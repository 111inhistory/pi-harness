import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeDeliveryRouter, type NativeDeliveryDeps } from '../../src/subagent/native-delivery.ts';
import type { NativeCustomHandoff } from '../../src/subagent/native-types.ts';
import { createSubagentRuntime } from '../../src/subagent/runtime.ts';
import type { TerminalNotification } from '../../src/subagent/lifecycle.ts';

const notice: TerminalNotification = { type: 'notification', from: 'sub_01', subagentId: 'sub_01', jobId: 'sub_01#r2', round: 2,
  status: 'completed', content: 'Job completed', error: null, history: null };
const cancelled: TerminalNotification = { ...notice, status: 'cancelled', content: 'partial' };
const failed: TerminalNotification = { ...notice, status: 'failed', content: '', error: 'provider failed' };

function deps(overrides: Partial<NativeDeliveryDeps> = {}): NativeDeliveryDeps {
  return {
    runner: { handoff: async () => ({ accepted: true, mode: 'steered' }), handoffCustom: async () => ({ accepted: true, mode: 'pending' }) },
    ownsContext: () => true, canWake: () => true,
    sendToMain() {}, appendRetained: async () => true, onError() {}, ...overrides,
  };
}

test('terminal notice is handed to the live parent job itself', async () => {
  const handed: Array<{ jobId: string; message: NativeCustomHandoff }> = [];
  const router = new NativeDeliveryRouter(deps({
    runner: { handoff: async () => ({ accepted: true, mode: 'steered' }),
      handoffCustom: async (jobId, message) => { handed.push({ jobId, message }); return { accepted: true, mode: 'pending' }; } },
    appendRetained: async () => { throw new Error('a live parent must not retain'); },
  }));
  assert.deepEqual(await router.toAgent({ agentId: 'sub_02', jobId: 'sub_02#r1', message: notice }),
    { accepted: true, mode: 'delivered' });
  assert.equal(handed.length, 1);
  assert.equal(handed[0]?.jobId, 'sub_02#r1');
  assert.equal(handed[0]?.message.from, 'sub_01');
  assert.equal((handed[0]?.message.details as { status: string }).status, 'completed');
});

test('late cancellation notice for a stopped parent is retained, never revived', async () => {
  let handoffs = 0;
  let retained: NativeCustomHandoff | undefined;
  const router = new NativeDeliveryRouter(deps({
    runner: { handoff: async () => ({ accepted: true, mode: 'steered' }),
      handoffCustom: async () => { handoffs += 1; return { accepted: false, reason: 'job_closed' }; } },
    appendRetained: async (_agentId, message) => { retained = message; return true; },
  }));
  assert.deepEqual(await router.toAgent({ agentId: 'sub_02', jobId: null, message: cancelled }),
    { accepted: true, mode: 'retained' });
  assert.equal(handoffs, 0);
  assert.ok(retained);
  assert.equal((retained.details as { status: string }).status, 'cancelled');
});

test('late failure notice for a stopping parent is retained once after the runner refuses', async () => {
  let handoffs = 0;
  let appends = 0;
  let retained: NativeCustomHandoff | undefined;
  const router = new NativeDeliveryRouter(deps({
    runner: { handoff: async () => ({ accepted: true, mode: 'steered' }),
      handoffCustom: async (jobId) => { handoffs += 1; assert.equal(jobId, 'sub_02#r1'); return { accepted: false, reason: 'job_closed' }; } },
    appendRetained: async (_agentId, message) => { appends += 1; retained = message; return true; },
  }));
  assert.deepEqual(await router.toAgent({ agentId: 'sub_02', jobId: 'sub_02#r1', message: failed }),
    { accepted: true, mode: 'retained' });
  assert.equal(handoffs, 1);
  assert.equal(appends, 1);
  assert.ok(retained);
  assert.equal((retained.details as { status: string }).status, 'failed');
});

test('a failed retained append is reported once and never replayed', async () => {
  const errors: Error[] = [];
  let appends = 0;
  const router = new NativeDeliveryRouter(deps({
    runner: { handoff: async () => ({ accepted: true, mode: 'steered' }), handoffCustom: async () => ({ accepted: false, reason: 'job_closed' }) },
    appendRetained: async () => { appends += 1; throw new Error('session unavailable'); },
    onError: (error) => errors.push(error),
  }));
  assert.deepEqual(await router.toAgent({ agentId: 'sub_02', jobId: null, message: failed }),
    { accepted: false, reason: 'retained_append_failed' });
  assert.equal(appends, 1);
  assert.match(errors[0]?.message ?? '', /session unavailable/);
});

