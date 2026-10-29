/**
 * Typed domain-contract regressions for `src/subagent/runtime.ts`.
 *
 * These exercise the production runtime directly, not a copied adapter. They
 * pin the public factory/class surface, depth topology, terminal history
 * persistence/restore, injected address formatting and broadcast receipts.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_AGENT_DEPTH,
  SubagentError,
  createSubagentRuntime,
} from "../../src/subagent/runtime.ts";
import type {
  JobEndEvent,
  JobEvent,
  JobRequest,
  RuntimeEvent,
} from "../../src/subagent/runtime.ts";
import { formatAgentSocketPath } from "../../src/subagent/address.ts";
import { getAgentSocketPath } from "../../src/ipc/socket.ts";

interface Handle {
  request: JobRequest;
  done: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cancel(): void;
}

function adapter() {
  const started: Handle[] = [];
  const deliveries: Array<{ agentId: string; jobId: string | null; content: string }> = [];
  const startJob = (request: JobRequest): Handle => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<unknown>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const handle: Handle = { request, done, resolve, reject, cancel() {} };
    started.push(handle);
    return handle;
  };
  const deliverMessage = (request: { agentId: string; jobId: string | null; message: { content?: unknown } }) => {
    deliveries.push({
      agentId: request.agentId,
      jobId: request.jobId,
      content: typeof request.message.content === "string" ? request.message.content : "",
    });
    return { accepted: true };
  };
  return { startJob, deliverMessage, started, deliveries };
}

function handleFor(started: Handle[], jobId: string): Handle {
  const handle = started.find((entry) => entry.request.jobId === jobId);
  assert.ok(handle, `job ${jobId} was never started`);
  return handle;
}

test("exports one MAX_AGENT_DEPTH and enforces it through the production topology", () => {
  assert.equal(MAX_AGENT_DEPTH, 2);
  const fake = adapter();
  const runtime = createSubagentRuntime({ startJob: fake.startJob });

  const root = runtime.create({ tasks: [{ task: "root" }] }).items[0];
  assert.ok(root);
  const child = runtime.create({ tasks: [{ task: "child" }] }, { parentAgentId: root.id }).items[0];
  assert.ok(child);
  assert.throws(
    () => runtime.create({ tasks: [{ task: "grandchild" }] }, { parentAgentId: child.id }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "max_depth_exceeded"
      && error.detail.maxDepth === MAX_AGENT_DEPTH,
  );
});

test("terminal history metadata is published and survives restore", async () => {
  const events: RuntimeEvent[] = [];
  const runtime = createSubagentRuntime({
    startJob: () => ({ done: Promise.resolve({ result: "done" }) }),
    finalizeJob: () => { throw new Error("history disk full"); },
    onEvent: (event) => { events.push(event); },
  });
  const created = runtime.create({ tasks: [{ name: "writer", task: "write history" }] }).items[0];
  assert.ok(created);
  const terminal = await runtime.jobDone(created.id);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.historyState, "error");
  assert.equal(terminal.historyError?.code, "history_write_failed");

  const jobEvent = events.find((event): event is JobEvent => event.type === "job");
  const endEvent = events.find((event): event is JobEndEvent => event.type === "job-end");
  assert.ok(jobEvent);
  assert.ok(endEvent);
  assert.equal(endEvent.historyState, "error", "the terminal event carries the history state");
  assert.deepEqual(endEvent.historyError, {
    code: "history_write_failed",
    message: "history disk full",
  }, "the terminal event carries the structured history failure");

  const restored = createSubagentRuntime({ startJob: () => ({ done: Promise.resolve({}) }) });
  const restore = restored.restoreState({
    actors: [{
      agentId: created.id,
      name: "writer",
      parentAgentId: null,
      depth: 1,
      stoppedOrder: 1,
    }],
    jobs: [{
      jobId: created.id,
      agentId: created.id,
      createdBy: "Main",
      spec: jobEvent.spec,
      end: {
        status: "completed",
        result: "done",
        error: null,
        history: endEvent.history,
        budget: endEvent.budget,
        historyState: endEvent.historyState,
        historyError: endEvent.historyError,
      },
    }],
  });
  assert.deepEqual(restore.interrupted, []);
  assert.equal(restore.jobs, 1);

  const record = restored.jobRecord(created.id);
  assert.equal(record?.historyState, "error");
  assert.equal(record?.historyError?.code, "history_write_failed");
  const view = restored.jobs({ jobIds: [created.id] }).jobs[0];
  assert.equal(view?.historyState, "error");
  assert.equal(view?.historyError?.message, "history disk full");
});

test("address formatting is an injectable pure port and matches the transport path", () => {
  const socketDir = "/tmp/runtime-domain-contract";
  const fake = adapter();
  const runtime = createSubagentRuntime({ startJob: fake.startJob, socketDir });
  const created = runtime.create({ tasks: [{ task: "address" }] }).items[0];
  assert.ok(created);
  assert.equal(created.socket, formatAgentSocketPath(created.id, socketDir));
  assert.equal(created.socket, getAgentSocketPath(created.id, socketDir));
  assert.equal(runtime.listDetailed({ id: created.id }, { callerId: "Main" }).items[0]?.socket, created.socket);

  const custom = createSubagentRuntime({
    startJob: fake.startJob,
    socketDir,
    agentSocketPath: (id, directory) => `custom://${directory ?? "unset"}/${id}`,
  });
  const customItem = custom.create({ tasks: [{ task: "custom address" }] }).items[0];
  assert.ok(customItem);
  assert.equal(customItem.socket, `custom://${socketDir}/${customItem.id}`);
});

test("broadcast keeps the existing per-recipient receipt shape", async () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({
    startJob: fake.startJob,
    deliverMessage: fake.deliverMessage,
  });
  const items = runtime.create({ tasks: [{ task: "one" }, { task: "two" }] }).items;
  assert.equal(items.length, 2);

  const receipt = await runtime.sendMessage({ from: "Main", to: "all", content: "status?" });
  assert.equal("sent" in receipt, true);
  if (!("sent" in receipt)) assert.fail("expected a broadcast receipt");
  assert.deepEqual(receipt, {
    ok: true,
    to: "all",
    sent: items.map((item) => ({ to: item.id, jobId: item.id })),
    errors: [],
  });
  assert.deepEqual(fake.deliveries.map((entry) => [entry.agentId, entry.content]), [
    [items[0]?.id, "status?"],
    [items[1]?.id, "status?"],
  ]);

  for (const item of items) {
    handleFor(fake.started, item.id).resolve({ result: "done" });
  }
  await Promise.all(items.map((item) => runtime.jobDone(item.id)));
});
