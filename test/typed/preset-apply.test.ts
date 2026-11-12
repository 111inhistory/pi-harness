import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPresetPlan, type PresetApplyHost } from '../../src/preset/apply.ts';
import type { PresetApplyPlan, PresetIssue } from '../../src/preset/resolve.ts';
import type { PresetSnapshot } from '../../src/preset/state.ts';

interface Recorded {
  thinking: string[];
  tools: (readonly string[])[];
  states: (PresetSnapshot | null)[];
  notices: { message: string; level: string }[];
}

function host(options: { modelOk?: boolean } = {}): { host: PresetApplyHost; log: Recorded } {
  const log: Recorded = { thinking: [], tools: [], states: [], notices: [] };
  const value: PresetApplyHost = {
    setModel: () => Promise.resolve(options.modelOk ?? true),
    setThinkingLevel: (level) => { log.thinking.push(level); },
    setActiveTools: (tools) => { log.tools.push(tools); },
    appendState: (record) => { log.states.push(record.snapshot); },
    notify: (message, level) => { log.notices.push({ message, level }); },
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
  assert.ok(log.notices.some((notice) => notice.level === 'error'));
});

test('codemode mode is recorded but flagged not applied with a warning', async () => {
  const { host: h, log } = host();
  const plan: PresetApplyPlan = { name: 'only', codemode: { mode: 'only' }, instructions: null };
  const outcome = await applyPresetPlan(plan, noIssues, h);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.codemodeNotApplied, true);
  assert.deepEqual(outcome.snapshot?.codemode, { mode: 'only' });
  assert.ok(log.notices.some((notice) => notice.level === 'warning' && notice.message.includes('codemode')));
});
