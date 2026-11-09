import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type McpTransportFactory,
} from '@earendil-works/pi-coding-agent';
import { getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
type McpTransport = ReturnType<McpTransportFactory>;
type JsonRpcMessage = Parameters<Parameters<McpTransport['onMessage']>[0]>[0];
import capabilityExtension from '../../src/capability/extension.ts';
import { CAPABILITY_STEP_TOOL_NAME } from '../../src/capability/contracts.ts';
import type { CapabilityStepFeedback } from '../../src/capability/agent.ts';
import { installCapabilityMcp } from '../../src/capability/native-discovery.ts';
import { waitFor } from '../../test-support/async.ts';

test('only mode + lazySchemas keeps matched group names but withholds its schema from declarations and the Codemode directory', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-lazy-schemas-'));
  const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const agentDir = path.join(cwd, 'agent');
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, 'harness.json'), JSON.stringify({ capability: { lazySchemas: ['mcp://big'] } }));
  let session: AgentSession | undefined;
  let pi: ExtensionAPI | undefined;
  const calls: string[] = [];
  const requests: { messages: { role: string }[] }[] = [];
  const errors: unknown[] = [];
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
    assert.ok(model);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-only' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    runtime.classify = async (classifier) => ({
      api: classifier.api, provider: classifier.provider, model: classifier.id,
      answers: { ready: { type: 'bool', probability: 1 } }, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 2, output: 1, totalTokens: 3, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
    });
    const response = (content: unknown[], stopReason: 'stop' | 'toolUse'): AssistantMessage => ({
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content, stopReason, timestamp: Date.now(),
      usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
    } as AssistantMessage);
    const toolCall = (name: string, args: Record<string, unknown>): AssistantMessage => response([
      { type: 'toolCall', id: `call-${name}`, name, arguments: args },
    ], 'toolUse');
    let rootStep = 0;
    let childStep = 0;
    runtime.streamSimple = (_model, context) => {
      const stream = new AssistantMessageEventStream();
      const internal = getCurrentTools(context.messages).some((entry) => entry.name === CAPABILITY_STEP_TOOL_NAME);
      let message: AssistantMessage;
      if (internal) {
        childStep++;
        if (childStep === 1) {
          message = toolCall(CAPABILITY_STEP_TOOL_NAME, { queries: ['search'], refs: [] });
        } else if (childStep === 2) {
          const result = context.messages.findLast((entry) => entry.role === 'toolResult' && entry.toolName === CAPABILITY_STEP_TOOL_NAME);
          assert.ok(result && result.role === 'toolResult');
          const body = result.content.find((part) => part.type === 'text');
          assert.ok(body?.type === 'text');
          const stepDetails = JSON.parse(body.text) as CapabilityStepFeedback;
          assert.equal(stepDetails.searches[0]?.mcp.length, 1);
          message = toolCall(CAPABILITY_STEP_TOOL_NAME, { queries: [], refs: ['namespace://mcp__big'], finish: true });
        } else {
          message = response([{ type: 'text', text: 'done' }], 'stop');
        }
      } else {
        requests.push(structuredClone(context));
        rootStep++;
        if (rootStep === 1) message = toolCall('capability', {});
        else if (rootStep === 2) message = toolCall('codemode', { code: `
          const d = await describeTool('mcp__big__search');
          if (typeof d !== 'string' || !d.includes('mcp__big__search')) throw Error('describeTool missing full interface');
          const ns = await describeNamespace('mcp__big');
          if (!ns || !ns.tools || !ns.tools.includes('mcp__big__search')) throw Error('describeNamespace missing member');
          const out = await tools.mcp__big__search({ q: 'x' });
          if (!JSON.stringify(out).includes('MCP_EXECUTED')) throw Error('lazy member not callable through Codemode');
          return 'LAZY_OK';
        ` });
        else message = response([{ type: 'text', text: 'Done' }], 'stop');
      }
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
      stream.end();
      return stream;
    };

    const transport = (server: string): McpTransport => {
      const listeners = new Set<(message: JsonRpcMessage) => void>();
      const closes = new Set<() => void>();
      return {
        start: async () => {},
        close: async () => { for (const listener of closes) listener(); },
        onMessage: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        onError: () => () => {},
        onClose: (listener) => { closes.add(listener); return () => { closes.delete(listener); }; },
        send: async (message) => {
          if (!('id' in message) || !('method' in message)) return;
          let result: unknown;
          if (message.method === 'initialize') result = {
            protocolVersion: '2025-11-25', capabilities: { tools: {} },
            serverInfo: { name: server, version: '1' }, instructions: `PRIVATE_CATALOG_${server}`,
          };
          else if (message.method === 'tools/list') result = { tools: [{
            name: 'search', description: 'Search the large service',
            inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
          }] };
          else if (message.method === 'tools/call') {
            calls.push(server);
            result = { content: [{ type: 'text', text: 'MCP_EXECUTED' }] };
          } else result = { resources: [], resourceTemplates: [] };
          const reply = { jsonrpc: '2.0', id: message.id, result } as JsonRpcMessage;
          queueMicrotask(() => { for (const listener of listeners) listener(reply); });
        },
      };
    };
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
      codemode: { mode: 'only' }, defaultTools: ['+codemode'],
    });
    const controlled = {
      name: 'lazy-harness',
      factory(api: ExtensionAPI) {
        pi = api;
        capabilityExtension(api);
        installCapabilityMcp(api, {
          loadConfig: () => ({ errors: [], autoEnableCodemode: true, servers: [
            { name: 'big', source: 'test', config: { command: 'unused', exposure: 'codemode' } },
          ] }),
          createTransport: (entry) => transport(entry.name),
          logPath: path.join(cwd, 'mcp.log'),
        });
      },
    };
    const natives = [
      { name: 'codemode', factory: createCodemodeExtension(), replaceable: true },
      { name: 'tool-search', factory: createToolSearchExtension(), replaceable: true },
      { name: 'mcp', factory: createMcpExtension(), replaceable: true },
    ];
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [controlled, ...natives],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime,
      model, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) }));
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    assert.ok(pi);
    await waitFor(() => pi!.getAllTools().some((entry) => entry.name === 'mcp__big__search'));

    await session.prompt('Select the big service and read one interface lazily');

    // Interfaces after activation: the lazy member is neither independently
    // declared nor inlined in the Codemode description.
    const afterActivation = requests[1];
    assert.ok(afterActivation, 'the request after activation must be captured');
    const declared = getCurrentTools(afterActivation.messages as unknown as never);
    assert.ok(!declared.some((entry) => entry.name === 'mcp__big__search'),
      'the lazy member must not be independently declared');
    const codemode = declared.find((entry) => entry.name === 'codemode');
    assert.ok(codemode, 'codemode stays declared');
    assert.doesNotMatch(String(codemode.description), /mcp__big__search/,
      'the lazy member schema must not be inlined in the Codemode directory');
    assert.doesNotMatch(String(codemode.description), /q\?*:\s*string/,
      'the parameter schema of the lazy member never reaches the Codemode declaration');

    // The capability result keeps the member name but not its schema.
    const selected = session.messages.findLast((message) => message.role === 'toolResult' && message.toolName === 'capability');
    assert.ok(selected?.role === 'toolResult');
    assert.equal(selected.isError, false, JSON.stringify(selected.content));
    const selectedBody = selected.content.find((part) => part.type === 'text');
    assert.ok(selectedBody?.type === 'text');
    const publicSelection = JSON.parse(selectedBody.text) as { mcp: { interface?: string; tools?: { name?: string }[]; parameters?: unknown }[] };
    const group = publicSelection.mcp[0];
    assert.ok(group?.interface, 'the group must advertise a Codemode query interface');
    assert.deepEqual(group?.tools?.map((member) => member.name), ['mcp__big__search'], 'the member name is retained');
    assert.equal(group?.parameters, undefined, 'the group schema is not repeated');

    // describeTool returns the full interface and the script can call it.
    const executed = session.messages.findLast((message) => message.role === 'toolResult' && message.toolName === 'codemode');
    assert.ok(executed?.role === 'toolResult');
    assert.equal(executed.isError, false, JSON.stringify(executed.content));
    assert.match(JSON.stringify(executed.content), /LAZY_OK/);
    assert.deepEqual(calls, ['big'], 'the lazy member executes through the Codemode sandbox');
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});
