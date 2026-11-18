import assert from "node:assert/strict";
import test from "node:test";

import { createSubagentRuntime, SubagentError } from "../src/subagent/runtime.ts";
import { foldEvents } from "../src/subagent/storage.ts";
import { deriveSessionUid } from "../src/ipc/socket.ts";
import { deferred } from "../test-support/async.ts";
import { treeNodes } from "./typed/support/agent-tree.ts";

const SESSION = "abcdef01";
const MAIN = "main";

function harness(t, options = {}) {
  const started = [];
  const events = [];
  const runtime = createSubagentRuntime({
    session: SESSION,
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
    for (const job of runtime.jobs().jobs) runtime.cancelJob(job.jobId);
    for (const handle of started) handle.finish();
    await Promise.all(runtime.jobs().jobs.map((job) => runtime.jobDone(job.jobId)));
  });
  return {
    runtime, started,
    state: () => foldEvents(events.map(({ type, ...data }) => ({
      type: "custom", customType: `subagent-${type}`, data: { v: 3, ...data },
    }))),
  };
}

const member = (name, goal = `do ${name}`) => ({ name, goal });
const batch = (...agents) => ({ agents });
const errorCode = (code) => (err) => err instanceof SubagentError && err.code === code;
const stop = (runtime, actor) => runtime.signal({ from: MAIN, to: actor.address, action: "stop" });
const resume = (runtime, actor, content = "Resume") =>
  runtime.sendMessage({ from: MAIN, to: actor.address, content });

test("public list filters actors without exposing Budget or redundant identity fields", async (t) => {
  const { runtime, started } = harness(t);
  const [first, second] = runtime.create(batch(member("running"), member("sibling"))).items;
  const before = runtime.listDetailed({}, { callerId: MAIN });
  assert.equal(before.id, MAIN);
  assert.deepEqual(before.children.map((child) => child.id), [first.id, second.id]);
  const item = before.children[0];
  assert.equal("depth" in item, false);
  assert.equal("parentSocket" in item, false);
  assert.equal("socket" in item, false);
  assert.equal("budget" in item, false);
  assert.equal("parentId" in item, false);
  for (const field of ["goal", "activity", "model"]) {
    assert.equal(field in item, false, `the list node must not carry ${field}`);
  }
  assert.equal(started[0].request.budget.snapshot().modelCalls, 0);
  const filtered = runtime.listDetailed({ id: first.id }, { callerId: MAIN });
  assert.equal(filtered.id, first.id);
  assert.equal(filtered.address, item.address);
  assert.deepEqual(filtered.history, item.history);
  assert.equal("budget" in filtered, false);
  assert.deepEqual(runtime.listDetailed({ id: "missing" }, { callerId: MAIN }), null);
  assert.equal((await stop(runtime, second)).targets[0].status, "stopping");
  started[1].finish();
  await runtime.jobDone(second.id);
  assert.equal((await stop(runtime, first)).targets[0].status, "stopping");
  assert.equal(runtime.listDetailed({ id: first.id }, { callerId: MAIN }).address, first.address,
    "a stopping actor stays visible in the list");
  started[0].finish();
  await runtime.jobDone(first.id);
  const final = runtime.listDetailed({ id: first.id }, { callerId: MAIN });
  assert.equal(runtime.jobs({ jobIds: [first.id] }).jobs[0].status, "cancelled");
  assert.equal(final.address, first.address);
  assert.deepEqual(final.history, first.history);
  assert.equal(started[0].request.budget.snapshot().terminal.status, "cancelled");
});

