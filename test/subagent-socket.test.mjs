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
  isWindowsPipe,
  isInSocketDirectory,
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
  await server.ready;
  const socketPath = getAgentSocketPath("sub_01", fixture.socketDir);
  if (!server.server.listening) await once(server.server, "listening");
  const before = isWindowsPipe(socketPath) ? null : await fsp.stat(socketPath);
  if (before) assert.ok(before.isSocket());
  assert.equal(server.server.address(), socketPath);
  await writeSocketOneWay(socketPath, '{"content":"hello"}\n{"content":"中文\\nnext"}\n');
  await delivered.promise;
  assert.deepEqual(received, [{ content: "hello" }, { content: "中文\nnext" }]);
  if (before) assert.equal((await fsp.stat(socketPath)).ino, before.ino);
  assert.equal(server.server.address(), socketPath);
  await server.close();
  if (before) await assert.rejects(fsp.stat(socketPath), { code: "ENOENT" });
  else await assert.rejects(writeSocketOneWay(socketPath, { content: "closed" }));
});

test("agent socket buffers an incomplete frame across actual data events", options, async (t) => {
  const fixture = await sockets(t);
  const received = [];
  const delivered = deferred();
  const server = fixture.agent({ id: "sub_02", onMessage(msg) {
    received.push(msg);
    if (received.length === 2) delivered.resolve();
  } });
  await server.ready;
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
  await server.ready;
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
  await server.ready;
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
  await server.ready;
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
  await Promise.all([...servers.values()].map((server) => server.ready));
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
  await server.ready;
  await assert.rejects(writeSocketOneWay(server.socketPath, 'invalid-json\n{"content":"valid after error"}\n'), /failed to parse NDJSON/);
  assert.deepEqual(await delivered.promise, { id: "sub_01", msg: { content: "valid after error" } });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /failed to parse NDJSON/);
});

test("broadcast invokes deliveries concurrently and reports a partial failure without skipping siblings", options, async (t) => {
  const fixture = await sockets(t);
  const pending = deferred();
  const started = deferred();
  const failure = deferred();
  const calls = [];
  const server = fixture.broadcast({
    parentId: "main", getDirectChildren: () => ["sub_01", "sub_02", "sub_03"],
    deliverMessage(childId) {
      calls.push(childId);
      if (childId === "sub_01") return pending.promise;
      if (childId === "sub_02") return Promise.reject(new Error("agent_stopping"));
      started.resolve();
      return Promise.resolve();
    },
    onError: failure.resolve,
  });
  await server.ready;
  const result = assert.rejects(writeSocketOneWay(getBroadcastSocketPath("main", fixture.socketDir), { content: "broadcast" }), /agent_stopping/);
  await started.promise;
  assert.deepEqual(calls, ["sub_01", "sub_02", "sub_03"]);
  pending.resolve();
  await result;
  assert.match((await failure.promise).message, /agent_stopping/);
});

test("write operations deliver to sockets while delegating normal files and mkdir unchanged", options, async (t) => {
  const fixture = await sockets(t);
  const delivered = deferred();
  const server = fixture.agent({ id: "sub_03", onMessage: delivered.resolve });
  await server.ready;
  const calls = [];
  const operations = createSocketAwareWriteOperations({
    mkdir: async (dir) => { calls.push(["mkdir", dir]); await fsp.mkdir(dir, { recursive: true }); },
    writeFile: async (file, content) => { calls.push(["write", file, content]); await fsp.writeFile(file, content); },
    resolveEndpoint: async (address) => address === server.socketPath ? { isManaged: true, targetId: "sub_03" } : null,
  });
  await operations.writeFile(server.socketPath, "backend");
  assert.deepEqual(await delivered.promise, { from: "main", content: "backend" });
  assert.deepEqual(calls, [], "a socket must never be passed to the filesystem writer");
  const dir = path.join(fixture.socketDir, "nested");
  const file = path.join(dir, "regular.txt");
  await operations.mkdir(dir);
  await operations.writeFile(file, "regular content");
  assert.deepEqual(calls, [["mkdir", dir], ["write", file, "regular content"]]);
  assert.equal(await fsp.readFile(file, "utf8"), "regular content");
});

