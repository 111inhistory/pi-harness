/**
 * Contract tests for the one delivery router.
 *
 * Only peer messages are model-visible now: a terminal Job state is an internal
 * wake owned by the runtime/root, so the router checks ownership and forwards
 * to Main or to the live native Job. It never synthesizes a result message.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeDeliveryRouter, type NativeDeliveryDeps } from '../../src/subagent/native-delivery.ts';
import type { NativePeerHandoff } from '../../src/subagent/native-types.ts';
import type { MessageEnvelope } from '../../src/subagent/runtime.ts';

const message: MessageEnvelope = { type: 'message', from: 'sub_01', content: 'child update' };

function deps(overrides: Partial<NativeDeliveryDeps> = {}): NativeDeliveryDeps {
  return {
    runner: { handoff: async () => ({ accepted: true, mode: 'steered' }) },
    ownsContext: () => true,
    canWake: () => true,
    sendToMain() {},
    activateReply() {},
    ...overrides,
  };
}

test('an external Main message activates the reply tool after the ownership check and before delivery', async () => {
  const order: string[] = [];
  const router = new NativeDeliveryRouter(deps({
    ownsContext: () => { order.push('owns'); return true; },
    activateReply: () => { order.push('activate'); },
    sendToMain: () => { order.push('send'); },
  }));
  await router.toMain({
    type: 'message', from: 'peer:main', content: 'peer ping',
    external: { sessionId: 'peer', sender: 'peer:main', replyTo: '/tmp/peer/main.sock' },
  });
  assert.deepEqual(order, ['owns', 'activate', 'send']);
});

test('a stale root neither activates the reply tool nor forwards the peer message', async () => {
  let activations = 0;
  let sends = 0;
  const router = new NativeDeliveryRouter(deps({
    ownsContext: () => false,
    activateReply: () => { activations += 1; },
    sendToMain: () => { sends += 1; },
  }));
  await assert.rejects(router.toMain({
    type: 'message', from: 'peer:main', content: 'peer ping',
    external: { sessionId: 'peer', sender: 'peer:main', replyTo: '/tmp/peer/main.sock' },
  }), /no longer owns this notification/);
  assert.equal(activations, 0);
  assert.equal(sends, 0);
});

test('a local child message does not activate the reply tool', async () => {
  let activations = 0;
  const router = new NativeDeliveryRouter(deps({ activateReply: () => { activations += 1; } }));
  await router.toMain(message);
  assert.equal(activations, 0);
});

test('a peer message is forwarded to the live native Job with its sender and Job id', async () => {
  const handed: Array<{ jobId: string; message: NativePeerHandoff }> = [];
  const router = new NativeDeliveryRouter(deps({
    runner: {
      handoff: async (jobId, handoff) => {
        handed.push({ jobId, message: handoff });
        return { accepted: true, mode: 'pending' };
      },
    },
  }));
  assert.deepEqual(await router.toAgent({ agentId: 'sub_02', jobId: 'sub_02#1', message }), {
    accepted: true, mode: 'pending',
  });
  assert.equal(handed.length, 1);
  assert.equal(handed[0]?.jobId, 'sub_02#1');
  assert.equal(handed[0]?.message.from, 'sub_01');
  assert.equal(handed[0]?.message.content, 'child update');
});

test('a retired root refuses the handoff without touching the runner', async () => {
  let calls = 0;
  const router = new NativeDeliveryRouter(deps({
    ownsContext: () => false,
    runner: { handoff: async () => { calls += 1; return { accepted: true, mode: 'steered' }; } },
  }));
  assert.deepEqual(await router.toAgent({ agentId: 'sub_02', jobId: 'sub_02#1', message }),
    { accepted: false, reason: 'runtime_retired' });
  assert.equal(calls, 0);
});

test('a parent without a live Job refuses the handoff as closed', async () => {
  let calls = 0;
  const router = new NativeDeliveryRouter(deps({
    runner: { handoff: async () => { calls += 1; return { accepted: true, mode: 'steered' }; } },
  }));
  assert.deepEqual(await router.toAgent({ agentId: 'sub_02', jobId: null, message }),
    { accepted: false, reason: 'job_closed' });
  assert.equal(calls, 0);
});