test("scoped list fills each group with recent stops and expands only active permitted branches", async (t) => {
  const { runtime, started } = harness(t);
  const create = (count, parentAgentId = null) => Array.from({ length: count }, (_, index) =>
    runtime.create(batch({ goal: `Inspect scoped list ${index}` }), parentAgentId === null ? {} : { parentAgentId }).items[0]);
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
  const main = runtime.listDetailed({}, { callerId: MAIN });
  assert.equal(treeNodes(main).length, 17, "Main, four roots, twelve active leaves");
  assert.deepEqual(main.children.map((item) => item.id), [...roots.map((item) => item.id), oldRoots[0].id]);
  assert.equal(treeNodes(main).some((item) => item.id === hiddenChild.id), false, "stopped root is not expanded even with an active child");
  const activeChildIds = new Set([...children.values()].flat().map((item) => item.id));
  assert.equal(main.children.flatMap((item) => item.children).every((item) => activeChildIds.has(item.id)), true,
    "only active children of a stopped root are expanded");
  const local = runtime.listDetailed({}, { callerId: roots[0].id });
  assert.equal(treeNodes(local).length, 9);
  assert.deepEqual(local.children.find((item) => item.id === roots[0].id).children.map((item) => item.id), children.get(roots[0].id).map((item) => item.id));
  assert.equal(local.children.find((item) => item.id === roots[1].id).children.length > 0, false, "peer children are not expanded");
  assert.deepEqual(runtime.listDetailed({ id: hiddenChild.id }, { callerId: MAIN }), null);
  const all = treeNodes(runtime.listDetailed({ all: true }, { callerId: roots[0].id }));
  assert.equal(all.length, 38);
  assert.equal(all.some((item) => item.id === hiddenChild.id), true);
  const leaf = children.get(roots[0].id)[0];
  assert.deepEqual(treeNodes(runtime.listDetailed({}, { callerId: leaf.id })).map((item) => item.id), [roots[0].id, ...children.get(roots[0].id).map((item) => item.id)]);
  await finish(children.get(roots[0].id).slice(0, 2));
  const filled = runtime.listDetailed({ id: roots[0].id }, { callerId: roots[0].id }).children;
  const own = children.get(roots[0].id);
  assert.deepEqual(filled.map((item) => item.id), [own[2].id, own[3].id, own[1].id, own[0].id],
    "active children stay first, then stopped children by most recent completion");
  assert.equal(filled[2].id, own[1].id, "last actual completion wins, not creation order");
});

test("reviving a stopped actor requires an available active-child slot", async (t) => {
  const { runtime, started } = harness(t);
  const stopped = runtime.create(batch({ goal: "Stopped before revival" })).items[0];
  started.find((handle) => handle.request.agentId === stopped.id).finish();
  await runtime.jobDone(stopped.id);

  const active = runtime.create(batch(...Array.from({ length: 7 }, (_, index) => ({ goal: `Remain active ${index}` })))).items;
  await assert.rejects(
    resume(runtime, stopped, "Resume now"),
    errorCode("subagent_limit_exceeded"),
  );
  await stop(runtime, active[0]);
  // A stopping Actor still holds its slot until its native run exits.
  await assert.rejects(
    resume(runtime, stopped, "Resume now"),
    errorCode("subagent_limit_exceeded"),
  );
  started.find((handle) => handle.request.agentId === active[0].id).finish();
  await runtime.jobDone(active[0].id);
  const receipt = await resume(runtime, stopped, "Resume now");
  assert.equal(receipt.ok, true);
  assert.equal(receipt.to, stopped.address);
});

