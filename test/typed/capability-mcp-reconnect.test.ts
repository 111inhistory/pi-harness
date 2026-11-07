/**
 * MCP tools that Pi registers through its native `/mcp reconnect` path.
 *
 * The MCP extension re-registers a server's tools through `pi.registerTool` on
 * every (re)connect and re-registers a withdrawn tool as `hidden`. Capability
 * must therefore read the *current* registry when it browses, completes and
 * enables — a startup snapshot, an independent MCP client or a required model
 * discovery run would all miss a tool that appeared after the session started.
 *
 * The fixture server answers `tools/list` from a JSON file, so a test can change
 * the server's tool list and drive the real reconnect. Only the model is
 * simulated; transport, registration, the command and the projection are the
 * SDK's.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  fauxProvider, getCurrentTools, InMemoryCredentialStore, type AssistantMessage,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

import harnessExtension from '../../test-support/harness-extension.ts';
import { discoveryRecords, manualEnabledTools } from '../../src/capability/discovery-record.ts';
import { waitFor } from '../../test-support/async.ts';

const SERVER = 'reconnect';
const SCRIPT = fileURLToPath(new URL('../../test-support/synthetic-mcp-server.mjs', import.meta.url));
const name = (tool: string): string => `mcp__${SERVER}__${tool}`;

interface Fixture {
  readonly session: AgentSession;
  readonly requests: string[][];
  readonly notices: { text: string; type: string }[];
  readonly toolsFile: string;
  run(command: string, args: string): Promise<string>;
  setTools(tools: readonly string[]): Promise<void>;
  reconnect(): Promise<void>;
  close(): Promise<void>;
}

async function start(options: { manual?: readonly string[] } = {}): Promise<Fixture> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-mcp-reconnect-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir);
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(cwd, 'uds');
  const toolsFile = path.join(cwd, 'tools.json');
  await writeFile(toolsFile, JSON.stringify([{ name: 'stable' }, { name: 'secret' }]));
  await writeFile(path.join(agentDir, 'harness.json'), JSON.stringify({
    ...(options.manual === undefined ? {} : { capability: { manualTools: [...options.manual] } }),
  }));
  await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      [SERVER]: {
        command: process.execPath,
        args: [SCRIPT],
        exposure: 'deferred',
        env: {
          MCP_FIXTURE_PID_FILE: path.join(cwd, 'mcp.pid'),
          MCP_FIXTURE_TOOLS_FILE: toolsFile,
        },
      },
    },
  }));

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: 'reconnect-fixture', contextWindow: 1_048_576 }] });
  runtime.registerNativeProvider(faux.provider);
  runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
  runtime.hasConfiguredAuth = () => true;
  const model = faux.models[0]!;
  const requests: string[][] = [];
  runtime.streamSimple = (_model, context) => {
    requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
    const reply: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', timestamp: Date.now(),
      usage: {
        input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
      },
    };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: reply });
    stream.end();
    return stream;
  };

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
  });
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: 'harness-reconnect-fixture', factory: (api: ExtensionAPI) => { harnessExtension(api); } }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const session = (await createAgentSession({
    cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  })).session;
  const notices: { text: string; type: string }[] = [];
  await session.bindExtensions({ onError: (error) => { throw error; } });
  await waitFor(() => session.getAllTools().some((tool) => tool.name === name('stable')),
    { label: 'the MCP server tools', timeoutMs: 15_000 });

  const commandContext = () => {
    const ctx = session.extensionRunner.createCommandContext();
    Object.defineProperty(ctx, 'ui', {
      value: {
        notify: (text: string, type: string = 'info') => { notices.push({ text, type }); },
        select: async () => undefined,
      },
    });
    return ctx;
  };
  const run = async (command: string, args: string): Promise<string> => {
    const entry = session.extensionRunner.getRegisteredCommands().find((candidate) => candidate.name === command);
    assert.ok(entry, `/${command} is registered`);
    notices.length = 0;
    await entry.handler(args, commandContext());
    return notices.map((notice) => notice.text).join('\n');
  };
  return {
    session,
    requests,
    notices,
    toolsFile,
    run,
    async setTools(tools) {
      await writeFile(toolsFile, JSON.stringify(tools.map((tool) => ({ name: tool }))));
    },
    async reconnect() {
      const text = await run('mcp', `reconnect ${SERVER}`);
      assert.doesNotMatch(text, /failed|error/i, text);
    },
    async close() {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test('a tool registered by /mcp reconnect is browsable and enableable without a restart', { timeout: 90_000 }, async () => {
  const fixture = await start();
  try {
    const { session } = fixture;
    assert.ok(session.getAllTools().some((tool) => tool.name === name('stable')));
    assert.match(await fixture.run('capability', 'list mcp'), new RegExp(`MCP servers · ${SERVER}`));

    // The server changes its tool list; only the native reconnect runs.
    await fixture.setTools(['stable', 'added']);
    await fixture.reconnect();
    await waitFor(() => session.getAllTools().some((tool) => tool.name === name('added')),
      { label: 'the re-registered MCP tool', timeoutMs: 15_000 });

    const listed = await fixture.run('capability', 'list mcp');
    assert.match(listed, /added/, 'a newly registered tool is browsable');
    assert.doesNotMatch(listed, /secret/, 'a withdrawn tool is re-registered hidden and disappears');
    assert.match(await fixture.run('capability', 'list added'), /1 matches for "added"/);

    const enabled = await fixture.run('capability', `enable mcp://${SERVER}`);
    assert.match(enabled, /Enabled[\s\S]*stable[\s\S]*added/);
    assert.ok(session.getActiveToolNames().includes(name('added')));
    assert.ok(manualEnabledTools(session.sessionManager.getBranch()).has(name('added')));
    // A withdrawn registration is still refused when it is named directly.
    assert.match(await fixture.run('capability', `enable ${name('secret')}`),
      /Refused[\s\S]*hidden by its registration/);

    // The declaration is real: the next model request carries the enabled tool.
    await session.prompt('Use the reconnected MCP tools.');
    assert.ok(fixture.requests.at(-1)!.includes(name('added')), 'the enabled MCP tool is declared');

    // A reconnect after the enable keeps the same tool enabled and recorded once.
    await fixture.reconnect();
    await waitFor(() => session.getActiveToolNames().includes(name('added')) ||
      session.getAllTools().some((tool) => tool.name === name('added')),
    { label: 'the tool after a second reconnect', timeoutMs: 15_000 });
    await session.prompt('After a second reconnect.');
    assert.ok(fixture.requests.at(-1)!.includes(name('added')), 'the enablement survives the reconnect');
    assert.equal(discoveryRecords(session.sessionManager.getBranch()).length, 1, 'one record, not one per reconnect');
  } finally {
    await fixture.close();
  }
});

test('a choice made before a reconnect is re-resolved against the new registry', { timeout: 90_000 }, async () => {
  const fixture = await start();
  try {
    const { session } = fixture;
    // The picker is open with the old registry in hand.
    const offered = session.getAllTools().map((tool) => tool.name);
    assert.ok(offered.includes(name('secret')));
    await fixture.setTools(['stable']);
    await fixture.reconnect();
    await waitFor(() => !session.getAllTools().some((tool) => tool.name === name('secret') && tool.exposure !== 'hidden'),
      { label: 'the withdrawn registration', timeoutMs: 15_000 });

    // The stale picker result is re-resolved at execution time and refused.
    const refused = await fixture.run('capability', `enable ${name('secret')}`);
    assert.match(refused, /Refused[\s\S]*hidden by its registration/);
    assert.deepEqual(discoveryRecords(session.sessionManager.getBranch()), [], 'a refused target writes no record');
    assert.ok(!session.getActiveToolNames().includes(name('secret')));
  } finally {
    await fixture.close();
  }
});

test('manualTools still governs an MCP tool that a reconnect registers', { timeout: 90_000 }, async () => {
  const fixture = await start({ manual: [`mcp__${SERVER}__secret`, `mcp__${SERVER}__added`] });
  try {
    const { session } = fixture;
    await session.prompt('Before any MCP enablement.');
    assert.ok(!fixture.requests.at(-1)!.includes(name('secret')), 'a manual MCP tool is never declared before the user enables it');
    assert.ok(!session.getActiveToolNames().includes(name('secret')));
    const refusal = await fixture.run('capability', `enable ${name('secret')}`);
    assert.match(refusal, /Enabled/, 'the user command is the one path that authorizes a manual tool');
    await session.prompt('After enabling the manual MCP tool.');
    assert.ok(fixture.requests.at(-1)!.includes(name('secret')), 'the authorized manual MCP tool is declared');

    // A manual tool that only appears after the reconnect is not auto-authorized.
    await fixture.setTools(['stable', 'secret', 'added']);
    await fixture.reconnect();
    await waitFor(() => session.getAllTools().some((tool) => tool.name === name('added')),
      { label: 'the new manual MCP tool', timeoutMs: 15_000 });
    await session.prompt('After the reconnect that added a manual tool.');
    assert.ok(!fixture.requests.at(-1)!.includes(name('added')), 'a new manual registration needs its own authorization');
    assert.equal(manualEnabledTools(session.sessionManager.getBranch()).has(name('added')), false);

    const enabled = await fixture.run('capability', `enable mcp://${SERVER}`);
    assert.match(enabled, /Enabled[\s\S]*added/);
    assert.match(enabled, /Already enabled[\s\S]*secret/, 'the earlier authorization is not repeated');
    assert.equal(discoveryRecords(session.sessionManager.getBranch()).length, 2, 'one record per user enablement');
  } finally {
    await fixture.close();
  }
});
