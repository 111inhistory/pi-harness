import assert from "node:assert/strict";
import test from "node:test";

import { SubagentError, createSubagentRuntime as createRuntime } from "../src/subagent/runtime.ts";
import { STORAGE_VERSION, foldEvents } from "../src/subagent/storage.ts";
import { formatAddress, formatChildrenAddress, formatGroupAddress, parseAddress, parseActorKey } from "../src/subagent/address.ts";
import { DEFAULT_HARNESS_CONFIG } from "../src/harness-config.ts";

const SESSION = "a1b2c3d4";
const MAIN = formatAddress(SESSION, "main");
const address = (key) => formatAddress(SESSION, key);

const recordedEvents = new WeakMap();
function createSubagentRuntime(options = {}) {
  const events = [];
  const onEvent = options.onEvent;
  const runtime = createRuntime({
    session: SESSION,
    ...options,
    onEvent(event) {
      events.push(event);
      onEvent?.(event);
    },
  });
  recordedEvents.set(runtime, events);
  return runtime;
}
function stateOf(runtime) {
  return foldEvents(recordedEvents.get(runtime).map(({ type, ...data }) => ({
    type: "custom", customType: `subagent-${type}`, data: { v: STORAGE_VERSION, ...data },
  })));
}

/** One configured snapshot with the three admission limits overridden. */
function capacity(overrides) {
  return { ...DEFAULT_HARNESS_CONFIG, subagent: { ...DEFAULT_HARNESS_CONFIG.subagent, ...overrides } };
}

// Deterministic stand-in for the Pi adapter: every started Job is parked on a
// promise the test resolves by hand, so scheduling order is observable.
// `state.onDeliver` / `state.refuseDelivery` decide how a live hand-over
// behaves, including one that races the end of the run.
function createFakeAdapter(options = {}) {
  const started = [];
  const deliveries = [];
  const mainMessages = [];
  const interrupts = [];
  const state = {
    refuseDelivery: options.refuseDelivery === true,
    mainDeliveryFails: options.mainDeliveryFails === true,
    onDeliver: null,
    interrupt: options.interrupt ?? null,
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
  const interruptJob = async (input) => {
    interrupts.push(input);
    if (state.interrupt === null) return { ok: false, reason: "interrupt_unsupported" };
    return state.interrupt(input);
  };
  return { startJob, deliverMessage, deliverToMain, interruptJob, started, deliveries, mainMessages, interrupts, state, handleFor };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Deterministic clock for Budget observation and ephemeral activity times.
async function withFakeClock(run) {
  const clock = { now: 0 };
  Object.defineProperty(performance, "now", { configurable: true, writable: true, value: () => clock.now });
  try {
    return await run(clock);
  } finally {
    delete performance.now;
  }
}

/** One member: a goal and an optional display label. */
function member(goal, extra = {}) {
  return { goal: `do ${goal}`, ...(typeof extra === "string" ? { name: extra } : extra) };
}

function stop(runtime, target, from = MAIN) {
  return runtime.signal({ from, to: target, action: "stop" });
}

test("registers a minimal batch with stable identities and one launch roster", () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });

  const created = runtime.create({ agents: [member("solo")] });
  assert.equal(created.batch, 1);
  assert.equal(created.address, formatGroupAddress(SESSION, 1));
  assert.deepEqual(created.roster, [{ address: address("sub_1"), name: null, goal: "do solo" }]);
  const [item] = created.items;
  assert.deepEqual(item, { id: "sub_1", address: address("sub_1"), name: null, goal: "do solo" });
  assert.deepEqual(runtime.list().agents, [{
    agentId: "sub_1",
    address: address("sub_1"),
    name: null,
    goal: "do solo",
    batch: 1,
    parentAgentId: null,
    status: "running",
    depth: 1,
    kind: "fresh",
  }]);
  // A first Job shares its Actor's key; the Job owns no task text of its own.
  const [job] = runtime.jobs().jobs;
  assert.equal(job.jobId, "sub_1");
  assert.equal(job.address, address("sub_1"));
  assert.deepEqual(adapter.started[0].job.roster, created.roster);
  assert.equal(adapter.started[0].job.goal, "do solo");
  assert.equal(adapter.started[0].job.context, null);
  assert.equal(adapter.started[0].job.group, created.address);
  assert.equal(adapter.started[0].job.parentAddress, null);
  assert.deepEqual(adapter.started[0].job.spec, { kind: "initial", inheritedContext: null });

  const multi = runtime.create({ context: "shared background", agents: [member("one", "Alpha"), member("two")] });
  assert.equal(multi.batch, 2);
  assert.deepEqual(multi.roster.map((entry) => [entry.address, entry.name]), [
    [address("sub_2-1"), "Alpha"],
    [address("sub_2-2"), null],
  ]);
  assert.equal(adapter.started[2].job.context, "shared background");
  assert.equal(adapter.started[2].job.parentAddress, null);
  // Batches are session-wide monotonic identities, not a per-parent chain.
  assert.equal(runtime.create({ agents: [member("three")] }).batch, 3);
});

test("rejects malformed batches and every unknown member field atomically", () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const failing = [
    [null, "invalid_batch"],
    [{ agents: [] }, "invalid_batch"],
    [{ agents: [member("x")], extra: true }, "invalid_batch"],
    [{ context: 7, agents: [member("x")] }, "invalid_batch"],
    // The replaced task-batch framing is not an alias: it is an unknown field.
    [{ tasks: [{ task: "x" }] }, "invalid_batch"],
    [{ goal: "batch goal", agents: [member("x")] }, "invalid_batch"],
    [{ agents: ["not-an-object"] }, "invalid_task"],
    [{ agents: [{ goal: "  " }] }, "invalid_task"],
    [{ agents: [{ task: "x" }] }, "invalid_task"],
    [{ agents: [{ goal: "x", inheritContext: "yes" }] }, "invalid_task"],
    [{ agents: [{ goal: "x", name: "  " }] }, "invalid_task"],
    [{ agents: [{ goal: "x", future: true }] }, "invalid_task"],
    [{ agents: [{ goal: "x", responsibility: "y" }] }, "invalid_task"],
  ];
  for (const [batch, code] of failing) {
    assert.throws(() => runtime.create(batch), (error) => error instanceof SubagentError && error.code === code, JSON.stringify(batch));
  }
  assert.deepEqual(runtime.list(), { agents: [] });
  assert.equal(adapter.started.length, 0);
});

test("refuses inherited members without a snapshot source and inside inherited sessions", () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });

  assert.throws(
    () => runtime.create({ agents: [{ goal: "x", inheritContext: true }] }),
    (error) => error instanceof SubagentError && error.code === "inherited_snapshot_unavailable",
  );
  assert.throws(
    () => runtime.create(
      { agents: [{ goal: "x", inheritContext: true }] },
      { captureInheritedContext: () => { throw new Error("session is gone"); } },
    ),
    (error) => error instanceof SubagentError && error.code === "inherited_snapshot_failed",
  );

  const inheritedSession = createSubagentRuntime({ startJob: adapter.startJob, allowInherited: false });
  assert.throws(
    () => inheritedSession.create({ agents: [{ goal: "x", inheritContext: true }] }, { captureInheritedContext: () => snapshot0() }),
    (error) => error instanceof SubagentError && error.code === "inherited_not_allowed",
  );
  // A Fresh Subagent created from an inherited session still works.
  const created = inheritedSession.create({ agents: [member("fresh")] });
  assert.equal(created.items.length, 1);
  assert.equal(adapter.started.length, 1);
});

