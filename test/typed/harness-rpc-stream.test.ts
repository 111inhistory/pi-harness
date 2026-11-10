import assert from "node:assert/strict";
import test from "node:test";

import { buildStreamPort } from "../../src/harness-rpc/ports/stream.ts";
import { projectSessionEvent } from "../../src/harness-rpc/stream-projection.ts";
import { RpcRequestError } from "../../src/harness-rpc/error.ts";
import type { RpcConnection } from "../../src/harness-rpc/transport.ts";
import { createSubagentRuntime, type JobRequest, type SubagentRuntime } from "../../src/subagent/runtime.ts";
import type { RootService } from "../../src/subagent/root-service.ts";
import type { NativeLiveSnapshot } from "../../src/subagent/native-types.ts";

interface FakeConnection {
  readonly events: Array<{ subscription: string; payload: Record<string, unknown> }>;
  addSubscription(unsubscribe: () => void): string;
  removeSubscription(id: string): boolean;
  pushEvent(subscription: string, payload: unknown): void;
}

function makeConnection(): FakeConnection {
  const events: Array<{ subscription: string; payload: Record<string, unknown> }> = [];
  const subscriptions = new Map<string, () => void>();
  let counter = 0;
  return {
    events,
    addSubscription(unsubscribe: () => void): string {
      counter += 1;
      const id = `sub-${counter}`;
      subscriptions.set(id, unsubscribe);
      return id;
    },
    removeSubscription(id: string): boolean {
      const unsubscribe = subscriptions.get(id);
      if (unsubscribe === undefined) return false;
      subscriptions.delete(id);
      unsubscribe();
      return true;
    },
    pushEvent(subscription: string, payload: unknown): void {
      events.push({ subscription, payload: payload as Record<string, unknown> });
    },
  };
}

interface Running {
  readonly runtime: SubagentRuntime;
  readonly jobId: string;
  readonly agentId: string;
  readonly finish: (endEntryId: string) => void;
}

/** A real SubagentRuntime Job that stays running until the test finishes it. */
function runningJob(): Running {
  let resolveDone!: (outcome: unknown) => void;
  const done = new Promise<unknown>((resolve) => {
    resolveDone = resolve;
  });
  const runtime = createSubagentRuntime({
    startJob: (request: JobRequest) => {
      request.recordStart("e1");
      return { done, cancel() {} };
    },
  });
  const created = runtime.create({ tasks: [{ task: "do work" }] });
  const item = created.items[0];
  assert.ok(item);
  return {
    runtime,
    jobId: item.id,
    agentId: item.id,
    finish: (endEntryId) => resolveDone({ status: "completed", result: "done", history: { startEntryId: "e1", endEntryId } }),
  };
}

interface RootHarness {
  root: RootService;
  listener(): ((event: unknown) => void) | null;
  detachCount(): number;
}

