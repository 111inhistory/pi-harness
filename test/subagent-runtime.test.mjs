import assert from "node:assert/strict";
import test from "node:test";

import {
  SubagentError,
  canonicalActorId,
  createSubagentRuntime as createRuntime,
} from "../src/subagent/runtime.ts";
import { getAgentSocketPath } from "../src/ipc/socket.ts";
import { foldEvents } from "../src/subagent/storage.ts";

const recordedEvents = new WeakMap();
function createSubagentRuntime(options) {
  const events = [];
  const onEvent = options.onEvent;
  const runtime = createRuntime({ ...options,
    ...(onEvent === undefined || typeof onEvent === "function" ? {
      onEvent(event) { events.push(event); onEvent?.(event); },
    } : {}),
  });
  recordedEvents.set(runtime, events);
  return runtime;
}
function stateOf(runtime) {
  return foldEvents(recordedEvents.get(runtime).map(({ type, ...data }) => ({
    type: "custom", customType: `subagent-${type}`, data: { v: 2, ...data },
  })));
}

const AGENT_ID_PATTERN = /^(sub_[0-9a-zA-Z_]+|agent_[0-9a-z]+-[0-9]+)$/;
const JOB_ID_PATTERN = /^(sub_[0-9a-zA-Z_]+(#r[0-9]+)?|job_[0-9a-z]+-[0-9]+)$/;
const TOKEN_PATTERN = /^(?:agent_([0-9a-z]+)-[0-9]+|sub_([0-9a-zA-Z_]+))$/;

function tokenOf(agentId) {
  const match = TOKEN_PATTERN.exec(agentId);
  assert.ok(match, `not an agent id: ${agentId}`);
  return match[1] || match[2];
}

// Deterministic stand-in for the Pi adapter: every started job is parked on a
// promise the test resolves by hand, so scheduling order is observable.
// `state.onDeliver` / `state.refuseDelivery` let a test decide how a live
// hand-over behaves, including one that races the end of the run.
function createFakeAdapter(options = {}) {
  const started = [];
  const deliveries = [];
  const mainMessages = [];
  const state = {
    refuseDelivery: options.refuseDelivery === true,
    mainDeliveryFails: options.mainDeliveryFails === true,
    onDeliver: null,
  };
  const handleFor = (jobId) => {
    const handle = started.find((entry) => entry.job.jobId === jobId);
    assert.ok(handle, `job ${jobId} was never started`);
    return handle;
  };
  const startJob = (request) => {
    const handle = { job: request, cancelled: false, cancelCount: 0 };
    handle.done = new Promise((resolve, reject) => {
      handle.settle = { resolve, reject };
    });
    handle.cancel = () => {
      handle.cancelled = true;
      handle.cancelCount += 1;
    };
    handle.resolve = (outcome) => handle.settle.resolve(outcome);
    handle.reject = (error) => handle.settle.reject(error);
    started.push(handle);
    return handle;
  };
  const deliverMessage = async ({ agentId, jobId, message }) => {
    deliveries.push({ agentId, jobId, message });
    if (typeof state.onDeliver === "function") {
      return state.onDeliver({ agentId, jobId, message, handle: started.find((entry) => entry.job.jobId === jobId) });
    }
    if (state.refuseDelivery) return { accepted: false, reason: "job_closed" };
    const handle = started.find((entry) => entry.job.jobId === jobId);
    if (handle === undefined || handle.cancelled) return { accepted: false, reason: "job_closed" };
    return { accepted: true, mode: "steered" };
  };
  const deliverToMain = async (message) => {
    mainMessages.push(message);
    if (state.mainDeliveryFails === true) throw new Error("main session unavailable");
  };
  return { startJob, deliverMessage, deliverToMain, started, deliveries, mainMessages, state, handleFor };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Deterministic clock for Budget observation: every Budget created while this
// helper is running reads `clock.now`, so a test can cross a hard time limit
// without waiting. The real clock is restored however `run` settles.
async function withFakeClock(run) {
  const clock = { now: 0 };
  Object.defineProperty(performance, "now", { configurable: true, writable: true, value: () => clock.now });
  try {
    return await run(clock);
  } finally {
    delete performance.now;
  }
}

function spec(name) {
  return { name, task: `do ${name}` };
}

test("rejects an invalid batch atomically and leaves no state behind", () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });

  assert.throws(
    () => runtime.create({ context: "batch", tasks: [spec("first"), { task: "later", inheritContext: "yes" }] }),
    (error) => error instanceof SubagentError && error.code === "invalid_task" && error.detail.index === 1,
  );
  assert.deepEqual(runtime.list(), { agents: [] });
  assert.deepEqual(runtime.jobs(), { jobs: [] });
  assert.equal(adapter.started.length, 0);

  const created = runtime.create({ tasks: [spec("first")] });
  assert.equal(created.items.length, 1);
  const [item] = created.items;
  assert.match(item.id, AGENT_ID_PATTERN);
  assert.deepEqual(item, { id: item.id, socket: getAgentSocketPath(item.id) });
  // A new actor's first Job shares its id; later continuations get their own.
  assert.deepEqual(runtime.jobs().jobs.map((job) => [job.jobId, job.name]), [[item.id, "first"]]);
  // A task assignment is exactly name/task/inheritContext: routing, roles and
  // tools are the adapter's job after the Job starts.
  assert.equal(adapter.started[0].job.spec.name, "first");
  assert.equal(adapter.started[0].job.spec.task, "do first");
  assert.equal(adapter.started[0].job.spec.inheritContext, false);
});

test("rejects malformed batches and every unknown task field", () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const failing = [
    [null, "invalid_batch"],
    [{ tasks: [] }, "invalid_batch"],
    [{ tasks: [{ task: "x" }], extra: true }, "invalid_batch"],
    [{ context: 7, tasks: [{ task: "x" }] }, "invalid_batch"],
    [{ tasks: ["not-an-object"] }, "invalid_task"],
    [{ tasks: [{ task: "  " }] }, "invalid_task"],
    [{ tasks: [{ task: "x", inheritContext: "yes" }] }, "invalid_task"],
    [{ tasks: [{ name: "  ", task: "x" }] }, "invalid_task"],
    [{ tasks: [{ task: "x", future: true }] }, "invalid_task"],
    // The removed task fields are not silently accepted, and not special-cased
    // either: they are unknown fields of the public task shape.
    [{ tasks: [{ task: "x", agent: "reviewer" }] }, "invalid_task"],
    [{ tasks: [{ task: "x", effort: "hi" }] }, "invalid_task"],
    [{ tasks: [{ task: "x", tools: ["read"] }] }, "invalid_task"],
    [{ tasks: [{ task: "x", outputSchema: { type: "object" } }] }, "invalid_task"],
    [{ tasks: [{ task: "x", schemaMode: "strict" }] }, "invalid_task"],
    [{ tasks: [{ task: "x", inheritContext: true, tools: ["read"] }] }, "invalid_task"],
  ];
  for (const [batch, code] of failing) {
    assert.throws(() => runtime.create(batch), (error) => error instanceof SubagentError && error.code === code, JSON.stringify(batch));
  }
  assert.deepEqual(runtime.list(), { agents: [] });
  assert.equal(adapter.started.length, 0);
});

test("registers entries in input order with distinct actor and Job IDs within a registry", () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });

  const first = runtime.create({ context: "shared background", tasks: [spec("a"), spec("b")] });
  assert.deepEqual(runtime.jobs().jobs.map((job) => [job.name, job.status]), [["a", "running"], ["b", "running"]]);
  const [a, b] = first.items;
  for (const item of first.items) {
    assert.match(item.id, AGENT_ID_PATTERN);
    assert.equal("status" in item, false);
    assert.deepEqual(runtime.jobs({ jobIds: [item.id] }).jobs.map((job) => job.jobId), [item.id]);
  }
  assert.notEqual(a.id, b.id);
  assert.equal(adapter.started[0].job.jobId, a.id);
  assert.equal(adapter.started[0].job.spec.task, "do a");
  assert.equal(adapter.started[0].job.spec.context, "shared background");

  const second = runtime.create({ tasks: [{ task: "third" }] }).items[0];
  assert.notEqual(second.id, a.id);
  assert.deepEqual(runtime.list().agents.map((agent) => agent.agentId), [a.id, b.id, second.id]);

  // Reject an actor/Job absent from this registry. Short IDs are session-scoped;
  // this assertion does not establish cross-session address isolation.
  const other = createSubagentRuntime({ startJob: createFakeAdapter().startJob });
  other.create({ tasks: [spec("a")] });
  assert.equal(other.jobRecord(b.id), null);
  assert.throws(() => other.cancelJob(b.id), (error) => error instanceof SubagentError && error.code === "unknown_job");
  assert.equal(canonicalActorId("agent_01"), null);
});

