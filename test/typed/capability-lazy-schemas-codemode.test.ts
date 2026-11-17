import assert from 'node:assert/strict';
import test from 'node:test';
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { installCapabilityCodemode, withoutWithheldDeclarations } from '../../src/capability/codemode.ts';
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
    getExposure: () => 'codemode', getNamespace: (name) => namespaceOf(name),
    getPromptGuidelines: (name) => name === 'mcp__docs__search' ? ['LAZY_GUIDE'] : ['PEER_GUIDE'],
  });

  assert.ok(changes?.hiddenDeclarations?.includes('mcp__docs__search'), 'the lazy member declaration is suppressed');
  assert.equal(changes?.hiddenDeclarations?.includes('mcp__other__run'), false, 'a non-lazy member is untouched');
  const description = String(changes?.descriptions?.['codemode'] ?? '');
  assert.match(description, /mcp__docs__search/, 'the withheld member name stays in the directory');
  assert.match(description, /mcp__docs__search description/, 'the withheld member description stays in the directory');
  assert.doesNotMatch(description, /mcp__docs__search\(args:/, 'the withheld member schema is not inlined');
  assert.doesNotMatch(description, /LAZY_GUIDE/, 'the withheld guideline stays in the guidance section');
  assert.match(description, /mcp__other__run\(args:/, 'the non-lazy active member keeps its declaration');
  assert.match(description, /PEER_GUIDE/, 'a non-withheld member keeps its inline guidelines');

  const declared = new Set(declaredTools());
  assert.equal(declared.has('mcp__docs__search'), false, 'declared set excludes the lazy member');
  assert.equal(declared.has('mcp__other__run'), true, 'declared set keeps the non-lazy member');
});

