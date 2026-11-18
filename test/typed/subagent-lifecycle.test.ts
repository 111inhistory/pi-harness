import { ServiceLifecycle } from '../../src/session/service-lifecycle.ts';
import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { sendDelivery, DELIVERY_CUSTOM_TYPE } from "../../src/subagent/delivery.ts";

import {
  createSubagentRuntime,
  SubagentError,
  type DeliverMessageRequest,
  type RuntimeEvent,
} from "../../src/subagent/runtime.ts";
import {
  adjudicateTerminal,
  firstEffectiveStopping,
  takeQueuedMessages,
} from "../../src/subagent/lifecycle.ts";
import type { LifecycleError, StoppingReason } from "../../src/subagent/lifecycle.ts";
import { formatAddress } from "../../src/subagent/address.ts";

const SESSION = "01a1deac";
const MAIN_ADDRESS = formatAddress(SESSION, "main");

interface FakeService {
  id: number;
  closed: boolean;
}

interface StartedJob {
  request: any;
  done: Promise<any>;
  resolve(value?: any): void;
  reject(error: unknown): void;
  cancelCount: number;
}

function adapter() {
  const started: StartedJob[] = [];
  const mainMessages: any[] = [];
  const startJob = (request: any): StartedJob => {
    let resolve!: (value?: any) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<any>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const handle: StartedJob = {
      request,
      done,
      resolve,
      reject,
      cancelCount: 0,
      cancel() {
        this.cancelCount += 1;
      },
    } as StartedJob;
    started.push(handle);
    return handle;
  };
  const deliveries: any[] = [];
  return {
    startJob,
    started,
    mainMessages,
    deliveries,
    deliverToMain: (message: any) => {
      mainMessages.push(message);
    },
    deliverMessage: async (request: any) => {
      deliveries.push(request);
      return { accepted: true };
    },
    handleFor(jobId: string): StartedJob {
      const handle = started.find((entry) => entry.request.jobId === jobId);
      assert.ok(handle, `job ${jobId} was never started`);
      return handle;
    },
  };
}

test("multilingual goal batches are admitted and allocated atomically", () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({ session: SESSION, startJob: fake.startJob });
  const created = runtime.create({
    context: "共享背景：保留中文、English and emoji 🙂",
    agents: [
      { name: "中文任务", goal: "检查配置文件" },
      { name: "english", goal: "Inspect the configuration file" },
      { name: "emoji", goal: "Verify 🙂 handling" },
    ],
  });
  const items = created.items as Array<{ id: string; address: string; goal: string }>;
  assert.deepEqual(items.map((item) => item.id), ["sub_1-1", "sub_1-2", "sub_1-3"]);
  assert.deepEqual(items.map((item) => item.address), [
    formatAddress(SESSION, "sub_1-1"),
    formatAddress(SESSION, "sub_1-2"),
    formatAddress(SESSION, "sub_1-3"),
  ]);
  assert.equal(fake.started.length, 3);
  assert.equal(fake.started[0]!.request.goal, "检查配置文件");
  assert.equal(fake.started[0]!.request.context, "共享背景：保留中文、English and emoji 🙂");
  assert.deepEqual(fake.started[0]!.request.roster.map((entry: { goal: string }) => entry.goal), [
    "检查配置文件", "Inspect the configuration file", "Verify 🙂 handling",
  ]);
  assert.deepEqual(created.roster.map((entry) => entry.name), ["中文任务", "english", "emoji"]);
});

