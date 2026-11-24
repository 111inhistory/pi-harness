/**
 * Read-only version comparison, modifier normalization, and skip lifecycle.
 *
 * Combines focused boundary checks (missing / unresolvable / intent-only diffs /
 * read-only guarantee) with fast in-memory property tests backed by
 * `test-support/pbt.ts` seed/replay.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import {
  currentPresetView,
  presetVersionChanges,
  type PresetSessionHost,
} from '../../src/preset/application.ts';
import type { CodemodeMode, PresetConfig, ThinkingLevelName } from '../../src/preset/config.ts';
import { applyToolModifiers, parseToolModifiers } from '../../src/preset/modifiers.ts';
import { resolvePreset, type PresetApplyPlan } from '../../src/preset/resolve.ts';
import {
  appendPresetState,
  appendSkippedVersion,
  buildPresetSnapshot,
  PRESET_STATE_RECORD,
  PRESET_STATE_VERSION,
  readSkippedVersion,
  type PresetSnapshot,
  type PresetVersionSkippedRecord,
} from '../../src/preset/state.ts';
import { checkProperty } from '../../test-support/pbt.ts';

const baseEntry = (baseline: readonly string[]) => ({
  type: 'custom', customType: 'capability-tool-base', id: 'base', data: { version: 1, baseline, load: [] },
});
const presetEntry = (snapshot: PresetSnapshot | null, baselineAdditions?: readonly string[]) => ({
  type: 'custom',
  customType: PRESET_STATE_RECORD,
  id: 'state',
  data: { version: PRESET_STATE_VERSION, snapshot, ...(baselineAdditions === undefined ? {} : { baselineAdditions }) },
});

function readOnlyHost(
  branch: unknown[],
  options: { tools?: readonly string[]; models?: readonly (readonly [string, string])[] } = {},
): PresetSessionHost {
  const tools = options.tools ?? ['read', 'bash', 'edit', 'write'];
  const models = options.models ?? [['p', 'm'], ['p', 'other']];
  const pi = {
    appendEntry: () => { throw new Error('the read-only view must not append branch entries'); },
    getAllTools: () => tools.map((name) => ({ name })),
    getActiveTools: () => [...tools],
    setActiveTools: () => { throw new Error('the read-only view must not change the loadout'); },
  } as unknown as ExtensionAPI;
  return {
    pi,
    getBranch: () => branch,
    modelRegistry: {
      find: (provider: string, id: string) => (models.some(([p, m]) => p === provider && m === id) ? {} as never : undefined),
    },
  };
}

const fastConfig: PresetConfig = {
  model: { provider: 'p', id: 'm' },
  thinkingLevel: 'low',
  tools: ['+write'],
  codemode: { mode: 'on' },
  instructions: 'guide',
};

const recordedFast = buildPresetSnapshot({
  name: 'fast',
  model: { provider: 'p', id: 'm' },
  thinkingLevel: 'low',
  tools: ['read', 'bash', 'write'],
  disabledTools: [],
  codemode: { mode: 'on' },
  instructions: 'guide',
  toolSelection: { kind: 'modifiers', add: ['write'], remove: [] },
});

// ---- focused boundary checks ----

test('absent, cleared, missing and unresolvable presets report exact status without writing', () => {
  assert.deepEqual(currentPresetView(readOnlyHost([]), { presets: new Map([['fast', fastConfig]]) }), {
    preset: null, status: null, currentVersion: null, changes: [],
  });

  const cleared = readOnlyHost([baseEntry(['read', 'bash']), presetEntry(null)]);
  assert.equal(currentPresetView(cleared, { presets: new Map([['fast', fastConfig]]) }).status, null);

  const branch = [baseEntry(['read', 'bash']), presetEntry(recordedFast)];
  const missing = currentPresetView(readOnlyHost(branch), { presets: new Map() });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.currentVersion, null);
  assert.deepEqual(missing.changes, []);
  assert.equal(missing.preset?.name, 'fast');

  const unresolvableModel = currentPresetView(readOnlyHost(branch, { models: [] }), { presets: new Map([['fast', fastConfig]]) });
  assert.equal(unresolvableModel.status, 'unresolvable');
  assert.equal(unresolvableModel.currentVersion, null);
  assert.equal(unresolvableModel.preset?.contentHash, recordedFast.contentHash);

  assert.equal(
    currentPresetView(readOnlyHost(branch), { presets: new Map(), invalidNames: new Set(['fast']) }).status,
    'unresolvable',
    'a catalog-rejected definition is unresolvable, not missing',
  );
  assert.equal(
    currentPresetView(readOnlyHost(branch), { presets: new Map(), invalidDocument: true }).status,
    'unresolvable',
    'an unreadable catalog makes absent names unresolvable',
  );
});

test('an intent change with an identical tool projection is still outdated and reported', () => {
  const registered = ['read', 'bash', 'edit', 'write'];
  const replaced = buildPresetSnapshot({
    name: 'fast',
    tools: ['read', 'bash', 'write'],
    disabledTools: [],
    instructions: null,
    toolSelection: { kind: 'replace', names: ['read', 'bash', 'write'] },
  });
  const view = currentPresetView(
    readOnlyHost([baseEntry(['read', 'bash']), presetEntry(replaced)], { tools: registered }),
    { presets: new Map([['fast', { tools: ['+write'] }]]) },
  );
  assert.equal(view.status, 'outdated');
  assert.ok(view.changes.includes('toolSelection: replace -> modifiers'));

  const redundantAdd = buildPresetSnapshot({
    name: 'fast',
    tools: ['read', 'bash'],
    disabledTools: [],
    instructions: null,
    toolSelection: { kind: 'modifiers', add: ['read'], remove: [] },
  });
  const changedIntent = currentPresetView(
    readOnlyHost([baseEntry(['read', 'bash']), presetEntry(redundantAdd)], { tools: registered }),
    { presets: new Map([['fast', { tools: ['+bash'] }]]) },
  );
  assert.equal(changedIntent.status, 'outdated');
  assert.deepEqual(changedIntent.changes, ['toolSelection: +bash -read']);
});

test('a sign flip on one name is reported once per field', () => {
  const recorded = buildPresetSnapshot({
    name: 'fast',
    tools: ['read', 'bash'],
    disabledTools: [],
    instructions: null,
    toolSelection: { kind: 'modifiers', add: ['bash'], remove: [] },
  });
  const candidate: PresetApplyPlan = {
    ...buildPresetSnapshot({
      name: 'fast',
      tools: ['read'],
      disabledTools: ['bash'],
      instructions: null,
      toolSelection: { kind: 'modifiers', add: [], remove: ['bash'] },
    }),
    baselineAdditions: [],
  };
  assert.deepEqual(presetVersionChanges(recorded, candidate), [
    'toolSelection: -bash',
    'tools: -bash',
    'disabledTools: +bash',
  ]);
});

// ---- property-based tests ----

const CORE_TOOLS = ['read', 'bash', 'edit', 'write', 'codemode'] as const;
const HARNESS_DEFAULTS = ['job_stop', 'job_send', 'job_key'] as const;

const arbToolsField: fc.Arbitrary<readonly string[]> = fc.oneof(
  fc.constant<readonly string[]>([]),
  fc.uniqueArray(fc.constantFrom(...CORE_TOOLS), { minLength: 1, maxLength: 4 }),
  fc.array(
    fc.tuple(fc.constantFrom('+', '-'), fc.constantFrom(...CORE_TOOLS)).map(([op, name]) => `${op}${name}`),
    { minLength: 1, maxLength: 6 },
  ),
);

const arbPresetConfig: fc.Arbitrary<PresetConfig> = fc.record({
  description: fc.constantFrom('desc A', 'desc B', ''),
  model: fc.constantFrom({ provider: 'p', id: 'm1' }, { provider: 'p', id: 'm2' }),
  thinkingLevel: fc.constantFrom<ThinkingLevelName>('low', 'medium', 'high'),
  tools: arbToolsField,
  codemode: fc.constantFrom<{ readonly mode: CodemodeMode }>({ mode: 'on' }, { mode: 'only' }),
  instructions: fc.constantFrom('', 'be terse', 'be thorough'),
}, { requiredKeys: [] });

function snapshotFromPlan(name: string, plan: NonNullable<ReturnType<typeof resolvePreset>['plan']>): PresetSnapshot {
  return buildPresetSnapshot({
    name,
    ...(plan.model === undefined ? {} : { model: plan.model }),
    ...(plan.thinkingLevel === undefined ? {} : { thinkingLevel: plan.thinkingLevel }),
    ...(plan.tools === undefined ? {} : { tools: plan.tools }),
    ...(plan.disabledTools === undefined ? {} : { disabledTools: plan.disabledTools }),
    ...(plan.codemode === undefined ? {} : { codemode: plan.codemode }),
    instructions: plan.instructions,
    toolSelection: plan.toolSelection,
  });
}

test('PBT: contentHash, currentPresetView, single-field sensitivity and manual-layer isolation', async () => {
  await checkProperty(fc.asyncProperty(
    fc.uniqueArray(fc.constantFrom(...CORE_TOOLS), { minLength: 0, maxLength: 4 }),
    fc.uniqueArray(fc.constantFrom(...HARNESS_DEFAULTS), { minLength: 0, maxLength: 3 }),
    fc.uniqueArray(fc.constantFrom(...CORE_TOOLS, ...HARNESS_DEFAULTS), { minLength: 0, maxLength: 3 }),
    fc.uniqueArray(fc.constantFrom(...CORE_TOOLS, ...HARNESS_DEFAULTS), { minLength: 0, maxLength: 3 }),
    arbPresetConfig,
    fc.constantFrom('alpha', 'beta'),
    fc.constantFrom('renamed-a', 'renamed-b'),
    async (baseline, registeredDefaults, manualRemove, manualBan, cfgA, nameA, nameB) => {
      const models: readonly (readonly [string, string])[] = [['p', 'm1'], ['p', 'm2']];
      const allOld = [...CORE_TOOLS];
      const allNew = [...CORE_TOOLS, ...registeredDefaults];

      const resolvedA = resolvePreset(nameA, cfgA, {
        hasModel: () => true,
        allToolNames: () => allOld,
        baseToolSet: () => baseline,
      });
      assert.ok(resolvedA.plan);
      const snapA = snapshotFromPlan(nameA, resolvedA.plan);

      const plainBranch = [baseEntry(baseline), presetEntry(snapA)];
      const manualBranch = [
        ...plainBranch,
        ...(manualRemove.length === 0 ? [] : [{
          type: 'custom', customType: 'capability-tool-base', id: 'm1',
          data: { version: 1, remove: manualRemove },
        }]),
        ...(manualBan.length === 0 ? [] : [{
          type: 'custom', customType: 'capability-tool-blacklist', id: 'm2',
          data: { version: 1, add: manualBan },
        }]),
      ];

      // Identity laws: description, token order, preset rename and manual branch records never alter version.
      const reorderedTools = snapA.toolSelection.kind === 'replace'
        ? [...snapA.toolSelection.names].reverse()
        : snapA.toolSelection.kind === 'modifiers'
          ? [
            ...snapA.toolSelection.remove.map((name) => `-${name}`).reverse(),
            ...snapA.toolSelection.add.map((name) => `+${name}`).reverse(),
          ]
          : undefined;
      const equivalentA: PresetConfig = {
        ...cfgA,
        description: `${cfgA.description ?? ''}-edited`,
        ...(reorderedTools === undefined ? {} : { tools: reorderedTools }),
      };
      const viewPlain = currentPresetView(readOnlyHost(plainBranch, { tools: allOld, models }), {
        presets: new Map([[nameA, equivalentA]]),
      });
      const viewManual = currentPresetView(readOnlyHost(manualBranch, { tools: allOld, models }), {
        presets: new Map([[nameA, equivalentA]]),
      });
      assert.equal(viewPlain.status, 'current');
      assert.equal(viewPlain.currentVersion, snapA.contentHash);
      assert.deepEqual(viewPlain.changes, []);
      assert.deepEqual(viewManual, viewPlain, 'manual base removals and blacklists never affect preset version');

      const renamedPlan = resolvePreset(nameB, equivalentA, {
        hasModel: () => true,
        allToolNames: () => allOld,
        baseToolSet: () => baseline,
      }).plan!;
      assert.equal(renamedPlan.contentHash, snapA.contentHash);

      // Independent single-field mutations: every semantic field change must flip hash and emit its summary.
      const checkMutation = (
        label: string,
        mutated: PresetConfig,
        requiredPrefixes: readonly string[],
        exactCount?: number,
      ) => {
        const view = currentPresetView(readOnlyHost(plainBranch, { tools: allOld, models }), {
          presets: new Map([[nameA, mutated]]),
        });
        assert.equal(view.status, 'outdated', `${label}: must be outdated`);
        assert.notEqual(view.currentVersion, snapA.contentHash, `${label}: contentHash must change`);
        for (const prefix of requiredPrefixes) {
          assert.ok(view.changes.some((line) => line.startsWith(prefix)), `${label}: missing ${prefix} in ${JSON.stringify(view.changes)}`);
        }
        if (exactCount !== undefined) {
          assert.equal(view.changes.length, exactCount, `${label}: unexpected extra changes ${JSON.stringify(view.changes)}`);
        }
      };

      checkMutation(
        'model',
        { ...cfgA, model: snapA.model?.id === 'm1' ? { provider: 'p', id: 'm2' } : { provider: 'p', id: 'm1' } },
        ['model: '],
        1,
      );
      checkMutation(
        'thinkingLevel',
        { ...cfgA, thinkingLevel: snapA.thinkingLevel === 'high' ? 'low' : 'high' },
        ['thinkingLevel: '],
        1,
      );
      checkMutation(
        'tools',
        { ...cfgA, tools: snapA.tools?.includes('read') ? ['write'] : ['read'] },
        ['toolSelection: ', 'tools: '],
      );
      checkMutation(
        'disabledTools',
        { ...cfgA, tools: snapA.disabledTools?.includes('bash') ? ['-edit'] : ['-bash'] },
        ['toolSelection: ', 'disabledTools: '],
      );
      checkMutation(
        'codemode',
        { ...cfgA, codemode: { mode: snapA.codemode?.mode === 'only' ? 'on' : 'only' } },
        ['codemode: '],
        1,
      );
      checkMutation(
        'instructions',
        { ...cfgA, instructions: snapA.instructions === 'be terse' ? 'be thorough' : 'be terse' },
        ['instructions: changed'],
        1,
      );

      // Harness default upgrade: new registered defaults mark modifier presets outdated until committed.
      const baselineSet = new Set<string>(baseline);
      const newDefaults = registeredDefaults.filter((d) => !baselineSet.has(d));
      if (newDefaults.length > 0 && snapA.toolSelection.kind === 'modifiers') {
        const viewUpgraded = currentPresetView(readOnlyHost(plainBranch, { tools: allNew, models }), {
          presets: new Map([[nameA, cfgA]]),
        });
        assert.equal(viewUpgraded.status, 'outdated');
        const resolvedUpgraded = resolvePreset(nameA, cfgA, {
          hasModel: () => true,
          allToolNames: () => allNew,
          baseToolSet: () => baseline,
        }).plan!;
        const upgradedSnap = snapshotFromPlan(nameA, resolvedUpgraded);
        const settled = currentPresetView(
          readOnlyHost([baseEntry(baseline), presetEntry(upgradedSnap, resolvedUpgraded.baselineAdditions)], { tools: allNew, models }),
          { presets: new Map([[nameA, cfgA]]) },
        );
        assert.equal(settled.status, 'current');
      }
    },
  ));
});

test('PBT: applyToolModifiers satisfies independent last-occurrence-wins set & order laws', async () => {
  const arbToken = fc.tuple(fc.constantFrom('+', '-', '='), fc.constantFrom(...CORE_TOOLS))
    .map(([op, name]) => (op === '=' ? name : `${op}${name}`));
  await checkProperty(fc.asyncProperty(
    fc.uniqueArray(fc.constantFrom(...CORE_TOOLS), { minLength: 0, maxLength: 5 }),
    fc.array(arbToken, { minLength: 0, maxLength: 10 }),
    async (base, raw) => {
      const { tokens } = parseToolModifiers(raw);
      const actual = applyToolModifiers(base, tokens);
      assert.equal(new Set(actual).size, actual.length, 'result contains no duplicate names');

      const plainNames = tokens.filter((t) => t.op === '=').map((t) => t.name);
      const initial = new Set(plainNames.length > 0 ? plainNames : base);
      for (const name of CORE_TOOLS) {
        let lastOp: '+' | '-' | null = null;
        for (const t of tokens) {
          if (t.name === name && (t.op === '+' || t.op === '-')) lastOp = t.op;
        }
        const shouldContain = lastOp === '+' ? true : lastOp === '-' ? false : initial.has(name);
        assert.equal(actual.includes(name), shouldContain, `membership mismatch for ${name}`);
      }

      // Base members never removed preserve their relative order when no plain replacement occurs.
      if (plainNames.length === 0) {
        const untouchedBase = base.filter((name) => !tokens.some((t) => t.op === '-' && t.name === name));
        const positions = untouchedBase.map((name) => actual.indexOf(name));
        for (let i = 1; i < positions.length; i += 1) {
          assert.ok(positions[i]! > positions[i - 1]!, 'untouched base order is preserved');
        }
      }
    },
  ));
});

test('PBT: readSkippedVersion returns only the latest skip after the latest preset-state', async () => {
  type Step =
    | { kind: 'apply'; name: string; hash: string }
    | { kind: 'clear' }
    | { kind: 'skip'; name: string; fromHash: string; candidateHash: string };
  const arbStep: fc.Arbitrary<Step> = fc.oneof(
    fc.record({
      kind: fc.constant('apply' as const),
      name: fc.constantFrom('fast', 'slow'),
      hash: fc.constantFrom('h1', 'h2'),
    }),
    fc.constant<Step>({ kind: 'clear' }),
    fc.record({
      kind: fc.constant('skip' as const),
      name: fc.constantFrom('fast', 'slow'),
      fromHash: fc.constantFrom('h1', 'h2'),
      candidateHash: fc.constantFrom('c1', 'c2', 'c3'),
    }),
  );
  await checkProperty(fc.asyncProperty(
    fc.array(arbStep, { minLength: 0, maxLength: 15 }),
    async (steps) => {
      const branch: unknown[] = [];
      const writer = {
        appendEntry: (customType: string, data: unknown) => {
          branch.push({ type: 'custom', customType, data, id: `e${branch.length}` });
        },
      };
      let seenState = false;
      let expected: PresetVersionSkippedRecord | null = null;
      for (const step of steps) {
        if (step.kind === 'apply') {
          appendPresetState(writer, {
            version: PRESET_STATE_VERSION,
            snapshot: buildPresetSnapshot({ name: step.name, instructions: step.hash }),
          });
          seenState = true;
          expected = null;
        } else if (step.kind === 'clear') {
          appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot: null });
          seenState = true;
          expected = null;
        } else {
          const rec: PresetVersionSkippedRecord = {
            version: 1, name: step.name, fromHash: step.fromHash, candidateHash: step.candidateHash,
          };
          appendSkippedVersion(writer, rec);
          if (seenState) expected = rec;
        }
        assert.deepEqual(readSkippedVersion(branch), expected);
      }
    },
  ));
});
