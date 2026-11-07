import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodemodeExtension, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { installCapabilityCodemode } from '../../src/capability/codemode.ts';
import { installNativeDiscoveryBoundary } from '../../src/capability/native-discovery.ts';
import { DEFAULT_HARNESS_CONFIG } from '../../src/harness-config.ts';
import capabilityExtension from '../../src/capability/extension.ts';
import { waitFor } from '../../test-support/async.ts';

function registrationFixture(mode: 'on' | 'only' = 'on') {
  const definitions = new Map<string, ToolDefinition>();
  const handlers = new Map<string, unknown[]>();
  let active = ['codemode', 'gate'];
  const pi = {
    registerTool: (tool: ToolDefinition) => { definitions.set(tool.name, tool); },
    registerCommand: () => {},
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
  const declaredTools = installCapabilityCodemode(pi, () => () => true, () => () => true);
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
  installCapabilityCodemode(pi, () => () => true, () => () => true);
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

function scriptOutput(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}

function returnedValue(result: unknown): unknown {
  const text = scriptOutput(result);
  assert.doesNotMatch(text, /Script error/, text);
  const start = text.lastIndexOf('\nOutput:\n');
  assert.notEqual(start, -1, text);
  return JSON.parse(text.slice(start + '\nOutput:\n'.length));
}

test('capabilityExtension forwards its fixed config to the installed Codemode executor', { timeout: 20000 }, async () => {
  const { pi, definitions } = registrationFixture();
  const config = { ...DEFAULT_HARNESS_CONFIG,
    codemode: { memoryLimitBytes: 8 * 1024 * 1024, defaultMaxOutputTokens: 2 } };
  capabilityExtension(pi, { discovery: false, config });
  const ctx = {
    tools: [], sessionManager: { getBranch: () => [] }, modelRegistry: {},
  } as unknown as ExtensionToolContext;
  const result = await definitions.get('codemode')!.execute('fixed-config',
    { code: 'return "0123456789ABCDEF";' }, undefined, undefined, ctx);
  assert.match(scriptOutput(result), /…output truncated…/);
  assert.doesNotMatch(scriptOutput(result), /0123456789ABCDEF/);
});

test('configured Codemode memory and output defaults apply per call while script options win', { timeout: 20000 }, async () => {
  const { pi, definitions } = registrationFixture();
  const config = { ...DEFAULT_HARNESS_CONFIG,
    codemode: { memoryLimitBytes: 8 * 1024 * 1024, defaultMaxOutputTokens: 2 } };
  installCapabilityCodemode(pi, () => () => true, () => () => true, () => config);
  const ctx = {
    tools: [], sessionManager: { getBranch: () => [] }, modelRegistry: {},
  } as unknown as ExtensionToolContext;
  const definition = definitions.get('codemode')!;

  const bounded = await definition.execute('bounded-output', { code: 'return "0123456789ABCDEF";' }, undefined, undefined, ctx);
  const text = scriptOutput(bounded);
  assert.match(text, /…output truncated…/);
  assert.doesNotMatch(text, /0123456789ABCDEF/);
  assert.equal(typeof (bounded as { details?: { fullOutputPath?: unknown } }).details?.fullOutputPath, 'string');

  const overridden = await definition.execute('overridden-output',
    { code: '// @options: {"max_output_tokens": 10000}\nreturn "0123456789ABCDEF";' }, undefined, undefined, ctx);
  assert.match(scriptOutput(overridden), /\nOutput:\n0123456789ABCDEF\n?$/);

  const exhausted = await definition.execute('memory-limit',
    { code: '// @options: {"max_output_tokens": 10000}\nreturn "x".repeat(16 * 1024 * 1024).length;' }, undefined, undefined, ctx);
  assert.equal((exhausted as { isError?: boolean }).isError, true);
  assert.match(scriptOutput(exhausted), /out of memory/i);
});

const BIG_PARAMETER_GUIDANCE = `BIG_PARAMETER_GUIDANCE ${'describe the query in detail. '.repeat(40)}`;
const BIG_PROMPT_GUIDELINE = `BIG_PROMPT_GUIDELINE ${'prefer short queries. '.repeat(40)}`;

function bigFixture() {
  const { pi, definitions } = registrationFixture();
  const bigParameters = {
    type: 'object',
    properties: { query: { type: 'string', description: BIG_PARAMETER_GUIDANCE } },
    required: ['query'],
  } as const;
  const bigTool: AgentTool = {
    name: 'big_tool', label: 'Big tool', description: 'Search the big fixture index.',
    parameters: bigParameters, outputSchema: { type: 'object', properties: { hits: { type: 'array', items: { type: 'string' } } } },
    execute: async () => ({ content: [], details: {} }),
  };
  const secondTool: AgentTool = {
    name: 'second_tool', label: 'Second tool', description: 'Read one big fixture document.',
    parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }),
  };
  const namespace = { name: 'fixture_ns', aliases: ['fixture'], description: 'Fixture namespace', instructions: 'FIXTURE_INSTRUCTIONS' };
  for (const tool of [bigTool, secondTool]) {
    definitions.set(tool.name, {
      ...tool, promptGuidelines: [BIG_PROMPT_GUIDELINE], namespace,
    } as unknown as ToolDefinition);
  }
  pi.setActiveTools(['codemode', 'big_tool', 'second_tool']);
  installCapabilityCodemode(pi, () => () => true, () => () => true);
  const ctx = {
    tools: [bigTool, secondTool], sessionManager: { getBranch: () => [] }, modelRegistry: {},
  } as unknown as ExtensionToolContext;
  return { definitions, ctx };
}

