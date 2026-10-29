import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeDeliveryRouter, type NativeDeliveryDeps } from '../../src/subagent/native-delivery.ts';
import { createSubagentRuntime } from '../../src/subagent/runtime.ts';
import type { TerminalNotification } from '../../src/subagent/lifecycle.ts';

const notice: TerminalNotification = { type: 'notification', from: 'sub_01', subagentId: 'sub_01', jobId: 'sub_01#r2', round: 2,
  status: 'completed', content: 'Job completed', error: null, history: null };

function deps(overrides: Partial<NativeDeliveryDeps> = {}): NativeDeliveryDeps {
  return {
    runtime: { reviveWithNotification: () => ({ woken: false, reason: 'running' }) },
    runner: { handoff: async () => ({ accepted: true, mode: 'steered' }), handoffCustom: async () => ({ accepted: true, mode: 'steered' }) },
    ownsContext: () => true, canWake: () => true,
    sendToMain() {}, appendRetained: async () => true, onError() {}, ...overrides,
  };
}

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

test('root quiescence stores notice without reviving child or triggering Main model', async () => {
  let wakeCalls = 0;
  let rootTriggered: boolean | undefined;
  let retained = 0;
  const router = new NativeDeliveryRouter(deps({
    canWake: () => false,
    runtime: { reviveWithNotification: () => { wakeCalls += 1; return { woken: true, jobId: 'forbidden' }; } },
    sendToMain: (_entry, trigger) => { rootTriggered = trigger; },
    appendRetained: async () => { retained += 1; return true; },
  }));
  await router.toMain(notice);
  await router.toAgent({ agentId: 'sub_02', jobId: null, message: notice });
  assert.equal(rootTriggered, false);
  assert.equal(wakeCalls, 0);
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
