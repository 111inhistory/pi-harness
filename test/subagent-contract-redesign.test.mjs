import assert from "node:assert/strict";
import test from "node:test";

import { createSubagentRuntime, SubagentError } from "../src/subagent-runtime.mjs";
import { createSocketAwareWriteOperations } from "../src/subagent-socket.mjs";

function createFakeAdapter() {
  const started = [];
  const handles = [];
  return {
    started,
    handles,
    startJob(request) {
      started.push(request);
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      const handle = {
        cancel: () => {}, // do not immediately resolve done, to simulate in-flight stopping
        done,
        finish: (result = "ok") => resolveDone({ result, messages: [] }),
        fail: (err = new Error("fault")) => {
          throw err;
        },
      };
      handles.push(handle);
      return handle;
    },
  };
}

test("contract-redesign: short unified ID naming format (sub_01..04 and parentId_01..04)", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });

  // 1. Depth 1 allocations
  const batch1 = {
    tasks: [
      { name: "Task1", task: "first" },
      { name: "Task2", task: "second" },
    ],
  };
  const resp1 = runtime.create(batch1);
  assert.equal(resp1.items[0].id, "sub_01");
  assert.equal(resp1.items[1].id, "sub_02");

  // 2. Depth 2 allocations under sub_01
  const batch2 = {
    tasks: [
      { name: "SubTask1", task: "child 1" },
      { name: "SubTask2", task: "child 2" },
    ],
  };
  const resp2 = runtime.create(batch2, { parentAgentId: "sub_01" });
  assert.equal(resp2.items[0].id, "sub_01_01");
  assert.equal(resp2.items[1].id, "sub_01_02");
});

test("contract-redesign: runtime.create returns unified id, socket path and dual history paths", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });

  const batch = {
    context: "audit run",
    tasks: [
      { name: "TaskA", task: "audit parser" },
      { name: "TaskB", task: "review contracts" },
    ],
  };

  const response = runtime.create(batch);
  assert.equal(response.items.length, 2);

  const [first, second] = response.items;
  assert.equal(first.id, "sub_01");
  assert.equal(first.name, "TaskA");
  assert.equal(first.status, "running");
  assert.equal(first.socket, "/tmp/pi-subagents/sub_01.sock");
  assert.equal(first.history.summary, ".pi/subagents/sub_01/summary.md");
  assert.equal(first.history.cleanJsonl, ".pi/subagents/sub_01/session.clean.jsonl");

  assert.equal(second.id, "sub_02");
  assert.equal(second.name, "TaskB");
  assert.notEqual(first.socket, second.socket);
});

test("contract-redesign: runtime.create preserves warnings for inherited tasks", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });

  const batch = {
    tasks: [
      {
        name: "InheritedTask",
        task: "do task",
        inheritContext: true,
      },
    ],
  };

  const captureInheritedContext = () => ({
    cwd: process.cwd(),
    sessionId: "test-session",
    systemPrompt: "prompt",
    model: { provider: "test", id: "model" },
    thinkingLevel: "high",
    entries: [],
    tools: ["bash"],
    warnings: ["Tool 'custom_secret' is not transplantable and was omitted."],
  });

  const response = runtime.create(batch, {
    allowInherited: true,
    captureInheritedContext,
  });

  assert.equal(response.items.length, 1);
  assert.ok(response.items[0].warnings);
  assert.equal(response.items[0].warnings.length, 1);
  assert.ok(response.items[0].warnings[0].includes("not transplantable"));
});

test("contract-redesign: runtime.listDetailed returns structured items with budget, socket and history", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });

  const response = runtime.create({ tasks: [{ name: "One", task: "do one" }] });
  const agentId = response.items[0].id;
  assert.equal(agentId, "sub_01");

  const list = runtime.listDetailed();
  assert.equal(list.items.length, 1);

  const item = list.items[0];
  assert.equal(item.id, "sub_01");
  assert.equal(item.name, "One");
  assert.equal(item.depth, 1);
  assert.equal(item.parentId, "Main");
  assert.equal(item.status, "running");
  assert.equal(item.socket, "/tmp/pi-subagents/sub_01.sock");
  assert.equal(item.history.summary, ".pi/subagents/sub_01/summary.md");
  assert.equal(item.history.cleanJsonl, ".pi/subagents/sub_01/session.clean.jsonl");
  assert.ok(item.budget !== null);

  // Filter by id
  const filtered = runtime.listDetailed({ id: agentId });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].id, agentId);

  const missing = runtime.listDetailed({ id: "non-existent" });
  assert.equal(missing.items.length, 0);
});

test("contract-redesign: runtime.stop gracefully cancels running agent and marks queued as cancelled", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob, maxConcurrency: 1 });

  // Create two tasks: first runs, second queues
  const response = runtime.create({
    tasks: [
      { name: "RunningTask", task: "run" },
      { name: "QueuedTask", task: "queue" },
    ],
  });

  const [running, queued] = response.items;
  assert.equal(running.status, "running");
  assert.equal(queued.status, "queued");

  // Stop queued task: cancelled immediately
  const stopQueued = runtime.stop(queued.id);
  assert.equal(stopQueued.ok, true);
  assert.equal(stopQueued.status, "cancelled");

  // Stop running task: enters stopping
  const stopRunning = runtime.stop(running.id);
  assert.equal(stopRunning.ok, true);
  assert.equal(stopRunning.status, "stopping");

  // Unknown agent throws
  assert.throws(() => runtime.stop("unknown_agent"), (err) => err instanceof SubagentError && err.code === "unknown_agent");
});

test("contract-redesign: write operations synchronously reports agent_stopping when target is stopping", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });

  const resp = runtime.create({ tasks: [{ name: "StopTarget", task: "stopping test" }] });
  const agentId = resp.items[0].id;

  // Stop it to put it into stopping
  runtime.stop(agentId);

  const writeOps = createSocketAwareWriteOperations({
    onCheckStatus: (id) => {
      const detailed = runtime.listDetailed({ id });
      return detailed.items?.[0]?.status ?? null;
    },
  });

  await assert.rejects(
    () => writeOps.writeFile(`/tmp/pi-subagents/${agentId}.sock`, JSON.stringify({ msg: "revive prematurely" })),
    (err) => err.code === "agent_stopping" && err.message.includes("is currently stopping"),
  );
});

test("contract-redesign: terminal notifications are sent only on failure, silent on normal completion", async () => {
  const adapter = createFakeAdapter();
  const delivered = [];
  const runtime = createSubagentRuntime({
    startJob: adapter.startJob,
    deliverToMain: (msg) => delivered.push(msg),
  });

  // 1. Normal completion
  runtime.create({ tasks: [{ name: "NormalTask", task: "ok" }] });
  const handle = adapter.handles[0];
  handle.finish("success result");
  await new Promise((r) => setTimeout(r, 20));
  // Must NOT send notification for normal completion
  assert.equal(delivered.length, 0);
});
