import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lazySchemasActive,
  matchesLazySchemaRef,
  parseLazySchemaRefs,
  type LazySchemaHost,
} from '../../src/capability/lazy-schemas.ts';

test('parseLazySchemaRefs keeps explicit MCP and namespace groups only', () => {
  assert.equal(parseLazySchemaRefs(undefined).empty, true);
  assert.equal(parseLazySchemaRefs([]).empty, true);

  const parsed = parseLazySchemaRefs(['mcp://large-service', 'namespace://large-extension']);
  assert.deepEqual([...parsed.mcpServers], ['large-service']);
  assert.deepEqual([...parsed.namespaces], ['large-extension']);
  assert.equal(parsed.empty, false);
  assert.deepEqual(parsed.refs, ['mcp://large-service', 'namespace://large-extension']);
});

test('parseLazySchemaRefs normalizes member refs, whitespace, encoding and ignores unknown schemes', () => {
  const parsed = parseLazySchemaRefs([
    '  mcp://docs/get  ',
    'mcp://my%20server',
    'namespace://grp',
    'tool://not-a-group',
    '',
  ]);
  assert.deepEqual([...parsed.mcpServers].sort(), ['docs', 'my server']);
  assert.deepEqual([...parsed.namespaces], ['grp']);
  assert.deepEqual(parsed.refs, ['mcp://docs/get', 'mcp://my%20server', 'namespace://grp']);

  assert.equal(parseLazySchemaRefs(['tool://x', 'weird']).empty, true);
});

test('matchesLazySchemaRef matches by MCP server, alias, tool prefix and namespace', () => {
  const refs = parseLazySchemaRefs(['mcp://docs', 'namespace://subagent']);
  assert.equal(matchesLazySchemaRef(refs, 'mcp__docs__search', { name: 'mcp__docs', aliases: ['docs'] }), true);
  assert.equal(matchesLazySchemaRef(refs, 'mcp__docs__search', { name: 'mcp__docs' }), true);
  assert.equal(matchesLazySchemaRef(refs, 'mcp__other__x', { name: 'mcp__other' }), false);
  // Bare alias server match.
  assert.equal(matchesLazySchemaRef(refs, 'docs__search', { name: 'docs', aliases: ['mcp__docs'] }), true);
  // Namespace name and alias.
  assert.equal(matchesLazySchemaRef(refs, 'subagent_create', { name: 'subagent' }), true);
  assert.equal(matchesLazySchemaRef(refs, 'x', { name: 'other', aliases: ['subagent'] }), true);
  // No namespace metadata, or no refs, never matches.
  assert.equal(matchesLazySchemaRef(refs, 'mcp__docs__search', undefined), false);
  assert.equal(matchesLazySchemaRef(parseLazySchemaRefs([]), 'mcp__docs__search', { name: 'mcp__docs' }), false);
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
