/**
 * Parent-hold contracts owned by the Runtime.
 *
 * A parent keeps one live Job while it has nonterminal direct children. These
 * tests drive the Runtime's own request callbacks, so they do not depend on the
 * Native runner's drain loop: pause/resume accounting, direct-child topology,
 * and the terminal-notice-before-wake ordering are all Runtime contracts.
 */

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { createSubagentRuntime, SubagentError, type JobRequest } from '../../src/subagent/runtime.ts';
import { profileForDepth } from '../../src/subagent/job-budget.ts';

interface FakeHandle {
  request: JobRequest;
  done: Promise<unknown>;
  resolve(value: unknown): void;
}

function adapter() {
  const started: FakeHandle[] = [];
  let cancels = 0;
  return {
    started,
    startJob(request: JobRequest): { done: Promise<unknown>; cancel(): void } {
      let resolve!: (value: unknown) => void;
      const done = new Promise<unknown>((accept) => { resolve = accept; });
      started.push({ request, done, resolve });
      return { done, cancel() { cancels += 1; } };
    },
    get cancels(): number {
      return cancels;
    },
  };
}

function handleFor(fake: ReturnType<typeof adapter>, jobId: string): FakeHandle {
  const handle = fake.started.find((entry) => entry.request.jobId === jobId);
  assert.ok(handle, `job ${jobId} was never started`);
  return handle;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function clock(t: TestContext) {
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => now);
  return {
    /** Move both the wall clock and due timers. */
    advance(ms: number) {
      now += ms;
      t.mock.timers.tick(ms);
    },
    /** Move only the wall clock, leaving due timers undelivered. */
    jump(ms: number) {
      now += ms;
    },
  };
}

test('hasActiveChildren follows direct nonterminal topology and counts finalizing', async () => {
  const fake = adapter();
  const entered = deferred();
  const gate = deferred();
  const runtime = createSubagentRuntime({
    startJob: fake.startJob,
    async finalizeJob() {
      entered.resolve();
      await gate.promise;
    },
  });
  const root = runtime.create({ tasks: [{ task: 'root' }] }).items[0]!;
  const child = runtime.create({ tasks: [{ task: 'child' }] }, { parentAgentId: root.id }).items[0]!;
  const otherRoot = runtime.create({ tasks: [{ task: 'other root' }] }).items[0]!;
  const otherChild = runtime.create({ tasks: [{ task: 'other child' }] }, { parentAgentId: otherRoot.id }).items[0]!;

  assert.equal(runtime.hasActiveChildren('sub_99'), false);
  assert.equal(runtime.hasActiveChildren(root.id), true);
  assert.equal(runtime.hasActiveChildren(otherRoot.id), true);

  handleFor(fake, child.id).resolve({ status: 'completed' });
  await entered.promise;
  assert.equal(runtime.jobs({ jobIds: [child.id] }).jobs[0]?.status, 'finalizing');
  assert.equal(runtime.hasActiveChildren(root.id), true, 'finalizing still occupies the direct-child slot');

  gate.resolve();
  await runtime.jobDone(child.id);
  assert.equal(runtime.hasActiveChildren(root.id), false, 'the direct child is truly terminal');
  assert.equal(runtime.hasActiveChildren(otherRoot.id), true, 'another parent keeps its own direct child');

  handleFor(fake, otherChild.id).resolve({ status: 'completed' });
  await runtime.jobDone(otherChild.id);
  assert.equal(runtime.hasActiveChildren(otherRoot.id), false);
  assert.equal(runtime.hasActiveChildren(root.id), false);
});

test('pauseActive freezes active time and resumeActive rearms the active deadline', async (t) => {
  const time = clock(t);
  const fake = adapter();
  const runtime = createSubagentRuntime({ startJob: fake.startJob });
  const item = runtime.create({ tasks: [{ task: 'wait for children' }] }).items[0]!;
  const request = handleFor(fake, item.id).request;
  const profile = profileForDepth(1);

  time.advance(profile.activeTimeMs.hard - 1);
  request.pauseActive();
  assert.equal(request.budget.snapshot().running, false);
  assert.equal(request.budget.snapshot().activeTimeMs, profile.activeTimeMs.hard - 1);

  time.advance(10 * 60_000);
  assert.equal(request.budget.snapshot().activeTimeMs, profile.activeTimeMs.hard - 1, 'paused time is not charged');
  assert.equal(runtime.jobs({ jobIds: [item.id] }).jobs[0]?.status, 'running');
  assert.equal(fake.cancels, 0);

  request.resumeActive();
  assert.equal(request.budget.snapshot().running, true);
  time.advance(1);
  assert.equal(fake.cancels, 1, 'resume restored the pending active-time deadline');
  const stopping = runtime.jobs({ jobIds: [item.id] }).jobs[0];
  assert.equal(stopping?.status, 'stopping');
  assert.equal(stopping?.stopping, 'failed');

  handleFor(fake, item.id).resolve({ status: 'cancelled' });
  const terminal = await runtime.jobDone(item.id);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error?.code, 'budget_exceeded');
});

