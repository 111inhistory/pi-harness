/**
 * Receipt activation respects a manual reply tool.
 *
 * When `msg_write` is configured as manual, a peer message must not grant it.
 * If the branch already authorizes it, the active set is authoritative and the
 * receipt must not report a false `manual_only` failure; if it is not
 * authorized, the tool stays inactive and the receipt reports the refusal
 * without writing a capability record.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { appendManualRecord, CAPABILITY_DISCOVERY_RECORD } from "../../src/capability/discovery-record.ts";

const cwd = await mkdtemp(path.join(tmpdir(), "reply-manual-"));
const agentDir = path.join(cwd, "agent");
const socketRoot = path.join(cwd, "uds");
await mkdir(agentDir, { recursive: true });
await writeFile(path.join(agentDir, "harness.json"), JSON.stringify({ capability: { manualTools: ["msg_write"] } }));
const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
const previousSocketDir = process.env["PI_SUBAGENT_SOCKET_DIR"];
process.env["PI_CODING_AGENT_DIR"] = agentDir;
process.env["PI_SUBAGENT_SOCKET_DIR"] = socketRoot;
after(async () => {
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  if (previousSocketDir === undefined) delete process.env["PI_SUBAGENT_SOCKET_DIR"];
  else process.env["PI_SUBAGENT_SOCKET_DIR"] = previousSocketDir;
  await rm(cwd, { recursive: true, force: true });
});

// The socket root is resolved when the IPC platform module first loads, so the
// harness import must follow the test override.
const [{ default: harnessExtension }, { liveSessions, registerSession, sendToSessionEndpoint, unregisterSession }] =
  await Promise.all([
    import("../../extensions/harness.ts"),
    import("../../src/subagent/session-directory.ts"),
  ]);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Started {
  readonly session: AgentSession;
  readonly notices: string[];
  readonly errors: unknown[];
  readonly turnStarted: Promise<void>;
  activeAtTurn(): readonly string[];
}

async function startSession(): Promise<Started> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: "reply-manual-fixture" }] });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.models[0]!;
  runtime.getAuth = async () => ({ auth: { apiKey: "offline-fixture" }, env: {} });
  runtime.hasConfiguredAuth = () => true;
  const turnStarted = deferred();
  let activeAtTurn: readonly string[] = [];
  let session: AgentSession | undefined;
  runtime.streamSimple = () => {
    activeAtTurn = session?.getActiveToolNames() ?? [];
    const stream = new AssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "text", text: "received" }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    turnStarted.resolve();
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
    return stream;
  };
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: "reply-manual-fixture", factory: harnessExtension }],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  session = (await createAgentSession({
    cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  })).session;
  const notices: string[] = [];
  const errors: unknown[] = [];
  await session.bindExtensions({
    uiContext: { ...session.extensionRunner.createContext().ui, notify: (text: string) => { notices.push(text); } },
    onError: (error) => errors.push(error),
  });
  return { session, notices, errors, turnStarted: turnStarted.promise, activeAtTurn: () => activeAtTurn };
}

async function deliver(session: AgentSession, content: string, turn: Promise<void>): Promise<void> {
  const receiver = (await liveSessions(socketRoot)).find((record) => record.sessionId === session.sessionId);
  assert.ok(receiver, "the root published its session record");
  const peer = await registerSession(socketRoot, { sessionId: `peer-${crypto.randomUUID()}`, cwd, name: "peer" });
  try {
    await sendToSessionEndpoint({
      sender: { sessionId: peer.sessionId, uid: peer.uid },
      target: receiver,
      content,
    });
    await turn;
  } finally {
    await unregisterSession(socketRoot, peer.sessionId);
  }
}

test("an authorized manual reply tool is not reported unavailable", { timeout: 20_000 }, async () => {
  const started = await startSession();
  const { session } = started;
  try {
    assert.ok(!session.getActiveToolNames().includes("msg_write"), "manual tool starts inactive");
    // Test fixture, not a production path: seed the active tool and the branch's
    // `manual` record that the retired user command used to write.
    appendManualRecord(
      { appendEntry: (customType, data) => { session.sessionManager.appendCustomEntry(customType, data); } },
      [{ ref: "tool://msg_write", name: "msg_write", kind: "tool", status: "available" }],
    );
    session.setActiveToolsByName([...session.getActiveToolNames(), "msg_write"]);
    assert.ok(session.getActiveToolNames().includes("msg_write"), "the reply tool is authorized and active");
    started.notices.length = 0;

    await deliver(session, "peer ping", started.turnStarted);
    assert.ok(started.activeAtTurn().includes("msg_write"), "the enabled tool remains active for the turn");
    assert.deepEqual(started.notices, [], "an already active tool is not reported unavailable");
    assert.deepEqual(started.errors, []);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});

test("an ungranted manual reply tool is not activated by receipt", { timeout: 20_000 }, async () => {
  const started = await startSession();
  const { session } = started;
  try {
    assert.ok(!session.getActiveToolNames().includes("msg_write"), "manual tool starts inactive");
    await deliver(session, "peer ping", started.turnStarted);
    assert.ok(!started.activeAtTurn().includes("msg_write"), "receipt does not activate the manual tool");
    assert.ok(!session.getActiveToolNames().includes("msg_write"));
    assert.deepEqual(started.notices, ["The cross-session reply tool is unavailable: manual_only."]);
    assert.deepEqual(started.errors, []);
    const records = session.sessionManager.getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === CAPABILITY_DISCOVERY_RECORD);
    assert.ok(!JSON.stringify(records).includes("msg_write"), "receipt writes no grant record");
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});
