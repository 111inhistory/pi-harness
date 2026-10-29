import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createAgentSocketServer,
  createBroadcastSocketServer,
  createSocketAwareWriteOperations,
  getAgentSocketPath,
  getBroadcastSocketPath,
  writeSocketOneWay,
} from "../../src/subagent-socket.mjs";
import { sendDelivery, type DeliveryEntry } from "../../src/subagent/delivery.ts";
import { SubagentError } from "../../src/subagent-runtime.mjs";

async function createTempSocketDir(t: test.TestContext): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-review-delivery-"));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("SDK createWriteToolDefinition: tool execution contract discards ops.writeFile return value", async () => {
  // Confirm that WriteOperations.writeFile's return value is completely discarded by the SDK write tool.
  // The calling agent only receives `{ content: [{ type: "text", text: "Successfully wrote to ..." }] }`.
  let capturedContent: unknown = null;
  let capturedPath: unknown = null;

  const mockReceipt = {
    ok: true,
    recipient: "sub_01",
    jobId: "sub_01_job_1",
    mode: "delivered",
  };

  const operations = {
    mkdir: async () => {},
    // WriteOperations.writeFile returns the mock receipt object
    writeFile: async (absolutePath: string, content: string) => {
      capturedPath = absolutePath;
      capturedContent = content;
      return mockReceipt as unknown as void;
    },
  };

  const tool = createWriteToolDefinition(process.cwd(), { operations });
  const result = await tool.execute(
    "call-1",
    {
      path: "test-target.sock",
      content: JSON.stringify({ from: "Main", content: "hello child" }),
    },
    undefined,
    undefined,
    {} as never,
  );

  // Verify that the return value from tool.execute does NOT contain mockReceipt
  assert.equal(capturedPath, path.resolve(process.cwd(), "test-target.sock"));
  assert.equal(capturedContent, JSON.stringify({ from: "Main", content: "hello child" }));
  assert.deepEqual(result, {
    content: [{ type: "text", text: "Successfully wrote to test-target.sock" }],
    details: undefined,
  });
  const rawResult = result as unknown as Record<string, unknown>;
  assert.equal("ok" in rawResult, false);
  assert.equal("recipient" in rawResult, false);
  // Conclusion: Returning a delivery receipt from WriteOperations.writeFile alone CANNOT expose
  // the receipt to the caller. The tool definition's execute wrapper itself must return the typed receipt.
});

test("A1 baseline: a callback that explicitly swallows rejection cannot return it to the caller", async (t) => {
  const socketDir = await createTempSocketDir(t);
  const agentId = "sub_01";
  const socketPath = getAgentSocketPath(agentId, socketDir);

  const swallowedErrors: Error[] = [];
  let runtimeSendMessageCalled = false;

  // Simulate createAgentSocketServer as in extensions/subagent.mjs:
  // onMessage invokes runtime.sendMessage and catches any error into ui.notify (here swallowedErrors)
  const server = createAgentSocketServer({
    id: agentId,
    socketDir,
    root: socketDir,
    onMessage: (msg: unknown) => {
      const content = typeof msg === "string" ? msg : ((msg as { content?: string })?.content ?? JSON.stringify(msg));
      const from = (typeof msg === "object" && msg !== null && typeof (msg as { from?: string }).from === "string")
        ? (msg as { from: string }).from
        : "Main";

      // Simulate runtime admission validation (e.g. #planMessage rules)
      runtimeSendMessageCalled = true;
      if (!content || content.trim() === "") {
        const err = new SubagentError("invalid_message", "A message body must be a non-empty string.");
        swallowedErrors.push(err);
        return;
      }
      if (content.length > 32768) {
        const err = new SubagentError("invalid_message", "A message body must be at most 32768 characters.");
        swallowedErrors.push(err);
        return;
      }
      if (from === agentId) {
        const err = new SubagentError("invalid_target", "An actor cannot send a message to itself.");
        swallowedErrors.push(err);
        return;
      }
    },
    onError: (err: Error) => {
      swallowedErrors.push(err);
    },
  });
  t.after(async () => {
    await server.close();
  });
  await server.ready;

  // Caller sends an empty message over the socket
  // writeSocketOneWay connects, writes NDJSON, ends connection, and resolves
  const emptyFrame = JSON.stringify({ from: "Main", content: "   " }) + "\n";
  const clientResult = await writeSocketOneWay(socketPath, emptyFrame);

  // 1. Caller observes success (writeSocketOneWay returns undefined / resolves)
  assert.equal(clientResult, undefined);

  // Wait a tick for server readNdjson to parse and dispatch onMessage
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 2. Server-side validation threw invalid_message, but caller never observed it
  assert.equal(runtimeSendMessageCalled, true);
  assert.equal(swallowedErrors.length, 1);
  assert.equal(swallowedErrors[0] instanceof SubagentError, true);
  assert.equal((swallowedErrors[0] as SubagentError).code, "invalid_message");

  // 3. Same silent failure happens for self-send
  swallowedErrors.length = 0;
  runtimeSendMessageCalled = false;
  const selfFrame = JSON.stringify({ from: agentId, content: "self talking" }) + "\n";
  await writeSocketOneWay(socketPath, selfFrame);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(runtimeSendMessageCalled, true);
  assert.equal(swallowedErrors.length, 1);
  assert.equal((swallowedErrors[0] as SubagentError).code, "invalid_target");
});

