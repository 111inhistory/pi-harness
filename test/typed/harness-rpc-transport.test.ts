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
