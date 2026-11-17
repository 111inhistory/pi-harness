/**
 * Authoritative tool availability: BASE, DYNAMIC and BLACKLIST.
 *
 * Covers the target grammar, branch replay, blacklist source lifetimes and
 * precedence, persistence-first writes, source-scoped blacklist removal,
 * declaration/usage timing, the model notice and the availability query.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { capabilityHost, type CapabilityTestTool } from './support/capability-host.ts';
import {
  activateToolTargets,
  activeToolsAfterCollections,
  addBaseTools,
  addBlacklistTargets,
  blacklistedNoticeNames,
  deactivateToolTargets,
  ensureToolBase,
  removeBaseTools,
  removeBlacklistTargets,
  sessionBaseNames,
  syncActiveToolsToCollections,
  TOOL_BASE_RECORD,
  TOOL_BLACKLIST_RECORD,
  TOOL_BLACKLIST_NOTICE_RECORD,
  TOOL_DYNAMIC_RECORD,
} from '../../src/capability/tool-access.ts';
import { createToolAccessView, listBaseTools, listBlacklist, listLoadedContainers, queryToolAccess } from '../../src/capability/tool-access-view.ts';
import { parseToolTarget } from '../../src/capability/targets.ts';
import { createToolAdmission } from '../../src/capability/admission.ts';
import { createEligibleToolCatalog } from '../../src/capability/tool-catalog.ts';
import { setIndependentDeclarations } from '../../src/capability/declaration-visibility.ts';
import { setCapabilityParent, setCapabilityStartupBlacklist } from '../../src/capability/scope.ts';
import { CAPABILITY_DISCOVERY_RECORD, CAPABILITY_PRUNE_RECORD } from '../../src/capability/discovery-record.ts';
import { PRESET_STATE_RECORD } from '../../src/preset/state.ts';

const registry: readonly CapabilityTestTool[] = [
  { name: 'read', description: 'Read a file', exposure: 'direct' },
  { name: 'write', description: 'Write a file', exposure: 'direct' },
  { name: 'cm_tool', description: 'Codemode only', exposure: 'codemode' },
  { name: 'codemode', description: 'Script tools', exposure: 'direct' },
  { name: 'docker_ps', description: 'List containers', exposure: 'deferred', namespace: { name: 'docker' } },
  { name: 'docker_run', description: 'Run a container', exposure: 'deferred', namespace: { name: 'docker' } },
  { name: 'mcp__git__status', description: 'Status', exposure: 'deferred', namespace: { name: 'mcp__git', aliases: ['git'] } },
];

interface Fixture {
  readonly api: ReturnType<typeof capabilityHost>['api'];
  readonly host: ReturnType<typeof capabilityHost>;
  readonly branch: () => unknown[];
}

function fixture(active: readonly string[] = ['read', 'write', 'cm_tool']): Fixture {
  const host = capabilityHost(registry, active, 'registered');
  return { api: host.api, host, branch: () => host.branch() };
}

function presetEntry(snapshot: Record<string, unknown> | null): Record<string, unknown> {
  return { type: 'custom', customType: PRESET_STATE_RECORD, data: { version: 1, snapshot } };
}

function discoveryEntry(names: readonly string[]): Record<string, unknown> {
  return {
    type: 'custom', customType: CAPABILITY_DISCOVERY_RECORD,
    data: { version: 1, result: { status: 'ok', tools: names.map((name) => ({ name, status: 'available' })), mcp: [], skills: [], coverage: { local: 'searched', remote: 'not_searched' } } },
  };
}

function pruneEntry(names: readonly string[]): Record<string, unknown> {
  return { type: 'custom', customType: CAPABILITY_PRUNE_RECORD, data: { version: 1, checkpointId: 'c1', removedTools: names } };
}

test('targets name exact tools, explicit groups and config prefixes', () => {
  assert.deepEqual(parseToolTarget('write'), { target: 'write', kind: 'tool', name: 'write', id: 'tool:write' });
  assert.deepEqual(parseToolTarget('mcp://github'), { target: 'mcp://github', kind: 'mcp', name: 'github', id: 'mcp:github' });
  assert.equal(parseToolTarget('namespace://docker')?.kind, 'namespace');
  assert.equal(parseToolTarget('mcp__prod__*')?.kind, 'prefix');
  assert.equal(parseToolTarget('  '), null);
  assert.equal(parseToolTarget('*'), null);
});

test('the baseline capture records the startup loadout once and is historical', () => {
  const f = fixture();
  const baseline = ensureToolBase(f.api, f.api, f.branch());
  assert.deepEqual([...baseline].sort(), ['cm_tool', 'read', 'write']);
  assert.equal(f.branch().filter((entry) => (entry as { customType?: string }).customType === TOOL_BASE_RECORD).length, 1);
  assert.deepEqual([...sessionBaseNames(f.branch())].sort(), ['cm_tool', 'read', 'write']);

  // A resumed/reshaped session does not rebuild the base from its live set.
  const view = createToolAccessView(f.api, f.branch());
  assert.equal(view.base('read'), true);
  assert.equal(view.base('docker_ps'), false);
  assert.equal(ensureToolBase(f.api, f.api, f.branch()).length, 3, 'no second baseline entry');
});

test('base overrides a local blacklist; dynamic membership remains blocked', () => {
  const f = fixture();
  ensureToolBase(f.api, f.api, f.branch());
  const added = addBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  assert.deepEqual(added.changed.map((change) => change.target), ['docker_ps']);
  assert.deepEqual(added.activated, ['docker_ps']);
  assert.equal(f.api.getActiveTools().includes('docker_ps'), true);

  const activated = activateToolTargets(f.api, f.api, f.branch(), ['docker_run']);
  assert.deepEqual(activated.activated, ['docker_run']);

  const banned = addBlacklistTargets(f.api, f.api, f.branch(), ['docker_ps', 'docker_run']);
  assert.deepEqual(banned.changed.map((change) => change.target).sort(), ['docker_ps', 'docker_run']);
  assert.deepEqual(banned.pendingCompaction, ['docker_run'], 'a base member keeps its declaration; the dynamic member defers');
  assert.deepEqual(banned.removedActive, []);
  const view = createToolAccessView(f.api, f.branch());
  assert.equal(view.base('docker_ps'), true, 'base membership is preserved');
  assert.equal(view.dynamic('docker_run'), true, 'the dynamic record is not deleted');
  assert.equal(view.blacklisted('docker_ps'), true, 'raw ban is retained');
  assert.equal(view.blocked('docker_ps'), false, 'base overrides the local ban');
  assert.equal(view.banOverridden('docker_ps'), true);
  assert.equal(view.requested('docker_ps'), true);
  assert.equal(view.blocked('docker_run'), true);
  assert.equal(view.requested('docker_run'), false);
  assert.equal(createToolAdmission(f.api, f.branch()).admits('docker_ps'), true);
  assert.equal(createToolAdmission(f.api, f.branch()).admits('docker_run'), false);

  // Removing base reveals the retained ban immediately.
  removeBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  const revealed = createToolAccessView(f.api, f.branch());
  assert.equal(revealed.blacklisted('docker_ps'), true);
  assert.equal(revealed.blocked('docker_ps'), true);
  assert.equal(createToolAdmission(f.api, f.branch()).admits('docker_ps'), false);
});

test('a root startup blacklist is local policy: base overrides, activate does not', () => {
  const f = fixture();
  ensureToolBase(f.api, f.api, f.branch());
  setCapabilityStartupBlacklist(f.api, ['docker_*']);
  assert.equal(createToolAccessView(f.api, f.branch()).blacklistSources('docker_ps').includes('startup'), true);

  const added = addBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  assert.deepEqual(added.activated, ['docker_ps'], 'base overrides the root local startup ban');
  assert.deepEqual(added.stillBlacklisted, ['docker_ps'], 'the stored ban is retained');
  assert.deepEqual(added.banOverridden, ['docker_ps']);
  assert.deepEqual(added.remainingSources, ['startup']);
  assert.equal(f.api.getActiveTools().includes('docker_ps'), true);
  assert.equal(createEligibleToolCatalog(f.api, {
    blocked: (tool) => createToolAccessView(f.api, f.branch()).blocked(tool.name),
  }).names.has('docker_ps'), true, 'the overridden member enters the eligible catalog');

  const activated = activateToolTargets(f.api, f.api, f.branch(), ['docker_run']);
  assert.equal(activated.activated.length, 0);
  assert.equal(createToolAccessView(f.api, f.branch()).requested('docker_run'), false);
  assert.equal(createToolAccessView(f.api, f.branch()).blocked('docker_run'), true);
});

test('blacklist removal clears the branch and startup sources but not the current preset', () => {
  const f = fixture();
  ensureToolBase(f.api, f.api, f.branch());
  setCapabilityStartupBlacklist(f.api, ['docker_ps']);
  f.branch().push(presetEntry({ name: 'p', tools: ['read'], disabledTools: ['docker_ps'], instructions: null }));
  addBaseTools(f.api, f.api, f.branch(), ['docker_ps']);

  const removed = removeBlacklistTargets(f.api, f.api, f.branch(), ['docker_ps']);
  assert.deepEqual(removed.changed.map((change) => change.target), ['docker_ps']);
  assert.deepEqual(removed.stillBlacklisted, ['docker_ps'], 'the current preset still prohibits it');
  assert.deepEqual(removed.remainingSources, ['preset']);
  assert.equal(removed.activated.length, 0);
  const view = createToolAccessView(f.api, f.branch());
  assert.deepEqual(view.blacklistSources('docker_ps'), ['preset']);

  // The preset contribution ends with its own clear; base membership survives.
  f.branch().push(presetEntry(null));
  syncActiveToolsToCollections(f.api, f.branch());
  const afterClear = createToolAccessView(f.api, f.branch());
  assert.equal(afterClear.blacklisted('docker_ps'), false);
  assert.equal(afterClear.base('docker_ps'), true);
  assert.equal(afterClear.requested('docker_ps'), true);
  assert.equal(f.api.getActiveTools().includes('docker_ps'), true, 'restored from preserved base membership');
});

test('blacklist removal reports notRequested when no membership is preserved', () => {
  const f = fixture();
  ensureToolBase(f.api, f.api, f.branch());
  addBlacklistTargets(f.api, f.api, f.branch(), ['docker_run']);
  const removed = removeBlacklistTargets(f.api, f.api, f.branch(), ['docker_run']);
  assert.deepEqual(removed.notRequested, ['docker_run']);
  assert.deepEqual(removed.activated, []);
});

test('a preset snapshot establishes base and preset blacklist chronologically', () => {
  const f = fixture();
  ensureToolBase(f.api, f.api, f.branch());
  addBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  f.branch().push(presetEntry({ name: 'p', tools: ['read', 'write'], disabledTools: ['write'], instructions: null }));
  const view = createToolAccessView(f.api, f.branch());
  assert.equal(view.base('read'), true);
  assert.equal(view.base('docker_ps'), false, 'the preset selection replaces the earlier base delta');
  assert.equal(view.blacklisted('write'), true);
  assert.deepEqual(view.blacklistSources('write'), ['preset']);
  assert.equal(view.blocked('write'), false, 'base (the preset +tool selection) overrides its own -tool ban');
  assert.equal(view.banOverridden('write'), true);
  assert.equal(view.requested('write'), true);

  // A base add after the preset applies to the current base.
  addBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  assert.equal(createToolAccessView(f.api, f.branch()).base('docker_ps'), true);
});

test('base removal and deactivation keep the declaration but stop usage', () => {
  const f = fixture();
  ensureToolBase(f.api, f.api, f.branch());
  setIndependentDeclarations(f.api as unknown as object, () => new Set(['read', 'write']));

  const removed = removeBaseTools(f.api, f.api, f.branch(), ['write']);
  assert.deepEqual(removed.pendingCompaction, ['write'], 'a declared member keeps its declaration');
  assert.deepEqual(removed.removedActive, []);
  assert.equal(f.api.getActiveTools().includes('write'), true);
  assert.equal(createToolAdmission(f.api, f.branch()).admits('write'), false, 'usage stops immediately');

  const removedCodemode = removeBaseTools(f.api, f.api, f.branch(), ['cm_tool']);
  assert.deepEqual(removedCodemode.removedActive, ['cm_tool'], 'a codemode-only member leaves now');

  // Base membership preserves a name against deactivation.
  activateToolTargets(f.api, f.api, f.branch(), ['read']);
  const kept = deactivateToolTargets(f.api, f.api, f.branch(), ['read']);
  assert.deepEqual(kept.removedActive, []);
  assert.deepEqual(kept.pendingCompaction, []);
  assert.equal(f.api.getActiveTools().includes('read'), true);

  const after = activeToolsAfterCollections(f.api, f.branch(), f.api.getActiveTools());
  assert.ok(!after.includes('write'), 'the pending declaration is dropped at compaction');
  assert.ok(after.includes('read'));
});

test('discovery selections are dynamic and prune removes only discovery membership', () => {
  const f = fixture();
  ensureToolBase(f.api, f.api, f.branch());
  f.branch().push(discoveryEntry(['docker_ps']));
  activateToolTargets(f.api, f.api, f.branch(), ['docker_run']);
  const view = createToolAccessView(f.api, f.branch());
  assert.equal(view.dynamic('docker_ps'), true);
  assert.equal(view.dynamic('docker_run'), true);

  f.branch().push(pruneEntry(['docker_ps']));
  const pruned = createToolAccessView(f.api, f.branch());
  assert.equal(pruned.dynamic('docker_ps'), false, 'the discovery member is pruned');
  assert.equal(pruned.dynamic('docker_run'), true, 'a manual activation has no discovery memory to prune');
});

test('a blacklist add records one model notice for used tools only', () => {
  const f = fixture();
  ensureToolBase(f.api, f.api, f.branch());
  activateToolTargets(f.api, f.api, f.branch(), ['docker_run']);
  f.branch().push({ type: 'message', message: { role: 'toolResult', toolName: 'docker_run', isError: false, content: [] } });
  const result = addBlacklistTargets(f.api, f.api, f.branch(), ['docker_run']);
  assert.deepEqual(result.noticed, ['docker_run'], 'a dynamically requested tool loses access and is announced');
  assert.deepEqual([...blacklistedNoticeNames(f.branch())], ['docker_run']);
  assert.equal(f.branch().filter((entry) => (entry as { customType?: string }).customType === TOOL_BLACKLIST_NOTICE_RECORD).length, 1);
});

test('a failed append changes nothing', () => {
  const f = fixture();
  ensureToolBase(f.api, f.api, f.branch());
  const before = f.api.getActiveTools();
  f.host.failAppend(true);
  const result = removeBaseTools(f.api, f.api, f.branch(), ['read']);
  assert.notEqual(result.recordError, null);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.skipped, [{ target: 'read', reason: 'record_error' }]);
  assert.deepEqual(f.api.getActiveTools(), before);
  assert.equal(createToolAccessView(f.api, f.branch()).base('read'), true);
});

test('alreadySet compares the latest branch record for one target id', () => {
  const f = fixture();
  ensureToolBase(f.api, f.api, f.branch());
  addBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  const again = addBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  assert.deepEqual(again.alreadySet, ['docker_ps']);
  assert.deepEqual(again.changed, []);
  assert.equal(f.branch().filter((entry) => (entry as { customType?: string }).customType === TOOL_BASE_RECORD).length, 2,
    'the baseline entry plus one add record');
});

test('unresolved targets are not recorded', () => {
  const f = fixture();
  ensureToolBase(f.api, f.api, f.branch());
  const exact = addBaseTools(f.api, f.api, f.branch(), ['missing_tool']);
  assert.deepEqual(exact.unresolved, ['missing_tool']);
  assert.deepEqual(exact.changed, []);
  // A container selector with no current member rejects the whole batch before
  // any append; nothing is recorded.
  const count = f.branch().length;
  const container = addBaseTools(f.api, f.api, f.branch(), ['namespace://missing']);
  assert.deepEqual(container.rejected?.code, 'container_without_members');
  assert.deepEqual(container.changed, []);
  assert.equal(f.branch().length, count);
});

test('the availability query lists current membership and optional facts', () => {
  const f = fixture();
  ensureToolBase(f.api, f.api, f.branch());
  addBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  addBlacklistTargets(f.api, f.api, f.branch(), ['docker_ps']);

  const current = queryToolAccess(f.api, f.branch(), f.api.getActiveTools());
  const baseEntry = current.entries.find((entry) => entry.name === 'docker_ps');
  assert.equal(baseEntry?.usable, true, 'a base member stays usable despite the raw ban');
  assert.equal(baseEntry?.blacklisted, true);
  assert.equal(baseEntry?.blocked, false);
  assert.equal(baseEntry?.banOverridden, true);
  const base = listBaseTools(f.api, f.branch()).map((entry) => entry.target.target);
  assert.ok(base.includes('docker_ps'), 'the base list still reports the membership');
  const banned = listBlacklist(f.api, f.branch());
  assert.deepEqual(banned.map((entry) => entry.target.target), ['docker_ps']);
  assert.deepEqual(banned[0]?.sources, ['branch']);

  const withActivatable = queryToolAccess(f.api, f.branch(), f.api.getActiveTools(), { includeActivatable: true });
  assert.ok(withActivatable.entries.some((entry) => entry.name === 'docker_run'), 'an eligible inactive tool is activatable');
  assert.ok(withActivatable.entries.some((entry) => entry.name === 'docker_ps'), 'the overridden base member remains listed');

  const withUsable = queryToolAccess(f.api, f.branch(), f.api.getActiveTools(), { includeUsable: true, filter: 'read' });
  assert.equal(withUsable.entries.length, 1);
  assert.equal(withUsable.entries[0]?.usable, true);
});

test('sync sets the active set to the requested eligible tools', () => {
  const f = fixture(['read', 'write', 'cm_tool']);
  ensureToolBase(f.api, f.api, f.branch());
  addBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  addBlacklistTargets(f.api, f.api, f.branch(), ['write', 'docker_run']);
  const synced = syncActiveToolsToCollections(f.api, f.branch());
  assert.ok(synced.active.includes('docker_ps'));
  assert.ok(synced.active.includes('write'), 'base (baseline) overrides the local blacklist');
  assert.deepEqual([...f.api.getActiveTools()].sort(), [...synced.active].sort());
});

test('a query accepts a bare host without an active-set reader', () => {
  const f = fixture();
  const host = { getAllTools: () => registry };
  const result = queryToolAccess(host, f.branch(), ['read']);
  assert.ok(result.entries.some((entry) => entry.name === 'read'));
});

test('a later explicit activation reintroduces a pruned member', () => {
  const f = fixture(['read']);
  ensureToolBase(f.api, f.api, f.branch());
  f.branch().push(discoveryEntry(['docker_run']));
  f.branch().push(pruneEntry(['docker_run']));
  assert.equal(createToolAdmission(f.api, f.branch()).admits('docker_run'), false,
    'the prune removed the discovery membership');
  activateToolTargets(f.api, f.api, f.branch(), ['docker_run']);
  const view = createToolAccessView(f.api, f.branch());
  assert.equal(view.requested('docker_run'), true, 'a newer explicit activation requests it again');
  assert.equal(createToolAdmission(f.api, f.branch()).admits('docker_run'), true);
});

test('an SDK toolsAdded message never undoes a removal intent', () => {
  const f = fixture(['read', 'write']);
  ensureToolBase(f.api, f.api, f.branch());
  removeBaseTools(f.api, f.api, f.branch(), ['read']);
  // The lingering declaration is written back by the SDK on the next turn.
  f.branch().push({ type: 'message', message: { role: 'system', toolsAdded: [{ name: 'read' }] } });
  const view = createToolAccessView(f.api, f.branch());
  assert.equal(view.dynamic('read'), false, 'declaration bookkeeping is not dynamic membership');
  assert.equal(view.requested('read'), false);
  assert.equal(createToolAdmission(f.api, f.branch()).admits('read'), false);
});

test('list flags select membership, usable-only and activatable populations', () => {
  const f = fixture(['read']);
  ensureToolBase(f.api, f.api, f.branch());
  // docker_ps is requested but inactive (the SDK has not activated it).
  addBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  const reset = f.api.getActiveTools().filter((name) => name !== 'docker_ps');
  f.api.setActiveTools(reset);
  const current = queryToolAccess(f.api, f.branch(), f.api.getActiveTools());
  assert.ok(current.entries.some((entry) => entry.name === 'docker_ps' && entry.usable === false));
  const usable = queryToolAccess(f.api, f.branch(), f.api.getActiveTools(), { includeUsable: true });
  assert.ok(!usable.entries.some((entry) => entry.name === 'docker_ps'), 'usable is a filter population');
  const activatable = queryToolAccess(f.api, f.branch(), f.api.getActiveTools(), { includeActivatable: true });
  assert.ok(activatable.entries.some((entry) => entry.name === 'docker_ps'), 'activatable keeps the requested membership');
  assert.ok(activatable.entries.some((entry) => entry.name === 'docker_run'));
  const both = queryToolAccess(f.api, f.branch(), f.api.getActiveTools(), { includeUsable: true, includeActivatable: true });
  assert.ok(both.entries.some((entry) => entry.name === 'docker_run'));
  assert.ok(both.entries.some((entry) => entry.name === 'read'));
  // A requested-but-inactive member is still a valid activation candidate; the
  // SDK's inactive state does not erase the intent.
  const requestedInactive = both.entries.find((entry) => entry.name === 'docker_ps');
  assert.equal(requestedInactive?.activatable, true);
  assert.equal(requestedInactive?.usable, false);
});

test('sync reports only the names the SDK actually accepted', () => {
  const f = fixture(['read']);
  ensureToolBase(f.api, f.api, f.branch());
  const masked = f.api as unknown as { setActiveTools(names: string[]): void };
  const original = masked.setActiveTools.bind(f.api);
  masked.setActiveTools = (names: string[]) => original(names.filter((name) => name !== 'write'));
  const synced = syncActiveToolsToCollections(f.api, f.branch());
  assert.ok(!synced.active.includes('write'), 'a masked name is not reported active');
  assert.ok(synced.active.includes('read'));
  assert.deepEqual([...f.api.getActiveTools()].sort(), [...synced.active].sort());
});

test('an active codemode-only tool without a usable Codemode entry is not usable', () => {
  const f = fixture(['read', 'cm_tool']);
  ensureToolBase(f.api, f.api, f.branch());
  // Codemode itself is not requested/active here, so a code-only declaration
  // has no call path even though the SDK still holds it active.
  const result = queryToolAccess(f.api, f.branch(), f.api.getActiveTools(), { includeUsable: true });
  const codemodeOnly = result.entries.find((entry) => entry.name === 'cm_tool');
  assert.equal(codemodeOnly, undefined, 'an unreachable active tool is not in the usable population');
  const all = queryToolAccess(f.api, f.branch(), f.api.getActiveTools());
  const entry = all.entries.find((candidate) => candidate.name === 'cm_tool');
  assert.equal(entry?.active, true);
  assert.equal(entry?.usable, false, 'the declaration has no usable call path');
  assert.equal(entry?.activatable, false, 'it is already active');
});

test('a plain container expands current members once and persists the container load', () => {
  const f = fixture(['read']);
  ensureToolBase(f.api, f.api, f.branch());
  const added = addBaseTools(f.api, f.api, f.branch(), ['namespace://docker']);
  assert.deepEqual([...added.selected].sort(), ['docker_ps', 'docker_run']);
  assert.deepEqual(added.containers.map((entry) => entry.target), ['namespace://docker']);
  assert.equal(added.containers[0]?.explicit, false);
  const record = f.branch().at(-1) as { data: { load?: string[]; add?: string[] } };
  assert.deepEqual([...record.data.load ?? []], ['namespace://docker']);
  assert.deepEqual([...record.data.add ?? []].sort(), ['docker_ps', 'docker_run']);
  assert.deepEqual(listLoadedContainers(f.api, f.branch()).map((entry) => entry.target), ['namespace://docker']);

  // A member registered later is not part of the earlier snapshot.
  f.host.register({ name: 'docker_exec', exposure: 'deferred', namespace: { name: 'docker' } });
  assert.equal(createToolAccessView(f.api, f.branch()).base('docker_exec'), false);
  const again = addBaseTools(f.api, f.api, f.branch(), ['namespace://docker']);
  assert.deepEqual([...again.selected].sort(), ['docker_exec', 'docker_ps', 'docker_run'],
    'a later snapshot includes the new member and the existing ones');
});

test('[ns] loads metadata only for explicit members in the same batch', () => {
  const f = fixture(['read']);
  ensureToolBase(f.api, f.api, f.branch());
  const activated = activateToolTargets(f.api, f.api, f.branch(), ['namespace://docker[ns]', 'docker_ps', 'read']);
  assert.deepEqual([...activated.selected].sort(), ['docker_ps', 'read']);
  assert.deepEqual(activated.containers.map((entry) => ({ target: entry.target, explicit: entry.explicit, members: entry.members })), [
    { target: 'namespace://docker', explicit: true, members: ['docker_ps'] },
  ]);
  assert.equal(createToolAccessView(f.api, f.branch()).dynamic('docker_run'), false, 'no default expansion');

  // Bare [ns] without a positive member rejects the whole batch.
  const count = f.branch().length;
  const bare = activateToolTargets(f.api, f.api, f.branch(), ['namespace://docker[ns]']);
  assert.equal(bare.rejected?.code, 'container_without_members');
  assert.equal(f.branch().length, count, 'nothing was appended');

  // A foreign member is independent as long as the container has a valid member.
  const mixed = activateToolTargets(f.api, f.api, f.branch(), ['namespace://docker[ns]', 'docker_ps', 'write']);
  assert.deepEqual(mixed.rejected, null);
  assert.ok(mixed.selected.includes('write'));
  // A foreign-only member leaves the container without a member and rejects.
  const foreign = activateToolTargets(f.api, f.api, f.branch(), ['namespace://docker[ns]', 'write']);
  assert.equal(foreign.rejected?.code, 'container_without_members');
  assert.equal(f.branch().length, count + 1, 'only the mixed batch was recorded');
});

test('a per-batch exclusion never changes prior membership or the blacklist', () => {
  const f = fixture(['read']);
  ensureToolBase(f.api, f.api, f.branch());
  addBaseTools(f.api, f.api, f.branch(), ['namespace://docker']);
  const result = addBaseTools(f.api, f.api, f.branch(), ['namespace://docker'], { exclude: ['docker_run'] });
  assert.ok(!result.selected.includes('docker_run'));
  assert.deepEqual(result.excluded, ['docker_run']);
  assert.equal(createToolAccessView(f.api, f.branch()).base('docker_run'), true, 'prior membership is untouched');
  assert.deepEqual(listBlacklist(f.api, f.branch()), [], 'no blacklist record is written');
});

test('a loaded container survives member deactivation and is guidance-eligible', () => {
  const f = fixture(['read']);
  ensureToolBase(f.api, f.api, f.branch());
  activateToolTargets(f.api, f.api, f.branch(), ['namespace://docker[ns]', 'docker_ps']);
  deactivateToolTargets(f.api, f.api, f.branch(), ['docker_ps']);
  assert.equal(createToolAccessView(f.api, f.branch()).dynamic('docker_ps'), false);
  const loaded = listLoadedContainers(f.api, f.branch());
  assert.deepEqual(loaded.map((entry) => entry.target), ['namespace://docker']);
  assert.deepEqual(loaded[0]?.members, ['docker_ps', 'docker_run']);
  assert.deepEqual(loaded[0]?.selected, []);
});

function onlyMode(api: ReturnType<typeof capabilityHost>['api']): ReturnType<typeof capabilityHost>['api'] {
  return Object.assign(Object.create(api), { getSettings: () => ({ codemode: { mode: 'only' } }) }) as ReturnType<typeof capabilityHost>['api'];
}

test('no-schema refuses the whole selection before writing when Codemode is unusable', () => {
  const f = fixture(['read', 'write']);
  ensureToolBase(f.api, f.api, f.branch());
  const count = f.branch().length;
  const result = activateToolTargets(f.api, f.api, f.branch(), ['docker_ps[lazy]']);
  assert.equal(result.rejected?.code, 'no_schema_unsupported');
  assert.equal(result.rejected?.reason, 'codemode_unavailable');
  assert.equal(f.branch().length, count, 'nothing was appended');
  assert.deepEqual(result.schemaWithheld, []);
});

test('no-schema requires the effective only projection, not a global mode change', () => {
  const f = fixture(['read', 'codemode']);
  ensureToolBase(f.api, f.api, f.branch());
  const onMode = Object.assign(Object.create(f.api), { getSettings: () => ({ codemode: { mode: 'on' } }) }) as typeof f.api;
  const count = f.branch().length;
  const refused = activateToolTargets(onMode, onMode, f.branch(), ['docker_ps[lazy]']);
  assert.equal(refused.rejected?.code, 'no_schema_unsupported');
  assert.equal(refused.rejected?.reason, 'mode_not_only');
  assert.equal(f.branch().length, count);

  const only = onlyMode(f.api);
  const accepted = activateToolTargets(only, only, f.branch(), ['docker_ps[lazy]']);
  assert.deepEqual(accepted.schemaWithheld, ['docker_ps']);
  assert.deepEqual(accepted.noSchema, ['docker_ps']);
  assert.equal(createToolAccessView(only, f.branch()).facts('docker_ps').schemaMode, 'no-schema');
  assert.equal(createToolAccessView(only, f.branch()).facts('docker_ps').schemaWithheld, true);

  // --schema is the explicit override; the latest record wins and is sticky.
  const restored = activateToolTargets(only, only, f.branch(), ['docker_ps[no-lazy]']);
  assert.deepEqual(restored.schema, ['docker_ps']);
  assert.deepEqual(restored.noSchema, []);
  assert.deepEqual(restored.schemaWithheld, []);
  assert.equal(createToolAccessView(only, f.branch()).facts('docker_ps').schemaMode, 'schema');
  assert.equal(createToolAccessView(only, f.branch()).facts('docker_ps').schemaWithheld, false);
});

test('a local blacklist blocks a dynamic tool despite its recorded no-schema mode', () => {
  const f = fixture(['read', 'codemode']);
  const only = onlyMode(f.api);
  ensureToolBase(only, only, f.branch());
  activateToolTargets(only, only, f.branch(), ['docker_ps[lazy]']);
  addBlacklistTargets(only, only, f.branch(), ['docker_ps']);
  const facts = createToolAccessView(only, f.branch()).facts('docker_ps');
  assert.equal(facts.schemaMode, 'no-schema');
  assert.equal(facts.schemaWithheld, false, 'a blacklisted tool is not requested and cannot be withheld');
  assert.equal(facts.blacklisted, true);
});

test('modifier grammar: plain targets never mutate policy, container defaults and member overrides mix in one record', () => {
  const f = fixture(['read', 'codemode']);
  const only = onlyMode(f.api);
  ensureToolBase(only, only, f.branch());
  const plain = activateToolTargets(only, only, f.branch(), ['docker_ps']);
  assert.deepEqual(plain.noSchema, []);
  assert.deepEqual(plain.schema, []);
  assert.equal(createToolAccessView(only, f.branch()).facts('docker_ps').schemaMode, null, 'plain target writes no policy');

  const mixed = activateToolTargets(only, only, f.branch(), ['namespace://docker[lazy]', 'docker_ps[no-lazy]']);
  assert.deepEqual([...mixed.noSchema].sort(), ['docker_run']);
  assert.deepEqual(mixed.schema, ['docker_ps']);
  assert.equal(createToolAccessView(only, f.branch()).facts('docker_run').schemaMode, 'no-schema');
  assert.equal(createToolAccessView(only, f.branch()).facts('docker_ps').schemaMode, 'schema');

  // A later plain selection obeys the recorded override; it never resets it.
  activateToolTargets(only, only, f.branch(), ['docker_ps']);
  assert.equal(createToolAccessView(only, f.branch()).facts('docker_ps').schemaMode, 'schema');

  // A `[ns,lazy]` container gives its explicit members the default, which an
  // explicit member modifier overrides in the same operation.
  const loadOnly = activateToolTargets(only, only, f.branch(), ['namespace://docker[ns,lazy]', 'docker_ps', 'docker_run[no-lazy]']);
  assert.deepEqual(loadOnly.noSchema, ['docker_ps']);
  assert.deepEqual(loadOnly.schema, ['docker_run']);
  assert.equal(loadOnly.containers.find((entry) => entry.target === 'namespace://docker')?.explicit, true);
});

test('conflicting or malformed modifiers reject the whole batch before any write', () => {
  const f = fixture(['read', 'codemode']);
  const only = onlyMode(f.api);
  ensureToolBase(only, only, f.branch());
  const count = f.branch().length;
  for (const tokens of [
    ['docker_ps[lazy]', 'docker_ps[no-lazy]'],
    ['mcp://git[lazy]', 'namespace://mcp__git[no-lazy]'],
    ['docker_ps[unknown]'],
    ['read[ns]'],
    ['-docker_ps[lazy]'],
  ]) {
    const result = activateToolTargets(only, only, f.branch(), tokens);
    assert.ok(result.rejected !== null, `rejects ${tokens.join(' ')}`);
    assert.equal(f.branch().length, count, 'zero writes on rejection');
  }
  // Blacklist and removal accept neither schema nor ns selection modifiers.
  assert.equal(addBlacklistTargets(only, only, f.branch(), ['docker_ps[lazy]']).rejected?.code, 'selection_not_supported');
  assert.equal(removeBaseTools(only, only, f.branch(), ['namespace://docker[lazy]']).rejected?.code, 'selection_not_supported');
  assert.ok(deactivateToolTargets(only, only, f.branch(), ['docker_ps[ns]']).rejected !== null);
});

test('a child inherits ancestor EFFECTIVE bans, not raw bans the ancestor base overrode', () => {
  const parent = fixture(['read']);
  setCapabilityStartupBlacklist(parent.api, ['docker_ps', 'docker_run']);
  ensureToolBase(parent.api, parent.api, parent.branch());
  // Parent base overrides only docker_ps; docker_run stays effectively banned.
  addBaseTools(parent.api, parent.api, parent.branch(), ['docker_ps']);
  assert.equal(createToolAccessView(parent.api, parent.branch()).blocked('docker_ps'), false);
  assert.equal(createToolAccessView(parent.api, parent.branch()).blocked('docker_run'), true);

  const child = fixture(['read']);
  setCapabilityParent(child.api, parent.api);
  ensureToolBase(child.api, child.api, child.branch());
  addBaseTools(child.api, child.api, child.branch(), ['docker_ps']);
  addBaseTools(child.api, child.api, child.branch(), ['docker_run']);

  const view = createToolAccessView(child.api, child.branch());
  // Ancestor config stays a raw external fence for now: the parent's local
  // base override is not inherited authorization.
  assert.equal(view.blacklisted('docker_ps'), true, 'the raw ancestor startup ban is reported');
  assert.equal(view.blocked('docker_ps'), true, 'the ancestor ban remains a hard fence');
  assert.equal(view.requested('docker_ps'), false);
  assert.equal(view.blacklisted('docker_run'), true);
  assert.equal(view.blocked('docker_run'), true);
  assert.equal(view.requested('docker_run'), false);
  assert.equal(createToolAdmission(child.api, child.branch()).admits('docker_run'), false);
  assert.equal(createToolAdmission(child.api, child.branch()).admits('docker_ps'), false);
});
