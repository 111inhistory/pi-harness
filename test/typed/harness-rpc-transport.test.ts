import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHarnessRpcServer, RpcConnection, type RpcHandler } from "../../src/harness-rpc/transport.ts";
import { RpcRequestError } from "../../src/harness-rpc/error.ts";
import { RPC_METHODS } from "../../src/harness-rpc/protocol.ts";
import { createRouter } from "../../src/harness-rpc/router.ts";
import { buildStreamPort } from "../../src/harness-rpc/ports/stream.ts";
import type { ToolPort } from "../../src/harness-rpc/ports/tool-info.ts";
import type { SubagentPort } from "../../src/harness-rpc/ports/subagent.ts";
import type { HistoryPort } from "../../src/harness-rpc/ports/history.ts";
import { createSubagentRuntime, type JobRequest } from "../../src/subagent/runtime.ts";
import type { RootService } from "../../src/subagent/root-service.ts";
import { getAgentSocketPath } from "../../src/ipc/socket.ts";

async function fixture(t: test.TestContext): Promise<string> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-harness-rpc-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

interface Client {
  readonly frames: unknown[];
  send(frame: unknown): void;
  close(): void;
  waitFor(predicate: () => boolean, label: string): Promise<void>;
  closed: Promise<void>;
}

async function connect(address: string): Promise<Client> {
  const socket = net.connect(address);
  await once(socket, "connect");
  const frames: unknown[] = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() !== "") frames.push(JSON.parse(line));
    }
  });
  const closed = once(socket, "close").then(() => undefined);
  return {
    frames,
    send(frame: unknown) {
      socket.write(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`);
    },
    close() {
      socket.destroy();
    },
    async waitFor(predicate: () => boolean, label: string): Promise<void> {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}; frames=${JSON.stringify(frames)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    closed,
  };
}

function asRecord(frame: unknown): Record<string, unknown> {
  assert.ok(typeof frame === "object" && frame !== null, "frame is an object");
  return frame as Record<string, unknown>;
}

function responseFor(client: Client, id: string): Record<string, unknown> | null {
  for (const frame of client.frames) {
    if (typeof frame !== "object" || frame === null) continue;
    const record = frame as Record<string, unknown>;
    if (record["id"] === id) return record;
  }
  return null;
}

function eventOf(frame: unknown): Record<string, unknown> | null {
  if (typeof frame !== "object" || frame === null) return null;
  const event = (frame as Record<string, unknown>)["event"];
  return typeof event === "object" && event !== null ? event as Record<string, unknown> : null;
}

function jobEventCount(client: Client): number {
  return client.frames.filter((frame) => {
    const event = eventOf(frame);
    const payload = event?.["payload"];
    return typeof payload === "object" && payload !== null && (payload as Record<string, unknown>)["kind"] === "job";
  }).length;
}

test("request/response carries structured success and structured errors in order", async (t) => {
  const root = await fixture(t);
  const handler: RpcHandler = async (request) => {
    switch (request.method) {
      case "echo":
        return { got: request.params };
      case "missing":
        throw new RpcRequestError("not_found", "nothing here");
      case "crash":
        throw new Error("kaboom");
      default:
        throw new RpcRequestError("method_not_found", "no such method");
    }
  };
  const server = createHarnessRpcServer({ address: getAgentSocketPath("harness-rpc", root), root, handler });
  t.after(() => server.close());
  await server.ready;

  const client = await connect(server.address);
  client.send({ id: 1, method: "echo", params: { a: 1 } });
  client.send({ id: 2, method: "missing" });
  client.send({ id: 3, method: "crash" });
  client.send({ id: 4, method: "nope" });
  client.send("this is not json");
  await client.waitFor(() => client.frames.length === 5, "five responses");

  const [ok, notFound, crashed, unknown, malformed] = client.frames.map(asRecord);
  assert.deepEqual(ok, { id: 1, ok: true, result: { got: { a: 1 } } });
  assert.equal(notFound?.ok, false);
  assert.deepEqual(asRecord(notFound?.error), { code: "not_found", message: "nothing here" });
  assert.equal(crashed?.ok, false);
  assert.equal(asRecord(crashed?.error).code, "internal");
  assert.equal(unknown?.ok, false);
  assert.equal(asRecord(unknown?.error).code, "method_not_found");
  // A malformed frame has no correlation id, so the refusal carries null.
  assert.equal(malformed?.id, null);
  assert.equal(asRecord(malformed?.error).code, "invalid_request");
});

test("a subscription receives pushed events and can be removed", async (t) => {
  const root = await fixture(t);
  let unsubscribed = false;
  const handler: RpcHandler = async (request, connection) => {
    if (request.method === "subscribe") {
      const subscription = connection.addSubscription(() => {
        unsubscribed = true;
      });
      return { subscription };
    }
    if (request.method === "unsubscribe") {
      const params = request.params as { id?: unknown };
      return { removed: typeof params.id === "string" ? connection.removeSubscription(params.id) : false };
    }
    throw new RpcRequestError("method_not_found", "no");
  };
  const server = createHarnessRpcServer({ address: getAgentSocketPath("harness-rpc", root), root, handler });
  t.after(() => server.close());
  await server.ready;

  const client = await connect(server.address);
  client.send({ id: 1, method: "subscribe" });
  await client.waitFor(() => client.frames.length === 1, "subscribe response");
  const subscription = asRecord(asRecord(client.frames[0]).result).subscription;
  assert.equal(typeof subscription, "string");

  const connection = [...server.connections][0];
  assert.ok(connection, "connection is tracked");
  connection.pushEvent(subscription as string, { hello: "world" });
  await client.waitFor(() => client.frames.length === 2, "pushed event");
  const event = asRecord(asRecord(client.frames[1]).event);
  assert.equal(event.subscription, subscription);
  assert.equal(event.seq, 1);
  assert.deepEqual(event.payload, { hello: "world" });

  client.send({ id: 2, method: "unsubscribe", params: { id: subscription } });
  await client.waitFor(() => client.frames.length === 3, "unsubscribe response");
  assert.deepEqual(asRecord(client.frames[2]), { id: 2, ok: true, result: { removed: true } });
  assert.equal(unsubscribed, true);
});

test("a connection that exceeds its event backlog is disconnected instead of blocking", () => {
  const destroyCalls: boolean[] = [];
  const errors: Error[] = [];
  let isDestroyed = false;
  const fakeSocket = {
    writableLength: 1_000_000,
    get destroyed() {
      return isDestroyed;
    },
    allowHalfOpen: false,
    on() {
      return fakeSocket;
    },
    write() {
      return true;
    },
    destroy() {
      isDestroyed = true;
      destroyCalls.push(true);
    },
  } as unknown as net.Socket;
  const connection = new RpcConnection(fakeSocket, async () => ({}), 1024, (error) => errors.push(error));
  connection.pushEvent("sub-1", { big: "payload" });
  assert.equal(connection.closed, true);
  assert.equal(destroyCalls.length, 1);
  assert.equal(errors.length, 1);
});

test("FIN stops new events, releases subscriptions and ends instead of destroying", async () => {
  const listeners = new Map<string, (...args: never[]) => void>();
  const writes: string[] = [];
  let ended = false;
  let destroyed = false;
  const fakeSocket = {
    writableLength: 0,
    destroyed: false,
    allowHalfOpen: false,
    on(event: string, listener: (...args: never[]) => void) {
      listeners.set(event, listener);
      return fakeSocket;
    },
    write(chunk: string) {
      writes.push(String(chunk));
      return true;
    },
    end() {
      ended = true;
    },
    destroy() {
      destroyed = true;
    },
  } as unknown as net.Socket;
  const connection = new RpcConnection(fakeSocket, async () => ({ ok: true }), 4096, () => {});
  let unsubscribed = false;
  connection.addSubscription(() => {
    unsubscribed = true;
  });

  listeners.get("data")?.(Buffer.from(`${JSON.stringify({ id: 1, method: "work" })}\n`) as never);
  listeners.get("end")?.();
  connection.pushEvent("sub-1", { late: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(unsubscribed, true, "FIN releases the subscription");
  assert.equal(ended, true, "FIN ends the writable side after the request chain");
  assert.equal(destroyed, false, "FIN does not discard queued response bytes");
  assert.equal(writes.some((line) => line.includes('"late"')), false, "no new event is queued after input ends");
});

test("closing a connection releases its subscriptions", async (t) => {
  const root = await fixture(t);
  let unsubscribed = false;
  const handler: RpcHandler = async (_request, connection) => {
    connection.addSubscription(() => {
      unsubscribed = true;
    });
    return { ok: true };
  };
  const server = createHarnessRpcServer({ address: getAgentSocketPath("harness-rpc", root), root, handler });
  t.after(() => server.close());
  await server.ready;

  const client = await connect(server.address);
  client.send({ id: 1, method: "subscribe" });
  await client.waitFor(() => client.frames.length === 1, "subscribe response");
  const count = (): number => server.connections.size;
  assert.equal(count(), 1);

  const connection = [...server.connections][0];
  assert.ok(connection, "connection is tracked");
  connection.close();
  await client.closed;
  for (let i = 0; i < 200 && count() !== 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(unsubscribed, true);
  assert.equal(count(), 0);
});

test("a half-closed client receives a backpressured response before teardown", async (t) => {
  const root = await fixture(t);
  const payload = "x".repeat(4 * 1024 * 1024);
  let handlerDone!: () => void;
  const handlerFinished = new Promise<void>((resolve) => {
    handlerDone = resolve;
  });
  const handler: RpcHandler = async (request) => {
    if (request.method !== "big") throw new RpcRequestError("method_not_found", "no such method");
    handlerDone();
    return { payload };
  };
  const server = createHarnessRpcServer({ address: getAgentSocketPath("harness-rpc", root), root, handler });
  t.after(() => server.close());
  await server.ready;

  const socket = net.connect(server.address);
  await once(socket, "connect");
  socket.setEncoding("utf8");
  // Delay reading so the response is queued beyond the socket high-water mark.
  socket.pause();
  const frames: unknown[] = [];
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() !== "") frames.push(JSON.parse(line));
    }
  });
  socket.write(`${JSON.stringify({ id: "big", method: "big" })}\n`);
  // Half-close the request side while keeping the read side open.
  socket.end();
  await handlerFinished;
  // Let the transport queue the response and finish the input chain, then read.
  await new Promise((resolve) => setImmediate(resolve));
  const closed = once(socket, "close");
  socket.resume();
  await closed;

  assert.equal(frames.length, 1, "the response is one complete NDJSON frame");
  const response = asRecord(frames[0]);
  assert.equal(response["id"], "big");
  assert.equal(response["ok"], true);
  assert.equal((response["result"] as Record<string, unknown>)["payload"], payload);
});

test("a real socket stream releases unsubscribe/disconnect observations and delivers one terminal event", async (t) => {
  const rootDir = await fixture(t);
  let finish!: (outcome: unknown) => void;
  const done = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const runtime = createSubagentRuntime({
    startJob: (request: JobRequest) => {
      request.recordStart("e1");
      return { done, cancel() {} };
    },
  });
  const item = runtime.create({ tasks: [{ task: "work" }] }).items[0];
  assert.ok(item);
  const jobId = item.id;

  let detaches = 0;
  const root = {
    sessionId: "session-root",
    runtime,
    // The native event source and live projection are root-level fixtures here;
    // the socket, router, stream port, Runtime observation and teardown are real.
    subscribeJobEvents: (_jobId: string, listener: (event: unknown) => void) => {
      listener({ type: "message_start", message: { role: "assistant", content: [] } });
      return () => {
        detaches += 1;
      };
    },
    liveSnapshot: () => ({ endEntryId: "e2", messages: [], partial: null }),
  } as unknown as RootService;

  const unused = (): never => {
    throw new Error("unused port");
  };
  const router = createRouter({
    sessionId: "session-root",
    tool: {
      catalog: unused, detail: unused, enable: unused, permissionQuery: unused,
      permissionEnable: unused, permissionDisable: unused, permissionReset: unused,
    } as unknown as ToolPort,
    subagent: {
      tree: unused, jobs: unused, job: unused, result: unused,
      create: unused, stop: unused, send: unused,
    } as unknown as SubagentPort,
    history: { read: unused } as unknown as HistoryPort,
    stream: buildStreamPort(root),
  });
  const server = createHarnessRpcServer({ address: getAgentSocketPath("harness-rpc", rootDir), root: rootDir, handler: router });
  t.after(() => server.close());
  await server.ready;

  const removed = await connect(server.address);
  const kept = await connect(server.address);
  const disconnected = await connect(server.address);

  async function subscribe(client: Client, requestId: string): Promise<string> {
    client.send({ id: requestId, method: RPC_METHODS.streamSubscribe, params: { jobId } });
    await client.waitFor(() => responseFor(client, requestId) !== null, `${requestId} response`);
    const response = responseFor(client, requestId);
    assert.ok(response);
    const result = response["result"] as Record<string, unknown>;
    const subscription = result["subscription"];
    assert.equal(typeof subscription, "string");
    const responseIndex = client.frames.findIndex((frame) => frame === response);
    const eventIndex = client.frames.findIndex((frame) => eventOf(frame)?.["subscription"] === subscription);
    assert.ok(eventIndex >= 0 && eventIndex < responseIndex, "a pre-response event carries the response subscription id");
    return subscription as string;
  }

  const removedSubscription = await subscribe(removed, "sub-a");
  const keptSubscription = await subscribe(kept, "sub-b");
  const disconnectedSubscription = await subscribe(disconnected, "sub-c");
  assert.notEqual(removedSubscription, keptSubscription);
  assert.notEqual(keptSubscription, disconnectedSubscription);

  removed.send({ id: "unsub-a", method: RPC_METHODS.streamUnsubscribe, params: { subscription: removedSubscription } });
  await removed.waitFor(() => responseFor(removed, "unsub-a") !== null, "unsubscribe response");
  assert.deepEqual(asRecord(responseFor(removed, "unsub-a")?.["result"]), { removed: true });
  assert.equal(detaches, 1, "unsubscribe tears down the native observer");

  disconnected.close();
  await disconnected.closed;
  await kept.waitFor(() => detaches === 2, "disconnect teardown");

  finish({ status: "completed", result: "done", history: { startEntryId: "e1", endEntryId: "e3" } });
  await runtime.jobDone(jobId);
  await kept.waitFor(() => jobEventCount(kept) === 1, "remaining terminal event");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(jobEventCount(kept), 1, "the remaining subscriber receives exactly one terminal event");
  assert.equal(jobEventCount(removed), 0, "an unsubscribed subscriber receives no terminal event");
  assert.equal(jobEventCount(disconnected), 0, "a disconnected subscriber receives no terminal event");
});
