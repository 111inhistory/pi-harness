import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createOwnedNdjsonServer,
  getAgentSocketPath,
  isInSocketDirectory,
  isWindowsPipe,
  writeSocket,
} from "../src/ipc/socket.ts";
import { deferred } from "../test-support/async.mjs";

async function sockets(t) {
  const root = await fsp.mkdtemp(path.join(tmpdir(), "pi-sock-"));
  const servers = [];
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    await Promise.all(servers.map((server) => server.close()));
    await fsp.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    server(address, options) {
      const server = createOwnedNdjsonServer({ address, root, ...options });
      servers.push(server);
      return server;
    },
    async connect(address) {
      const client = net.connect(address);
      clients.push(client);
      await once(client, "connect");
      return client;
    },
  };
}

const options = { timeout: 3000 };

test("owned endpoints deliver ordered NDJSON records without a response and retain their path", options, async (t) => {
  const fixture = await sockets(t);
  const received = [];
  const delivered = deferred();
  const address = getAgentSocketPath("sub_01", fixture.root);
  const server = fixture.server(address, { onMessage(msg) {
    received.push(msg);
    if (received.length === 2) delivered.resolve();
  } });
  await server.ready;
  if (!server.server.listening) await once(server.server, "listening");
  const before = isWindowsPipe(address) ? null : await fsp.stat(address);
  if (before) assert.ok(before.isSocket());
  assert.equal(server.server.address(), address);
  await writeSocket(address, '{"content":"hello"}\n{"content":"中文\\nnext"}\n');
  await delivered.promise;
  assert.deepEqual(received, [{ content: "hello" }, { content: "中文\nnext" }]);
  if (before) assert.equal((await fsp.stat(address)).ino, before.ino);
  assert.equal(server.server.address(), address);
  await server.close();
  if (before) await assert.rejects(fsp.stat(address), { code: "ENOENT" });
  else await assert.rejects(writeSocket(address, { content: "closed" }));
});

test("owned endpoint buffers an incomplete frame across actual data events", options, async (t) => {
  const fixture = await sockets(t);
  const received = [];
  const delivered = deferred();
  const address = getAgentSocketPath("sub_02", fixture.root);
  const server = fixture.server(address, { onMessage(msg) {
    received.push(msg);
    if (received.length === 2) delivered.resolve();
  } });
  await server.ready;
  const connection = once(server.server, "connection");
  const client = await fixture.connect(server.address);
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
  const address = getAgentSocketPath("sub_01", fixture.root);
  const server = fixture.server(address, { onMessage: delivered.resolve });
  await server.ready;
  const connection = once(server.server, "connection");
  const client = await fixture.connect(server.address);
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
  const address = getAgentSocketPath("sub_01", fixture.root);
  const server = fixture.server(address, { onError(err) { errors.push(err); }, onMessage(msg) {
    received.push(msg);
    if (received.length === 2) complete.resolve();
  } });
  await server.ready;
  const firstConnection = once(server.server, "connection");
  const first = await fixture.connect(server.address);
  const [accepted] = await firstConnection;
  const partialReceived = once(accepted, "data");
  first.write('{"first":');
  await partialReceived;
  const second = await fixture.connect(server.address);
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
  const address = getAgentSocketPath("sub_01", fixture.root);
  const server = fixture.server(address, { onMessage: (msg) => received.push(msg) });
  await server.ready;
  const connection = once(server.server, "connection");
  const client = await fixture.connect(server.address);
  const [accepted] = await connection;
  const ended = once(accepted, "end");
  client.end('{"missing":"newline"}');
  await ended;
  assert.deepEqual(received, []);
});

test("missing socket rejects delivery with ENOENT", options, async (t) => {
  const fixture = await sockets(t);
  await assert.rejects(writeSocket(getAgentSocketPath("missing", fixture.root), { content: "test" }), { code: "ENOENT" });
});