test("each Job publishes exactly one terminal event and never an auto result message", async () => {
  const fake = adapter();
  const events: RuntimeEvent[] = [];
  const runtime = createSubagentRuntime({
    session: SESSION,
    startJob: fake.startJob,
    deliverToMain: fake.deliverToMain,
    deliverMessage: fake.deliverMessage,
    onEvent: (event) => { events.push(event); },
  });
  const [completed, cancelled, failed] = runtime.create({
    agents: [{ goal: "complete" }, { goal: "cancel" }, { goal: "fail" }],
  }).items as unknown as [{ id: string; address: string }, { id: string; address: string }, { id: string; address: string }];
  const ends = (): Array<{ jobId: string; agentId: string; status: string }> =>
    events.filter((event) => event.type === "job-end") as unknown as Array<{ jobId: string; agentId: string; status: string }>;

  fake.handleFor(completed.id).resolve({ result: "done", messages: [] });
  runtime.cancelJob(cancelled.id);
  fake.handleFor(cancelled.id).resolve({ result: "partial", messages: [] });
  fake.handleFor(failed.id).reject(new Error("provider failed"));

  await Promise.all([
    runtime.jobDone(completed.id),
    runtime.jobDone(cancelled.id),
    runtime.jobDone(failed.id),
  ]);

  assert.deepEqual(ends().map(({ jobId, status }) => ({ jobId, status })), [
    { jobId: completed.id, status: "completed" },
    { jobId: cancelled.id, status: "cancelled" },
    { jobId: failed.id, status: "failed" },
  ]);
  assert.deepEqual(fake.mainMessages, [], "Main receives no synthesized terminal message");
  assert.deepEqual(fake.deliveries, [], "a collaborator result is never auto-delivered as a message");

  // Read-only polls and repeated completion never republish the terminal event.
  runtime.listDetailed({}, { callerId: "main" });
  await runtime.jobDone(completed.id);
  assert.equal(ends().length, 3);

  // A continuation is a new Job of the same Actor with its own single terminal.
  const revived = await runtime.sendMessage({ from: MAIN_ADDRESS, to: completed.address, content: "continue" });
  assert.ok("jobId" in revived && revived.jobId);
  fake.handleFor(revived.jobId).resolve({ result: "second", messages: [] });
  await runtime.jobDone(revived.jobId);
  const continuation = ends().at(-1);
  assert.equal(continuation?.jobId, revived.jobId);
  assert.equal(continuation?.status, "completed");
  const continuationRegistration = events.find((event) => event.type === "job" && event.jobId === revived.jobId);
  assert.ok(continuationRegistration && continuationRegistration.type === "job");
  assert.equal(continuationRegistration.agentId, completed.id);
  assert.equal(ends().length, 4);
  assert.deepEqual(fake.mainMessages, []);
});

test("a stopped parent is not revived by a child settlement; an explicit message is", async () => {
  const fake = adapter();
  const notices: DeliverMessageRequest[] = [];
  const runtime = createSubagentRuntime({
    session: SESSION,
    startJob: fake.startJob,
    deliverMessage: async request => { notices.push(request); return { accepted: true }; },
  });
  const parent = runtime.create({ agents: [{ name: "parent", goal: "coordinate" }] }).items[0]!;
  const child = runtime.create({ agents: [{ name: "child", goal: "report" }] }, { parentAgentId: parent.id }).items[0]!;
  runtime.cancelJob(parent.id);
  fake.handleFor(parent.id).resolve({ result: "cancelled parent", messages: [] });
  await runtime.jobDone(parent.id);
  fake.handleFor(child.id).resolve({ result: "child done", messages: [] });
  await runtime.jobDone(child.id);
  assert.equal(runtime.jobs().jobs.length, 2);
  assert.deepEqual(notices, [], "child settlement is an internal wake, not a handoff");

  const revived = await runtime.sendMessage({ from: MAIN_ADDRESS, to: parent.address, content: "continue explicitly" });
  assert.ok("jobId" in revived && revived.jobId);
  assert.equal(runtime.jobs().jobs.length, 3);
  const request = fake.started.at(-1)!.request;
  assert.equal(request.pendingMessages.length, 1);
  assert.equal(request.pendingMessages[0].type, "message");
  assert.equal(request.pendingMessages[0].content, "continue explicitly");
  fake.handleFor(revived.jobId).resolve({ result: "parent resumed", messages: [] });
  await runtime.jobDone(revived.jobId);
});