test('paused active time still consumes the lifetime lease', async (t) => {
  const time = clock(t);
  const fake = adapter();
  const runtime = createSubagentRuntime({ startJob: fake.startJob });
  const item = runtime.create({ tasks: [{ task: 'wait for children' }] }).items[0]!;
  const request = handleFor(fake, item.id).request;
  const profile = profileForDepth(1);

  request.pauseActive();
  time.advance(profile.lifetimeMs - 1);
  assert.equal(request.budget.snapshot().activeTimeMs, 0);
  assert.equal(runtime.jobs({ jobIds: [item.id] }).jobs[0]?.status, 'running');

  request.resumeActive();
  time.advance(1);
  assert.equal(fake.cancels, 1, 'the lifetime lease kept running while active time was paused');

  handleFor(fake, item.id).resolve({ status: 'completed' });
  const terminal = await runtime.jobDone(item.id);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error?.code, 'job_expired');
});

test('resumeActive refuses a stopping job and preserves the first stop cause', async () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({ startJob: fake.startJob });
  const item = runtime.create({ tasks: [{ task: 'wait for children' }] }).items[0]!;
  const request = handleFor(fake, item.id).request;

  request.pauseActive();
  assert.equal(runtime.cancelJob(item.id).ok, true);
  assert.throws(
    () => request.resumeActive(),
    (error: unknown) => error instanceof SubagentError && error.code === 'cancelled',
  );
  const stopping = runtime.jobs({ jobIds: [item.id] }).jobs[0];
  assert.equal(stopping?.status, 'stopping');
  assert.equal(stopping?.stopping, 'cancelled');

  handleFor(fake, item.id).resolve({ status: 'completed' });
  const terminal = await runtime.jobDone(item.id);
  assert.equal(terminal.status, 'cancelled', 'explicit cancellation still wins over the late adapter report');
});

test('resumeActive turns a silently expired lifetime into the failed stop cause', async (t) => {
  const time = clock(t);
  const fake = adapter();
  const runtime = createSubagentRuntime({ startJob: fake.startJob });
  const item = runtime.create({ tasks: [{ task: 'wait for children' }] }).items[0]!;
  const request = handleFor(fake, item.id).request;

  request.pauseActive();
  // The clock passes the lease before the queued timer callback is delivered.
  time.jump(profileForDepth(1).lifetimeMs);
  assert.throws(
    () => request.resumeActive(),
    (error: unknown) => error instanceof SubagentError && error.code === 'job_expired',
  );
  const stopping = runtime.jobs({ jobIds: [item.id] }).jobs[0];
  assert.equal(stopping?.status, 'stopping');
  assert.equal(stopping?.stopping, 'failed');

  handleFor(fake, item.id).resolve({ status: 'completed' });
  const terminal = await runtime.jobDone(item.id);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error?.code, 'job_expired');
});

test('onChildrenSettled fires once after the last direct child notice is attempted', async () => {
  const fake = adapter();
  const log: string[] = [];
  let deliveries = 0;
  const runtime = createSubagentRuntime({
    startJob: fake.startJob,
    deliverMessage: () => {
      deliveries += 1;
      log.push(`deliver:${deliveries}`);
      return { accepted: true };
    },
    onChildrenSettled: (parentId) => {
      log.push(`wake:${parentId}:${deliveries}`);
    },
  });
  const parent = runtime.create({ tasks: [{ task: 'parent' }] }).items[0]!;
  const first = runtime.create({ tasks: [{ task: 'first' }] }, { parentAgentId: parent.id }).items[0]!;
  const second = runtime.create({ tasks: [{ task: 'second' }] }, { parentAgentId: parent.id }).items[0]!;

  handleFor(fake, first.id).resolve({ status: 'completed', result: 'first' });
  await runtime.jobDone(first.id);
  assert.deepEqual(log, ['deliver:1'], 'a live sibling suppresses the wake');
  assert.equal(runtime.jobs({ jobIds: [parent.id] }).jobs[0]?.status, 'running');

  handleFor(fake, second.id).resolve({ status: 'completed', result: 'second' });
  await runtime.jobDone(second.id);
  assert.deepEqual(log, ['deliver:1', 'deliver:2', `wake:${parent.id}:2`], 'the notice precedes the wake');
  assert.equal(runtime.jobs().jobs.length, 3, 'the wake does not create a continuation Job');
});

