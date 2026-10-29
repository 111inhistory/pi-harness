import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { sendDelivery, DELIVERY_CUSTOM_TYPE } from "../../src/subagent/delivery.ts";

import { createSubagentRuntime, SubagentError } from "../../src/subagent-runtime.mjs";
import {
  ServiceLifecycle,
  adjudicateTerminal,
  firstEffectiveStopping,
  takeQueuedMessages,
  terminalNotification,
} from "../../src/subagent/lifecycle.ts";
import type {
  LifecycleError,
  RetirableService,
  StoppingReason,
  TerminalNotification,
} from "../../src/subagent/lifecycle.ts";

interface FakeService extends RetirableService {
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

test("multilingual task batches are admitted and allocated atomically", () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({ startJob: fake.startJob });
  const items = runtime.create({
    context: "共享背景：保留中文、English and emoji 🙂",
    tasks: [
      { name: "中文任务", task: "检查配置文件" },
      { name: "english", task: "Inspect the configuration file" },
      { name: "emoji", task: "Verify 🙂 handling" },
    ],
  }).items as Array<{ id: string }>;
  assert.deepEqual(items.map((item) => item.id), ["sub_01", "sub_02", "sub_03"]);
  assert.equal(fake.started.length, 3);
  assert.equal(fake.started[0]!.request.spec.task, "检查配置文件");
});

test("terminal notifications cover completion, cancellation and failure with sender and round", async () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({
    startJob: fake.startJob,
    deliverToMain: fake.deliverToMain,
  });
  const [completed, cancelled, failed] = runtime.create({
    tasks: [{ task: "complete" }, { task: "cancel" }, { task: "fail" }],
  }).items as unknown as [{ id: string }, { id: string }, { id: string }];

  fake.handleFor(completed.id).resolve({ result: "done", messages: [] });
  runtime.stop(cancelled.id);
  fake.handleFor(cancelled.id).resolve({ result: "partial", messages: [] });
  fake.handleFor(failed.id).reject(new Error("provider failed"));

  await Promise.all([
    runtime.jobDone(completed.id),
    runtime.jobDone(cancelled.id),
    runtime.jobDone(failed.id),
  ]);

  assert.deepEqual(
    fake.mainMessages.map((message) => ({
      type: message.type,
      from: message.from,
      jobId: message.jobId,
      round: message.round,
      status: message.status,
    })),
    [
      { type: "notification", from: completed.id, jobId: completed.id, round: 1, status: "completed" },
      { type: "notification", from: cancelled.id, jobId: cancelled.id, round: 1, status: "cancelled" },
      { type: "notification", from: failed.id, jobId: failed.id, round: 1, status: "failed" },
    ],
  );
  assert.equal(fake.mainMessages[0].error, null);
  assert.match(fake.mainMessages[2].content, /provider failed/);

  // A continuation is a new execution round of the same sender; its terminal
  // event must not be mergeable with round one.
  const revived = (await runtime.sendMessage({ from: "Main", to: completed.id, content: "continue" })) as { jobId: string };
  fake.handleFor(revived.jobId).resolve({ result: "second", messages: [] });
  await runtime.jobDone(revived.jobId);
  const continuation = fake.mainMessages.at(-1) as TerminalNotification;
  assert.equal(continuation.from, completed.id);
  assert.equal(continuation.jobId, revived.jobId);
  assert.equal(continuation.round, 2);
  assert.equal(continuation.status, "completed");
});

