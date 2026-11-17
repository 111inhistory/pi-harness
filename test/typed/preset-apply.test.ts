import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPresetPlan, clearActivePreset, type PresetApplyHost } from '../../src/preset/apply.ts';
import type { PresetApplyPlan, PresetIssue } from '../../src/preset/resolve.ts';
import type { PresetSnapshot } from '../../src/preset/state.ts';

interface Recorded {
  thinking: string[];
  syncs: number;
  states: (PresetSnapshot | null)[];
  codemodeCleared: number;
  codemodeApplied: string[];
  /** Mutations in call order; durable records must precede the loadout effect. */
  order: string[];
}

interface HostOptions {
  modelOk?: boolean;
  /** Error text the loadout effect returns; null means the sync succeeded. */
  syncError?: string | null;
  /** Whether the host can apply a Codemode mode (omitted = record only). */
  canApplyCodemode?: boolean;
}

function host(options: HostOptions = {}): { host: PresetApplyHost; log: Recorded } {
  const log: Recorded = {
    thinking: [], syncs: 0, states: [], codemodeCleared: 0, codemodeApplied: [], order: [],
  };
  const value: PresetApplyHost = {
    setModel: () => { log.order.push('model'); return Promise.resolve(options.modelOk ?? true); },
    setThinkingLevel: (level) => { log.thinking.push(level); log.order.push('thinking'); },
    syncTools: () => {
      log.syncs += 1;
      log.order.push('sync');
      return options.syncError ?? null;
    },
    appendState: (record) => { log.states.push(record.snapshot); log.order.push('state'); },
    ...(options.canApplyCodemode === true
      ? { applyCodemodeMode: (mode: 'on' | 'only') => { log.codemodeApplied.push(mode); log.order.push('codemode'); } }
      : {}),
    clearCodemodeMode: () => { log.codemodeCleared += 1; log.order.push('codemode-clear'); },
  };
  return { host: value, log };
}

const basePlan: PresetApplyPlan = {
  name: 'fast',
  model: { provider: 'p', id: 'm' },
  thinkingLevel: 'high',
  tools: ['read', 'write'],
  instructions: 'be terse',
};
const noIssues: readonly PresetIssue[] = [];

test('a failed model switch applies nothing and does not report success', async () => {
  const { host: h, log } = host({ modelOk: false });
  const outcome = await applyPresetPlan(basePlan, noIssues, h);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.snapshot, null);
  assert.deepEqual(log.thinking, []);
  assert.equal(log.syncs, 0, 'no loadout is recomputed when nothing was applied');
  assert.equal(log.states.length, 0);
  assert.deepEqual(outcome.problems, [{
    severity: 'error',
    kind: 'model_unauthenticated',
    model: { provider: 'p', id: 'm' },
    detail: 'model p/m is not authenticated; nothing applied.',
  }]);
});

test('codemode mode is recorded but flagged not applied with a warning', async () => {
  const { host: h, log } = host();
  const plan: PresetApplyPlan = { name: 'only', codemode: { mode: 'only' }, instructions: null };
  const outcome = await applyPresetPlan(plan, noIssues, h);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.codemodeNotApplied, true);
  assert.deepEqual(outcome.snapshot?.codemode, { mode: 'only' });
  assert.deepEqual(log.order, ['state', 'sync'], 'the snapshot is durable before the tool sync');
  assert.deepEqual(outcome.problems, [{
    severity: 'warning',
    kind: 'codemode_not_applied',
    codemode: { mode: 'only' },
    detail: 'codemode mode "only" cannot be applied in this session; it was recorded only.',
  }]);
});

test('a declared codemode intent is recorded before the loadout effect', async () => {
  const { host: h, log } = host({ canApplyCodemode: true });
  const plan: PresetApplyPlan = { name: 'only', codemode: { mode: 'only' }, instructions: null };
  const outcome = await applyPresetPlan(plan, noIssues, h);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.codemodeNotApplied, false);
  assert.deepEqual(log.codemodeApplied, ['only']);
  assert.deepEqual(log.order, ['state', 'codemode', 'sync'],
    'both durable records precede the only loadout effect');
});

test('a loadout sync failure is reported on the durable outcome, not thrown', async () => {
  const { host: h, log } = host({ syncError: 'capability scope parent chain contains a cycle' });
  const outcome = await applyPresetPlan(basePlan, noIssues, h);
  assert.equal(outcome.applied, true, 'the durable snapshot still counts as applied');
  assert.deepEqual(outcome.snapshot?.tools, ['read', 'write']);
  assert.deepEqual(log.states, [outcome.snapshot], 'the snapshot was written before the failed effect');
  assert.deepEqual(log.order.slice(-2), ['state', 'sync']);
  const syncProblem = outcome.problems.find((problem) => problem.kind === 'tool_sync_failed');
  assert.deepEqual(syncProblem, {
    severity: 'warning',
    kind: 'tool_sync_failed',
    detail: 'the tool loadout could not be synchronized from the recorded collections: '
      + 'capability scope parent chain contains a cycle',
  });
  assert.equal(outcome.codemodeNotApplied, false);
});

test('clear writes the durable withdrawal and codemode clear before the loadout effect', () => {
  const { host: h, log } = host();
  const outcome = clearActivePreset(h);
  assert.deepEqual(outcome, { cleared: true, snapshot: null, codemodeCleared: true, toolSyncError: null });
  assert.deepEqual(log.states, [null]);
  assert.equal(log.syncs, 1, 'clear ends the preset blacklist lifetime and recomputes availability');
  assert.equal(log.codemodeCleared, 1);
  assert.deepEqual(log.order, ['state', 'codemode-clear', 'sync'],
    'the withdrawal and codemode records precede the loadout effect');
});

test('a clear loadout sync failure keeps the clear durable and reports the effect error', () => {
  const { host: h, log } = host({ syncError: 'sdk setActiveTools failed' });
  const outcome = clearActivePreset(h);
  assert.deepEqual(outcome, {
    cleared: true,
    snapshot: null,
    codemodeCleared: true,
    toolSyncError: 'sdk setActiveTools failed',
  });
  assert.deepEqual(log.states, [null], 'the cleared snapshot stays authoritative');
  assert.deepEqual(log.order, ['state', 'codemode-clear', 'sync']);
});
