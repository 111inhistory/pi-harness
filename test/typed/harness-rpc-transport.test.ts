import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { deferred } from "../../test-support/async.ts";

import { createHarnessRpcServer, RpcConnection, type RpcHandler } from "../../src/harness-rpc/transport.ts";
import { RpcRequestError } from "../../src/harness-rpc/error.ts";
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

test("the endpoint admits one connection and refuses contenders until it closes", async (t) => {
  const root = await fixture(t);
  const handled: string[] = [];
  const server = createHarnessRpcServer({
    address: getAgentSocketPath("harness-rpc", root), root,
    handler: async request => { handled.push(request.method); return { method: request.method }; },
  });
  t.after(() => server.close());
  await server.ready;
  const owner = await connect(server.address);
  owner.send({ id: 1, method: "owner" });
  await owner.waitFor(() => owner.frames.length === 1, "owner response");

  async function refused(): Promise<void> {
    const socket = net.connect(server.address);
    const chunks: Buffer[] = [];
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      assert.ok(error.code === "EPIPE" || error.code === "ECONNRESET", String(error));
    });
    socket.on("data", chunk => chunks.push(chunk));
    socket.once("connect", () => socket.write('{"id":2,"method":"contender"}\n'));
    await closed;
    assert.equal(Buffer.concat(chunks).length, 0, "an occupied endpoint closes the extra socket without dispatching requests");
  }
  await Promise.all([refused(), refused()]);
  assert.deepEqual(handled, ["owner"]);
  owner.send({ id: 3, method: "still-owner" });
  await owner.waitFor(() => owner.frames.length === 2, "owner remains usable");
  owner.close();
  await owner.closed;
  await nextTurn();
  const successor = await connect(server.address);
  successor.send({ id: 4, method: "successor" });
  await successor.waitFor(() => successor.frames.length === 1, "replacement after close");
  assert.deepEqual(handled, ["owner", "still-owner", "successor"]);
});

test("FIN retains the connection slot until the pending response has flushed and the socket closes", async (t) => {
  const root = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const server = createHarnessRpcServer({
    address: getAgentSocketPath("harness-rpc", root), root,
    handler: async () => { entered.resolve(); await release.promise; return { done: true }; },
  });
  t.after(async () => { release.resolve(); await server.close(); });
  await server.ready;
  const owner = net.connect(server.address);
  const responses: string[] = [];
  const closed = new Promise<void>(resolve => owner.once("close", () => resolve()));
  owner.setEncoding("utf8");
  owner.on("data", (chunk: string) => responses.push(chunk));
  await once(owner, "connect");
  owner.end('{"id":1,"method":"pending"}\n');
  await entered.promise;
  const contender = net.connect(server.address);
  const rejected = new Promise<void>(resolve => contender.once("close", () => resolve()));
  contender.on("error", (error: NodeJS.ErrnoException) => {
    assert.ok(error.code === "EPIPE" || error.code === "ECONNRESET", String(error));
  });
  await rejected;
  assert.equal(owner.destroyed, false, "the first connection still owns its pending request");
  release.resolve();
  await closed;
  assert.deepEqual(JSON.parse(responses.join("")), { id: 1, ok: true, result: { done: true } });
  await nextTurn();
  const successor = await connect(server.address);
  successor.send({ id: 2, method: "replacement" });
  await successor.waitFor(() => successor.frames.length === 1, "replacement after FIN completes");
});

