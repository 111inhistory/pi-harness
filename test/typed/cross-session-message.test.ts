/**
 * Cross-session subagent messaging over the one main endpoint.
 *
 * Boundaries pinned here:
 * - the receiving root binds a full logical sender at the IPC boundary: another
 *   live session is admitted only as its Main, unknown sessions and non-Main
 *   senders are refused before any delivery;
 * - the receiving model sees one `from` label carrying the peer address plus the
 *   peer Main reply address;
 * - outbound crossing writes one frame to the peer Main endpoint and keeps a
 *   remote refusal code; nothing is retried or replayed;
 * - `msg_write` uses one logical target for local and cross-session sends.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

/**
 * The harness resolves its socket root once, when the IPC platform module first
 * loads, so the override is in place before any harness module is imported.
 */
const SOCKET_ROOT = path.join(tmpdir(), `pi-cross-session-${process.pid}-${Math.random().toString(16).slice(2, 10)}`);
process.env["PI_SUBAGENT_SOCKET_DIR"] = SOCKET_ROOT;

async function loadHarness() {
  const [root, directory, address, socket] = await Promise.all([
    import("../../src/subagent/root-service.ts"),
    import("../../src/subagent/session-directory.ts"),
    import("../../src/subagent/address.ts"),
    import("../../src/ipc/socket.ts"),
  ]);
  return { ...root, ...directory, ...address, ...socket };
}

