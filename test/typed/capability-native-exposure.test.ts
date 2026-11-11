/**
 * P1 acceptance: the MCP adapter must preserve each tool's native exposure.
 *
 * The old adapter rewrote every non-hidden MCP tool to `deferred`. That erased
 * the difference between `direct`, `codemode` and `deferred`, which is what
 * `codemode.mode: "only"` and the declaration mask key off. These cases run the
 * real MCP extension through `installCapabilityMcp` with an offline transport and
 * assert the registered exposure, and that activation is decided by Capability
 * (every MCP tool starts inactive) rather than by the exposure rewrite.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { getCurrentTools, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { offlineMcpTransport } from './support/offline-mcp-transport.ts';

import { installCapabilityMcp } from '../../src/capability/native-discovery.ts';
import { installCapabilityCodemode } from '../../src/capability/codemode.ts';
import capabilityExtension from '../../src/capability/extension.ts';
import { CAPABILITY_DISCOVERY_RECORD } from '../../src/capability/discovery-record.ts';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { waitFor } from '../../test-support/async.ts';

/**
 * Record one request: the declarations the transcript carries and the tools the
 * native registry holds when the request is made.
 */
interface RecordedRequest {
  readonly declared: readonly string[];
  readonly registered: readonly string[];
}

function recordTextRequests(
  runtime: Awaited<ReturnType<typeof ModelRuntime.create>>,
  model: Model<Api>,
  requests: RecordedRequest[],
  registered: () => readonly string[],
): void {
  runtime.streamSimple = (_model, context) => {
    requests.push({
      declared: getCurrentTools(context.messages).map((tool) => tool.name),
      registered: [...registered()],
    });
    const message: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
    };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end();
    return stream;
  };
}

function offlineTransport(server: string, tool: string) {
  return offlineMcpTransport(message => {
    let result: unknown;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: server, version: '1' } };
    } else if (message.method === 'tools/list') {
      result = { tools: [{ name: tool, description: `${server} tool`, inputSchema: { type: 'object', properties: {} } }] };
    } else if (message.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'OK' }] };
    } else {
      result = { resources: [], resourceTemplates: [] };
    }
    return result;
  });
}

test('MCP adapter preserves native tool exposure and keeps tools inactive', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-native-exposure-'));
  const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = path.join(cwd, 'agent');
  let session: AgentSession | undefined;
  let pi: ExtensionAPI | undefined;
  const errors: unknown[] = [];
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
    assert.ok(model);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-only' }, env: {} });
    runtime.hasConfiguredAuth = () => true;

    // One server per exposure. `direct` is the case the old rewrite silently
    // turned into `deferred`; `codemode` is the script-only default.
    const servers = [
      { server: 'srv_direct', tool: 'inspect', exposure: 'direct' },
      { server: 'srv_codemode', tool: 'inspect', exposure: 'codemode' },
      { server: 'srv_deferred', tool: 'inspect', exposure: 'deferred' },
      { server: 'srv_hidden', tool: 'inspect', exposure: 'hidden' },
    ] as const;

    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' });
    const controlled = {
      name: 'harness-mcp-exposure',
      factory(api: ExtensionAPI) {
        pi = api;
        installCapabilityMcp(api, {
          loadConfig: () => ({ errors: [], autoEnableCodemode: false, servers: servers.map((s) => ({
            name: s.server, source: 'test', config: { command: 'unused', exposure: s.exposure },
          })) }),
          createTransport: (entry) => offlineTransport(entry.name, 'inspect'),
          logPath: path.join(cwd, 'mcp.log'),
        });
      },
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: process.env['PI_CODING_AGENT_DIR']!, settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [controlled],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd, agentDir: process.env['PI_CODING_AGENT_DIR']!, modelRuntime: runtime,
      model, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) }));
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    assert.ok(pi);
    for (const s of servers) {
      await waitFor(() => pi!.getAllTools().some((entry) => entry.name === `mcp__${s.server}__inspect`));
    }

    const exposureOf = (name: string) => pi!.getAllTools().find((entry) => entry.name === name)?.exposure;
    // The old rewrite turned every non-hidden MCP tool into `deferred`; this is
    // the case that catches it, because `direct` is what `only` mode hides.
    assert.equal(exposureOf('mcp__srv_direct__inspect'), 'direct', 'direct MCP tool must not be rewritten to deferred');
    // The SDK maps MCP config `codemode` to tool-level `deferred` (to keep the
    // tool out of the codemode description); the adapter must not change that.
    assert.equal(exposureOf('mcp__srv_codemode__inspect'), 'deferred', 'MCP codemode exposure maps to deferred and stays deferred');
    assert.equal(exposureOf('mcp__srv_deferred__inspect'), 'deferred', 'deferred exposure must survive');
    assert.equal(exposureOf('mcp__srv_hidden__inspect'), 'hidden', 'hidden exposure must stay hidden');

    // Capability owns activation: an exposed MCP tool is registered but not active.
    for (const s of servers.filter((entry) => entry.exposure !== 'hidden')) {
      assert.ok(!pi.getActiveTools().includes(`mcp__${s.server}__inspect`),
        `${s.server} tool must start inactive so Capability decides what to declare`);
    }
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