test("runs all twenty descendants concurrently while enforcing each parent's width", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const roots = runtime.create({ tasks: ["a", "b", "c", "d"].map(spec) }).items;
  const children = roots.flatMap((parent) => runtime.create({
    tasks: ["one", "two", "three", "four"].map(spec),
  }, { parentAgentId: parent.id }).items);
  const all = [...roots, ...children];
  assert.equal(adapter.started.length, 20);
  assert.ok(runtime.jobs().jobs.every((job) => job.status === "running"));
  assert.ok(adapter.started.every((handle) => handle.job.budget.snapshot().running));
  assert.throws(() => runtime.create({ tasks: [spec("fifth")] }), (error) => error.code === "child_limit_exceeded");
  for (const parent of roots) {
    assert.throws(() => runtime.create({ tasks: [spec("fifth")] }, { parentAgentId: parent.id }), (error) => error.code === "child_limit_exceeded");
  }
  for (const item of all) adapter.handleFor(item.id).resolve({ result: "done" });
  await Promise.all(all.map((item) => runtime.jobDone(item.id)));
  assert.ok(runtime.jobs().jobs.every((job) => job.status === "completed"));
  assert.ok(runtime.list().agents.every((agent) => agent.status === "idle"));
});

test("validates Fresh and inherited specs and snapshots the parent context once per batch", () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const snapshot = { systemPrompt: "parent prompt", tools: ["read"], entries: [] };
  let captures = 0;
  const parent = runtime.create({ tasks: [spec("parent")] }).items[0];

  const { items } = runtime.create(
    {
      context: "batch context",
      tasks: [
        { name: "fresh", task: "fresh work" },
        { name: "inherit-a", task: "inherited work", inheritContext: true },
        { name: "inherit-b", task: "more inherited work", inheritContext: true },
      ],
    },
    {
      parentAgentId: parent.id,
      captureInheritedContext: () => {
        captures += 1;
        return snapshot;
      },
    },
  );

  assert.equal(captures, 1);
  assert.ok(items.every((item) => !("status" in item)));

  const [fresh, inheritA, inheritB] = adapter.started.slice(1).map((handle) => handle.job.spec);
  assert.deepEqual(fresh, {
    name: "fresh",
    task: "fresh work",
    context: "batch context",
    inheritContext: false,
    inheritedContext: null,
  });
  assert.equal(inheritA.inheritContext, true);
  assert.equal(inheritA.task, "inherited work");
  // One capture instant, one copy per child: a session appending into its own
  // entries must never reach a sibling or the caller's snapshot.
  assert.notEqual(inheritA.inheritedContext, inheritB.inheritedContext);
  assert.notEqual(inheritA.inheritedContext, snapshot);
  assert.deepEqual(inheritA.inheritedContext, snapshot);
  assert.deepEqual(inheritB.inheritedContext, snapshot);
  assert.equal(adapter.started[1].job.parentAgentId, parent.id);
  assert.equal(adapter.started[1].job.depth, 2);
});

test("refuses inherited specs without a snapshot source and inside inherited sessions", () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });

  assert.throws(
    () => runtime.create({ tasks: [{ task: "x", inheritContext: true }] }),
    (error) => error instanceof SubagentError && error.code === "inherited_snapshot_unavailable",
  );
  assert.throws(
    () =>
      runtime.create(
        { tasks: [{ task: "x", inheritContext: true }] },
        {
          captureInheritedContext: () => {
            throw new Error("session is gone");
          },
        },
      ),
    (error) => error instanceof SubagentError && error.code === "inherited_snapshot_failed",
  );

  const inheritedSession = createSubagentRuntime({ startJob: adapter.startJob, allowInherited: false });
  assert.throws(
    () => inheritedSession.create({ tasks: [{ task: "x", inheritContext: true }] }, { captureInheritedContext: () => snapshot0() }),
    (error) => error instanceof SubagentError && error.code === "inherited_not_allowed",
  );
  // A Fresh Subagent created from an inherited session still works.
  const created = inheritedSession.create({ tasks: [spec("fresh")] });
  assert.equal("status" in created.items[0], false);
  assert.equal(adapter.started.length, 1);
});

function snapshot0() {
  return { systemPrompt: "parent", tools: [], entries: [] };
}

test("gives each inherited child its own native containers over shared immutable history", () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const header = { type: "session", id: "session_parent", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work" };
  const userEntry = {
    type: "message",
    id: "e1",
    parentId: "session_parent",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "parent work" }] },
  };
  // The body is an accessor so creation that serializes the whole history is
  // observable: sharing must not read a captured message body at all.
  let bodyReads = 0;
  const assistantBody = [
    { type: "thinking", thinking: "weigh options", signature: "sig-1" },
    { type: "text", text: "done" },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
  ];
  const assistantMessage = { role: "assistant" };
  Object.defineProperty(assistantMessage, "content", {
    enumerable: true, configurable: true,
    get() { bodyReads += 1; return assistantBody; },
  });
  const assistantEntry = {
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: assistantMessage,
  };
  const capture = {
    capturedAt: 1,
    cwd: "/work",
    systemPrompt: "parent",
    model: null,
    thinkingLevel: null,
    tools: ["read"],
    entries: [header, userEntry, assistantEntry],
  };

  const items = runtime.create(
    { tasks: [{ task: "one", inheritContext: true }, { task: "two", inheritContext: true }] },
    { captureInheritedContext: () => capture },
  ).items;
  assert.equal(items.length, 2);

  const [snapshotA, snapshotB] = adapter.started.map((handle) => handle.job.spec.inheritedContext);
  // Creation shares the capture instead of serializing it; the probe reads a
  // nested message body accessor and must stay at zero.
  assert.equal(bodyReads, 0, "creation must not serialize captured message bodies");
  // Each child owns its top-level snapshot, its entries array and its session
  // header. The captured history itself is immutable data and stays shared.
  assert.notEqual(snapshotA.entries, snapshotB.entries);
  assert.notEqual(snapshotA.entries, capture.entries);
  assert.notEqual(snapshotA.entries[0], capture.entries[0]);
  assert.notEqual(snapshotA, snapshotB);
  assert.equal(snapshotA.entries[1], userEntry);
  assert.equal(snapshotA.entries[2], assistantEntry);
  assert.equal(snapshotB.entries[1], userEntry);
  assert.equal(snapshotB.entries[2], assistantEntry);

  // Each seeded session has its own identity instead of the caller's.
  const headerIdOf = (snapshot) => snapshot.entries.find((entry) => entry.type === "session").id;
  assert.notEqual(headerIdOf(snapshotA), headerIdOf(snapshotB));
  assert.notEqual(headerIdOf(snapshotA), "session_parent");
  assert.notEqual(headerIdOf(snapshotB), "session_parent");

  // Native blocks are shared unchanged — provider signature included.
  assert.deepEqual(snapshotA.entries[2].message.content[0], { type: "thinking", thinking: "weigh options", signature: "sig-1" });
  assert.deepEqual(snapshotA.entries[2].message.content[2], { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } });

  // Appending to one child's native entries — exactly what its SessionManager
  // does — leaves the sibling and the capture untouched.
  snapshotA.entries.push({
    type: "message",
    id: "e3",
    parentId: "e2",
    timestamp: "2026-01-01T00:00:03.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "child-only" }] },
  });
  assert.equal(snapshotB.entries.length, 3);
  assert.equal(capture.entries.length, 3);
  assert.deepEqual(capture.entries.map((entry) => entry.id), ["session_parent", "e1", "e2"]);
  assert.deepEqual(capture.entries[0], header);

  // Lifecycle events carry seed metadata, never the captured native entries.
  const state = stateOf(runtime);
  assert.equal(state.jobs[0].spec.inheritedContext.entries, undefined);
  assert.equal(snapshotA.entries.length, 4);
  assert.equal(adapter.started[0].job.spec.inheritedContext, snapshotA);
});

test("inherited registration persists a model reference, not headers or live provider callbacks", () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const model = { provider: "test", id: "private-model", api: "test-api", headers: { Authorization: "private-credential" }, callback() {} };
  runtime.create({ tasks: [{ task: "inherit", inheritContext: true }] }, {
    captureInheritedContext: () => ({ model, entries: [], systemPrompt: "parent", tools: [] }),
  });
  const state = stateOf(runtime);
  assert.equal(state.jobs.length, 1, "registration must not fail structuredClone on a provider callback");
  assert.deepEqual(state.jobs[0].spec.inheritedContext.model, { provider: "test", id: "private-model" });
  assert.equal(JSON.stringify(state).includes("private-credential"), false);
  assert.equal(adapter.started[0].job.spec.inheritedContext.model, model, "live execution retains the actual captured definition");
});

test("isolates failures to the failing job", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const items = runtime.create({ tasks: [spec("bad"), spec("good")] }).items;

  adapter.handleFor(items[0].id).reject(new Error("model unreachable"));
  const failed = await runtime.jobDone(items[0].id);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.error, { code: "job_failed", message: "model unreachable" });
  assert.equal(runtime.jobs({ jobIds: [items[1].id] }).jobs[0].status, "running");

  adapter.handleFor(items[1].id).resolve({ result: "survived", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
  assert.equal((await runtime.jobDone(items[1].id)).status, "completed");
  assert.equal(runtime.jobRecord(items[1].id).result, "survived");
  assert.equal(runtime.jobRecord(items[0].id).result, null);
  assert.deepEqual(
    runtime.jobs().jobs.map((job) => [job.status, job.error?.code ?? null]),
    [["failed", "job_failed"], ["completed", null]],
  );
});