function snapshot0() {
  return { systemPrompt: "parent", tools: [], entries: [] };
}

test("gives each inherited child its own native containers over shared immutable history", () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  let captures = 0;
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
  const capture = { capturedAt: 1, cwd: "/work", systemPrompt: "parent", model: null, thinkingLevel: null, tools: ["read"],
    entries: [header, userEntry, assistantEntry] };

  const created = runtime.create(
    { agents: [{ goal: "one", inheritContext: true }, { goal: "two", inheritContext: true }] },
    { captureInheritedContext: () => { captures += 1; return capture; } },
  );
  assert.equal(created.items.length, 2);
  // One capture instant for the whole batch: siblings are not captured twice.
  assert.equal(captures, 1);

  const [snapshotA, snapshotB] = adapter.started.map((handle) => handle.job.spec.inheritedContext);
  assert.equal(bodyReads, 0, "creation must not serialize captured message bodies");
  assert.notEqual(snapshotA.entries, snapshotB.entries);
  assert.notEqual(snapshotA.entries, capture.entries);
  assert.notEqual(snapshotA.entries[0], capture.entries[0]);
  assert.equal(snapshotA.entries[1], userEntry);
  assert.equal(snapshotA.entries[2], assistantEntry);
  assert.equal(snapshotB.entries[1], userEntry);

  const headerIdOf = (snapshot) => snapshot.entries.find((entry) => entry.type === "session").id;
  assert.notEqual(headerIdOf(snapshotA), headerIdOf(snapshotB));
  assert.notEqual(headerIdOf(snapshotA), "session_parent");

  snapshotA.entries.push({ type: "message", id: "e3", parentId: "e2", timestamp: "2026-01-01T00:00:03.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "child-only" }] } });
  assert.equal(snapshotB.entries.length, 3);
  assert.equal(capture.entries.length, 3);

  // Lifecycle events carry seed metadata, never the captured native entries.
  const state = stateOf(runtime);
  assert.equal(state.jobs[0].spec.inheritedContext.entries, undefined);
  assert.equal(adapter.started[0].job.spec.inheritedContext, snapshotA);
  // Pool identity is recorded with the topology, not re-derived per Job.
  assert.deepEqual(state.actors.map((actor) => [actor.agentId, actor.kind]), [["sub_1-1", "inherited"], ["sub_1-2", "inherited"]]);
});

test("an inherited registration persists a model reference, not headers or live provider callbacks", () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const model = { provider: "test", id: "private-model", api: "test-api", headers: { Authorization: "private-credential" }, callback() {} };
  runtime.create({ agents: [{ goal: "inherit", inheritContext: true }] }, {
    captureInheritedContext: () => ({ model, entries: [], systemPrompt: "parent", tools: [] }),
  });
  const state = stateOf(runtime);
  assert.equal(state.jobs.length, 1);
  assert.deepEqual(state.jobs[0].spec.inheritedContext.model, { provider: "test", id: "private-model" });
  assert.equal(JSON.stringify(state).includes("private-credential"), false);
  assert.equal(adapter.started[0].job.spec.inheritedContext.model, model);
});

test("isolates failures to the failing job", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const items = runtime.create({ agents: [member("bad"), member("good")] }).items;

  adapter.handleFor(items[0].id).reject(new Error("model unreachable"));
  const failed = await runtime.jobDone(items[0].id);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.error, { code: "job_failed", message: "model unreachable" });
  assert.equal(runtime.jobs({ jobIds: [items[1].id] }).jobs[0].status, "running");

  adapter.handleFor(items[1].id).resolve({ result: "survived" });
  assert.equal((await runtime.jobDone(items[1].id)).status, "completed");
  assert.equal(runtime.jobRecord(items[1].id).result, "survived");
  assert.equal(runtime.jobRecord(items[0].id).result, null);
});

test("marks only the job whose start failed and rejects a non-handle", async () => {
  const adapter = createFakeAdapter();
  let starts = 0;
  const runtime = createSubagentRuntime({
    startJob: (job) => {
      starts += 1;
      if (starts === 1) throw new Error("cannot create session");
      return adapter.startJob(job);
    },
  });
  const created = runtime.create({ agents: [member("a"), member("b")] }).items;
  const failed = await runtime.jobDone(created[0].id);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.error, { code: "start_failed", message: "cannot create session" });
  assert.deepEqual(adapter.started.map((handle) => handle.job.jobId), [created[1].id]);

  const invalid = createSubagentRuntime({ startJob: () => undefined });
  const item = invalid.create({ agents: [member("a")] }).items[0];
  const snapshot = await invalid.jobDone(item.id);
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.error.code, "invalid_adapter");
});

test("cancellation during batch registration prevents the not-yet-started sibling from starting", async () => {
  const adapter = createFakeAdapter();
  let notStarted;
  const runtime = createSubagentRuntime({ startJob(request) {
    if (request.index === 0) {
      const sibling = runtime.jobs().jobs.find((job) => job.agentId === "sub_1-2");
      assert.equal(sibling.status, "running");
      notStarted = runtime.cancelJob(sibling.jobId);
    }
    return adapter.startJob(request);
  } });
  const items = runtime.create({ agents: [member("a"), member("b")] }).items;

  assert.equal(notStarted.ok, true);
  assert.equal(notStarted.job.status, "cancelled");
  assert.deepEqual(notStarted.job.error, { code: "cancelled", message: "Job cancelled before it started." });
  assert.deepEqual(await runtime.jobDone(items[1].id), notStarted.job);
  assert.equal(adapter.started.length, 1);
  assert.equal(runtime.cancelJob(items[1].id).reason, "already_finished");
  assert.throws(() => runtime.cancelJob("sub_9"), (error) => error instanceof SubagentError && error.code === "unknown_job");
});

test("a cancelled run keeps its Actor active without blocking its sibling", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const [first, sibling] = runtime.create({ agents: [member("a"), member("b")] }).items;

  const stopping = runtime.cancelJob(first.id);
  assert.equal(stopping.ok, true);
  assert.equal(stopping.job.status, "stopping");
  assert.equal(stopping.job.stopping, "cancelled");
  assert.equal(adapter.handleFor(first.id).cancelled, true);
  assert.equal(runtime.jobs({ jobIds: [sibling.id] }).jobs[0].status, "running");
  assert.equal(runtime.list().agents[0].status, "running");
  assert.equal(runtime.cancelJob(first.id).reason, "stopping");

  let settled = false;
  const pending = runtime.jobDone(first.id).then((view) => { settled = true; return view; });
  await flush();
  assert.equal(settled, false);

  adapter.handleFor(first.id).resolve({ result: "partial output" });
  const published = await pending;
  assert.equal(published.status, "cancelled");
  assert.deepEqual(published.error, { code: "cancelled", message: "Job cancelled while running." });
  assert.equal(published.budget.terminal.status, "cancelled");
  const record = runtime.jobRecord(first.id);
  assert.equal(record.status, "cancelled");
  assert.equal(record.result, "partial output");
  assert.equal(record.goal, "do a");
  assert.equal("messages" in record, false);
  assert.equal(runtime.cancelJob(first.id).reason, "already_finished");
});

