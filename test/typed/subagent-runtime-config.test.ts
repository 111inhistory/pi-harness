/**
 * Resolved Harness settings as the Subagent runtime consumes them.
 *
 * These cases exercise the production runtime with its own config snapshot:
 * depth admission, per-depth Budget profiles, the three independent per-parent
 * limits (batches, direct subagents and the inherited subset), the deadline
 * watch, and historical topology whose depth is above a reduced maximum.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { resolveHarnessConfig } from "../../src/harness-config.ts";
import {
  SubagentError,
  createSubagentRuntime,
  type JobRequest,
} from "../../src/subagent/runtime.ts";
import { formatAddress, parseActorKey } from "../../src/subagent/address.ts";

const SESSION = "01a1deac";
const addressOf = (agentId: string): string => formatAddress(SESSION, agentId);

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

/** One restored Actor description. */
function restoredActor(
  agentId: string,
  depth: number,
  parentAgentId: string | null,
  kind: "fresh" | "inherited" = "fresh",
  stoppedOrder = depth,
) {
  const key = parseActorKey(agentId);
  assert.ok(key !== null && key.batch !== null, `${agentId} is a subagent actor key`);
  const goal = `goal of ${agentId}`;
  return {
    agentId,
    name: null,
    parentAgentId,
    depth,
    batch: key.batch,
    member: key.member,
    goal,
    context: null,
    roster: [{ id: agentId, name: null, goal }],
    kind,
    stoppedOrder,
  };
}

function completedJob(agentId: string, createdBy: string) {
  return {
    jobId: agentId,
    agentId,
    createdBy,
    // The canonical v3 persisted spec. The context kind lives on the Actor;
    // restoration must derive it from there instead of expecting a third field.
    spec: { kind: "initial", inheritedContext: null },
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
    session: SESSION,
    config: config({ subagent: { maxDepth: 3, budgetsByDepth: {
      3: {
        modelCalls: { soft: 5, hard: 7 },
        activeTimeMs: { soft: 1_000, hard: 2_000 },
        lifetimeMs: 5_000,
      },
    } } }),
    startJob: (request) => fake.startJob(request),
  });

  const first = runtime.create({ agents: [{ goal: "depth one" }] }).items[0];
  assert.ok(first);
  const second = runtime.create({ agents: [{ goal: "depth two" }] }, { parentAgentId: first.id }).items[0];
  assert.ok(second);
  const third = runtime.create({ agents: [{ goal: "depth three" }] }, { parentAgentId: second.id }).items[0];
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
    () => runtime.create({ agents: [{ goal: "depth four" }] }, { parentAgentId: third.id }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "max_depth_exceeded"
      && error.detail.maxDepth === 3,
  );
});

