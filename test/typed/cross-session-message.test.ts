/**
 * Cross-session subagent messaging.
 *
 * Three boundaries are pinned separately:
 * - Runtime admission: an unregistered sender is accepted only with a host
 *   resolved external descriptor, and an external sender cannot broadcast.
 * - Delivery rendering: the receiving model sees the sending session and one
 *   reply address, and the UI title names the session instead of a round.
 * - Transport: a frame naming a live session reaches the receiving root with the
 *   directory-derived reply address; an unknown session is refused.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { deriveSessionUid, getAgentSocketPath, getBroadcastSocketPath, writeSocket } from "../../src/ipc/socket.ts";
import { AgentListeners } from "../../src/subagent/listeners.ts";
import { createMessageWriteTool, type ManagedWriteHost } from "../../src/subagent/message-write.ts";
import {
  createSubagentRuntime,
  SubagentError,
  type JobRequest,
  type MessageEnvelope,
} from "../../src/subagent/runtime.ts";
import { deliveryEntryFor, deliveryMessage } from "../../src/subagent/delivery.ts";
import {
  assertCrossSessionSupported,
  crossSessionAddress,
  crossSessionSupported,
  registerSession,
  sendToSession,
} from "../../src/subagent/session-directory.ts";

const posix = process.platform !== "win32";

interface Handle {
  request: JobRequest;
  done: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cancel(): void;
}

function adapter() {
  const started: Handle[] = [];
  const deliveries: MessageEnvelope[] = [];
  const mainDeliveries: MessageEnvelope[] = [];
  return {
    started,
    deliveries,
    mainDeliveries,
    startJob(request: JobRequest): Handle {
      let resolve!: (value: unknown) => void;
      let reject!: (error: unknown) => void;
      const done = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
      const handle: Handle = { request, done, resolve, reject, cancel() {} };
      started.push(handle);
      return handle;
    },
    deliverMessage(request: { message: MessageEnvelope | { type: string } }) {
      if (request.message.type === "message") deliveries.push(request.message as MessageEnvelope);
      return { accepted: true };
    },
    deliverToMain(message: MessageEnvelope | { type: string }) {
      if (message.type === "message") mainDeliveries.push(message as MessageEnvelope);
    },
  };
}

function runtimeFixture() {
  const fake = adapter();
  const runtime = createSubagentRuntime({
    startJob: fake.startJob,
    deliverMessage: fake.deliverMessage,
    deliverToMain: fake.deliverToMain,
  });
  const first = runtime.create({ tasks: [{ task: "first" }] }).items[0]!;
  const second = runtime.create({ tasks: [{ task: "second" }] }).items[0]!;
  return { fake, runtime, first, second };
}

test("an unregistered sender needs a host-resolved external descriptor", async () => {
  const { fake, runtime, first } = runtimeFixture();
  await assert.rejects(
    runtime.sendMessage({ from: "sub_ghost", to: first.id, content: "hello" }),
    (error: unknown) => error instanceof SubagentError && error.code === "unknown_sender",
  );
  assert.equal(fake.deliveries.length, 0);

  const external = { sessionId: "session-alpha", replyTo: crossSessionAddress("abc123") };
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: first.id, content: "hello", external }),
    (error: unknown) => error instanceof SubagentError && error.code === "invalid_target",
    "another session may reach this Main only",
  );
  assert.equal(fake.deliveries.length, 0);
});

test("cross-session traffic is Main-to-Main only", async () => {
  const { fake, runtime, first } = runtimeFixture();
  const external = { sessionId: "session-alpha", replyTo: crossSessionAddress("abc123") };
  await assert.rejects(
    runtime.sendMessage({ from: "sub_remote", to: "Main", content: "hi", external }),
    (error: unknown) => error instanceof SubagentError && error.code === "invalid_sender",
  );
  await runtime.sendMessage({ from: "Main", to: "Main", content: "hi", external });
  assert.deepEqual(fake.mainDeliveries[0]?.external, external);
  assert.equal(fake.mainDeliveries[0]?.from, "Main");
  assert.equal(fake.mainDeliveries[0]?.content, "hi");
});

test("a subagent cannot claim a cross-session identity", async () => {
  const { fake, runtime, first, second } = runtimeFixture();
  await assert.rejects(
    runtime.sendMessage({ from: first.id, to: second.id, content: "peer", external: { sessionId: "session-alpha", replyTo: "session:abc123" } }),
    (error: unknown) => error instanceof SubagentError && error.code === "invalid_sender",
  );
  await runtime.sendMessage({ from: first.id, to: second.id, content: "peer" });
  assert.equal(fake.deliveries[0]?.external, undefined);
});

test("a cross-session sender cannot broadcast", async () => {
  const { runtime } = runtimeFixture();
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: "all", content: "hi", external: { sessionId: "session-alpha", replyTo: "session:abc123" } }),
    (error: unknown) => error instanceof SubagentError && error.code === "invalid_target",
  );
});

test("the receiving model sees the sending session and one reply address", () => {
  const external = { sessionId: "session-alpha", replyTo: crossSessionAddress("abc123") };
  const entry = deliveryEntryFor({ type: "message", from: "Main", content: "please review", external });
  assert.equal(entry.session, "session-alpha");
  assert.equal(entry.round, 1);
  const message = deliveryMessage(entry);
  assert.equal(message.content,
    "[Message from Main in another session (session-alpha)]\nReply address: session:abc123\nplease review");
  assert.equal(message.details.session, "session-alpha");

  const local = deliveryMessage(deliveryEntryFor({ type: "message", from: "sub_01", content: "hi" }));
  assert.equal(local.content, "[Message from sub_01]\nhi");
  assert.equal("session" in (local.details ?? {}), false);
});

async function socketRoot(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-cross-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a frame naming a live session reaches the receiving root with a derived reply address", { skip: !posix, timeout: 15000 }, async (t) => {
  const root = await socketRoot(t);
  const sender = await registerSession(root, { sessionId: "session-alpha", cwd: "/tmp/project" });
  const sends: Array<{ from: string; to: string; content: string; external?: unknown }> = [];
  const listeners = new AgentListeners({
    socketDir: root,
    baseSocketDir: root,
    maxDepth: 2,
    actors: () => [{ agentId: "sub_01", parentAgentId: null, depth: 1 }],
    isAccepting: () => true,
    send: async (command) => { sends.push(command); return { ok: true, to: command.to, jobId: null }; },
    onError: () => {},
  });
  t.after(() => listeners.close());
  await listeners.sync();

  await writeSocket(getAgentSocketPath("Main", root), { from: "Main", session: "session-alpha", content: "hello" });
  assert.deepEqual(sends, [{
    from: "Main", to: "Main", content: "hello",
    external: { sessionId: "session-alpha", replyTo: crossSessionAddress(sender.uid) },
  }]);

  // A cross-session frame may not address a subagent or a broadcast endpoint.
  for (const address of [getAgentSocketPath("sub_01", root), getBroadcastSocketPath("Main", root)]) {
    await assert.rejects(
      writeSocket(address, { from: "Main", session: "session-alpha", content: "hello" }),
      { code: "invalid_target" },
    );
  }
  assert.equal(sends.length, 1);
});

test("a frame naming an unknown session is refused before any delivery", { skip: !posix, timeout: 15000 }, async (t) => {
  const root = await socketRoot(t);
  const sends: unknown[] = [];
  const listeners = new AgentListeners({
    socketDir: root,
    baseSocketDir: root,
    maxDepth: 2,
    actors: () => [{ agentId: "sub_01", parentAgentId: null, depth: 1 }],
    isAccepting: () => true,
    send: async (command) => { sends.push(command); return { ok: true, to: command.to, jobId: null }; },
    onError: () => {},
  });
  t.after(() => listeners.close());
  await listeners.sync();

  await assert.rejects(
    writeSocket(getAgentSocketPath("Main", root), { from: "Main", session: "ghost-session", content: "hello" }),
    { code: "unknown_session" },
  );
  assert.deepEqual(sends, []);
});

test("the sender writes to another published session and keeps the remote refusal code", { skip: !posix, timeout: 15000 }, async (t) => {
  const root = await socketRoot(t);
  const receiver = await registerSession(root, { sessionId: "receiver-session", cwd: "/tmp/receiver" });
  // Both sessions publish themselves, so the receiver can validate the sender.
  await registerSession(root, { sessionId: "sender-session", cwd: "/tmp/sender" });
  let failure: SubagentError | null = null;
  const sends: Array<{ from: string; to: string; content: string; external?: unknown }> = [];
  const listeners = new AgentListeners({
    socketDir: receiver.socketDir,
    baseSocketDir: root,
    maxDepth: 2,
    actors: () => [{ agentId: "sub_01", parentAgentId: null, depth: 1 }],
    isAccepting: () => true,
    send: async (command) => {
      if (failure !== null) throw failure;
      sends.push(command);
      return { ok: true, to: command.to, jobId: null };
    },
    onError: () => {},
  });
  t.after(() => listeners.close());
  await listeners.sync();

  await sendToSession(root, { senderSessionId: "sender-session", target: { uid: receiver.uid }, content: "ping" });
  assert.deepEqual(sends, [{
    from: "Main", to: "Main", content: "ping",
    external: { sessionId: "sender-session", replyTo: crossSessionAddress(deriveSessionUid("sender-session")) },
  }]);

  await assert.rejects(
    sendToSession(root, { senderSessionId: "sender-session", target: { uid: "ffffff" }, content: "ping" }),
    (error: unknown) => error instanceof SubagentError && error.code === "unknown_session",
  );

  failure = new SubagentError("agent_busy", "Agent Main is stopping.");
  await assert.rejects(
    sendToSession(root, { senderSessionId: "sender-session", target: { uid: receiver.uid }, content: "ping" }),
    (error: unknown) => error instanceof SubagentError && error.code === "agent_busy",
  );
});

test("msg_write accepts a cross-session address and refuses a malformed one", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cross-session-write-"));
  try {
    const calls: unknown[] = [];
    const host: ManagedWriteHost = {
      resolveEndpoint: async () => { throw new Error("a cross-session address is not an IPC path"); },
      sendMessage: async () => { throw new Error("a cross-session address is not a local recipient"); },
      sendCrossSession: async (command) => { calls.push(command); },
    };
    const tool = createMessageWriteTool({ cwd, senderId: "sub_01", host });
    const ctx = { cwd } as ExtensionToolContext;

    // A subagent may not reach another session; only Main coordinates across them.
    await assert.rejects(
      tool.execute("call", { path: "session:abc123", content: "hello" }, undefined, undefined, ctx),
      (error: unknown) => error instanceof SubagentError && error.code === "invalid_target",
    );

    const main = createMessageWriteTool({ cwd, senderId: "Main", host });
    const result = await main.execute("call", { path: "session:abc123", content: "hello" }, undefined, undefined, ctx);
    assert.deepEqual(calls, [{ target: { uid: "abc123" }, content: "hello" }]);
    assert.match(JSON.stringify(result.content), /Successfully sent message to session:abc123/);
    assert.equal(result.details, undefined);

    await assert.rejects(
      main.execute("call", { path: "session:abc123/../escape", content: "hello" }, undefined, undefined, ctx),
      (error: unknown) => error instanceof SubagentError && error.code === "invalid_target",
    );
    await assert.rejects(
      main.execute("call", { path: "not-an-address", content: "hello" }, undefined, undefined, ctx),
      (error: unknown) => error instanceof SubagentError && error.code === "invalid_target",
    );
    assert.equal(calls.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cross-session coordination is POSIX-only and refuses Windows explicitly", () => {
  assert.equal(crossSessionSupported("linux"), true);
  assert.equal(crossSessionSupported("darwin"), true);
  assert.equal(crossSessionSupported("win32"), false);
  assert.throws(
    () => assertCrossSessionSupported("win32"),
    (error: unknown) => error instanceof SubagentError && error.code === "unsupported_platform",
  );
  assert.doesNotThrow(() => assertCrossSessionSupported("linux"));
});
