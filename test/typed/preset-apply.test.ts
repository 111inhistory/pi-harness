import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { applyPresetToSession, type PresetSessionHost } from '../../src/preset/application.ts';
import { applyPresetPlan, clearActivePreset, type PresetApplyHost } from '../../src/preset/apply.ts';
import type { PresetApplyPlan, PresetIssue } from '../../src/preset/resolve.ts';
import {
  buildPresetSnapshot,
  PRESET_STATE_RECORD,
  type PresetSnapshot,
  type PresetToolSelection,
} from '../../src/preset/state.ts';

interface Recorded {
  thinking: string[];
  syncs: number;
  states: { snapshot: PresetSnapshot | null; baselineAdditions?: readonly string[] }[];
  order: string[];
}

interface HostOptions {
  modelOk?: boolean;
  syncError?: string | null;
  inSync?: boolean;
  recorded?: PresetSnapshot | null;
  contextToken?: () => string;
  retained?: readonly string[];
  assertSession?: () => string | null;
}

function host(options: HostOptions = {}): { host: PresetApplyHost & { setModel: PresetApplyHost['setModel'] }; log: Recorded } {
  const log: Recorded = { thinking: [], syncs: 0, states: [], order: [] };
  const value: PresetApplyHost = {
    setModel: () => { log.order.push('model'); return Promise.resolve(options.modelOk ?? true); },
    setThinkingLevel: (level) => { log.thinking.push(level); log.order.push('thinking'); },
    syncTools: () => {
      log.syncs += 1;
      log.order.push('sync');
      return options.syncError ?? null;
    },
    toolsInSync: () => options.inSync ?? false,
    appendState: (record) => {
      log.states.push(record);
      log.order.push('state');
    },
    recordedSnapshot: () => options.recorded ?? null,
    contextToken: () => options.contextToken?.() ?? '0:',
    retainedToolNames: () => options.retained ?? [],
    ...(options.assertSession === undefined ? {} : { assertSession: options.assertSession }),
  };
  return { host: value, log };
}

function plan(fields: {
  name: string;
  model?: { provider: string; id: string };
  thinkingLevel?: PresetApplyPlan['thinkingLevel'];
  tools?: readonly string[];
  disabledTools?: readonly string[];
  codemode?: PresetApplyPlan['codemode'];
  toolSelection?: PresetToolSelection;
  baselineAdditions?: readonly string[];
  instructions: string | null;
}): PresetApplyPlan {
  const toolSelection: PresetToolSelection = fields.toolSelection ?? (fields.tools === undefined
    ? { kind: 'none' }
    : { kind: 'replace', names: fields.tools });
  const snapshot = buildPresetSnapshot({
    name: fields.name,
    ...(fields.model === undefined ? {} : { model: fields.model }),
    ...(fields.thinkingLevel === undefined ? {} : { thinkingLevel: fields.thinkingLevel }),
    ...(fields.tools === undefined ? {} : { tools: fields.tools }),
    ...(fields.disabledTools === undefined ? {} : { disabledTools: fields.disabledTools }),
    ...(fields.codemode === undefined ? {} : { codemode: fields.codemode }),
    instructions: fields.instructions,
    toolSelection,
  });
  return { ...snapshot, toolSelection, baselineAdditions: fields.baselineAdditions ?? [] };
}

const basePlan = plan({
  name: 'fast',
  model: { provider: 'p', id: 'm' },
  thinkingLevel: 'high',
  tools: ['read', 'write'],
  instructions: 'be terse',
});
const noIssues: readonly PresetIssue[] = [];

// ---- applyPresetPlan / clearActivePreset ----

test('a failed model switch applies nothing and does not report success', async () => {
  const { host: h, log } = host({ modelOk: false });
  const outcome = await applyPresetPlan(basePlan, noIssues, h);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.unchanged, false);
  assert.equal(outcome.snapshot, null);
  assert.deepEqual(log.thinking, []);
  assert.equal(log.syncs, 0);
  assert.deepEqual(log.states, []);
  assert.equal(outcome.problems[0]?.kind, 'model_unauthenticated');
});

test('an expectedVersion mismatch refuses the apply before any record or live effect', async () => {
  const { host: h, log } = host();
  const outcome = await applyPresetPlan(basePlan, noIssues, h, { expectedVersion: 'stale-hash' });
  assert.equal(outcome.applied, false);
  assert.equal(outcome.snapshot, null);
  assert.deepEqual(log.order, []);
  assert.equal(outcome.problems[0]?.kind, 'version_mismatch');

  const accepted = await applyPresetPlan(basePlan, noIssues, host().host, { expectedVersion: basePlan.contentHash });
  assert.equal(accepted.applied, true);
});

