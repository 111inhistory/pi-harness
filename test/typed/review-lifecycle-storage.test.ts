import assert from "node:assert/strict";
import test from "node:test";

import { createSubagentRuntime, SubagentError } from "../../src/subagent/runtime.ts";
import { ServiceLifecycle } from "../../src/subagent/lifecycle.ts";

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
  status: string;
  socket: string;
  history?: { jobId: string; summary: string; cleanJsonl: string };
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
    startJob: () => ({
      done: Promise.resolve({ result: "done" }),
      cancel() {},
    }),
    historyPaths: (jobId: string) => {
      if (jobId.includes("sub_02")) {
        throw new Error("EACCES: permission denied, open '/subagent-sessions/sub_02.jsonl'");
      }
      return { summary: "/tmp/sum.md", cleanJsonl: "/tmp/clean.jsonl" };
    },
  });

  const b1 = runtime.create({ tasks: [{ name: "healthy", task: "ok" }] }) as BatchCreationResult;
  const b2 = runtime.create({ tasks: [{ name: "corrupt", task: "bad" }] }) as BatchCreationResult;
  const id1 = b1.items[0]?.id;
  const id2 = b2.items[0]?.id;
  assert.ok(id1 && id2);

  await Promise.all([runtime.jobDone(id1), runtime.jobDone(id2)]);

  const detailed = runtime.listDetailed({}, { callerId: "Main" });
  assert.ok(detailed);
  const healthy = detailed.children.find((item) => item.id === id1);
  const broken = detailed.children.find((item) => item.id === id2);
  assert.ok(healthy, "Healthy item is returned even when a sibling history lookup fails");
  assert.ok(broken, "Broken item remains visible instead of collapsing the list");
  assert.deepEqual(healthy.history, {
    jobId: id1,
    summary: "/tmp/sum.md",
    cleanJsonl: "/tmp/clean.jsonl",
  });
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

test("A4 regression: Runtime protects domain stopping state against revival", async () => {
  // Exercising SubagentRuntime directly:
  // When cancelJob(jobId) is called, Runtime moves domain state to 'stopping'.
  // While in 'stopping', reviveWithNotification is strictly refused.
  // (In extensions/subagent.mjs:636, checking live.closed was a confused admission gate;
  // Runtime never permits revival while the domain job is stopping.)
  const jobHandle = deferredJob();

  const runtime = createSubagentRuntime({
    startJob: () => ({
      done: jobHandle.done,
      cancel() {},
    }),
  });

  const batch = runtime.create({ tasks: [{ name: "stop-test", task: "work" }] }) as BatchCreationResult;
  const jobId = batch.items[0]?.id;
  assert.ok(jobId);

  // Transition to domain stopping
  runtime.cancelJob(jobId);
  const jobsView = runtime.jobs({ jobIds: [jobId] }) as JobsQueryResult;
  assert.equal(jobsView.jobs[0]?.status, "stopping", "Domain status is stopping");

  // Runtime refuses revival with reason 'stopping'
  const wake = runtime.reviveWithNotification(jobId, {
    type: "notification",
    from: jobId,
    subagentId: jobId,
    jobId,
    round: 1,
    status: "completed",
    content: "done",
    error: null,
    history: null,
  });
  assert.equal(wake.woken, false);
  assert.equal(wake.reason, "stopping", "Runtime protects stopping state against revival");

  jobHandle.resolve({ status: "cancelled" });
  await runtime.jobDone(jobId);
});

test("A4 regression: Runtime restoreState repairs unended jobs to job_interrupted", () => {
  // Exercising SubagentRuntime directly:
  // Runtime's native planRestore/restoreState owns the repair decision and the
  // persisted/operator error code, without replaying or re-notifying the Job.
  const runtime = createSubagentRuntime({
    startJob: () => ({ done: Promise.resolve(), cancel() {} }),
  });

  const rawState = {
    actors: [{ agentId: "sub_01", name: "test", parentAgentId: null, depth: 1, stoppedOrder: 0 }],
    jobs: [
      {
        jobId: "sub_01",
        agentId: "sub_01",
        spec: { name: "test", task: "unended task" },
        end: null,
      },
    ],
  };

  const restoreResult = runtime.restoreState(rawState) as { actors: number; jobs: number; interrupted: string[] };
  assert.deepEqual(restoreResult.interrupted, ["sub_01"], "Runtime records interrupted job");

  const jobsView = runtime.jobs({ jobIds: ["sub_01"] }) as JobsQueryResult;
  assert.equal(jobsView.jobs[0]?.error?.code, "job_interrupted", "Runtime uses the persisted job_interrupted contract");
  const record = runtime.jobRecord("sub_01");
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