test("serves isolated Job records and sealed bounds without owning transcripts", async () => {
  const adapter = createFakeAdapter();
  const ends = [];
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    onEvent: (event) => { if (event.type === "job-end") ends.push(event); },
  });
  const item = runtime.create({ agents: [member("read things", "reader")] }).items[0];
  const handle = adapter.handleFor(item.id);
  handle.job.recordStart("e0");
  assert.equal(runtime.jobRecord(item.id), null);
  handle.resolve({ result: { issues: [] }, transcript: [{ role: "assistant", content: "done" }],
    history: { startEntryId: "e0", endEntryId: "e2" } });
  await runtime.jobDone(item.id);
  const first = runtime.jobRecord(item.id);
  assert.equal(first.status, "completed");
  assert.equal(first.name, "reader");
  assert.equal(first.address, address(item.id));
  assert.deepEqual(first.history, { startEntryId: "e0", endEntryId: "e2" });
  first.result.issues.push("mutated by reader");
  first.history.endEntryId = "mutated";
  assert.deepEqual(runtime.jobRecord(item.id).result, { issues: [] });
  assert.equal(runtime.jobRecord(item.id).history.endEntryId, "e2");
  assert.equal("transcript" in first, false);
  assert.equal(runtime.jobRecord(address(item.id)), null);
  assert.throws(() => runtime.jobDone("sub_9"), (error) => error.code === "unknown_job");

  // A result the runtime cannot detach follows the normal failed-Job path.
  const uncloneable = runtime.create({ agents: [member("return a live handle")] }).items[0];
  adapter.handleFor(uncloneable.id).resolve({ result: () => "live" });
  const failed = await runtime.jobDone(uncloneable.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "invalid_result");
  assert.equal(ends.find((event) => event.jobId === uncloneable.id).result, null);
  assert.equal(runtime.list().agents.find((agent) => agent.agentId === uncloneable.id).status, "idle");

  // Unsupported optional error detail is omitted instead of shared.
  const throwing = runtime.create({ agents: [member("throwing")] }).items[0];
  adapter.handleFor(throwing.id).reject({ message: "adapter failed", detail: { live: () => "handle" } });
  const failedError = await runtime.jobDone(throwing.id);
  assert.equal(failedError.error.code, "job_failed");
  assert.equal("detail" in failedError.error, false);
});

test("enforces the three per-parent limits independently and atomically", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    config: capacity({ maxActiveBatches: 2, maxActiveSubagents: 3, maxActiveInheritedSubagents: 1 }),
  });

  // Two batches, three Actors: the batch limit is full and the Actor limit is
  // exactly full.
  const first = runtime.create({ agents: [member("a"), member("b")] }).items;
  const second = runtime.create({ agents: [member("c")] }).items;
  assert.deepEqual(runtime.list().agents.map((agent) => agent.batch), [1, 1, 2]);

  assert.throws(
    () => runtime.create({ agents: [member("third batch")] }),
    (error) => error instanceof SubagentError && error.code === "batch_limit_exceeded"
      && error.detail.activeBatches === 2 && error.detail.maxActiveBatches === 2,
  );
  // Once batch 2 exits, one batch slot is free; the new Actor also uses the
  // still-available third Actor slot.
  adapter.handleFor(second[0].id).resolve({ result: "done" });
  await runtime.jobDone(second[0].id);
  const third = runtime.create({ agents: [member("third")] });
  assert.equal(third.batch, 3);
  assert.equal(runtime.list().agents.filter((agent) => agent.status === "running").length, 3);

  // The Actor cap is checked independently of the batch cap.
  const childCapped = createSubagentRuntime({
    startJob: createFakeAdapter().startJob,
    config: capacity({ maxActiveBatches: 4, maxActiveSubagents: 3, maxActiveInheritedSubagents: 1 }),
  });
  childCapped.create({ agents: [member("one"), member("two"), member("three")] });
  assert.throws(
    () => childCapped.create({ agents: [member("fourth")] }),
    (error) => error instanceof SubagentError && error.code === "subagent_limit_exceeded"
      && error.detail.activeChildren === 3 && error.detail.maxActiveSubagents === 3,
  );

  // Inherited members have their own subset limit.
  const inherited = createSubagentRuntime({
    startJob: adapter.startJob,
    config: capacity({ maxActiveInheritedSubagents: 1 }),
  });
  inherited.create({ agents: [{ goal: "one", inheritContext: true }] }, { captureInheritedContext: () => snapshot0() });
  assert.throws(
    () => inherited.create({ agents: [{ goal: "two", inheritContext: true }] }, { captureInheritedContext: () => snapshot0() }),
    (error) => error instanceof SubagentError && error.code === "inherited_limit_exceeded"
      && error.detail.activeInherited === 1 && error.detail.maxActiveInheritedSubagents === 1,
  );
  // A Fresh child of the same parent is still admitted.
  inherited.create({ agents: [member("fresh")] });

  // The limits count direct children of one parent, not the whole session.
  const nested = runtime.create({ agents: [member("nested")] }, { parentAgentId: first[0].id }).items[0];
  assert.equal(runtime.list().agents.find((agent) => agent.agentId === nested.id).depth, 2);
  assert.throws(
    () => runtime.create({ agents: [member("too-deep")] }, { parentAgentId: nested.id }),
    (error) => error instanceof SubagentError && error.code === "max_depth_exceeded",
  );
  assert.throws(
    () => runtime.create({ agents: [member("unknown-parent")] }, { parentAgentId: "sub_9" }),
    (error) => error instanceof SubagentError && error.code === "unknown_parent",
  );
});

test("a stopped Actor releases its slots only after the native run exits", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    config: capacity({ maxActiveBatches: 1, maxActiveSubagents: 2, maxActiveInheritedSubagents: 1 }),
  });
  const [first] = runtime.create({ agents: [member("a")] }).items;

  const signal = await stop(runtime, address(first.id));
  assert.equal(signal.ok, true);
  assert.deepEqual(signal.targets, [{ address: address(first.id), ok: true, status: "stopping" }]);
  // Stopping still occupies the batch and the Actor slot.
  assert.throws(
    () => runtime.create({ agents: [member("c")] }),
    (error) => error instanceof SubagentError && error.code === "batch_limit_exceeded",
  );
  adapter.handleFor(first.id).resolve({ result: "partial" });
  await runtime.jobDone(first.id);
  // After the real exit the next batch is admitted.
  const later = runtime.create({ agents: [member("c")] });
  assert.equal(later.batch, 2);
});

test("revival re-checks the batch and total limits of its parent", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    deliverMessage: adapter.deliverMessage,
    config: capacity({ maxActiveBatches: 1, maxActiveSubagents: 2, maxActiveInheritedSubagents: 1 }),
  });
  const [idle] = runtime.create({ agents: [member("first")] }).items;
  adapter.handleFor(idle.id).resolve({ result: "done" });
  await runtime.jobDone(idle.id);
  const live = runtime.create({ agents: [member("second")] }).items[0];

  // The Actor's batch is not live any more, so a revival would open a second
  // live batch while one is already running: refused before any Job exists.
  await assert.rejects(
    runtime.sendMessage({ from: MAIN, to: address(idle.id), content: "wake up" }),
    (error) => error instanceof SubagentError && error.code === "batch_limit_exceeded",
  );
  assert.equal(runtime.jobs().jobs.length, 2);

  // Once the live batch finished, the same explicit write is admitted.
  adapter.handleFor(live.id).resolve({ result: "done" });
  await runtime.jobDone(live.id);
  const admitted = await runtime.sendMessage({ from: MAIN, to: address(idle.id), content: "wake up" });
  const revived = adapter.handleFor(admitted.jobId);
  assert.equal(revived.job.continuedFromJobId, idle.id);
  assert.equal(revived.job.spec.kind, "continuation");
  assert.equal(revived.job.goal, "do first");
  assert.deepEqual(revived.job.roster, [{ address: address(idle.id), name: null, goal: "do first" }]);
  assert.deepEqual(revived.job.pendingMessages, [{ type: "message", from: MAIN, content: "wake up" }]);
  assert.equal(revived.job.budget.snapshot().modelCalls, 0);
});