test("marks only the job whose start failed", async () => {
  const adapter = createFakeAdapter();
  let starts = 0;
  const runtime = createSubagentRuntime({
    startJob: (job) => {
      starts += 1;
      if (starts === 1) throw new Error("cannot create session");
      return adapter.startJob(job);
    },
  });
  const created = runtime.create({ tasks: [spec("a"), spec("b")] }).items;

  const failed = await runtime.jobDone(created[0].id);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.error, { code: "start_failed", message: "cannot create session" });
  assert.equal(runtime.jobs({ jobIds: [created[1].id] }).jobs[0].status, "running");
  assert.deepEqual(adapter.started.map((handle) => handle.job.jobId), [created[1].id]);
});

test("rejects adapters that do not return a job handle", async () => {
  const runtime = createSubagentRuntime({ startJob: () => undefined });
  const item = runtime.create({ tasks: [spec("a")] }).items[0];
  const snapshot = await runtime.jobDone(item.id);
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.error.code, "invalid_adapter");
});

test("cancellation during batch registration prevents the not-yet-started sibling from starting", async () => {
  const adapter = createFakeAdapter();
  let notStarted;
  const runtime = createSubagentRuntime({ startJob(request) {
    if (request.spec.name === "a") {
      const sibling = runtime.jobs().jobs.find((job) => job.name === "b");
      assert.equal(sibling.status, "running");
      notStarted = runtime.cancelJob(sibling.jobId);
    }
    return adapter.startJob(request);
  } });
  const items = runtime.create({ tasks: [spec("a"), spec("b")] }).items;

  assert.equal(notStarted.ok, true);
  assert.equal(notStarted.job.status, "cancelled");
  assert.deepEqual(notStarted.job.error, { code: "cancelled", message: "Job cancelled before it started." });
  assert.deepEqual(await runtime.jobDone(items[1].id), notStarted.job);
  assert.equal(adapter.started.length, 1);
  assert.deepEqual(runtime.cancelJob(items[1].id).reason, "already_finished");
  assert.throws(() => runtime.cancelJob("job_missing-9"), (error) => error instanceof SubagentError && error.code === "unknown_job");
});

test("a cancelled run keeps its actor active without blocking its sibling", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const items = runtime.create({ tasks: [spec("a"), spec("b")] }).items;
  const [first, sibling] = items;

  const stopping = runtime.cancelJob(first.id);
  assert.equal(stopping.ok, true);
  assert.equal(stopping.job.status, "stopping");
  assert.equal(stopping.job.stopping, "cancelled");
  assert.equal(adapter.handleFor(first.id).cancelled, true);
  // Cancellation keeps this actor active, but does not block its sibling.
  assert.deepEqual(adapter.started.map((handle) => handle.job.jobId), [first.id, sibling.id]);
  assert.equal(runtime.jobs({ jobIds: [sibling.id] }).jobs[0].status, "running");
  assert.equal(runtime.list().agents[0].status, "running");
  assert.deepEqual(runtime.cancelJob(first.id).reason, "stopping");

  // Nothing terminal is published while the run unwinds: the result ref keeps
  // reporting the stopping status and existing waiters stay parked.
  assert.equal(runtime.jobs({ jobIds: [first.id] }).jobs[0].status, "stopping");
  let settled = false;
  const pending = runtime.jobDone(first.id).then((view) => {
    settled = true;
    return view;
  });
  await flush();
  assert.equal(settled, false);

  // Late output from the aborted run is kept, but published exactly once.
  adapter.handleFor(first.id).resolve({
    result: "partial output",
    messages: [{ role: "assistant", content: [{ type: "text", text: "partial" }] }],
  });
  const published = await pending;
  assert.equal(published.status, "cancelled");
  assert.deepEqual(published.error, { code: "cancelled", message: "Job cancelled while running." });
  assert.equal(published.budget.terminal.status, "cancelled");

  const result = runtime.jobRecord(first.id);
  assert.equal(result.status, "cancelled");
  assert.equal(result.result, "partial output");
  assert.deepEqual(result, runtime.jobRecord(first.id));
  assert.equal("messages" in result, false, "runtime does not own transcript copies");

  // The sibling was already running and is unaffected by the cancelled exit.
  assert.deepEqual(adapter.started.map((handle) => handle.job.jobId), [first.id, sibling.id]);
  assert.equal(runtime.jobs({ jobIds: [sibling.id] }).jobs[0].status, "running");
  assert.deepEqual(runtime.cancelJob(first.id).reason, "already_finished");
});

test("keeps agent state and job state in separate snapshots", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const items = runtime.create({ tasks: [spec("a"), spec("b")] }).items;

  assert.deepEqual(runtime.list({ status: "running" }).agents, [
    { agentId: items[0].id, name: "a", parentAgentId: null, status: "running", depth: 1, kind: "fresh" },
    { agentId: items[1].id, name: "b", parentAgentId: null, status: "running", depth: 1, kind: "fresh" },
  ]);
  assert.equal(runtime.list({ status: "idle" }).agents.length, 0);
  for (const agent of runtime.list().agents) {
    assert.equal("jobId" in agent, false);
    assert.equal("jobStatus" in agent, false);
  }

  adapter.handleFor(items[0].id).resolve({ result: "one" });
  await runtime.jobDone(items[0].id);
  // job one is terminal, so agent one is idle while agent two still has a live job.
  assert.deepEqual(
    runtime.list().agents.map((agent) => [agent.agentId, agent.status]),
    [[items[0].id, "idle"], [items[1].id, "running"]],
  );
  const { budget, ...completed } = runtime.jobs({ jobIds: [items[1].id] }).jobs[0];
  assert.deepEqual(completed, {
    jobId: items[1].id,
    agentId: items[1].id,
    name: "b",
    parentAgentId: null,
    depth: 1,
    status: "running",
    continuedFromJobId: null,
  });
  assert.equal(budget.jobId, items[1].id);

  adapter.handleFor(items[1].id).resolve({});
  await runtime.jobDone(items[1].id);
  assert.deepEqual(runtime.list().agents.map((agent) => agent.status), ["idle", "idle"]);
  const terminal = runtime.jobs({ jobIds: [items[1].id] }).jobs[0];
  assert.deepEqual(
    { ...terminal, budget: undefined },
    {
      jobId: items[1].id,
      agentId: items[1].id,
      name: "b",
      parentAgentId: null,
      depth: 1,
      status: "completed",
      continuedFromJobId: null,
      budget: undefined,
    },
  );
  assert.equal(terminal.budget.phase, "normal");
  assert.equal(terminal.budget.modelCalls, 0);
  assert.equal(terminal.budget.running, false);
  assert.equal(terminal.budget.terminal.status, "completed");
  assert.throws(() => runtime.jobs({ jobIds: ["job_missing-9"] }), (error) => error instanceof SubagentError && error.code === "unknown_job");
});

test("serves isolated Job records and sealed bounds without owning transcripts", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const item = runtime.create({ tasks: [{ name: "reader", task: "read things" }] }).items[0];
  const handle = adapter.handleFor(item.id);
  handle.job.recordStart("e0");
  assert.equal(runtime.jobRecord(item.id), null);
  handle.resolve({ result: { issues: [] }, transcript: [{ role: "assistant", content: "done" }],
    history: { startEntryId: "e0", endEntryId: "e2" } });
  await runtime.jobDone(item.id);
  const first = runtime.jobRecord(item.id);
  assert.equal(first.status, "completed");
  assert.equal(first.name, "reader");
  assert.deepEqual(first.history, { startEntryId: "e0", endEntryId: "e2" });
  first.result.issues.push("mutated by reader");
  first.history.endEntryId = "mutated";
  assert.deepEqual(runtime.jobRecord(item.id).result, { issues: [] });
  assert.equal(runtime.jobRecord(item.id).history.endEntryId, "e2");
  assert.equal("transcript" in first, false);
  assert.equal("messages" in first, false);
  assert.equal(runtime.jobRecord("file:///etc/passwd"), null);
  assert.throws(() => runtime.jobDone("job_missing-7"), (error) => error.code === "unknown_job");
});

test("enforces four active children per parent and two nesting levels atomically", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });

  const roots = runtime.create({ tasks: [spec("a"), spec("b"), spec("c"), spec("d")] }).items;
  assert.deepEqual(runtime.list().agents.map((agent) => agent.depth), [1, 1, 1, 1]);
  assert.throws(
    () => runtime.create({ tasks: [spec("overflow")] }),
    (error) => error instanceof SubagentError && error.code === "child_limit_exceeded",
  );

  const children = runtime.create(
    { tasks: [spec("a1"), spec("a2"), spec("a3"), spec("a4")] },
    { parentAgentId: roots[0].id },
  ).items;
  assert.deepEqual(
    runtime.list().agents.slice(4).map((agent) => [agent.parentAgentId, agent.depth]),
    children.map(() => [roots[0].id, 2]),
  );
  assert.throws(
    () => runtime.create({ tasks: [spec("too-deep")] }, { parentAgentId: children[0].id }),
    (error) => error instanceof SubagentError && error.code === "max_depth_exceeded",
  );
  assert.throws(
    () => runtime.create({ tasks: [spec("unknown-parent")] }, { parentAgentId: "agent_missing-1" }),
    (error) => error instanceof SubagentError && error.code === "unknown_parent",
  );

  adapter.handleFor(roots[0].id).resolve({ result: "done" });
  await runtime.jobDone(roots[0].id);
  const replacement = runtime.create({ tasks: [spec("replacement")] }).items[0];
  assert.notEqual(replacement.id, roots[0].id);
  // The freed slot is reused by a new root child: four parent-level agents run
  // while the four nested children of the first root keep running beneath it.
  assert.equal(
    runtime.list({ status: "running" }).agents.filter((agent) => agent.parentAgentId === null).length,
    4,
  );
});

