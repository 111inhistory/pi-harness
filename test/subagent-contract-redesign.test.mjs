import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createSubagentRuntime, SubagentError } from "../src/subagent-runtime.mjs";
import { createSocketAwareWriteOperations, getAgentSocketPath, getBroadcastSocketPath, deriveSessionUid } from "../src/subagent-socket.mjs";
import { getSubagentHistoryPaths, appendCleanJsonl } from "../src/subagent-history.mjs";
import { deferred } from "../test-support/async.mjs";

function harness(t, options = {}) {
  const started = [];
  const runtime = createSubagentRuntime({
    deliverMessage: async () => ({ accepted: true }),
    ...options,
    startJob(request) {
      let resolve;
      let reject;
      const done = new Promise((yes, no) => { resolve = yes; reject = no; });
      const handle = {
        request, done, cancelCount: 0,
        cancel() { this.cancelCount += 1; },
        finish: (result = "ok") => resolve({ result, messages: [] }),
        fail: (error = new Error("fault")) => reject(error),
      };
      started.push(handle);
      return handle;
    },
  });
  t.after(async () => {
    // Request cancellation before resolving native handles; retirement waits for actual exits.
    for (const actor of runtime.list().agents) runtime.stop(actor.agentId);
    for (const handle of started) handle.finish();
    await Promise.all(runtime.jobs().jobs.map((job) => runtime.jobDone(job.jobId)));
  });
  return { runtime, started };
}

const task = (name) => ({ name, task: `do ${name}` });
const errorCode = (code) => (err) => err instanceof SubagentError && err.code === code;

test("public create allocates distinct hierarchical IDs and couples the initial Job to the actor", (t) => {
  const { runtime } = harness(t);
  const roots = runtime.create({ tasks: [task("a"), task("b"), task("c"), task("d")] }).items;
  assert.deepEqual(roots.map((item) => item.id), ["sub_01", "sub_02", "sub_03", "sub_04"]);
  const aChildren = runtime.create({ tasks: [task("a1"), task("a2"), task("a3"), task("a4")] }, { parentAgentId: "sub_01" }).items;
  const bChildren = runtime.create({ tasks: [task("b1"), task("b2")] }, { parentAgentId: "sub_02" }).items;
  assert.deepEqual(aChildren.map((item) => item.id), ["sub_01_01", "sub_01_02", "sub_01_03", "sub_01_04"]);
  assert.deepEqual(bChildren.map((item) => item.id), ["sub_02_01", "sub_02_02"]);
  assert.deepEqual(runtime.jobs().jobs.map((job) => job.jobId), [...roots, ...aChildren, ...bChildren].map((item) => item.id));
  const before = runtime.exportState();
  assert.throws(() => runtime.create({ tasks: [task("too many")] }, { parentAgentId: "sub_01" }), errorCode("child_limit_exceeded"));
  assert.throws(() => runtime.create({ tasks: [task("too deep")] }, { parentAgentId: "sub_01_01" }), errorCode("max_depth_exceeded"));
  const after = runtime.exportState();
  assert.deepEqual(after.actors, before.actors, "rejected topology must not register partial actors");
  assert.deepEqual(after.jobs.map((job) => job.jobId), before.jobs.map((job) => job.jobId));
  assert.deepEqual(after.sequences, before.sequences);
});

test("public create returns only deferred metadata in input order, with stable socket and history paths", (t) => {
  const { runtime } = harness(t);
  const response = runtime.create({ context: "audit", tasks: [task("TaskA"), task("TaskB")] });
  assert.deepEqual(response, { items: ["TaskA", "TaskB"].map((name, index) => {
    const id = `sub_0${index + 1}`;
    const history = getSubagentHistoryPaths(id);
    return { id, status: "running", socket: getAgentSocketPath(id), history: { summary: history.summary, cleanJsonl: history.cleanJsonl } };
  }) });
  for (const item of response.items) {
    for (const removed of ["agentId", "jobId", "delivery", "result", "resultRef", "historyRef"]) assert.equal(removed in item, false);
  }
});