test("real SDK queue extraction preserves two steering messages and a follow-up", () => {
  const agent = new Agent({
    // Queue inspection never dispatches a model request.
    streamFn: (() => { throw new Error("stream must not be called"); }) as never,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
  });
  const first = {
    role: "user",
    content: [{ type: "text", text: "STEER_ONE" }],
    timestamp: 1,
  } as AgentMessage;
  const second = {
    role: "custom",
    customType: "agent-delivery",
    content: "STEER_TWO_CUSTOM",
    display: true,
    details: { batchId: "b2" },
    timestamp: 2,
  } as unknown as AgentMessage;
  const followUp = {
    role: "user",
    content: [{ type: "text", text: "FOLLOW_UP" }],
    timestamp: 3,
  } as AgentMessage;
  agent.steer(first);
  agent.steer(second);
  agent.followUp(followUp);

  const taken = takeQueuedMessages(agent, (queue) => ({
    role: "user",
    content: [{ type: "text", text: `subagent-queue-probe-${queue}` }],
    timestamp: 0,
  }) as AgentMessage);

  assert.deepEqual(taken, [first, second, followUp]);
  assert.equal(agent.hasQueuedMessages(), false);
  assert.equal(agent.steeringMode, "one-at-a-time");
  assert.equal(agent.followUpMode, "one-at-a-time");

  // An empty steering queue is distinguishable because the probe makes the
  // steering queue selectable without dropping the real follow-up.
  const onlyFollowUp = {
    role: "user",
    content: [{ type: "text", text: "ONLY_FOLLOW_UP" }],
    timestamp: 4,
  } as AgentMessage;
  agent.followUp(onlyFollowUp);
  assert.deepEqual(takeQueuedMessages(agent, (queue) => ({
    role: "user",
    content: [{ type: "text", text: `subagent-queue-probe-${queue}` }],
    timestamp: 0,
  }) as AgentMessage), [onlyFollowUp]);
});

test("a sibling-triggered continuation delivers only to the target and notifies Main of nothing", async () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({
    session: SESSION,
    startJob: fake.startJob,
    deliverToMain: fake.deliverToMain,
    deliverMessage: fake.deliverMessage,
  });
  const [peer, revived] = runtime.create({
    agents: [{ name: "peer", goal: "wake sibling" }, { name: "sibling", goal: "wait" }],
  }).items as unknown as [{ id: string; address: string }, { id: string; address: string }];
  fake.handleFor(peer.id).resolve({ result: "peer done", messages: [] });
  fake.handleFor(revived.id).resolve({ result: "sibling done", messages: [] });
  await Promise.all([runtime.jobDone(peer.id), runtime.jobDone(revived.id)]);

  const continuation = (await runtime.sendMessage({ from: peer.address, to: revived.address, content: "continue" })) as { jobId: string };
  fake.handleFor(continuation.jobId).resolve({ result: "sibling round two", messages: [] });
  await runtime.jobDone(continuation.jobId);

  assert.deepEqual(fake.mainMessages, [], "the direct parent receives no synthesized terminal notice");
  assert.deepEqual(fake.deliveries, [], "the peer that triggered the continuation is not a notification owner");
  const request = fake.started.at(-1)!.request;
  assert.equal(request.agentId, revived.id);
  assert.equal(request.pendingMessages.length, 1);
  assert.equal(request.pendingMessages[0].content, "continue");
  assert.equal(runtime.jobs({ jobIds: [continuation.jobId] }).jobs[0]!.status, "completed");
});

