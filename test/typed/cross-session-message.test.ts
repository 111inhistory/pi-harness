/**
 * Cross-session subagent messaging.
 *
 * Three boundaries are pinned separately:
 * - Runtime admission: an unregistered sender is accepted only with a host
 *   resolved external descriptor, and an external sender cannot broadcast.
 * - Delivery rendering: the receiving model sees one `from` label carrying the
 *   full session identity, plus one managed reply address.
 * - Transport: the managed Main endpoint is the only cross-session address. A
 *   composite `from` is parsed at the IPC boundary, an unknown session is
 *   refused, and a session cannot address itself.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { getAgentSocketPath, getBroadcastSocketPath, writeSocket } from "../../src/ipc/socket.ts";
import { AgentListeners } from "../../src/subagent/listeners.ts";
import { createMessageWriteTool, type ManagedWriteHost, type SessionEndpoint } from "../../src/subagent/message-write.ts";
import {
  createSubagentRuntime,
  SubagentError,
  type JobRequest,
  type MessageEnvelope,
} from "../../src/subagent/runtime.ts";
import { deliveryEntryFor, deliveryMessage } from "../../src/subagent/delivery.ts";
import {
  registerSession,
  sendToSessionEndpoint,
  sessionMainAddress,
  sessionSenderId,
  type LiveSession,
} from "../../src/subagent/session-directory.ts";

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

  const external = { sessionId: "session-alpha", sender: "abc123:Main", replyTo: "/tmp/abc123/main.sock" };
  await assert.rejects(
    runtime.sendMessage({ from: "Main", to: first.id, content: "hello", external }),
    (error: unknown) => error instanceof SubagentError && error.code === "invalid_target",
    "another session may reach this Main only",
  );
  assert.equal(fake.deliveries.length, 0);
});

test("cross-session traffic is Main-to-Main only", async () => {
  const { fake, runtime } = runtimeFixture();
  const external = { sessionId: "session-alpha", sender: "abc123:Main", replyTo: "/tmp/abc123/main.sock" };
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
    runtime.sendMessage({
      from: first.id, to: second.id, content: "peer",
      external: { sessionId: "session-alpha", sender: "abc123:Main", replyTo: "/tmp/abc123/main.sock" },
    }),
    (error: unknown) => error instanceof SubagentError && error.code === "invalid_sender",
  );
  await runtime.sendMessage({ from: first.id, to: second.id, content: "peer" });
  assert.equal(fake.deliveries[0]?.external, undefined);
});

test("a cross-session sender cannot broadcast", async () => {
  const { runtime } = runtimeFixture();
  await assert.rejects(
    runtime.sendMessage({
      from: "Main", to: "all", content: "hi",
      external: { sessionId: "session-alpha", sender: "abc123:Main", replyTo: "/tmp/abc123/main.sock" },
    }),
    (error: unknown) => error instanceof SubagentError && error.code === "invalid_target",
  );
});

test("the receiving model sees one full identity and one managed reply address", () => {
  const external = { sessionId: "session-alpha", sender: "abc123:Main", replyTo: "/tmp/abc123/main.sock" };
  const entry = deliveryEntryFor({ type: "message", from: "Main", content: "please review", external });
  assert.equal(entry.sourceId, "abc123:Main");
  assert.equal(entry.round, 1);
  const message = deliveryMessage(entry);
  assert.equal(message.content,
    "[Message from abc123:Main]\nReply address: /tmp/abc123/main.sock\nplease review");
  assert.equal(message.details.sourceId, "abc123:Main");
  assert.equal("status" in (message.details ?? {}), false, "a peer message carries no execution state");
  assert.equal("session" in (message.details ?? {}), false);

  const local = deliveryMessage(deliveryEntryFor({ type: "message", from: "sub_01", content: "hi" }));
  assert.equal(local.content, "[Message from sub_01]\nhi");
  assert.equal("status" in (local.details ?? {}), false);
});

async function socketRoot(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-cross-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

interface RecordedSend {
  readonly from: string;
  readonly to: string;
  readonly content: string;
  readonly external?: unknown;
}

function receiverListeners(root: string, session: LiveSession, sends: RecordedSend[]): AgentListeners {
  return new AgentListeners({
    sessionId: session.sessionId,
    socketDir: session.socketDir,
    baseSocketDir: root,
    maxDepth: 2,
    actors: () => [{ agentId: "sub_01", parentAgentId: null, depth: 1 }],
    isAccepting: () => true,
    send: async (command) => { sends.push(command); return { ok: true, to: command.to, jobId: null }; },
    onError: () => {},
  });
}

test("a frame from another session reaches Main with its identity and reply address", { timeout: 15000 }, async (t) => {
  const root = await socketRoot(t);
  const receiver = await registerSession(root, { sessionId: "receiver-session", cwd: "/tmp/receiver" });
  const sender = await registerSession(root, { sessionId: "sender-session", cwd: "/tmp/sender" });
  const sends: RecordedSend[] = [];
  const listeners = receiverListeners(root, receiver, sends);
  t.after(() => listeners.close());
  await listeners.sync();

  await writeSocket(sessionMainAddress(receiver), { from: sessionSenderId(sender.uid), content: "hello" });
  assert.deepEqual(sends, [{
    from: "Main", to: "Main", content: "hello",
    external: { sessionId: "sender-session", sender: sessionSenderId(sender.uid), replyTo: sessionMainAddress(sender) },
  }]);
});

test("a composite sender at a non-Main endpoint or broadcast is refused", { timeout: 15000 }, async (t) => {
  const root = await socketRoot(t);
  const receiver = await registerSession(root, { sessionId: "receiver-session", cwd: "/tmp/receiver" });
  const sender = await registerSession(root, { sessionId: "sender-session", cwd: "/tmp/sender" });
  const sends: RecordedSend[] = [];
  const listeners = receiverListeners(root, receiver, sends);
  t.after(() => listeners.close());
  await listeners.sync();

  for (const address of [getAgentSocketPath("sub_01", receiver.socketDir), getBroadcastSocketPath("Main", receiver.socketDir)]) {
    await assert.rejects(
      writeSocket(address, { from: sessionSenderId(sender.uid), content: "hello" }),
      { code: "invalid_target" },
    );
  }
  assert.deepEqual(sends, []);
});

test("a frame naming an unknown session is refused before any delivery", { timeout: 15000 }, async (t) => {
  const root = await socketRoot(t);
  const receiver = await registerSession(root, { sessionId: "receiver-session", cwd: "/tmp/receiver" });
  const sends: RecordedSend[] = [];
  const listeners = receiverListeners(root, receiver, sends);
  t.after(() => listeners.close());
  await listeners.sync();

  await assert.rejects(
    writeSocket(sessionMainAddress(receiver), { from: "ffffffff:Main", content: "hello" }),
    { code: "unknown_session" },
  );
  assert.deepEqual(sends, []);
});

test("a frame with the removed session field has no cross-session effect", { timeout: 15000 }, async (t) => {
  const root = await socketRoot(t);
  const receiver = await registerSession(root, { sessionId: "receiver-session", cwd: "/tmp/receiver" });
  await registerSession(root, { sessionId: "sender-session", cwd: "/tmp/sender" });
  const sends: RecordedSend[] = [];
  const listeners = receiverListeners(root, receiver, sends);
  t.after(() => listeners.close());
  await listeners.sync();

  // The old field is not read at all: only `from` decides the identity.
  await writeSocket(sessionMainAddress(receiver), { from: "Main", session: "sender-session", content: "hello" });
  assert.deepEqual(sends, [{ from: "Main", to: "Main", content: "hello" }]);
});

test("a reply to the reported address reaches the sender's Main", { timeout: 15000 }, async (t) => {
  const root = await socketRoot(t);
  const alpha = await registerSession(root, { sessionId: "alpha-session", cwd: "/tmp/alpha" });
  const beta = await registerSession(root, { sessionId: "beta-session", cwd: "/tmp/beta" });
  const alphaSends: RecordedSend[] = [];
  const betaSends: RecordedSend[] = [];
  const alphaListeners = receiverListeners(root, alpha, alphaSends);
  const betaListeners = receiverListeners(root, beta, betaSends);
  t.after(async () => { await alphaListeners.close(); await betaListeners.close(); });
  await alphaListeners.sync();
  await betaListeners.sync();

  await sendToSessionEndpoint({ sender: { sessionId: alpha.sessionId, uid: alpha.uid }, target: beta, content: "ping" });
  const delivered = betaSends[0];
  const external = delivered?.external as { replyTo: string } | undefined;
  assert.equal(external?.replyTo, sessionMainAddress(alpha));

  await sendToSessionEndpoint({ sender: { sessionId: beta.sessionId, uid: beta.uid }, target: alpha, content: "pong" });
  assert.deepEqual(alphaSends, [{
    from: "Main", to: "Main", content: "pong",
    external: { sessionId: "beta-session", sender: sessionSenderId(beta.uid), replyTo: sessionMainAddress(beta) },
  }]);
});

test("a frame naming this session is local Main traffic, not an external sender", { timeout: 15000 }, async (t) => {
  const root = await socketRoot(t);
  const receiver = await registerSession(root, { sessionId: "receiver-session", cwd: "/tmp/receiver" });
  const sends: RecordedSend[] = [];
  const listeners = receiverListeners(root, receiver, sends);
  t.after(() => listeners.close());
  await listeners.sync();

  await writeSocket(sessionMainAddress(receiver), { from: sessionSenderId(receiver.uid), content: "hello" });
  assert.deepEqual(sends, [{ from: "Main", to: "Main", content: "hello" }],
    "the runtime then applies its self-send rule; the frame is never framed as another session");
});

test("the sender writes to another published session and keeps the remote refusal code", { timeout: 15000 }, async (t) => {
  const root = await socketRoot(t);
  const receiver = await registerSession(root, { sessionId: "receiver-session", cwd: "/tmp/receiver" });
  const sender = await registerSession(root, { sessionId: "sender-session", cwd: "/tmp/sender" });
  let failure: SubagentError | null = null;
  const sends: RecordedSend[] = [];
  const listeners = new AgentListeners({
    sessionId: receiver.sessionId,
    socketDir: receiver.socketDir,
    baseSocketDir: root,
    maxDepth: 2,
    actors: () => [],
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

  const self = { sessionId: sender.sessionId, uid: sender.uid };
  await sendToSessionEndpoint({ sender: self, target: receiver, content: "ping" });
  assert.deepEqual(sends, [{
    from: "Main", to: "Main", content: "ping",
    external: { sessionId: "sender-session", sender: sessionSenderId(sender.uid), replyTo: sessionMainAddress(sender) },
  }]);

  failure = new SubagentError("agent_busy", "Agent Main is stopping.");
  await assert.rejects(
    sendToSessionEndpoint({ sender: self, target: receiver, content: "ping" }),
    (error: unknown) => error instanceof SubagentError && error.code === "agent_busy",
  );
});

test("a session cannot address itself across the directory", { timeout: 15000 }, async (t) => {
  const root = await socketRoot(t);
  const self = await registerSession(root, { sessionId: "self-session", cwd: "/tmp/self" });
  const sends: RecordedSend[] = [];
  const listeners = receiverListeners(root, self, sends);
  t.after(() => listeners.close());
  await listeners.sync();

  await assert.rejects(
    sendToSessionEndpoint({ sender: { sessionId: self.sessionId, uid: self.uid }, target: self, content: "ping" }),
    (error: unknown) => error instanceof SubagentError && error.code === "invalid_target",
  );
  assert.deepEqual(sends, [], "a self-addressed frame never reaches the socket");
});

test("msg_write uses the same path for local and cross-session targets", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cross-session-write-"));
  try {
    const calls: unknown[] = [];
    const target = { sessionId: "receiver-session", uid: "abc123" } as unknown as LiveSession;
    let managed = true;
    let kind: SessionEndpoint = { kind: "local" };
    const host: ManagedWriteHost = {
      resolveEndpoint: async () => managed
        ? { isManaged: true, isBroadcast: false, targetId: "sub_01" }
        : { isManaged: false },
      sessionEndpoint: async () => kind,
      sendMessage: async (command) => { calls.push({ local: command }); return { ok: true, to: command.to, jobId: null }; },
      sendCrossSession: async (command) => { calls.push({ cross: command }); },
    };
    const ctx = { cwd } as ExtensionToolContext;
    // Real endpoint addresses for this platform: socket files or pipe names.
    const localPath = getAgentSocketPath("sub_01", cwd);
    const remotePath = getAgentSocketPath("receiver", cwd);

    // A local path keeps the existing write path.
    await createMessageWriteTool({ cwd, senderId: "sub_01", host })
      .execute("call", { path: localPath, content: "hello" }, undefined, undefined, ctx);
    assert.deepEqual(calls, [{ local: { from: "sub_01", to: "sub_01", content: "hello" } }]);

    // A session's Main endpoint is a cross-session send for Main only.
    managed = false;
    kind = { kind: "session", session: target };
    await assert.rejects(
      createMessageWriteTool({ cwd, senderId: "sub_01", host })
        .execute("call", { path: remotePath, content: "hello" }, undefined, undefined, ctx),
      (error: unknown) => error instanceof SubagentError && error.code === "invalid_target",
    );
    const result = await createMessageWriteTool({ cwd, senderId: "Main", host })
      .execute("call", { path: remotePath, content: "hello" }, undefined, undefined, ctx);
    assert.deepEqual(calls[1], { cross: { target, content: "hello" } });
    const [reply] = result.content;
    assert.equal(reply?.type, "text");
    assert.ok(reply?.type === "text" && reply.text.includes(`Successfully sent message to ${remotePath}`),
      "the success text carries the address verbatim, without transport escaping");

    // Foreign non-Main endpoints are refused before any write.
    kind = { kind: "foreign" };
    await assert.rejects(
      createMessageWriteTool({ cwd, senderId: "Main", host })
        .execute("call", { path: remotePath, content: "hello" }, undefined, undefined, ctx),
      (error: unknown) => error instanceof SubagentError && error.code === "invalid_target",
    );
    await assert.rejects(
      createMessageWriteTool({ cwd, senderId: "Main", host })
        .execute("call", { path: "not-an-address", content: "hello" }, undefined, undefined, ctx),
      (error: unknown) => error instanceof SubagentError && error.code === "invalid_target",
    );
    assert.equal(calls.length, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