test("non-ASCII assignments reject the whole batch before allocation", (t) => {
  const { runtime, started } = harness(t);
  assert.throws(() => runtime.create({ tasks: [{ task: "valid" }, { task: "中文任务" }] }), errorCode("assignment_language"));
  assert.deepEqual(runtime.listDetailed(), { items: [] });
  assert.equal(started.length, 0);
  assert.equal(runtime.create({ tasks: [{ task: "abcd你" }] }).items[0].id, "sub_01", "exactly 20% is allowed");
  assert.throws(() => runtime.create({ tasks: [{ task: "abc🙂" }] }), errorCode("assignment_language"));
  assert.throws(() => runtime.create({ context: "中文背景".repeat(40), tasks: [{ task: "English task" }] }), errorCode("assignment_language"));
});

test("public create rejects unknown routing and schema fields atomically", (t) => {
  const { runtime, started } = harness(t);
  for (const field of ["agent", "role", "model", "thinking", "effort", "provider", "preference", "tools", "outputSchema", "schemaMode"]) {
    assert.throws(() => runtime.create({ tasks: [task("valid"), { ...task("invalid"), [field]: "override" }] }), errorCode("invalid_task"));
  }
  assert.deepEqual(runtime.listDetailed(), { items: [] });
  assert.equal(started.length, 0);
  assert.equal(runtime.create({ tasks: [task("first accepted")] }).items[0].id, "sub_01");
});

test("public create preserves inherited warnings and captures one independent snapshot per batch", (t) => {
  const { runtime, started } = harness(t);
  const warning = "Tool 'custom_secret' is not transplantable and was omitted.";
  const snapshot = {
    cwd: process.cwd(), sessionId: "test-session", systemPrompt: "prompt",
    model: { provider: "test", id: "model" }, thinkingLevel: "high", entries: [], tools: ["bash"], warnings: [warning],
  };
  let captures = 0;
  const response = runtime.create({ tasks: [task("fresh"), { ...task("inherited 1"), inheritContext: true }, { ...task("inherited 2"), inheritContext: true }] }, {
    captureInheritedContext: () => { captures += 1; return snapshot; },
  });
  assert.equal(captures, 1);
  assert.equal("warnings" in response.items[0], false);
  for (const item of response.items.slice(1)) assert.deepEqual(item.warnings, [warning]);
  assert.notEqual(started[1].request.spec.inheritedContext.entries, started[2].request.spec.inheritedContext.entries);
  snapshot.warnings.push("later mutation");
  assert.deepEqual(response.items[1].warnings, [warning]);
});

test("public list filters actors without exposing Budget or redundant identity fields", async (t) => {
  const { runtime, started } = harness(t);
  const [first, second] = runtime.create({ tasks: [task("running"), task("sibling")] }).items;
  const before = runtime.listDetailed();
  assert.deepEqual(before.items.map((item) => item.status), ["running", "running"]);
  const item = before.items[0];
  assert.equal("depth" in item, false);
  assert.equal("name" in item, false);
  assert.equal("parentSocket" in item, false);
  assert.equal("budget" in item, false);
  assert.equal(item.parentId, "Main");
  assert.equal(started[0].request.budget.snapshot().modelCalls, 0);
  const filtered = runtime.listDetailed({ id: first.id }).items;
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, first.id);
  assert.equal(filtered[0].socket, item.socket);
  assert.deepEqual(filtered[0].history, item.history);
  assert.equal("budget" in filtered[0], false);
  assert.deepEqual(runtime.listDetailed({ id: "missing" }), { items: [] });
  assert.equal(runtime.stop(second.id).status, "stopping");
  started[1].finish();
  await runtime.jobDone(second.id);
  assert.equal(runtime.stop(first.id).status, "stopping");
  assert.equal(runtime.listDetailed({ id: first.id }).items[0].status, "stopping");
  started[0].finish();
  await runtime.jobDone(first.id);
  const final = runtime.listDetailed({ id: first.id }).items[0];
  assert.equal(final.status, "stopped");
  assert.equal(final.socket, first.socket);
  assert.deepEqual(final.history, first.history);
  assert.equal(started[0].request.budget.snapshot().terminal.status, "cancelled");
});