test("surfaces exhausted budgets without exposing profile limits", async () => {
  const runtime = createSubagentRuntime({
    startJob(job) {
      for (let call = 1; call <= 201; call += 1) job.budget.beginModelCall();
      return { done: Promise.reject(new Error("provider call should not start")) };
    },
  });

  const item = runtime.create({ tasks: [spec("bounded")] }).items[0];
  const failed = await runtime.jobDone(item.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "budget_exceeded");
  assert.equal("detail" in failed.error, false);
  assert.equal(failed.budget.modelCalls, 200);
  assert.equal(failed.budget.rejectedProjectedModelCalls, 201);
  assert.equal(failed.budget.terminal.error.code, "budget_exceeded");
  assert.equal("detail" in failed.budget.terminal.error, false);
  assert.equal("profile" in failed.budget, false);
});

test("an observed active-time failure stops only its actor until the handle exits", async () => {
  await withFakeClock(async (clock) => {
    const adapter = createFakeAdapter();
    const runtime = createSubagentRuntime({
      startJob: adapter.startJob,
      deliverToMain: adapter.deliverToMain,
    });
    const items = runtime.create({ tasks: [spec("a"), spec("b")] }).items;
    const [first, sibling] = items;
    const handle = adapter.handleFor(first.id);

    // A watch tick that finds a healthy Budget is a plain read: the run keeps
    // going and nothing is cancelled or transitioned.
    const healthy = handle.job.checkBudget();
    assert.equal(healthy.terminal, null);
    assert.equal(healthy.running, true);
    assert.equal(handle.cancelCount, 0);
    assert.equal(runtime.jobs({ jobIds: [first.id] }).jobs[0].status, "running");

    // The adapter's watch observes the Budget: depth 1 reaches the hard
    // active-time ceiling exactly at 120 minutes.
    clock.now = 120 * 60 * 1000;
    const verdict = handle.job.checkBudget();
    assert.equal(verdict.phase, "exhausted");
    assert.equal(verdict.terminal.status, "failed");
    assert.equal(verdict.terminal.error.code, "budget_exceeded");

    // The observation routes through the runtime: the native run is aborted
    // once and the Job keeps its physical and topology slots until it exits.
    assert.equal(handle.cancelled, true);
    assert.equal(handle.cancelCount, 1);
    const stopping = runtime.jobs({ jobIds: [first.id] }).jobs[0];
    assert.equal(stopping.status, "stopping");
    assert.equal(stopping.stopping, "failed");
    assert.equal(runtime.list().agents[0].status, "running");
    assert.equal(runtime.jobs({ jobIds: [sibling.id] }).jobs[0].status, "running");
    assert.deepEqual(adapter.started.map((entry) => entry.job.jobId), [first.id, sibling.id]);
    // A stopping agent rejects writes, and nothing terminal is published
    // while the aborted run is still unwinding.
    await assert.rejects(
      runtime.sendMessage({ from: "Main", to: first.id, content: "still there?" }),
      (error) => error instanceof SubagentError && error.code === "agent_busy",
    );
    assert.deepEqual(adapter.mainMessages, []);

    // Re-observing the same failure is a plain read of the frozen verdict: no
    // second cancel and no second transition.
    assert.deepEqual(handle.job.checkBudget(), verdict);
    assert.equal(handle.cancelCount, 1);
    assert.equal(runtime.jobs({ jobIds: [first.id] }).jobs[0].status, "stopping");
    assert.deepEqual(adapter.mainMessages, []);

    // Late output of the aborted run is kept; the failed payload is published
    // exactly once, when the native run has exited.
    handle.resolve({ result: "partial output" });
    const failed = await runtime.jobDone(first.id);
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.error, { code: "budget_exceeded", message: "Job execution budget exhausted." });
    assert.equal(failed.budget.terminal.status, "failed");
    assert.equal(runtime.jobRecord(first.id).result, "partial output");
    assert.equal(adapter.mainMessages.length, 1);
    assert.equal(adapter.mainMessages[0].status, "failed");
    assert.equal(adapter.mainMessages[0].round, 1);
    assert.equal(adapter.mainMessages[0].content, "partial output");
    assert.equal(adapter.mainMessages[0].error, "Job execution budget exhausted.");

    // The sibling was already running; a later observation of the finished
    // Job changes nothing either.
    assert.deepEqual(adapter.started.map((entry) => entry.job.jobId), [first.id, sibling.id]);
    assert.equal(handle.job.checkBudget().terminal.status, "failed");
    assert.equal(handle.cancelCount, 1);
    assert.equal(adapter.mainMessages.length, 1);
    assert.equal(runtime.jobs({ jobIds: [first.id] }).jobs[0].status, "failed");
  });
});

test("a Budget failure observed before the native handle exists is never lost or doubled", async () => {
  // The adapter checks the Budget synchronously inside startJob, before it
  // could return a handle: the failure is routed while no handle exists yet.
  await withFakeClock(async (clock) => {
    const adapter = createFakeAdapter();
    const runtime = createSubagentRuntime({
      startJob(request) {
        clock.now = 120 * 60 * 1000;
        assert.equal(request.checkBudget().terminal.status, "failed");
        return adapter.startJob(request);
      },
    });
    const item = runtime.create({ tasks: [spec("sync")] }).items[0];
    const handle = adapter.handleFor(item.id);

    // The cancellation is owed to the handle that arrives right after the
    // observation, and happens exactly once.
    assert.equal(handle.cancelCount, 1);
    const stopping = runtime.jobs({ jobIds: [item.id] }).jobs[0];
    assert.equal(stopping.status, "stopping");
    assert.equal(stopping.stopping, "failed");

    handle.resolve({ result: "partial output" });
    const failed = await runtime.jobDone(item.id);
    assert.deepEqual(failed.error, { code: "budget_exceeded", message: "Job execution budget exhausted." });
    assert.equal(handle.cancelCount, 1);
    assert.equal(runtime.jobRecord(item.id).result, "partial output");
  });

  // An adapter that throws after observing the same failure does not replace
  // it with a start failure, and no native run holds a slot to wait for.
  await withFakeClock(async (clock) => {
    const runtime = createSubagentRuntime({
      startJob(request) {
        clock.now = 120 * 60 * 1000;
        assert.equal(request.checkBudget().terminal.status, "failed");
        throw new Error("startup aborted");
      },
    });
    const item = runtime.create({ tasks: [spec("sync throw")] }).items[0];
    const failed = await runtime.jobDone(item.id);
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.error, { code: "budget_exceeded", message: "Job execution budget exhausted." });
    assert.equal(runtime.list().agents[0].status, "idle");
  });
});

test("delivers a message to a running agent without waiting for a response", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    deliverMessage: adapter.deliverMessage,
    deliverToMain: adapter.deliverToMain,
  });
  const item = runtime.create({ tasks: [spec("a")] }).items[0];

  const receipt = await runtime.sendMessage({ from: "Main", to: item.id, content: "what is your status?" });
  assert.deepEqual(receipt, { ok: true, to: item.id, jobId: item.id });
  // The receipt means the live run took the message, not that a model replied:
  // no second Job exists and the run is still parked on its own promise. The
  // envelope type and sender are host-owned.
  assert.deepEqual(adapter.deliveries, [
    { agentId: item.id, jobId: item.id, message: { type: "message", from: "Main", content: "what is your status?" } },
  ]);
  assert.equal(runtime.jobs().jobs.length, 1);
  assert.equal(runtime.jobs({ jobIds: [item.id] }).jobs[0].status, "running");
});

test("buffers a message during batch registration until the recipient starts", async () => {
  const adapter = createFakeAdapter();
  let receipt;
  const runtime = createSubagentRuntime({
    startJob(request) {
      if (request.spec.name === "a") {
        const sibling = runtime.jobs().jobs.find((job) => job.name === "b");
        receipt = runtime.sendMessage({ from: "Main", to: sibling.agentId, content: "start with the tests" });
      }
      return adapter.startJob(request);
    },
    deliverMessage: adapter.deliverMessage,
  });
  const items = runtime.create({ tasks: [spec("a"), spec("b")] }).items;
  const [first, second] = items;

  receipt = await receipt;
  assert.deepEqual(receipt, { ok: true, to: second.id, jobId: second.id });
  assert.deepEqual(adapter.deliveries, []);
  assert.equal(adapter.started.length, 2);

  adapter.handleFor(first.id).resolve({ result: "one" });
  await runtime.jobDone(first.id);

  const request = adapter.handleFor(second.id).job;
  assert.equal(request.jobId, second.id);
  assert.deepEqual(request.pendingMessages, [{ type: "message", from: "Main", content: "start with the tests" }]);

  // Once that Job is running, the next write goes through the live hand-over.
  const later = await runtime.sendMessage({ from: "Main", to: second.id, content: "and the docs" });
  assert.deepEqual(later, { ok: true, to: second.id, jobId: second.id });
  assert.deepEqual(adapter.deliveries, [
    { agentId: second.id, jobId: second.id, message: { type: "message", from: "Main", content: "and the docs" } },
  ]);
});

