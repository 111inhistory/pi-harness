/**
 * Full SDK acceptance for manual capabilities.
 *
 * These run a real `createAgentSession` through the real harness extension, with
 * the manual policy read from `harness.json`, a real stdio MCP server child
 * process and an offline scripted model. Only the model is simulated: the
 * request, declaration, command, execution and projection paths are the SDK's.
 *
 * Covered here, because the assembly tests only call extension handlers:
 * - a `defaultActive` manual tool is pruned from the declaration and refused by
 *   direct execution and by Codemode until the branch carries the user's manual
 *   record;
 * - with that record and the tool in the active set, the tool and its MCP server
 *   are declared, directly callable, scriptable and usable for
 *   `read_mcp_resource`;
 * - a second real session wired as a child scope drops the same tools even with
 *   the root's manual record on its branch.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  fauxProvider, getCurrentTools, InMemoryCredentialStore, type AssistantMessage, type JsonObject, type Message,
} from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

import capabilityExtension from '../../src/capability/extension.ts';
import subagentEntry from '../../extensions/subagent.ts';
import capabilityEntry from '../../extensions/capability.ts';
import resultRenderingEntry from '../../extensions/result-rendering.ts';
import btwEntry from '../../extensions/btw.ts';
import { explicitlyEnabled } from '../../src/capability/tool-permission.ts';
import { installCapabilityMcp } from '../../src/capability/native-discovery.ts';
import { setCapabilityParent } from '../../src/capability/scope.ts';
import { harnessConfigFor } from '../../src/harness-config.ts';
import { waitFor } from '../../test-support/async.ts';

type ToolResult = Extract<Message, { role: 'toolResult' }>;
type Phase = 'before' | 'after' | 'child';

const SERVER = 'manual_fixture';
const MCP_TOOL = `mcp__${SERVER}__deploy`;
const MANUAL_TOOLS = ['manual_fixture', MCP_TOOL, 'read_mcp_resource'] as const;
const SERVER_SCRIPT = fileURLToPath(new URL('../../test-support/synthetic-mcp-server.mjs', import.meta.url));

function results(messages: readonly AgentMessage[], name: string): ToolResult[] {
  return messages.filter((entry): entry is ToolResult => entry.role === 'toolResult' && entry.toolName === name);
}

function textOf(message: ToolResult): string {
  return message.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** The same manual fixture tool in both sessions, so registration is equal. */
const manualFixtureTool = {
  name: 'manual-fixture-tool',
  factory: (api: ExtensionAPI): void => {
    api.registerTool({
      name: 'manual_fixture',
      label: 'Manual fixture',
      description: 'A default-active tool that only the user may enable.',
      parameters: { type: 'object', properties: {} },
      defaultActive: true,
      async execute() {
        return { content: [{ type: 'text' as const, text: 'MANUAL_FIXTURE_EXECUTED' }], details: {} };
      },
    });
  },
};

function systemText(messages: readonly AgentMessage[]): string {
  return JSON.stringify(messages.filter((entry) => entry.role === 'system'));
}