test("surfaces exhausted budgets without exposing profile limits", async () => {
  const runtime = createSubagentRuntime({
    startJob(job) {
      for (let call = 1; call <= 201; call += 1) job.budget.beginModelCall();
      return { done: Promise.reject(new Error("provider call should not start")) };
    },
  });
  const item = runtime.create({ agents: [member("bounded")] }).items[0];
  const failed = await runtime.jobDone(item.id);
  assert.equal(failed.error.code, "budget_exceeded");
  assert.equal("detail" in failed.error, false);
  assert.equal(failed.budget.modelCalls, 200);
  assert.equal(failed.budget.rejectedProjectedModelCalls, 201);
  assert.equal("profile" in failed.budget, false);
});

test("an observed active-time failure stops only its Actor until the handle exits", async () => {
  await withFakeClock(async (clock) => {
    const adapter = createFakeAdapter();
    const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverToMain: adapter.deliverToMain });
    const [first, sibling] = runtime.create({ agents: [member("a"), member("b")] }).items;
    const handle = adapter.handleFor(first.id);

    const healthy = handle.job.checkBudget();
    assert.equal(healthy.terminal, null);
    assert.equal(handle.cancelCount, 0);

    clock.now = 120 * 60 * 1000;
    const verdict = handle.job.checkBudget();
    assert.equal(verdict.terminal.status, "failed");
    assert.equal(verdict.terminal.error.code, "budget_exceeded");
    assert.equal(handle.cancelCount, 1);
    assert.equal(runtime.jobs({ jobIds: [first.id] }).jobs[0].status, "stopping");
    assert.equal(runtime.list().agents[0].status, "running");
    await assert.rejects(
      runtime.sendMessage({ from: MAIN, to: address(first.id), content: "still there?" }),
      (error) => error instanceof SubagentError && error.code === "agent_busy",
    );
    assert.deepEqual(adapter.mainMessages, []);

    assert.deepEqual(handle.job.checkBudget(), verdict);
    assert.equal(handle.cancelCount, 1);

    handle.resolve({ result: "partial output" });
    const failed = await runtime.jobDone(first.id);
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.error, { code: "budget_exceeded", message: "Job execution budget exhausted." });
    assert.equal(runtime.jobRecord(first.id).result, "partial output");
    // No model-facing completion is synthesized for a settled Job.
    assert.deepEqual(adapter.mainMessages, []);
  });
});

test("a Budget failure observed before the native handle exists is never lost or doubled", async () => {
  await withFakeClock(async (clock) => {
    const adapter = createFakeAdapter();
    const runtime = createSubagentRuntime({
      startJob(request) {
        clock.now = 120 * 60 * 1000;
        assert.equal(request.checkBudget().terminal.status, "failed");
        return adapter.startJob(request);
      },
    });
    const item = runtime.create({ agents: [member("sync")] }).items[0];
    const handle = adapter.handleFor(item.id);
    assert.equal(handle.cancelCount, 1);
    assert.equal(runtime.jobs({ jobIds: [item.id] }).jobs[0].status, "stopping");
    handle.resolve({ result: "partial output" });
    const failed = await runtime.jobDone(item.id);
    assert.deepEqual(failed.error, { code: "budget_exceeded", message: "Job execution budget exhausted." });
    assert.equal(handle.cancelCount, 1);
  });

  await withFakeClock(async (clock) => {
    const runtime = createSubagentRuntime({
      startJob(request) {
        clock.now = 120 * 60 * 1000;
        assert.equal(request.checkBudget().terminal.status, "failed");
        throw new Error("startup aborted");
      },
    });
    const item = runtime.create({ agents: [member("sync throw")] }).items[0];
    const failed = await runtime.jobDone(item.id);
    assert.deepEqual(failed.error, { code: "budget_exceeded", message: "Job execution budget exhausted." });
    assert.equal(runtime.list().agents[0].status, "idle");
  });
});

test("buffers a message during batch registration until the recipient starts", async () => {
  const adapter = createFakeAdapter();
  let receipt;
  const runtime = createSubagentRuntime({
    startJob(request) {
      if (request.index === 0) {
        const sibling = runtime.jobs().jobs.find((job) => job.agentId === "sub_1-2");
        receipt = runtime.sendMessage({ from: MAIN, to: address(sibling.agentId), content: "start with the tests" });
      }
      return adapter.startJob(request);
    },
    deliverMessage: adapter.deliverMessage,
  });
  const items = runtime.create({ agents: [member("a"), member("b")] }).items;
  const [first, second] = items;

  receipt = await receipt;
  assert.deepEqual(receipt, { ok: true, to: address(second.id), jobId: second.id });
  assert.deepEqual(adapter.deliveries, []);

  adapter.handleFor(first.id).resolve({ result: "one" });
  await runtime.jobDone(first.id);
  assert.deepEqual(adapter.handleFor(second.id).job.pendingMessages,
    [{ type: "message", from: MAIN, content: "start with the tests" }]);

  const later = await runtime.sendMessage({ from: MAIN, to: address(second.id), content: "and the docs" });
  assert.deepEqual(later, { ok: true, to: address(second.id), jobId: second.id });
  assert.deepEqual(adapter.deliveries, [
    { agentId: second.id, jobId: second.id, message: { type: "message", from: MAIN, content: "and the docs" } },
  ]);
});

test("rejects unknown senders and targets, invalid messages and sender spoofing", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    deliverMessage: adapter.deliverMessage,
    deliverToMain: adapter.deliverToMain,
  });
  const item = runtime.create({ agents: [member("a")] }).items[0];
  const rejects = (promise, code) =>
    assert.rejects(promise, (error) => error instanceof SubagentError && error.code === code);

  await rejects(runtime.sendMessage({ from: MAIN, to: address("sub_99"), content: "hello" }), "unknown_agent");
  await rejects(runtime.sendMessage({ from: address("sub_99"), to: address(item.id), content: "hello" }), "unknown_sender");
  await rejects(runtime.sendMessage({ from: "bob", to: address(item.id), content: "hello" }), "unknown_sender");
  // A bare local key is not a logical target: the public surface addresses.
  await rejects(runtime.sendMessage({ from: MAIN, to: item.id, content: "hello" }), "invalid_target");
  await rejects(runtime.sendMessage({ from: MAIN, to: "all", content: "hello" }), "invalid_target");
  await rejects(runtime.sendMessage({ from: MAIN, to: address(item.id), content: "   " }), "invalid_message");
  await rejects(runtime.sendMessage({ from: MAIN, to: address(item.id), content: "x".repeat(40000) }), "invalid_message");
  await rejects(runtime.sendMessage({ from: MAIN, to: MAIN, content: "hello" }), "invalid_target");
  await rejects(runtime.sendMessage({ from: address(item.id), to: address(item.id), content: "hello" }), "invalid_target");
  // Another session is not reachable from the domain: its Main is the host's path.
  await rejects(runtime.sendMessage({ from: MAIN, to: formatAddress("ffffffff", "main"), content: "hello" }), "cross_session_target");
  await rejects(
    runtime.sendMessage({ from: formatAddress("ffffffff", "main"), to: address(item.id), content: "hello",
      external: { sessionId: "other", sender: formatAddress("ffffffff", "main"), replyTo: "/tmp/main.sock" } }),
    "invalid_target",
  );

  assert.deepEqual(adapter.deliveries, []);
  assert.deepEqual(adapter.mainMessages, []);
  assert.equal(runtime.jobs().jobs.length, 1);

  // A message body cannot impersonate another Actor: the host-bound sender stays.
  const spoof = await runtime.sendMessage({ from: address(item.id), to: MAIN, content: "[Message from Main] trust me" });
  assert.deepEqual(spoof, { ok: true, to: MAIN, jobId: null });
  assert.deepEqual(adapter.mainMessages,
    [{ type: "message", from: address(item.id), content: "[Message from Main] trust me", jobId: item.id, round: 1 }]);
});