test("revives an idle agent with a new Job, continuedFromJobId and a fresh Budget", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const item = runtime.create({ tasks: [{ name: "auditor", task: "audit" }] }).items[0];
  const original = adapter.handleFor(item.id);
  original.resolve({
    result: "initial result",
    messages: [{ role: "assistant", content: [{ type: "text", text: "initial" }] }],
  });
  await runtime.jobDone(item.id);
  assert.equal(runtime.list().agents[0].status, "idle");

  const receipt = await runtime.sendMessage({ from: "Main", to: item.id, content: "add the deployment section" });
  assert.deepEqual(receipt, { ok: true, to: item.id, jobId: receipt.jobId });
  assert.notEqual(receipt.jobId, item.id);
  assert.match(receipt.jobId, JOB_ID_PATTERN);

  const revived = adapter.handleFor(receipt.jobId);
  assert.equal(revived.job.continuedFromJobId, item.id);
  assert.equal(revived.job.spec.kind, "continuation");
  assert.equal(revived.job.spec.name, "auditor");
  // The original seed travels with every continuation, so an actor that never
  // started can still build its first session from it.
  assert.equal(revived.job.spec.seed.task, "audit");
  assert.equal(revived.job.spec.seed.name, "auditor");
  assert.equal(revived.job.depth, 1);
  assert.deepEqual(revived.job.pendingMessages, [{ type: "message", from: "Main", content: "add the deployment section" }]);
  // A continuation Job carries its own Budget for the same depth.
  assert.notEqual(revived.job.budget, original.job.budget);
  const revivedBudget = revived.job.budget.snapshot();
  assert.equal(revivedBudget.jobId, receipt.jobId);
  assert.equal(revivedBudget.depth, 1);
  assert.equal(revivedBudget.modelCalls, 0);
  assert.equal(revivedBudget.phase, "normal");
  assert.equal(revivedBudget.terminal, null);
  assert.equal(revivedBudget.running, true);
  assert.equal(runtime.jobs({ jobIds: [item.id] }).jobs[0].budget.terminal.status, "completed");
  assert.equal(runtime.list().agents[0].status, "running");

  revived.job.recordStart("continued-start");
  revived.resolve({
    result: "continued result",
    history: { startEntryId: "continued-start", endEntryId: "continued-end" },
  });
  await runtime.jobDone(receipt.jobId);

  // Later rounds never rewrite the original outcome or concatenate transcripts.
  assert.equal(runtime.jobRecord(item.id).result, "initial result");
  const continued = runtime.jobRecord(receipt.jobId);
  assert.equal(continued.result, "continued result");
  assert.equal(continued.previousJobId, item.id);
  assert.deepEqual(continued.history, { startEntryId: "continued-start", endEntryId: "continued-end" });
  assert.equal("messages" in continued, false);
  assert.equal(runtime.jobs({ jobIds: [receipt.jobId] }).jobs[0].continuedFromJobId, item.id);
});

test("a task cancelled before its batch start is revived from its original seed", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob(request) {
      if (request.spec.name === "a") {
        const sibling = runtime.jobs().jobs.find((job) => job.name === "notStarted");
        assert.equal(runtime.cancelJob(sibling.jobId).job.status, "cancelled");
      }
      return adapter.startJob(request);
    },
    deliverMessage: adapter.deliverMessage,
  });
  const items = runtime.create({
    context: "batch background",
    tasks: [spec("a"), { name: "notStarted", task: "later work" }],
  }).items;
  const [first, notStarted] = items;

  await runtime.jobDone(notStarted.id);
  assert.equal(adapter.started.length, 1);
  // Nothing retries the cancelled task on its own.
  adapter.handleFor(first.id).resolve({ result: "one" });
  await runtime.jobDone(first.id);
  assert.equal(runtime.jobs().jobs.length, 2);

  // The explicit write revives an actor whose first native session was never
  // created: one continuation Job that still carries the original seed.
  const receipt = await runtime.sendMessage({ from: "Main", to: notStarted.id, content: "begin now" });
  const revived = adapter.handleFor(receipt.jobId);
  assert.equal(revived.job.continuedFromJobId, notStarted.id);
  assert.equal(revived.job.spec.kind, "continuation");
  assert.equal(revived.job.spec.seed.task, "later work");
  assert.equal(revived.job.spec.seed.context, "batch background");
  assert.deepEqual(revived.job.pendingMessages, [{ type: "message", from: "Main", content: "begin now" }]);
  assert.equal(runtime.jobs().jobs.length, 3);
});

test("rejects a write that would exceed four active children", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    deliverMessage: adapter.deliverMessage,
  });
  const roots = runtime.create({ tasks: [spec("a"), spec("b"), spec("c"), spec("d")] }).items;

  adapter.handleFor(roots[0].id).resolve({ result: "a done" });
  await runtime.jobDone(roots[0].id);
  const fifth = runtime.create({ tasks: [spec("e")] }).items[0];
  assert.equal(runtime.list({ status: "running" }).agents.length, 4);

  // Reviving the idle agent would create a fifth active child: the whole write
  // is rejected before any message or Job is registered.
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: roots[0].id, content: "wake up" }),
    (error) =>
      error instanceof SubagentError &&
      error.code === "child_limit_exceeded" &&
      error.detail.agentId === roots[0].id &&
      error.detail.activeChildren === 4,
  );
  assert.equal(runtime.jobs().jobs.length, 5);
  assert.equal(runtime.list().agents.find((agent) => agent.agentId === roots[0].id).status, "idle");
  assert.deepEqual(adapter.deliveries, []);

  // Once a child finishes, the same explicit write is admitted and revives.
  adapter.handleFor(roots[1].id).resolve({ result: "b done" });
  await runtime.jobDone(roots[1].id);
  assert.equal(runtime.jobs().jobs.length, 5);
  const admitted = await runtime.sendMessage({ from: "Main", to: roots[0].id, content: "wake up" });
  const revived = adapter.handleFor(admitted.jobId);
  assert.equal(revived.job.agentId, roots[0].id);
  assert.equal(revived.job.continuedFromJobId, roots[0].id);
  assert.deepEqual(revived.job.pendingMessages.map((message) => message.content), ["wake up"]);
  assert.equal(runtime.jobs({ jobIds: [fifth.id] }).jobs[0].status, "running");
});

test("rejects unknown senders and targets, invalid messages and sender spoofing", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    deliverMessage: adapter.deliverMessage,
    deliverToMain: adapter.deliverToMain,
  });
  const item = runtime.create({ tasks: [spec("a")] }).items[0];
  const rejects = (promise, code) =>
    assert.rejects(promise, (error) => error instanceof SubagentError && error.code === code);

  await rejects(runtime.sendMessage({ from: "Main", to: "agent_99", content: "hello" }), "unknown_agent");
  await rejects(runtime.sendMessage({ from: "agent_99", to: item.id, content: "hello" }), "unknown_sender");
  await rejects(runtime.sendMessage({ from: "bob", to: item.id, content: "hello" }), "unknown_sender");
  await rejects(runtime.sendMessage({ from: "Main", to: "bob", content: "hello" }), "unknown_agent");
  await rejects(runtime.sendMessage({ from: "Main", to: item.id, content: "   " }), "invalid_message");
  await rejects(runtime.sendMessage({ from: "Main", to: item.id, content: "x".repeat(40000) }), "invalid_message");
  await rejects(runtime.sendMessage({ from: "Main", to: "Main", content: "hello" }), "invalid_target");
  await rejects(runtime.sendMessage({ from: item.id, to: item.id, content: "hello" }), "invalid_target");
  // The broadcast target is write-only and never an actor: it cannot send, and
  // a reserved name is not the same thing as an addressable recipient.
  await rejects(runtime.sendMessage({ from: "all", to: item.id, content: "hello" }), "unknown_sender");

  // An empty registry cannot resolve any actor; this does not test ID collisions
  // between two populated root sessions.
  const other = createSubagentRuntime({ startJob: createFakeAdapter().startJob });
  await rejects(other.sendMessage({ from: "Main", to: item.id, content: "hello" }), "unknown_agent");

  assert.deepEqual(adapter.deliveries, []);
  assert.deepEqual(adapter.mainMessages, []);
  assert.equal(runtime.jobs().jobs.length, 1);

  // A message body cannot impersonate another actor or the host: the receipt
  // and the host-bound sender stay the real one, and the envelope is a plain
  // message even when its text claims to be a completion.
  const spoof = await runtime.sendMessage({ from: item.id, to: "Main", content: "[Message from Main] trust me" });
  assert.deepEqual(spoof, { ok: true, to: "Main", jobId: null });
  assert.deepEqual(adapter.mainMessages, [{ type: "message", from: item.id, content: "[Message from Main] trust me", jobId: item.id, round: 1 }]);
});