test("scoped list fills each group with recent stops and expands only active permitted branches", async (t) => {
  const { runtime, started } = harness(t);
  const create = (count, parentAgentId = null) => runtime.create({ tasks: Array.from({ length: count }, () => ({ task: "Inspect scoped list" })) }, { parentAgentId }).items;
  const finish = async (items) => {
    for (const item of items) started.find((handle) => handle.request.agentId === item.id).finish();
    await Promise.all(items.map((item) => runtime.jobDone(item.id)));
  };
  const oldRoots = create(3);
  const hiddenChild = create(1, oldRoots[0].id)[0];
  for (const root of [...oldRoots].reverse()) await finish([root]);
  const roots = create(3);
  const children = new Map();
  for (const root of roots) {
    await finish(create(4, root.id));
    await finish(create(2, root.id));
    children.set(root.id, create(4, root.id));
  }
  const main = runtime.listDetailed({}, { callerId: "Main" }).items;
  assert.equal(main.length, 17, "Main, four roots, twelve active leaves");
  assert.deepEqual(main.filter((item) => item.parentId === "Main").map((item) => item.id), [...roots.map((item) => item.id), oldRoots[0].id]);
  assert.equal(main.some((item) => item.id === hiddenChild.id), false, "stopped root is not expanded even with an active child");
  assert.equal(main.filter((item) => item.parentId !== null && item.parentId !== "Main").every((item) => item.status === "running"), true);
  const local = runtime.listDetailed({}, { callerId: roots[0].id }).items;
  assert.equal(local.length, 9);
  assert.deepEqual(local.filter((item) => item.parentId === roots[0].id).map((item) => item.id), children.get(roots[0].id).map((item) => item.id));
  assert.equal(local.some((item) => item.parentId === roots[1].id), false, "peer children are not expanded");
  assert.deepEqual(runtime.listDetailed({ id: hiddenChild.id }, { callerId: "Main" }).items, []);
  const all = runtime.listDetailed({ all: true }, { callerId: roots[0].id }).items;
  assert.equal(all.length, 38);
  assert.equal(all.some((item) => item.id === hiddenChild.id), true);
  const leaf = children.get(roots[0].id)[0];
  assert.deepEqual(runtime.listDetailed({}, { callerId: leaf.id }).items.map((item) => item.id), [roots[0].id, ...children.get(roots[0].id).map((item) => item.id)]);
  await finish(children.get(roots[0].id).slice(0, 2));
  const filled = runtime.listDetailed({}, { callerId: roots[0].id }).items.filter((item) => item.parentId === roots[0].id);
  assert.deepEqual(filled.map((item) => item.status), ["running", "running", "stopped", "stopped"]);
  assert.equal(filled[2].id, children.get(roots[0].id)[1].id, "last actual completion wins, not creation order");
});