test("the configured direct-subagent limit is live admission, not the list window", async () => {
  const wide = adapter();
  const runtime = createSubagentRuntime({
    session: SESSION,
    config: config({ subagent: { maxActiveSubagents: 6 } }),
    startJob: (request) => wide.startJob(request),
  });
  const created = runtime.create({
    agents: Array.from({ length: 6 }, (_, index) => ({ goal: `child ${index}` })),
  }).items;
  assert.equal(created.length, 6);
  assert.equal(runtime.list({ status: "running" }).agents.length, 6);
  assert.throws(
    () => runtime.create({ agents: [{ goal: "seventh" }] }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "subagent_limit_exceeded"
      && error.detail.activeChildren === 6
      && error.detail.requestedChildren === 1
      && error.detail.maxActiveSubagents === 6,
  );
  const main = runtime.listDetailed(null, { callerId: "main" });
  assert.ok(main);
  assert.equal(main.children.length, 4, "the display window stays four rows independently of admission");

  for (const item of created) wide.handle(item.id).resolve({ result: "done" });
  await Promise.all(created.map((item) => runtime.jobDone(item.id)));

  const narrow = adapter();
  const narrowRuntime = createSubagentRuntime({
    session: SESSION,
    config: config({ subagent: { maxActiveSubagents: 2 } }),
    startJob: (request) => narrow.startJob(request),
  });
  const first = narrowRuntime.create({ agents: [{ goal: "one" }] }).items[0];
  assert.ok(first);
  const second = narrowRuntime.create({ agents: [{ goal: "two" }] }).items[0];
  assert.ok(second);
  assert.throws(
    () => narrowRuntime.create({ agents: [{ goal: "three" }] }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "subagent_limit_exceeded"
      && error.detail.activeChildren === 2
      && error.detail.requestedChildren === 1
      && error.detail.maxActiveSubagents === 2,
  );
  // A freed slot is reused immediately.
  narrow.handle(first.id).resolve({ result: "done" });
  await narrowRuntime.jobDone(first.id);
  assert.equal(narrowRuntime.create({ agents: [{ goal: "three" }] }).items.length, 1);
});

test("the batch limit counts live batches, not their members", async () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({
    session: SESSION,
    config: config({ subagent: { maxActiveBatches: 2, maxActiveSubagents: 6 } }),
    startJob: (request) => fake.startJob(request),
  });
  const first = runtime.create({ agents: [{ goal: "b1m1" }, { goal: "b1m2" }, { goal: "b1m3" }] }).items;
  const second = runtime.create({ agents: [{ goal: "b2m1" }, { goal: "b2m2" }] }).items;
  assert.equal(runtime.list({ status: "running" }).agents.length, 5, "the member cap still has room");
  assert.throws(
    () => runtime.create({ agents: [{ goal: "b3m1" }] }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "batch_limit_exceeded"
      && error.detail.activeBatches === 2
      && error.detail.maxActiveBatches === 2,
  );

  // One batch stays live while any member runs; finishing one member frees no
  // batch slot, but finishing every member of the first batch does.
  fake.handle(first[0]!.id).resolve({ result: "done" });
  await runtime.jobDone(first[0]!.id);
  assert.throws(
    () => runtime.create({ agents: [{ goal: "b3m1" }] }),
    (error: unknown) => error instanceof SubagentError && error.code === "batch_limit_exceeded",
  );
  for (const item of first.slice(1)) {
    fake.handle(item.id).resolve({ result: "done" });
    await runtime.jobDone(item.id);
  }
  const third = runtime.create({ agents: [{ goal: "b3m1" }, { goal: "b3m2" }] }).items;
  assert.equal(third.length, 2);
  void second;
});

test("a configured depth-one maximum admits a leaf child but no descendant", () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({
    session: SESSION,
    config: config({ subagent: { maxDepth: 1 } }),
    startJob: (request) => fake.startJob(request),
  });
  const leaf = runtime.create({ agents: [{ goal: "only child" }] }).items[0];
  assert.ok(leaf);
  assert.throws(
    () => runtime.create({ agents: [{ goal: "grandchild" }] }, { parentAgentId: leaf.id }),
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
    session: SESSION,
    config: config({ subagent: { budgetsByDepth: {
      1: {
        modelCalls: { soft: 2, hard: 3 },
        activeTimeMs: { soft: 1_000, hard: 2_000 },
        lifetimeMs: 100_000,
      },
    } } }),
    startJob: (request) => fake.startJob(request),
  });
  const item = runtime.create({ agents: [{ goal: "watched" }] }).items[0];
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
    session: SESSION,
    config: config({ subagent: { maxDepth: 2 } }),
    startJob: () => ({ done: new Promise(() => {}), cancel() {} }),
  });
  const restored = runtime.restoreState({
    actors: [
      restoredActor("sub_2", 1, null, "fresh", 1),
      restoredActor("sub_3", 2, "sub_2", "fresh", 2),
      restoredActor("sub_4", 3, "sub_3", "fresh", 3),
    ],
    jobs: [
      completedJob("sub_2", "main"),
      completedJob("sub_3", "sub_2"),
      completedJob("sub_4", "sub_3"),
    ],
  });
  assert.deepEqual(restored.interrupted, []);
  assert.deepEqual(runtime.list().agents.map((agent) => [agent.agentId, agent.depth]), [
    ["sub_2", 1],
    ["sub_3", 2],
    ["sub_4", 3],
  ]);
  const record = runtime.jobRecord("sub_4");
  assert.equal(record?.status, "completed");
  assert.equal(record?.result, "done");

  await assert.rejects(
    runtime.sendMessage({ from: addressOf("main"), to: addressOf("sub_4"), content: "continue" }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "max_depth_exceeded"
      && error.detail.depth === 3
      && error.detail.maxDepth === 2,
  );
  assert.throws(
    () => runtime.create({ agents: [{ goal: "depth three again" }] }, { parentAgentId: "sub_3" }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "max_depth_exceeded"
      && error.detail.maxDepth === 2,
  );
  // A depth that the current configuration still admits keeps working.
  const admitted = runtime.create({ agents: [{ goal: "depth two again" }] }, { parentAgentId: "sub_2" });
  assert.equal(runtime.list().agents.find((agent) => agent.agentId === admitted.items[0]?.id)?.depth, 2);
});

