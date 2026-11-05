import { defaultSocketRoot, effectiveUserId } from '../../src/ipc/address.ts';
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  IpcOwnershipError,
  createOwnedServer,
  ensurePrivateDirectory,
  ensurePrivateSocketRoot,
  endpointInsideDirectory,
  inspectEndpoint,
  prepareEndpoint,
  releaseEndpoint,
} from "../../src/ipc/endpoint.ts";
import { ipc } from "../../src/ipc/platform.ts";
import { createOwnedNdjsonServer, getAgentSocketPath, writeSocket } from "../../src/ipc/socket.ts";

const posix = process.platform !== "win32";

async function fixture(t: { after: (fn: () => Promise<void> | void) => void }) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-ipc-own-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return { root, address: path.join(root, "agent.sock") };
}

/** A real endpoint address: a Unix socket file or a Windows Named Pipe. */
const nativeAddress = (root: string, name: string): string => getAgentSocketPath(name, root);

function ownershipError(code: string) {
  return (error: unknown) => error instanceof IpcOwnershipError && error.code === code;
}

/** A bound endpoint is a socket file on Unix and a kernel pipe name on Windows. */
const releasedOnClose = (address: string): boolean => !ipc.isNamespace(address);

test("an active endpoint refuses a competing server without disturbing the live listener", async (t) => {
  const { root } = await fixture(t);
  const address = nativeAddress(root, "agent");
  let accepted = 0;
  const first = createOwnedServer({
    address,
    isNamespace: ipc.isNamespace(address),
    onConnection(socket: net.Socket) {
      accepted += 1;
      socket.resume();
    },
  });
  await first.ready;
  t.after(() => first.close());
  if (posix) assert.deepEqual(await fsp.readdir(root), ["agent.sock"], "the private bind name is not published alongside the endpoint");

  const second = createOwnedServer({ address, isNamespace: ipc.isNamespace(address), onConnection() {} });
  await assert.rejects(second.ready, ownershipError("ipc_endpoint_in_use"));
  const competing = await second.close();
  assert.equal((competing.startupError as IpcOwnershipError | null)?.code, "ipc_endpoint_in_use");
  assert.equal(competing.release, null, "a competing startup owns nothing to release");

  const acceptedBefore = accepted;
  const serverAccepted = once(first.server, "connection");
  const client = net.connect(address);
  t.after(() => client.destroy());
  await Promise.all([once(client, "connect"), serverAccepted]);
  assert.equal(accepted, acceptedBefore + 1, "the live listener accepted the new client");

  const closed = await first.close();
  assert.equal(closed.startupError, null);
  assert.equal(closed.release?.removed, releasedOnClose(address));
  await assert.rejects(fsp.stat(address), { code: "ENOENT" });
  assert.deepEqual(await fsp.readdir(root), [], "teardown leaves no temporary bind names or endpoint");
});

test("a closed endpoint can be rebound immediately and still serves a request", async (t) => {
  const { root } = await fixture(t);
  const address = nativeAddress(root, "agent");
  const replies: unknown[] = [];
  const open = () => createOwnedNdjsonServer({ address, root, onMessage(message: unknown) { replies.push(message); } });

  const first = open();
  await first.ready;
  await writeSocket(address, { from: "sub_01", content: "before close" });
  await first.close();
  await assert.rejects(fsp.stat(address), { code: "ENOENT" });

  const second = open();
  t.after(() => second.close());
  await second.ready;
  await writeSocket(address, { from: "sub_01", content: "after rebind" });
  assert.deepEqual(replies, [
    { from: "sub_01", content: "before close" },
    { from: "sub_01", content: "after rebind" },
  ]);
});