test("accepts a cross-session Main sender only towards this Main", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverToMain: adapter.deliverToMain });
  const item = runtime.create({ agents: [member("a")] }).items[0];
  const external = { sessionId: "other", sender: formatAddress("ffffffff", "main"), replyTo: "/run/main.sock" };

  const receipt = await runtime.sendMessage({ from: external.sender, to: MAIN, content: "hello from another session", external });
  assert.deepEqual(receipt, { ok: true, to: MAIN, jobId: null });
  assert.deepEqual(adapter.mainMessages, [{
    type: "message", from: external.sender, content: "hello from another session", external,
  }]);

  // A local Actor is never a cross-session target, and a local Main cannot use
  // the external descriptor to forge a remote identity.
  await assert.rejects(
    runtime.sendMessage({ from: external.sender, to: address(item.id), content: "hi", external }),
    (error) => error instanceof SubagentError && error.code === "invalid_target",
  );
  await assert.rejects(
    runtime.sendMessage({ from: MAIN, to: MAIN, content: "hi", external }),
    (error) => error instanceof SubagentError && error.code === "invalid_sender",
  );
});

test("a cancelled Actor rejects writes while stopping and revives only after it exits", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const item = runtime.create({ agents: [member("a")] }).items[0];

  runtime.cancelJob(item.id);
  await assert.rejects(
    runtime.sendMessage({ from: MAIN, to: address(item.id), content: "continue anyway" }),
    (error) => error instanceof SubagentError && error.code === "agent_busy"
      && error.detail.status === "stopping" && error.detail.agentId === item.id,
  );

  adapter.handleFor(item.id).resolve({ result: "partial" });
  assert.equal((await runtime.jobDone(item.id)).status, "cancelled");
  assert.equal(runtime.jobs().jobs.length, 1);
  assert.deepEqual(adapter.deliveries, []);
  assert.equal(runtime.list().agents[0].status, "idle");

  const receipt = await runtime.sendMessage({ from: MAIN, to: address(item.id), content: "continue anyway" });
  const revived = adapter.handleFor(receipt.jobId);
  assert.equal(revived.job.continuedFromJobId, item.id);
  assert.deepEqual(revived.job.pendingMessages, [{ type: "message", from: MAIN, content: "continue anyway" }]);
});

test("a write that races a closing run either revives it or reports the successor state", async () => {
  const busyAdapter = createFakeAdapter({ refuseDelivery: true });
  const busyRuntime = createSubagentRuntime({ startJob: busyAdapter.startJob, deliverMessage: busyAdapter.deliverMessage });
  const busyItem = busyRuntime.create({ agents: [member("a")] }).items[0];
  await assert.rejects(
    busyRuntime.sendMessage({ from: MAIN, to: address(busyItem.id), content: "late message" }),
    (error) => error instanceof SubagentError && error.code === "agent_busy" && error.detail.status === "running",
  );
  assert.equal(busyRuntime.jobs().jobs.length, 1);

  const raceAdapter = createFakeAdapter();
  const raceRuntime = createSubagentRuntime({ startJob: raceAdapter.startJob, deliverMessage: raceAdapter.deliverMessage });
  const raceItem = raceRuntime.create({ agents: [member("a")] }).items[0];
  raceAdapter.state.onDeliver = ({ handle }) => {
    handle.resolve({ result: "done while the write was in flight" });
    return { accepted: false, reason: "job_closed" };
  };

  const receipt = await raceRuntime.sendMessage({ from: MAIN, to: address(raceItem.id), content: "late message" });
  assert.equal(receipt.ok, true);
  assert.notEqual(receipt.jobId, raceItem.id);
  assert.equal(raceRuntime.jobs().jobs.length, 2);
  const revived = raceAdapter.handleFor(receipt.jobId);
  assert.equal(revived.job.continuedFromJobId, raceItem.id);
  assert.equal(raceRuntime.jobRecord(raceItem.id).result, "done while the write was in flight");
});

test("rejects a write that arrives before any delivery hook is wired", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const item = runtime.create({ agents: [member("a")] }).items[0];

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runtime.sendMessage({ from: MAIN, to: address(item.id), content: "never sent", signal: controller.signal }),
    (error) => error instanceof SubagentError && error.code === "aborted",
  );
  assert.deepEqual(adapter.deliveries, []);

  const noHook = createSubagentRuntime({ startJob: adapter.startJob });
  const items = noHook.create({ agents: [member("a"), member("b")] }).items;
  await assert.rejects(
    noHook.sendMessage({ from: MAIN, to: address(items[0].id), content: "held" }),
    (error) => error instanceof SubagentError && error.code === "agent_busy",
  );
  await assert.rejects(
    noHook.sendMessage({ from: address(items[0].id), to: MAIN, content: "hello" }),
    (error) => error instanceof SubagentError && error.code === "delivery_unavailable",
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
  const item = runtime.create({ agents: [member("a")] }).items[0];

  const receipt = await runtime.sendMessage({ from: address(item.id), to: MAIN, content: "audit finished" });
  assert.deepEqual(receipt, { ok: true, to: MAIN, jobId: null });
  assert.deepEqual(adapter.mainMessages, [{ type: "message", from: address(item.id), content: "audit finished", jobId: item.id, round: 1 }]);

  const failing = createFakeAdapter({ mainDeliveryFails: true });
  const failingRuntime = createSubagentRuntime({ startJob: failing.startJob, deliverToMain: failing.deliverToMain });
  const failingItem = failingRuntime.create({ agents: [member("a")] }).items[0];
  await assert.rejects(
    failingRuntime.sendMessage({ from: address(failingItem.id), to: MAIN, content: "hello" }),
    (error) => error instanceof SubagentError && error.code === "delivery_failed" && /main session unavailable/.test(error.message),
  );

  // A settled Job never needs a delivery hook and never notifies a model.
  const silentAdapter = createFakeAdapter();
  const silent = createSubagentRuntime({ startJob: silentAdapter.startJob });
  const silentItem = silent.create({ agents: [member("a")] }).items[0];
  silentAdapter.handleFor(silentItem.id).resolve({ result: "done" });
  assert.equal((await silent.jobDone(silentItem.id)).status, "completed");
  assert.deepEqual(silentAdapter.mainMessages, []);
});