test("listener window stays bounded across one thousand stopped actors and revival admission", async (t) => {
  const { runtime, started } = harness(t);
  let first;
  for (let index = 0; index < 1000; index++) {
    const actor = runtime.create({ tasks: [{ task: "Complete history entry" }] }).items[0];
    first ??= actor.id;
    started.at(-1).finish();
    await runtime.jobDone(actor.id);
  }
  assert.equal(runtime.list().agents.length, 1000);
  assert.equal(runtime.listenerGroup().length, 4);
  assert.equal(runtime.listenerGroup()[0], "sub_1000");
  assert.equal(runtime.listenerGroup(null, first)[0], first);
  runtime.assertMessageAdmission(first);
  const active = runtime.create({ tasks: Array.from({ length: 4 }, () => ({ task: "Remain active" })) }).items;
  assert.deepEqual(runtime.listenerGroup(), active.map((actor) => actor.id));
  assert.throws(() => runtime.assertMessageAdmission(first), errorCode("child_limit_exceeded"));
  runtime.stop(active[0].id);
  assert.throws(() => runtime.assertMessageAdmission(first), errorCode("child_limit_exceeded"));
  started.find((handle) => handle.request.agentId === active[0].id).finish();
  await runtime.jobDone(active[0].id);
  runtime.assertMessageAdmission(first);
});

test("scoped stopped ordering survives registry restoration", async (t) => {
  const { runtime, started } = harness(t);
  const first = runtime.create({ tasks: [task("first"), task("second"), task("third"), task("fourth")] }).items;
  for (const item of [...first].reverse()) {
    started.find((handle) => handle.request.agentId === item.id).finish();
    await runtime.jobDone(item.id);
  }
  const fifth = runtime.create({ tasks: [task("fifth")] }).items[0];
  started.find((handle) => handle.request.agentId === fifth.id).finish();
  await runtime.jobDone(fifth.id);
  const { runtime: restored } = harness(t);
  restored.restoreState(runtime.exportState());
  assert.deepEqual(restored.listDetailed({}, { callerId: "Main" }).items.map((item) => item.id), ["Main", fifth.id, first[0].id, first[1].id, first[2].id]);
  await runtime.sendMessage({ from: "Main", to: first[3].id, content: "Resume before interruption" });
  const { runtime: interrupted } = harness(t);
  interrupted.restoreState(runtime.exportState());
  assert.deepEqual(interrupted.listDetailed({}, { callerId: "Main" }).items.map((item) => item.id), ["Main", first[3].id, fifth.id, first[0].id, first[1].id]);
});

test("public stop waits for its native exit without blocking a running sibling and is repeatable", async (t) => {
  const { runtime, started } = harness(t);
  const [first, second] = runtime.create({ tasks: [task("running"), task("sibling")] }).items;
  assert.equal(runtime.listDetailed({ id: second.id }).items[0].status, "running");
  assert.equal(runtime.stop(first.id).status, "stopping");
  assert.equal(runtime.stop(first.id).ok, false);
  assert.equal(started[0].cancelCount, 1);
  await assert.rejects(runtime.sendMessage({ from: "Main", to: first.id, content: "too early" }), errorCode("agent_busy"));
  assert.equal(started.length, 2);
  started[0].finish("partial");
  assert.equal((await runtime.jobDone(first.id)).status, "cancelled");
  assert.equal(started.length, 2);
  assert.equal(runtime.stop(first.id).ok, true);
  assert.throws(() => runtime.stop("unknown_agent"), errorCode("unknown_agent"));
  assert.throws(() => runtime.stop(), errorCode("invalid_request"));
});

test("public actor metadata remains stable through revival while a new Job and Budget are allocated", async (t) => {
  const { runtime, started } = harness(t);
  const original = runtime.create({ tasks: [task("revive")] }).items[0];
  started[0].request.budget.beginModelCall();
  started[0].finish("first output");
  await runtime.jobDone(original.id);
  const response = await runtime.sendMessage({ from: "Main", to: original.id, content: "continue" });
  assert.equal(response.to, original.id);
  assert.notEqual(response.jobId, original.id);
  assert.equal(started[1].request.continuedFromJobId, original.id);
  assert.notEqual(started[0].request.budget, started[1].request.budget);
  const revived = runtime.listDetailed({ id: original.id }).items[0];
  assert.equal(started[1].request.budget.snapshot().modelCalls, 0);
  assert.equal(revived.socket, original.socket);
  assert.deepEqual(revived.history, original.history);
});

