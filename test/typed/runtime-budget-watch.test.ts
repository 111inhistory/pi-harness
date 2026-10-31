import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createSubagentRuntime, type JobRequest } from '../../src/subagent/runtime.ts';
import { profileForDepth } from '../../src/subagent/job-budget.ts';

function clock(t: TestContext) {
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => now);
  return { advance(ms: number) { now += ms; t.mock.timers.tick(ms); } };
}
function adapter() {
  let resolve!: (outcome: unknown) => void;
  const done = new Promise<unknown>(accept => { resolve = accept; });
  let request: JobRequest | undefined;
  let cancels = 0;
  return {
    startJob(input: JobRequest) {
      request = input;
      // This adapter never calls request.checkBudget and has no deadline timer.
      return { done, cancel() { cancels++; } };
    },
    finish(outcome: unknown = { status: 'completed', result: 'done' }) { resolve(outcome); },
    get request() { assert.ok(request); return request; },
    get cancels() { return cancels; },
  };
}

test('Runtime stops a hung adapter at the active hard limit, before its lifetime deadline', async t => {
  const time = clock(t);
  const execution = adapter();
  const runtime = createSubagentRuntime({ startJob: input => execution.startJob(input) });
  const item = runtime.create({ tasks: [{ task: 'remain pending without model calls' }] }).items[0]!;
  const profile = profileForDepth(1);
  assert.ok(profile.activeTimeMs.hard < profile.lifetimeMs);
  time.advance(profile.activeTimeMs.hard - 1);
  assert.equal(execution.cancels, 0);
  assert.equal(runtime.jobs().jobs[0]?.status, 'running');
  time.advance(1);
  assert.equal(execution.cancels, 1, 'the runtime watcher must enforce active time without adapter observations');
  assert.equal(runtime.jobs().jobs[0]?.status, 'stopping');
  execution.finish({ status: 'cancelled' });
  const terminal = await runtime.jobDone(item.id);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error?.code, 'budget_exceeded');
  time.advance(profile.lifetimeMs * 2);
  assert.equal(execution.cancels, 1);
});

test('explicit cancellation removes the runtime deadline watch while the adapter is still stopping', async t => {
  const time = clock(t);
  const execution = adapter();
  const runtime = createSubagentRuntime({ startJob: input => execution.startJob(input) });
  const item = runtime.create({ tasks: [{ task: 'cancel before the deadline' }] }).items[0]!;
  const check = t.mock.method(execution.request.budget, 'check');
  runtime.cancelJob(item.id);
  assert.equal(execution.cancels, 1);
  const checksAfterCancel = check.mock.callCount();
  time.advance(profileForDepth(1).lifetimeMs * 2);
  assert.equal(check.mock.callCount(), checksAfterCancel, 'a stopping job has no scheduled budget observations');
  assert.equal(execution.cancels, 1);
  execution.finish({ status: 'failed', error: new Error('late adapter failure') });
  const terminal = await runtime.jobDone(item.id);
  assert.equal(terminal.status, 'cancelled', 'late errors and expired wall time cannot replace explicit cancellation');
  const checksAfterEnd = check.mock.callCount();
  time.advance(profileForDepth(1).lifetimeMs);
  assert.equal(check.mock.callCount(), checksAfterEnd);
  assert.equal(execution.cancels, 1);
});

test('normal finalization clears the runtime watch before a slow finalizer settles', async t => {
  const time = clock(t);
  const execution = adapter();
  let release!: () => void;
  let entered!: () => void;
  const finalizing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = createSubagentRuntime({
    startJob: input => execution.startJob(input),
    async finalizeJob() { entered(); await gate; },
  });
  const item = runtime.create({ tasks: [{ task: 'finish while result publication is delayed' }] }).items[0]!;
  const check = t.mock.method(execution.request.budget, 'check');
  execution.finish();
  await finalizing;
  assert.equal(runtime.jobs().jobs[0]?.status, 'finalizing');
  const checksAfterFinalize = check.mock.callCount();
  time.advance(profileForDepth(1).lifetimeMs * 2);
  assert.equal(check.mock.callCount(), checksAfterFinalize);
  assert.equal(execution.cancels, 0);
  release();
  const terminal = await runtime.jobDone(item.id);
  assert.equal(terminal.status, 'completed');
  time.advance(profileForDepth(1).lifetimeMs);
  assert.equal(execution.cancels, 0);
});