test('an apply writes one atomic version pack and always recomputes the loadout', async () => {
  const prior = plan({ name: 'fast', instructions: null });
  const { host: h, log } = host({ recorded: prior, inSync: true });
  const withCodemode = plan({
    name: 'only',
    model: { provider: 'p', id: 'm' },
    thinkingLevel: 'high',
    codemode: { mode: 'only' },
    instructions: null,
    tools: ['read'],
    baselineAdditions: ['job_stop'],
  });
  const outcome = await applyPresetPlan(withCodemode, noIssues, h);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.unchanged, false);
  assert.deepEqual(outcome.snapshot?.codemode, { mode: 'only' });
  assert.deepEqual(outcome.problems, []);
  assert.deepEqual(log.order, ['model', 'thinking', 'state', 'sync'],
    'durable record precedes loadout sync and a new record always recomputes even when inSync');
  assert.equal(log.states.length, 1);
  assert.deepEqual(log.states[0]?.baselineAdditions, ['job_stop']);
  assert.equal(log.states[0]?.snapshot?.contentHash, withCodemode.contentHash);
});

test('an unchanged re-apply is a silent no-op when already in sync', async () => {
  const recorded = plan({
    name: 'fast', model: { provider: 'p', id: 'm' }, thinkingLevel: 'high',
    tools: ['read'], instructions: 'be terse',
  });
  const { host: h, log } = host({ recorded, inSync: true, modelOk: false, retained: ['edit'] });
  const outcome = await applyPresetPlan(
    plan({
      name: 'fast', model: { provider: 'p', id: 'm' }, thinkingLevel: 'high',
      tools: ['read'], instructions: 'be terse',
    }),
    noIssues,
    h,
  );
  assert.equal(outcome.applied, true);
  assert.equal(outcome.unchanged, true);
  assert.equal(outcome.snapshot?.contentHash, recorded.contentHash);
  assert.deepEqual(log.order, [], 'no model, thinking, record or loadout effect');
  assert.deepEqual(outcome.problems, [], 'a true no-op reports no retained-tool warning');
});

test('same hash under a new name or with a pending baseline increment writes one record', async () => {
  const recorded = plan({ name: 'fast', tools: ['read'], instructions: null });
  const renamed = plan({ name: 'renamed', tools: ['read'], instructions: null });
  assert.equal(renamed.contentHash, recorded.contentHash);
  const first = host({ recorded, inSync: true });
  const renamedOutcome = await applyPresetPlan(renamed, noIssues, first.host);
  assert.equal(renamedOutcome.unchanged, false);
  assert.equal(first.log.states.length, 1);
  assert.equal(renamedOutcome.snapshot?.name, 'renamed');

  const second = host({ recorded, inSync: true });
  const withDefault = plan({ name: 'fast', tools: ['read'], instructions: null, baselineAdditions: ['job_stop'] });
  const incOutcome = await applyPresetPlan(withDefault, noIssues, second.host);
  assert.equal(incOutcome.unchanged, false);
  assert.deepEqual(second.log.states, [{ snapshot: incOutcome.snapshot, baselineAdditions: ['job_stop'] }]);
});

test('re-applying a recorded version with a desynchronized loadout resyncs live only', async () => {
  const recordedSnapshot = buildPresetSnapshot({
    name: 'fast', tools: ['read'], instructions: 'be terse', toolSelection: { kind: 'replace', names: ['read'] },
  });
  const { host: h, log } = host({ recorded: recordedSnapshot, inSync: false, syncError: 'sdk setActiveTools failed' });
  const outcome = await applyPresetPlan(
    plan({ name: 'fast', tools: ['read'], instructions: 'be terse' }),
    noIssues,
    h,
  );
  assert.equal(outcome.unchanged, false, 'an explicit retry never swallows a desynchronized loadout');
  assert.deepEqual(log.states, [], 'no duplicate record');
  assert.equal(log.syncs, 1);
  assert.equal(outcome.problems[0]?.kind, 'tool_sync_failed');
});

test('a loadout sync failure is reported on the durable outcome, not thrown', async () => {
  const { host: h, log } = host({ syncError: 'capability scope parent chain contains a cycle' });
  const outcome = await applyPresetPlan(basePlan, noIssues, h);
  assert.equal(outcome.applied, true, 'the durable record stays authoritative');
  assert.equal(log.states[0]?.snapshot?.contentHash, basePlan.contentHash);
  assert.deepEqual(log.order.slice(-2), ['state', 'sync']);
  assert.equal(outcome.problems[0]?.kind, 'tool_sync_failed');
});

