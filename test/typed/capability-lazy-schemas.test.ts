import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lazySchemasActive,
  matchesLazySchemaRef,
  parseLazySchemaRefs,
  planNoSchema,
  type LazySchemaHost,
  type NoSchemaSelection,
  type NoSchemaTool,
} from '../../src/capability/lazy-schemas.ts';

test('parseLazySchemaRefs keeps MCP groups, namespace groups and exact tool refs', () => {
  assert.equal(parseLazySchemaRefs(undefined).empty, true);
  assert.equal(parseLazySchemaRefs([]).empty, true);

  const parsed = parseLazySchemaRefs(['mcp://large-service', 'namespace://large-extension', 'tool://fixture-report']);
  assert.deepEqual([...parsed.mcpServers], ['large-service']);
  assert.deepEqual([...parsed.namespaces], ['large-extension']);
  assert.deepEqual([...parsed.tools], ['fixture-report']);
  assert.equal(parsed.empty, false);
  assert.deepEqual(parsed.refs, ['mcp://large-service', 'namespace://large-extension', 'tool://fixture-report']);
});

test('parseLazySchemaRefs normalizes member refs, whitespace, encoding and ignores unknown schemes', () => {
  const parsed = parseLazySchemaRefs([
    '  mcp://docs/get  ',
    'mcp://my%20server',
    'namespace://grp',
    'tool://fixture report',
    'tool://',
    '',
  ]);
  assert.deepEqual([...parsed.mcpServers].sort(), ['docs', 'my server']);
  assert.deepEqual([...parsed.namespaces], ['grp']);
  assert.deepEqual([...parsed.tools], ['fixture report']);
  assert.deepEqual(parsed.refs, ['mcp://docs/get', 'mcp://my%20server', 'namespace://grp', 'tool://fixture report']);

  assert.equal(parseLazySchemaRefs(['weird', 'tool://']).empty, true);
});

test('matchesLazySchemaRef matches MCP server, alias, tool prefix, namespace and one exact tool', () => {
  const refs = parseLazySchemaRefs(['mcp://docs', 'namespace://subagent', 'tool://fixture-report']);
  assert.equal(matchesLazySchemaRef(refs, 'mcp__docs__search', { name: 'mcp__docs', aliases: ['docs'] }), true);
  assert.equal(matchesLazySchemaRef(refs, 'mcp__docs__search', { name: 'mcp__docs' }), true);
  assert.equal(matchesLazySchemaRef(refs, 'mcp__other__x', { name: 'mcp__other' }), false);
  // Bare alias server match.
  assert.equal(matchesLazySchemaRef(refs, 'docs__search', { name: 'docs', aliases: ['mcp__docs'] }), true);
  // Namespace name and alias.
  assert.equal(matchesLazySchemaRef(refs, 'subagent_create', { name: 'subagent' }), true);
  assert.equal(matchesLazySchemaRef(refs, 'x', { name: 'other', aliases: ['subagent'] }), true);
  // One exact tool, with or without namespace metadata.
  assert.equal(matchesLazySchemaRef(refs, 'fixture-report', undefined), true);
  assert.equal(matchesLazySchemaRef(refs, 'fixture-report', { name: 'reports' }), true);
  assert.equal(matchesLazySchemaRef(refs, 'fixture_report', undefined), false);
  // No refs never match.
  assert.equal(matchesLazySchemaRef(parseLazySchemaRefs([]), 'mcp__docs__search', { name: 'mcp__docs' }), false);
});

const activeHost = (settings: unknown, tools: readonly string[] = ['codemode']): LazySchemaHost => ({
  getActiveTools: () => [...tools],
  getSettings: () => settings as ReturnType<NonNullable<LazySchemaHost['getSettings']>>,
});

const modeOf = (map: Readonly<Record<string, 'no-schema' | 'schema'>>): NoSchemaSelection => ({
  mode: (name) => map[name] ?? null,
});

const catalog: readonly NoSchemaTool[] = [
  { name: 'plain_tool' },
  { name: 'docs_search', namespace: { name: 'docs' } },
  { name: 'report_build', namespace: { name: 'reports' } },
  { name: 'model_only_tool', exposure: 'model-only', namespace: { name: 'reports' } },
];