test('onChildrenSettled wakes even without a delivery handler or when delivery fails', async () => {
  const clean = adapter();
  const cleanWakes: string[] = [];
  const cleanRuntime = createSubagentRuntime({
    startJob: clean.startJob,
    onChildrenSettled: (parentId) => { cleanWakes.push(parentId); },
  });
  const cleanParent = cleanRuntime.create({ tasks: [{ task: 'parent' }] }).items[0]!;
  const cleanChild = cleanRuntime.create({ tasks: [{ task: 'child' }] }, { parentAgentId: cleanParent.id }).items[0]!;
  handleFor(clean, cleanChild.id).resolve({ status: 'completed' });
  const cleanTerminal = await cleanRuntime.jobDone(cleanChild.id);
  assert.equal(cleanTerminal.status, 'completed');
  assert.deepEqual(cleanWakes, [cleanParent.id]);

  const failing = adapter();
  const failingWakes: string[] = [];
  const failingRuntime = createSubagentRuntime({
    startJob: failing.startJob,
    deliverMessage: () => {
      throw new Error('no route');
    },
    onChildrenSettled: (parentId) => { failingWakes.push(parentId); },
  });
  const failingParent = failingRuntime.create({ tasks: [{ task: 'parent' }] }).items[0]!;
  const failingChild = failingRuntime.create({ tasks: [{ task: 'child' }] }, { parentAgentId: failingParent.id }).items[0]!;
  handleFor(failing, failingChild.id).resolve({ status: 'completed' });
  const failingTerminal = await failingRuntime.jobDone(failingChild.id);
  assert.equal(failingTerminal.status, 'completed', 'a delivery failure never rewrites the child outcome');
  assert.deepEqual(failingWakes, [failingParent.id]);
});

test('explicit msg_write remains the only revival path', async () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({ startJob: fake.startJob });
  const root = runtime.create({ tasks: [{ task: 'root' }] }).items[0]!;
  const child = runtime.create({ tasks: [{ task: 'child' }] }, { parentAgentId: root.id }).items[0]!;

  handleFor(fake, child.id).resolve({ status: 'completed' });
  await runtime.jobDone(child.id);
  assert.equal('reviveWithNotification' in runtime, false);
  assert.equal(fake.started.length, 2);

  const receipt = await runtime.sendMessage({ from: 'Main', to: child.id, content: 'continue' });
  assert.ok('jobId' in receipt);
  assert.equal(receipt.jobId, `${child.id}#r2`);
  assert.equal(fake.started.length, 3);

  const continuation = handleFor(fake, `${child.id}#r2`);
  assert.equal(continuation.request.continuedFromJobId, child.id);
  assert.equal(continuation.request.spec.kind, 'continuation');
  assert.equal(continuation.request.pendingMessages.length, 1);
});

test('a cancelled parent may keep active children without repairing the topology', async () => {
  const fake = adapter();
  const wakes: string[] = [];
  const runtime = createSubagentRuntime({
    startJob: fake.startJob,
    onChildrenSettled: (parentId) => { wakes.push(parentId); },
  });
  const root = runtime.create({ tasks: [{ task: 'root' }] }).items[0]!;
  const child = runtime.create({ tasks: [{ task: 'child' }] }, { parentAgentId: root.id }).items[0]!;

  runtime.cancelJob(root.id);
  handleFor(fake, root.id).resolve({ status: 'completed' });
  const terminal = await runtime.jobDone(root.id);
  assert.equal(terminal.status, 'cancelled');

  assert.equal(runtime.list({ id: root.id }).agents[0]?.status, 'idle');
  assert.equal(runtime.hasActiveChildren(root.id), true, 'stopping a parent does not stop its children');
  assert.deepEqual(wakes, []);
  assert.equal(runtime.jobs({ jobIds: [child.id] }).jobs[0]?.status, 'running');

  handleFor(fake, child.id).resolve({ status: 'completed' });
  await runtime.jobDone(child.id);
  assert.deepEqual(wakes, [root.id], 'the settled child still wakes its cancelled parent');
  assert.equal(runtime.hasActiveChildren(root.id), false);
});
