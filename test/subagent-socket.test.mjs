import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createAgentSocketServer,
  createBroadcastSocketServer,
  createSocketAwareWriteOperations,
  getAgentSocketPath,
  getBroadcastSocketPath,
  writeSocketOneWay,
} from "../src/subagent-socket.mjs";
import { deferred } from "../test-support/async.mjs";

async function sockets(t) {
  const socketDir = await fsp.mkdtemp(path.join(tmpdir(), "pi-sock-"));
  const servers = [];
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    await Promise.all(servers.map((server) => server.close()));
    await fsp.rm(socketDir, { recursive: true, force: true });
  });
  return {
    socketDir,
    agent(options) {
      const server = createAgentSocketServer({ ...options, socketDir });
      servers.push(server);
      return server;
    },
    broadcast(options) {
      const server = createBroadcastSocketServer({ ...options, socketDir });
      servers.push(server);
      return server;
    },
    async connect(socketPath) {
      const client = net.connect(socketPath);
      clients.push(client);
      await once(client, "connect");
      return client;
    },
  };
}

const options = { timeout: 3000 };

test("agent socket delivers ordered NDJSON records without a response and retains its endpoint", options, async (t) => {
  const fixture = await sockets(t);
  const received = [];
  const delivered = deferred();
  const server = fixture.agent({ id: "sub_01", onMessage(msg) {
    received.push(msg);
    if (received.length === 2) delivered.resolve();
  } });
  const socketPath = getAgentSocketPath("sub_01", fixture.socketDir);
  const before = await fsp.stat(socketPath);
  assert.ok(before.isSocket());
  await writeSocketOneWay(socketPath, '{"content":"hello"}\n{"content":"中文\\nnext"}\n');
  await delivered.promise;
  assert.deepEqual(received, [{ content: "hello" }, { content: "中文\nnext" }]);
  assert.equal((await fsp.stat(socketPath)).ino, before.ino);
  await server.close();
  await assert.rejects(fsp.stat(socketPath), { code: "ENOENT" });
});

test("agent socket buffers an incomplete frame across actual data events", options, async (t) => {
  const fixture = await sockets(t);
  const received = [];
  const delivered = deferred();
  const server = fixture.agent({ id: "sub_02", onMessage(msg) {
    received.push(msg);
    if (received.length === 2) delivered.resolve();
  } });
  const connection = once(server.server, "connection");
  const client = await fixture.connect(server.socketPath);
  const [accepted] = await connection;
  const firstChunk = once(accepted, "data");
  client.write('{"content":"par');
  await firstChunk;
  assert.deepEqual(received, [], "a partial frame must not be parsed or delivered");
  client.end('tial"}\n{"sequence":2}\n');
  await delivered.promise;
  assert.deepEqual(received, [{ content: "partial" }, { sequence: 2 }]);
});

test("UTF-8 characters split across data events are decoded without corruption", options, async (t) => {
  const fixture = await sockets(t);
  const delivered = deferred();
  const server = fixture.agent({ id: "sub_01", onMessage: delivered.resolve });
  const connection = once(server.server, "connection");
  const client = await fixture.connect(server.socketPath);
  const [accepted] = await connection;
  const payload = Buffer.from('{"content":"你好🙂"}\n');
  const split = payload.indexOf(Buffer.from("你")) + 1;
  const partialReceived = once(accepted, "data");
  client.write(payload.subarray(0, split));
  await partialReceived;
  client.end(payload.subarray(split));
  assert.deepEqual(await delivered.promise, { content: "你好🙂" });
});