test('planNoSchema combines configured refs and the recorded selection, with a no-lazy override beating config', () => {
  const plan = planNoSchema({
    host: activeHost({ codemode: { mode: 'only' } }),
    refs: ['tool://plain_tool', 'namespace://docs'],
    selection: modeOf({ docs_search: 'schema', report_build: 'no-schema' }),
    tools: catalog,
  });
  assert.equal(plan.active, true);
  assert.deepEqual([...plan.requested].sort(), ['plain_tool', 'report_build']);
  assert.deepEqual([...plan.withheld].sort(), ['plain_tool', 'report_build']);
  assert.equal(plan.inactive.size, 0);
  assert.equal(plan.withheld.has('docs_search'), false, 'an explicit schema mode overrides the configured namespace default');
});

test('planNoSchema never withholds a model-only tool and reports its reason', () => {
  const plan = planNoSchema({
    host: activeHost({ codemode: { mode: 'only' } }),
    refs: [],
    selection: modeOf({ model_only_tool: 'no-schema' }),
    tools: catalog,
  });
  assert.equal(plan.active, true);
  assert.equal(plan.withheld.has('model_only_tool'), false);
  assert.equal(plan.inactive.get('model_only_tool'), 'model_only');
});

test('planNoSchema never withholds the Codemode entry itself', () => {
  // Codemode is model-only and intentionally absent from the sandbox catalog;
  // withholding it would remove the only path every other script call uses.
  const tools: readonly NoSchemaTool[] = [
    { name: 'codemode', exposure: 'model-only' },
    { name: 'report_build' },
  ];
  const plan = planNoSchema({
    host: activeHost({ codemode: { mode: 'only' } }),
    refs: ['tool://codemode'],
    selection: modeOf({ codemode: 'no-schema', report_build: 'no-schema' }),
    tools,
  });
  assert.equal(plan.withheld.has('codemode'), false, 'the execution entry keeps its declaration');
  assert.equal(plan.inactive.get('codemode'), 'model_only');
  assert.equal(plan.withheld.has('report_build'), true);
});

test('planNoSchema stays inert and reports the reason when the projection gate is not met', () => {
  for (const [settings, tools, reason] of [
    [{ codemode: { mode: 'on' } }, ['codemode'], 'mode_not_only'],
    [{ codemode: { mode: 'on' } }, ['read'], 'codemode_unavailable'],
    [{ codemode: { mode: 'only' } }, ['read'], 'codemode_unavailable'],
  ] as const) {
    const plan = planNoSchema({
      host: activeHost(settings, tools),
      refs: ['tool://plain_tool'],
      selection: modeOf({ report_build: 'no-schema' }),
      tools: catalog,
    });
    assert.equal(plan.active, false, reason);
    assert.equal(plan.withheld.size, 0, 'no schema is withheld while the projection is inert');
    assert.deepEqual([...plan.requested].sort(), ['plain_tool', 'report_build']);
    assert.equal(plan.inactive.get('plain_tool'), reason);
    assert.equal(plan.inactive.get('report_build'), reason);
  }
});

test('planNoSchema accepts a narrowed unusable Codemode call path as unavailable', () => {
  const plan = planNoSchema({
    host: activeHost({ codemode: { mode: 'only' } }),
    refs: ['tool://plain_tool'],
    selection: modeOf({}),
    tools: catalog,
    codemodeUsable: false,
  });
  assert.equal(plan.active, false);
  assert.equal(plan.withheld.size, 0);
  assert.equal(plan.inactive.get('plain_tool'), 'codemode_unavailable');
});

test('lazySchemasActive requires an active Codemode in only mode', () => {
  const host = (tools: string[], settings: unknown): LazySchemaHost => ({
    getActiveTools: () => tools,
    getSettings: () => settings as ReturnType<NonNullable<LazySchemaHost['getSettings']>>,
  });

  assert.equal(lazySchemasActive(host(['codemode'], { codemode: { mode: 'only' } })), true);
  assert.equal(lazySchemasActive(host(['codemode'], { codemode: { mode: 'on' } })), false);
  assert.equal(lazySchemasActive(host(['codemode'], {})), false);
  assert.equal(lazySchemasActive(host(['codemode'], undefined)), false);
  assert.equal(lazySchemasActive(host(['read', 'bash'], { codemode: { mode: 'only' } })), false,
    'lazy projection needs Codemode itself to be active');
  assert.equal(lazySchemasActive({
    getActiveTools: () => ['codemode'],
    getSettings: () => {
      throw new Error('no settings');
    },
  }), false);
});
