/**
 * Authoritative tool availability: BASE, DYNAMIC and BLACKLIST.
 *
 * Covers the target grammar, branch replay, blacklist source lifetimes and
 * precedence, persistence-first writes, source-scoped blacklist removal,
 * declaration/usage timing, the model notice and the availability query.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { checkProperty } from '../../test-support/pbt.ts';

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
  presetLiveToolsInSync,
  presetRetainedByBranch,
  removeBlacklistTargets,
  sessionBaseNames,
  syncActiveToolsForBranch,
  toolBaselineNames,
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
import { buildPresetSnapshot, PRESET_STATE_RECORD } from '../../src/preset/state.ts';

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

function presetEntry(
  snapshot: Parameters<typeof buildPresetSnapshot>[0] | null,
  baselineAdditions?: readonly string[],
): Record<string, unknown> {
  return {
    type: 'custom',
    customType: PRESET_STATE_RECORD,
    data: {
      version: 2,
      snapshot: snapshot === null ? null : buildPresetSnapshot(snapshot),
      ...(baselineAdditions === undefined ? {} : { baselineAdditions }),
    },
  };
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

test('the baseline preview reads the recorded fact or the capture rule read-only', () => {
  const f = fixture(['read', 'write', 'cm_tool']);
  // A raw ban is excluded from the capture rule.
  addBlacklistTargets(f.api, f.api, f.branch(), ['write']);
  const count = f.branch().length;
  assert.deepEqual([...toolBaselineNames(f.api, f.branch())].sort(), ['cm_tool', 'read'],
    'no recorded baseline: the preview applies the capture rule');
  assert.equal(f.branch().length, count, 'the preview writes nothing');

  const captured = ensureToolBase(f.api, f.api, f.branch());
  assert.deepEqual([...captured].sort(), ['cm_tool', 'read'], 'the capture records exactly the preview');
  assert.equal(f.branch().length, count + 1);
  assert.deepEqual([...toolBaselineNames(f.api, f.branch())].sort(), ['cm_tool', 'read'],
    'a recorded baseline is read back, not re-captured');

  // Capturing an empty startup loadout (--no-tools) persists baseline: [] so
  // later dynamic activations stay out of base and never trigger re-capture.
  const empty = fixture([]);
  assert.deepEqual([...ensureToolBase(empty.api, empty.api, empty.branch())], []);
  activateToolTargets(empty.api, empty.api, empty.branch(), ['read']);
  assert.equal(createToolAccessView(empty.api, empty.branch()).base('read'), false);
  assert.deepEqual([...toolBaselineNames(empty.api, empty.branch())], []);
  assert.deepEqual([...ensureToolBase(empty.api, empty.api, empty.branch())], [],
    'a captured empty baseline is not re-captured');
  assert.equal(empty.branch().filter((entry) => (entry as { customType?: string }).customType === TOOL_BASE_RECORD).length, 1);
});

test('a manual blacklist is a hard fence no base or preset selection lifts', () => {
  const f = fixture();
  ensureToolBase(f.api, f.api, f.branch());
  const added = addBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  assert.deepEqual(added.activated, ['docker_ps']);
  activateToolTargets(f.api, f.api, f.branch(), ['docker_run']);

  const banned = addBlacklistTargets(f.api, f.api, f.branch(), ['docker_ps', 'docker_run']);
  assert.deepEqual(banned.changed.map((change) => change.target).sort(), ['docker_ps', 'docker_run']);
  assert.deepEqual(banned.removedActive, [], 'a deferred declaration stays until compaction');
  assert.deepEqual([...banned.pendingCompaction].sort(), ['docker_ps', 'docker_run']);
  const view = createToolAccessView(f.api, f.branch());
  assert.equal(view.base('docker_ps'), true, 'membership is preserved but not authorized');
  assert.equal(view.dynamic('docker_run'), true, 'the dynamic record is not deleted');
  assert.equal(view.blacklisted('docker_ps'), true, 'raw ban is retained');
  assert.equal(view.blocked('docker_ps'), true, 'the manual ban wins over the base member');
  assert.equal(view.banOverridden('docker_ps'), false, 'a hard fence is never reported as overridden');
  assert.equal(view.requested('docker_ps'), false);
  assert.equal(view.blocked('docker_run'), true);
  assert.equal(createToolAdmission(f.api, f.branch()).admits('docker_ps'), false);

  // A preset selection is equally unable to lift it, whatever the branch order.
  f.branch().push(presetEntry({
    name: 'p', instructions: null,
    toolSelection: { kind: 'modifiers', add: ['docker_ps'], remove: [] }, tools: [],
  }));
  const withPreset = createToolAccessView(f.api, f.branch());
  assert.equal(withPreset.base('docker_ps'), true);
  assert.equal(withPreset.blocked('docker_ps'), true, 'the preset add does not lift a manual ban');
  assert.equal(withPreset.requested('docker_ps'), false);
  assert.equal(createToolAdmission(f.api, f.branch()).admits('docker_ps'), false);

  // Removing base and then the ban is the only path back.
  removeBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  assert.equal(createToolAccessView(f.api, f.branch()).blocked('docker_ps'), true);
  removeBlacklistTargets(f.api, f.api, f.branch(), ['docker_ps']);
  assert.equal(createToolAccessView(f.api, f.branch()).blocked('docker_ps'), false);
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
  f.branch().push(presetEntry({
    name: 'p', instructions: null,
    toolSelection: { kind: 'replace', names: ['read'] }, tools: ['read'], disabledTools: ['docker_ps'],
  }));
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

test('PBT: four-layer precedence, permanent baseline additions, retention and branch sync match independent model', async () => {
  const UNIVERSE = ['read', 'write', 'docker_ps', 'job_stop'] as const;
  type ToolName = (typeof UNIVERSE)[number];
  type Op =
    | { kind: 'baseAdd'; name: ToolName }
    | { kind: 'baseRemove'; name: ToolName }
    | { kind: 'dynActivate'; name: ToolName }
    | { kind: 'dynDeactivate'; name: ToolName }
    | { kind: 'banAdd'; name: ToolName }
    | { kind: 'banRemove'; name: ToolName }
    | { kind: 'presetNone'; additions: readonly ToolName[] }
    | { kind: 'presetMod'; add: readonly ToolName[]; remove: readonly ToolName[]; disabled: readonly ToolName[]; additions: readonly ToolName[] }
    | { kind: 'presetReplace'; names: readonly ToolName[]; disabled: readonly ToolName[]; additions: readonly ToolName[] }
    | { kind: 'presetClear' };

  const arbTool = fc.constantFrom<ToolName>(...UNIVERSE);
  const arbSub = fc.uniqueArray(arbTool, { minLength: 0, maxLength: 3 });
  const arbOp: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant('baseAdd' as const), name: arbTool }),
    fc.record({ kind: fc.constant('baseRemove' as const), name: arbTool }),
    fc.record({ kind: fc.constant('dynActivate' as const), name: arbTool }),
    fc.record({ kind: fc.constant('dynDeactivate' as const), name: arbTool }),
    fc.record({ kind: fc.constant('banAdd' as const), name: arbTool }),
    fc.record({ kind: fc.constant('banRemove' as const), name: arbTool }),
    fc.record({ kind: fc.constant('presetNone' as const), additions: arbSub }),
    fc.record({
      kind: fc.constant('presetMod' as const),
      add: arbSub,
      remove: arbSub,
      disabled: arbSub,
      additions: arbSub,
    }).map((op) => ({
      ...op,
      remove: op.remove.filter((name) => !op.add.includes(name)),
    })),
    fc.record({
      kind: fc.constant('presetReplace' as const),
      names: arbSub,
      disabled: arbSub,
      additions: arbSub,
    }),
    fc.constant<Op>({ kind: 'presetClear' }),
  );

  await checkProperty(fc.asyncProperty(
    fc.uniqueArray(fc.constantFrom<ToolName>('read', 'write'), { minLength: 0, maxLength: 2 }),
    arbSub,
    fc.boolean(),
    fc.array(arbOp, { minLength: 1, maxLength: 14 }),
    async (initBaseline, startupBanList, hasUnmanagedLive, ops) => {
      const f = fixture(initBaseline);
      f.host.register({ name: 'job_stop', description: 'Stop a job', exposure: 'direct' });
      f.host.register({ name: 'unmanaged_extra', description: 'Unmanaged', exposure: 'direct' });
      ensureToolBase(f.api, f.api, f.branch());
      setCapabilityStartupBlacklist(f.api, startupBanList);

      // Independent reference model of the four orthogonal layers.
      const baseline = new Set<string>(initBaseline);
      const permanentAdditions = new Set<string>();
      const startupBan = new Set<string>(startupBanList);
      const manualBan = new Set<string>();
      const manualBranch = new Map<string, 'add' | 'remove'>();
      const dynamicBranch = new Set<string>();
      const removalIntents = new Set<string>();
      let preset:
        | null
        | { kind: 'none'; disabled: Set<string> }
        | { kind: 'modifiers'; add: Set<string>; remove: Set<string>; disabled: Set<string> }
        | { kind: 'replace'; names: Set<string>; disabled: Set<string> } = null;

      const modelInBase = (name: string): boolean => {
        const manual = manualBranch.get(name);
        if (manual === 'add') return true;
        if (manual === 'remove') return false;
        const inEffBaseline = baseline.has(name) || permanentAdditions.has(name);
        if (preset === null || preset.kind === 'none') return inEffBaseline;
        if (preset.kind === 'replace') return preset.names.has(name);
        return preset.add.has(name) || (inEffBaseline && !preset.remove.has(name));
      };

      for (const op of ops) {
        if (op.kind === 'baseAdd') {
          addBaseTools(f.api, f.api, f.branch(), [op.name]);
          manualBranch.set(op.name, 'add');
        } else if (op.kind === 'baseRemove') {
          const wasInBase = modelInBase(op.name);
          const removed = removeBaseTools(f.api, f.api, f.branch(), [op.name]);
          assert.equal(removed.changed.length, wasInBase ? 1 : 0, `baseRemove(${op.name}) changed`);
          if (wasInBase) {
            manualBranch.set(op.name, 'remove');
            removalIntents.add(op.name);
          }
        } else if (op.kind === 'dynActivate') {
          activateToolTargets(f.api, f.api, f.branch(), [op.name]);
          dynamicBranch.add(op.name);
        } else if (op.kind === 'dynDeactivate') {
          const wasInDynamic = dynamicBranch.has(op.name);
          deactivateToolTargets(f.api, f.api, f.branch(), [op.name]);
          if (wasInDynamic) {
            dynamicBranch.delete(op.name);
            removalIntents.add(op.name);
          }
        } else if (op.kind === 'banAdd') {
          addBlacklistTargets(f.api, f.api, f.branch(), [op.name]);
          manualBan.add(op.name);
          removalIntents.add(op.name);
        } else if (op.kind === 'banRemove') {
          removeBlacklistTargets(f.api, f.api, f.branch(), [op.name]);
          manualBan.delete(op.name);
          startupBan.delete(op.name);
        } else if (op.kind === 'presetNone') {
          for (const a of op.additions) permanentAdditions.add(a);
          f.branch().push(presetEntry({ name: 'p', instructions: null }, op.additions));
          preset = { kind: 'none', disabled: new Set() };
        } else if (op.kind === 'presetMod') {
          for (const a of op.additions) permanentAdditions.add(a);
          f.branch().push(presetEntry({
            name: 'p', instructions: null,
            toolSelection: { kind: 'modifiers', add: op.add, remove: op.remove },
            disabledTools: op.disabled,
          }, op.additions));
          preset = { kind: 'modifiers', add: new Set(op.add), remove: new Set(op.remove), disabled: new Set(op.disabled) };
        } else if (op.kind === 'presetReplace') {
          for (const a of op.additions) permanentAdditions.add(a);
          f.branch().push(presetEntry({
            name: 'p', instructions: null,
            toolSelection: { kind: 'replace', names: op.names },
            tools: op.names,
            disabledTools: op.disabled,
          }, op.additions));
          preset = { kind: 'replace', names: new Set(op.names), disabled: new Set(op.disabled) };
        } else {
          f.branch().push(presetEntry(null));
          preset = null;
        }
      }

      const view = createToolAccessView(f.api, f.branch());
      const effectiveBaseline = new Set([...baseline, ...permanentAdditions]);
      assert.deepEqual([...sessionBaseNames(f.branch())].sort(), [...effectiveBaseline].sort());

      const expectedRetained: string[] = [];
      const expectedExcluded: string[] = [];
      const expectedRequested: string[] = [];

      for (const name of UNIVERSE) {
        const manual = manualBranch.get(name);
        const presetBase = preset === null || preset.kind === 'none'
          ? effectiveBaseline.has(name)
          : preset.kind === 'replace'
            ? preset.names.has(name)
            : preset.add.has(name) || (effectiveBaseline.has(name) && !preset.remove.has(name));
        const inBase = manual === 'add' ? true : manual === 'remove' ? false : presetBase;

        // Baseline and permanent baselineAdditions never override startup/preset bans;
        // only explicit manual base add or explicit preset add/replace can override local bans.
        const presetExplicit = preset !== null && (
          (preset.kind === 'replace' && preset.names.has(name))
          || (preset.kind === 'modifiers' && preset.add.has(name))
        );
        const explicitGrant = manual === 'add' || (manual !== 'remove' && presetExplicit);
        const hasStartup = startupBan.has(name);
        const hasPresetBan = preset !== null && preset.disabled.has(name);
        const hasManualBan = manualBan.has(name);
        const blacklisted = hasManualBan || hasStartup || hasPresetBan;
        const blocked = hasManualBan || ((hasStartup || hasPresetBan) && !explicitGrant);
        const requested = (inBase || dynamicBranch.has(name)) && !blocked;

        assert.equal(view.base(name), inBase, `base(${name})`);
        assert.equal(view.blacklisted(name), blacklisted, `blacklisted(${name})`);
        assert.equal(view.blocked(name), blocked, `blocked(${name})`);
        assert.equal(view.banOverridden(name), blacklisted && !blocked, `banOverridden(${name})`);
        assert.equal(view.requested(name), requested, `requested(${name})`);
        if (requested) expectedRequested.push(name);

        const presetIntentExclude = preset !== null && (
          (preset.kind === 'replace' && effectiveBaseline.has(name) && !preset.names.has(name))
          || (preset.kind === 'modifiers' && preset.remove.has(name))
        );
        if (presetIntentExclude) {
          if (inBase) expectedRetained.push(name);
          else expectedExcluded.push(name);
        }
      }

      assert.deepEqual([...view.preset.retained].sort(), expectedRetained.sort());
      assert.deepEqual([...presetRetainedByBranch(f.api, f.branch())].sort(), expectedRetained.sort());
      assert.deepEqual([...view.preset.excluded].sort(), expectedExcluded.sort());

      // Compaction drops excluded/blocked members while keeping requested and unmanaged tools.
      const compacted = activeToolsAfterCollections(f.api, f.branch(), [...UNIVERSE, 'unmanaged_extra']);
      for (const name of expectedRequested) assert.ok(compacted.includes(name));
      for (const name of expectedExcluded) {
        if (!dynamicBranch.has(name)) assert.ok(!compacted.includes(name));
      }
      assert.ok(compacted.includes('unmanaged_extra'));

      // Compute independent managed set: any name with a current membership, ban,
      // historical removal intent, or current preset exclusion.
      const expectedManaged = new Set<string>();
      for (const name of UNIVERSE) {
        const inBase = modelInBase(name);
        const hasBan = manualBan.has(name) || startupBan.has(name) || (preset !== null && preset.disabled.has(name));
        const managed = inBase || dynamicBranch.has(name) || hasBan || removalIntents.has(name) || expectedExcluded.includes(name);
        assert.equal(view.managed(name), managed, `managed(${name})`);
        if (managed) expectedManaged.add(name);
      }
      assert.equal(view.managed('unmanaged_extra'), false);

      // Branch sync preserves unmanaged live tools, drops managed non-requested tools,
      // is idempotent, and makes presetLiveToolsInSync true.
      if (hasUnmanagedLive) f.api.setActiveTools([...f.api.getActiveTools(), 'unmanaged_extra']);
      const beforeBranchSync = f.api.getActiveTools();
      const keptUnmanaged = beforeBranchSync.filter((name) => !expectedManaged.has(name) && !expectedRequested.includes(name));
      syncActiveToolsForBranch(f.api, f.branch());
      assert.equal(presetLiveToolsInSync(f.api, f.branch()), true);
      if (hasUnmanagedLive) assert.ok(f.api.getActiveTools().includes('unmanaged_extra'));
      assert.deepEqual([...f.api.getActiveTools()].sort(), [...new Set([...expectedRequested, ...keptUnmanaged])].sort());
      const secondSync = syncActiveToolsForBranch(f.api, f.branch());
      assert.deepEqual(secondSync.activated, []);
      assert.deepEqual(secondSync.removed, []);

      // Full collection sync converges the live set to exactly expectedRequested.
      syncActiveToolsToCollections(f.api, f.branch());
      assert.deepEqual([...f.api.getActiveTools()].sort(), [...expectedRequested].sort());
    },
  ));
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

  // A hard-banned member is not requested, so it leaves the availability
  // population; the base and blacklist lists still report the raw facts.
  const current = queryToolAccess(f.api, f.branch(), f.api.getActiveTools());
  assert.equal(current.entries.some((entry) => entry.name === 'docker_ps'), false);
  const facts = createToolAccessView(f.api, f.branch()).facts('docker_ps');
  assert.equal(facts.blocked, true);
  assert.equal(facts.banOverridden, false);
  assert.equal(facts.blacklisted, true);
  assert.equal(facts.requested, false);
  const base = listBaseTools(f.api, f.branch()).map((entry) => entry.target.target);
  assert.ok(base.includes('docker_ps'), 'the base list still reports the membership');
  const banned = listBlacklist(f.api, f.branch());
  assert.deepEqual(banned.map((entry) => entry.target.target), ['docker_ps']);
  assert.deepEqual(banned[0]?.sources, ['branch']);

  const withActivatable = queryToolAccess(f.api, f.branch(), f.api.getActiveTools(), { includeActivatable: true });
  assert.ok(withActivatable.entries.some((entry) => entry.name === 'docker_run'), 'an eligible inactive tool is activatable');
  assert.equal(withActivatable.entries.some((entry) => entry.name === 'docker_ps'), false,
    'a hard-banned member is not an activation candidate');

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
  assert.ok(!synced.active.includes('write'), 'a manual ban also beats a recorded baseline member');
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

test('a branch sync preserves names the harness does not manage', () => {
  const f = fixture(['read', 'write']);
  ensureToolBase(f.api, f.api, f.branch());
  f.host.register({ name: 'job_stop', description: 'Stop a job', exposure: 'direct' });
  f.host.register({ name: 'mcp__pending__call', description: 'Pending MCP tool', exposure: 'deferred' });
  f.api.setActiveTools(['read', 'write', 'job_stop', 'mcp__pending__call']);
  const calls: string[][] = [];
  const spy = Object.assign(Object.create(f.api), {
    setActiveTools: (names: string[]) => { calls.push([...names]); f.api.setActiveTools(names); },
  }) as typeof f.api;

  const same = syncActiveToolsForBranch(spy, f.branch());
  assert.deepEqual(calls, [], 'no difference means no setActiveTools call');
  assert.deepEqual(same.activated, []);
  assert.deepEqual(same.removed, []);

  // The branch preset excludes write; the native default and the unmanaged MCP
  // name are still declared afterwards.
  f.branch().push(presetEntry({
    name: 'p', instructions: null,
    toolSelection: { kind: 'modifiers', add: [], remove: ['write'] },
  }));
  assert.equal(createToolAccessView(f.api, f.branch()).managed('job_stop'), false);
  const synced = syncActiveToolsForBranch(spy, f.branch());
  assert.deepEqual(calls, [['read', 'job_stop', 'mcp__pending__call']]);
  assert.deepEqual(synced.removed, ['write']);
  assert.deepEqual(synced.activated, []);

  // A requested base member whose server is not connected stays declared: the
  // sync never drops a name the branch still requests.
  addBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  const withBase = f.api.getActiveTools();
  f.host.unregister('docker_ps');
  assert.equal(createToolAccessView(f.api, f.branch()).requested('docker_ps'), true);
  const kept = syncActiveToolsForBranch(f.api, f.branch());
  assert.ok(!kept.removed.includes('docker_ps'), 'an unregistered requested member is not dropped');
  assert.ok(!f.api.getActiveTools().includes('write'));
  assert.ok(withBase.length > 0);
});

test('presetLiveToolsInSync ignores unregistered requested members', () => {
  const f = fixture(['read', 'write']);
  ensureToolBase(f.api, f.api, f.branch());
  addBaseTools(f.api, f.api, f.branch(), ['docker_ps']);
  f.host.unregister('docker_ps');
  assert.equal(presetLiveToolsInSync(f.api, f.branch()), true);
});

test('an ancestor manual blacklist stays a hard fence in a child scope', () => {
  const parent = fixture(['read']);
  ensureToolBase(parent.api, parent.api, parent.branch());
  addBlacklistTargets(parent.api, parent.api, parent.branch(), ['docker_ps']);
  const parentView = createToolAccessView(parent.api, parent.branch());
  assert.equal(parentView.blocked('docker_ps'), true);

  // This is how the subagent root service exposes an ancestor's live bans.
  const child = fixture(['read']);
  setCapabilityParent(child.api, parent.api, [], (name) => parentView.blocked(name));
  ensureToolBase(child.api, child.api, child.branch());
  const added = addBaseTools(child.api, child.api, child.branch(), ['docker_ps']);
  assert.deepEqual(added.activated, [], 'the child cannot activate an ancestor-denied tool');
  assert.deepEqual(added.skipped, [{ target: 'docker_ps', reason: 'not_permitted' }]);
  const view = createToolAccessView(child.api, child.branch());
  assert.equal(view.base('docker_ps'), true, 'the child base record is written');
  assert.equal(view.blacklisted('docker_ps'), false, 'the ban itself is the ancestor branch record');
  // The scope fence is an eligibility/execution check, not a local ban fact, so
  // a published declaration is not rewritten mid-window.
  assert.equal(view.blocked('docker_ps'), false);
  assert.equal(view.requested('docker_ps'), true);
  assert.equal(createToolAdmission(child.api, child.branch()).admits('docker_ps'), false,
    'the ancestor fence still denies execution');
  assert.equal(createEligibleToolCatalog(child.api).names.has('docker_ps'), false,
    'the ancestor fence keeps it out of every eligible catalog');
});