test("socket write preflight rejects stopping before attempting to connect", async (t) => {
  const { runtime } = harness(t);
  const { id } = runtime.create({ tasks: [task("stopping")] }).items[0];
  runtime.stop(id);
  const checked = [];
  const operations = createSocketAwareWriteOperations({ resolveEndpoint: async () => ({ isManaged: true, targetId: id }), onCheckStatus(target) {
    checked.push(target);
    return runtime.listDetailed({ id: target }).items[0].status;
  } });
  await assert.rejects(operations.writeFile(getAgentSocketPath(id, "/not-a-real-socket-dir"), '{"content":"too early"}'), (err) => err.code === "agent_stopping");
  assert.deepEqual(checked, [id]);
});

test("terminal notifications are emitted once only for failure, not normal completion or explicit cancellation", async (t) => {
  const delivered = [];
  const { runtime, started } = harness(t, { deliverToMain: (msg) => delivered.push(msg) });
  const [normal, stopped] = runtime.create({ tasks: [task("normal"), task("stopped")] }).items;
  runtime.stop(stopped.id);
  started[0].finish("success");
  started[1].finish("cancelled");
  await Promise.all([runtime.jobDone(normal.id), runtime.jobDone(stopped.id)]);
  assert.deepEqual(delivered, []);
  const failed = runtime.create({ tasks: [task("failure")] }).items[0];
  started[2].fail(new Error("provider failed"));
  assert.equal((await runtime.jobDone(failed.id)).status, "failed");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].type, "notification");
  assert.equal(delivered[0].subagentId, failed.id);
  assert.equal(delivered[0].status, "failed");
  assert.deepEqual(delivered[0].history, failed.history);
  assert.match(delivered[0].content, /provider failed/);
  runtime.stop(failed.id);
  runtime.listDetailed();
  await runtime.jobDone(failed.id);
  assert.equal(delivered.length, 1, "polls and repeated stop must not resend an error notification");
});

test("depth-2 failure notification is delivered to depth-1 parent via deliverMessage, not to main", async (t) => {
  const mainDelivered = [];
  const parentDelivered = [];
  const { runtime, started } = harness(t, {
    deliverToMain: (msg) => mainDelivered.push(msg),
    deliverMessage: (req) => parentDelivered.push(req),
  });
  const parent = runtime.create({ tasks: [task("parent")] }).items[0];
  const child = runtime.create({ tasks: [task("child")] }, { parentAgentId: parent.id }).items[0];
  started[1].fail(new Error("depth-2 child failed"));
  await runtime.jobDone(child.id);
  assert.equal(mainDelivered.length, 0, "Main must not receive depth-2 failure notification directly");
  assert.equal(parentDelivered.length, 1, "Parent must receive depth-2 failure notification");
  assert.equal(parentDelivered[0].agentId, parent.id);
  assert.equal(parentDelivered[0].message.type, "notification");
  assert.equal(parentDelivered[0].message.subagentId, child.id);
});

test("broadcast write rejects cross-hierarchy senders without mutating from", async () => {
  const endpoint = getBroadcastSocketPath("sub_01", path.join(tmpdir(), "pi-cross-hierarchy"));
  const ops = createSocketAwareWriteOperations({
    senderId: "main",
    resolveEndpoint: async (p) => {
      if (p === endpoint) return { isManaged: true, isBroadcast: true, parentId: "sub_01" };
      return { isManaged: false };
    },
  });
  await assert.rejects(
    ops.writeFile(endpoint, '{"content":"test"}\n'),
    (err) => err.code === "invalid_target",
  );
});

test("deriveSessionUid produces stable 6-character hex hash", () => {
  const uid1 = deriveSessionUid("session-12345");
  const uid2 = deriveSessionUid("session-12345");
  const uid3 = deriveSessionUid("session-67890");
  assert.equal(uid1.length, 6);
  assert.equal(uid1, uid2);
  assert.notEqual(uid1, uid3);
  assert.equal(deriveSessionUid(null), "default");
});

