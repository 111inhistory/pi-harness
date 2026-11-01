/**
 * Resolved Harness settings as the Subagent runtime consumes them.
 *
 * These cases exercise the production runtime with its own config snapshot:
 * depth admission, per-depth Budget profiles, the live active-children limit
 * (independent of the fixed list window), the deadline watch, and historical
 * topology whose depth is above a reduced maximum.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { resolveHarnessConfig } from "../../src/harness-config.ts";
import {
  SubagentError,
  createSubagentRuntime,
  type JobRequest,
} from "../../src/subagent/runtime.ts";

function config(value: unknown) {
  return resolveHarnessConfig([{ source: "test", value }]);
}

interface Handle {
  request: JobRequest;
  resolve(outcome: unknown): void;
  cancel(): void;
}

function adapter() {
  const handles: Handle[] = [];
  let cancels = 0;
  return {
    handles,
    get cancels() { return cancels; },
    startJob(request: JobRequest): { done: Promise<unknown>; cancel(): void } {
      let resolve!: (outcome: unknown) => void;
      const done = new Promise<unknown>((settle) => { resolve = settle; });
      handles.push({
        request,
        resolve,
        cancel() { cancels += 1; },
      });
      return { done, cancel() { cancels += 1; } };
    },
    handle(jobId: string): Handle {
      const handle = handles.find((entry) => entry.request.jobId === jobId);
      assert.ok(handle, `job ${jobId} was never started`);
      return handle;
    },
  };
}

function completedJob(jobId: string, agentId: string, createdBy: string, task: string) {
  return {
    jobId,
    agentId,
    createdBy,
    spec: { name: null, task, context: null, inheritContext: false, inheritedContext: null },
    started: true,
    startEntryId: "e0",
    end: {
      status: "completed",
      result: "done",
      error: null,
      history: { startEntryId: "e0", endEntryId: "e1" },
      budget: null,
    },
  };
}

test("every reachable depth uses its configured Budget profile", () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({
    config: config({ subagent: { maxDepth: 3, budgetsByDepth: {
      3: {
        modelCalls: { soft: 5, hard: 7 },
        activeTimeMs: { soft: 1_000, hard: 2_000 },
        lifetimeMs: 5_000,
      },
    } } }),
    startJob: (request) => fake.startJob(request),
  });

  const first = runtime.create({ tasks: [{ task: "depth one" }] }).items[0];
  assert.ok(first);
  const second = runtime.create({ tasks: [{ task: "depth two" }] }, { parentAgentId: first.id }).items[0];
  assert.ok(second);
  const third = runtime.create({ tasks: [{ task: "depth three" }] }, { parentAgentId: second.id }).items[0];
  assert.ok(third);

  assert.deepEqual(runtime.list().agents.map((agent) => agent.depth), [1, 2, 3]);
  assert.deepEqual(
    fake.handles.map((handle) => handle.request.budget.snapshot({ detail: true }).profile.modelCalls.hard),
    [200, 100, 7],
    "each Job uses the profile resolved for its own depth",
  );
  assert.deepEqual(
    fake.handles.map((handle) => handle.request.budget.snapshot({ detail: true }).profile.activeTimeMs.hard),
    [7_200_000, 3_600_000, 2_000],
  );
  assert.throws(
    () => runtime.create({ tasks: [{ task: "depth four" }] }, { parentAgentId: third.id }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "max_depth_exceeded"
      && error.detail.maxDepth === 3,
  );
});

test("the configured active-children limit is live admission, not the list window", async () => {
  const wide = adapter();
  const runtime = createSubagentRuntime({
    config: config({ subagent: { maxActiveChildren: 6 } }),
    startJob: (request) => wide.startJob(request),
  });
  const created = runtime.create({
    tasks: Array.from({ length: 6 }, (_, index) => ({ task: `child ${index}` })),
  }).items;
  assert.equal(created.length, 6);
  assert.equal(runtime.list({ status: "running" }).agents.length, 6);
  assert.throws(
    () => runtime.create({ tasks: [{ task: "seventh" }] }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "child_limit_exceeded"
      && error.detail.kind === "fresh"
      && error.detail.activeChildren === 6
      && error.detail.requestedChildren === 1
      && error.detail.maxActiveChildren === 6,
  );
  const main = runtime.listDetailed(null, { callerId: "Main" });
  assert.ok(main);
  assert.equal(main.children.length, 4, "the display window stays four rows independently of admission");

  for (const item of created) wide.handle(item.id).resolve({ result: "done" });
  await Promise.all(created.map((item) => runtime.jobDone(item.id)));

  const narrow = adapter();
  const narrowRuntime = createSubagentRuntime({
    config: config({ subagent: { maxActiveChildren: 2 } }),
    startJob: (request) => narrow.startJob(request),
  });
  const first = narrowRuntime.create({ tasks: [{ task: "one" }] }).items[0];
  assert.ok(first);
  const second = narrowRuntime.create({ tasks: [{ task: "two" }] }).items[0];
  assert.ok(second);
  assert.throws(
    () => narrowRuntime.create({ tasks: [{ task: "three" }] }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "child_limit_exceeded"
      && error.detail.kind === "fresh"
      && error.detail.activeChildren === 2
      && error.detail.requestedChildren === 1
      && error.detail.maxActiveChildren === 2,
  );
  // A freed slot is reused immediately.
  narrow.handle(first.id).resolve({ result: "done" });
  await narrowRuntime.jobDone(first.id);
  assert.equal(narrowRuntime.create({ tasks: [{ task: "three" }] }).items.length, 1);
});

test("a configured depth-one maximum admits a leaf child but no descendant", () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({
    config: config({ subagent: { maxDepth: 1 } }),
    startJob: (request) => fake.startJob(request),
  });
  const leaf = runtime.create({ tasks: [{ task: "only child" }] }).items[0];
  assert.ok(leaf);
  assert.throws(
    () => runtime.create({ tasks: [{ task: "grandchild" }] }, { parentAgentId: leaf.id }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "max_depth_exceeded"
      && error.detail.maxDepth === 1,
  );
});

test("the runtime deadline watch uses the configured active-time limit", async (t: TestContext) => {
  let now = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => now);
  const fake = adapter();
  const runtime = createSubagentRuntime({
    config: config({ subagent: { budgetsByDepth: {
      1: {
        modelCalls: { soft: 2, hard: 3 },
        activeTimeMs: { soft: 1_000, hard: 2_000 },
        lifetimeMs: 100_000,
      },
    } } }),
    startJob: (request) => fake.startJob(request),
  });
  const item = runtime.create({ tasks: [{ task: "watched" }] }).items[0];
  assert.ok(item);
  const profile = fake.handles[0]?.request.budget.snapshot({ detail: true }).profile;
  assert.equal(profile?.activeTimeMs.hard, 2_000);

  now += 1_999;
  t.mock.timers.tick(1_999);
  assert.equal(fake.cancels, 0);
  assert.equal(runtime.jobs().jobs[0]?.status, "running");
  now += 1;
  t.mock.timers.tick(1);
  assert.equal(fake.cancels, 1, "the configured active hard limit stops the run");
  assert.equal(runtime.jobs().jobs[0]?.status, "stopping");
});

test("historical depth stays readable but cannot be revived under a reduced maximum", async () => {
  const runtime = createSubagentRuntime({
    config: config({ subagent: { maxDepth: 2 } }),
    startJob: () => ({ done: new Promise(() => {}), cancel() {} }),
  });
  const restored = runtime.restoreState({
    actors: [
      { agentId: "sub_01", name: null, parentAgentId: null, depth: 1, stoppedOrder: 1 },
      { agentId: "sub_01_01", name: null, parentAgentId: "sub_01", depth: 2, stoppedOrder: 2 },
      { agentId: "sub_01_01_01", name: null, parentAgentId: "sub_01_01", depth: 3, stoppedOrder: 3 },
    ],
    jobs: [
      completedJob("sub_01", "sub_01", "Main", "first generation"),
      completedJob("sub_01_01", "sub_01_01", "sub_01", "second generation"),
      completedJob("sub_01_01_01", "sub_01_01_01", "sub_01_01", "third generation"),
    ],
  });
  assert.deepEqual(restored.interrupted, []);
  assert.deepEqual(runtime.list().agents.map((agent) => [agent.agentId, agent.depth]), [
    ["sub_01", 1],
    ["sub_01_01", 2],
    ["sub_01_01_01", 3],
  ]);
  const record = runtime.jobRecord("sub_01_01_01");
  assert.equal(record?.status, "completed");
  assert.equal(record?.result, "done");

  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: "sub_01_01_01", content: "continue" }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "max_depth_exceeded"
      && error.detail.agentId === "sub_01_01_01"
      && error.detail.depth === 3
      && error.detail.maxDepth === 2,
  );
  assert.throws(
    () => runtime.create({ tasks: [{ task: "depth three again" }] }, { parentAgentId: "sub_01_01" }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "max_depth_exceeded"
      && error.detail.maxDepth === 2,
  );
  // A depth that the current configuration still admits keeps working.
  const admitted = runtime.create({ tasks: [{ task: "depth two again" }] }, { parentAgentId: "sub_01" });
  assert.equal(runtime.list().agents.find((agent) => agent.agentId === admitted.items[0]?.id)?.depth, 2);
});

test("Fresh pool full while an Inherited child is still admitted, and the inverse", () => {
  const fake = adapter();
  const capture = () => ({ systemPrompt: "p", tools: [], entries: [] });
  const runtime = createSubagentRuntime({
    config: config({ subagent: { maxActiveChildren: 2, maxActiveInheritedChildren: 1 } }),
    startJob: (request) => fake.startJob(request),
  });

  // Admit 2 Fresh children -> fresh pool full (2/2)
  runtime.create({ tasks: [{ task: "fresh 1" }, { task: "fresh 2" }] });
  assert.throws(
    () => runtime.create({ tasks: [{ task: "fresh 3" }] }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "child_limit_exceeded"
      && error.detail.kind === "fresh"
      && error.detail.activeChildren === 2
      && error.detail.maxActiveChildren === 2,
  );

  // Inherited child is still admitted while Fresh pool is full
  const inherited = runtime.create(
    { tasks: [{ task: "inherited 1", inheritContext: true }] },
    { captureInheritedContext: capture },
  ).items[0];
  assert.ok(inherited);

  // Now Inherited pool is also full (1/1)
  assert.throws(
    () => runtime.create(
      { tasks: [{ task: "inherited 2", inheritContext: true }] },
      { captureInheritedContext: capture },
    ),
    (error: unknown) => error instanceof SubagentError
      && error.code === "child_limit_exceeded"
      && error.detail.kind === "inherited"
      && error.detail.activeChildren === 1
      && error.detail.maxActiveChildren === 1,
  );

  // Inverse: Inherited pool full while Fresh child is still admitted
  const fake2 = adapter();
  const runtime2 = createSubagentRuntime({
    config: config({ subagent: { maxActiveChildren: 1, maxActiveInheritedChildren: 2 } }),
    startJob: (request) => fake2.startJob(request),
  });
  runtime2.create(
    { tasks: [{ task: "inh 1", inheritContext: true }, { task: "inh 2", inheritContext: true }] },
    { captureInheritedContext: capture },
  );
  assert.throws(
    () => runtime2.create(
      { tasks: [{ task: "inh 3", inheritContext: true }] },
      { captureInheritedContext: capture },
    ),
    (error: unknown) => error instanceof SubagentError
      && error.code === "child_limit_exceeded"
      && error.detail.kind === "inherited"
      && error.detail.activeChildren === 2
      && error.detail.maxActiveChildren === 2,
  );
  const fresh = runtime2.create({ tasks: [{ task: "fresh 1" }] }).items[0];
  assert.ok(fresh);
});

test("a mixed batch validates each pool atomically and refusal detail reports kind and pool limit", () => {
  const fake = adapter();
  const capture = () => ({ systemPrompt: "p", tools: [], entries: [] });
  const runtime = createSubagentRuntime({
    config: config({ subagent: { maxActiveChildren: 2, maxActiveInheritedChildren: 2 } }),
    startJob: (request) => fake.startJob(request),
  });

  // Mixed batch where Fresh exceeds: 3 fresh + 1 inherited (caps: 2 fresh, 2 inherited)
  assert.throws(
    () => runtime.create({
      tasks: [
        { task: "f1" },
        { task: "f2" },
        { task: "f3" },
        { task: "i1", inheritContext: true },
      ],
    }, { captureInheritedContext: capture }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "child_limit_exceeded"
      && error.message === 'Agent Main already has 0 active fresh children; at most 2 are allowed.'
      && error.detail.parentAgentId === null
      && error.detail.kind === "fresh"
      && error.detail.activeChildren === 0
      && error.detail.requestedChildren === 3
      && error.detail.maxActiveChildren === 2,
  );
  // Atomic: nothing was registered
  assert.equal(runtime.list().agents.length, 0);

  // Mixed batch where Inherited exceeds: 1 fresh + 3 inherited
  assert.throws(
    () => runtime.create({
      tasks: [
        { task: "f1" },
        { task: "i1", inheritContext: true },
        { task: "i2", inheritContext: true },
        { task: "i3", inheritContext: true },
      ],
    }, { captureInheritedContext: capture }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "child_limit_exceeded"
      && error.message === 'Agent Main already has 0 active inherited children; at most 2 are allowed.'
      && error.detail.parentAgentId === null
      && error.detail.kind === "inherited"
      && error.detail.activeChildren === 0
      && error.detail.requestedChildren === 3
      && error.detail.maxActiveChildren === 2,
  );
  assert.equal(runtime.list().agents.length, 0);

  // Mixed batch within limits admits all atomically
  const created = runtime.create({
    tasks: [
      { task: "f1" },
      { task: "f2" },
      { task: "i1", inheritContext: true },
      { task: "i2", inheritContext: true },
    ],
  }, { captureInheritedContext: capture });
  assert.equal(created.items.length, 4);
  assert.equal(runtime.list({ status: "running" }).agents.length, 4);
});

test("reviving an Inherited agent consumes the inherited pool while reviving a Fresh agent consumes the fresh pool", async () => {
  const fake = adapter();
  const capture = () => ({ systemPrompt: "p", tools: [], entries: [] });
  const runtime = createSubagentRuntime({
    config: config({ subagent: { maxActiveChildren: 1, maxActiveInheritedChildren: 1 } }),
    startJob: (request) => fake.startJob(request),
    deliverMessage: async () => ({ accepted: true }),
  });

  const fresh1 = runtime.create({ tasks: [{ task: "fresh 1" }] }).items[0]!;
  const inh1 = runtime.create(
    { tasks: [{ task: "inh 1", inheritContext: true }] },
    { captureInheritedContext: capture },
  ).items[0]!;

  // Finish both so they are idle
  fake.handle(fresh1.id).resolve({ result: "done" });
  await runtime.jobDone(fresh1.id);
  fake.handle(inh1.id).resolve({ result: "done" });
  await runtime.jobDone(inh1.id);
  assert.equal(runtime.list({ status: "running" }).agents.length, 0);

  // Admit a fresh child: fresh pool full (1/1), inherited pool free (0/1)
  const fresh2 = runtime.create({ tasks: [{ task: "fresh 2" }] }).items[0]!;
  assert.ok(fresh2);

  // Reviving fresh1 fails because fresh pool is full
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: fresh1.id, content: "wake" }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "child_limit_exceeded"
      && error.detail.kind === "fresh"
      && error.detail.activeChildren === 1
      && error.detail.requestedChildren === 1
      && error.detail.maxActiveChildren === 1
      && error.message.includes("active fresh children"),
  );

  // Reviving inh1 succeeds because inherited pool has capacity (0/1)
  const inhReceipt = await runtime.sendMessage({ from: "Main", to: inh1.id, content: "wake" });
  assert.ok(inhReceipt.ok);
  const inhJobId = "jobId" in inhReceipt ? inhReceipt.jobId : null;
  assert.ok(inhJobId, "the inherited revival registered its continuation Job");

  // Now inherited pool is full (1/1). Free fresh pool by finishing fresh2
  fake.handle(fresh2.id).resolve({ result: "done" });
  await runtime.jobDone(fresh2.id);

  // Finish inh1 again so it becomes idle, then create inh2 to fill inherited pool
  fake.handle(inhJobId).resolve({ result: "done" });
  await runtime.jobDone(inhJobId);
  const inh2 = runtime.create(
    { tasks: [{ task: "inh 2", inheritContext: true }] },
    { captureInheritedContext: capture },
  ).items[0]!;
  assert.ok(inh2);

  // Reviving inh1 now fails because inherited pool is full (1/1)
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: inh1.id, content: "wake again" }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "child_limit_exceeded"
      && error.detail.kind === "inherited"
      && error.detail.activeChildren === 1
      && error.detail.requestedChildren === 1
      && error.detail.maxActiveChildren === 1
      && error.message.includes("active inherited children"),
  );

  // Reviving fresh1 succeeds because fresh pool has capacity (0/1)
  const freshReceipt = await runtime.sendMessage({ from: "Main", to: fresh1.id, content: "wake fresh" });
  assert.ok(freshReceipt.ok);
});

test("restored actors keep the pool of their persisted creation spec", async () => {
  const fake = adapter();
  const capture = () => ({ systemPrompt: "p", tools: [], entries: [] });
  const runtime = createSubagentRuntime({
    config: config({ subagent: { maxActiveChildren: 1, maxActiveInheritedChildren: 1 } }),
    startJob: (request) => fake.startJob(request),
    deliverMessage: async () => ({ accepted: true }),
  });
  // The persisted creation spec is the only source of an actor's kind: no
  // separate field is stored, so restoration must derive it from the first Job.
  const inheritedSeed = {
    ...completedJob("sub_01", "sub_01", "Main", "inherited seed"),
    spec: { name: null, task: "inherited seed", context: null, inheritContext: true, inheritedContext: null },
  };
  const restored = runtime.restoreState({
    actors: [
      { agentId: "sub_01", name: null, parentAgentId: null, depth: 1, stoppedOrder: 1 },
      { agentId: "sub_02", name: null, parentAgentId: null, depth: 1, stoppedOrder: 2 },
    ],
    jobs: [inheritedSeed, completedJob("sub_02", "sub_02", "Main", "fresh seed")],
  });
  assert.deepEqual(restored.interrupted, []);

  const fresh = runtime.create({ tasks: [{ task: "fresh holder" }] }).items[0]!;
  const inherited = runtime.create(
    { tasks: [{ task: "inherited holder", inheritContext: true }] },
    { captureInheritedContext: capture },
  ).items[0]!;

  // Both pools are full. Each refusal names the pool the restored actor occupies.
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: "sub_02", content: "wake fresh" }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "child_limit_exceeded"
      && error.detail.kind === "fresh"
      && error.detail.agentId === "sub_02",
  );
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: "sub_01", content: "wake inherited" }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "child_limit_exceeded"
      && error.detail.kind === "inherited"
      && error.detail.agentId === "sub_01",
  );

  // Freeing one pool admits only the actor that belongs to it.
  fake.handle(fresh.id).resolve({ result: "done" });
  await runtime.jobDone(fresh.id);
  assert.ok((await runtime.sendMessage({ from: "Main", to: "sub_02", content: "wake fresh" })).ok);
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: "sub_01", content: "wake inherited" }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "child_limit_exceeded"
      && error.detail.kind === "inherited",
  );

  fake.handle(inherited.id).resolve({ result: "done" });
  await runtime.jobDone(inherited.id);
  assert.ok((await runtime.sendMessage({ from: "Main", to: "sub_01", content: "wake inherited" })).ok);
});