test('a preset exclusion kept by the manual layer is reported as a warning', async () => {
  const { host: h } = host({ retained: ['edit'] });
  const outcome = await applyPresetPlan(basePlan, noIssues, h);
  assert.equal(outcome.applied, true);
  assert.deepEqual(outcome.problems, [{
    severity: 'warning',
    kind: 'tool_retained_by_branch',
    retainedTools: ['edit'],
    detail: 'edit stayed available: the manual /capability base layer keeps them; '
      + 'remove that membership to let the preset exclude them.',
  }]);
});

test('clear withdraws once, repairs desynchronized cleared branches, and reports sync failures', () => {
  const active = host({ recorded: plan({ name: 'fast', instructions: null }) });
  assert.deepEqual(clearActivePreset(active.host), { cleared: true, snapshot: null, toolSyncError: null });
  assert.deepEqual(active.log.states, [{ snapshot: null }]);
  assert.deepEqual(active.log.order, ['state', 'sync']);

  const idle = host({ recorded: null, inSync: true });
  assert.deepEqual(clearActivePreset(idle.host), { cleared: true, snapshot: null, toolSyncError: null });
  assert.deepEqual(idle.log.order, []);

  const repair = host({ recorded: null, inSync: false });
  assert.deepEqual(clearActivePreset(repair.host), { cleared: true, snapshot: null, toolSyncError: null });
  assert.deepEqual(repair.log.states, []);
  assert.equal(repair.log.syncs, 1);

  const failed = host({ recorded: plan({ name: 'fast', instructions: null }), syncError: 'sdk setActiveTools failed' });
  assert.deepEqual(clearActivePreset(failed.host), {
    cleared: true, snapshot: null, toolSyncError: 'sdk setActiveTools failed',
  });
  assert.deepEqual(failed.log.states, [{ snapshot: null }]);
  assert.deepEqual(failed.log.order, ['state', 'sync']);
});

// ---- applyPresetToSession ordering, baseline capture & real interleaving guards ----

interface FakeSession {
  readonly host: PresetSessionHost;
  branch: unknown[];
  readonly calls: { setActiveTools: string[][]; setModel: string[] };
  readonly active: () => readonly string[];
}

function sessionHost(options: {
  tools?: readonly string[];
  active?: readonly string[];
  models?: readonly string[];
  onSetModel?: (branch: unknown[], swap: (next: unknown[]) => void) => void;
  assertSession?: () => string | null;
} = {}): FakeSession {
  let branch: unknown[] = [];
  const tools = options.tools ?? ['read', 'bash', 'edit', 'write'];
  let active = [...(options.active ?? ['read', 'bash'])];
  const models = new Set(options.models ?? []);
  const calls = { setActiveTools: [] as string[][], setModel: [] as string[] };
  const pi = {
    getAllTools: () => tools.map((name) => ({ name, parameters: {} })),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      calls.setActiveTools.push([...names]);
      active = [...names];
    },
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ type: 'custom', customType, data, id: `e${branch.length}` });
    },
    setModel: async (model: { provider: string; id: string }) => {
      calls.setModel.push(`${model.provider}/${model.id}`);
      options.onSetModel?.(branch, (next) => { branch = next; });
      return true;
    },
    setThinkingLevel: () => {},
  } as unknown as ExtensionAPI;
  const value: PresetSessionHost = {
    pi,
    getBranch: () => branch,
    modelRegistry: { find: (provider, id) => (models.has(`${provider}/${id}`) ? { provider, id } as never : undefined) },
    ...(options.assertSession === undefined ? {} : { assertSession: options.assertSession }),
  };
  return {
    host: value,
    get branch() { return branch; },
    set branch(next: unknown[]) { branch = next; },
    calls,
    active: () => active,
  };
}

const recordTypes = (branch: readonly unknown[]): string[] =>
  branch.map((entry) => (entry as { customType?: string }).customType ?? (entry as { type?: string }).type ?? 'other');

