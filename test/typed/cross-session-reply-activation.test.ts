/**
 * A cross-session message loads the reply tool, and nothing else.
 *
 * Main starts without `msg_write`. When a peer session addresses this Main, the
 * receiving host activates `msg_write` before the triggered turn builds its tool
 * loadout, so the model can answer without a Capability discovery round. The
 * activation is receipt-scoped:
 *
 * - it makes the reply callable on that turn and the reply is delivered;
 * - it loads no other member of the Subagent namespace;
 * - it writes no capability record, so it never manufactures a user grant;
 * - repeated receipts are idempotent: the active set and the transcript do not
 *   grow, and an already active reply tool is not reported as a failure.
 *
 * The explicit `manualTools` case lives in `cross-session-reply-manual.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, getCurrentTools, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { discoveryRecords, manualEnabledTools } from "../../src/capability/discovery-record.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** System messages of the branch that declared `name` to the model. */
function declarationsOf(session: AgentSession, name: string): number {
  return session.sessionManager.getBranch()
    .flatMap((entry) => (entry.type === "message" && entry.message.role === "system" ? [entry.message] : []))
    .flatMap((message) => message.toolsAdded ?? [])
    .filter((tool) => tool.name === name).length;
}

test("an external Main message activates msg_write for that turn only", { timeout: 40_000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "reply-activation-"));
  const agentDir = path.join(cwd, "agent");
  const socketRoot = path.join(cwd, "uds");
  await mkdir(agentDir);
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const previousSocketDir = process.env["PI_SUBAGENT_SOCKET_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  process.env["PI_SUBAGENT_SOCKET_DIR"] = socketRoot;
  const opened: AgentSession[] = [];
  try {
    // The socket root is resolved when the IPC platform module first loads, so
    // import the harness only after the test override is in place.
    const [{ default: harnessExtension }, directory] = await Promise.all([
      import("../../extensions/harness.ts"),
      import("../../src/subagent/session-directory.ts"),
    ]);
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    const faux = fauxProvider({ models: [{ id: "reply-activation-fixture" }] });
    runtime.registerNativeProvider(faux.provider);
    const model = faux.models[0]!;
    runtime.getAuth = async () => ({ auth: { apiKey: "offline-fixture" }, env: {} });
    runtime.hasConfiguredAuth = () => true;

    let replySent = false;
    let turn = deferred();
    let peerMain = "";
    const declaredAtTurn: string[][] = [];
    const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content, stopReason, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    runtime.streamSimple = (_model, context) => {
      declaredAtTurn.push(getCurrentTools(context.messages).map((tool) => tool.name));
      // The first request after the receipt is the reply; every later request is
      // a plain answer, so the peer's own triggered turn cannot loop.
      let reply: AssistantMessage;
      if (replySent) reply = assistant([{ type: "text", text: "done" }], "stop");
      else {
        replySent = true;
        reply = assistant([{
          type: "toolCall", id: "reply-1", name: "msg_write",
          arguments: { path: peerMain, content: "PEER_REPLY" },
        }], "toolUse");
      }
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: reply.stopReason as "stop" | "toolUse", message: reply });
      stream.end();
      const started = turn;
      turn = deferred();
      started.resolve();
      return stream;
    };

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
    });
    const load = async (name: string): Promise<AgentSession> => {
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [{ name, factory: harnessExtension }],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const created = (await createAgentSession({
        cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
      })).session;
      opened.push(created);
      return created;
    };

    const errors: unknown[] = [];
    const notices: string[] = [];
    const session = await load("reply-activation-receiver");
    const peer = await load("reply-activation-peer");
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.createContext().ui, notify: (text: string) => { notices.push(text); } },
      onError: (error) => errors.push(error),
    });
    await peer.bindExtensions({ onError: (error) => errors.push(error) });

    const live = await directory.liveSessions(socketRoot);
    const receiver = live.find((record) => record.sessionId === session.sessionId);
    const peerRecord = live.find((record) => record.sessionId === peer.sessionId);
    assert.ok(receiver, "the receiving session published its record");
    assert.ok(peerRecord, "the peer session published its record");
    peerMain = directory.sessionMainAddress(peerRecord);

    // The receipt must add exactly the reply tool, whatever the session started with.
    const namespace = ["subagent_create", "subagent_list", "subagent_stop", "capability"] as const;
    const baseline = new Set(session.getActiveToolNames());
    assert.ok(!baseline.has("msg_write"), "Main starts without the reply tool");

    const send = async (content: string): Promise<void> => {
      const started = turn.promise;
      await directory.sendToSessionEndpoint({
        sender: { sessionId: peerRecord.sessionId, uid: peerRecord.uid },
        target: receiver,
        content,
      });
      await started;
      await session.waitForIdle();
    };

    await send("peer ping");
    assert.ok(declaredAtTurn[0]!.includes("msg_write"),
      "the reply tool is declared when the triggered turn builds its loadout");
    assert.deepEqual(session.getActiveToolNames().filter((name) => !baseline.has(name)), ["msg_write"],
      "the receipt activated the reply tool and nothing else");
    for (const name of namespace) {
      if (baseline.has(name)) continue;
      assert.ok(!declaredAtTurn[0]!.includes(name), `${name} was not declared by the receipt`);
    }
    type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
    const replies = session.messages.filter((message): message is ToolResultMessage =>
      message.role === "toolResult" && message.toolName === "msg_write");
    assert.equal(replies.length, 1, "the model replied through msg_write");
    assert.equal(replies[0]!.isError, false, JSON.stringify(replies[0]!.content));
    assert.ok(peer.messages.some((message) => JSON.stringify(message).includes("PEER_REPLY")),
      "the reply reached the peer session's Main");

    // A receipt is not a user authorization: no capability record is written.
    assert.deepEqual(discoveryRecords(session.sessionManager.getBranch()), []);
    assert.deepEqual([...manualEnabledTools(session.sessionManager.getBranch())], []);

    // A second receipt changes nothing: same active set, no second declaration,
    // no record and no "unavailable" notice.
    const activeBefore = [...session.getActiveToolNames()].sort();
    const declarationsBefore = declarationsOf(session, "msg_write");
    await send("peer ping again");
    assert.deepEqual([...session.getActiveToolNames()].sort(), activeBefore);
    assert.equal(declarationsOf(session, "msg_write"), declarationsBefore,
      "a repeated receipt adds no second declaration");
    assert.deepEqual(discoveryRecords(session.sessionManager.getBranch()), []);
    assert.deepEqual(notices, [], "an already active reply tool is not reported unavailable");
    assert.deepEqual(errors, []);
  } finally {
    for (const target of opened) {
      try {
        await target.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        target.dispose();
      }
    }
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    if (previousSocketDir === undefined) delete process.env["PI_SUBAGENT_SOCKET_DIR"];
    else process.env["PI_SUBAGENT_SOCKET_DIR"] = previousSocketDir;
    await rm(cwd, { recursive: true, force: true });
  }
});
