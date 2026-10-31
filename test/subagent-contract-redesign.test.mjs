import assert from "node:assert/strict";
import test from "node:test";

import { createSubagentRuntime, SubagentError } from "../src/subagent/runtime.ts";
import { foldEvents } from "../src/subagent/storage.ts";
import { deriveSessionUid } from "../src/ipc/socket.ts";
import { deferred } from "../test-support/async.ts";
import { treeNodes } from "./typed/support/agent-tree.ts";

function harness(t, options = {}) {
  const started = [];
  const events = [];
  const runtime = createSubagentRuntime({
    deliverMessage: async () => ({ accepted: true }),
    ...options,
    onEvent(event) { events.push(event); options.onEvent?.(event); },
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
  return { runtime, started, state: () => foldEvents(events.map(({ type, ...data }) => ({
    type: "custom", customType: `subagent-${type}`, data: { v: 2, ...data },
  }))) };
}

const task = (name) => ({ name, task: `do ${name}` });
const errorCode = (code) => (err) => err instanceof SubagentError && err.code === code;

test("public list filters actors without exposing Budget or redundant identity fields", async (t) => {
  const { runtime, started } = harness(t);
  const [first, second] = runtime.create({ tasks: [task("running"), task("sibling")] }).items;
  const before = runtime.listDetailed({}, { callerId: "Main" });
  assert.deepEqual(treeNodes(before).map((item) => item.status), ["running", "running", "running"]);
  assert.equal(before.id, "Main");
  const item = before.children[0];
  assert.equal("depth" in item, false);
  assert.equal("name" in item, false);
  assert.equal("parentSocket" in item, false);
  assert.equal("budget" in item, false);
  assert.equal("parentId" in item, false);
  assert.equal(started[0].request.budget.snapshot().modelCalls, 0);
  const filtered = runtime.listDetailed({ id: first.id }, { callerId: "Main" });
  assert.equal(filtered.id, first.id);
  assert.equal(filtered.socket, item.socket);
  assert.deepEqual(filtered.history, item.history);
  assert.equal("budget" in filtered, false);
  assert.deepEqual(runtime.listDetailed({ id: "missing" }, { callerId: "Main" }), null);
  assert.equal(runtime.stop(second.id).status, "stopping");
  started[1].finish();
  await runtime.jobDone(second.id);
  assert.equal(runtime.stop(first.id).status, "stopping");
  assert.equal(runtime.listDetailed({ id: first.id }, { callerId: "Main" }).status, "stopping");
  started[0].finish();
  await runtime.jobDone(first.id);
  const final = runtime.listDetailed({ id: first.id }, { callerId: "Main" });
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
  const main = runtime.listDetailed({}, { callerId: "Main" });
  assert.equal(treeNodes(main).length, 17, "Main, four roots, twelve active leaves");
  assert.deepEqual(main.children.map((item) => item.id), [...roots.map((item) => item.id), oldRoots[0].id]);
  assert.equal(treeNodes(main).some((item) => item.id === hiddenChild.id), false, "stopped root is not expanded even with an active child");
  assert.equal(main.children.flatMap((item) => item.children).every((item) => item.status === "running"), true);
  const local = runtime.listDetailed({}, { callerId: roots[0].id });
  assert.equal(treeNodes(local).length, 9);
  assert.deepEqual(local.children.find((item) => item.id === roots[0].id).children.map((item) => item.id), children.get(roots[0].id).map((item) => item.id));
  assert.equal(local.children.find((item) => item.id === roots[1].id).children.length > 0, false, "peer children are not expanded");
  assert.deepEqual(runtime.listDetailed({ id: hiddenChild.id }, { callerId: "Main" }), null);
  const all = treeNodes(runtime.listDetailed({ all: true }, { callerId: roots[0].id }));
  assert.equal(all.length, 38);
  assert.equal(all.some((item) => item.id === hiddenChild.id), true);
  const leaf = children.get(roots[0].id)[0];
  assert.deepEqual(treeNodes(runtime.listDetailed({}, { callerId: leaf.id })).map((item) => item.id), [roots[0].id, ...children.get(roots[0].id).map((item) => item.id)]);
  await finish(children.get(roots[0].id).slice(0, 2));
  const filled = runtime.listDetailed({ id: roots[0].id }, { callerId: roots[0].id }).children;
  assert.deepEqual(filled.map((item) => item.status), ["running", "running", "stopped", "stopped"]);
  assert.equal(filled[2].id, children.get(roots[0].id)[1].id, "last actual completion wins, not creation order");
});

test("reviving a stopped actor requires an available active-child slot", async (t) => {
  const { runtime, started } = harness(t);
  const stopped = runtime.create({ tasks: [{ task: "Stopped before revival" }] }).items[0];
  started.find((handle) => handle.request.agentId === stopped.id).finish();
  await runtime.jobDone(stopped.id);

  const active = runtime.create({ tasks: Array.from({ length: 4 }, () => ({ task: "Remain active" })) }).items;
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: stopped.id, content: "Resume now" }),
    errorCode("child_limit_exceeded"),
  );
  runtime.stop(active[0].id);
  // A stopping Actor still holds its slot until its native run exits.
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: stopped.id, content: "Resume now" }),
    errorCode("child_limit_exceeded"),
  );
  started.find((handle) => handle.request.agentId === active[0].id).finish();
  await runtime.jobDone(active[0].id);
  const receipt = await runtime.sendMessage({ from: "Main", to: stopped.id, content: "Resume now" });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.to, stopped.id);
});

