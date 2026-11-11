/**
 * A real SubagentRuntime Job shared by the Harness RPC port tests.
 *
 * The Runtime, its request callbacks and its terminal record remain production
 * code; this fixture only keeps one Job running until the test resolves the
 * native outcome with the interval it wants sealed.
 */
import assert from "node:assert/strict";

import { createSubagentRuntime, type JobRequest, type SubagentRuntime } from "../../../src/subagent/runtime.ts";

export interface RunningJob {
  readonly runtime: SubagentRuntime;
  readonly jobId: string;
  readonly agentId: string;
  /** Resolve the native work so the Runtime seals this interval. */
  readonly finish: (endEntryId: string) => void;
}

export function startRunningJob(start: string | null = "e1"): RunningJob {
  let resolveDone!: (outcome: unknown) => void;
  const done = new Promise<unknown>((resolve) => { resolveDone = resolve; });
  const runtime = createSubagentRuntime({
    startJob: (request: JobRequest) => {
      request.recordStart(start);
      return { done, cancel() {} };
    },
  });
  const item = runtime.create({ tasks: [{ task: "do work" }] }).items[0];
  assert.ok(item);
  return {
    runtime,
    jobId: item.id,
    agentId: item.id,
    finish: (endEntryId) => resolveDone({
      status: "completed",
      result: "done",
      history: { startEntryId: start, endEntryId },
    }),
  };
}