/**
 * Switching `codemode.mode` between `on` and `only` changes only the request
 * declaration projection. The set of active (enabled) tools must stay identical:
 * `only` hides direct declarations, it does not disable the tools.
 */
test('on vs only keeps the same active set and only hides direct declarations', () => {
  let mode: 'on' | 'only' = 'on';
  const definitions = new Map<string, import('@earendil-works/pi-coding-agent').ToolDefinition>();
  let active = ['codemode', 'direct_tool', 'deferred_tool'];
  const pi = {
    registerTool: (tool: import('@earendil-works/pi-coding-agent').ToolDefinition) => { definitions.set(tool.name, tool); },
    registerCommand: () => {},
    on: () => {},
    getSettings: () => ({ codemode: { mode } }),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = names; },
    getAllTools: () => [...definitions.values()],
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  const declared = installCapabilityCodemode(pi, () => () => true, () => () => true);
  const names = ['codemode', 'direct_tool', 'deferred_tool'];
  const tools: AgentTool[] = names.map((name) => ({
    name, label: name, description: name, parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [], details: undefined }),
  }));
  const exposure = (name: string) => name === 'codemode' ? 'model-only' as const
    : name === 'direct_tool' ? 'direct' as const : 'deferred' as const;
  const runLoadout = () => definitions.get('codemode')!.prepareLoadout!({
    declared: tools, callable: tools.slice(1), registered: tools,
    getExposure: exposure, getNamespace: () => undefined, getPromptGuidelines: () => [],
  });

  pi.setActiveTools(names);
  runLoadout();
  const activeOn = [...pi.getActiveTools()].sort();
  assert.deepEqual([...declared()].sort(), [...names].sort(), 'on mode declares every active tool');

  mode = 'only';
  runLoadout();
  assert.deepEqual([...pi.getActiveTools()].sort(), activeOn, 'the active/enabled set never changes with mode');
  assert.ok(![...declared()].includes('direct_tool'), 'only mode hides the direct declaration');
  assert.ok([...declared()].includes('deferred_tool'), 'deferred stays declared in only mode');
  assert.ok([...declared()].includes('codemode'), 'codemode itself stays declared');
});

/**
 * The native MCP startup hook waits for `direct` servers so their tools are
 * declared in the first request. Capability registers every MCP tool inactive
 * and declares only branch-selected tools, so an unselected server must not
 * spend the startup budget before the baseline prompt. The gate holds the
 * server's replies: the prompt either finishes while it is still connecting, or
 * it waits for Pi's own startup timer and reports that it did.
 */