test("connection buffers are independent and invalid frames do not block subsequent valid messages", options, async (t) => {
  const fixture = await sockets(t);
  const received = [];
  const errors = [];
  const complete = deferred();
  const server = fixture.agent({ id: "sub_01", onError(err) { errors.push(err); }, onMessage(msg) {
    received.push(msg);
    if (received.length === 2) complete.resolve();
  } });
  const firstConnection = once(server.server, "connection");
  const first = await fixture.connect(server.socketPath);
  const [accepted] = await firstConnection;
  const partialReceived = once(accepted, "data");
  first.write('{"first":');
  await partialReceived;
  const second = await fixture.connect(server.socketPath);
  second.end('not-json\n\n{"second":2}\n');
  // The first connection is completed independently, even if the second batch is coalesced.
  first.end('1}\n');
  await complete.promise;
  assert.deepEqual(received.sort((a, b) => Object.keys(a)[0].localeCompare(Object.keys(b)[0])), [{ first: 1 }, { second: 2 }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Failed to parse NDJSON/);
});

test("unterminated NDJSON is not delivered", options, async (t) => {
  const fixture = await sockets(t);
  const received = [];
  const server = fixture.agent({ id: "sub_01", onMessage: (msg) => received.push(msg) });
  const connection = once(server.server, "connection");
  const client = await fixture.connect(server.socketPath);
  const [accepted] = await connection;
  const ended = once(accepted, "end");
  client.end('{"missing":"newline"}');
  await ended;
  assert.deepEqual(received, []);
});

test("hierarchical endpoints fan out only their direct-child snapshots and accept an empty snapshot", options, async (t) => {
  const fixture = await sockets(t);
  const delivered = [];
  const done = deferred();
  const children = new Map([["main", ["sub_01", "sub_02"]], ["sub_01", ["sub_01_01", "sub_01_02"]], ["sub_02", []]]);
  const servers = new Map();
  for (const parentId of children.keys()) {
    servers.set(parentId, fixture.broadcast({
      parentId, getDirectChildren: () => [...children.get(parentId)],
      async deliverMessage(childId, msg) {
        delivered.push({ childId, msg });
        if (delivered.length === 4) done.resolve();
      },
    }));
  }
  assert.equal(getBroadcastSocketPath("Main", fixture.socketDir), getBroadcastSocketPath("main", fixture.socketDir));
  await writeSocketOneWay(servers.get("main").socketPath, { source: "main" });
  await writeSocketOneWay(servers.get("sub_01").socketPath, { source: "sub_01" });
  await done.promise;
  assert.deepEqual(delivered.filter((d) => d.msg.source === "main").map((d) => d.childId), ["sub_01", "sub_02"]);
  assert.deepEqual(delivered.filter((d) => d.msg.source === "sub_01").map((d) => d.childId), ["sub_01_01", "sub_01_02"]);
  await writeSocketOneWay(servers.get("sub_02").socketPath, { source: "empty" });
  await servers.get("sub_02").close();
  assert.equal(delivered.length, 4);
});

test("broadcast rejects a malformed frame but still delivers the following valid frame", options, async (t) => {
  const fixture = await sockets(t);
  const errors = [];
  const delivered = deferred();
  const server = fixture.broadcast({
    parentId: "main", getDirectChildren: () => ["sub_01"],
    onError: (err) => errors.push(err),
    deliverMessage: async (id, msg) => delivered.resolve({ id, msg }),
  });
  await writeSocketOneWay(server.socketPath, 'invalid-json\n{"content":"valid after error"}\n');
  assert.deepEqual(await delivered.promise, { id: "sub_01", msg: { content: "valid after error" } });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /failed to parse NDJSON/);
});

test("broadcast invokes deliveries concurrently and reports a partial failure without skipping siblings", options, async (t) => {
  const fixture = await sockets(t);
  const pending = deferred();
  const failure = deferred();
  const calls = [];
  fixture.broadcast({
    parentId: "main", getDirectChildren: () => ["sub_01", "sub_02", "sub_03"],
    deliverMessage(childId) {
      calls.push(childId);
      if (childId === "sub_01") return pending.promise;
      if (childId === "sub_02") return Promise.reject(new Error("agent_stopping"));
      return Promise.resolve();
    },
    onError: failure.resolve,
  });
  await writeSocketOneWay(getBroadcastSocketPath("main", fixture.socketDir), { content: "broadcast" });
  assert.match((await failure.promise).message, /agent_stopping/);
  assert.deepEqual(calls, ["sub_01", "sub_02", "sub_03"]);
  pending.resolve();
});

test("write operations deliver to sockets while delegating normal files and mkdir unchanged", options, async (t) => {
  const fixture = await sockets(t);
  const delivered = deferred();
  const server = fixture.agent({ id: "sub_03", onMessage: delivered.resolve });
  const calls = [];
  const operations = createSocketAwareWriteOperations({
    mkdir: async (dir) => { calls.push(["mkdir", dir]); await fsp.mkdir(dir, { recursive: true }); },
    writeFile: async (file, content) => { calls.push(["write", file, content]); await fsp.writeFile(file, content); },
  });
  await operations.writeFile(server.socketPath, '{"content":"backend"}');
  assert.deepEqual(await delivered.promise, { content: "backend" });
  assert.deepEqual(calls, [], "a socket must never be passed to the filesystem writer");
  const dir = path.join(fixture.socketDir, "nested");
  const file = path.join(dir, "regular.txt");
  await operations.mkdir(dir);
  await operations.writeFile(file, "regular content");
  assert.deepEqual(calls, [["mkdir", dir], ["write", file, "regular content"]]);
  assert.equal(await fsp.readFile(file, "utf8"), "regular content");
});

test("missing socket rejects delivery with ENOENT", options, async (t) => {
  const fixture = await sockets(t);
  await assert.rejects(writeSocketOneWay(getAgentSocketPath("missing", fixture.socketDir), { content: "test" }), { code: "ENOENT" });
});