test('sandbox ALL_TOOLS is a short plain listing while describeTool keeps the full declaration', async () => {
  const { definitions, ctx } = bigFixture();
  const result = await definitions.get('codemode')!.execute('catalog', { code: `
    const listed = ALL_TOOLS.map((tool) => ({ name: tool.name, description: tool.description }));
    const full = await describeTool('big_tool');
    const namespace = await describeNamespace('fixture');
    return JSON.stringify({ listed, full, namespace });
  ` }, undefined, undefined, ctx);
  const value = returnedValue(result) as {
    listed: { name: string; description: string }[];
    full: string;
    namespace: { name: string; aliases: string[]; description: string; instructions: string; tools: string[] };
  };
  assert.deepEqual(value.listed.map((tool) => tool.name), ['big_tool', 'second_tool']);
  for (const entry of value.listed) {
    assert.ok(entry.description.length <= 200, `ALL_TOOLS description is long: ${entry.description.length}`);
    assert.doesNotMatch(entry.description, /BIG_PARAMETER_GUIDANCE|BIG_PROMPT_GUIDELINE|declare const tools|properties/);
  }
  assert.equal(value.listed[0]!.description, 'Search the big fixture index.');
  assert.equal(value.listed[1]!.description, 'Read one big fixture document.');

  assert.match(value.full, /Search the big fixture index\./);
  assert.match(value.full, /declare const tools/);
  assert.match(value.full, /BIG_PARAMETER_GUIDANCE/);
  assert.match(value.full, /BIG_PROMPT_GUIDELINE/, 'describeTool keeps prompt guidelines');

  assert.deepEqual(value.namespace.tools, ['big_tool', 'second_tool']);
  assert.equal(value.namespace.name, 'fixture_ns');
  assert.equal(value.namespace.description, 'Fixture namespace');
  assert.doesNotMatch(JSON.stringify(value.namespace), /BIG_PARAMETER_GUIDANCE|declare const tools|properties/,
    'describeNamespace lists members without their schemas');
});

test('a running sandbox keeps its tool snapshot and the next call sees newly activated tools', async () => {
  const { pi, definitions } = registrationFixture();
  let gateStarted = false;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const gateTool: AgentTool = {
    name: 'gate', label: 'Gate', description: 'Hold the script open.',
    parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }),
  };
  const lateTool: AgentTool = {
    name: 'late_tool', label: 'Late tool', description: 'Activated while a script runs.',
    parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }),
  };
  const ctxTools = [gateTool];
  const ctx = {
    tools: ctxTools, sessionManager: { getBranch: () => [] }, modelRegistry: {},
    executeTool: async () => {
      gateStarted = true;
      await gate;
      return { toolCall: { id: 'gate-call' }, isError: false, result: { content: [{ type: 'text', text: 'released' }], details: {} } };
    },
  } as unknown as ExtensionToolContext;
  pi.setActiveTools(['codemode', 'gate']);
  installCapabilityCodemode(pi, () => () => true, () => () => true);
  const definition = definitions.get('codemode')!;
  const code = 'await tools.gate({}); return JSON.stringify(ALL_TOOLS.map((tool) => tool.name));';
  const running = definition.execute('snapshot', { code }, undefined, undefined, ctx);
  try {
    await waitFor(() => gateStarted);
    ctxTools.push(lateTool);
    pi.setActiveTools(['codemode', 'gate', 'late_tool']);
  } finally {
    releaseGate();
  }
  const during = (returnedValue(await running) as string[]).sort();
  assert.deepEqual(during, ['gate'], 'the running sandbox keeps its own tool snapshot');

  const next = (returnedValue(await definition.execute('next', { code }, undefined, undefined, ctx)) as string[]).sort();
  assert.deepEqual(next, ['gate', 'late_tool'], 'the next Codemode call sees the newly activated tool');
});

test('codemode reach claims no servers instead of every active tool', () => {
  const { pi, definitions } = registrationFixture();
  pi.setActiveTools(['codemode', 'mcp__fixture_server__inspect', 'read']);
  installCapabilityCodemode(pi, () => () => true, () => () => true);
  const reachesTools = definitions.get('codemode')!.reachesTools!;
  for (const code of [
    'return ALL_TOOLS.map((tool) => tool.name);',
    'return await describeTool("mcp__fixture_server__inspect");',
    'return await describeNamespace("fixture_server");',
    'return await tools.mcp__fixture_server__inspect({});',
  ]) {
    const reach = reachesTools({ code });
    assert.notEqual(reach, 'all');
    assert.ok(Array.isArray(reach) && !reach.includes('mcp__fixture_server__inspect'), 'no all-active enumeration');
    assert.deepEqual(reach, [], `lookup script must not wait for MCP servers: ${code}`);
  }
});
