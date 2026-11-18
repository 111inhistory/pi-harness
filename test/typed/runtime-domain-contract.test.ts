/**
 * Typed domain-contract regressions for `src/subagent/runtime.ts`.
 *
 * These exercise the production runtime directly, not a copied adapter. They
 * pin the public factory/class surface, depth topology, terminal history
 * persistence through the real event fold, logical addresses and broadcast
 * receipts.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_HARNESS_CONFIG, resolveHarnessConfig } from "../../src/harness-config.ts";
import {
  SubagentError,
  createSubagentRuntime,
} from "../../src/subagent/runtime.ts";
import type {
  JobEndEvent,
  JobEvent,
  JobRequest,
  RuntimeEvent,
} from "../../src/subagent/runtime.ts";
import { formatAddress, formatGroupAddress } from "../../src/subagent/address.ts";
import { foldEvents } from "../../src/subagent/storage.ts";

const SESSION = "01a1deac";
const MAIN_ADDRESS = formatAddress(SESSION, "main");

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

/** Persist runtime events exactly as the root service does, then fold them. */
function foldedRegistry(events: readonly RuntimeEvent[]) {
  const customTypes = {
    job: "subagent-job",
    "job-start": "subagent-job-start",
    "job-end": "subagent-job-end",
  } as const;
  const branch = events.map((event, index) => {
    const { type, ...data } = event;
    return { type: "custom", id: `fold-${index}`, customType: customTypes[type], data: { v: 3, ...data } };
  });
  return foldEvents(branch);
}

test("the configured maximum depth gates the production topology", () => {
  const maxDepth = DEFAULT_HARNESS_CONFIG.subagent.maxDepth;
  assert.equal(maxDepth, 2);
  const fake = adapter();
  const runtime = createSubagentRuntime({ session: SESSION, startJob: fake.startJob });

  const root = runtime.create({ agents: [{ goal: "root" }] }).items[0];
  assert.ok(root);
  const child = runtime.create({ agents: [{ goal: "child" }] }, { parentAgentId: root.id }).items[0];
  assert.ok(child);
  assert.throws(
    () => runtime.create({ agents: [{ goal: "grandchild" }] }, { parentAgentId: child.id }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "max_depth_exceeded"
      && error.detail.maxDepth === maxDepth,
  );

  // A deeper resolved configuration admits one more generation and still stops
  // at its own leaf.
  const deep = createSubagentRuntime({
    session: SESSION,
    startJob: fake.startJob,
    config: resolveHarnessConfig([{ source: "test", value: { subagent: {
      maxDepth: 3,
      budgetsByDepth: {
        3: {
          modelCalls: { soft: 5, hard: 7 },
          activeTimeMs: { soft: 1_000, hard: 2_000 },
          lifetimeMs: 5_000,
        },
      },
    } } }]),
  });
  const first = deep.create({ agents: [{ goal: "depth one" }] }).items[0];
  assert.ok(first);
  const second = deep.create({ agents: [{ goal: "depth two" }] }, { parentAgentId: first.id }).items[0];
  assert.ok(second);
  const third = deep.create({ agents: [{ goal: "depth three" }] }, { parentAgentId: second.id }).items[0];
  assert.ok(third);
  assert.throws(
    () => deep.create({ agents: [{ goal: "depth four" }] }, { parentAgentId: third.id }),
    (error: unknown) => error instanceof SubagentError
      && error.code === "max_depth_exceeded"
      && error.detail.maxDepth === 3,
  );
});

test("terminal history metadata is published and survives restore", async () => {
  const events: RuntimeEvent[] = [];
  const runtime = createSubagentRuntime({
    session: SESSION,
    startJob: () => ({ done: Promise.resolve({ result: "done" }) }),
    finalizeJob: () => { throw new Error("history disk full"); },
    onEvent: (event) => { events.push(event); },
  });
  const created = runtime.create({ agents: [{ name: "writer", goal: "write history" }] }).items[0];
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

  // The registry description is folded from the runtime's own durable events,
  // the same path the root service uses, so no hand-built actor/spec shape is
  // involved.
  const state = foldedRegistry(events);
  assert.equal(state.actors[0]?.name, "writer");
  assert.equal(state.actors[0]?.goal, "write history");
  const restored = createSubagentRuntime({ session: SESSION, startJob: () => ({ done: Promise.resolve({}) }) });
  const restore = restored.restoreState(state);
  assert.deepEqual(restore.interrupted, []);
  assert.equal(restore.jobs, 1);

  const record = restored.jobRecord(created.id);
  assert.equal(record?.historyState, "error");
  assert.equal(record?.historyError?.code, "history_write_failed");
  const view = restored.jobs({ jobIds: [created.id] }).jobs[0];
  assert.equal(view?.historyState, "error");
  assert.equal(view?.historyError?.message, "history disk full");
});

test("logical addresses are derived from the session and canonical batch keys", () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({ session: SESSION, startJob: fake.startJob });
  const created = runtime.create({ agents: [{ goal: "address" }] }).items[0];
  assert.ok(created);
  assert.equal(created.id, "sub_1");
  assert.equal(created.address, formatAddress(SESSION, created.id));
  assert.equal(runtime.listDetailed({ id: created.id }, { callerId: "main" })?.address, created.address);

  // The address is derived from the session uid and the stable batch key, not
  // from a socket path passed through the runtime options.
  const second = runtime.create({ agents: [{ goal: "second" }] }).items[0];
  assert.ok(second);
  assert.equal(second.address, formatAddress(SESSION, second.id));
  assert.notEqual(second.address, created.address);
});

test("broadcast keeps the existing per-recipient receipt shape", async () => {
  const fake = adapter();
  const runtime = createSubagentRuntime({
    session: SESSION,
    startJob: fake.startJob,
    deliverMessage: fake.deliverMessage,
  });
  const items = runtime.create({ agents: [{ goal: "one" }, { goal: "two" }] }).items;
  assert.equal(items.length, 2);
  const group = formatGroupAddress(SESSION, 1);

  const receipt = await runtime.sendMessage({ from: MAIN_ADDRESS, to: group, content: "status?" });
  assert.equal("sent" in receipt, true);
  if (!("sent" in receipt)) assert.fail("expected a broadcast receipt");
  assert.deepEqual(receipt, {
    ok: true,
    to: group,
    sent: items.map((item) => ({ to: item.address, jobId: item.id })),
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