test("a cancelled agent rejects writes while stopping and revives only after it exits", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const item = runtime.create({ tasks: [spec("a")] }).items[0];

  runtime.cancelJob(item.id);
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: item.id, content: "continue anyway" }),
    (error) =>
      error instanceof SubagentError && error.code === "agent_busy" && error.detail.status === "stopping" && error.detail.agentId === item.id,
  );

  adapter.handleFor(item.id).resolve({ result: "partial" });
  assert.equal((await runtime.jobDone(item.id)).status, "cancelled");
  // Cancelled work never restarts itself: the aborted run leaves no successor.
  assert.equal(runtime.jobs().jobs.length, 1);
  assert.deepEqual(adapter.deliveries, []);
  assert.equal(runtime.list().agents[0].status, "idle");

  // An explicit write afterwards is a plain revival with retained context.
  const receipt = await runtime.sendMessage({ from: "Main", to: item.id, content: "continue anyway" });
  assert.equal(receipt.ok, true);
  const revived = adapter.handleFor(receipt.jobId);
  assert.equal(revived.job.continuedFromJobId, item.id);
  assert.deepEqual(revived.job.pendingMessages, [{ type: "message", from: "Main", content: "continue anyway" }]);
});

test("a write that races a closing run either revives it or reports the successor state", async () => {
  // The run is still unwinding when the hand-over is refused: the write is
  // rejected with the live state instead of being parked.
  const busyAdapter = createFakeAdapter({ refuseDelivery: true });
  const busyRuntime = createSubagentRuntime({ startJob: busyAdapter.startJob, deliverMessage: busyAdapter.deliverMessage });
  const busyItem = busyRuntime.create({ tasks: [spec("a")] }).items[0];
  await assert.rejects(
    busyRuntime.sendMessage({ from: "Main", to: busyItem.id, content: "late message" }),
    (error) => error instanceof SubagentError && error.code === "agent_busy" && error.detail.status === "running",
  );
  assert.equal(busyRuntime.jobs().jobs.length, 1);

  // The run settles inside the hand-over: the same write revives the agent
  // against the fresh state, still delivering the message exactly once.
  const raceAdapter = createFakeAdapter();
  const raceRuntime = createSubagentRuntime({ startJob: raceAdapter.startJob, deliverMessage: raceAdapter.deliverMessage });
  const raceItem = raceRuntime.create({ tasks: [spec("a")] }).items[0];
  raceAdapter.state.onDeliver = ({ handle }) => {
    handle.resolve({ result: "done while the write was in flight" });
    return { accepted: false, reason: "job_closed" };
  };

  const receipt = await raceRuntime.sendMessage({ from: "Main", to: raceItem.id, content: "late message" });
  assert.equal(receipt.ok, true);
  assert.notEqual(receipt.jobId, raceItem.id);
  assert.equal(raceRuntime.jobs().jobs.length, 2);
  const revived = raceAdapter.handleFor(receipt.jobId);
  assert.equal(revived.job.continuedFromJobId, raceItem.id);
  assert.deepEqual(revived.job.pendingMessages, [{ type: "message", from: "Main", content: "late message" }]);
  assert.equal(raceRuntime.jobRecord(raceItem.id).result, "done while the write was in flight");
});

test("rejects a write that arrives before any delivery hook is wired", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const item = runtime.create({ tasks: [spec("a")] }).items[0];

  // An aborted call never reaches the runtime.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: item.id, content: "never sent", signal: controller.signal }),
    (error) => error instanceof SubagentError && error.code === "aborted",
  );
  assert.deepEqual(adapter.deliveries, []);

  // Without a hand-over hook neither running sibling can take a message.
  const noHook = createSubagentRuntime({ startJob: adapter.startJob });
  const items = noHook.create({ tasks: [spec("a"), spec("b")] }).items;
  await assert.rejects(
    noHook.sendMessage({ from: "Main", to: items[0].id, content: "held" }),
    (error) => error instanceof SubagentError && error.code === "agent_busy",
  );
  await assert.rejects(
    noHook.sendMessage({ from: "Main", to: items[1].id, content: "held" }),
    (error) => error instanceof SubagentError && error.code === "agent_busy",
  );
  assert.equal(noHook.jobs().jobs.length, 2);
});

test("delivers an explicit message to Main and reports a failed Main delivery", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    deliverMessage: adapter.deliverMessage,
    deliverToMain: adapter.deliverToMain,
  });
  const item = runtime.create({ tasks: [spec("a")] }).items[0];

  const receipt = await runtime.sendMessage({ from: item.id, to: "Main", content: "audit finished" });
  assert.deepEqual(receipt, { ok: true, to: "Main", jobId: null });
  assert.deepEqual(adapter.mainMessages, [{ type: "message", from: item.id, content: "audit finished", jobId: item.id, round: 1 }]);
  assert.equal(runtime.jobs().jobs.length, 1);

  const failing = createFakeAdapter({ mainDeliveryFails: true });
  const failingRuntime = createSubagentRuntime({ startJob: failing.startJob, deliverToMain: failing.deliverToMain });
  const failingItem = failingRuntime.create({ tasks: [spec("a")] }).items[0];
  await assert.rejects(
    failingRuntime.sendMessage({ from: failingItem.id, to: "Main", content: "hello" }),
    (error) => error instanceof SubagentError && error.code === "delivery_failed" && /main session unavailable/.test(error.message),
  );

  // A completion never needs a delivery hook to be wired to change a Job's
  // outcome, and a runtime without one simply cannot notify.
  const silentAdapter = createFakeAdapter();
  const silent = createSubagentRuntime({ startJob: silentAdapter.startJob });
  const silentItem = silent.create({ tasks: [spec("a")] }).items[0];
  silentAdapter.handleFor(silentItem.id).resolve({ result: "done" });
  assert.equal((await silent.jobDone(silentItem.id)).status, "completed");
});

test("requires a delivery hook to message Main", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const item = runtime.create({ tasks: [spec("a")] }).items[0];
  await assert.rejects(
    runtime.sendMessage({ from: item.id, to: "Main", content: "hello" }),
    (error) => error instanceof SubagentError && error.code === "delivery_unavailable",
  );
});

test("notifies the creator with a typed terminal event for completion, failure and cancellation", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    deliverMessage: adapter.deliverMessage,
    deliverToMain: adapter.deliverToMain,
  });
  const item = runtime.create({ tasks: [{ name: "auditor", task: "audit" }] }).items[0];

  adapter.handleFor(item.id).resolve({ result: "the whole answer", messages: [] });
  const completed = await runtime.jobDone(item.id);
  assert.equal(completed.status, "completed");
  assert.equal(adapter.mainMessages.length, 1);
  assert.deepEqual(
    (({ type, from, subagentId, jobId, round, status, error }) => ({ type, from, subagentId, jobId, round, status, error }))(adapter.mainMessages[0]),
    { type: "notification", from: item.id, subagentId: item.id, jobId: item.id, round: 1, status: "completed", error: null },
  );
  assert.equal(adapter.mainMessages[0].round, 1);
  assert.equal(adapter.mainMessages[0].content, "the whole answer");

  // Failures carry the result (empty here) and the error summary separately.
  const failing = runtime.create({ tasks: [spec("failing")] }).items[0];
  adapter.handleFor(failing.id).reject(new Error("model unreachable"));
  await runtime.jobDone(failing.id);
  assert.equal(adapter.mainMessages.length, 2);
  assert.equal(adapter.mainMessages[1].status, "failed");
  assert.equal(adapter.mainMessages[1].jobId, failing.id);
  assert.equal(adapter.mainMessages[1].round, 1);
  assert.equal(adapter.mainMessages[1].content, "");
  assert.equal(adapter.mainMessages[1].error, "model unreachable");

  // Cancellation publishes its own terminal status rather than silence.
  const cancelled = runtime.create({ tasks: [spec("cancelled")] }).items[0];
  assert.equal(runtime.cancelJob(cancelled.id).job.status, "stopping");
  adapter.handleFor(cancelled.id).resolve({ result: "partial" });
  assert.equal((await runtime.jobDone(cancelled.id)).status, "cancelled");
  assert.equal(adapter.mainMessages.length, 3);
  assert.equal(adapter.mainMessages[2].status, "cancelled");
  assert.equal(adapter.mainMessages[2].jobId, cancelled.id);
  assert.equal(adapter.mainMessages[2].round, 1);
  assert.equal(adapter.mainMessages[2].content, "partial");
  assert.equal(adapter.mainMessages[2].error, "Job cancelled while running.");
});