test("a subscription receives pushed events and can be removed", async (t) => {
  const root = await fixture(t);
  let unsubscribed = false;
  const accepted: { connection?: RpcConnection } = {};
  const handler: RpcHandler = async (request, connection) => {
    accepted.connection = connection;
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

  const connection = accepted.connection;
  assert.ok(connection);
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

test("root release detaches root observers but retains host observers and the connection", async (t) => {
  const root = await fixture(t);
  let connection: RpcConnection | undefined;
  let rootReleased = 0;
  let hostReleased = 0;
  const handler: RpcHandler = async (request, accepted) => {
    connection = accepted;
    if (request.method === "subscribe") {
      const params = request.params as { scope?: unknown };
      const scope = params.scope === "host" ? "host" : "root";
      const subscription = accepted.addSubscription(() => {
        if (scope === "host") hostReleased += 1;
        else rootReleased += 1;
      }, scope);
      return { subscription };
    }
    if (request.method === "ping") return { pong: true };
    throw new RpcRequestError("method_not_found", "no");
  };
  const server = createHarnessRpcServer({ address: getAgentSocketPath("harness-rpc", root), root, handler });
  t.after(() => server.close());
  await server.ready;

  const client = await connect(server.address);
  client.send({ id: 1, method: "subscribe", params: { scope: "root" } });
  client.send({ id: 2, method: "subscribe", params: { scope: "host" } });
  await client.waitFor(() => client.frames.length === 2, "root and host subscriptions");
  const rootSubscription = asRecord(asRecord(client.frames[0]).result).subscription as string;
  const hostSubscription = asRecord(asRecord(client.frames[1]).result).subscription as string;
  assert.ok(connection);

  connection.pushEvent(rootSubscription, { root: 1 });
  connection.pushEvent(hostSubscription, { host: 1 });
  await client.waitFor(() => client.frames.length === 4, "both observers receive events");

  server.releaseRootSubscriptions();
  assert.equal(rootReleased, 1);
  assert.equal(hostReleased, 0, "host observers survive a root transition");
  assert.equal(connection.closed, false, "the connection survives a root transition");

  connection.pushEvent(rootSubscription, { late: true });
  await nextTurn();
  assert.equal(client.frames.length, 4, "a released root observer cannot push through its old id");
  connection.pushEvent(hostSubscription, { host: 2 });
  await client.waitFor(() => client.frames.length === 5, "host observer still pushes");

  client.send({ id: 3, method: "ping" });
  await client.waitFor(() => client.frames.length === 6, "connection still serves requests");
  assert.deepEqual(asRecord(client.frames[5]), { id: 3, ok: true, result: { pong: true } });

  // Normal unsubscribe removes only its observer. A later close still releases
  // every remaining scope; a root subscription may be created after the root release.
  client.send({ id: 4, method: "subscribe", params: { scope: "root" } });
  await client.waitFor(() => client.frames.length === 7, "new root observer");
  const nextRoot = asRecord(asRecord(client.frames[6]).result).subscription as string;
  assert.equal(connection.removeSubscription(hostSubscription), true);
  assert.equal(hostReleased, 1);
  assert.equal(connection.closed, false);
  connection.pushEvent(hostSubscription, { lateHost: true });
  await nextTurn();
  assert.equal(client.frames.length, 7, "normal unsubscribe also suppresses old host ids");

  client.close();
  await client.closed;
  await client.waitFor(() => rootReleased === 2, "connection close releases remaining root observers");
  assert.equal(nextRoot.length > 0, true);
});

test("a control reply completes while an earlier ordered operation is pending", async (t) => {
  const root = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const handler: RpcHandler = async (request) => {
    if (request.method === "long") {
      entered.resolve();
      await release.promise;
      return { long: true };
    }
    if (request.method === "control") return { control: true };
    throw new RpcRequestError("method_not_found", "no");
  };
  const server = createHarnessRpcServer({
    address: getAgentSocketPath("harness-rpc", root), root, handler,
    isControlRequest: request => request.method === "control",
  });
  t.after(async () => { release.resolve(); await server.close(); });
  await server.ready;

  const client = await connect(server.address);
  client.send({ id: 1, method: "long" });
  await entered.promise;
  client.send({ id: 2, method: "control" });
  await client.waitFor(() => client.frames.length === 1, "control response while long operation is pending");
  assert.deepEqual(asRecord(client.frames[0]), { id: 2, ok: true, result: { control: true } });
  release.resolve();
  await client.waitFor(() => client.frames.length === 2, "ordered operation completion");
  assert.deepEqual(asRecord(client.frames[1]), { id: 1, ok: true, result: { long: true } });
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
  const subscription = connection.addSubscription(() => {});
  connection.pushEvent(subscription, { big: "payload" });
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
    get destroyed() {
      return destroyed;
    },
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
  const subscription = connection.addSubscription(() => {
    unsubscribed = true;
  });

  listeners.get("data")?.(Buffer.from(`${JSON.stringify({ id: 1, method: "work" })}\n`) as never);
  listeners.get("end")?.();
  connection.pushEvent(subscription, { late: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(unsubscribed, true, "FIN releases the subscription");
  assert.equal(ended, true, "FIN ends the writable side after the request chain");
  assert.equal(destroyed, false, "FIN does not discard queued response bytes");
  assert.equal(writes.some((line) => line.includes('"late"')), false, "no new event is queued after input ends");

  // Server retirement calls close() on every tracked connection. A FIN'd
  // connection must still release the live socket instead of making close() a no-op.
  connection.close();
  assert.equal(destroyed, true, "explicit close destroys a FIN'd but still-live socket");
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
  client.close();
  await client.closed;
  await client.waitFor(() => unsubscribed, "subscription release after disconnect");
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
