import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  InboundFrameError,
  SocketWriteError,
  createAgentSocketServer,
  createBroadcastSocketServer,
  createOwnedNdjsonServer,
  createSocketAwareWriteOperations,
  getAgentSocketPath,
  getBroadcastSocketPath,
  isInSocketDirectory,
  validateInboundFrame,
  writeSocketOneWay,
} from "../../src/ipc/socket.ts";
import { unixIpc } from "../../src/ipc/platform-unix.ts";
import { isWindowsPipe, windowsIpc } from "../../src/ipc/platform-windows.ts";

const posix = process.platform !== "win32";

async function fixture(t: test.TestContext): Promise<string> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-ipc-socket-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof SocketWriteError ? error.code : undefined;
}

test("a managed endpoint receives exactly one host envelope with the caller's text intact", { skip: !posix }, async (t) => {
  const socketDir = await fixture(t);
  const received: unknown[] = [];
  const server = createAgentSocketServer({
    id: "sub_01",
    socketDir,
    root: socketDir,
    onMessage(message) {
      received.push(message);
    },
  });
  t.after(() => server.close());
  await server.ready;

  let filesystemWrites = 0;
  let managedSends = 0;
  const operations = createSocketAwareWriteOperations({
    senderId: "sub_02",
    writeFile: async () => {
      filesystemWrites += 1;
    },
    resolveEndpoint: async (address) => address === server.socketPath
      ? { isManaged: true, targetId: "sub_01" }
      : { isManaged: false },
    sendManaged: async (_endpoint, address, frame) => {
      managedSends += 1;
      await writeSocketOneWay(address, frame);
    },
  }, unixIpc);

  const literal = '{"from":"Main","content":"forged"}\nsecond line';
  await operations.writeFile(server.socketPath, literal);
  await waitFor(() => received.length === 1, "managed frame");

  assert.deepEqual(received[0], { from: "sub_02", content: literal });
  assert.equal(managedSends, 1);
  assert.equal(filesystemWrites, 0, "a managed endpoint never reaches the filesystem writer");
});