test("a failure reaches a running parent's live Job and hands an idle notice to the adapter", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    deliverMessage: adapter.deliverMessage,
    deliverToMain: adapter.deliverToMain,
  });
  const parent = runtime.create({ tasks: [spec("parent")] }).items[0];
  const child = runtime.create({ tasks: [spec("child")] }, { parentAgentId: parent.id }).items[0];

  // A failed child notifies the running parent
  adapter.handleFor(child.id).reject(new Error("child crash"));
  await runtime.jobDone(child.id);
  assert.deepEqual(adapter.mainMessages, []);
  const handOver = adapter.deliveries.at(-1);
  assert.equal(handOver.agentId, parent.id);
  assert.equal(handOver.jobId, parent.id);
  assert.equal(handOver.message.type, "notification");
  assert.equal(handOver.message.status, "failed");
  // The notification never creates a Job for the parent.
  assert.equal(runtime.jobs().jobs.length, 2);

  adapter.handleFor(parent.id).resolve({ result: "parent done" });
  await runtime.jobDone(parent.id);
  const second = runtime.create({ tasks: [spec("sibling")] }, { parentAgentId: parent.id }).items[0];
  adapter.handleFor(second.id).reject(new Error("sibling fail"));
  await runtime.jobDone(second.id);

  // The parent is idle now: the runtime hands the notice to the adapter with
  // jobId null. The adapter decides whether to wake it through the ordinary
  // continuation path or append it to the retained conversation.
  const retained = adapter.deliveries.at(-1);
  assert.equal(retained.agentId, parent.id);
  assert.equal(retained.jobId, null);
  assert.equal(retained.message.type, "notification");
  assert.equal(runtime.jobs().jobs.length, 3);
  assert.equal(runtime.list().agents.find((agent) => agent.agentId === parent.id).status, "idle");

  // Only an explicit write revives the preserved identity — and that revival
  // is a plain message, not a completion.
  const revived = await runtime.sendMessage({ from: "Main", to: parent.id, content: "carry on" });
  const handle = adapter.handleFor(revived.jobId);
  assert.equal(handle.job.continuedFromJobId, parent.id);
  assert.deepEqual(handle.job.pendingMessages, [{ type: "message", from: "Main", content: "carry on" }]);
});

test("broadcast reaches the sender's direct children only", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    deliverMessage: adapter.deliverMessage,
  });
  const roots = runtime.create({ tasks: [spec("a"), spec("b"), spec("c")] }).items;
  const nested = runtime.create({ tasks: [spec("a1"), spec("a2")] }, { parentAgentId: roots[0].id }).items;

  // Main's broadcast reaches its three direct children and none of the
  // grandchildren.
  const receipt = await runtime.sendMessage({ from: "Main", to: "all", content: "status?" });
  assert.deepEqual(receipt, {
    ok: true,
    to: "all",
    sent: roots.map((item) => ({ to: item.id, jobId: item.id })),
    errors: [],
  });
  assert.deepEqual(adapter.deliveries.map((entry) => entry.jobId), roots.map((item) => item.id));
  for (const delivery of adapter.deliveries) {
    assert.deepEqual(delivery.message, { type: "message", from: "Main", content: "status?" });
  }

  // A child's broadcast reaches only its own children: not itself, not its
  // parent, not its siblings and not its grandchildren.
  adapter.deliveries.length = 0;
  const child = await runtime.sendMessage({ from: roots[0].id, to: "all", content: "how is it going?" });
  assert.deepEqual(child, {
    ok: true,
    to: "all",
    sent: nested.map((item) => ({ to: item.id, jobId: item.id })),
    errors: [],
  });
  assert.deepEqual(adapter.deliveries.map((entry) => entry.jobId), nested.map((item) => item.id));
  assert.ok(adapter.deliveries.every((entry) => entry.message.from === roots[0].id));

  // A leaf has no children: the broadcast is a successful no-op, not an error.
  assert.deepEqual(await runtime.sendMessage({ from: nested[0].id, to: "all", content: "anyone there?" }), {
    ok: true,
    to: "all",
    sent: [],
    errors: [],
  });
});

test("broadcast reports partial outcomes and revives idle children like any single write", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    deliverMessage: adapter.deliverMessage,
  });
  const roots = runtime.create({ tasks: [spec("a"), spec("b"), spec("c")] }).items;

  // One child refuses the hand-over: its outcome is an explicit error while
  // the others still get the write.
  adapter.state.onDeliver = ({ handle }) => (handle.job.jobId === roots[1].id ? { accepted: false, reason: "job_closed" } : { accepted: true });
  const partial = await runtime.sendMessage({ from: "Main", to: "all", content: "report in" });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.sent.map((entry) => entry.to), [roots[0].id, roots[2].id]);
  assert.deepEqual(
    partial.errors.map((entry) => [entry.to, entry.code]),
    [[roots[1].id, "agent_busy"]],
  );

  // An idle child is revived by the broadcast exactly as a single write would
  // revive it: a continuation Job that carries the envelope.
  adapter.state.onDeliver = null;
  adapter.handleFor(roots[2].id).resolve({ result: "c done" });
  await runtime.jobDone(roots[2].id);
  const before = runtime.jobs().jobs.length;
  const revival = await runtime.sendMessage({ from: "Main", to: "all", content: "round two" });
  assert.equal(revival.ok, true);
  assert.equal(runtime.jobs().jobs.length, before + 1);
  const revivedEntry = revival.sent.find((entry) => entry.to === roots[2].id);
  const revived = adapter.handleFor(revivedEntry.jobId);
  assert.equal(revived.job.continuedFromJobId, roots[2].id);
  assert.deepEqual(revived.job.pendingMessages, [{ type: "message", from: "Main", content: "round two" }]);
});

test("a label is not an actor id: a child named all is reached by id only", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const labeled = runtime.create({ tasks: [{ name: "all", task: "do things" }] }).items[0];

  // The reserved target is the broadcast route, never a label: Main's write
  // still fans out by actor id and the message reaches that one child.
  const broadcast = await runtime.sendMessage({ from: "Main", to: "all", content: "status?" });
  assert.deepEqual(broadcast, { ok: true, to: "all", sent: [{ to: labeled.id, jobId: labeled.id }], errors: [] });
  assert.deepEqual(adapter.deliveries, [
    { agentId: labeled.id, jobId: labeled.id, message: { type: "message", from: "Main", content: "status?" } },
  ]);
  // And the label is not an address: only a real actor id resolves.
  assert.equal(canonicalActorId("all"), null);
  assert.equal(runtime.jobRecord("all"), null);
  adapter.handleFor(labeled.id).resolve({ result: "done" });
  await runtime.jobDone(labeled.id);
  assert.equal(runtime.jobRecord(labeled.id).name, "all");
});

test("carries the adapter's inherited warnings on the entry and job views", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const warning = "Not transplantable through Pi's public API, so the inherited child does not have them: mystery.";
  const snapshot = { systemPrompt: "parent", tools: ["read"], entries: [], warnings: [warning] };

  const fresh = runtime.create({ tasks: [spec("fresh")] }).items[0];
  assert.equal("warnings" in fresh, false);

  const child = runtime.create({ tasks: [{ task: "inherit", inheritContext: true }] }, { captureInheritedContext: () => snapshot }).items[0];
  assert.deepEqual(child.warnings, [warning]);
  assert.deepEqual(runtime.jobs({ jobIds: [child.id] }).jobs[0].warnings, [warning]);

  // A revival restates them through the Job's seed, and the persisted spec
  // keeps them for a restored Job.
  adapter.handleFor(child.id).resolve({ result: "done" });
  await runtime.jobDone(child.id);
  const revived = await runtime.sendMessage({ from: "Main", to: child.id, content: "more" });
  assert.deepEqual(runtime.jobs({ jobIds: [revived.jobId] }).jobs[0].warnings, [warning]);

  const state = JSON.parse(JSON.stringify(stateOf(runtime)));
  const restored = createSubagentRuntime({ startJob: createFakeAdapter().startJob });
  restored.restoreState(state);
  assert.deepEqual(restored.jobs({ jobIds: [child.id] }).jobs[0].warnings, [warning]);
  assert.deepEqual(restored.jobs({ jobIds: [revived.jobId] }).jobs[0].warnings, [warning]);
});

test("emits lifecycle deltas once and never during read-only polls", async () => {
  const adapter = createFakeAdapter();
  const events = [];
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage,
    onEvent: (event) => events.push(event) });
  const item = runtime.create({ tasks: [spec("a")] }).items[0];
  assert.deepEqual(events.map((event) => event.type), ["job"]);
  runtime.list(); runtime.jobs(); runtime.jobDone(item.id); runtime.jobRecord(item.id);
  await runtime.sendMessage({ from: "Main", to: item.id, content: "status?" });
  assert.equal(events.length, 1);
  const handle = adapter.handleFor(item.id);
  handle.job.recordStart("e0");
  handle.job.recordStart("e1");
  assert.deepEqual(events.map((event) => event.type), ["job", "job-start"]);
  assert.equal(events[1].startEntryId, "e0");
  handle.resolve({ result: "done", history: { startEntryId: "e0", endEntryId: "e2" } });
  await runtime.jobDone(item.id);
  assert.deepEqual(events.map((event) => event.type), ["job", "job-start", "job-end"]);
  assert.deepEqual(events[2].history, { startEntryId: "e0", endEntryId: "e2" });
  events[0].actor.name = "tampered";
  events[2].status = "tampered";
  assert.equal(runtime.list().agents[0].name, "a");
  assert.equal(runtime.jobRecord(item.id).status, "completed");
});