test("scoped stopped ordering survives registry restoration", async (t) => {
  const { runtime, started, state } = harness(t);
  const first = runtime.create({ tasks: [task("first"), task("second"), task("third"), task("fourth")] }).items;
  for (const item of [...first].reverse()) {
    started.find((handle) => handle.request.agentId === item.id).finish();
    await runtime.jobDone(item.id);
  }
  const fifth = runtime.create({ tasks: [task("fifth")] }).items[0];
  started.find((handle) => handle.request.agentId === fifth.id).finish();
  await runtime.jobDone(fifth.id);
  const { runtime: restored } = harness(t);
  restored.restoreState(state());
  assert.deepEqual(treeNodes(restored.listDetailed({}, { callerId: "Main" })).map((item) => item.id), ["Main", fifth.id, first[0].id, first[1].id, first[2].id]);
  await runtime.sendMessage({ from: "Main", to: first[3].id, content: "Resume before interruption" });
  const { runtime: interrupted } = harness(t);
  interrupted.restoreState(state());
  assert.deepEqual(treeNodes(interrupted.listDetailed({}, { callerId: "Main" })).map((item) => item.id), ["Main", first[3].id, fifth.id, first[0].id, first[1].id]);
});

test("session namespaces remain stable on reload and distinct between sessions", () => {
  const uid1 = deriveSessionUid("session-12345");
  const uid2 = deriveSessionUid("session-12345");
  const uid3 = deriveSessionUid("session-67890");
  assert.equal(uid1, uid2);
  assert.notEqual(uid1, uid3);
});

test("fresh agent does not reuse actor IDs taken by earlier branches", () => {
  const rootSessionAllocated = new Set();
  // Branch A: create an actor that is immediately stopped or never checkpointed
  const runtimeA = createSubagentRuntime({
    isIdTaken: (id) => rootSessionAllocated.has(id),
    onIdAllocated: (id) => rootSessionAllocated.add(id),
    startJob: () => ({ request: {}, done: Promise.resolve({ result: "ok", messages: [] }), cancel() {} }),
  });
  const resA = runtimeA.create({ tasks: [{ name: "T1", task: "Do task A" }] });
  assert.equal(resA.items[0].id, "sub_01");
  assert.ok(rootSessionAllocated.has("sub_01"));

  // Branch switch: runtimeB starts with empty registry on the new branch, sharing root session allocated IDs
  const runtimeB = createSubagentRuntime({
    isIdTaken: (id) => rootSessionAllocated.has(id),
    onIdAllocated: (id) => rootSessionAllocated.add(id),
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