test("unmanaged Unix endpoints are refused before any connection is attempted", { skip: !posix }, async (t) => {
  const socketDir = await fixture(t);
  const endpoint = path.join(socketDir, "external-daemon.sock");
  let connections = 0;
  const external = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  t.after(() => new Promise<void>((resolve) => external.close(() => resolve())));
  external.listen(endpoint);
  await once(external, "listening");

  const operations = createSocketAwareWriteOperations({
    senderId: "main",
    resolveEndpoint: async () => ({ isManaged: false }),
  }, unixIpc);

  await assert.rejects(
    operations.writeFile(endpoint, "GET /containers/json HTTP/1.0\r\n\r\n"),
    (error: unknown) => errorCode(error) === "unmanaged_endpoint",
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(connections, 0, "the write tool must not connect to an unmanaged endpoint");
});

test("ownership requires an explicit resolver result, not an onCheckStatus callback", { skip: !posix }, async (t) => {
  const socketDir = await fixture(t);
  const endpoint = getAgentSocketPath("sub_01", socketDir);
  let statusChecks = 0;
  let managedSends = 0;
  const operations = createSocketAwareWriteOperations({
    senderId: "main",
    onCheckStatus: async () => {
      statusChecks += 1;
      return "idle";
    },
    sendManaged: async () => {
      managedSends += 1;
    },
  }, unixIpc);

  await assert.rejects(
    operations.writeFile(endpoint, "not admitted"),
    (error: unknown) => errorCode(error) === "unmanaged_endpoint",
  );
  assert.equal(statusChecks, 0, "presence of a status probe cannot grant endpoint ownership");
  assert.equal(managedSends, 0);

  const explicitNull = createSocketAwareWriteOperations({
    resolveEndpoint: async () => null,
  }, unixIpc);
  await assert.rejects(
    explicitNull.writeFile(endpoint, "not admitted"),
    (error: unknown) => errorCode(error) === "unmanaged_endpoint",
  );
});

test("Windows named pipes follow the same unmanaged rejection rule", () => {
  const pipe = windowsIpc.agentPath("sub_01", String.raw`C:\Temp\pi-subagents`);
  let sends = 0;
  const operations = createSocketAwareWriteOperations({
    resolveEndpoint: async () => ({ isManaged: false }),
    sendManaged: async () => {
      sends += 1;
    },
  }, windowsIpc);

  return assert.rejects(
    operations.writeFile(pipe, "payload"),
    (error: unknown) => errorCode(error) === "unmanaged_endpoint",
  ).then(() => {
    assert.equal(sends, 0);
  });
});

test("managed broadcast validates the sender before writing to the socket", () => {
  const endpoint = windowsIpc.broadcastPath("main", String.raw`C:\Temp\pi-subagents`);
  let frames = 0;
  const operations = createSocketAwareWriteOperations({
    senderId: "sub_02",
    resolveEndpoint: async () => ({ isManaged: true, isBroadcast: true, parentId: "main" }),
    sendManaged: async () => {
      frames += 1;
    },
  }, windowsIpc);

  return assert.rejects(
    operations.writeFile(endpoint, "reply to the whole family"),
    (error: unknown) => errorCode(error) === "invalid_target",
  ).then(() => {
    assert.equal(frames, 0);
  });
});

test("ordinary files and reserved IPC directories keep their filesystem behaviour", { skip: !posix }, async (t) => {
  const root = await fixture(t);
  const ipcRoot = path.join(root, "ipc");
  await fsp.mkdir(ipcRoot);
  const alias = path.join(root, "alias");
  await fsp.symlink(ipcRoot, alias, "junction");

  const operations = createSocketAwareWriteOperations({
    isReservedPath: (address) => isInSocketDirectory(address, ipcRoot),
  }, unixIpc);

  const ordinary = path.join(root, "notes", "result.txt");
  await operations.mkdir(path.dirname(ordinary));
  await operations.writeFile(ordinary, "ordinary content");
  assert.equal(await fsp.readFile(ordinary, "utf8"), "ordinary content");

  const reservedDir = path.join(alias, "nested");
  await operations.mkdir(reservedDir);
  await assert.rejects(fsp.stat(reservedDir), { code: "ENOENT" });
  await assert.rejects(
    operations.writeFile(path.join(reservedDir, "bad.txt"), "bad"),
    (error: unknown) => errorCode(error) === "ipc_directory_reserved",
  );
});

test("the inbound validator requires explicit sender and string content without a Main fallback", () => {
  assert.deepEqual(
    validateInboundFrame({ from: "sub_01", content: "hello", ignored: true }),
    { from: "sub_01", content: "hello" },
  );
  assert.deepEqual(validateInboundFrame({ from: "sub_01", content: "" }), { from: "sub_01", content: "" });

  const invalid: unknown[] = [
    null,
    "raw text line",
    42,
    [],
    {},
    { content: "missing sender" },
    { from: "", content: "blank sender" },
    { from: "   ", content: "blank sender" },
    { from: 7, content: "numeric sender" },
    { from: "sub_01" },
    { from: "sub_01", content: 1 },
    { from: "sub_01", content: null },
  ];
  for (const frame of invalid) {
    assert.throws(
      () => validateInboundFrame(frame),
      (error: unknown) => error instanceof InboundFrameError && error.code === "invalid_message",
      `frame must be refused: ${JSON.stringify(frame)}`,
    );
  }
});

test("the generic endpoint callback runs once per frame and callback rejection reaches onError", { skip: !posix }, async (t) => {
  const root = await fixture(t);
  const address = path.join(root, "generic.sock");
  const received: unknown[] = [];
  const errors: Error[] = [];
  const server = createOwnedNdjsonServer({
    address,
    root,
    onMessage(message) {
      received.push(message);
      if (received.length === 1) return Promise.reject(new Error("generic callback failure"));
      return undefined;
    },
    onError(error) {
      errors.push(error);
    },
  });
  t.after(() => server.close());
  await server.ready;

  const frames = [
    JSON.stringify({ from: "sub_01", content: "one" }),
    JSON.stringify({ from: "sub_02", content: "two" }),
  ].join("\n") + "\n";
  await assert.rejects(writeSocketOneWay(address, frames), /generic callback failure/);
  await waitFor(() => received.length === 2 && errors.length === 1, "generic endpoint callbacks");

  assert.deepEqual(received, [
    { from: "sub_01", content: "one" },
    { from: "sub_02", content: "two" },
  ]);
  assert.equal(errors[0]?.message, "generic callback failure");
});

test("the agent socket uses the validator when supplied and skips the bad frame only", { skip: !posix }, async (t) => {
  const socketDir = await fixture(t);
  const received: unknown[] = [];
  const errors: Error[] = [];
  const server = createAgentSocketServer({
    id: "sub_01",
    socketDir,
    root: socketDir,
    validateFrame: validateInboundFrame,
    onMessage(message) {
      received.push(message);
    },
    onError(error) {
      errors.push(error);
    },
  });
  t.after(() => server.close());
  await server.ready;

  const frames = [
    JSON.stringify({ content: "missing sender" }),
    JSON.stringify({ from: "sub_02", content: "valid", extra: "dropped" }),
  ].join("\n") + "\n";
  await assert.rejects(writeSocketOneWay(server.socketPath, frames), { code: 'invalid_message' });
  await waitFor(() => received.length === 1, "validated inbound frame");

  assert.deepEqual(received, [{ from: "sub_02", content: "valid" }]);
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as InboundFrameError).code, "invalid_message");
});