function rootFor(runtime: SubagentRuntime, live: NativeLiveSnapshot | null | (() => NativeLiveSnapshot | null)): RootHarness {
  let listener: ((event: unknown) => void) | null = null;
  let detaches = 0;
  const root = {
    sessionId: "session-root",
    runtime,
    subscribeJobEvents: (_jobId: string, registered: (event: unknown) => void) => {
      // Mirror the runner: a terminal Job has no live run to observe.
      if (live === null) return null;
      listener = registered;
      return () => {
        detaches += 1;
      };
    },
    liveSnapshot: () => (typeof live === "function" ? live() : live),
  } as unknown as RootService;
  return { root, listener: () => listener, detachCount: () => detaches };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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

test("an event can precede the subscribe response and still carries the assigned subscription id", async () => {
  const running = runningJob();
  const live: NativeLiveSnapshot = { endEntryId: "e2", messages: [], partial: null };
  const captured: { listener: ((event: unknown) => void) | null } = { listener: null };
  const root = {
    sessionId: "session-root",
    runtime: running.runtime,
    subscribeJobEvents: (_jobId: string, registered: (event: unknown) => void) => {
      captured.listener = registered;
      return () => {};
    },
    liveSnapshot: () => live,
  } as unknown as RootService;
  const port = buildStreamPort(root);
  const connection = makeConnection();
  // The subscribe handler registers synchronously; emit before awaiting the
  // response to model a wire event that precedes the response.
  const pending = port.subscribe({ jobId: running.jobId }, connection as unknown as RpcConnection);
  captured.listener?.({ type: "message_start", message: { role: "assistant", content: [] } });
  const result = (await pending) as Record<string, unknown>;
  assert.equal(result.subscription, "sub-1");
  assert.equal(connection.events.length, 1);
  assert.equal(connection.events[0]!.subscription, "sub-1", "the event carries the id assigned before the response");
});

test("a running Job yields a real snapshot boundary, then live deltas and the Runtime terminal event", async () => {
  const running = runningJob();
  // The terminal-only record is empty while the Job runs; the snapshot is not.
  assert.equal(running.runtime.jobRecord(running.jobId), null);
  const snapshot = running.runtime.jobSnapshot(running.jobId);
  assert.ok(snapshot);
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.round, 1);
  assert.deepEqual(snapshot.history, { startEntryId: "e1", endEntryId: null });

  const produced = { role: "assistant", content: [{ type: "text", text: "already said" }] };
  const partial = { role: "assistant", content: [{ type: "text", text: "already said plus" }] };
  const live: NativeLiveSnapshot = {
    endEntryId: "e2",
    messages: [produced],
    partial,
  };
  const harness = rootFor(running.runtime, () => (running.runtime.jobSnapshot(running.jobId)?.status === "completed" ? null : live));
  const port = buildStreamPort(harness.root);
  const connection = makeConnection();
  const result = (await port.subscribe({ jobId: running.jobId }, connection as unknown as RpcConnection)) as Record<string, unknown>;

  assert.equal(result.live, true);
  assert.equal(result.rootSessionId, "session-root");
  assert.deepEqual(result.boundary, {
    status: "running",
    round: 1,
    history: { startEntryId: "e1", endEntryId: "e2" },
    messages: [produced],
    partial,
  });

  // Live deltas continue from the snapshot.
  const before = connection.events.length;
  harness.listener()?.({
    type: "message_update",
    message: { role: "assistant", usage: {} },
    assistantMessageEvent: { type: "text_delta", delta: " more", partial: { role: "assistant" } },
  });
  assert.equal(connection.events.length, before + 1);
  const pushed = connection.events.at(-1)!;
  assert.equal(pushed.payload.kind, "session");
  assert.equal(pushed.payload.jobId, running.jobId);
  assert.equal(pushed.payload.agentId, running.agentId);
  const event = pushed.payload.event as Record<string, unknown>;
  assert.equal((event.assistantMessageEvent as Record<string, unknown>).delta, " more");
  assert.equal("partial" in (event.assistantMessageEvent as Record<string, unknown>), false);

  // Finishing the real Job publishes its Runtime terminal boundary, not agent_end.
  running.finish("e3");
  await running.runtime.jobDone(running.jobId);
  await flush();
  const terminal = connection.events.at(-1)!;
  assert.equal(terminal.payload.kind, "job");
  assert.equal(terminal.payload.status, "completed");
  const settled = running.runtime.jobSnapshot(running.jobId);
  assert.equal(settled?.status, "completed");
  assert.deepEqual(settled?.history, { startEntryId: "e1", endEntryId: "e3" });
});

test("unsubscribe detaches the live observer and suppresses later events", async () => {
  const running = runningJob();
  const live: NativeLiveSnapshot = { endEntryId: "e2", messages: [], partial: null };
  const harness = rootFor(running.runtime, live);
  const port = buildStreamPort(harness.root);
  const connection = makeConnection();
  await port.subscribe({ jobId: running.jobId }, connection as unknown as RpcConnection);

  assert.deepEqual(port.unsubscribe({ subscription: "sub-1" }, connection as unknown as RpcConnection), { removed: true });
  assert.equal(harness.detachCount(), 1);
  const before = connection.events.length;
  harness.listener()?.({ type: "text_delta" });
  assert.equal(connection.events.length, before);
  assert.deepEqual(port.unsubscribe({ subscription: "sub-1" }, connection as unknown as RpcConnection), { removed: false });

  running.finish("e3");
  await running.runtime.jobDone(running.jobId);
});

test("an already-terminal Job reports its boundary without a future terminal event", async () => {
  const running = runningJob();
  running.finish("e3");
  await running.runtime.jobDone(running.jobId);

  const harness = rootFor(running.runtime, null);
  const port = buildStreamPort(harness.root);
  const connection = makeConnection();
  const result = (await port.subscribe({ jobId: running.jobId }, connection as unknown as RpcConnection)) as Record<string, unknown>;
  assert.equal(result.live, false);
  const boundary = result.boundary as Record<string, unknown>;
  assert.equal(boundary.status, "completed");
  assert.deepEqual(boundary.history, { startEntryId: "e1", endEntryId: "e3" });
  await flush();
  assert.equal(connection.events.length, 0);
});

test("subscribing to an unknown Job is a structured not-found", async () => {
  const runtime = createSubagentRuntime({ startJob: () => ({ done: new Promise(() => {}) }) });
  const harness = rootFor(runtime, null);
  const port = buildStreamPort(harness.root);
  await assert.rejects(
    port.subscribe({ jobId: "sub_missing" }, makeConnection() as unknown as RpcConnection),
    (error: unknown) => error instanceof RpcRequestError && error.code === "not_found",
  );
});
