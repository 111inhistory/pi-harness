/**
 * Deliveries wait for native compaction.
 *
 * A steer handed to the SDK while the root is compacting can land inside the
 * rewritten boundary or interleave with the retried turn. The root gates Main
 * deliveries on the native compaction lifecycle and releases them on retirement
 * instead of hanging.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import subagentExtension from "../../src/subagent/extension.ts";
import { RootService } from "../../src/subagent/root-service.ts";

interface Sent {
  readonly content: unknown;
  readonly options: unknown;
}

function harness(cwd: string, agentDir: string, sessionManager: SessionManager, sent: Sent[]): { api: ExtensionAPI; context: ExtensionContext } {
  const api = {
    appendEntry: () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
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

test("a Main delivery waits until native compaction finishes", async (t) => {
  const { cwd, agentDir, sessionDir } = await fixture(t);
  const sent: Sent[] = [];
  const { api, context } = harness(cwd, agentDir, SessionManager.create(cwd, sessionDir), sent);
  const service = new RootService({ api, context, agentDir, allocatedIds: new Set(), ownsContext: () => true });
  try {
    await service.initialize();
    service.beginCompaction();
    const pending = service.sendMessage(peerMessage());
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sent.length, 0, "nothing is steered while compaction is running");

    service.endCompaction();
    await pending;
    assert.equal(sent.length, 1);
    assert.match(String(sent[0]?.content), /\[Message from peer:Main\][\s\S]*peer message during compaction/);
    assert.deepEqual(sent[0]?.options, { triggerTurn: true, deliverAs: "steer" });
  } finally {
    await service.retire();
  }
});

test("retiring while compacting releases the wait and fails the delivery", async (t) => {
  const { cwd, agentDir, sessionDir } = await fixture(t);
  const sent: Sent[] = [];
  const { api, context } = harness(cwd, agentDir, SessionManager.create(cwd, sessionDir), sent);
  const service = new RootService({ api, context, agentDir, allocatedIds: new Set(), ownsContext: () => true });
  await service.initialize();
  service.beginCompaction();
  const pending = assert.rejects(
    service.sendMessage(peerMessage()),
    (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "delivery_failed"
      && /not accepting new operations/.test(error.message),
  );
  await service.retire();
  await pending;
  assert.equal(sent.length, 0, "a delivery released by retirement is not steered");
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