test("an endpoint bound by another process cannot be taken over", { timeout: 10000 }, async (t) => {
  const { root } = await fixture(t);
  const address = nativeAddress(root, "agent");
  const script = `
    const net = require("node:net");
    const server = net.createServer((socket) => socket.resume());
    server.listen(process.argv[1], () => process.stdout.write("listening\\n"));
  `;
  const child = spawn(process.execPath, ["-e", script, address], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  await once(child.stdout!, "data");

  const competing = createOwnedServer({ address, isNamespace: ipc.isNamespace(address), onConnection() {} });
  await assert.rejects(competing.ready, ownershipError("ipc_endpoint_in_use"));
  await competing.close();

  child.kill("SIGKILL");
  await once(child, "exit");
});

test("teardown force-closes held-open and half-frame clients and is idempotent", async (t) => {
  const { root } = await fixture(t);
  const address = nativeAddress(root, "agent");
  const chunks: Buffer[] = [];
  const owned = createOwnedServer({
    address,
    isNamespace: ipc.isNamespace(address),
    onConnection(socket: net.Socket) {
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    },
  });
  await owned.ready;
  t.after(() => owned.close());

  const client = net.connect(address);
  client.on("error", () => {});
  t.after(() => client.destroy());
  await once(client, "connect");
  client.write('{"partial":');
  const deadline = Date.now() + 2000;
  while (chunks.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(chunks.length > 0, "the half frame reached the tracked connection");
  assert.equal(owned.clients.size, 1);

  const clientClosed = once(client, "close");
  const firstClose = owned.close();
  const secondClose = owned.close();
  assert.equal(firstClose, secondClose, "repeated close returns the same operation");
  const result = await firstClose;
  assert.equal(result.startupError, null);
  assert.equal(result.release?.removed, releasedOnClose(address));
  await clientClosed;
  await assert.rejects(fsp.stat(address), { code: "ENOENT" });
  assert.deepEqual(await fsp.readdir(root), [], "close leaves no temporary bind names");
});

test("ordinary files, directories and symlinks are preserved", { skip: !posix }, async (t) => {
  const { root, address } = await fixture(t);
  await fsp.writeFile(address, "ordinary file");
  await assert.rejects(prepareEndpoint({ address }), ownershipError("ipc_endpoint_not_socket"));
  assert.equal(await fsp.readFile(address, "utf8"), "ordinary file");

  const directory = path.join(root, "as-directory.sock");
  await fsp.mkdir(directory);
  await assert.rejects(prepareEndpoint({ address: directory }), ownershipError("ipc_endpoint_not_socket"));
  assert.ok((await fsp.stat(directory)).isDirectory());

  const target = path.join(root, "target.txt");
  await fsp.writeFile(target, "target content");
  const link = path.join(root, "link.sock");
  await fsp.symlink(target, link);
  await assert.rejects(prepareEndpoint({ address: link }), ownershipError("ipc_endpoint_symlink"));
  assert.ok((await fsp.lstat(link)).isSymbolicLink());
  assert.equal(await fsp.readFile(target, "utf8"), "target content");
});

test("close removes only the inode this server bound", { skip: !posix }, async (t) => {
  const { root, address } = await fixture(t);
  const owned = createOwnedServer({ address, onConnection() {} });
  await owned.ready;
  t.after(() => owned.close());
  const bound = inspectEndpoint(address).identity;
  assert.notEqual(bound, null);

  fs.unlinkSync(address);
  fs.writeFileSync(address, "replacement after bind");
  const result = await owned.close();
  assert.equal(result.release?.removed, false);
  assert.equal(result.release?.reason, "not_owned");
  assert.equal(fs.readFileSync(address, "utf8"), "replacement after bind");
  assert.deepEqual(await fsp.readdir(root), ["agent.sock"], "no temporary bind name remains after close");
});

test("release requires a matching identity instead of removing by path alone", { skip: !posix }, async (t) => {
  const { address } = await fixture(t);
  fs.writeFileSync(address, "not a socket");
  const result = releaseEndpoint({ address, namespace: false, identity: { dev: 0, ino: 0 }, staleRemoved: false });
  assert.deepEqual(result, { removed: false, reason: "not_owned" });
  assert.equal(fs.readFileSync(address, "utf8"), "not a socket");
});

test("insecure or foreign-owner directories are refused without repair", { skip: !posix }, async (t) => {
  const { root } = await fixture(t);
  const uid = effectiveUserId();
  assert.notEqual(uid, null);
  if (posix && typeof process.geteuid === "function") {
    assert.equal(uid, process.geteuid(), "the effective uid, not the real uid, owns the root");
  }
  const directory = path.join(root, "session");
  ensurePrivateDirectory(directory, uid);
  assert.equal((fs.statSync(directory).mode & 0o777), 0o700);
  fs.chmodSync(directory, 0o755);
  assert.throws(() => ensurePrivateDirectory(directory, uid), ownershipError("ipc_directory_insecure"));
  assert.equal((fs.statSync(directory).mode & 0o777), 0o755, "the check must not chmod the path");
});

test("default roots are per effective user while explicit overrides are retained", () => {
  assert.equal(
    defaultSocketRoot({ platform: "linux", env: {}, tmpdir: "/tmp", userId: 1234 }),
    path.join("/tmp", "pi-subagents-1234"),
  );
  assert.equal(
    defaultSocketRoot({ platform: "linux", env: { PI_SUBAGENT_SOCKET_DIR: "/custom/root" }, tmpdir: "/tmp", userId: 1234 }),
    "/custom/root",
  );
  assert.equal(
    defaultSocketRoot({ platform: "win32", env: {}, tmpdir: "C:\\Temp", userId: null }),
    path.join("C:\\Temp", "pi-subagents"),
  );
});

test("the managed namespace root itself is validated before any session directory", { skip: !posix }, async (t) => {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-ipc-root-"));
  t.after(() => fsp.rm(parent, { recursive: true, force: true }));
  const uid = effectiveUserId();
  const root = path.join(parent, `pi-subagents-${uid ?? 0}`);
  const sessionDir = path.join(root, "session");
  const address = path.join(sessionDir, "agent.sock");
  const attacker = path.join(parent, "attacker");
  await fsp.mkdir(attacker, { mode: 0o700 });

  await fsp.symlink(attacker, root);
  await assert.rejects(prepareEndpoint({ address, root }), ownershipError("ipc_root_symlink"));
  assert.ok((await fsp.lstat(root)).isSymbolicLink(), "the attacker's symlink is preserved, not followed");
  await assert.rejects(fsp.stat(path.join(attacker, "session")), { code: "ENOENT" });
  await fsp.unlink(root);

  await fsp.mkdir(root, { mode: 0o777 });
  await fsp.chmod(root, 0o777);
  await assert.rejects(prepareEndpoint({ address, root }), ownershipError("ipc_root_insecure"));
  await assert.rejects(fsp.stat(sessionDir), { code: "ENOENT" });
  assert.equal(fs.statSync(root).mode & 0o777, 0o777, "validation does not chmod an insecure root");

  const fileRoot = path.join(parent, "root-file");
  await fsp.writeFile(fileRoot, "not a root");
  await assert.rejects(prepareEndpoint({ address: path.join(fileRoot, "session", "agent.sock"), root: fileRoot }), ownershipError("ipc_root_not_directory"));
  assert.equal(await fsp.readFile(fileRoot, "utf8"), "not a root");
});

test("a missing managed root is created private and nested session directories still validate", { skip: !posix }, async (t) => {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-ipc-root-"));
  t.after(() => fsp.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "managed-root");
  const sessionDir = path.join(root, "session");
  const address = path.join(sessionDir, "agent.sock");
  assert.equal(endpointInsideDirectory(address, root), true);
  assert.equal(endpointInsideDirectory(address, path.join(parent, "other-root")), false);

  const validation = ensurePrivateSocketRoot(root);
  assert.equal(validation.created, true);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);

  await prepareEndpoint({ address, root });
  assert.equal(fs.statSync(sessionDir).mode & 0o777, 0o700);

  const attacker = path.join(parent, "nested-attacker");
  await fsp.mkdir(attacker, { mode: 0o700 });
  const link = path.join(root, "linked-session");
  await fsp.symlink(attacker, link);
  await assert.rejects(
    prepareEndpoint({ address: path.join(link, "agent.sock"), root }),
    ownershipError("ipc_directory_symlink"),
  );
  await assert.rejects(fsp.stat(path.join(attacker, "agent.sock")), { code: "ENOENT" });
});

test("arbitrary sockets outside the managed root keep the external leaf-only contract", { skip: !posix }, async (t) => {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-ipc-root-"));
  t.after(() => fsp.rm(parent, { recursive: true, force: true }));
  const managed = path.join(parent, "managed-root");
  await fsp.mkdir(managed, { mode: 0o700 });
  const externalDir = path.join(parent, "external");
  await fsp.mkdir(externalDir, { mode: 0o700 });
  const external = path.join(externalDir, "agent.sock");
  assert.equal(endpointInsideDirectory(external, managed), false);
  const lease = await prepareEndpoint({ address: external, root: managed });
  assert.equal(lease.staleRemoved, false);
  assert.equal(fs.statSync(externalDir).mode & 0o777, 0o700, "the external leaf is still validated");
});

test("publishing fails closed when atomic hard-link no-replace is unavailable", { skip: !posix }, async (t) => {
  const { root, address } = await fixture(t);
  const original = fs.linkSync;
  const unsupported = Object.assign(new Error("hard links are not supported for sockets here"), { code: "EPERM" });
  (fs as unknown as { linkSync: typeof fs.linkSync }).linkSync = (() => { throw unsupported; }) as typeof fs.linkSync;
  try {
    const owned = createOwnedServer({ address, onConnection() {} });
    await assert.rejects(owned.ready, ownershipError("ipc_endpoint_publish_unsupported"));
    const closed = await owned.close();
    assert.equal((closed.startupError as IpcOwnershipError | null)?.code, "ipc_endpoint_publish_unsupported");
    await assert.rejects(fsp.stat(address), { code: "ENOENT" });
    assert.deepEqual(await fsp.readdir(root), [], "the failed publish removes its private temporary bind name");
  } finally {
    (fs as unknown as { linkSync: typeof fs.linkSync }).linkSync = original;
  }
});

test("failed hard-link publish never overwrites a destination that appeared concurrently", { skip: !posix }, async (t) => {
  const { root, address } = await fixture(t);
  const original = fs.linkSync;
  const unsupported = Object.assign(new Error("hard links are not supported for sockets here"), { code: "EPERM" });
  (fs as unknown as { linkSync: typeof fs.linkSync }).linkSync = ((_temporary: fs.PathLike, destination: fs.PathLike) => {
    fs.writeFileSync(destination, "appeared during publish");
    throw unsupported;
  }) as typeof fs.linkSync;
  try {
    const owned = createOwnedServer({ address, onConnection() {} });
    await assert.rejects(owned.ready, ownershipError("ipc_endpoint_publish_unsupported"));
    await owned.close();
    assert.equal(await fsp.readFile(address, "utf8"), "appeared during publish");
    assert.deepEqual(await fsp.readdir(root), ["agent.sock"], "only the concurrent destination remains");
  } finally {
    (fs as unknown as { linkSync: typeof fs.linkSync }).linkSync = original;
  }
});

test("a crashed process's abandoned socket is recovered only after ownership and inactivity checks", { skip: !posix, timeout: 10000 }, async (t) => {
  const { address } = await fixture(t);
  const script = `
    const net = require("node:net");
    const server = net.createServer();
    server.listen(process.argv[1], () => process.stdout.write("listening\\n"));
  `;
  const child = spawn(process.execPath, ["-e", script, address], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal(inspectEndpoint(address).kind, "socket");

  const lease = await prepareEndpoint({ address, probeTimeoutMs: 1000 });
  assert.equal(lease.staleRemoved, true);
  await assert.rejects(fsp.stat(address), { code: "ENOENT" });

  const replacement = createOwnedServer({ address, onConnection() {} });
  await replacement.ready;
  await replacement.close();
});