test("history paths and writes bind to session cwd", async () => {
  const tmpCwd = await fsp.mkdtemp(path.join(tmpdir(), "pi-hist-cwd-"));
  try {
    const paths = getSubagentHistoryPaths("sub_01", ".pi/subagents", { cwd: tmpCwd });
    assert.equal(paths.summary, ".pi/subagents/sub_01/summary.md");
    assert.equal(paths.resolvedSummary, path.join(tmpCwd, ".pi/subagents/sub_01/summary.md"));
    await appendCleanJsonl("sub_01", { type: "message_start", role: "assistant" }, { baseDir: ".pi/subagents", cwd: tmpCwd });
    assert.ok(fs.existsSync(paths.resolvedCleanJsonl));
  } finally {
    await fsp.rm(tmpCwd, { recursive: true, force: true });
  }
});

test("fresh agent does not reuse actor IDs taken by earlier branches", () => {
  const rootSessionAllocated = new Set();
  // Branch A: create an actor that is immediately stopped or never checkpointed
  const runtimeA = createSubagentRuntime({
    isAgentIdTaken: (id) => rootSessionAllocated.has(id),
    onAgentIdAllocated: (id) => rootSessionAllocated.add(id),
    startJob: () => ({ request: {}, done: Promise.resolve({ result: "ok", messages: [] }), cancel() {} }),
  });
  const resA = runtimeA.create({ tasks: [{ name: "T1", task: "Do task A" }] });
  assert.equal(resA.items[0].id, "sub_01");
  assert.ok(rootSessionAllocated.has("sub_01"));

  // Branch switch: runtimeB starts with empty registry on the new branch, sharing root session allocated IDs
  const runtimeB = createSubagentRuntime({
    isAgentIdTaken: (id) => rootSessionAllocated.has(id),
    onAgentIdAllocated: (id) => rootSessionAllocated.add(id),
    startJob: () => ({ request: {}, done: Promise.resolve({ result: "ok", messages: [] }), cancel() {} }),
  });
  const resB = runtimeB.create({ tasks: [{ name: "T2", task: "Do task B" }] });
  assert.equal(resB.items[0].id, "sub_02", "Must allocate sub_02 without reusing sub_01 from unpersisted actor in branch A");
});
test("finalization rejects reentrant stop and runs once per Job across revival", { timeout: 3000 }, async () => {
  const finalized = [];
  const runtime = createSubagentRuntime({
    startJob: () => ({ done: Promise.resolve({ result: "done", messages: [] }) }),
    finalizeJob({ job, outcome }) {
      const stop = runtime.cancelJob(job.jobId);
      assert.equal(stop.ok, false);
      assert.equal(stop.reason, "finalizing");
      finalized.push({ jobId: job.jobId, status: outcome.status, round: outcome.round });
    },
  });
  const actor = runtime.create({ tasks: [task("reentrant")] }).items[0];
  await runtime.jobDone(actor.id);
  const next = await runtime.sendMessage({ from: "Main", to: actor.id, content: "continue" });
  await runtime.jobDone(next.jobId);
  assert.deepEqual(finalized, [
    { jobId: actor.id, status: "completed", round: 1 },
    { jobId: next.jobId, status: "completed", round: 2 },
  ]);
  assert.equal(runtime.jobs().jobs.every((job) => job.status === "completed"), true);
});

