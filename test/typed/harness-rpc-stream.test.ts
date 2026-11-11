import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { projectSessionEvent } from "../../src/harness-rpc/stream-projection.ts";
import { startRunningJob } from "./support/rpc-job-fixture.ts";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const retentionFixture = path.join(repositoryRoot, "test-support/rpc-observer-retention.mjs");

test("unsubscribed stream connections are collectible before the Job settles", { timeout: 20000 }, async () => {
  try {
    const { stdout, stderr } = await execute(
      process.execPath,
      ["--expose-gc", "--import", "tsx", retentionFixture],
      { cwd: repositoryRoot, timeout: 15000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
    );
    assert.match(stdout, /RETENTION_OK/, `retention fixture did not finish:\n${stdout}\n${stderr}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    assert.fail(`retention fixture failed: ${detail}`);
  }
});

test("projection drops cumulative partial and keeps tool-call identity", () => {
  const projected = projectSessionEvent({
    type: "message_update",
    message: { role: "assistant", usage: { input: 1 } },
    assistantMessageEvent: { type: "text_delta", delta: "hi", contentIndex: 0, partial: { huge: "cumulative" } },
  }) as Record<string, unknown>;
  const delta = projected.assistantMessageEvent as Record<string, unknown>;
  assert.equal(delta.delta, "hi");
  assert.equal("partial" in delta, false);

  const toolStart = projectSessionEvent({
    type: "message_update",
    message: { role: "assistant", usage: {} },
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 1,
      partial: { content: [{}, { type: "toolCall", id: "call-1", name: "read" }] },
    },
  }) as Record<string, unknown>;
  const toolDelta = toolStart.assistantMessageEvent as Record<string, unknown>;
  assert.equal(toolDelta.id, "call-1");
  assert.equal(toolDelta.toolName, "read");

  const execution = { type: "tool_execution_end", toolCallId: "call-1", parentToolCallId: "call-0" };
  assert.deepEqual(projectSessionEvent(execution), execution);
});

test("a detachable terminal observer removes only its listener and isolates observer failures", async () => {
  const running = startRunningJob();
  let detachedCalls = 0;
  let throwingCalls = 0;
  let keptView: unknown = null;
  const detach = running.runtime.observeJobDone(running.jobId, () => {
    detachedCalls += 1;
  });
  running.runtime.observeJobDone(running.jobId, () => {
    throwingCalls += 1;
    throw new Error("observer failed");
  });
  running.runtime.observeJobDone(running.jobId, (view) => {
    keptView = view;
  });

  detach();
  detach();
  running.finish("e3");
  const settled = await running.runtime.jobDone(running.jobId);

  assert.equal(detachedCalls, 0, "a detached listener is not invoked at settlement");
  assert.equal(throwingCalls, 1, "a throwing observer is still invoked once");
  assert.equal(keptView, settled, "all remaining observers and jobDone receive the same terminal view");

  let lateView: unknown = null;
  const detachLate = running.runtime.observeJobDone(running.jobId, (view) => {
    lateView = view;
  });
  detachLate();
  assert.deepEqual(lateView, settled, "a terminal Job reports its view immediately to a new observer");
});
