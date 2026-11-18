import assert from "node:assert/strict";
import test from "node:test";

import { createSubagentRuntime } from "../../src/subagent/runtime.ts";
import { foldEvents } from "../../src/subagent/storage.ts";
import { ServiceLifecycle } from "../../src/session/service-lifecycle.ts";

const SESSION = "01a1deac";

interface StartedJobHandle {
  done: Promise<{ result?: unknown; status?: string }>;
  cancel(): void;
  resolve(value: { result?: unknown; status?: string }): void;
  reject(error: unknown): void;
}

interface BatchCreationResult {
  items: Array<{ id: string; name?: string | null }>;
}

interface DetailedListItem {
  id: string;
  address: string;
  history?: { summary: string; cleanJsonl: string };
  historyError?: { code: string; message: string };
}


interface JobRecordView {
  jobId: string;
  agentId: string;
  status: string;
  error?: { code: string; message: string } | null;
}

interface JobsQueryResult {
  jobs: JobRecordView[];
}

interface DummyService {
  id: number;
  closed: boolean;
}

function deferredJob(): StartedJobHandle {
  let resolve!: (value: { result?: unknown; status?: string }) => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<{ result?: unknown; status?: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    done,
    resolve,
    reject,
    cancel() {},
  };
}

// ---------------------------------------------------------------------------
// A7: listDetailed history lookup failure effect
// ---------------------------------------------------------------------------

test("A7 regression: listDetailed isolates history lookup failure to its own item", async () => {
  // Exercising SubagentRuntime directly: historyPaths throws on one broken child file.
  const runtime = createSubagentRuntime({
    session: SESSION,
    startJob: () => ({
      done: Promise.resolve({ result: "done" }),
      cancel() {},
    }),
    historyPaths: (jobId: string) => {
      if (jobId === "sub_2") {
        throw new Error("EACCES: permission denied, open '/subagent-sessions/sub_02.jsonl'");
      }
      return { summary: "/tmp/sum.md", cleanJsonl: "/tmp/clean.jsonl" };
    },
  });

  const b1 = runtime.create({ agents: [{ name: "healthy", goal: "ok" }] }) as BatchCreationResult;
  const b2 = runtime.create({ agents: [{ name: "corrupt", goal: "bad" }] }) as BatchCreationResult;
  const id1 = b1.items[0]?.id;
  const id2 = b2.items[0]?.id;
  assert.ok(id1 && id2);

  await Promise.all([runtime.jobDone(id1), runtime.jobDone(id2)]);

  const detailed = runtime.listDetailed({}, { callerId: "main" });
  assert.ok(detailed);
  const healthy = detailed.children.find((item) => item.id === id1);
  const broken = detailed.children.find((item) => item.id === id2);
  assert.ok(healthy, "Healthy item is returned even when a sibling history lookup fails");
  assert.ok(broken, "Broken item remains visible instead of collapsing the list");
  assert.deepEqual(healthy.history, {
    summary: "/tmp/sum.md",
    cleanJsonl: "/tmp/clean.jsonl",
  });
  assert.equal("jobId" in healthy.history, false, "the list node never repeats the Job id");
  assert.equal("history" in broken, false);
  assert.deepEqual(broken.historyError, {
    code: "history_unavailable",
    message: "EACCES: permission denied, open '/subagent-sessions/sub_02.jsonl'",
  }, "The failure is reported per item with a stable structured code");

  // The derived view failure belongs to the list row, not to the terminal Job.
  const jobs = runtime.jobs({ jobIds: [id2] }) as JobsQueryResult;
  assert.equal(jobs.jobs[0]?.status, "completed");
  assert.equal("historyError" in (runtime.jobRecord(id2) ?? {}), false);
});

// ---------------------------------------------------------------------------
// A4: Domain state protection vs adapter admission barrier
// ---------------------------------------------------------------------------