test("the inherited cap is a subset of the direct-subagent cap, not a separate pool", () => {
  const fake = adapter();
  const capture = () => ({ systemPrompt: "p", tools: [], entries: [] });
  const runtime = createSubagentRuntime({
    session: SESSION,
    config: config({ subagent: { maxActiveSubagents: 5, maxActiveInheritedSubagents: 2 } }),
    startJob: (request) => fake.startJob(request),
  });

  // Two Fresh and two Inherited children: total 4/5, inherited 2/2.
  runtime.create({ agents: [{ goal: "fresh 1" }, { goal: "fresh 2" }] });
  runtime.create(
    { agents: [{ goal: "inherited 1", inheritContext: true }, { goal: "inherited 2", inheritContext: true }] },
    { captureInheritedContext: capture },
  );

  // A third Inherited child still fits the total cap but exceeds the subset.
  assert.throws(
    () => runtime.create(
      { agents: [{ goal: "inherited 3", inheritContext: true }] },
      { captureInheritedContext: capture },
    ),
    (error: unknown) => error instanceof SubagentError
      && error.code === "inherited_limit_exceeded"
      && error.detail.activeInherited === 2
      && error.detail.requestedInherited === 1
      && error.detail.maxActiveInheritedSubagents === 2,
  );

  // A Fresh child is admitted while the inherited subset is full.
  runtime.create({ agents: [{ goal: "fresh 3" }] });
  assert.equal(runtime.list({ status: "running" }).agents.length, 5);
  assert.throws(
    () => runtime.create({ agents: [{ goal: "fresh 4" }] }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "subagent_limit_exceeded"
      && error.detail.activeChildren === 5
      && error.detail.maxActiveSubagents === 5,
  );
});

test("the runtime bounds an inherited declaration above the total by the total", () => {
  const fake = adapter();
  const capture = () => ({ systemPrompt: "p", tools: [], entries: [] });
  const runtime = createSubagentRuntime({
    session: SESSION,
    // The inherited declaration stays at its default 3; the total is 2.
    config: config({ subagent: { maxActiveSubagents: 2 } }),
    startJob: (request) => fake.startJob(request),
  });
  const created = runtime.create({
    agents: [
      { goal: "i1", inheritContext: true },
      { goal: "i2", inheritContext: true },
    ],
  }, { captureInheritedContext: capture }).items;
  assert.equal(created.length, 2, "the declared inherited cap does not override the smaller total");
  assert.equal(runtime.list({ status: "running" }).agents.length, 2);

  // A third Inherited child is refused by the total, the effective upper bound.
  assert.throws(
    () => runtime.create(
      { agents: [{ goal: "i3", inheritContext: true }] },
      { captureInheritedContext: capture },
    ),
    (error: unknown) => error instanceof SubagentError
      && error.code === "subagent_limit_exceeded"
      && error.detail.activeChildren === 2
      && error.detail.maxActiveSubagents === 2,
  );
});

test("a mixed batch validates every limit atomically and refusal detail names the limit", () => {
  const fake = adapter();
  const capture = () => ({ systemPrompt: "p", tools: [], entries: [] });
  const runtime = createSubagentRuntime({
    session: SESSION,
    config: config({ subagent: { maxActiveSubagents: 4, maxActiveInheritedSubagents: 2 } }),
    startJob: (request) => fake.startJob(request),
  });

  // Mixed batch where the direct-subagent cap is exceeded before registration.
  assert.throws(
    () => runtime.create({
      agents: [
        { goal: "f1" },
        { goal: "f2" },
        { goal: "f3" },
        { goal: "f4" },
        { goal: "i1", inheritContext: true },
      ],
    }, { captureInheritedContext: capture }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "subagent_limit_exceeded"
      && error.message === "main already has 0 live direct children; at most 4 are allowed."
      && error.detail.parentAgentId === null
      && error.detail.activeChildren === 0
      && error.detail.requestedChildren === 5
      && error.detail.maxActiveSubagents === 4,
  );
  // Atomic: nothing was registered
  assert.equal(runtime.list().agents.length, 0);

  // The inherited subset is checked after the total, so it refuses on its own.
  assert.throws(
    () => runtime.create({
      agents: [
        { goal: "f1" },
        { goal: "i1", inheritContext: true },
        { goal: "i2", inheritContext: true },
        { goal: "i3", inheritContext: true },
      ],
    }, { captureInheritedContext: capture }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "inherited_limit_exceeded"
      && error.message === "main already has 0 live inherited children; at most 2 are allowed."
      && error.detail.parentAgentId === null
      && error.detail.activeInherited === 0
      && error.detail.requestedInherited === 3
      && error.detail.maxActiveInheritedSubagents === 2,
  );
  assert.equal(runtime.list().agents.length, 0);

  // Mixed batch within every limit admits all atomically
  const created = runtime.create({
    agents: [
      { goal: "f1" },
      { goal: "f2" },
      { goal: "i1", inheritContext: true },
      { goal: "i2", inheritContext: true },
    ],
  }, { captureInheritedContext: capture });
  assert.equal(created.items.length, 4);
  assert.equal(runtime.list({ status: "running" }).agents.length, 4);
});

test("reviving an Inherited agent consumes the inherited subset while a Fresh revival consumes only the total", async () => {
  const fake = adapter();
  const capture = () => ({ systemPrompt: "p", tools: [], entries: [] });
  const runtime = createSubagentRuntime({
    session: SESSION,
    config: config({ subagent: { maxActiveSubagents: 3, maxActiveInheritedSubagents: 1 } }),
    startJob: (request) => fake.startJob(request),
    deliverMessage: async () => ({ accepted: true }),
  });

  const fresh1 = runtime.create({ agents: [{ goal: "fresh 1" }] }).items[0]!;
  const inh1 = runtime.create(
    { agents: [{ goal: "inh 1", inheritContext: true }] },
    { captureInheritedContext: capture },
  ).items[0]!;

  // Finish both so they are idle.
  fake.handle(fresh1.id).resolve({ result: "done" });
  await runtime.jobDone(fresh1.id);
  fake.handle(inh1.id).resolve({ result: "done" });
  await runtime.jobDone(inh1.id);
  assert.equal(runtime.list({ status: "running" }).agents.length, 0);

  // One live Inherited and one live Fresh child: total 2/3, inherited 1/1.
  const inh2 = runtime.create(
    { agents: [{ goal: "inh 2", inheritContext: true }] },
    { captureInheritedContext: capture },
  ).items[0]!;
  const fresh2 = runtime.create({ agents: [{ goal: "fresh 2" }] }).items[0]!;
  assert.ok(inh2 && fresh2);

  // Reviving inh1 keeps the total in range but exceeds the inherited subset.
  await assert.rejects(
    runtime.sendMessage({ from: addressOf("main"), to: inh1.address, content: "wake" }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "inherited_limit_exceeded"
      && error.detail.activeInherited === 1
      && error.detail.requestedInherited === 1
      && error.detail.maxActiveInheritedSubagents === 1
      && error.message.includes("live inherited children"),
  );

  // Reviving the Fresh actor only consumes the total: the inherited subset is
  // full but does not block it.
  const freshReceipt = await runtime.sendMessage({ from: addressOf("main"), to: fresh1.address, content: "wake fresh" });
  assert.ok(freshReceipt.ok);

  // The total is now full (3/3), so another revival is refused by that limit.
  await assert.rejects(
    runtime.sendMessage({ from: addressOf("main"), to: inh1.address, content: "wake again" }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "subagent_limit_exceeded"
      && error.detail.activeChildren === 3
      && error.detail.maxActiveSubagents === 3,
  );
});

test("restored actors keep the pool of their persisted creation spec", async () => {
  const fake = adapter();
  const capture = () => ({ systemPrompt: "p", tools: [], entries: [] });
  const runtime = createSubagentRuntime({
    session: SESSION,
    config: config({ subagent: { maxActiveSubagents: 5, maxActiveInheritedSubagents: 1 } }),
    startJob: (request) => fake.startJob(request),
    deliverMessage: async () => ({ accepted: true }),
  });
  // The persisted creation spec is the only source of an actor's kind: no
  // separate field is stored, so restoration must derive it from the first Job.
  const restored = runtime.restoreState({
    actors: [
      restoredActor("sub_2", 1, null, "inherited", 1),
      restoredActor("sub_3", 1, null, "fresh", 2),
    ],
    jobs: [
      completedJob("sub_2", "main"),
      completedJob("sub_3", "main"),
    ],
  });
  assert.deepEqual(restored.interrupted, []);

  // Revive the restored Inherited actor; it now consumes the only subset slot.
  const inhReceipt = await runtime.sendMessage({ from: addressOf("main"), to: addressOf("sub_2"), content: "wake inherited" });
  assert.ok(inhReceipt.ok);
  const inhJobId = "jobId" in inhReceipt ? inhReceipt.jobId : null;
  assert.ok(inhJobId);

  runtime.create({ agents: [{ goal: "fresh holder 1" }] });
  runtime.create({ agents: [{ goal: "fresh holder 2" }] });
  // A new Inherited child exceeds the subset while the total still has room.
  assert.throws(
    () => runtime.create(
      { agents: [{ goal: "inherited holder", inheritContext: true }] },
      { captureInheritedContext: capture },
    ),
    (error: unknown) => error instanceof SubagentError
      && error.code === "inherited_limit_exceeded"
      && error.detail.activeInherited === 1
      && error.detail.maxActiveInheritedSubagents === 1,
  );

  // The restored Fresh actor is admitted because it only consumes the total.
  const freshReceipt = await runtime.sendMessage({ from: addressOf("main"), to: addressOf("sub_3"), content: "wake fresh" });
  assert.ok(freshReceipt.ok);
  assert.equal(runtime.list({ status: "running" }).agents.length, 4);

  // Freeing the inherited slot admits the restored Inherited actor again.
  fake.handle(inhJobId).resolve({ result: "done" });
  await runtime.jobDone(inhJobId);
  const again = await runtime.sendMessage({ from: addressOf("main"), to: addressOf("sub_2"), content: "wake inherited again" });
  assert.ok(again.ok);
});
