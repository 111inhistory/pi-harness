import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
  waitFor(predicate: () => boolean, label: string): Promise<void>;
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
  return {
    frames,
    send(frame: unknown) {
      socket.write(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`);
    },
    async waitFor(predicate: () => boolean, label: string): Promise<void> {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}; frames=${JSON.stringify(frames)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
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

  // Server retirement calls close() on every tracked connection. A FIN'd
  // connection must still release the live socket instead of making close() a no-op.
  connection.close();
  assert.equal(destroyed, true, "explicit close destroys a FIN'd but still-live socket");
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