test("reserved IPC directories reject files and skip mkdir, including directory aliases", options, async (t) => {
  const root = await fsp.mkdtemp(path.join(tmpdir(), "pi-reserved-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const ipcRoot = path.join(root, "ipc");
  await fsp.mkdir(ipcRoot);
  const alias = path.join(root, "alias");
  await fsp.symlink(ipcRoot, alias, "junction");
  const operations = createSocketAwareWriteOperations({ isReservedPath: (address) => isInSocketDirectory(address, ipcRoot) });
  for (const dir of [path.join(ipcRoot, "nested"), path.join(alias, "nested")]) {
    await operations.mkdir(dir);
    await assert.rejects(operations.writeFile(path.join(dir, "bad.txt"), "bad"), { code: "ipc_directory_reserved" });
    await assert.rejects(fsp.stat(dir), { code: "ENOENT" });
  }
  const ordinary = path.join(root, "ipc-other", "result.txt");
  await operations.mkdir(path.dirname(ordinary));
  await operations.writeFile(ordinary, "good");
  assert.equal(await fsp.readFile(ordinary, "utf8"), "good");
});

test("agent server teardown force-closes held-open half-frame clients and repeated close removes only its endpoint", options, async (t) => {
  const fixture = await sockets(t);
  let acceptedSocket = null;
  const server = fixture.agent({ id: "sub_04", onMessage() {} });
  server.server.on("connection", (socket) => { acceptedSocket = socket; socket.on("error", () => {}); });
  await server.ready;
  const client = await fixture.connect(server.socketPath);
  client.on("error", () => {});
  client.write('{"content":"half');
  while (acceptedSocket === null) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(server.clients.size, 1);

  const clientClosed = new Promise((resolve) => client.once("close", resolve));
  const first = server.close();
  const second = server.close();
  assert.equal(first, second);
  const result = await first;
  assert.equal(result.startupError, null);
  assert.equal(result.release?.removed, true);
  await clientClosed;
  await assert.rejects(fsp.stat(server.socketPath), { code: "ENOENT" });
});

test("agent server refuses an active endpoint without deleting the live listener", options, async (t) => {
  const fixture = await sockets(t);
  const first = fixture.agent({ id: "sub_05", onMessage() {} });
  await first.ready;
  const before = await fsp.lstat(first.socketPath);
  const second = fixture.agent({ id: "sub_05", onMessage() {} });
  await assert.rejects(second.ready, (error) => error?.code === "ipc_endpoint_in_use");
  await second.close();
  const after = await fsp.lstat(first.socketPath);
  assert.equal(after.ino, before.ino, "the live endpoint is not replaced or removed");
  await first.close();
  await assert.rejects(fsp.stat(first.socketPath), { code: "ENOENT" });
});

test("agent server preserves ordinary files and symlinks at the endpoint", options, async (t) => {
  const fixture = await sockets(t);
  const filePath = getAgentSocketPath("file_target", fixture.socketDir);
  await fsp.writeFile(filePath, "ordinary file");
  const fileServer = fixture.agent({ id: "file_target", onMessage() {} });
  await assert.rejects(fileServer.ready, (error) => error?.code === "ipc_endpoint_not_socket");
  await fileServer.close();
  assert.equal(await fsp.readFile(filePath, "utf8"), "ordinary file");

  const target = path.join(fixture.socketDir, "symlink-target.txt");
  await fsp.writeFile(target, "target content");
  const linkPath = getAgentSocketPath("link_target", fixture.socketDir);
  await fsp.symlink(target, linkPath);
  const linkServer = fixture.agent({ id: "link_target", onMessage() {} });
  await assert.rejects(linkServer.ready, (error) => error?.code === "ipc_endpoint_symlink");
  await linkServer.close();
  assert.ok((await fsp.lstat(linkPath)).isSymbolicLink());
  assert.equal(await fsp.readFile(target, "utf8"), "target content");
});

test("agent server validates an explicit managed root before creating session directories", options, async (t) => {
  const parent = await fsp.mkdtemp(path.join(tmpdir(), "pi-root-"));
  const target = path.join(parent, "attacker");
  const root = path.join(parent, "managed-root");
  const socketDir = path.join(root, "abcdef");
  await fsp.mkdir(target, { mode: 0o700 });
  await fsp.symlink(target, root);
  t.after(() => fsp.rm(parent, { recursive: true, force: true }));

  const server = createAgentSocketServer({ id: "Main", socketDir, root, onMessage() {} });
  await assert.rejects(server.ready, (error) => error?.code === "ipc_root_symlink");
  await server.close();
  await assert.rejects(fsp.stat(path.join(target, "abcdef")), { code: "ENOENT" });
  assert.ok((await fsp.lstat(root)).isSymbolicLink());
});

test("missing socket rejects delivery with ENOENT", options, async (t) => {
  const fixture = await sockets(t);
  await assert.rejects(writeSocketOneWay(getAgentSocketPath("missing", fixture.socketDir), { content: "test" }), { code: "ENOENT" });
});
