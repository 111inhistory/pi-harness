import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodemodeExtension, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { installCapabilityCodemode } from '../../src/capability/codemode.ts';
import { installNativeDiscoveryBoundary } from '../../src/capability/native-discovery.ts';
import { waitFor } from '../../test-support/async.ts';

function registrationFixture(mode: 'on' | 'only' = 'on') {
  const definitions = new Map<string, ToolDefinition>();
  const handlers = new Map<string, unknown[]>();
  let active = ['codemode', 'gate'];
  const pi = {
    registerTool: (tool: ToolDefinition) => { definitions.set(tool.name, tool); },
    on: (event: string, handler: unknown) => { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
    getSettings: () => ({ codemode: { mode } }),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = names; },
    getAllTools: () => [...definitions.values()],
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  return { pi, definitions, handlers };
}

test('old native Codemode catalogs are removed from request declarations, not from user text', () => {
  const { pi, definitions, handlers } = registrationFixture();
  createCodemodeExtension()(pi);
  const original = definitions.get('codemode')!;
  const privateTool: AgentTool = {
    name: 'mcp__unselected_fixture__inspect', label: 'Private inspector', description: 'PRIVATE_OLD_CATALOG',
    parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }),
  };
  const legacy = original.prepareLoadout!({
    declared: [], registered: [privateTool], callable: [privateTool],
    getExposure: () => 'codemode', getNamespace: () => ({ name: 'mcp__unselected_fixture', aliases: ['unselected_fixture'] }),
    getPromptGuidelines: () => [],
  })!.descriptions!['codemode']!;
  assert.match(legacy, /searchTools/);
  assert.match(legacy, /PRIVATE_OLD_CATALOG/);

  installNativeDiscoveryBoundary(pi);
  const context = { sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;
  const user = { role: 'user' as const, content: 'Keep user text: searchTools and mcp__unselected_fixture', timestamp: 1 };
  const messages: Message[] = [{
    role: 'system', content: 'Keep base instructions', timestamp: 0,
    sections: { mcp_servers: '<mcp_servers>PRIVATE_OLD_DIRECTORY</mcp_servers>' },
    toolsAdded: [
      { name: 'codemode', description: legacy, parameters: original.parameters },
      { name: privateTool.name, description: privateTool.description, parameters: privateTool.parameters },
    ],
  }, user];
  const project = handlers.get('context_with_system')!.at(-1) as
    (event: { messages: Message[] }, ctx: ExtensionContext) => { messages: Message[] };
  const result = project({ messages }, context);
  const system = result.messages[0]!;
  assert.equal(system.role, 'system');
  assert.doesNotMatch(JSON.stringify(system), /searchTools|PRIVATE_OLD|mcp__unselected_fixture/);
  assert.equal(system.content, 'Keep base instructions');
  assert.deepEqual(result.messages[1], user);
  assert.match(JSON.stringify(messages[0]), /PRIVATE_OLD_CATALOG/, 'projection never rewrites stored history');
});

test('only mode hides direct exposure, not active codemode or deferred declarations', () => {
  const { pi, definitions } = registrationFixture('only');
  const declaredTools = installCapabilityCodemode(pi, () => true, () => true);
  const names = ['codemode', 'direct_tool', 'script_tool', 'deferred_tool'];
  const tools: AgentTool[] = names.map((name) => ({
    name, label: name, description: name, parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [], details: undefined }),
  }));
  const exposure = (name: string) => name === 'codemode' ? 'model-only' as const
    : name === 'direct_tool' ? 'direct' as const : name === 'script_tool' ? 'codemode' as const : 'deferred' as const;
  pi.setActiveTools(names);
  definitions.get('codemode')!.prepareLoadout!({
    declared: tools, callable: tools.slice(1), registered: tools,
    getExposure: exposure, getNamespace: () => undefined, getPromptGuidelines: () => [],
  });
  assert.deepEqual([...declaredTools()], ['codemode', 'script_tool', 'deferred_tool']);
  pi.setActiveTools(names.slice(1));
  assert.deepEqual([...declaredTools()], names.slice(1), 'inactive Codemode cannot hide declarations');
});

test('a Codemode admission aborted after wake-up passes the free worker to the next script', { timeout: 10000 }, async () => {
  const oldLimit = process.env['PI_CODEMODE_MAX_WORKERS'];
  process.env['PI_CODEMODE_MAX_WORKERS'] = '1';
  const { pi, definitions } = registrationFixture();
  installCapabilityCodemode(pi, () => true, () => true);
  const definition = definitions.get('codemode')!;
  let gateStarted = false;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const gateTool: AgentTool = { name: 'gate', label: 'Gate', description: 'Hold one real sandbox worker',
    parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }) };
  const ctx = {
    tools: [gateTool], sessionManager: { getBranch: () => [] }, modelRegistry: {},
    executeTool: async () => {
      gateStarted = true;
      await gate;
      return { toolCall: { id: 'gate-call' }, isError: false,
        result: { content: [{ type: 'text', text: 'released' }], details: {} } };
    },
  } as unknown as ExtensionToolContext;
  const second = new AbortController();
  const third = new AbortController();
  let reads = 0;
  // First observation: queued and alive. Second: just awakened, now aborted.
  // This makes the grant/abort interleaving deterministic without test sleeps.
  const abortOnGrant = new Proxy(second.signal, { get(target, key) {
    if (key === 'aborted') return ++reads > 1;
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const firstRun = definition.execute('first', { code: 'await tools.gate({}); return "released";' }, undefined, undefined, ctx);
  let secondRun: Promise<unknown> | undefined;
  let thirdRun: Promise<unknown> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitFor(() => gateStarted);
    secondRun = assert.rejects(definition.execute('second', { code: 'return "must not start";' }, abortOnGrant, undefined, ctx), { name: 'AbortError' });
    thirdRun = definition.execute('third', { code: 'return "THIRD_ADMITTED";' }, third.signal, undefined, ctx);
    releaseGate();
    await firstRun;
    await secondRun;
    const result = await Promise.race([thirdRun, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Free worker was stranded after the aborted admission.')), 3000);
    })]);
    assert.match(JSON.stringify(result), /THIRD_ADMITTED/);
  } finally {
    clearTimeout(timeout);
    releaseGate(); second.abort(); third.abort();
    await Promise.allSettled([firstRun, secondRun, thirdRun]);
    if (oldLimit === undefined) delete process.env['PI_CODEMODE_MAX_WORKERS'];
    else process.env['PI_CODEMODE_MAX_WORKERS'] = oldLimit;
  }
});