test('a tool:// ref withholds exactly one tool and leaves its peers declared and listed', () => {
  const { pi, definitions, handlers } = registrationFixture('only');
  const declaredTools = installCapabilityCodemode(pi, () => () => true, () => () => true, () => lazyConfig(['tool://fixture-report']));
  const ctx = {} as ExtensionContext;
  for (const handler of handlers.get('session_start') ?? []) (handler as (event: unknown, ctx: ExtensionContext) => void)({}, ctx);

  const report = tool('fixture-report');
  const peer = tool('fixture-other');
  pi.setActiveTools(['codemode', 'fixture-report', 'fixture-other']);
  const changes = definitions.get('codemode')!.prepareLoadout!({
    declared: [report, peer], callable: [report, peer], registered: [report, peer],
    getExposure: () => 'codemode', getNamespace: () => undefined, getPromptGuidelines: () => [],
  });

  assert.ok(changes?.hiddenDeclarations?.includes('fixture-report'), 'only the exact tool ref is withheld');
  assert.equal(changes?.hiddenDeclarations?.includes('fixture-other'), false, 'a peer is untouched');
  const description = String(changes?.descriptions?.['codemode'] ?? '');
  assert.match(description, /fixture-report/, 'the exact tool name stays in the directory');
  assert.match(description, /fixture-report description/, 'the exact tool description stays in the directory');
  assert.doesNotMatch(description, /fixture_report\(args:/, 'the exact tool schema is not inlined');
  assert.match(description, /fixture_other\(args:/, 'the peer keeps its declaration');
  assert.equal(declaredTools().has('fixture-report'), false);
  assert.equal(declaredTools().has('fixture-other'), true);
});

test('a recorded per-tool no-schema mode withholds exactly that tool without config refs', () => {
  const { pi, definitions, handlers } = registrationFixture('only');
  const declaredTools = installCapabilityCodemode(pi, () => () => true, () => () => true, () => lazyConfig([]));
  // Branch shape only: the tool-access view owns replaying these records.
  const branch = [
    { type: 'custom', customType: 'capability-tool-base', data: { version: 1, baseline: ['fixture-report', 'fixture-other'] } },
    { type: 'custom', customType: 'capability-tool-base', data: { version: 1, noSchema: ['fixture-report'] } },
  ];
  const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  for (const handler of handlers.get('session_start') ?? []) (handler as (event: unknown, ctx: ExtensionContext) => void)({}, ctx);

  const report = tool('fixture-report');
  const peer = tool('fixture-other');
  pi.setActiveTools(['codemode', 'fixture-report', 'fixture-other']);
  const changes = definitions.get('codemode')!.prepareLoadout!({
    declared: [report, peer], callable: [report, peer], registered: [report, peer],
    getExposure: () => 'codemode', getNamespace: () => undefined, getPromptGuidelines: () => [],
  });

  assert.ok(changes?.hiddenDeclarations?.includes('fixture-report'), 'the recorded mode withholds the tool');
  assert.equal(changes?.hiddenDeclarations?.includes('fixture-other'), false, 'a peer without a record is untouched');
  const description = String(changes?.descriptions?.['codemode'] ?? '');
  assert.match(description, /fixture-report/, 'the recorded tool name stays in the directory');
  assert.doesNotMatch(description, /fixture_report\(args:/, 'the recorded tool schema is not inlined');
  assert.match(description, /fixture_other\(args:/);
  assert.equal(declaredTools().has('fixture-report'), false);
  assert.equal(declaredTools().has('fixture-other'), true);
});

test('the Codemode declaration itself can never be withheld', () => {
  const { pi, definitions, handlers } = registrationFixture('only');
  const declaredTools = installCapabilityCodemode(pi, () => () => true, () => () => true, () => lazyConfig(['tool://codemode']));
  const branch = [
    { type: 'custom', customType: 'capability-tool-base', data: { version: 1, baseline: ['codemode'] } },
    { type: 'custom', customType: 'capability-tool-base', data: { version: 1, noSchema: ['codemode'] } },
  ];
  const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  for (const handler of handlers.get('session_start') ?? []) (handler as (event: unknown, ctx: ExtensionContext) => void)({}, ctx);

  const codemodeTool = tool('codemode');
  pi.setActiveTools(['codemode']);
  const changes = definitions.get('codemode')!.prepareLoadout!({
    declared: [codemodeTool], callable: [codemodeTool], registered: [codemodeTool],
    getExposure: () => 'model-only', getNamespace: () => undefined, getPromptGuidelines: () => [],
  });

  assert.equal(changes?.hiddenDeclarations?.includes('codemode'), false,
    'the sole execution entry keeps its native declaration');
  assert.equal(declaredTools().has('codemode'), true);
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

test('a withheld entry without an inline declaration never consumes the next entry', () => {
  // The SDK can list an entry's heading/description without inlining its
  // declaration under the inline budget. Stripping must stop at that entry's
  // own boundary, and a namespace heading between entries is not a tool entry.
  const headingOnly = `### \`fixture_report\` (\`fixture-report\`)
fixture-report description

## reports
Search document reports

### \`fixture_other\` (\`fixture-other\`)
fixture-other description

codemode tool declaration:
\`\`\`ts
declare const tools: { fixture_other(args: { q?: string; }): Promise<string>; };
\`\`\``;
  assert.equal(withoutWithheldDeclarations(headingOnly, new Set(['fixture-report'])), headingOnly,
    'the following entry keeps its declaration');

  const withoutPeerDeclaration = `### \`fixture_report\` (\`fixture-report\`)
fixture-report description

### \`fixture_other\` (\`fixture-other\`)
fixture-other description`;
  assert.equal(withoutWithheldDeclarations(withoutPeerDeclaration, new Set(['fixture-report'])),
    withoutPeerDeclaration, 'a directory without any declaration is unchanged');

  const withDeclaration = `### \`fixture_report\` (\`fixture-report\`)
fixture-report description

codemode tool declaration:
\`\`\`ts
declare const tools: { fixture_report(args: { q?: string; }): Promise<string>; };
\`\`\`

### \`fixture_other\` (\`fixture-other\`)
fixture-other description

codemode tool declaration:
\`\`\`ts
declare const tools: { fixture_other(args: { q?: string; }): Promise<string>; };
\`\`\``;
  const expected = `### \`fixture_report\` (\`fixture-report\`)
fixture-report description

### \`fixture_other\` (\`fixture-other\`)
fixture-other description

codemode tool declaration:
\`\`\`ts
declare const tools: { fixture_other(args: { q?: string; }): Promise<string>; };
\`\`\``;
  assert.equal(withoutWithheldDeclarations(withDeclaration, new Set(['fixture-report'])), expected,
    'only the withheld entry declaration is removed');
});
