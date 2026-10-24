import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { getCurrentTools, type AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { McpTransportFactory } from '@earendil-works/pi-coding-agent';
type McpTransport = ReturnType<McpTransportFactory>;
type JsonRpcMessage = Parameters<Parameters<McpTransport['onMessage']>[0]>[0];
import capabilityExtension from '../../extensions/capability.mjs';
import { installCapabilityMcp } from '../../src/capability/native-discovery.ts';
import { setCapabilityParent } from '../../src/capability-scope.mjs';
import { waitFor } from '../../test-support/async.mjs';

for (const nativeFirst of [false, true]) {
  test(`native discovery is disabled while selected MCP execution survives (${nativeFirst ? 'native-first' : 'harness-first'})`, async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'pi-native-discovery-'));
    const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
    process.env['PI_CODING_AGENT_DIR'] = path.join(cwd, 'agent');
    let session: AgentSession | undefined;
    let pi: ExtensionAPI | undefined;
    const calls: string[] = [];
    const resourceReads: string[] = [];
    const requests: { messages: { role: string }[] }[] = [];
    const blocked: { isError: boolean }[] = [];
    const errors: unknown[] = [];
    try {
      const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      const model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
      assert.ok(model);
      runtime.getAuth = async () => ({ auth: { apiKey: 'offline-only' }, env: {} });
      runtime.hasConfiguredAuth = () => true;
      let rootStep = 0;
      let childStep = 0;
      let classifications = 0;
      runtime.classify = async (classifier) => {
        classifications++;
        return { api: classifier.api, provider: classifier.provider, model: classifier.id,
          answers: { ready: { type: 'bool', probability: 1 } }, stopReason: 'stop', timestamp: Date.now(),
          usage: { input: 2, output: 1, totalTokens: 3, cacheRead: 0, cacheWrite: 0,
            cost: { input: 0.002, output: 0.001, total: 0.003, cacheRead: 0, cacheWrite: 0 } } };
      };
      const fixturePath = path.join(cwd, 'fixture.txt');
      await writeFile(fixturePath, 'BASIC_READ_REMAINS_CALLABLE');
      const checkGlobals = `
        if (typeof searchTools !== 'undefined' || ('searchTools' in globalThis)) throw Error('searchTools is still installed');
        if (Function('return typeof searchTools')() !== 'undefined') throw Error('searchTools escaped lexical scope');
        if (ALL_TOOLS.some(t => t.name.includes('unselected_fixture'))) throw Error('unselected tool leaked');
        if (Object.keys(tools).some(n => n.includes('unselected_fixture'))) throw Error('unselected callable leaked');
        if (await describeTool('mcp__unselected_fixture__unrelated')) throw Error('unselected interface leaked');
        if (await describeNamespace('mcp__unselected_fixture')) throw Error('unselected namespace leaked');
      `;
      const response = (content: unknown[], stopReason: 'stop' | 'toolUse'): AssistantMessage => ({
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content, stopReason, timestamp: Date.now(),
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
      } as AssistantMessage);
      const tool = (name: string, args: Record<string, unknown>) => response([
        { type: 'toolCall', id: `call-${rootStep}-${childStep}`, name, arguments: args },
      ], 'toolUse');
      runtime.streamSimple = (_model, context) => {
        const stream = new AssistantMessageEventStream();
        const internal = getCurrentTools(context.messages).some((entry) => entry.name === 'capability_search');
        let message: AssistantMessage;
        if (internal) {
          childStep++;
          if (childStep === 1) message = tool('capability_search', { query: 'inspect', src: 'local' });
          else if (childStep === 2) {
            const result = context.messages.findLast((entry) => entry.role === 'toolResult' && entry.toolName === 'capability_search');
            assert.ok(result && result.role === 'toolResult');
            const body = result.content.find((part) => part.type === 'text');
            assert.ok(body?.type === 'text');
            assert.equal((JSON.parse(body.text) as { mcp: unknown[] }).mcp.length, 1);
            message = tool('capability_search', { query: 'tool://read_mcp_resource', src: 'local' });
          } else if (childStep === 3) message = tool('capability_search', { query: 'namespace://mcp__no_resources_fixture', src: 'local' });
          else message = tool('submit_result', { refs: ['namespace://mcp__selected_fixture', 'tool://read_mcp_resource', 'namespace://mcp__no_resources_fixture'] });
        } else {
          requests.push(structuredClone(context));
          rootStep++;
          if (rootStep === 1) message = tool('probe', {});
          else if (rootStep === 2) message = tool('codemode', { code: `${checkGlobals}
            const candidates = await models.getModelsOfType('classifier');
            if (!candidates.length) throw Error('classifier catalog missing');
            const result = await models.classify(candidates[0], { state: {}, questions: { ready: { type: 'bool', instructions: 'Ready?', criteria: { true: 'yes', false: 'no' } } } });
            if (result.stopReason !== 'stop') throw Error('classifier execution failed');
            store('before-selection', true);
            return 'NO_NATIVE_SEARCH';` });
          else if (rootStep === 4) message = tool('capability', {});
          else if (rootStep === 5) message = tool('codemode', { code: `${checkGlobals}
            if (load('before-selection') !== true) throw Error('branch store was lost');
            const [result, read, resource] = await Promise.all([
              tools.mcp__selected_fixture__inspect({}), tools.read({ path: ${JSON.stringify(fixturePath)} }),
              tools.read_mcp_resource({ server: 'selected_fixture', uri: 'memory://fixture' })
            ]);
            if (!JSON.stringify(resource).includes('RESOURCE_READ_selected_fixture')) throw Error('selected resource reader failed');
            let refused = 0;
            for (const server of ['unselected_fixture', 'missing', 'no_resources_fixture']) {
              try { await tools.read_mcp_resource({ server, uri: 'memory://fixture' }); }
              catch (error) {
                if (error.message.includes('Servers with resources:')) throw Error('resource error leaked server catalog');
                refused++;
              }
            }
            if (refused !== 3) throw Error('resource reader escaped server selection');
            if (!JSON.stringify(result).includes('MCP_EXECUTED')) throw Error('MCP result missing');
            if (!JSON.stringify(read).includes('BASIC_READ_REMAINS_CALLABLE')) throw Error('basic read failed');
            store('selection-survives', true);
            return 'SCOPED_SCRIPT_EXECUTED';
          ` });
          else if (rootStep === 7) message = tool('codemode', { code: `${checkGlobals}
            if (ALL_TOOLS.some(t => t.name.includes('late_unselected'))) throw Error('late catalog leaked');
            if (await describeNamespace('mcp__late_unselected')) throw Error('late namespace leaked');
            if (await describeTool('mcp__selected_fixture__inspect')) throw Error('role-denied interface leaked');
            let denied = false;
            try { await tools.read_mcp_resource({ server: 'selected_fixture', uri: 'memory://fixture' }); }
            catch { denied = true; }
            if (!denied) throw Error('resource read escaped the current role');
            return 'AFTER_LATE_REGISTRATION';
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
              protocolVersion: '2025-11-25', capabilities: { tools: {}, ...(server === 'no_resources_fixture' ? {} : { resources: {} }) },
              serverInfo: { name: server, version: '1' }, instructions: `PRIVATE_CATALOG_${server}`,
            };
            else if (message.method === 'tools/list') result = { tools: [{
              name: server === 'selected_fixture' ? 'inspect' : 'unrelated',
              description: server === 'selected_fixture' ? 'Inspect selected documents' : 'Unrelated private operation',
              inputSchema: { type: 'object', properties: {} },
            }] };
            else if (message.method === 'tools/call') {
              calls.push(server);
              result = { content: [{ type: 'text', text: 'MCP_EXECUTED' }] };
            } else if (message.method === 'resources/read') {
              resourceReads.push(server);
              result = { contents: [{ uri: 'memory://fixture', mimeType: 'text/plain', text: `RESOURCE_READ_${server}` }] };
            } else {
              calls.push(message.method);
              result = { resources: [], resourceTemplates: [] };
            }
            const reply = { jsonrpc: '2.0', id: message.id, result } as JsonRpcMessage;
            queueMicrotask(() => { for (const listener of listeners) listener(reply); });
          },
        };
      };
      const settingsManager = SettingsManager.inMemory({
        retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
        defaultTools: nativeFirst ? ['+codemode', '+tool_search'] : ['+tool_search'],
      });
      const controlled = {
        name: 'harness-boundary',
        factory(api: ExtensionAPI) {
          pi = api;
          capabilityExtension(api);
          installCapabilityMcp(api, {
            loadConfig: () => ({ errors: [], autoEnableCodemode: true, servers: [
              { name: 'selected_fixture', source: 'test', config: { command: 'unused', exposure: 'direct' } },
              { name: 'unselected_fixture', source: 'test', config: { command: 'unused', exposure: 'deferred' } },
              { name: 'no_resources_fixture', source: 'test', config: { command: 'unused', exposure: 'deferred' } },
            ] }),
            createTransport: (entry) => transport(entry.name),
            logPath: path.join(cwd, 'mcp.log'),
          });
          api.registerTool({
            name: 'probe', label: 'Probe', description: 'Verify execution boundaries',
            parameters: { type: 'object', properties: {} },
            execute: async (_id, _args, _signal, _update, ctx) => {
              api.setActiveTools([...api.getActiveTools(), 'codemode', 'tool_search', 'mcp__selected_fixture__inspect']);
              for (const name of ['tool_search', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'mcp__selected_fixture__inspect']) {
                const outcome = await ctx.executeTool(name, {});
                blocked.push(outcome);
                assert.equal(outcome.isError, true, `${name} cannot bypass Capability selection`);
              }
              return { content: [{ type: 'text', text: 'Boundaries enforced' }], details: {} };
            },
          });
        },
      };
      const natives = [
        { name: 'codemode', factory: createCodemodeExtension(), replaceable: true },
        { name: 'tool-search', factory: createToolSearchExtension(), replaceable: true },
        { name: 'mcp', factory: createMcpExtension(), replaceable: true },
      ];
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir: process.env['PI_CODING_AGENT_DIR']!, settingsManager,
        noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: nativeFirst ? [...natives, controlled] : [controlled, ...natives],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      ({ session } = await createAgentSession({ cwd, agentDir: process.env['PI_CODING_AGENT_DIR']!, modelRuntime: runtime,
        model, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) }));
      await session.bindExtensions({ onError: (error) => errors.push(error) });
      assert.ok(pi);
      await waitFor(() => pi!.getAllTools().some((entry) => entry.name === 'mcp__unselected_fixture__unrelated'));
      await session.prompt('Verify native discovery is unavailable');
      assert.equal(blocked.length, 5);
      assert.deepEqual(calls, [], 'blocked discovery and unselected execution never reach an MCP server');
      const first = JSON.stringify(requests[0]);
      assert.doesNotMatch(first, /mcp_servers|PRIVATE_CATALOG_|selected_fixture|unselected_fixture/);
      assert.doesNotMatch(session.systemPrompt, /<mcp_servers>/);
      for (const name of ['read', 'bash', 'edit', 'write']) assert.ok(pi.getActiveTools().includes(name), `${name} remains available`);
      assert.equal(pi.getAllTools().find((entry) => entry.name === 'tool_search')?.exposure, 'hidden');
      assert.ok(!pi.getActiveTools().includes('tool_search'));
      assert.ok(pi.getActiveTools().includes('codemode'), 'Codemode execution remains enabled');

      await session.prompt('Find a capability for inspection and execute the selected tool');
      const selected = session.messages.findLast((message) => message.role === 'toolResult' && message.toolName === 'capability');
      assert.ok(selected?.role === 'toolResult');
      assert.equal(selected.isError, false, JSON.stringify(selected.content));
      const executed = session.messages.findLast((message) => message.role === 'toolResult' && message.toolName === 'codemode');
      assert.ok(executed?.role === 'toolResult');
      assert.equal(executed.isError, false, JSON.stringify(executed.content));
      assert.deepEqual(calls, ['selected_fixture']);
      assert.deepEqual(resourceReads, ['selected_fixture'], 'only the selected, resource-enabled server is read');
      assert.equal(classifications, 1, 'non-LLM model execution is retained');
      setCapabilityParent(pi, null, ['mcp__selected_fixture__inspect']);
      pi.registerMcpServer('late_unselected', { command: 'unused', exposure: 'deferred' });
      await waitFor(() => pi!.getAllTools().some((entry) => entry.name === 'mcp__late_unselected__unrelated'));
      await session.prompt('Continue after a server registers late');
      assert.ok(!pi.getActiveTools().includes('tool_search'), 'late servers cannot restore native search');
      assert.deepEqual(calls, ['selected_fixture']);
      assert.deepEqual(resourceReads, ['selected_fixture'], 'role denial closes resource reads without replacing branch selection');
      assert.ok(pi.getActiveTools().includes('mcp__selected_fixture__inspect'));
      assert.ok(!pi.getActiveTools().includes('mcp__unselected_fixture__unrelated'));
      // The adversarial scripts explicitly contain guessed names. Those are
      // user/model text, not default catalog injection; inspect system state.
      const systemState = requests.flatMap((request) => request.messages.filter((message) => message.role === 'system'));
      assert.doesNotMatch(JSON.stringify(systemState), /PRIVATE_CATALOG_unselected_fixture|unselected_fixture|late_unselected|<mcp_servers>/);
      const scripts = session.messages.filter((message) => message.role === 'toolResult' && message.toolName === 'codemode');
      assert.equal(scripts.length, 3);
      assert.equal(scripts[0]?.role === 'toolResult' && scripts[0].usage?.cost.total, 0.003);
      for (const message of scripts) assert.equal(message.role === 'toolResult' && message.isError, false);
      assert.match(JSON.stringify(scripts), /NO_NATIVE_SEARCH/);
      assert.match(JSON.stringify(scripts), /SCOPED_SCRIPT_EXECUTED/);
      assert.match(JSON.stringify(scripts), /AFTER_LATE_REGISTRATION/);
      const branch = session.sessionManager.getBranch();
      assert.ok(branch.some((entry) => entry.type === 'custom' && entry.customType === 'capability-discovery'));
      assert.doesNotMatch(JSON.stringify(branch), /<mcp_servers>/);
      assert.deepEqual(errors, []);
    } finally {
      session?.dispose();
      if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