test("parked peer deliveries retain independent native payloads", () => {
  const sent: any[] = [];
  const options = { send: (entry: any) => { sent.push(entry); } };
  sendDelivery({ sourceId: "sub_child", round: 1, content: "PROGRESS_A", jobId: "sub_child#r2" }, options);
  sendDelivery({ sourceId: "sub_child", round: 1, content: "PROGRESS_B" }, options);
  const agent = new Agent({ streamFn: (() => { throw new Error("stream must not be called"); }) as never,
    steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" });
  for (const message of sent) agent.steer(message);
  const parked = takeQueuedMessages(agent, (queue) => ({ role: "user",
    content: [{ type: "text", text: `subagent-queue-probe-${queue}` }], timestamp: 0 }) as AgentMessage);
  assert.equal(parked.length, 2);
  assert.deepEqual(parked, sent);
  assert.equal((parked[0] as any).customType, DELIVERY_CUSTOM_TYPE);
  assert.equal((parked[0] as any).content, "PROGRESS_A");
  assert.equal((parked[0] as any).details.sourceId, "sub_child");
  assert.equal((parked[0] as any).details.jobId, "sub_child#r2");
  assert.equal((parked[1] as any).details.jobId, undefined);
});

test("the first stopping reason survives later terminal observations", () => {
  const cancelled: StoppingReason = { status: "cancelled", error: { code: "cancelled", message: "Job cancelled." } };
  const budget: LifecycleError = { code: "budget_exceeded", message: "Job execution budget exhausted." };
  assert.equal(firstEffectiveStopping(cancelled, { status: "failed", error: budget }), cancelled);
  assert.deepEqual(firstEffectiveStopping(null, cancelled), cancelled);

  const decision = adjudicateTerminal({
    stopping: cancelled,
    budgetError: budget,
    executionError: { code: "job_failed", message: "model failed" },
    executionStatus: "failed",
  });
  assert.equal(decision.status, "cancelled");
  assert.equal(decision.error?.code, "cancelled");

  assert.deepEqual(
    adjudicateTerminal({ stopping: null, budgetError: budget, executionError: null, executionStatus: "completed" }),
    { status: "failed", error: budget },
  );
  assert.deepEqual(
    adjudicateTerminal({ stopping: null, budgetError: null, executionError: null, executionStatus: "cancelled" }),
    { status: "cancelled", error: { code: "cancelled", message: "Job cancelled." } },
  );
  assert.deepEqual(
    adjudicateTerminal({ stopping: null, budgetError: null, executionError: null, executionStatus: "completed" }),
    { status: "completed", error: null },
  );
});

test("service retirement is idempotent in flight and forgets a completed generation", async () => {
  const retired: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lifecycle = new ServiceLifecycle<FakeService>({
    async retire(service) {
      retired.push(service.id);
      if (service.id === 1) await gate;
      service.closed = true;
    },
  });

  const first = await lifecycle.activate(async () => ({ id: 1, closed: false }));
  assert.equal(lifecycle.service, first);
  const firstRetirement = lifecycle.retire();
  assert.equal(lifecycle.retire(), firstRetirement, "concurrent retirement shares one operation");
  release();
  await firstRetirement;
  assert.equal(lifecycle.service, null);
  assert.equal(lifecycle.retiring, false);

  // A replacement generation retires the previous one before it is published.
  await lifecycle.activate(async () => ({ id: 2, closed: false }));
  await lifecycle.activate(async () => ({ id: 3, closed: false }));
  assert.equal((lifecycle.service as FakeService | null)?.id, 3);
  await lifecycle.retire();
  assert.deepEqual(retired, [1, 2, 3]);
  assert.equal(lifecycle.service, null);
  assert.equal(lifecycle.retiring, false);
});

test("retirement during activation cleans up creation and allows a later activation", async () => {
  const retired: number[] = [];
  let releaseCreation!: () => void;
  const creationGate = new Promise<void>((resolve) => {
    releaseCreation = resolve;
  });
  let creationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    creationStarted = resolve;
  });
  const lifecycle = new ServiceLifecycle<FakeService>({
    async retire(service) {
      retired.push(service.id);
      service.closed = true;
    },
  });

  const activation = lifecycle.activate(async () => {
    creationStarted();
    await creationGate;
    return { id: 10, closed: false };
  });
  await started;
  const retirement = lifecycle.retire();

  // Retire is waiting for creation cleanup; activation must not publish the
  // service after shutdown, and the two operations must not deadlock.
  releaseCreation();
  await assert.rejects(activation, /retired before it became current/);
  await retirement;
  assert.equal(lifecycle.service, null);
  assert.equal(lifecycle.retiring, false);
  assert.deepEqual(retired, [10], "the invalidated creation is cleaned up exactly once");

  const next = await lifecycle.activate(async () => ({ id: 11, closed: false }));
  assert.equal(next.id, 11);
  assert.equal((lifecycle.service as FakeService | null)?.id, 11);
  await lifecycle.retire();
  assert.deepEqual(retired, [10, 11], "a later activation is still allowed");
});

