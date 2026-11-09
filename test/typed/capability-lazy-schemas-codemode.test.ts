import assert from 'node:assert/strict';
import test from 'node:test';
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { installCapabilityCodemode } from '../../src/capability/codemode.ts';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfig } from '../../src/harness-config.ts';

function registrationFixture(mode: 'on' | 'only') {
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

function lazyConfig(refs: readonly string[]): HarnessConfig {
  return { ...DEFAULT_HARNESS_CONFIG, capability: { ...DEFAULT_HARNESS_CONFIG.capability, lazySchemas: refs } };
}

function tool(name: string): AgentTool {
  return {
    name, label: name, description: `${name} description`,
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    execute: async () => ({ content: [], details: {} }),
  };
}

const namespaceOf = (name: string) => name.startsWith('mcp__docs')
  ? { name: 'mcp__docs', aliases: ['docs'] }
  : { name: 'mcp__other', aliases: ['other'] };

test('only mode + lazySchemas hides matched groups from the Codemode directory and declarations', () => {
  const { pi, definitions, handlers } = registrationFixture('only');
  const declaredTools = installCapabilityCodemode(pi, () => () => true, () => () => true, () => lazyConfig(['mcp://docs']));
  const ctx = {} as ExtensionContext;
  for (const handler of handlers.get('session_start') ?? []) (handler as (event: unknown, ctx: ExtensionContext) => void)({}, ctx);

  const docs = tool('mcp__docs__search');
  const other = tool('mcp__other__run');
  const tools = [docs, other];
  pi.setActiveTools(['codemode', 'mcp__docs__search', 'mcp__other__run']);
  const changes = definitions.get('codemode')!.prepareLoadout!({
    declared: tools, callable: tools, registered: tools,
    getExposure: () => 'codemode', getNamespace: (name) => namespaceOf(name), getPromptGuidelines: () => [],
  });

  assert.ok(changes?.hiddenDeclarations?.includes('mcp__docs__search'), 'the lazy member declaration is suppressed');
  assert.equal(changes?.hiddenDeclarations?.includes('mcp__other__run'), false, 'a non-lazy member is untouched');
  const description = String(changes?.descriptions?.['codemode'] ?? '');
  assert.doesNotMatch(description, /mcp__docs__search/, 'the lazy member schema is not inlined in the Codemode directory');
  assert.match(description, /mcp__other__run/, 'the non-lazy active member still appears');

  const declared = new Set(declaredTools());
  assert.equal(declared.has('mcp__docs__search'), false, 'declared set excludes the lazy member');
  assert.equal(declared.has('mcp__other__run'), true, 'declared set keeps the non-lazy member');
});

test('lazySchemas is inert when Codemode is not in only mode', () => {
  const { pi, definitions, handlers } = registrationFixture('on');
  const declaredTools = installCapabilityCodemode(pi, () => () => true, () => () => true, () => lazyConfig(['mcp://docs']));
  const ctx = {} as ExtensionContext;
  for (const handler of handlers.get('session_start') ?? []) (handler as (event: unknown, ctx: ExtensionContext) => void)({}, ctx);

  const docs = tool('mcp__docs__search');
  pi.setActiveTools(['codemode', 'mcp__docs__search']);
  const changes = definitions.get('codemode')!.prepareLoadout!({
    declared: [docs], callable: [docs], registered: [docs],
    getExposure: () => 'codemode', getNamespace: (name) => namespaceOf(name), getPromptGuidelines: () => [],
  });

  assert.equal(changes?.hiddenDeclarations?.includes('mcp__docs__search'), false, 'on mode keeps the native declaration behaviour');
  assert.match(String(changes?.descriptions?.['codemode'] ?? ''), /mcp__docs__search/);
  assert.equal(declaredTools().has('mcp__docs__search'), true);
});
