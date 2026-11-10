import assert from "node:assert/strict";
import test from "node:test";

import { buildHistoryPort } from "../../src/harness-rpc/ports/history.ts";
import { RpcRequestError } from "../../src/harness-rpc/error.ts";
import { createSubagentRuntime, type JobRequest, type JobSnapshotView, type SubagentRuntime } from "../../src/subagent/runtime.ts";
import type { RootService } from "../../src/subagent/root-service.ts";
import type { NativeLiveSnapshot } from "../../src/subagent/native-types.ts";

interface Running {
  readonly runtime: SubagentRuntime;
  readonly jobId: string;
  readonly finish: (endEntryId: string) => void;
}

function runningJob(start: string | null = "e1"): Running {
  let resolveDone!: (outcome: unknown) => void;
  const done = new Promise<unknown>((resolve) => {
    resolveDone = resolve;
  });
  const runtime = createSubagentRuntime({
    startJob: (request: JobRequest) => {
      request.recordStart(start);
      return { done, cancel() {} };
    },
  });
  const created = runtime.create({ tasks: [{ task: "do work" }] });
  const item = created.items[0];
  assert.ok(item);
  return {
    runtime,
    jobId: item.id,
    finish: (endEntryId) => resolveDone({ status: "completed", result: "done", history: { startEntryId: start, endEntryId } }),
  };
}

function rootWithRuntime(
  runtime: SubagentRuntime,
  options: { live?: NativeLiveSnapshot | null; entries?: readonly unknown[] | null } = {},
): { root: RootService; interval(): { startEntryId: string | null; endEntryId: string | null } | null } {
  let requested: { startEntryId: string | null; endEntryId: string | null } | null = null;
  const root = {
    sessionId: "session-root",
    runtime,
    liveSnapshot: () => options.live ?? null,
    actors: {
      readInterval: (input: { startEntryId: string | null; endEntryId: string | null }) => {
        requested = { startEntryId: input.startEntryId, endEntryId: input.endEntryId };
        return options.entries ?? null;
      },
    },
  } as unknown as RootService;
  return { root, interval: () => requested };
}

test("a running Job returns the interval produced so far plus the live end", () => {
  const running = runningJob();
  const live: NativeLiveSnapshot = { startEntryId: "e1", endEntryId: "e2", messages: [], entries: [], partial: null };
  const harness = rootWithRuntime(running.runtime, { live, entries: [{ type: "message", id: "e1" }] });
  const result = buildHistoryPort(harness.root).read({ jobId: running.jobId });

  assert.equal(result.available, true);
  assert.equal(result.status, "running");
  assert.equal(result.live, true);
  assert.deepEqual(result.bounds, { startEntryId: "e1", endEntryId: "e2" });
  assert.deepEqual(harness.interval(), { startEntryId: "e1", endEntryId: "e2" });
  assert.deepEqual(result.entries, [{ type: "message", id: "e1" }]);

  running.finish("e3");
  return running.runtime.jobDone(running.jobId).then(() => undefined);
});

test("a settled Job returns its sealed interval and reports live=false", async () => {
  const running = runningJob();
  running.finish("e3");
  await running.runtime.jobDone(running.jobId);

  const harness = rootWithRuntime(running.runtime, { live: null, entries: [{ type: "message", id: "e1" }, { type: "message", id: "e3" }] });
  const result = buildHistoryPort(harness.root).read({ jobId: running.jobId });
  assert.equal(result.available, true);
  assert.equal(result.status, "completed");
  assert.equal(result.live, false);
  assert.deepEqual(result.bounds, { startEntryId: "e1", endEntryId: "e3" });
});

test("a legitimate null start is read as the branch head, not treated as not-started", async () => {
  // A first Job may legitimately record a null start (the SDK leaf was null
  // before the session recorded anything). It is not "not started".
  const running = runningJob(null);
  const live: NativeLiveSnapshot = {
    startEntryId: null,
    endEntryId: "e2",
    messages: [{ role: "assistant" }],
    entries: [{ type: "message", id: "e2" }],
    partial: null,
  };
  const harness = rootWithRuntime(running.runtime, { live, entries: [{ type: "message", id: "e2" }] });

  const runningRead = buildHistoryPort(harness.root).read({ jobId: running.jobId });
  assert.equal(runningRead.available, true);
  assert.equal(runningRead.status, "running");
  assert.equal(runningRead.live, true);
  assert.deepEqual(runningRead.bounds, { startEntryId: null, endEntryId: "e2" });
  // The port must reach storage with a null start (branch head), not bail out.
  assert.deepEqual(harness.interval(), { startEntryId: null, endEntryId: "e2" });
  assert.deepEqual(runningRead.entries, [{ type: "message", id: "e2" }]);

  running.finish("e3");
  await running.runtime.jobDone(running.jobId);
  const settled = rootWithRuntime(running.runtime, { live: null, entries: [{ type: "message", id: "e3" }] });
  const settledRead = buildHistoryPort(settled.root).read({ jobId: running.jobId });
  assert.equal(settledRead.available, true);
  assert.equal(settledRead.status, "completed");
  assert.equal(settledRead.live, false);
  assert.deepEqual(settledRead.bounds, { startEntryId: null, endEntryId: "e3" });
});

test("history distinguishes unknown, not-yet-started and unreadable intervals", () => {
  const running = runningJob();
  // A registered Job before its native start boundary is recorded.
  const notStarted = {
    sessionId: "s",
    runtime: {
      jobSnapshot: (_id: string): JobSnapshotView => ({
        jobId: running.jobId,
        agentId: running.jobId,
        name: null,
        round: 1,
        status: "running",
        history: null,
        error: null,
        previousJobId: null,
      }),
    },
    liveSnapshot: () => null,
  } as unknown as RootService;
  assert.deepEqual(buildHistoryPort(notStarted).read({ jobId: running.jobId }), {
    available: false,
    jobId: running.jobId,
    status: "running",
    reason: "history_unavailable",
  });

  // A durable record whose interval cannot be read (memory-only).
  const live: NativeLiveSnapshot = { startEntryId: "e1", endEntryId: "e2", messages: [], entries: [], partial: null };
  const unreadable = rootWithRuntime(running.runtime, { live, entries: null });
  assert.equal(buildHistoryPort(unreadable.root).read({ jobId: running.jobId }).available, false);

  // An unknown Job is a structured not-found.
  assert.throws(
    () => buildHistoryPort(rootWithRuntime(running.runtime, { live, entries: [] }).root).read({ jobId: "sub_missing" }),
    (error: unknown) => error instanceof RpcRequestError && error.code === "not_found",
  );

  running.finish("e3");
  return running.runtime.jobDone(running.jobId).then(() => undefined);
});