interface Fixture {
  readonly cwd: string;
  readonly harness: Awaited<ReturnType<typeof loadHarness>>;
  readonly service: import("../../src/subagent/root-service.ts").RootService;
  readonly sent: Array<{ customType?: string; content: string }>;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-cross-session-cwd-"));
  const harness = await loadHarness();
  const sent: Array<{ customType?: string; content: string }> = [];
  const api = {
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools() {},
    appendEntry() {},
    sendMessage(message: { customType?: string; content: string }) { sent.push(message); },
  } as unknown as ExtensionAPI;
  const context = {
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    modelRegistry: { find: () => undefined },
    isIdle: () => true,
  } as unknown as ExtensionContext;
  const service = new harness.RootService({
    api, context, agentDir: path.join(cwd, "agent"), allocatedIds: new Set(), ownsContext: () => true,
  });
  await service.initialize();
  t.after(async () => {
    await service.retire();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, harness, service, sent };
}

test("a peer Main message reaches Main with its full identity and reply address", { timeout: 15000 }, async t => {
  const { harness, service, sent } = await fixture(t);
  const peer = await harness.registerSession(SOCKET_ROOT, { sessionId: "peer-session", cwd: "/tmp/peer" });
  t.after(() => harness.unregisterSession(SOCKET_ROOT, peer.sessionId));
  t.after(() => rm(SOCKET_ROOT, { recursive: true, force: true }));

  const own = (await service.listSessions()).find(session => session.sessionId === service.sessionId);
  assert.ok(own, "this root publishes itself under the shared socket root");
  await harness.writeSocket(harness.sessionMainAddress(own),
    { from: harness.formatAddress(peer.uid, harness.MAIN_ACTOR), to: harness.formatAddress(own.uid, harness.MAIN_ACTOR), content: "hello" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.content,
    `[Message from ${peer.uid}:main]\nReply address: ${peer.uid}:main\nhello`);
});

test("an unknown session, a foreign non-Main sender and a bare sender are refused before delivery", { timeout: 15000 }, async t => {
  const { harness, service, sent } = await fixture(t);
  const own = (await service.listSessions()).find(session => session.sessionId === service.sessionId);
  assert.ok(own);
  const ownMain = harness.formatAddress(own.uid, harness.MAIN_ACTOR);
  const address = harness.sessionMainAddress(own);

  for (const [frame, code] of [
    [{ from: "ffffffff:main", to: ownMain, content: "hello" }, "unknown_session"],
    [{ from: "abcdef12:sub_3", to: ownMain, content: "hello" }, "invalid_target"],
    [{ from: "main", to: ownMain, content: "hello" }, "unknown_sender"],
    [{ from: "not-an-address", to: ownMain, content: "hello" }, "unknown_sender"],
    [{ from: ownMain, to: "ffffffff:main", content: "hello" }, "cross_session_target"],
  ] as const) {
    await assert.rejects(harness.writeSocket(address, frame), { code });
  }
  assert.deepEqual(sent, []);
});

test("a frame naming this root Main is a local self-send, never a peer session", { timeout: 15000 }, async t => {
  const { harness, service, sent } = await fixture(t);
  const own = (await service.listSessions()).find(session => session.sessionId === service.sessionId);
  assert.ok(own);
  const ownMain = harness.formatAddress(own.uid, harness.MAIN_ACTOR);
  // The canonical self-send rule rejects it; it is never reframed as another
  // session's Main and never reaches a loopback delivery.
  await assert.rejects(harness.writeSocket(harness.sessionMainAddress(own),
    { from: ownMain, to: ownMain, content: "note" }), { code: "invalid_target" });
  assert.deepEqual(sent, []);
});

test("cross-session send writes one frame to the peer Main and never retries", { timeout: 15000 }, async t => {
  const { harness, service } = await fixture(t);
  const peer = await harness.registerSession(SOCKET_ROOT, { sessionId: "peer-session", cwd: "/tmp/peer" });
  t.after(() => harness.unregisterSession(SOCKET_ROOT, peer.sessionId));
  t.after(() => rm(SOCKET_ROOT, { recursive: true, force: true }));

  const frames: unknown[] = [];
  const peerListener = harness.createOwnedNdjsonServer({
    address: harness.sessionMainAddress(peer), root: SOCKET_ROOT,
    onMessage: (frame: unknown) => { frames.push(frame); },
  });
  await peerListener.ready;
  t.after(() => peerListener.close());

  const own = (await service.listSessions()).find(session => session.sessionId === service.sessionId);
  assert.ok(own);
  const to = harness.formatAddress(peer.uid, harness.MAIN_ACTOR);
  await service.sendCrossSession({ target: peer, to, content: "ping" });
  assert.deepEqual(frames, [{ from: `${own.uid}:main`, to, content: "ping" }]);

  await assert.rejects(service.sendCrossSession({ target: own, to: harness.formatAddress(own.uid, harness.MAIN_ACTOR), content: "self" }),
    { code: "invalid_target" });
  assert.equal(frames.length, 1);
});

test("a reply to the reported address reaches the sender Main", { timeout: 15000 }, async t => {
  const { harness, service } = await fixture(t);
  const peer = await harness.registerSession(SOCKET_ROOT, { sessionId: "peer-session", cwd: "/tmp/peer" });
  t.after(() => harness.unregisterSession(SOCKET_ROOT, peer.sessionId));
  t.after(() => rm(SOCKET_ROOT, { recursive: true, force: true }));

  const frames: Array<{ from: string; content: string }> = [];
  const peerListener = harness.createOwnedNdjsonServer({
    address: harness.sessionMainAddress(peer), root: SOCKET_ROOT,
    onMessage: (frame: unknown) => { frames.push(frame as { from: string; content: string }); },
  });
  await peerListener.ready;
  t.after(() => peerListener.close());

  const resolved = await service.resolveTarget(harness.formatAddress(peer.uid, harness.MAIN_ACTOR));
  assert.equal(resolved.kind, "session");
  if (resolved.kind !== "session") return;
  await service.sendCrossSession({ target: resolved.session, to: harness.formatAddress(peer.uid, harness.MAIN_ACTOR), content: "pong" });
  assert.deepEqual(frames, [{ from: (await service.listSessions()).find(s => s.sessionId === service.sessionId)!.uid + ":main",
    to: harness.formatAddress(peer.uid, harness.MAIN_ACTOR), content: "pong" }]);
});

test("msg_write uses one logical target for local and cross-session sends", async () => {
  const createMessageWriteTool = (await import("../../src/subagent/message-write.ts")).createMessageWriteTool;
  const calls: unknown[] = [];
  const peer = { sessionId: "peer-session", uid: "abc12345" };
  let resolved: import("../../src/subagent/managed-send.ts").ResolvedTarget = { kind: "local" };
  const host: import("../../src/subagent/managed-send.ts").ManagedWriteHost = {
    resolveTarget: async () => resolved,
    sendMessage: async command => { calls.push({ local: command }); return { ok: true, to: command.to, jobId: null }; },
    sendCrossSession: async command => { calls.push({ cross: command }); },
  };
  const local = "aaaaaaa1:sub_2-1";
  const remote = "abc12345:main";
  const tool = (senderId: string) => createMessageWriteTool({ senderId, host });
  const context = {} as ExtensionToolContext;

  await tool("aaaaaaa1:sub_2-1").execute("call", { to: local, content: "hello" }, undefined, undefined, context);
  assert.deepEqual(calls, [{ local: { from: "aaaaaaa1:sub_2-1", to: local, content: "hello" } }]);

  resolved = { kind: "session", session: peer as never };
  await assert.rejects(tool("aaaaaaa1:sub_2-1").execute("call", { to: remote, content: "hello" }, undefined, undefined, context),
    { code: "invalid_target" });
  const result = await tool("main").execute("call", { to: remote, content: "hello" }, undefined, undefined, context);
  assert.deepEqual(calls[1], { cross: { target: peer, to: remote, content: "hello" } });
  const [reply] = result.content;
  assert.ok(reply?.type === "text" && reply.text.includes(`Successfully sent message to ${remote}`),
    "the success text carries the logical address verbatim");

  resolved = { kind: "foreign" };
  await assert.rejects(tool("main").execute("call", { to: remote, content: "hello" }, undefined, undefined, context),
    { code: "invalid_target" });
  resolved = { kind: "unknown" };
  await assert.rejects(tool("main").execute("call", { to: remote, content: "hello" }, undefined, undefined, context),
    { code: "unknown_session" });
  await assert.rejects(tool("main").execute("call", { to: "/tmp/project/main.sock", content: "hello" }, undefined, undefined, context),
    { code: "invalid_target" }, "a filesystem path is not a logical target");
  await assert.rejects(tool("main").execute("call", { to: remote, content: "hello" }, AbortSignal.abort(), undefined, context),
    { code: "cancelled" });
  assert.equal(calls.length, 2);
});