test("lifecycle: finalizing state blocks new writes with agent_busy and settles frozen outcome after finalizeJob", { timeout: 3000 }, async (t) => {
  const entered = deferred();
  let finalizeResolve;
  const finalizePromise = new Promise((resolve) => {
    finalizeResolve = resolve;
  });
  let jobHandleResolve;
  const jobHandlePromise = new Promise((resolve) => {
    jobHandleResolve = resolve;
  });

  let finalizedOutcome = null;

  const runtime = createSubagentRuntime({
    startJob: () => ({
      request: {},
      done: jobHandlePromise,
      cancel() {},
    }),
    finalizeJob: async ({ outcome }) => {
      finalizedOutcome = outcome;
      entered.resolve();
      await finalizePromise;
    },
    deliverMessage: async () => ({ accepted: true }),
  });

  const created = runtime.create({ tasks: [{ name: "T1", task: "Do work" }] });
  const actorId = created.items[0].id;
  t.after(async () => {
    finalizeResolve();
    await runtime.jobDone(actorId);
  });

  // 1. Native execution resolves
  jobHandleResolve({ result: "native work done", messages: [] });
  await entered.promise;

  // 2. Status should be finalizing, actor is live/busy
  const jobState = runtime.jobs({ jobIds: [actorId] }).jobs[0];
  assert.equal(jobState.status, "finalizing");

  // A socket/sendMessage write during finalizing must be rejected with agent_busy
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: actorId, content: "ping during finalizing" }),
    (err) => err.code === "agent_busy",
  );

  // 3. Resolve finalization (I/O done)
  finalizeResolve();
  await runtime.jobDone(actorId);

  const finalJobState = runtime.jobs({ jobIds: [actorId] }).jobs[0];
  assert.equal(finalJobState.status, "completed");
  assert.equal(finalJobState.historyState, "ready");
  assert.equal(finalizedOutcome.status, "completed");
  assert.equal(finalizedOutcome.result, "native work done");
});

test("cancellation before adapter invocation still finalizes once without native execution", { timeout: 3000 }, async (t) => {
  const native = deferred();
  const history = deferred();
  const finalized = [];
  const started = [];
  const runtime = createSubagentRuntime({
    startJob(request) {
      started.push(request.spec.name);
      const sibling = runtime.jobs().jobs.find((job) => job.name === "notStarted");
      assert.equal(sibling.status, "running", "registration must not expose a separate waiting state");
      runtime.cancelJob(sibling.jobId);
      return { done: native.promise };
    },
    async finalizeJob({ job, outcome }) {
      finalized.push({ name: job.name, status: outcome.status });
      await history.promise;
    },
  });
  const actors = runtime.create({ tasks: [task("first"), task("notStarted")] }).items;
  t.after(async () => {
    native.resolve({ result: "done" });
    history.resolve();
    await Promise.all(actors.map((actor) => runtime.jobDone(actor.id)));
  });
  assert.deepEqual(started, ["first"]);
  assert.equal(runtime.jobs().jobs[1].status, "finalizing");
  assert.deepEqual(finalized, [{ name: "notStarted", status: "cancelled" }]);
  history.resolve();
  const ended = await runtime.jobDone(actors[1].id);
  assert.equal(ended.status, "cancelled");
  assert.equal(ended.historyState, "ready");
  assert.equal(finalized.length, 1);
});

test("lifecycle: finalizeJob failure records historyState error while preserving original completion status", async () => {
  const runtime = createSubagentRuntime({
    startJob: () => ({
      request: {},
      done: Promise.resolve({ result: "work done successfully", messages: [] }),
      cancel() {},
    }),
    finalizeJob: async () => {
      throw new Error("Disk full or permission denied during summary write");
    },
    deliverMessage: async () => ({ accepted: true }),
  });

  const created = runtime.create({ tasks: [{ name: "T1", task: "Do work" }] });
  const actorId = created.items[0].id;

  await runtime.jobDone(actorId);

  const finalJobState = runtime.jobs({ jobIds: [actorId] }).jobs[0];
  assert.equal(finalJobState.status, "completed", "Job status must remain completed despite history write failure");
  assert.equal(finalJobState.historyState, "error");
  assert.equal(finalJobState.historyError?.code, "history_write_failed");
  assert.match(finalJobState.historyError?.message, /Disk full/);
});
