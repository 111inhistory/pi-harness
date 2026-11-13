/**
 * During compaction the root acknowledges queue ownership immediately. SDK
 * handoff waits for the native boundary; retirement drains the accepted queue
 * while it still owns the original context, and uncertain handoffs never replay.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import subagentExtension from "../../extensions/harness.ts";
import { RootService } from "../../src/subagent/root-service.ts";
import { deriveSessionUid, getAgentSocketPath, writeSocket } from "../../src/ipc/socket.ts";
import { registerSession, sessionSenderId, unregisterSession } from "../../src/subagent/session-directory.ts";
import { waitFor } from "../../test-support/async.ts";

interface Sent {
  readonly content: unknown;
  readonly options: unknown;
}

function harness(cwd: string, agentDir: string, sessionManager: SessionManager, sent: Sent[]): { api: ExtensionAPI; context: ExtensionContext } {
  const api = {
    appendEntry: () => {},
    getAllTools: () => [],
    getActiveTools: () => ["msg_write"],
    sendMessage: async (message: { content: unknown }, options: unknown) => { sent.push({ content: message.content, options }); },
    registerTool: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  const context = {
    modelRegistry: { find: () => undefined },
    sessionManager,
    cwd,
    isIdle: () => true,
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  return { api, context };
}

async function fixture(t: test.TestContext): Promise<{ cwd: string; agentDir: string; sessionDir: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "delivery-compaction-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = path.join(cwd, "agent");
  const sessionDir = path.join(cwd, "sessions");
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  return { cwd, agentDir, sessionDir };
}

function peerMessage(): Parameters<RootService["sendMessage"]>[0] {
  return {
    from: "Main",
    to: "Main",
    content: "peer message during compaction",
    external: { sessionId: "peer-session", sender: "peer:Main", replyTo: "/tmp/peer/Main.sock" },
  };
}

test("Main acknowledges queue ownership before compaction finishes", async (t) => {
  const { cwd, agentDir, sessionDir } = await fixture(t);
  const sent: Sent[] = [];
  const { api, context } = harness(cwd, agentDir, SessionManager.create(cwd, sessionDir), sent);
  const service = new RootService({ api, context, agentDir, allocatedIds: new Set(), ownsContext: () => true });
  try {
    await service.initialize();
    service.beginCompaction();
    await service.sendMessage(peerMessage());
    assert.equal(sent.length, 0, "nothing is steered while compaction is running");

    service.endCompaction();
    await waitFor(() => sent.length === 1, { label: "queued Main delivery" });
    assert.equal(sent.length, 1);
    assert.match(String(sent[0]?.content), /\[Message from peer:Main\][\s\S]*peer message during compaction/);
    assert.deepEqual(sent[0]?.options, { triggerTurn: true, deliverAs: "steer" });
  } finally {
    await service.retire();
  }
});

test("retiring while compacting releases the wait instead of hanging", async (t) => {
  const { cwd, agentDir, sessionDir } = await fixture(t);
  const sent: Sent[] = [];
  const { api, context } = harness(cwd, agentDir, SessionManager.create(cwd, sessionDir), sent);
  const service = new RootService({ api, context, agentDir, allocatedIds: new Set(), ownsContext: () => true });
  await service.initialize();
  service.beginCompaction();
  const pending = service.sendMessage(peerMessage()).then(
    () => "delivered" as const,
    () => "refused" as const,
  );
  await service.retire();
  const outcome = await pending;
  // The quiescing root may retain the notice; a detached root refuses it. Both
  // settle, and a retained notice never wakes the old root.
  if (outcome === "delivered") {
    assert.equal(sent.length, 1);
    assert.equal((sent[0]?.options as { triggerTurn?: boolean }).triggerTurn, false);
  } else {
    assert.equal(sent.length, 0);
  }
});

test("socket acknowledgement does not wait for the receiver's compaction", async t => {
  const { cwd, agentDir, sessionDir } = await fixture(t);
  const manager = SessionManager.create(cwd, sessionDir);
  const sent: Sent[] = [];
  const { api, context } = harness(cwd, agentDir, manager, sent);
  const service = new RootService({ api, context, agentDir, allocatedIds: new Set(), ownsContext: () => true });
  await service.initialize();
  const sender = await registerSession(service.socketRoot, { sessionId: 'compaction-peer-fixture', cwd });
  try {
    service.beginCompaction();
    const address = getAgentSocketPath('Main', path.join(service.socketRoot, deriveSessionUid(manager.getSessionId())));
    await writeSocket(address, { from: sessionSenderId(sender.uid), content: 'queued over the socket' }, { timeoutMs: 1000 });
    assert.equal(sent.length, 0, 'the socket acknowledges before the SDK can receive the message');
    service.endCompaction();
    await waitFor(() => sent.length === 1, { label: 'socket message after compaction' });
    assert.match(String(sent[0]?.content), /queued over the socket/);
  } finally {
    await service.retire();
    await unregisterSession(service.socketRoot, sender.sessionId);
  }
});

test("retirement drains accepted messages in order before detaching the root", async t => {
  const { cwd, agentDir, sessionDir } = await fixture(t);
  const sent: Sent[] = [];
  const { api, context } = harness(cwd, agentDir, SessionManager.create(cwd, sessionDir), sent);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(api, 'sendMessage', async (message: { content: unknown }, options: unknown) => {
    sent.push({ content: message.content, options });
    if (sent.length === 1) await gate;
  });
  const service = new RootService({ api, context, agentDir, allocatedIds: new Set(), ownsContext: () => true });
  await service.initialize();
  try {
    service.beginCompaction();
    await service.sendMessage({ ...peerMessage(), content: 'first queued message' });
    await service.sendMessage({ ...peerMessage(), content: 'second queued message' });
    service.endCompaction();
    await waitFor(() => sent.length === 1, { label: 'first SDK handoff' });
    let retired = false;
    const retirement = service.retire().then(() => { retired = true; });
    await service.listeners.close();
    await waitFor(async () => !(await service.listSessions()).some(session => session.sessionId === service.sessionId), {
      label: 'directory unpublication',
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(retired, false, 'the outstanding SDK handoff still belongs to this root');
    assert.equal(sent.length, 1, 'the second message cannot overtake the first');
    release();
    await retirement;
    assert.equal(service.closed, true);
    assert.equal(sent.length, 2);
    assert.match(String(sent[0]?.content), /first queued message/);
    assert.match(String(sent[1]?.content), /second queued message/);
    assert.equal((sent[1]?.options as { triggerTurn: boolean }).triggerTurn, false, 'retirement retains without waking');
  } finally {
    release();
    await service.retire();
  }
});

test("a queued SDK handoff failure is reported once and never replayed", async t => {
  const { cwd, agentDir, sessionDir } = await fixture(t);
  const sent: Sent[] = [];
  const { api, context } = harness(cwd, agentDir, SessionManager.create(cwd, sessionDir), sent);
  const errors: string[] = [];
  t.mock.method(context.ui, 'notify', (message: string) => { errors.push(message); });
  t.mock.method(api, 'sendMessage', async (message: { content: unknown }, options: unknown) => {
    sent.push({ content: message.content, options });
    if (sent.length === 1) throw new Error('uncertain SDK handoff');
  });
  const service = new RootService({ api, context, agentDir, allocatedIds: new Set(), ownsContext: () => true });
  try {
    await service.initialize();
    service.beginCompaction();
    await service.sendMessage({ ...peerMessage(), content: 'uncertain first' });
    await service.sendMessage({ ...peerMessage(), content: 'known second' });
    service.endCompaction();
    await waitFor(() => sent.length === 2 && errors.length === 1, { label: 'failure reporting and next handoff' });
    service.endCompaction();
    await service.retire();
    assert.equal(sent.length, 2, 'the first submission is never retried');
    assert.deepEqual(errors, ['uncertain SDK handoff']);
    assert.match(String(sent[1]?.content), /known second/);
  } finally {
    await service.retire();
  }
});

test("a queued message cannot enter the replacement root after ownership is lost", async t => {
  const { cwd, agentDir, sessionDir } = await fixture(t);
  const sent: Sent[] = [];
  const { api, context } = harness(cwd, agentDir, SessionManager.create(cwd, sessionDir), sent);
  const errors: string[] = [];
  t.mock.method(context.ui, 'notify', (message: string) => { errors.push(message); });
  let owns = true;
  const service = new RootService({ api, context, agentDir, allocatedIds: new Set(), ownsContext: () => owns });
  try {
    await service.initialize();
    service.beginCompaction();
    await service.sendMessage(peerMessage());
    owns = false;
    service.endCompaction();
    await waitFor(() => errors.length === 1, { label: 'lost-generation delivery refusal' });
    assert.equal(sent.length, 0);
    assert.match(errors[0]!, /no longer owns this delivery/);
  } finally {
    await service.retire();
  }
});

test("the extension subscribes to the native compaction lifecycle", () => {
  const events: string[] = [];
  const api = {
    on: (event: string) => { events.push(event); return () => {}; },
    registerTool: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  subagentExtension(api);
  for (const event of ["session_before_compact", "session_compact", "session_compact_failed"]) {
    assert.ok(events.includes(event), `${event} is registered`);
  }
});