test("scoped stopped ordering survives registry restoration", async (t) => {
  const { runtime, started, state } = harness(t);
  const first = runtime.create(batch(member("first"), member("second"), member("third"), member("fourth"))).items;
  for (const item of [...first].reverse()) {
    started.find((handle) => handle.request.agentId === item.id).finish();
    await runtime.jobDone(item.id);
  }
  const fifth = runtime.create(batch({ goal: "fifth" })).items[0];
  started.find((handle) => handle.request.agentId === fifth.id).finish();
  await runtime.jobDone(fifth.id);
  const { runtime: restored } = harness(t);
  restored.restoreState(state());
  assert.deepEqual(treeNodes(restored.listDetailed({}, { callerId: MAIN })).map((item) => item.id), [MAIN, fifth.id, first[0].id, first[1].id, first[2].id]);
  await resume(runtime, first[3], "Resume before interruption");
  const { runtime: interrupted } = harness(t);
  interrupted.restoreState(state());
  assert.deepEqual(treeNodes(interrupted.listDetailed({}, { callerId: MAIN })).map((item) => item.id), [MAIN, first[3].id, fifth.id, first[0].id, first[1].id]);
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
    session: SESSION,
    isIdTaken: (id) => rootSessionAllocated.has(id),
    onIdAllocated: (id) => rootSessionAllocated.add(id),
    startJob: () => ({ request: {}, done: Promise.resolve({ result: "ok", messages: [] }), cancel() {} }),
  });
  const resA = runtimeA.create(batch(member("T1", "Do task A")));
  assert.equal(resA.items[0].id, "sub_1");
  assert.ok(rootSessionAllocated.has("sub_1"));

  // Branch switch: runtimeB starts with empty registry on the new branch, sharing root session allocated IDs
  const runtimeB = createSubagentRuntime({
    session: SESSION,
    isIdTaken: (id) => rootSessionAllocated.has(id),
    onIdAllocated: (id) => rootSessionAllocated.add(id),
    startJob: () => ({ request: {}, done: Promise.resolve({ result: "ok", messages: [] }), cancel() {} }),
  });
  const resB = runtimeB.create(batch(member("T2", "Do task B")));
  assert.equal(resB.items[0].id, "sub_2", "Must allocate sub_2 without reusing sub_1 from unpersisted actor in branch A");
});
test("finalization rejects reentrant stop and runs once per Job across revival", { timeout: 3000 }, async () => {
  const finalized = [];
  const runtime = createSubagentRuntime({
    session: SESSION,
    startJob: () => ({ done: Promise.resolve({ result: "done", messages: [] }) }),
    finalizeJob({ job, outcome }) {
      const stopResult = runtime.cancelJob(job.jobId);
      assert.equal(stopResult.ok, false);
      assert.equal(stopResult.reason, "finalizing");
      finalized.push({ jobId: job.jobId, status: outcome.status, round: outcome.round });
    },
  });
  const actor = runtime.create(batch(member("reentrant"))).items[0];
  await runtime.jobDone(actor.id);
  const next = await resume(runtime, actor, "continue");
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
    session: SESSION,
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

  const created = runtime.create(batch(member("T1", "Do work")));
  const actor = created.items[0];
  t.after(async () => {
    finalizeResolve();
    await runtime.jobDone(actor.id);
  });

  // 1. Native execution resolves
  jobHandleResolve({ result: "native work done", messages: [] });
  await entered.promise;

  // 2. Status should be finalizing, actor is live/busy
  const jobState = runtime.jobs({ jobIds: [actor.id] }).jobs[0];
  assert.equal(jobState.status, "finalizing");

  // A managed write during finalizing must be rejected with agent_busy
  await assert.rejects(
    resume(runtime, actor, "ping during finalizing"),
    (err) => err.code === "agent_busy",
  );

  // 3. Resolve finalization (I/O done)
  finalizeResolve();
  await runtime.jobDone(actor.id);

  const finalJobState = runtime.jobs({ jobIds: [actor.id] }).jobs[0];
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
    session: SESSION,
    startJob(request) {
      started.push(request.agentId);
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
  const actors = runtime.create(batch(member("first"), member("notStarted"))).items;
  t.after(async () => {
    native.resolve({ result: "done" });
    history.resolve();
    await Promise.all(actors.map((actor) => runtime.jobDone(actor.id)));
  });
  assert.equal(started.length, 1);
  assert.equal(runtime.jobs().jobs[1].status, "finalizing");
  assert.deepEqual(finalized, [{ name: "notStarted", status: "cancelled" }]);
  history.resolve();
  const ended = await runtime.jobDone(actors[1].id);
  assert.equal(ended.status, "cancelled");
  assert.equal(ended.historyState, "ready");
  assert.equal(finalized.length, 1);
});