test("A1: Socket broadcast returns a child failure without repeating successful deliveries", async (t) => {
  const socketDir = await createTempSocketDir(t);
  const parentId = "main";
  const broadcastPath = getBroadcastSocketPath(parentId, socketDir);

  const children = ["sub_01", "sub_02"];
  const deliveredChildren: string[] = [];
  const broadcastErrors: Error[] = [];

  // Caller-visible errors do not require a separate logging callback.
  const server = createBroadcastSocketServer({
    parentId,
    socketDir,
    root: socketDir,
    getDirectChildren: () => children,
    deliverMessage: (childId: string, _msg: unknown) => {
      if (childId === "sub_02") {
        // Child 2 is stopping or busy -> delivery rejects
        const err = new SubagentError("agent_busy", `Agent ${childId} is stopping`);
        broadcastErrors.push(err);
        return Promise.reject(err);
      }
      deliveredChildren.push(childId);
      return Promise.resolve({ ok: true });
    },
    onError: undefined,
  });
  t.after(async () => {
    await server.close();
  });
  await server.ready;

  // Caller broadcasts to children.sock
  const payload = { from: "Main", content: "all hands report" };
  await assert.rejects(writeSocketOneWay(broadcastPath, payload), { code: 'agent_busy' });

  // 2. Child 1 got the message, Child 2 failed
  assert.deepEqual(deliveredChildren, ["sub_01"]);
  assert.equal(broadcastErrors.length, 1);
  assert.equal((broadcastErrors[0] as SubagentError).code, "agent_busy");

  // 3. Caller has NO WAY of knowing:
  //    - that sub_01 succeeded
  //    - that sub_02 failed
  // If the caller retries the broadcast, sub_01 will receive a duplicate message!
});

test("I1: sendDelivery synchronous accepted:true masks async handoff failure, bypassing appendCompletion fallback", async () => {
  // Trace deliverMessage in extensions/subagent.mjs:
  // const result = sendToAgent(service, agentId, ...);
  // if (result.accepted) return { accepted: true, mode: "delivered" };
  // await appendCompletion(service, agentId, ...);

  let appendCompletionCalled = false;
  const handoffError = new Error("Session destroyed during async steer");

  // Mock sendDelivery where handoff fails asynchronously (e.g. live.session.sendCustomMessage rejects)
  const entry: DeliveryEntry = {
    sourceId: "sub_01",
    round: 1,
    content: "done",
    terminal: { status: "completed" },
  };

  const deliveryResult = sendDelivery(entry, {
    isActive: () => true,
    send: () => Promise.reject(handoffError),
  });

  // Observe sendDelivery contract:
  // accepted is true synchronously!
  assert.equal(deliveryResult.accepted, true);
  assert.ok(deliveryResult.completion instanceof Promise);

  // Recreate the deliverMessage logic from extensions/subagent.mjs:651
  const deliverMessageSim = async () => {
    if (deliveryResult.accepted) {
      return { accepted: true, mode: "delivered" };
    }
    // Fallback:
    appendCompletionCalled = true;
    return { accepted: true, mode: "retained" };
  };

  const outcome = await deliverMessageSim();

  // 1. deliverMessage returned "delivered" even though the actual send failed!
  assert.deepEqual(outcome, { accepted: true, mode: "delivered" });

  // 2. appendCompletion was NEVER called!
  assert.equal(appendCompletionCalled, false);

  // 3. The async completion settled to failure, but was completely unobserved
  const completionOutcome = await deliveryResult.completion;
  assert.deepEqual(completionOutcome, { ok: false, error: handoffError });

  // Conclusion: The notification is permanently lost from the session history because
  // deliverMessage branch was decided on `result.accepted` without awaiting native handoff.
});