test("emits terminal events before notifications, including synchronous batch failures", async () => {
  const adapter = createFakeAdapter();
  const observed = [];
  let runtime;
  runtime = createSubagentRuntime({ startJob: adapter.startJob,
    deliverToMain(message) {
      observed.push(stateOf(runtime).jobs.find((job) => job.jobId === message.jobId).end.status);
    } });
  const item = runtime.create({ tasks: [spec("a")] }).items[0];
  adapter.handleFor(item.id).resolve({ result: "done" });
  await runtime.jobDone(item.id);
  assert.deepEqual(observed, ["completed"]);
  const events = [], failures = [];
  const failing = createSubagentRuntime({
    startJob(request) { if (request.index === 0) throw new Error("cannot create session"); return adapter.startJob(request); },
    onEvent: (event) => events.push(event),
    deliverToMain(message) {
      failures.push(message);
      assert.equal(events.filter((event) => event.type === "job").length, 2);
      assert.ok(events.some((event) => event.type === "job-end" && event.jobId === message.jobId));
    },
  });
  failing.create({ tasks: [spec("bad"), spec("good")] });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].status, "failed");
  assert.equal(failures[0].round, 1);
  assert.equal(failures[0].content, "");
  assert.equal(failures[0].error, "cannot create session");
});

test("a failing persistence hook can never change a Job outcome", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    onEvent: () => {
      throw new Error("disk full");
    },
  });
  const item = runtime.create({ tasks: [spec("a")] }).items[0];
  adapter.handleFor(item.id).resolve({ result: "done" });
  const terminal = await runtime.jobDone(item.id);
  assert.equal(terminal.status, "completed");
  assert.equal(runtime.jobRecord(item.id).result, "done");
});

function validState() {
  return {
    actors: [{ agentId: "sub_01", name: "kept", parentAgentId: null, depth: 1, stoppedOrder: 1 }],
    jobs: [{ jobId: "sub_01", agentId: "sub_01", createdBy: "Main", continuedFromJobId: null,
      spec: { name: "kept", task: "kept work", context: null, inheritContext: false },
      end: { status: "completed", result: "kept result", error: null,
        history: { startEntryId: "e0", endEntryId: "e2" }, budget: null } }],
  };
}

test("rejects malformed folded topology, ownership, specs and terminal states", () => {
  const corrupt = (mutate) => {
    const state = validState(); mutate(state);
    const runtime = createSubagentRuntime({ startJob: createFakeAdapter().startJob });
    assert.throws(() => runtime.restoreState(state), (error) => error.code === "invalid_state");
    assert.deepEqual(runtime.list(), { agents: [] }, "failed restore cannot partially adopt actors");
  };
  for (const id of ["all", "Main", "agent_01"]) corrupt((state) => { state.actors[0].agentId = id; });
  corrupt((state) => { state.actors = "no"; });
  corrupt((state) => { state.jobs = {}; });
  corrupt((state) => { state.actors[0].parentAgentId = "sub_99"; });
  corrupt((state) => { state.actors[0].depth = 2; });
  corrupt((state) => { state.jobs[0].agentId = "sub_99"; });
  corrupt((state) => { state.jobs[0].end.status = "zombie"; });
  corrupt((state) => { state.jobs[0].createdBy = "bob"; });
  corrupt((state) => { state.jobs[0].continuedFromJobId = "sub_99"; });
  corrupt((state) => { state.jobs[0].spec.task = ""; });
  corrupt((state) => { state.actors.push({ ...state.actors[0] }); });
  corrupt((state) => { state.jobs.push({ ...state.jobs[0] }); });
  corrupt((state) => {
    state.actors.push({ agentId: "sub_02", depth: 1, parentAgentId: null });
    state.jobs.push({ ...state.jobs[0], jobId: "sub_02", agentId: "sub_02", continuedFromJobId: "sub_01" });
  });
  const used = createSubagentRuntime({ startJob: createFakeAdapter().startJob });
  used.create({ tasks: [spec("live")] });
  assert.throws(() => used.restoreState(validState()), /requires a fresh runtime/);
});

test("restores folded results and topology without replaying live work or retaining transcripts", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const first = runtime.create({ context: "batch background", tasks: [spec("first")] }).items[0];
  adapter.handleFor(first.id).job.recordStart("e0");
  adapter.handleFor(first.id).resolve({ result: "first result", transcript: [{ role: "assistant", content: "first answer" }],
    history: { startEntryId: "e0", endEntryId: "e2" } });
  await runtime.jobDone(first.id);
  const nested = runtime.create({ tasks: [spec("nested")] }, { parentAgentId: first.id }).items[0];
  const second = runtime.create({ context: "second background", tasks: [spec("second")] }).items[0];
  const state = stateOf(runtime);
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes("first answer"), false);
  assert.equal(state.jobs[0].end.result, "first result");
  const restoredAdapter = createFakeAdapter();
  const restored = createSubagentRuntime({ startJob: restoredAdapter.startJob, deliverMessage: restoredAdapter.deliverMessage,
    deliverToMain: restoredAdapter.deliverToMain });
  assert.deepEqual(restored.restoreState(JSON.parse(serialized)), { actors: 3, jobs: 3, interrupted: [nested.id, second.id] });
  assert.deepEqual(restoredAdapter.started, []);
  assert.deepEqual(restoredAdapter.mainMessages, []);
  assert.equal(restored.jobRecord(first.id).result, "first result");
  assert.deepEqual(restored.jobRecord(first.id).history, { startEntryId: "e0", endEntryId: "e2" });
  for (const id of [nested.id, second.id]) {
    assert.equal(restored.jobRecord(id).status, "failed");
    assert.equal(restored.jobRecord(id).error.code, "job_interrupted");
    assert.equal(restored.cancelJob(id).reason, "already_finished");
    assert.equal((await restored.jobDone(id)).status, "failed");
  }
  assert.equal(restored.list().agents[1].parentAgentId, first.id);
  state.jobs[0].end.result = "tampered";
  assert.equal(runtime.jobRecord(first.id).result, "first result");
  const revived = await restored.sendMessage({ from: "Main", to: second.id, content: "begin now" });
  const handle = restoredAdapter.handleFor(revived.jobId);
  assert.equal(handle.job.continuedFromJobId, second.id);
  assert.equal(handle.job.spec.seed.task, "do second");
  assert.equal(handle.job.spec.seed.context, "second background");
  assert.deepEqual(handle.job.pendingMessages.map((message) => message.content), ["begin now"]);
  assert.notEqual(restored.create({ tasks: [spec("later")] }).items[0].id, first.id);
});

test("restore rebuilds the Job order exactly as persisted, never grouped by actor", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    deliverMessage: adapter.deliverMessage,
  });
  const a = runtime.create({ tasks: [spec("a")] }).items[0];
  const b = runtime.create({ tasks: [spec("b")] }).items[0];
  adapter.handleFor(a.id).resolve({ result: "a done" });
  await runtime.jobDone(a.id);
  // A continuation for the earliest actor lands between two later actors: a
  // reload that regrouped Jobs by actor would move it next to its own actor
  // and lose the global creation chronology.
  const continuation = await runtime.sendMessage({ from: "Main", to: a.id, content: "more work" });
  const c = runtime.create({ tasks: [spec("c")] }).items[0];
  const created = [a.id, b.id, continuation.jobId, c.id];
  assert.deepEqual(runtime.jobs().jobs.map((job) => job.jobId), created);

  const state = stateOf(runtime);
  assert.deepEqual(state.jobs.map((job) => job.jobId), created);

  const restored = createSubagentRuntime({ startJob: createFakeAdapter().startJob });
  const summary = restored.restoreState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(summary.interrupted, [b.id, continuation.jobId, c.id]);
  assert.deepEqual(restored.jobs().jobs.map((job) => job.jobId), created);
  assert.deepEqual(restored.jobs().jobs.filter((job) => job.agentId === a.id).map((job) => job.jobId),
    [a.id, continuation.jobId]);
});

test("view failures cannot suppress a terminal notice or change the execution outcome", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverToMain: adapter.deliverToMain,
    finalizeJob() { throw new Error("view disk full"); },
    historyPaths() { throw new Error("view still unavailable"); },
  });
  const item = runtime.create({ tasks: [spec("view-failure")] }).items[0];
  adapter.handleFor(item.id).resolve({ result: "canonical result" });
  const done = await runtime.jobDone(item.id);
  await flush();
  assert.equal(done.status, "completed");
  assert.equal(done.historyState, "error");
  assert.equal(runtime.jobRecord(item.id).result, "canonical result");
  assert.equal(adapter.mainMessages.length, 1);
  assert.equal(adapter.mainMessages[0].status, "completed");
  assert.equal(adapter.mainMessages[0].history, null);
});

test("restored history paths are resolved by the adapter, not an in-memory transcript API", () => {
  const reads = [];
  const runtime = createSubagentRuntime({ startJob: createFakeAdapter().startJob,
    historyPaths(jobId) { reads.push(jobId); return { summary: `/views/${jobId}/summary.md`, cleanJsonl: `/views/${jobId}/transcript.jsonl` }; } });
  runtime.restoreState(validState());
  assert.equal(runtime.listDetailed({ id: "sub_01" }, { callerId: "Main" }).history.summary, "/views/sub_01/summary.md");
  assert.deepEqual(reads, ["sub_01"]);
  assert.equal("readRef" in runtime, false);
  assert.equal("readHistory" in runtime, false);
});