test('applyPresetToSession refuses version mismatch and unresolvable preset before baseline capture', async () => {
  const mismatch = sessionHost();
  const m = await applyPresetToSession(mismatch.host, 'fast', { tools: ['+write'] }, { expectedVersion: 'stale' });
  assert.equal(m.applied, false);
  assert.equal(m.problems[0]?.kind, 'version_mismatch');
  assert.deepEqual(mismatch.branch, []);
  assert.deepEqual(mismatch.calls.setActiveTools, []);

  const invalid = sessionHost();
  const inv = await applyPresetToSession(invalid.host, 'bad', { model: { provider: 'p', id: 'missing' }, tools: ['+write'] });
  assert.equal(inv.applied, false);
  assert.ok(inv.issues.some((issue) => issue.kind === 'unknown_model'));
  assert.deepEqual(invalid.branch, []);
});

test('applyPresetToSession captures baseline once with Harness defaults and honours explicit empty baseline', async () => {
  const fresh = sessionHost({ tools: ['read', 'bash', 'edit', 'write', 'job_stop'] });
  const outcome = await applyPresetToSession(fresh.host, 'fast', { tools: ['+write'] });
  assert.equal(outcome.applied, true);
  assert.deepEqual(recordTypes(fresh.branch), ['capability-tool-base', PRESET_STATE_RECORD]);
  assert.deepEqual(outcome.snapshot?.tools, ['read', 'bash', 'job_stop', 'write']);
  assert.ok(fresh.active().includes('write'));
  assert.equal(fresh.calls.setActiveTools.length, 1);

  const again = await applyPresetToSession(fresh.host, 'fast', { tools: ['+write'] }, {
    expectedVersion: outcome.snapshot!.contentHash,
  });
  assert.equal(again.applied, true);
  assert.equal(again.unchanged, true);
  assert.equal(fresh.branch.length, 2, 'no second capture or duplicate preset record');
  assert.equal(fresh.calls.setActiveTools.length, 1);

  const empty = sessionHost({ tools: ['read', 'bash', 'write'], active: ['read', 'bash'] });
  empty.branch.push({ type: 'custom', customType: 'capability-tool-base', data: { version: 1, baseline: [], load: [] }, id: 'base' });
  const emptyOutcome = await applyPresetToSession(empty.host, 'fast', { tools: ['+write'] });
  assert.equal(emptyOutcome.applied, true);
  assert.deepEqual(recordTypes(empty.branch), ['capability-tool-base', PRESET_STATE_RECORD]);
  assert.deepEqual(emptyOutcome.snapshot?.tools, ['write']);
});

test('applyPresetToSession allows model/thinking side-effects during setModel but rejects branch drift or caller mismatch', async () => {
  const normal = sessionHost({
    models: ['p/m'],
    onSetModel: (branch) => {
      branch.push({ type: 'model_change', id: 'mc1' }, { type: 'thinking_level_change', id: 'tc1' });
    },
  });
  const ok = await applyPresetToSession(normal.host, 'fast', { model: { provider: 'p', id: 'm' }, tools: ['+write'] });
  assert.equal(ok.applied, true);
  assert.equal(recordTypes(normal.branch).at(-1), PRESET_STATE_RECORD);

  const concurrent = sessionHost({
    models: ['p/m'],
    onSetModel: (branch) => {
      branch.push({ type: 'model_change', id: 'mc1' }, { type: 'custom', customType: 'other', id: 'c1', data: {} });
    },
  });
  const blocked = await applyPresetToSession(concurrent.host, 'fast', { model: { provider: 'p', id: 'm' } });
  assert.equal(blocked.applied, false);
  assert.equal(blocked.problems[0]?.kind, 'context_changed');
  assert.ok(!recordTypes(concurrent.branch).includes(PRESET_STATE_RECORD));

  const switched = sessionHost({
    models: ['p/m'],
    onSetModel: (_branch, swap) => {
      swap([{ type: 'message', id: 'other-branch-leaf' }]);
    },
  });
  const sw = await applyPresetToSession(switched.host, 'fast', { model: { provider: 'p', id: 'm' } });
  assert.equal(sw.applied, false);
  assert.equal(sw.problems[0]?.kind, 'context_changed');
  assert.ok(!recordTypes(switched.branch).includes(PRESET_STATE_RECORD));

  let activeSession = true;
  const retired = sessionHost({
    models: ['p/m'],
    onSetModel: () => { activeSession = false; },
    assertSession: () => (activeSession ? null : 'session rpc-1 is no longer active'),
  });
  const ret = await applyPresetToSession(retired.host, 'fast', { model: { provider: 'p', id: 'm' } });
  assert.equal(ret.applied, false);
  assert.equal(ret.problems[0]?.kind, 'context_changed');
  assert.equal(ret.problems[0]?.detail, 'session rpc-1 is no longer active');
  assert.deepEqual(retired.branch, []);
});