test("Delivery semantics: SDK handoff vs full run await", async () => {
  // In Pi SDK:
  // - When session.isStreaming is true: sendCustomMessage with { triggerTurn: true, deliverAs: "steer" }
  //   calls agent.steer(appMessage) and returns immediately (handoff).
  // - When session.isStreaming is false: sendCustomMessage with { triggerTurn: true }
  //   calls `await this._startRun(...)`, which awaits the completion of the ENTIRE agent turn!

  let steerQueuePushed = false;
  let fullRunExecuted = false;

  const mockSession = {
    isStreaming: true,
    agent: {
      steer: (_msg: unknown) => {
        steerQueuePushed = true;
      },
    },
    async _startRun() {
      fullRunExecuted = true;
    },
    async sendCustomMessage(msg: unknown, options?: { triggerTurn?: boolean; deliverAs?: string }) {
      if (this.isStreaming && options?.triggerTurn !== false) {
        if (options?.deliverAs === "steer") {
          this.agent.steer(msg);
          return;
        }
      } else if (options?.triggerTurn) {
        await this._startRun();
      }
    },
  };

  // Case A: Streaming parent (handoff is instantaneous queue insertion)
  await mockSession.sendCustomMessage({ customType: "agent-delivery" }, { triggerTurn: true, deliverAs: "steer" });
  assert.equal(steerQueuePushed, true);
  assert.equal(fullRunExecuted, false);

  // Case B: Idle session (triggerTurn: true awaits the entire run)
  mockSession.isStreaming = false;
  await mockSession.sendCustomMessage({ customType: "agent-delivery" }, { triggerTurn: true, deliverAs: "steer" });
  assert.equal(fullRunExecuted, true);

  // Conclusion: "Completion" MUST mean SDK handoff (queue/steer acceptance), NOT model read or run settlement.
  // Unconditionally awaiting sendCustomMessage when idle would block on the entire agent run.
});

test("Retry safety distinction: pre-admission check rejection vs post-admission delivery", async (t) => {
  const socketDir = await createTempSocketDir(t);
  const targetId = "sub_01";
  const socketPath = getAgentSocketPath(targetId, socketDir);

  let currentStatus = "stopping";
  let timesChecked = 0;

  // Operations with onCheckStatus precheck (as in extensions/subagent.mjs)
  const operations = createSocketAwareWriteOperations({
    senderId: "main",
    onCheckStatus: async (_agent: string) => {
      timesChecked++;
      return currentStatus;
    },
    resolveEndpoint: async () => ({ isManaged: true, targetId, isBroadcast: false }),
  });

  // 1. Pre-admission rejection: Target is stopping -> throws synchronously BEFORE socket connect
  await assert.rejects(
    operations.writeFile(socketPath, "resume work"),
    (err: Error & { code?: string }) => err.code === "agent_stopping",
  );
  assert.equal(timesChecked, 1);

  // This failure is completely safe to retry because nothing was sent to the socket or target.
  // Once the agent becomes idle / stopped:
  currentStatus = "idle";

  // Simulate server receiving the retried message
  let serverReceived = false;
  const server = createAgentSocketServer({
    id: targetId,
    socketDir,
    root: socketDir,
    onMessage: () => {
      serverReceived = true;
    },
    onError: () => {},
  });
  t.after(async () => {
    await server.close();
  });
  await server.ready;

  // Retrying the write now succeeds without duplicate delivery
  await operations.writeFile(socketPath, "resume work");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(serverReceived, true);
});