test("concurrent activation builds one service after retiring the previous generation", async () => {
  const retired: number[] = [];
  let builds = 0;
  const lifecycle = new ServiceLifecycle<FakeService>({
    retire(service) {
      retired.push(service.id);
      service.closed = true;
    },
  });
  await lifecycle.activate(async () => ({ id: 1, closed: false }));
  const [a, b] = await Promise.all([
    lifecycle.activate(async () => {
      builds += 1;
      return { id: 2, closed: false };
    }),
    lifecycle.activate(async () => {
      builds += 1;
      return { id: 3, closed: false };
    }),
  ]);
  assert.equal(a, b);
  assert.equal(builds, 1);
  assert.deepEqual(retired, [1]);
  assert.equal((lifecycle.service as FakeService | null)?.id, 2);
});

test("a frozen terminal outcome keeps its status when history finalization fails", async () => {
  const finalized: any[] = [];
  let releaseHistory!: () => void;
  const historyGate = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  const runtime = createSubagentRuntime({
    session: SESSION,
    startJob: () => ({
      done: Promise.resolve({ result: "work done", messages: [{ role: "assistant", content: [] }] }),
      cancel() {},
    }),
    async finalizeJob({ job, outcome }: any) {
      finalized.push({ jobId: job.jobId, status: outcome.status, round: outcome.round, result: outcome.result });
      await historyGate;
      throw new Error("history append failed");
    },
  });

  const actor = runtime.create({ agents: [{ name: "frozen", goal: "do work" }] }).items[0] as { id: string };
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = runtime.cancelJob(actor.id);
  assert.equal(stopping.ok, false);
  assert.equal(stopping.reason, "finalizing");
  releaseHistory();
  const terminal = await runtime.jobDone(actor.id);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.historyState, "error");
  assert.ok(terminal.historyError);
  assert.match(terminal.historyError.message, /history append failed/);
  assert.deepEqual(finalized, [{ jobId: actor.id, status: "completed", round: 1, result: "work done" }]);
  const completedJob = runtime.jobs({ jobIds: [actor.id] }).jobs[0];
  assert.ok(completedJob);
  assert.equal(completedJob.status, "completed");
});

test("execution failures keep cancellation as the frozen reason while history stays separate", async () => {
  const runtime = createSubagentRuntime({
    session: SESSION,
    startJob: () => ({
      done: Promise.reject(new SubagentError("native_failed", "native run failed")),
      cancel() {},
    }),
    finalizeJob: async () => {
      throw new Error("summary write failed");
    },
  });
  const actor = runtime.create({ agents: [{ goal: "fail" }] }).items[0] as { id: string };
  const terminal = await runtime.jobDone(actor.id);
  assert.equal(terminal.status, "failed");
  assert.ok(terminal.error);
  assert.equal(terminal.error.code, "native_failed");
  assert.equal(terminal.historyState, "error");
  assert.ok(terminal.historyError);
  assert.match(terminal.historyError.message, /summary write failed/);
});
