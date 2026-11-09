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
  createOwnedNdjsonServer,
  getAgentSocketPath,
  validateInboundFrame,
  writeSocket,
} from "../../src/ipc/socket.ts";
import { unixIpc } from "../../src/ipc/platform-unix.ts";
import { isWindowsPipe, windowsIpc } from "../../src/ipc/platform-windows.ts";

/** A real endpoint address: a Unix socket file or a Windows Named Pipe. */
const nativeAddress = (root: string, name: string): string => getAgentSocketPath(name, root);

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

test("the generic endpoint callback runs once per frame and callback rejection reaches onError", async (t) => {
  const root = await fixture(t);
  const address = nativeAddress(root, "generic");
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
  await assert.rejects(writeSocket(address, frames), /generic callback failure/);
  await waitFor(() => received.length === 2 && errors.length === 1, "generic endpoint callbacks");

  assert.deepEqual(received, [
    { from: "sub_01", content: "one" },
    { from: "sub_02", content: "two" },
  ]);
  assert.equal(errors[0]?.message, "generic callback failure");
});

test("a supplied validator skips only the bad frame and the later valid frame still runs", async (t) => {
  const socketDir = await fixture(t);
  const received: unknown[] = [];
  const errors: Error[] = [];
  const server = createOwnedNdjsonServer({
    address: getAgentSocketPath("sub_01", socketDir),
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
  await assert.rejects(writeSocket(server.address, frames), { code: 'invalid_message' });
  await waitFor(() => received.length === 1, "validated inbound frame");

  assert.deepEqual(received, [{ from: "sub_02", content: "valid" }]);
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as InboundFrameError).code, "invalid_message");
});

test("endpoint callback throws and rejected promises are routed to onError", async (t) => {
  const socketDir = await fixture(t);
  const errors: Error[] = [];
  let calls = 0;
  const server = createOwnedNdjsonServer({
    address: getAgentSocketPath("sub_01", socketDir),
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
  await assert.rejects(writeSocket(server.address, frames), /sync callback failure/);
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

test("endpoint namespace membership is address classification, not ownership", () => {
  const socketDir = String.raw`C:\Users\fixture\Temp\pi-session\abcdef`;
  const otherDir = String.raw`C:\Users\fixture\Temp\pi-session\123456`;
  const main = windowsIpc.agentPath("Main", socketDir);
  assert.equal(windowsIpc.belongsToNamespace(main, socketDir), true);
  assert.equal(windowsIpc.belongsToNamespace(windowsIpc.broadcastPath("Main", socketDir), socketDir), true);
  assert.equal(windowsIpc.belongsToNamespace(main, socketDir.toUpperCase()), true, "the pipe prefix folds the root's case");
  assert.equal(windowsIpc.belongsToNamespace(main, otherDir), false, "another session's directory is another namespace");
  assert.equal(windowsIpc.belongsToNamespace(String.raw`\\.\pipe\arbitrary-service`, socketDir), false);
  assert.equal(windowsIpc.belongsToNamespace(String.raw`C:\data\file.sock`, socketDir), false);

  assert.equal(unixIpc.belongsToNamespace("/tmp/root/abcdef/Main.sock", "/tmp/root/abcdef"), true);
  assert.equal(unixIpc.belongsToNamespace("/tmp/root/abcdef/sub_01/children.sock", "/tmp/root/abcdef"), true);
  assert.equal(unixIpc.belongsToNamespace("/tmp/root/abcdef/Main.sock", "/tmp/root/ABCDEF"), false, "POSIX paths stay case-sensitive");
  assert.equal(unixIpc.belongsToNamespace("/tmp/root/abcdefg/Main.sock", "/tmp/root/abcdef"), false);
  assert.equal(unixIpc.belongsToNamespace("/tmp/root/abcdef/notes.txt", "/tmp/root/abcdef"), false, "a plain file is not an endpoint");
});

const windowsRoot = String.raw`C:\Users\fixture\Temp\pi-session\abcdef`;
test("Windows endpoints use a flat pipe namespace and distinct actor/broadcast names", () => {
  const main = windowsIpc.agentPath("Main", windowsRoot);
  const child = windowsIpc.agentPath("sub_01", windowsRoot);
  const broadcast = windowsIpc.broadcastPath("main", windowsRoot);
  assert.ok(isWindowsPipe(main));
  assert.match(main, /pi-harness-[0-9a-f]{8}-Main\.sock$/);
  assert.equal(new Set([main, child, broadcast]).size, 3);
  assert.notEqual(main, windowsIpc.agentPath("Main", windowsRoot + "-other"));
  assert.equal(windowsIpc.key(main), windowsIpc.key(main.toUpperCase()));
  assert.ok(windowsIpc.isEndpoint(String.raw`\\.\pipe\external-service`));
  assert.equal(windowsIpc.isEndpoint(String.raw`C:\data\file.txt`), false);
  assert.equal(windowsIpc.isEndpoint(String.raw`C:\data\file.sock`), false, "a .sock file is not a Windows pipe");
  windowsIpc.prepare(main);
  windowsIpc.remove(main);
});

test("Win32 path resolution preserves generated pipe paths", () => {
  const endpoint = windowsIpc.agentPath("sub_01", windowsRoot);
  assert.equal(path.win32.resolve(windowsRoot, endpoint), endpoint);
  assert.ok(windowsIpc.isNamespace(path.win32.dirname(endpoint)));
});