test("a terminal notification wakes an idle parent through an ordinary continuation Job", async () => {
  const fake = adapter();
  let runtime: any;
  runtime = createSubagentRuntime({
    startJob: fake.startJob,
    // The extension adapter implements this same call; this fake keeps the
    // runtime-level continuation admission under test.
    deliverMessage: async ({ agentId, message }: any) => {
      runtime.reviveWithNotification(agentId, message);
      return { accepted: true };
    },
  });
  const parent = runtime.create({ tasks: [{ name: "parent", task: "coordinate" }] }).items[0] as { id: string };
  fake.handleFor(parent.id).resolve({ result: "parent idle", messages: [] });
  await runtime.jobDone(parent.id);

  const child = runtime.create({ tasks: [{ name: "child", task: "report" }] }, { parentAgentId: parent.id }).items[0] as { id: string };
  fake.handleFor(child.id).resolve({ result: "child done", messages: [] });
  await runtime.jobDone(child.id);

  const jobs = runtime.jobs().jobs;
  assert.equal(jobs.length, 3, "the notification creates one continuation Job, not a second orchestrator");
  const revived = jobs[2]!;
  assert.equal(revived.agentId, parent.id);
  assert.equal(revived.continuedFromJobId, parent.id);
  assert.equal(revived.status, "running");
  const request = fake.started.at(-1)!.request;
  assert.equal(request.pendingMessages.length, 1);
  assert.equal(request.pendingMessages[0].type, "notification");
  assert.equal(request.pendingMessages[0].from, child.id);
  assert.equal(request.pendingMessages[0].jobId, child.id);
  assert.equal(request.pendingMessages[0].round, 1);

  fake.handleFor(revived.jobId).resolve({ result: "parent resumed", messages: [] });
  await runtime.jobDone(revived.jobId);
  assert.equal(runtime.jobs({ jobIds: [revived.jobId] }).jobs[0]!.status, "completed");
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

test("a sibling revival does not steal the terminal notice from the direct parent", async () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({
    startJob: fake.startJob,
    deliverToMain: fake.deliverToMain,
    deliverMessage: fake.deliverMessage,
  });
  const [peer, revived] = runtime.create({
    tasks: [{ name: "peer", task: "wake sibling" }, { name: "sibling", task: "wait" }],
  }).items as unknown as [{ id: string }, { id: string }];
  fake.handleFor(peer.id).resolve({ result: "peer done", messages: [] });
  fake.handleFor(revived.id).resolve({ result: "sibling done", messages: [] });
  await Promise.all([runtime.jobDone(peer.id), runtime.jobDone(revived.id)]);

  const continuation = (await runtime.sendMessage({ from: peer.id, to: revived.id, content: "continue" })) as { jobId: string };
  fake.handleFor(continuation.jobId).resolve({ result: "sibling round two", messages: [] });
  await runtime.jobDone(continuation.jobId);

  const terminal = fake.mainMessages.find((message) => message.jobId === continuation.jobId);
  assert.ok(terminal, "the direct parent (Main) receives the continuation terminal notice");
  assert.equal(terminal.from, revived.id);
  assert.equal(terminal.round, 2);
  assert.equal(
    fake.deliveries.some((delivery) => delivery.agentId === peer.id && delivery.message?.type === "notification"),
    false,
    "the peer that triggered the continuation is not the notification owner",
  );
  assert.equal(runtime.jobs({ jobIds: [continuation.jobId] }).jobs[0]!.status, "completed");
});

test("parked messages retain independent native payloads and terminal metadata", () => {
  const sent: any[] = [];
  const options = { send: (entry: any) => { sent.push(entry); } };
  sendDelivery({ sourceId: "sub_child", round: 1, content: "PROGRESS_A" }, options);
  sendDelivery({ sourceId: "sub_child", round: 1, content: "PROGRESS_B" }, options);
  sendDelivery({ sourceId: "sub_child", round: 1, content: "TERMINAL_C",
    terminal: { status: "completed", details: { jobId: "sub_child#r1" } } }, options);
  const agent = new Agent({ streamFn: (() => { throw new Error("stream must not be called"); }) as never,
    steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" });
  for (const message of sent) agent.steer(message);
  const parked = takeQueuedMessages(agent, (queue) => ({ role: "user",
    content: [{ type: "text", text: `subagent-queue-probe-${queue}` }], timestamp: 0 }) as AgentMessage);
  assert.equal(parked.length, 3);
  assert.deepEqual(parked, sent);
  assert.equal((parked[0] as any).customType, DELIVERY_CUSTOM_TYPE);
  assert.equal((parked[0] as any).content, "PROGRESS_A");
  assert.equal((parked[2] as any).details.source, "host");
  assert.equal((parked[2] as any).details.status, "completed");
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

test("terminalNotification keeps host ownership of type, sender, Job and round", () => {
  const envelope = terminalNotification({
    agentId: "sub_01",
    jobId: "sub_01#r2",
    round: 2,
    name: "audit",
    status: "completed",
    content: "finished",
    error: null,
    history: { summary: "summary.md", cleanJsonl: "session.clean.jsonl" },
  });
  assert.deepEqual(envelope, {
    type: "notification",
    from: "sub_01",
    subagentId: "sub_01",
    jobId: "sub_01#r2",
    round: 2,
    name: "audit",
    status: "completed",
    content: "finished",
    error: null,
    history: { summary: "summary.md", cleanJsonl: "session.clean.jsonl" },
  });
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
      service.active = false;
    },
  });

  const first = await lifecycle.activate(async () => ({ id: 1, closed: false, active: true }));
  assert.equal(lifecycle.service, first);
  const firstRetirement = lifecycle.retire();
  assert.equal(lifecycle.retire(), firstRetirement, "concurrent retirement shares one operation");
  release();
  await firstRetirement;
  assert.equal(lifecycle.service, null);
  assert.equal(lifecycle.retiring, false);

  const second = await lifecycle.activate(async () => ({ id: 2, closed: false, active: true }));
  await lifecycle.activate(async () => ({ id: 3, closed: false, active: true }));
  // A stale callback carrying generation two cannot retire generation three.
  await lifecycle.retire(second);
  assert.equal((lifecycle.service as FakeService | null)?.id, 3);
  await lifecycle.retire();
  assert.deepEqual(retired, [1, 2, 3]);
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
      service.active = false;
      service.closed = true;
    },
  });

  const activation = lifecycle.activate(async () => {
    creationStarted();
    await creationGate;
    return { id: 10, closed: false, active: true };
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

  const next = await lifecycle.activate(async () => ({ id: 11, closed: false, active: true }));
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
      service.active = false;
      service.closed = true;
    },
  });
  await lifecycle.activate(async () => ({ id: 1, closed: false, active: true }));
  const [a, b] = await Promise.all([
    lifecycle.activate(async () => {
      builds += 1;
      return { id: 2, closed: false, active: true };
    }),
    lifecycle.activate(async () => {
      builds += 1;
      return { id: 3, closed: false, active: true };
    }),
  ]);
  assert.equal(a, b);
  assert.equal(builds, 1);
  assert.deepEqual(retired, [1]);
  assert.equal(lifecycle.generation, 2);
});

test("a frozen terminal outcome keeps its status when history finalization fails", async () => {
  const finalized: any[] = [];
  let releaseHistory!: () => void;
  const historyGate = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  const runtime = createSubagentRuntime({
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

  const actor = runtime.create({ tasks: [{ name: "frozen", task: "do work" }] }).items[0] as { id: string };
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
    startJob: () => ({
      done: Promise.reject(new SubagentError("native_failed", "native run failed")),
      cancel() {},
    }),
    finalizeJob: async () => {
      throw new Error("summary write failed");
    },
  });
  const actor = runtime.create({ tasks: [{ task: "fail" }] }).items[0] as { id: string };
  const terminal = await runtime.jobDone(actor.id);
  assert.equal(terminal.status, "failed");
  assert.ok(terminal.error);
  assert.equal(terminal.error.code, "native_failed");
  assert.equal(terminal.historyState, "error");
  assert.ok(terminal.historyError);
  assert.match(terminal.historyError.message, /summary write failed/);
});
