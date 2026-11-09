import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPresetPlan, clearActivePreset, type PresetApplyHost } from '../../src/preset/apply.ts';
import type { PresetApplyPlan, PresetIssue } from '../../src/preset/resolve.ts';
import type { PresetSnapshot } from '../../src/preset/state.ts';

interface Recorded {
  models: string[];
  thinking: string[];
  tools: (readonly string[])[];
  states: (PresetSnapshot | null)[];
  notices: { message: string; level: string }[];
  codemode: (string | null)[];
}

function host(options: { modelOk?: boolean; applyCodemode?: boolean } = {}): { host: PresetApplyHost; log: Recorded } {
  const log: Recorded = { models: [], thinking: [], tools: [], states: [], notices: [], codemode: [] };
  const value: PresetApplyHost = {
    setModel: (provider, id) => { log.models.push(`${provider}/${id}`); return Promise.resolve(options.modelOk ?? true); },
    setThinkingLevel: (level) => { log.thinking.push(level); },
    setActiveTools: (tools) => { log.tools.push(tools); },
    appendState: (record) => { log.states.push(record.snapshot); },
    notify: (message, level) => { log.notices.push({ message, level }); },
    ...(options.applyCodemode === true
      ? {
          applyCodemodeMode: (mode: 'on' | 'only') => { log.codemode.push(mode); },
          clearCodemodeMode: () => { log.codemode.push(null); },
        }
      : {}),
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

test('applies model, thinking, tools, records snapshot and reports success', async () => {
  const { host: h, log } = host();
  const outcome = await applyPresetPlan(basePlan, noIssues, h);
  assert.equal(outcome.applied, true);
  assert.deepEqual(log.models, ['p/m']);
  assert.deepEqual(log.thinking, ['high']);
  assert.deepEqual(log.tools, [['read', 'write']]);
  assert.deepEqual(outcome.snapshot, {
    name: 'fast', model: { provider: 'p', id: 'm' }, thinkingLevel: 'high', tools: ['read', 'write'], instructions: 'be terse',
  });
  assert.equal(log.states.length, 1);
  assert.equal(log.notices.at(-1)?.level, 'info');
});

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

test('a host that applies codemode mode reports it applied without a not-applied warning', async () => {
  const { host: h, log } = host({ applyCodemode: true });
  const plan: PresetApplyPlan = { name: 'only', codemode: { mode: 'only' }, instructions: null };
  const outcome = await applyPresetPlan(plan, noIssues, h);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.codemodeNotApplied, false);
  assert.deepEqual(log.codemode, ['only'], 'the host actually switches the mode');
  assert.deepEqual(outcome.snapshot?.codemode, { mode: 'only' });
  assert.ok(!log.notices.some((notice) => notice.level === 'warning' && notice.message.includes('codemode')),
    'a genuinely applied mode must not warn that it was not switched');
});

test('clear records a null snapshot and leaves tools/model untouched', () => {
  const { host: h, log } = host({ applyCodemode: true });
  clearActivePreset(h);
  assert.deepEqual(log.states, [null]);
  assert.deepEqual(log.models, []);
  assert.deepEqual(log.tools, []);
  assert.deepEqual(log.codemode, [null], 'clear drops the preset codemode override');
});
