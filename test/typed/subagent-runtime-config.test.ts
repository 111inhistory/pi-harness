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
    [200, 64, 7],
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
      && error.detail.activeChildren === 6
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
      && error.detail.activeChildren === 2
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