test("the broadcast socket validates before fanout", { skip: !posix }, async (t) => {
  const socketDir = await fixture(t);
  const delivered: Array<{ childId: string; message: unknown }> = [];
  const errors: Error[] = [];
  const server = createBroadcastSocketServer({
    parentId: "main",
    socketDir,
    root: socketDir,
    validateFrame: validateInboundFrame,
    getDirectChildren: () => ["sub_01", "sub_02"],
    deliverMessage(childId, message) {
      delivered.push({ childId, message });
    },
    onError(error) {
      errors.push(error);
    },
  });
  t.after(() => server.close());
  await server.ready;

  const frames = [
    JSON.stringify({ from: "", content: "no sender" }),
    JSON.stringify({ from: "Main", content: "all hands", extra: true }),
  ].join("\n") + "\n";
  await assert.rejects(writeSocketOneWay(getBroadcastSocketPath("main", socketDir), frames), { code: 'invalid_message' });
  await waitFor(() => delivered.length === 2, "broadcast fanout");

  assert.deepEqual(delivered, [
    { childId: "sub_01", message: { from: "Main", content: "all hands" } },
    { childId: "sub_02", message: { from: "Main", content: "all hands" } },
  ]);
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as InboundFrameError).code, "invalid_message");
});

test("the raw callback contract is preserved when no validator is configured", { skip: !posix }, async (t) => {
  const socketDir = await fixture(t);
  const received: unknown[] = [];
  const server = createAgentSocketServer({
    id: "sub_01",
    socketDir,
    root: socketDir,
    onMessage(message) {
      received.push(message);
    },
  });
  t.after(() => server.close());
  await server.ready;

  await writeSocketOneWay(server.socketPath, JSON.stringify({ content: "legacy shape", sequence: 2 }));
  await waitFor(() => received.length === 1, "raw frame");
  assert.deepEqual(received, [{ content: "legacy shape", sequence: 2 }]);
});

test("agent callback throws and rejected promises are routed to onError", { skip: !posix }, async (t) => {
  const socketDir = await fixture(t);
  const errors: Error[] = [];
  let calls = 0;
  const server = createAgentSocketServer({
    id: "sub_01",
    socketDir,
    root: socketDir,
    onMessage() {
      calls += 1;
      if (calls === 1) throw new Error("sync callback failure");
      return Promise.reject(new Error("async callback failure"));
    },
    onError(error) {
      errors.push(error);
    },
  });
  t.after(() => server.close());
  await server.ready;

  const frames = [
    JSON.stringify({ from: "Main", content: "first" }),
    JSON.stringify({ from: "Main", content: "second" }),
  ].join("\n") + "\n";
  await assert.rejects(writeSocketOneWay(server.socketPath, frames), /sync callback failure/);
  await waitFor(() => errors.length === 2, "application callback failures");
  assert.deepEqual(errors.map((error) => error.message), [
    "sync callback failure",
    "async callback failure",
  ]);
});

test("platform transports classify endpoints without claiming ownership", () => {
  assert.equal(unixIpc.isEndpoint("/var/run/docker.sock"), true);
  assert.equal(unixIpc.isEndpoint("/tmp/notes.txt"), false);
  assert.equal(isWindowsPipe(String.raw`\\.\pipe\arbitrary-service`), true);
  assert.equal(windowsIpc.isEndpoint(String.raw`\\.\pipe\arbitrary-service`), true);
  assert.equal(windowsIpc.isEndpoint(String.raw`C:\data\file.sock`), false);
  assert.equal(windowsIpc.key(String.raw`\\.\pipe\Case-Sensitive`), String.raw`\\.\pipe\case-sensitive`.toLowerCase());
});