test("broadcast filters the sender, reports per-recipient failures and allows zero recipients", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const roots = runtime.create({ agents: [member("a"), member("b"), member("c")] }).items;

  adapter.state.onDeliver = ({ handle }) => (handle.job.jobId === roots[1].id ? { accepted: false, reason: "job_closed" } : { accepted: true });
  const partial = await runtime.sendMessage({ from: MAIN, to: formatChildrenAddress(SESSION, "main"), content: "report in" });
  assert.equal(partial.ok, false);
  assert.equal(partial.to, formatChildrenAddress(SESSION, "main"));
  assert.deepEqual(partial.sent.map((entry) => entry.to), [address(roots[0].id), address(roots[2].id)]);
  assert.deepEqual(partial.errors.map((entry) => [entry.to, entry.code]), [[address(roots[1].id), "agent_busy"]]);

  // A leaf Actor has no direct children: the broadcast is empty, not an error.
  adapter.state.onDeliver = null;
  const empty = await runtime.sendMessage({ from: address(roots[0].id), to: formatChildrenAddress(SESSION, roots[0].id), content: "hello?" });
  assert.deepEqual(empty, { ok: true, to: formatChildrenAddress(SESSION, roots[0].id), sent: [], errors: [] });

  // The batch selector reaches every member of that batch, never Main.
  const group = runtime.create({ agents: [member("d"), member("e")] });
  const sent = await runtime.sendMessage({ from: MAIN, to: group.address, content: "status?" });
  assert.deepEqual(sent.sent.map((entry) => entry.to), group.roster.map((entry) => entry.address));
  // A member of the group does not receive its own broadcast.
  const fromMember = await runtime.sendMessage({ from: group.roster[0].address, to: group.address, content: "status?" });
  assert.deepEqual(fromMember.sent.map((entry) => entry.to), [group.roster[1].address]);
});

test("a label is not an address and an Actor is reached by its address only", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const labeled = runtime.create({ agents: [member("do things", "all")] }).items[0];

  await assert.rejects(
    runtime.sendMessage({ from: MAIN, to: "all", content: "status?" }),
    (error) => error instanceof SubagentError && error.code === "invalid_target",
  );
  assert.equal(parseAddress("all"), null);
  assert.equal(parseActorKey("main").key, "main");
  assert.equal(runtime.jobRecord("all"), null);
  const receipt = await runtime.sendMessage({ from: MAIN, to: address(labeled.id), content: "status?" });
  assert.deepEqual(receipt, { ok: true, to: address(labeled.id), jobId: labeled.id });
  adapter.handleFor(labeled.id).resolve({ result: "done" });
  await runtime.jobDone(labeled.id);
  assert.equal(runtime.jobRecord(labeled.id).name, "all");
});

test("carries inherited warnings on the entry, the Job view and a restored registry", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const warning = "Not transplantable through Pi's public API, so the inherited child does not have them: mystery.";
  const snapshot = { systemPrompt: "parent", tools: ["read"], entries: [], warnings: [warning] };

  const fresh = runtime.create({ agents: [member("fresh")] }).items[0];
  assert.equal("warnings" in fresh, false);
  const created = runtime.create({ agents: [{ goal: "inherit", inheritContext: true }] }, { captureInheritedContext: () => snapshot });
  assert.deepEqual(created.warnings, [warning]);
  assert.deepEqual(created.items[0].warnings, [warning]);
  assert.deepEqual(runtime.jobs({ jobIds: [created.items[0].id] }).jobs[0].warnings, [warning]);

  adapter.handleFor(created.items[0].id).resolve({ result: "done" });
  await runtime.jobDone(created.items[0].id);
  const revived = await runtime.sendMessage({ from: MAIN, to: address(created.items[0].id), content: "more" });
  assert.deepEqual(runtime.jobs({ jobIds: [revived.jobId] }).jobs[0].warnings, [warning]);

  const state = JSON.parse(JSON.stringify(stateOf(runtime)));
  const restored = createSubagentRuntime({ startJob: createFakeAdapter().startJob });
  restored.restoreState(state);
  assert.deepEqual(restored.jobs({ jobIds: [created.items[0].id] }).jobs[0].warnings, [warning]);
});

test("emits lifecycle deltas once and never during read-only polls", async () => {
  const adapter = createFakeAdapter();
  const events = [];
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage,
    onEvent: (event) => events.push(event) });
  const item = runtime.create({ agents: [member("a")] }).items[0];
  assert.deepEqual(events.map((event) => event.type), ["job"]);
  assert.deepEqual(events[0].actor, {
    name: null, parentAgentId: null, depth: 1, batch: 1, member: null, goal: "do a", context: null,
    roster: [{ id: "sub_1", name: null, goal: "do a" }], kind: "fresh",
  });
  runtime.list(); runtime.jobs(); runtime.jobDone(item.id); runtime.jobRecord(item.id);
  await runtime.sendMessage({ from: MAIN, to: address(item.id), content: "status?" });
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
  assert.equal(runtime.list().agents[0].name, null);
  assert.equal(runtime.jobRecord(item.id).status, "completed");
  assert.deepEqual(adapter.mainMessages, []);
});

test("a failing persistence hook can never change a Job outcome", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    onEvent: () => { throw new Error("disk full"); },
  });
  const item = runtime.create({ agents: [member("a")] }).items[0];
  adapter.handleFor(item.id).resolve({ result: "done" });
  const terminal = await runtime.jobDone(item.id);
  assert.equal(terminal.status, "completed");
  assert.equal(runtime.jobRecord(item.id).result, "done");
});

test("signal stops one Actor, keeps its identity and refuses a direct self-signal", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const [first, second] = runtime.create({ agents: [member("a"), member("b")] }).items;

  const result = await stop(runtime, address(first.id));
  assert.deepEqual(result, { ok: true, action: "stop", to: address(first.id), targets: [{ address: address(first.id), ok: true, status: "stopping" }] });
  adapter.handleFor(first.id).resolve({ result: "partial" });
  await runtime.jobDone(first.id);
  const idle = await stop(runtime, address(first.id));
  assert.deepEqual(idle.targets, [{ address: address(first.id), ok: true, status: "idle" }]);

  const group = await stop(runtime, formatGroupAddress(SESSION, 1));
  assert.equal(group.action, "stop");
  assert.deepEqual(group.targets.map((entry) => [entry.address, entry.status]), [
    [address(first.id), "idle"],
    [address(second.id), "stopping"],
  ]);
  assert.deepEqual(group.targets.map((entry) => entry.ok), [true, true]);

  await assert.rejects(runtime.signal({ from: address(second.id), to: address(second.id), action: "stop" }),
    (error) => error instanceof SubagentError && error.code === "invalid_target");
  await assert.rejects(runtime.signal({ from: MAIN, to: address(second.id), action: "reboot" }),
    (error) => error instanceof SubagentError && error.code === "invalid_request");
  await assert.rejects(runtime.signal({ from: MAIN, to: address("sub_99"), action: "stop" }),
    (error) => error instanceof SubagentError && error.code === "unknown_agent");
});