test('terminal native queue rejection is observed and is not blindly appended twice', async () => {
  let appends = 0;
  const errors: Error[] = [];
  const router = new NativeDeliveryRouter(deps({
    runner: { handoff: async () => ({ accepted: true, mode: 'steered' }), handoffCustom: async () => { throw new Error('uncertain SDK failure'); } },
    appendRetained: async () => { appends += 1; return true; }, onError: (error) => errors.push(error),
  }));
  const result = await router.toAgent({ agentId: 'sub_02', jobId: 'sub_02', message: notice });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'delivery_uncertain');
  assert.equal(appends, 0);
  assert.match(errors[0]?.message ?? '', /uncertain SDK failure/);
});

test('definite closed-job refusal falls back to retained append once', async () => {
  let appends = 0;
  const router = new NativeDeliveryRouter(deps({
    runner: { handoff: async () => ({ accepted: false, reason: 'job_closed' }), handoffCustom: async () => ({ accepted: false, reason: 'job_closed' }) },
    appendRetained: async (_id, message) => { appends += 1; assert.equal(message.customType, 'agent-delivery'); return true; },
  }));
  assert.deepEqual(await router.toAgent({ agentId: 'sub_02', jobId: 'sub_02', message: notice }), { accepted: true, mode: 'retained' });
  assert.equal(appends, 1);
});

test('explicit messages keep the normal peer handoff', async () => {
  const handed: string[] = [];
  let customs = 0;
  const router = new NativeDeliveryRouter(deps({
    runner: { handoff: async (jobId) => { handed.push(jobId); return { accepted: true, mode: 'steered' }; },
      handoffCustom: async () => { customs += 1; return { accepted: true, mode: 'pending' }; } },
  }));
  assert.deepEqual(await router.toAgent({ agentId: 'sub_02', jobId: 'sub_02#r1', message: { type: 'message', from: 'Main', content: 'steer' } }),
    { accepted: true, mode: 'steered' });
  assert.deepEqual(await router.toAgent({ agentId: 'sub_02', jobId: null, message: { type: 'message', from: 'Main', content: 'late' } }),
    { accepted: false, reason: 'job_closed' });
  assert.deepEqual(handed, ['sub_02#r1']);
  assert.equal(customs, 0);
});

test('root quiescence retains a terminal notice without steering Main again', async () => {
  let rootTriggered: boolean | undefined;
  let retained = 0;
  let handoffs = 0;
  const router = new NativeDeliveryRouter(deps({
    canWake: () => false,
    runner: { handoff: async () => ({ accepted: true, mode: 'steered' }),
      handoffCustom: async () => { handoffs += 1; return { accepted: true, mode: 'pending' }; } },
    sendToMain: (_entry, trigger) => { rootTriggered = trigger; },
    appendRetained: async () => { retained += 1; return true; },
  }));
  await router.toMain(notice);
  await router.toAgent({ agentId: 'sub_02', jobId: null, message: notice });
  assert.equal(rootTriggered, false);
  assert.equal(handoffs, 0);
  assert.equal(retained, 1);
});

test('Main native handoff rejection propagates, not a synchronous accepted flag', async () => {
  const router = new NativeDeliveryRouter(deps({ sendToMain: async () => { throw new Error('Main queue rejected'); } }));
  await assert.rejects(router.toMain(notice), /Main queue rejected/);
});

test('Runtime does not retry an ambiguous live handoff exception', async () => {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  const runtime = createSubagentRuntime({ startJob: () => ({ done, cancel() {} }),
    deliverMessage: async () => { calls += 1; throw new Error('queue may already own the message'); } });
  const id = runtime.create({ tasks: [{ task: 'work' }] }).items[0]?.id;
  assert.ok(id);
  await assert.rejects(runtime.sendMessage({ from: 'Main', to: id, content: 'one event' }), /without a safe retry/);
  assert.equal(calls, 1);
  runtime.cancelJob(id);
  finish();
  await runtime.jobDone(id);
});
