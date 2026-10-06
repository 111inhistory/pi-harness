import assert from "node:assert/strict";
import test from "node:test";

import { createSubagentRuntime, SubagentError } from "../src/subagent-runtime.mjs";

function createFakeAdapter() {
  const started = [];
  return {
    started,
    startJob(request) {
      started.push(request);
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      return {
        cancel: () => resolveDone({ result: "", messages: [] }),
        done,
        finish: (result = "ok") => resolveDone({ result, messages: [] }),
      };
    },
  };
}

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
  assert.ok(first.id);
  assert.equal(first.name, "TaskA");
  assert.equal(first.status, "running");
  assert.ok(first.socket.endsWith(".sock"));
  assert.ok(first.history.summary.endsWith("summary.md"));
  assert.ok(first.history.cleanJsonl.endsWith("session.clean.jsonl"));

  assert.ok(second.id);
  assert.equal(second.name, "TaskB");
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.socket, second.socket);
});

test("contract-redesign: runtime.listDetailed returns structured items with budget, socket and history", async () => {
  const adapter = createFakeAdapter();
  const runtime = createSubagentRuntime({ startJob: adapter.startJob });

  const response = runtime.create({ tasks: [{ name: "One", task: "do one" }] });
  const agentId = response.items[0].id;

  const list = runtime.listDetailed();
  assert.equal(list.items.length, 1);

  const item = list.items[0];
  assert.equal(item.id, agentId);
  assert.equal(item.name, "One");
  assert.equal(item.depth, 1);
  assert.equal(item.parentId, "Main");
  assert.equal(item.status, "running");
  assert.ok(item.socket.endsWith(".sock"));
  assert.ok(item.history.summary.endsWith("summary.md"));
  assert.ok(item.history.cleanJsonl.endsWith("session.clean.jsonl"));
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