test("interrupt keeps the Job and the goal alive or reports the missing capability", async () => {
  const adapter = createFakeAdapter();
  const interrupted = [];
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    interruptJob: async (input) => { interrupted.push(input); return { ok: true }; },
  });
  const item = runtime.create({ agents: [member("a")] }).items[0];

  const accepted = await runtime.signal({ from: MAIN, to: address(item.id), action: "interrupt" });
  assert.deepEqual(accepted, { ok: true, action: "interrupt", to: address(item.id), targets: [{ address: address(item.id), ok: true, status: "running" }] });
  assert.deepEqual(interrupted, [{ agentId: item.id, jobId: item.id, address: address(item.id), from: MAIN }]);
  // The Job, its Actor and its goal are untouched: no Job was created or ended.
  assert.equal(runtime.jobs().jobs.length, 1);
  assert.equal(runtime.jobs().jobs[0].status, "running");
  assert.equal(runtime.list().agents[0].goal, "do a");

  // Without the capability the runtime reports the refusal and changes nothing.
  const plain = createSubagentRuntime({ startJob: adapter.startJob });
  const plainItem = plain.create({ agents: [member("b")] }).items[0];
  const refused = await plain.signal({ from: MAIN, to: address(plainItem.id), action: "interrupt" });
  assert.deepEqual(refused.targets, [{ address: address(plainItem.id), ok: false, status: "running", reason: "interrupt_unsupported" }]);
  assert.equal(plain.jobs().jobs[0].status, "running");

  // A capability that refuses, and one that throws, are both truthful refusals.
  const refusing = createFakeAdapter({ interrupt: () => ({ ok: false, reason: "run_abort_unavailable" }) });
  const refusingRuntime = createSubagentRuntime({ startJob: refusing.startJob, interruptJob: refusing.interruptJob });
  const refusingItem = refusingRuntime.create({ agents: [member("c")] }).items[0];
  const refusal = await refusingRuntime.signal({ from: MAIN, to: address(refusingItem.id), action: "interrupt" });
  assert.deepEqual(refusal.targets, [{ address: address(refusingItem.id), ok: false, status: "running", reason: "run_abort_unavailable" }]);
  const throwing = createSubagentRuntime({ startJob: adapter.startJob, interruptJob: () => { throw new Error("no live run"); } });
  const throwingItem = throwing.create({ agents: [member("d")] }).items[0];
  const thrown = await throwing.signal({ from: MAIN, to: address(throwingItem.id), action: "interrupt" });
  assert.deepEqual(thrown.targets, [{ address: address(throwingItem.id), ok: false, status: "running", reason: "interrupt_failed" }]);

  // Interrupting an idle Actor is not a stop.
  const idleAdapter = createFakeAdapter();
  const idle = createSubagentRuntime({ startJob: idleAdapter.startJob, interruptJob: async () => ({ ok: true }) });
  const idleItem = idle.create({ agents: [member("e")] }).items[0];
  idleAdapter.handleFor(idleItem.id).resolve({ result: "done" });
  await idle.jobDone(idleItem.id);
  const idleTarget = await idle.signal({ from: MAIN, to: address(idleItem.id), action: "interrupt" });
  assert.deepEqual(idleTarget.targets, [{ address: address(idleItem.id), ok: false, status: "idle", reason: "not_running" }]);
  assert.equal(idle.jobs().jobs.length, 1);

  // A stop that wins while the adapter is aborting cannot become a stale
  // successful interrupt once that adapter finally acknowledges the request.
  let finishInterrupt;
  const racingAdapter = createFakeAdapter();
  const racing = createSubagentRuntime({
    startJob: racingAdapter.startJob,
    interruptJob: () => new Promise(resolve => { finishInterrupt = resolve; }),
  });
  const racingItem = racing.create({ agents: [member("racing")] }).items[0];
  const inFlight = racing.signal({ from: MAIN, to: address(racingItem.id), action: "interrupt" });
  await racing.signal({ from: MAIN, to: address(racingItem.id), action: "stop" });
  finishInterrupt({ ok: true });
  const raced = await inFlight;
  assert.equal(raced.targets[0].ok, false);
  assert.equal(raced.targets[0].status, "stopping");
  assert.equal(raced.targets[0].reason, "stopping");
  racingAdapter.handleFor(racingItem.id).resolve({ result: null });
  await racing.jobDone(racingItem.id);
});

test("the list projection omits the goal, activity and model while execution keeps its goal", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });
  const [first] = runtime.create({ agents: [member("a")] }).items;
  const node = () => runtime.listDetailed({ id: first.id }, { callerId: MAIN });

  const omitted = (item) => ["goal", "activity", "model"].filter((field) => field in item);
  assert.deepEqual(omitted(node()), [], "a list node carries identity and topology only");
  assert.equal(node().address, address(first.id));

  // The persistent goal and the Job lifecycle stay internal and observable
  // through their own projections, independently of the list node.
  assert.equal(runtime.list().agents[0].goal, "do a");
  adapter.handleFor(first.id).resolve({ result: "done" });
  await runtime.jobDone(first.id);
  assert.equal(runtime.jobs().jobs[0].status, "completed");
  assert.equal(runtime.jobRecord(first.id).goal, "do a");
  assert.deepEqual(omitted(node()), []);
});

test("parent-hold wakes stay internal and never synthesize a collaborator result", async () => {
  const adapter = createFakeAdapter();
  const wakes = [];
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    deliverMessage: adapter.deliverMessage,
    deliverToMain: adapter.deliverToMain,
    onChildrenSettled: (parentId) => wakes.push(parentId),
  });
  const [parent] = runtime.create({ agents: [member("parent")] }).items;
  const child = runtime.create({ agents: [member("child")] }, { parentAgentId: parent.id }).items[0];

  adapter.handleFor(child.id).resolve({ result: "child result" });
  await runtime.jobDone(child.id);
  await flush();
  assert.deepEqual(wakes, [parent.id]);
  assert.deepEqual(adapter.deliveries, []);
  assert.deepEqual(adapter.mainMessages, []);
  // The child's outcome stays durable and readable without a model notice.
  assert.equal(runtime.jobRecord(child.id).result, "child result");
});

function validState() {
  const roster = [{ id: "sub_1", name: "kept", goal: "kept work" }];
  return {
    actors: [{ agentId: "sub_1", name: "kept", parentAgentId: null, depth: 1, batch: 1, member: null,
      goal: "kept work", context: null, roster, kind: "fresh", stoppedOrder: 1 }],
    jobs: [{ jobId: "sub_1", agentId: "sub_1", createdBy: "main", continuedFromJobId: null,
      spec: { kind: "initial", inheritedContext: null },
      end: { status: "completed", result: "kept result", error: null,
        history: { startEntryId: "e0", endEntryId: "e2" }, budget: null } }],
  };
}

test("rejects malformed folded topology, batch identity, ownership and terminal states", () => {
  const corrupt = (mutate) => {
    const state = validState();
    mutate(state);
    const runtime = createSubagentRuntime({ startJob: createFakeAdapter().startJob });
    assert.throws(() => runtime.restoreState(state), (error) => error.code === "invalid_state");
    assert.deepEqual(runtime.list(), { agents: [] }, "failed restore cannot partially adopt actors");
  };
  for (const id of ["all", "main", "sub_01", "sub_1-1"]) corrupt((state) => { state.actors[0].agentId = id; });
  corrupt((state) => { state.actors = "no"; });
  corrupt((state) => { state.jobs = {}; });
  corrupt((state) => { state.actors[0].parentAgentId = "sub_9"; });
  corrupt((state) => { state.actors[0].depth = 2; });
  corrupt((state) => { state.actors[0].batch = 2; });
  corrupt((state) => { state.actors[0].member = 1; });
  corrupt((state) => { state.actors[0].roster[0].goal = "wrong goal"; });
  corrupt((state) => { state.actors[0].roster[0].id = "sub_9"; });
  corrupt((state) => { delete state.actors[0].roster[0].id; });
  corrupt((state) => { state.actors[0].roster[0].address = address("sub_1"); });
  corrupt((state) => { state.actors[0].goal = " "; });
  corrupt((state) => { delete state.actors[0].kind; });
  corrupt((state) => { state.actors[0].roster = [{ address: address("sub_2"), name: null, goal: "kept work" }]; });
  corrupt((state) => { state.jobs[0].agentId = "sub_9"; });
  corrupt((state) => { state.jobs[0].jobId = "sub_2"; });
  corrupt((state) => { state.jobs[0].end.status = "zombie"; });
  corrupt((state) => { state.jobs[0].createdBy = "bob"; });
  corrupt((state) => { state.jobs[0].continuedFromJobId = "sub_9"; });
  corrupt((state) => {
    state.jobs[0].spec.inheritedContext = { systemPrompt: "parent", tools: [], entries: [], warnings: [] };
  });
  corrupt((state) => { state.actors.push({ ...state.actors[0] }); });
  corrupt((state) => { state.jobs.push({ ...state.jobs[0] }); });
  const used = createSubagentRuntime({ startJob: createFakeAdapter().startJob });
  used.create({ agents: [member("live")] });
  assert.throws(() => used.restoreState(validState()), /requires a fresh runtime/);
});

