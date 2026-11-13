import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPresetPlan, clearActivePreset, type PresetApplyHost } from '../../src/preset/apply.ts';
import type { PresetApplyPlan, PresetIssue } from '../../src/preset/resolve.ts';
import type { PresetSnapshot } from '../../src/preset/state.ts';

interface Recorded {
  thinking: string[];
  tools: (readonly string[])[];
  states: (PresetSnapshot | null)[];
  codemodeCleared: number;
}

function host(options: { modelOk?: boolean } = {}): { host: PresetApplyHost; log: Recorded } {
  const log: Recorded = { thinking: [], tools: [], states: [], codemodeCleared: 0 };
  const value: PresetApplyHost = {
    setModel: () => Promise.resolve(options.modelOk ?? true),
    setThinkingLevel: (level) => { log.thinking.push(level); },
    setActiveTools: (tools) => { log.tools.push(tools); },
    appendState: (record) => { log.states.push(record.snapshot); },
    clearCodemodeMode: () => { log.codemodeCleared += 1; },
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
  assert.deepEqual(log.tools, []);
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
  assert.deepEqual(outcome.problems, [{
    severity: 'warning',
    kind: 'codemode_not_applied',
    codemode: { mode: 'only' },
    detail: 'codemode mode "only" cannot be applied in this session; it was recorded only.',
  }]);
});

test('clear records a null snapshot and reports whether codemode was cleared', () => {
  const { host: h, log } = host();
  const outcome = clearActivePreset(h);
  assert.deepEqual(outcome, { cleared: true, snapshot: null, codemodeCleared: true });
  assert.deepEqual(log.states, [null]);
  assert.equal(log.codemodeCleared, 1);
});