test('the first prompt does not wait for an unselected pending direct MCP server', { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-mcp-startup-'));
  const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = path.join(cwd, 'agent');
  const NAME = 'mcp__slow_direct__inspect';
  const requests: RecordedRequest[] = [];
  const notices: string[] = [];
  const errors: unknown[] = [];
  let session: AgentSession | undefined;
  let pi: ExtensionAPI | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
    assert.ok(model);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-only' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    recordTextRequests(runtime, model, requests, () => pi?.getAllTools().map((tool) => tool.name) ?? []);

    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
    });
    const controlled = {
      name: 'harness-mcp-startup',
      factory(api: ExtensionAPI) {
        pi = api;
        capabilityExtension(api);
        installCapabilityMcp(api, {
          loadConfig: () => ({ errors: [], autoEnableCodemode: false, servers: [{
            name: 'slow_direct', source: 'test', config: { command: 'unused', exposure: 'direct' },
          }] }),
          createTransport: (entry) => offlineMcpTransport((message) => {
            if (message.method === 'initialize') {
              return { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: entry.name, version: '1' } };
            }
            return {
              tools: [{ name: 'inspect', description: 'Slow direct inspection', inputSchema: { type: 'object', properties: {} } }],
            };
          }, { gate }),
          logPath: path.join(cwd, 'mcp.log'),
        });
      },
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: process.env['PI_CODING_AGENT_DIR']!, settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [controlled],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd, agentDir: process.env['PI_CODING_AGENT_DIR']!, modelRuntime: runtime,
      model, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) }));
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.createContext().ui, notify: (message: string) => { notices.push(message); } },
      onError: (error) => errors.push(error),
    });
    assert.ok(pi);

    await session.prompt('Baseline request');
    // The gate is still closed: the prompt completed against a server that has
    // not answered, so nothing declared by this session depended on it.
    assert.equal(pi.getAllTools().some((tool) => tool.name === NAME), false,
      'the unselected server is still connecting after the first request');
    assert.ok(!requests[0]?.registered.includes(NAME),
      'the unselected server had not registered when the first request was made');
    assert.deepEqual(requests[0]?.declared.filter((name) => name.startsWith('mcp__')), [],
      'no MCP tool is declared before Capability selects one');
    assert.doesNotMatch(notices.join('\n'), /still connecting/,
      'the baseline prompt did not spend the MCP startup budget');
    assert.doesNotMatch(session.systemPrompt, /<mcp_servers>/);

    // The decision belongs to the first request, like Pi's own startup latch:
    // a later prompt must not pick the wait up while the same server is still
    // connecting.
    await session.prompt('Second baseline request');
    assert.equal(requests.length, 2);
    assert.ok(!requests[1]?.registered.includes(NAME), 'the server is still connecting on the second request');
    assert.doesNotMatch(notices.join('\n'), /still connecting/,
      'a later prompt did not start the MCP startup wait');

    // Background connection is untouched: releasing the server registers its
    // tool with the configured exposure, without activating it.
    release();
    await waitFor(() => pi!.getAllTools().some((tool) => tool.name === NAME));
    assert.equal(pi.getAllTools().find((tool) => tool.name === NAME)?.exposure, 'direct',
      'the configured direct exposure is preserved');
    assert.ok(!pi.getActiveTools().includes(NAME), 'registration does not activate an unselected tool');
    await session.prompt('After the server connected');
    assert.ok(!requests.at(-1)?.declared.includes(NAME), 'a connected but unselected tool stays undeclared');
    assert.ok(requests.at(-1)?.registered.includes(NAME), 'the server did register its tool in the background');
    assert.deepEqual(errors, []);
  } finally {
    release();
    session?.dispose();
    if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

/**
 * The startup wait is only a delay when no recorded declaration needs it. A
 * resumed session records its active loadout in the transcript, and Pi activates
 * a recorded MCP tool when its server registers. That pending selection is a real
 * dependency of the first request, so this case keeps the wait instead of
 * dropping the tool from a session that had selected it.
 */
test('a resumed session still waits for its recorded direct MCP tool', { timeout: 60_000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-mcp-resume-'));
  const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = path.join(cwd, 'agent');
  const NAME = 'mcp__recorded_direct__inspect';
  const requests: RecordedRequest[] = [];
  const sentMethods: string[] = [];
  const errors: unknown[] = [];
  let session: AgentSession | undefined;
  let pi: ExtensionAPI | undefined;
  let slowReplies = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
    assert.ok(model);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-only' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    recordTextRequests(runtime, model, requests, () => pi?.getAllTools().map((tool) => tool.name) ?? []);

    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
    });
    const controlled = {
      name: 'harness-mcp-resume',
      factory(api: ExtensionAPI) {
        pi = api;
        capabilityExtension(api);
        installCapabilityMcp(api, {
          loadConfig: () => ({ errors: [], autoEnableCodemode: false, servers: [{
            name: 'recorded_direct', source: 'test', config: { command: 'unused', exposure: 'direct' },
          }] }),
          createTransport: (entry) => offlineMcpTransport((message) => {
            sentMethods.push(message.method);
            if (message.method === 'initialize') {
              return { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: entry.name, version: '1' } };
            }
            return {
              tools: [{ name: 'inspect', description: 'Recorded direct inspection', inputSchema: { type: 'object', properties: {} } }],
            };
          }, slowReplies ? { gate } : {}),
          logPath: path.join(cwd, 'mcp.log'),
        });
      },
    };
    const load = async (sessionManager: SessionManager): Promise<AgentSession> => {
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir: process.env['PI_CODING_AGENT_DIR']!, settingsManager,
        noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [controlled],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const created = await createAgentSession({ cwd, agentDir: process.env['PI_CODING_AGENT_DIR']!, modelRuntime: runtime,
        model, settingsManager, resourceLoader, sessionManager });
      await created.session.bindExtensions({ onError: (error) => errors.push(error) });
      return created.session;
    };

    // Session A selects and declares the direct MCP tool through the real
    // activation path, so the branch records both the selection and the loadout.
    const dir = path.join(cwd, 'sessions');
    session = await load(SessionManager.create(cwd, dir));
    assert.ok(pi);
    await waitFor(() => pi!.getAllTools().some((tool) => tool.name === NAME));
    session.sessionManager.appendCustomEntry(CAPABILITY_DISCOVERY_RECORD, {
      version: 1,
      result: {
        status: 'ok', tools: [], skills: [],
        mcp: [{ ref: `tool://${NAME}`, name: NAME, kind: 'tool', status: 'available', server: 'recorded_direct' }],
        coverage: { local: 'searched', remote: 'not_searched' },
      },
    });
    pi.setActiveTools([...pi.getActiveTools(), NAME]);
    await session.prompt('Activate the MCP tool');
    assert.ok(requests.at(-1)?.declared.includes(NAME), 'the selected tool is declared while its server is connected');
    const sessionFile = session.sessionManager.getSessionFile();
    assert.ok(sessionFile);
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    session = undefined;

    // Session B starts while the server is still connecting. Its first request
    // must still carry the recorded declaration, which requires the wait.
    slowReplies = true;
    requests.length = 0;
    sentMethods.length = 0;
    session = await load(SessionManager.open(sessionFile, dir));
    const resumed = session;
    await waitFor(() => sentMethods.includes('initialize'), { label: 'the resumed server initialize request' });

    // Overlap proof instead of a release timer: the run is active while the
    // gated server has not answered, and no model request exists yet. Only the
    // startup wait can hold the first request at this point; releasing the gate
    // then completes it with the recorded tool already registered.
    const prompted = resumed.prompt('Resumed request');
    prompted.catch(() => {});
    await waitFor(() => resumed.isStreaming, { label: 'the resumed run to wait for its recorded MCP tool' });
    assert.equal(requests.length, 0, 'the startup wait holds the first request while the server is connecting');
    assert.ok(!pi!.getAllTools().some((tool) => tool.name === NAME), 'the server is still connecting while the prompt waits');
    release();
    await prompted;
    assert.ok(requests[0]?.registered.includes(NAME),
      'the resumed session waited for its recorded direct tool before the first request');
    const reopened = pi;
    assert.ok(reopened);
    assert.ok(reopened.getActiveTools().includes(NAME), 'the restored selection stays active');
    await session.prompt('Second resumed request');
    assert.ok(requests.at(-1)?.declared.includes(NAME), 'the restored declaration survives later requests');
    assert.deepEqual(errors, []);
  } finally {
    release();
    session?.dispose();
    if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});