test("restores folded results and topology without replaying live work or retaining transcripts", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const first = runtime.create({ context: "batch background", agents: [member("first")] }).items[0];
  adapter.handleFor(first.id).job.recordStart("e0");
  adapter.handleFor(first.id).resolve({ result: "first result", transcript: [{ role: "assistant", content: "first answer" }],
    history: { startEntryId: "e0", endEntryId: "e2" } });
  await runtime.jobDone(first.id);
  const nested = runtime.create({ agents: [member("nested")] }, { parentAgentId: first.id }).items[0];
  const second = runtime.create({ context: "second background", agents: [member("second")] }).items[0];
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
    assert.equal(restored.jobRecord(id).error.code, "job_interrupted");
    assert.equal(restored.cancelJob(id).reason, "already_finished");
  }
  assert.equal(restored.list().agents[1].parentAgentId, first.id);
  assert.equal(restored.list().agents[1].goal, "do nested");
  state.jobs[0].end.result = "tampered";
  assert.equal(runtime.jobRecord(first.id).result, "first result");

  const revived = await restored.sendMessage({ from: MAIN, to: address(second.id), content: "begin now" });
  const handle = restoredAdapter.handleFor(revived.jobId);
  assert.equal(handle.job.continuedFromJobId, second.id);
  assert.equal(handle.job.goal, "do second");
  assert.equal(handle.job.context, "second background");
  assert.deepEqual(handle.job.pendingMessages.map((message) => message.content), ["begin now"]);
  // A new batch never reuses an identity of the restored registry.
  assert.notEqual(restored.create({ agents: [member("later")] }).items[0].id, first.id);
});

test("roster storage is local and restores under a copied root's session prefix", async () => {
  const adapter = createFakeAdapter();
  const source = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const [multi, sibling] = source.create({ agents: [member("multi one", "Alpha"), member("multi two")] }).items;
  const [singleton] = source.create({ agents: [member("single", "Solo")] }).items;
  const state = stateOf(source);
  const stored = new Map(state.actors.map((actor) => [actor.agentId, actor.roster]));
  assert.deepEqual(stored.get(multi.id), [
    { id: multi.id, name: "Alpha", goal: "do multi one" },
    { id: sibling.id, name: null, goal: "do multi two" },
  ]);
  assert.deepEqual(stored.get(singleton.id), [{ id: singleton.id, name: "Solo", goal: "do single" }]);
  assert.equal(JSON.stringify(state.actors.map((actor) => actor.roster)).includes(source.session), false,
    "persisted rosters never carry a full session address");

  const restoredAdapter = createFakeAdapter();
  const restored = createSubagentRuntime({ session: "bbbbbbbb", startJob: restoredAdapter.startJob, deliverMessage: restoredAdapter.deliverMessage });
  restored.restoreState(state);
  assert.deepEqual(restored.list().agents.map((agent) => agent.agentId), [multi.id, sibling.id, singleton.id]);
  const receipt = await restored.sendMessage({ from: "main", to: `bbbbbbbb:${multi.id}`, content: "continue" });
  const request = restoredAdapter.handleFor(receipt.jobId).job;
  assert.deepEqual(request.roster, [
    { address: `bbbbbbbb:${multi.id}`, name: "Alpha", goal: "do multi one" },
    { address: `bbbbbbbb:${sibling.id}`, name: null, goal: "do multi two" },
  ]);
  assert.deepEqual(request.roster.map((entry) => entry.name), ["Alpha", null]);
  const singletonReceipt = await restored.sendMessage({ from: "main", to: `bbbbbbbb:${singleton.id}`, content: "continue single" });
  const singletonRequest = restoredAdapter.handleFor(singletonReceipt.jobId).job;
  assert.deepEqual(singletonRequest.roster, [
    { address: `bbbbbbbb:${singleton.id}`, name: "Solo", goal: "do single" },
  ]);
});

test("restore rebuilds the Job order exactly as persisted, never grouped by Actor", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverMessage: adapter.deliverMessage });
  const a = runtime.create({ agents: [member("a")] }).items[0];
  const b = runtime.create({ agents: [member("b")] }).items[0];
  adapter.handleFor(a.id).resolve({ result: "a done" });
  await runtime.jobDone(a.id);
  const continuation = await runtime.sendMessage({ from: MAIN, to: address(a.id), content: "more work" });
  const c = runtime.create({ agents: [member("c")] }).items[0];
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

test("view failures cannot change the execution outcome or create a model notice", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, deliverToMain: adapter.deliverToMain,
    finalizeJob() { throw new Error("view disk full"); },
    historyPaths() { throw new Error("view still unavailable"); },
  });
  const item = runtime.create({ agents: [member("view-failure")] }).items[0];
  adapter.handleFor(item.id).resolve({ result: "canonical result" });
  const done = await runtime.jobDone(item.id);
  await flush();
  assert.equal(done.status, "completed");
  assert.equal(done.historyState, "error");
  assert.equal(runtime.jobRecord(item.id).result, "canonical result");
  assert.deepEqual(adapter.mainMessages, []);
});

test("restored history paths are resolved by the adapter, not an in-memory transcript API", () => {
  const reads = [];
  const runtime = createSubagentRuntime({ startJob: createFakeAdapter().startJob,
    historyPaths(jobId) { reads.push(jobId); return { summary: `/views/${jobId}/summary.md`, cleanJsonl: `/views/${jobId}/transcript.jsonl` }; } });
  runtime.restoreState(validState());
  const node = runtime.listDetailed({ id: "sub_1" }, { callerId: MAIN });
  assert.equal(node.history.summary, "/views/sub_1/summary.md");
  assert.equal("jobId" in node.history, false, "the list node never repeats the Job id");
  assert.equal(node.address, address("sub_1"));
  for (const field of ["goal", "activity", "model"]) assert.equal(field in node, false, field);
  assert.deepEqual(reads, ["sub_1"]);
  assert.equal("readRef" in runtime, false);
  assert.equal("readHistory" in runtime, false);
});

test("batch identities are never reused after a rewind or an abandoned branch", () => {
  const taken = new Set(["sub_1", "sub_5", "sub_9-1"]);
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, isIdTaken: (id) => taken.has(id), config: capacity({ maxActiveBatches: 12 }) });
  // The runtime starts above every identity it can see, not at the first gap.
  assert.equal(runtime.create({ agents: [member("a")] }).batch, 2);
  const next = runtime.create({ agents: [member("b")] }).batch;
  assert.equal(next, 3);
  assert.equal(runtime.create({ agents: [member("c")] }).batch, 4);
  // Batch 5 is owned by an abandoned branch: it is skipped, never reused.
  assert.equal(runtime.create({ agents: [member("d")] }).batch, 6);
  assert.equal(runtime.create({ agents: [member("e")] }).batch, 7);
  assert.equal(runtime.create({ agents: [member("f")] }).batch, 8);
  // 9 is only taken as a multi-member key, so a singleton at 9 is still free.
  const guarded = createSubagentRuntime({ startJob: adapter.startJob, isIdTaken: (id) => id === "sub_10-1" });
  assert.equal(guarded.create({ agents: [member("g")] }).batch, 1);
});