test('full SDK: manual tools stay unreachable until the user records them, then work in Main only', { timeout: 90_000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-capability-manual-sdk-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir);
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousSocketDir = process.env['PI_SUBAGENT_SOCKET_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(cwd, 'uds');
  const sessions: AgentSession[] = [];
  const errors: unknown[] = [];
  try {
    await writeFile(path.join(agentDir, 'harness.json'), JSON.stringify({
      capability: { manualTools: [...MANUAL_TOOLS] },
    }));
    const pidFile = path.join(cwd, 'mcp.pid');
    await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        [SERVER]: {
          command: process.execPath, args: [SERVER_SCRIPT], exposure: 'deferred',
          env: { MCP_FIXTURE_PID_FILE: pidFile },
        },
      },
    }));

    const faux = fauxProvider({ models: [{ id: 'manual-sdk-fixture', contextWindow: 1_048_576 }] });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    const model = faux.models[0]!;

    let phase: Phase = 'before';
    let step = 0;
    const declared: Record<Phase, string[][]> = { before: [], after: [], child: [] };
    const requests: Record<Phase, AgentMessage[][]> = { before: [], after: [], child: [] };

    const message = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content, stopReason, timestamp: Date.now(),
      usage: {
        input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });
    const call = (name: string, args: JsonObject = {}) => message([
      { type: 'toolCall', id: `call-${phase}-${step}-${name}`, name, arguments: args },
    ], 'toolUse');
    const calls = (entries: readonly [string, JsonObject][]) => message(
      entries.map(([name, args], index) => ({
        type: 'toolCall' as const, id: `call-${phase}-${step}-${index}-${name}`, name, arguments: args,
      })),
      'toolUse',
    );

    const unreachableScript = `
      if (ALL_TOOLS.some(t => t.name === 'manual_fixture')) throw Error('manual tool leaked into ALL_TOOLS');
      if (await describeTool('manual_fixture')) throw Error('manual tool leaked into describeTool');
      let refused = 0;
      try { await tools.manual_fixture({}); } catch { refused++; }
      if (refused !== 1) throw Error('manual tool was callable from a script');
      return 'NO_MANUAL_ACCESS';
    `;
    const reachableScript = `
      const [direct, mcp] = await Promise.all([tools.manual_fixture({}), tools.${MCP_TOOL}({})]);
      if (!JSON.stringify(direct).includes('MANUAL_FIXTURE_EXECUTED')) throw Error('manual fixture failed');
      if (!JSON.stringify(mcp).includes('MCP_DEPLOY_EXECUTED')) throw Error('manual MCP tool failed');
      return 'MANUAL_ACCESS_OK';
    `;

    runtime.streamSimple = (_model, context) => {
      const tools = getCurrentTools(context.messages).map((entry) => entry.name);
      declared[phase].push(tools);
      requests[phase].push(structuredClone(context.messages));
      step += 1;
      let reply: AssistantMessage;
      if (phase === 'before') {
        if (step === 1) reply = call('manual_fixture');
        else if (step === 2) reply = call('codemode', { code: unreachableScript });
        else reply = message([{ type: 'text', text: 'before done' }], 'stop');
      } else if (phase === 'after') {
        if (step === 1) {
          reply = calls([
            ['manual_fixture', {}],
            [MCP_TOOL, {}],
            ['read_mcp_resource', { server: SERVER, uri: 'memory://fixture' }],
            ['read_mcp_resource', { server: 'other_fixture', uri: 'memory://fixture' }],
          ]);
        } else if (step === 2) reply = call('codemode', { code: reachableScript });
        else reply = message([{ type: 'text', text: 'after done' }], 'stop');
      } else if (step === 1) {
        reply = call('manual_fixture');
      } else {
        reply = message([{ type: 'text', text: 'child done' }], 'stop');
      }
      const stream = new AssistantMessageEventStream();
      stream.push({ type: 'done', reason: reply.stopReason as 'stop' | 'toolUse', message: reply });
      stream.end();
      return stream;
    };

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
    });
    let rootApi: ExtensionAPI | undefined;
    let capabilityApi: ExtensionAPI | undefined;
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        manualFixtureTool,
        { name: 'result-rendering', factory: resultRenderingEntry },
        {
          name: 'subagent',
          factory: (api: ExtensionAPI) => {
            rootApi = api;
            subagentEntry(api);
          },
        },
        { name: 'capability', factory: (api: ExtensionAPI) => {
          capabilityApi = api;
          capabilityEntry(api);
        } },
        { name: 'btw', factory: btwEntry },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);

    const session = (await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    })).session;
    sessions.push(session);
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    assert.ok(rootApi, 'the Subagent entrypoint ran');
    assert.ok(capabilityApi, 'the Capability entrypoint ran');
    assert.notEqual(rootApi, capabilityApi, 'Pi supplies a separate API to each plugin');
    assert.equal(harnessConfigFor(rootApi), harnessConfigFor(capabilityApi),
      'separate registrations retain one session configuration snapshot');

    // The MCP server is a real child process; wait for its pid file and tools.
    await waitFor(async () => (await readFile(pidFile, 'utf8').catch(() => '')) !== '', { label: 'the MCP pid file', timeoutMs: 10_000 });
    await waitFor(() => session.getAllTools().some((tool) => tool.name === MCP_TOOL), { label: 'the manual MCP server', timeoutMs: 10_000 });
    assert.ok(session.getActiveToolNames().includes('manual_fixture'),
      'the SDK activates a defaultActive tool at registration; the manual gate must be what removes it');
    session.setActiveToolsByName([...session.getActiveToolNames(), 'codemode']);

    // Phase 1: not enabled yet.
    await session.prompt('Check the manual tool before enablement.');
    assert.ok(!declared.before[0]!.includes('manual_fixture'), 'an unauthorized manual tool is not declared');
    assert.ok(!declared.before[0]!.includes(MCP_TOOL), 'a manual MCP tool is not declared');
    assert.ok(!session.getActiveToolNames().includes('manual_fixture'), 'the declaration prune removed it');
    const blocked = results(session.messages, 'manual_fixture');
    assert.equal(blocked.length, 1, 'the direct call was refused');
    assert.equal(blocked[0]!.isError, true);
    assert.match(textOf(blocked[0]!), /not found/,
      'the manual gate removed the tool from the turn loadout, so the SDK cannot run it');
    const beforeScript = results(session.messages, 'codemode').at(-1);
    assert.ok(beforeScript);
    assert.equal(beforeScript.isError, false, textOf(beforeScript));
    assert.match(textOf(beforeScript), /NO_MANUAL_ACCESS/);

    // The real user entry: the command activates the tools and writes the
    // append-only authorization record the declaration and execution paths read.
    const enableCommand = session.extensionRunner.getRegisteredCommands()
      .find((entry) => entry.name === 'capability');
    assert.ok(enableCommand, 'the harness registers /capability on the real SDK session');
    const enableNotices: { text: string; type: string }[] = [];
    const enableContext = session.extensionRunner.createCommandContext();
    Object.defineProperty(enableContext, 'ui', {
      value: { notify: (text: string, type: string = 'info') => { enableNotices.push({ text, type }); } },
    });
    const mcpNamespace = session.getAllTools().find(tool => tool.name === MCP_TOOL)?.namespace?.name;
    assert.ok(mcpNamespace, 'the real SDK registers an MCP namespace');
    await enableCommand.handler(`enable manual_fixture namespace://${mcpNamespace} read_mcp_resource`, enableContext);
    assert.match(enableNotices.at(-1)?.text ?? '', /Capability · enable|Changed/);
    for (const name of MANUAL_TOOLS) {
      assert.ok(session.getActiveToolNames().includes(name), `${name} is active`);
      assert.ok(explicitlyEnabled(capabilityApi!, session.sessionManager.getBranch(), name), `${name} is enabled`);
    }

    // Phase 2: authorized by the user's record.
    phase = 'after';
    step = 0;
    await session.prompt('Use the manual tools now that they are enabled.');
    assert.ok(declared.after[0]!.includes('manual_fixture'), 'the enabled manual tool is declared');
    assert.ok(declared.after[0]!.includes(MCP_TOOL), 'the enabled manual MCP tool is declared');
    assert.ok(declared.after[0]!.includes('read_mcp_resource'), 'the enabled resource reader is declared');
    const executed = results(session.messages, 'manual_fixture').at(-1);
    assert.ok(executed);
    assert.equal(executed.isError, false, textOf(executed));
    assert.match(textOf(executed), /MANUAL_FIXTURE_EXECUTED/);
    const mcpExecuted = results(session.messages, MCP_TOOL).at(-1);
    assert.ok(mcpExecuted);
    assert.equal(mcpExecuted.isError, false, textOf(mcpExecuted));
    assert.match(textOf(mcpExecuted), /MCP_DEPLOY_EXECUTED/);
    const reads = results(session.messages, 'read_mcp_resource');
    assert.equal(reads.length, 2);
    assert.ok(reads.some((read) => !read.isError && textOf(read).includes('SYNTHETIC_MCP_RESOURCE')),
      'the enabled manual server qualifies a resource read');
    assert.ok(reads.some((read) => read.isError), 'an unselected server is still refused');
    const afterScript = results(session.messages, 'codemode').at(-1);
    assert.ok(afterScript);
    assert.equal(afterScript.isError, false, textOf(afterScript));
    assert.match(textOf(afterScript), /MANUAL_ACCESS_OK/);

    // The real SDK view through the user-facing list, with the four-state labels.
    const command = session.extensionRunner.getRegisteredCommands().find((entry) => entry.name === 'capability');
    assert.ok(command, 'the harness registers /capability on the real SDK session');
    const listNotices: { text: string; type: string }[] = [];
    const listContext = session.extensionRunner.createCommandContext();
    Object.defineProperty(listContext, 'ui', {
      value: { notify: (text: string, type: string = 'info') => { listNotices.push({ text, type }); } },
    });
    await command.handler('list', listContext);
    const defaultList = listNotices.at(-1)?.text ?? '';
    assert.match(defaultList, /manual_fixture/);
    assert.match(defaultList, /\[enabled\]/);
    await command.handler('list namespace', listContext);
    const namespaceList = listNotices.at(-1)?.text ?? '';
    assert.ok(namespaceList.includes(`${MCP_TOOL}  [`), 'the enabled MCP member is listed under its namespace');
    assert.ok(!namespaceList.includes('manual_fixture  ['), 'a plain tool is not a namespace entry');
    await command.handler('list tool', listContext);
    const toolList = listNotices.at(-1)?.text ?? '';
    assert.match(toolList, /manual_fixture/);
    assert.ok(!toolList.includes(`${MCP_TOOL}  [`), 'a namespace member is not a plain tool entry');
    await command.handler('list disabled', listContext);
    assert.match(listNotices.at(-1)?.text ?? '', /No tools match/);

    // Phase 3: the same branch memory, the same registered tools, a real child scope.
    const rootBranch = session.sessionManager.getEntries();
    assert.ok(rootBranch.some((entry) => entry.type === 'custom' && entry.customType === 'capability-tool-permission'),
      "the user's permission record is on the branch");
    // The child gets its own agent directory only so its MCP child process records
    // a separate pid; the manual policy is identical.
    const childAgentDir = path.join(cwd, 'agent-child');
    const childPidFile = path.join(cwd, 'mcp-child.pid');
    await mkdir(childAgentDir);
    await writeFile(path.join(childAgentDir, 'harness.json'), JSON.stringify({
      capability: { manualTools: [...MANUAL_TOOLS] },
    }));
    await writeFile(path.join(childAgentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        [SERVER]: {
          command: process.execPath, args: [SERVER_SCRIPT], exposure: 'deferred',
          env: { MCP_FIXTURE_PID_FILE: childPidFile },
        },
      },
    }));
    process.env['PI_CODING_AGENT_DIR'] = childAgentDir;
    const childLoader = new DefaultResourceLoader({
      cwd, agentDir: childAgentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        manualFixtureTool,
        {
          name: 'child-capability-manual-fixture',
          factory: (api: ExtensionAPI) => {
            setCapabilityParent(api, rootApi!);
            capabilityExtension(api);
            installCapabilityMcp(api, { logPath: path.join(cwd, 'mcp-child.log') });
          },
        },
      ],
    });
    await childLoader.reload();
    assert.deepEqual(childLoader.getExtensions().errors, []);
    const child = (await createAgentSession({
      cwd, agentDir: childAgentDir, modelRuntime: runtime, model, settingsManager, resourceLoader: childLoader,
      sessionManager: SessionManager.inMemory(cwd, {}, rootBranch),
    })).session;
    sessions.push(child);
    await child.bindExtensions({ onError: (error) => errors.push(error) });
    await waitFor(async () => (await readFile(childPidFile, 'utf8').catch(() => '')) !== '',
      { label: 'the child MCP pid file', timeoutMs: 10_000 });
    await waitFor(() => child.getAllTools().some((tool) => tool.name === 'manual_fixture')
      && child.getAllTools().some((tool) => tool.name === MCP_TOOL),
    { label: 'the child tools', timeoutMs: 10_000 });
    const childTools = child.getAllTools().map((tool) => tool.name);
    assert.ok(childTools.includes('manual_fixture'), 'the child registers the same manual fixture');
    assert.ok(childTools.includes(MCP_TOOL), 'the child registers the same MCP tool');
    assert.ok(child.sessionManager.getBranch().some((entry) => {
      const data = (entry as { data?: { set?: { target?: string; state?: string }[] } }).data;
      return entry.type === 'custom' && entry.customType === 'capability-tool-permission'
        && Array.isArray(data?.set) && data.set.some((item) => item.state === 'enabled');
    }), 'the child branch carries the root permission record');
    phase = 'child';
    step = 0;
    const childBaseline = child.messages.length;
    await child.prompt('Try the manual tool from a child scope.');
    assert.ok(!declared.child[0]!.includes('manual_fixture'), 'a child scope never declares a manual tool');
    assert.ok(!declared.child[0]!.includes(MCP_TOOL));
    assert.doesNotMatch(systemText(requests.child[0]!), /"category":"manual"/,
      'the child projection drops the manual record even though the branch carries it');
    assert.ok(!declared.child[0]!.includes('manual_fixture') && !declared.child[0]!.includes(MCP_TOOL),
      'registered manual tools stay out of the child declaration');
    const childCall = results(child.messages.slice(childBaseline), 'manual_fixture');
    assert.equal(childCall.length, 1);
    assert.equal(childCall[0]!.isError, true);
    assert.match(textOf(childCall[0]!), /not found|unavailable in this session|requires explicit user authorization/);
    assert.deepEqual(errors, []);
  } finally {
    for (const session of sessions) {
      try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); } catch { /* already stale */ }
      session.dispose();
    }
    // The SDK stdio transport keeps its child handle after dispose; terminate the
    // fixture server so the test process can exit.
    for (const pidFile of ['mcp.pid', 'mcp-child.pid']) {
      const pid = Number(await readFile(path.join(cwd, pidFile), 'utf8').catch(() => ''));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    }
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
    else process.env['PI_SUBAGENT_SOCKET_DIR'] = previousSocketDir;
    await rm(cwd, { recursive: true, force: true });
  }
});
