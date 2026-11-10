/**
 * Three-state tool-permission domain: query grammar, append-only replay,
 * legacy migration, four-state resolution, set/reset and the disabled notice.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityHost } from './support/capability-host.ts';

import {
  activeToolsAfterDisabled,
  CAPABILITY_TOOL_PERMISSION_RECORD,
  effectiveToolPermissionEntries,
  explicitlyDisabled,
  explicitlyEnabled,
  noticedToolPermissionNames,
  parsePermissionQuery,
  parseToolPermissionTarget,
  queryToolPermissions,
  resetToolPermission,
  resolveToolPermission,
  setToolPermission,
  ToolPermissionQueryError,
  type ToolPermissionTool,
} from '../../src/capability/tool-permission.ts';
import { createToolAdmission } from '../../src/capability/admission.ts';
import { setIndependentDeclarations } from '../../src/capability/declaration-visibility.ts';
import { setCapabilityPermissionDefaults } from '../../src/capability/scope.ts';

const registry: readonly ToolPermissionTool[] = [
  { name: 'read', exposure: 'direct' },
  { name: 'write', exposure: 'direct' },
  { name: 'cm_tool', exposure: 'codemode' },
  { name: 'docker_ps', exposure: 'deferred', namespace: { name: 'docker' } },
  { name: 'docker_run', exposure: 'deferred', namespace: { name: 'docker' } },
];

function host(tools: readonly ToolPermissionTool[] = registry, active: readonly string[] = []) {
  const fixture = capabilityHost(tools, active, 'registered');
  return {
    ...fixture,
    seedUsed(name: string) {
      fixture.branch().push({ type: 'message', message: { role: 'toolResult', toolName: name, isError: false, content: [] } });
    },
    seedBlacklist(name: string) {
      fixture.branch().push({
        type: 'custom', customType: 'capability-blacklist', data: {
          version: 1,
          added: [{ id: `tool:${name}`, kind: 'tool', name, target: name, scope: 'branch' }],
        },
      });
    },
  };
}

test('parsePermissionQuery handles unions, exclusions, categories and refusals', () => {
  assert.deepEqual(parsePermissionQuery(''), { text: 'enabled+active', include: ['enabled', 'active'], exclude: [] });
  assert.deepEqual(parsePermissionQuery('enabled+disabled'), { text: 'enabled+disabled', include: ['enabled', 'disabled'], exclude: [] });
  assert.deepEqual(parsePermissionQuery('active-enabled'), { text: 'active-enabled', include: ['active'], exclude: ['enabled'] });
  assert.deepEqual(parsePermissionQuery('namespace+enabled'), { text: 'namespace+enabled', include: ['namespace', 'enabled'], exclude: [] });
  assert.throws(() => parsePermissionQuery('enabled active'), ToolPermissionQueryError);
  assert.throws(() => parsePermissionQuery('enabled+nope'), ToolPermissionQueryError);
  assert.throws(() => parsePermissionQuery('enabled+enabled'), ToolPermissionQueryError);
  assert.throws(() => parsePermissionQuery('tool+namespace'), ToolPermissionQueryError);
  assert.throws(() => parsePermissionQuery('enabled+'), ToolPermissionQueryError);
  assert.throws(() => parsePermissionQuery('+enabled'), ToolPermissionQueryError);
});

test('parseToolPermissionTarget names exact tools and explicit groups only', () => {
  assert.deepEqual(parseToolPermissionTarget('write'), { target: 'write', kind: 'tool', name: 'write', id: 'tool:write' });
  assert.deepEqual(parseToolPermissionTarget('mcp://github'), { target: 'mcp://github', kind: 'mcp', name: 'github', id: 'mcp:github' });
  assert.equal(parseToolPermissionTarget('namespace://docker')?.kind, 'namespace');
  assert.equal(parseToolPermissionTarget('   '), null);
});

test('records replay append-only: set then reset returns the target to unmanaged', () => {
  const f = host(registry, ['write']);
  setToolPermission(f.api, f.api, f.branch(), ['write'], 'disabled');
  assert.equal(explicitlyDisabled(f.api, f.branch(), 'write'), true);
  resetToolPermission(f.api, f.api, f.branch(), ['write']);
  assert.equal(explicitlyDisabled(f.api, f.branch(), 'write'), false);
  assert.equal(resolveToolPermission(f.api, f.branch(), 'write', f.activeNames()).state, 'active');
  assert.ok(f.branch().every((entry) => entry.customType === CAPABILITY_TOOL_PERMISSION_RECORD || entry.type === 'message'));
});

test('the manual seed disables by default and an explicit enable overrides it', () => {
  const f = host(registry, ['read']);
  setCapabilityPermissionDefaults(f.api, ['read']);
  assert.equal(explicitlyDisabled(f.api, f.branch(), 'read'), true, 'the seed defaults to disabled');
  setToolPermission(f.api, f.api, f.branch(), ['read'], 'enabled');
  assert.equal(explicitlyEnabled(f.api, f.branch(), 'read'), true, 'an explicit enable overrides the seed');
  assert.equal(resolveToolPermission(f.api, f.branch(), 'read', f.activeNames()).state, 'enabled');
});

test('a config prefix default is disabled and a covered member reset stays managed', () => {
  const f = host([
    { name: 'mcp__prod__deploy', exposure: 'deferred', namespace: { name: 'mcp__prod' } },
    { name: 'mcp__staging__deploy', exposure: 'deferred', namespace: { name: 'mcp__staging' } },
  ], ['mcp__prod__deploy']);
  setCapabilityPermissionDefaults(f.api, ['mcp__prod__*']);
  assert.equal(explicitlyDisabled(f.api, f.branch(), 'mcp__prod__deploy'), true);
  assert.equal(explicitlyDisabled(f.api, f.branch(), 'mcp__staging__deploy'), false);

  const reset = resetToolPermission(f.api, f.api, f.branch(), ['mcp__prod__deploy']);
  assert.deepEqual(reset.reset, [], 'no exact tombstone is written for a prefix-covered member');
  assert.deepEqual(reset.notManaged, []);
  assert.deepEqual(reset.stillManaged, [{ name: 'mcp__prod__deploy', state: 'disabled' }]);
  assert.equal(explicitlyDisabled(f.api, f.branch(), 'mcp__prod__deploy'), true);
});

test('the latest same-rank alias rule wins', () => {
  const f = host([
    { name: 'mcp__git__status', exposure: 'deferred', namespace: { name: 'mcp__git', aliases: ['git'] } },
  ]);
  setToolPermission(f.api, f.api, f.branch(), ['namespace://mcp__git'], 'enabled');
  setToolPermission(f.api, f.api, f.branch(), ['namespace://git'], 'enabled');
  const disabled = setToolPermission(f.api, f.api, f.branch(), ['namespace://mcp__git'], 'disabled');
  assert.equal(disabled.changed.length, 1, 'the third mutation is a real change');
  assert.equal(resolveToolPermission(f.api, f.branch(), 'mcp__git__status', f.activeNames()).state, 'disabled',
    'the latest mutation of the alias target wins over the earlier alias');
  assert.equal(createToolAdmission(f.api, f.branch()).admits('mcp__git__status'), false);
});

test('a config prefix default can be reset by its prefix target', () => {
  const f = host([
    { name: 'mcp__prod__deploy', exposure: 'deferred', namespace: { name: 'mcp__prod' } },
    { name: 'mcp__prod__run', exposure: 'deferred', namespace: { name: 'mcp__prod' } },
  ]);
  setCapabilityPermissionDefaults(f.api, ['mcp__prod__*']);
  assert.equal(explicitlyDisabled(f.api, f.branch(), 'mcp__prod__run'), true);

  const reset = resetToolPermission(f.api, f.api, f.branch(), ['mcp__prod__*']);
  assert.deepEqual(reset.reset.map((item) => item.target), ['mcp__prod__*'], 'the prefix entry is reset');
  assert.equal(explicitlyDisabled(f.api, f.branch(), 'mcp__prod__run'), false, 'the prefix default no longer applies');
  assert.equal(resolveToolPermission(f.api, f.branch(), 'mcp__prod__run', f.activeNames()).managed, false);
});

test('an explicit group enable overrides a narrower config default', () => {
  const f = host([
    { name: 'mcp__git__status', exposure: 'deferred', namespace: { name: 'mcp__git' } },
  ], ['mcp__git__status']);
  setCapabilityPermissionDefaults(f.api, ['mcp__git__status']);
  assert.equal(explicitlyDisabled(f.api, f.branch(), 'mcp__git__status'), true);
  setToolPermission(f.api, f.api, f.branch(), ['namespace://mcp__git'], 'enabled');
  assert.equal(explicitlyEnabled(f.api, f.branch(), 'mcp__git__status'), true,
    'the explicit group outranks the exact config default');
});

test('resolution exposes the four mutually exclusive states without provenance', () => {
  const f = host(registry, ['write', 'read']);
  assert.equal(resolveToolPermission(f.api, f.branch(), 'write', f.activeNames()).state, 'active');
  assert.equal(resolveToolPermission(f.api, f.branch(), 'read', f.activeNames()).state, 'active');
  assert.equal(resolveToolPermission(f.api, f.branch(), 'docker_ps', f.activeNames()).state, 'inactive');
  setToolPermission(f.api, f.api, f.branch(), ['read'], 'enabled');
  setToolPermission(f.api, f.api, f.branch(), ['docker_ps'], 'disabled');
  const enabled = resolveToolPermission(f.api, f.branch(), 'read', f.activeNames());
  assert.equal(enabled.state, 'enabled');
  assert.deepEqual(Object.keys(enabled).sort(), ['active', 'category', 'kind', 'managed', 'name', 'registered', 'state']);
  assert.equal(resolveToolPermission(f.api, f.branch(), 'docker_ps', f.activeNames()).state, 'disabled');
});

test('query defaults to enabled+active and filters by state and category', () => {
  const f = host(registry, ['write', 'read', 'docker_ps', 'docker_run']);
  setToolPermission(f.api, f.api, f.branch(), ['read'], 'enabled');
  setToolPermission(f.api, f.api, f.branch(), ['docker_ps'], 'disabled');

  const defaultView = queryToolPermissions(f.api, f.branch(), f.activeNames());
  assert.deepEqual(defaultView.entries.map((entry) => entry.name).sort(), ['docker_run', 'read', 'write']);
  assert.equal(defaultView.expression, 'enabled+active');

  const disabled = queryToolPermissions(f.api, f.branch(), f.activeNames(), 'disabled');
  assert.deepEqual(disabled.entries.map((entry) => entry.name), ['docker_ps']);

  // A category-only expression lists that category's default set (enabled+active).
  const namespaces = queryToolPermissions(f.api, f.branch(), f.activeNames(), 'namespace');
  assert.deepEqual(namespaces.entries.map((entry) => entry.name), ['docker_run']);
  const plain = queryToolPermissions(f.api, f.branch(), f.activeNames(), 'tool');
  assert.deepEqual(plain.entries.map((entry) => entry.name).sort(), ['read', 'write']);

  // An explicit state term replaces the category default.
  const plainInactive = queryToolPermissions(f.api, f.branch(), f.activeNames(), 'tool+inactive');
  assert.deepEqual(plainInactive.entries.map((entry) => entry.name), ['cm_tool']);

  const excluded = queryToolPermissions(f.api, f.branch(), f.activeNames(), 'enabled+active-disabled');
  assert.deepEqual(excluded.entries.map((entry) => entry.name).sort(), ['docker_run', 'read', 'write']);
});

test('disable removes Codemode-only members now and defers declared members', () => {
  const f = host(registry, ['write', 'cm_tool']);
  f.seedUsed('write');
  const result = setToolPermission(f.api, f.api, f.branch(), ['write', 'cm_tool'], 'disabled');
  assert.deepEqual([...result.removedActive], ['cm_tool']);
  assert.deepEqual([...result.pendingCompaction], ['write']);
  assert.deepEqual(f.activeNames(), ['write']);
  assert.deepEqual([...result.noticed], ['write'], 'only the enabled, used tool gets a notice');
  assert.deepEqual([...noticedToolPermissionNames(f.branch())], ['write']);
});

test('disable removes a direct tool immediately when the loadout hides it', () => {
  const f = host([{ name: 'direct_tool', exposure: 'direct' }], ['direct_tool']);
  setIndependentDeclarations(f.api, () => new Set());
  const result = setToolPermission(f.api, f.api, f.branch(), ['direct_tool'], 'disabled');
  assert.deepEqual(result.removedActive, ['direct_tool']);
  assert.deepEqual(result.pendingCompaction, []);
  assert.deepEqual(f.activeNames(), []);
  assert.equal(explicitlyDisabled(f.api, f.branch(), 'direct_tool'), true);
});

test('enable reactivates an already-set member that lost its active slot', () => {
  const f = host(registry);
  const first = setToolPermission(f.api, f.api, f.branch(), ['docker_ps', 'docker_run'], 'enabled');
  assert.deepEqual([...first.activated].sort(), ['docker_ps', 'docker_run']);
  assert.ok(f.activeNames().includes('docker_ps'));
  assert.ok(f.activeNames().includes('docker_run'));

  f.api.setActiveTools([]);
  const again = setToolPermission(f.api, f.api, f.branch(), ['docker_ps', 'docker_run'], 'enabled');
  assert.deepEqual([...again.alreadySet].sort(), ['docker_ps', 'docker_run']);
  assert.deepEqual([...again.changed], []);
  assert.deepEqual([...again.activated].sort(), ['docker_ps', 'docker_run'], 'no second record is needed to reactivate');
  assert.ok(f.activeNames().includes('docker_ps'));
  assert.ok(f.activeNames().includes('docker_run'));
});

test('a failed record write applies nothing', () => {
  const f = host(registry, ['write']);
  const failing = { appendEntry() { throw new Error('branch is read-only'); } };
  const result = setToolPermission(f.api, failing, f.branch(), ['write'], 'disabled');
  assert.deepEqual(result.changed, []);
  assert.equal(result.recordError, 'branch is read-only');
  assert.equal(result.skipped.length, 1);
  assert.equal(explicitlyDisabled(f.api, f.branch(), 'write'), false);
  assert.deepEqual(f.activeNames(), ['write']);
});

test('reset tombstones explicit, migrated and config-default entries', () => {
  // An explicit disable resets cleanly.
  const explicit = host(registry, ['write']);
  setToolPermission(explicit.api, explicit.api, explicit.branch(), ['write'], 'disabled');
  const resetExplicit = resetToolPermission(explicit.api, explicit.api, explicit.branch(), ['write']);
  assert.deepEqual(resetExplicit.reset.map((entry) => entry.name), ['write']);
  assert.deepEqual(resetExplicit.stillManaged, []);
  assert.equal(resolveToolPermission(explicit.api, explicit.branch(), 'write', explicit.activeNames()).state, 'active');

  // A migrated blacklist rule is canonical `disabled`; reset removes it.
  const migrated = host(registry, ['read']);
  migrated.branch().push({ type: 'custom', customType: CAPABILITY_TOOL_PERMISSION_RECORD,
    data: { version: 1, set: [{ target: 'read', state: 'disabled' }] } });
  assert.equal(explicitlyDisabled(migrated.api, migrated.branch(), 'read'), true);
  const resetMigrated = resetToolPermission(migrated.api, migrated.api, migrated.branch(), ['read']);
  assert.deepEqual(resetMigrated.reset.map((entry) => entry.name), ['read']);
  assert.deepEqual(resetMigrated.notManaged, []);
  assert.deepEqual(resetMigrated.stillManaged, []);
  assert.equal(resolveToolPermission(migrated.api, migrated.branch(), 'read', migrated.activeNames()).state, 'active');

  // An explicit enable over an old blacklist also resets to unmanaged.
  const overridden = host(registry, ['read']);
  overridden.seedBlacklist('read');
  setToolPermission(overridden.api, overridden.api, overridden.branch(), ['read'], 'enabled');
  const resetOverridden = resetToolPermission(overridden.api, overridden.api, overridden.branch(), ['read']);
  assert.deepEqual(resetOverridden.reset.map((entry) => entry.name), ['read']);
  assert.deepEqual(resetOverridden.notManaged, []);
  assert.deepEqual(resetOverridden.stillManaged, []);
  assert.equal(explicitlyEnabled(overridden.api, overridden.branch(), 'read'), false);
  assert.equal(explicitlyDisabled(overridden.api, overridden.branch(), 'read'), false);

  // A config default is a disabled entry; reset writes a tombstone that covers
  // it, so the target really becomes unmanaged on this branch.
  const seeded = host(registry, ['read']);
  setCapabilityPermissionDefaults(seeded.api, ['read']);
  assert.equal(explicitlyDisabled(seeded.api, seeded.branch(), 'read'), true);
  const resetSeeded = resetToolPermission(seeded.api, seeded.api, seeded.branch(), ['read']);
  assert.deepEqual(resetSeeded.reset.map((entry) => entry.name), ['read']);
  assert.deepEqual(resetSeeded.notManaged, ['read']);
  assert.deepEqual(resetSeeded.stillManaged, []);
  assert.equal(resolveToolPermission(seeded.api, seeded.branch(), 'read', seeded.activeNames()).state, 'active');
  assert.equal(explicitlyDisabled(seeded.api, seeded.branch(), 'read'), false, 'the tombstone covers the config default');
});

test('reset of a member covered by a migrated group leaves it managed', () => {
  const f = host(registry, ['docker_ps']);
  f.branch().push({ type: 'custom', customType: CAPABILITY_TOOL_PERMISSION_RECORD,
    data: { version: 1, set: [{ target: 'namespace://docker', state: 'disabled' }] } });
  assert.equal(explicitlyDisabled(f.api, f.branch(), 'docker_ps'), true);
  const reset = resetToolPermission(f.api, f.api, f.branch(), ['docker_ps']);
  assert.deepEqual(reset.reset, [], 'no exact tombstone is written for a group-covered member');
  assert.deepEqual(reset.notManaged, []);
  assert.deepEqual(reset.stillManaged, [{ name: 'docker_ps', state: 'disabled' }]);
  assert.equal(explicitlyDisabled(f.api, f.branch(), 'docker_ps'), true);
});

test('reset reports notManaged and targets still managed by another rule or the seed', () => {
  const f = host(registry, ['read']);
  setCapabilityPermissionDefaults(f.api, ['read']);
  setToolPermission(f.api, f.api, f.branch(), ['read'], 'enabled');
  const reset = resetToolPermission(f.api, f.api, f.branch(), ['read']);
  assert.deepEqual(reset.reset.map((entry) => entry.name), ['read']);
  assert.deepEqual(reset.stillManaged, [], 'the tombstone covers the config default too');
  assert.equal(resolveToolPermission(f.api, f.branch(), 'read', f.activeNames()).state, 'active');

  const notManaged = resetToolPermission(f.api, f.api, f.branch(), ['write']);
  assert.deepEqual(notManaged.notManaged, ['write']);
});

test("queryToolPermissions resolves 500 tools and 30 rules with exactly one branch scan and one catalog read", () => {
  let catalogReads = 0;
  const tools: ToolPermissionTool[] = [];
  for (let i = 0; i < 500; i++) {
    tools.push({
      name: `tool_${i}`,
      exposure: "direct",
      namespace: { name: `ns_${i % 30}`, aliases: [`alias_${i % 30}`] },
    });
  }

  const queryHost = {
    getAllTools: () => {
      catalogReads++;
      return tools;
    },
  };

  const branch: unknown[] = [];
  for (let i = 0; i < 30; i++) {
    branch.push({
      type: "custom",
      customType: CAPABILITY_TOOL_PERMISSION_RECORD,
      data: {
        version: 1,
        set: [{ target: `namespace://ns_${i}`, state: "enabled" }],
      },
    });
  }

  let branchIterations = 0;
  const observedBranch = new Proxy(branch, {
    get(target, prop) {
      if (prop === Symbol.iterator) {
        branchIterations++;
      }
      return Reflect.get(target, prop);
    },
  });

  const result = queryToolPermissions(queryHost, observedBranch, [], "enabled");
  assert.equal(catalogReads, 1, "catalog read exactly once");
  assert.equal(branchIterations, 1, "branch scanned exactly once");
  assert.equal(result.entries.length, 500);
});

test('activeToolsAfterDisabled filters disabled names from an active set', () => {
  const f = host(registry, ['write', 'read']);
  setToolPermission(f.api, f.api, f.branch(), ['read'], 'disabled');
  assert.deepEqual(activeToolsAfterDisabled(f.api, f.branch(), ['write', 'read']), ['write']);
  assert.deepEqual([...effectiveToolPermissionEntries(f.api, f.branch()).map((entry) => entry.id)], ['tool:read']);
});

test('retired capability-discovery manual records do not admit MCP tools, while canonical permissions and current discoveries admit them', () => {
  const mcpTool: ToolPermissionTool = {
    name: 'mcp__github__create_issue',
    exposure: 'deferred',
    namespace: { name: 'mcp__github', aliases: ['github'] },
  };
  const ordinaryTool: ToolPermissionTool = {
    name: 'ordinary_discovered_tool',
    exposure: 'deferred',
  };
  const f = host([mcpTool, ordinaryTool], [mcpTool.name, ordinaryTool.name]);

  // 1. Empty branch: MCP tool not admitted without discovery or canonical enable
  const admEmpty = createToolAdmission(f.api, f.branch());
  assert.equal(admEmpty.admits(mcpTool.name), false);
  assert.equal(admEmpty.admitsServer('github'), false);

  // 2. Retired capability-discovery record with manual hit: must NOT grant admission
  const legacyRecord = {
    type: 'custom',
    customType: 'capability-discovery',
    data: {
      version: 1,
      result: {
        status: 'ok',
        tools: [],
        mcp: [],
        skills: [],
        manual: [{ ref: 'mcp://github', name: 'github', tools: [{ ref: 'tool://mcp__github__create_issue', name: mcpTool.name }] }],
        coverage: { local: 'not_searched', remote: 'not_searched' },
      },
    },
  };
  f.branch().push(legacyRecord);
  const admLegacy = createToolAdmission(f.api, f.branch());
  assert.equal(admLegacy.admits(mcpTool.name), false, 'retired manual category does not admit MCP tool');
  assert.equal(admLegacy.admitsServer('github'), false, 'retired manual category does not admit MCP server');

  // 3. Same retired record plus canonical unset: still not admitted
  f.branch().push({
    type: 'custom',
    customType: CAPABILITY_TOOL_PERMISSION_RECORD,
    data: { version: 1, unset: [mcpTool.name] },
  });
  const admUnset = createToolAdmission(f.api, f.branch());
  assert.equal(admUnset.admits(mcpTool.name), false, 'canonical unset leaves tool unmanaged and unadmitted');
  assert.equal(admUnset.admitsServer('github'), false);

  // 4. Canonical enable: admitted
  setToolPermission(f.api, f.api, f.branch(), [mcpTool.name], 'enabled');
  const admEnabled = createToolAdmission(f.api, f.branch());
  assert.equal(admEnabled.admits(mcpTool.name), true, 'canonical permission admits MCP tool');
  assert.equal(admEnabled.admitsServer('github'), true);

  // 5. Production resetToolPermission: returns to unmanaged -> denied without legitimate discovery
  resetToolPermission(f.api, f.api, f.branch(), [mcpTool.name]);
  const admReset = createToolAdmission(f.api, f.branch());
  assert.equal(admReset.admits(mcpTool.name), false, 'resetToolPermission removes canonical enable and leaves tool unadmitted');
  assert.equal(admReset.admitsServer('github'), false);

  // 6. Current legitimate discovery positive control: both tools and mcp categories populate selected and admit tools
  const validDiscovery = {
    type: 'custom',
    customType: 'capability-discovery',
    data: {
      version: 1,
      result: {
        status: 'ok',
        tools: [{ ref: 'tool://ordinary_discovered_tool', name: ordinaryTool.name }],
        mcp: [{ ref: 'mcp://github', name: 'github', tools: [{ ref: 'tool://mcp__github__create_issue', name: mcpTool.name }] }],
        skills: [],
        coverage: { local: 'searched', remote: 'not_searched' },
      },
    },
  };
  f.branch().push(validDiscovery);
  const admValid = createToolAdmission(f.api, f.branch());
  assert.equal(admValid.admits(mcpTool.name), true, 'current legitimate discovery admits MCP tool');
  assert.equal(admValid.admitsServer('github'), true, 'current legitimate discovery admits MCP server');
  assert.equal(admValid.declares(ordinaryTool.name), true, 'ordinary discovered tool is declared');
});

for (const scenario of [
  { name: 'overlapping group disable does not remove an exact enabled member from active set', exact: 'enabled', group: 'disabled', active: true },
  { name: 'overlapping group enable does not activate an exact disabled member', exact: 'disabled', group: 'enabled', active: false },
] as const) {
  test(scenario.name, () => {
    const tool: ToolPermissionTool = {
      name: 'mcp__prod__deploy', exposure: 'codemode',
      namespace: { name: 'mcp__prod', aliases: ['prod'] },
    };
    const f = scenario.active
      ? host([tool], [tool.name])
      : host([{ name: 'codemode', exposure: 'direct' }, tool], ['codemode']);
    setToolPermission(f.api, f.api, f.branch(), [tool.name], scenario.exact);
    assert.equal(f.activeNames().includes(tool.name), scenario.active);
    assert.equal(resolveToolPermission(f.api, f.branch(), tool.name, f.activeNames()).state, scenario.exact);

    const result = setToolPermission(f.api, f.api, f.branch(), ['mcp://prod'], scenario.group);
    assert.deepEqual(scenario.group === 'disabled' ? result.removedActive : result.activated, []);
    assert.equal(f.activeNames().includes(tool.name), scenario.active, 'the group mutation preserves membership');
    assert.equal(resolveToolPermission(f.api, f.branch(), tool.name, f.activeNames()).state, scenario.exact,
      'the exact rule still wins');
  });
}

for (const branchKind of ['live', 'snapshot'] as const) {
  test(`permission effects and reset use committed precedence with a ${branchKind} branch`, () => {
    const tool: ToolPermissionTool = {
      name: 'mcp__fixture__deploy', exposure: 'codemode',
      namespace: { name: 'mcp__fixture', aliases: ['fixture'] },
    };
    const f = host([{ name: 'codemode', exposure: 'direct' }, tool], ['codemode']);
    const branch = () => branchKind === 'live' ? f.branch() : [...f.branch()];
    const enabled = setToolPermission(f.api, f.api, branch(), [tool.name], 'enabled');
    assert.deepEqual(enabled.activated, [tool.name]);
    const disabled = setToolPermission(f.api, f.api, branch(), ['mcp://fixture'], 'disabled');
    assert.deepEqual(disabled.removedActive, []);
    assert.deepEqual(disabled.pendingCompaction, []);
    assert.ok(f.activeNames().includes(tool.name));
    const reset = resetToolPermission(f.api, f.api, branch(), [tool.name]);
    assert.deepEqual(reset.reset.map(item => item.target), [tool.name]);
    assert.deepEqual(reset.stillManaged, [{ name: tool.name, state: 'disabled' }]);
    assert.equal(resolveToolPermission(f.api, f.branch(), tool.name, f.activeNames()).state, 'disabled');
  });
}