test("A4 regression: a stopping parent is fenced from a late child settlement", async () => {
  // Exercising SubagentRuntime directly: cancelling the parent Job keeps its
  // slot in `stopping`, and a child that settles afterwards must not allocate a
  // continuation or synthesize a collaborator result message. The parent wake,
  // when configured, stays internal.
  const parentHandle = deferredJob();
  const settled: string[] = [];
  const deliveries: unknown[] = [];

  const runtime = createSubagentRuntime({
    session: SESSION,
    startJob: (request) => request.parentAgentId === null
      ? { done: parentHandle.done, cancel() {} }
      : { done: Promise.resolve({ result: "child done" }), cancel() {} },
    deliverMessage: (request) => { deliveries.push(request); return { accepted: true }; },
    onChildrenSettled: (parentId) => { settled.push(parentId); },
  });

  const parent = runtime.create({ agents: [{ name: "stop-test", goal: "work" }] }).items[0]!;
  const child = runtime.create({ agents: [{ name: "child", goal: "report" }] }, { parentAgentId: parent.id }).items[0]!;

  runtime.cancelJob(parent.id);
  const jobsView = runtime.jobs({ jobIds: [parent.id] }) as JobsQueryResult;
  assert.equal(jobsView.jobs[0]?.status, "stopping", "Domain status is stopping");

  await runtime.jobDone(child.id);
  assert.deepEqual(deliveries, [], "a child result is never auto-delivered as a collaborator message");
  assert.equal(runtime.jobs().jobs.length, 2, "settling the child allocates no continuation Job");
  assert.ok(settled.every((parentId) => parentId === parent.id),
    "the internal parent wake never invents another target");

  parentHandle.resolve({ status: "cancelled" });
  await runtime.jobDone(parent.id);
});

test("A4 regression: Runtime restoreState repairs unended jobs to job_interrupted", () => {
  // Exercising SubagentRuntime directly: persist the real event sequence of an
  // unended Job, fold it through the storage path, and restore into a fresh
  // runtime. The repair decision belongs to runtime, not to a hand-built
  // legacy spec or to replayed notifications.
  const events: unknown[] = [];
  const source = createSubagentRuntime({
    session: SESSION,
    startJob: () => ({ done: new Promise(() => {}), cancel() {} }),
    onEvent: (event) => { events.push(event); },
  });
  const created = source.create({ agents: [{ name: "test", goal: "unended task" }] }).items[0]!;

  const customTypes: Record<string, string> = {
    job: "subagent-job",
    "job-start": "subagent-job-start",
    "job-end": "subagent-job-end",
  };
  const folded = foldEvents(events.map((raw, index) => {
    const event = raw as { type: string } & Record<string, unknown>;
    const { type, ...data } = event;
    return { type: "custom", id: `review-${index}`, customType: customTypes[type], data: { v: 3, ...data } };
  }));

  const runtime = createSubagentRuntime({
    session: SESSION,
    startJob: () => ({ done: Promise.resolve(), cancel() {} }),
  });
  const restoreResult = runtime.restoreState(folded) as { actors: number; jobs: number; interrupted: string[] };
  assert.deepEqual(restoreResult.interrupted, [created.id], "Runtime records interrupted job");

  const jobsView = runtime.jobs({ jobIds: [created.id] }) as JobsQueryResult;
  assert.equal(jobsView.jobs[0]?.error?.code, "job_interrupted", "Runtime uses the persisted job_interrupted contract");
  const record = runtime.jobRecord(created.id);
  assert.equal(record?.status, "failed");
  assert.equal(record?.error?.code, "job_interrupted", "The repaired terminal decision is readable for persistence");
});

// ---------------------------------------------------------------------------
// A6: ServiceLifecycle retirement failure retains the resource fence
// ---------------------------------------------------------------------------

test("A6 regression: failed retirement cannot publish a replacement generation", async () => {
  const nativeExecutionAlive = true;

  const lifecycle = new ServiceLifecycle<DummyService>({
    async retire(service) {
      // Simulate retirement failure (e.g. native SDK execution failed to idle within timeout)
      if (nativeExecutionAlive) {
        throw new Error("Native SDK execution did not idle within timeout");
      }
      service.closed = true;
    },
  });

  const first = await lifecycle.activate(async (gen) => ({ id: gen, closed: false }));
  assert.equal(lifecycle.service, first);

  // Retirement fails
  await assert.rejects(lifecycle.retire(), /Native SDK execution did not idle/);

  assert.equal(lifecycle.service, null);
  assert.equal(lifecycle.retiring, true);
  let created = false;
  await assert.rejects(lifecycle.activate(async (gen) => {
    created = true;
    return { id: gen, closed: false };
  }), /Native SDK execution did not idle/);
  assert.equal(created, false);
  assert.equal(lifecycle.service, null, "the failed retirement keeps the published service fenced");
  assert.equal(lifecycle.retiring, true);
});
