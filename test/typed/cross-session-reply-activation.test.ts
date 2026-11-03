/**
 * A cross-session message loads the reply tool.
 *
 * Main starts without `msg_write`. When a peer session addresses this Main, the
 * receiving host activates `msg_write` before the triggered turn builds its
 * tool loadout, so the model can answer without a Capability discovery round.
 * The activation is receipt-scoped: it writes no capability record and does not
 * load the rest of the Subagent namespace.
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
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("an external Main message activates msg_write before the turn", { timeout: 20_000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "reply-activation-"));
  const agentDir = path.join(cwd, "agent");
  const socketRoot = path.join(cwd, "uds");
  await mkdir(agentDir);
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const previousSocketDir = process.env["PI_SUBAGENT_SOCKET_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  process.env["PI_SUBAGENT_SOCKET_DIR"] = socketRoot;
  const errors: unknown[] = [];
  let session: AgentSession | undefined;
  try {
    // The socket root is resolved when the IPC platform module first loads, so
    // import the harness only after the test override is in place.
    const [{ default: harnessExtension }, { liveSessions, registerSession, sendToSessionEndpoint, unregisterSession }] =
      await Promise.all([
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
    const turnStarted = deferred();
    let activeAtTurn: readonly string[] = [];
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
      extensionFactories: [{ name: "reply-activation-fixture", factory: harnessExtension }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    session = (await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    })).session;
    await session.bindExtensions({ onError: (error) => errors.push(error) });

    assert.ok(!session.getActiveToolNames().includes("msg_write"), "Main starts without the reply tool");
    const receiver = (await liveSessions(socketRoot)).find((record) => record.sessionId === session!.sessionId);
    assert.ok(receiver, "the root published its session record");
    const peer = await registerSession(socketRoot, { sessionId: "peer-session", cwd, name: "peer" });
    try {
      await sendToSessionEndpoint({
        sender: { sessionId: peer.sessionId, uid: peer.uid },
        target: receiver,
        content: "peer ping",
      });
      await turnStarted.promise;
      assert.ok(activeAtTurn.includes("msg_write"), "the reply tool is active when the triggered turn builds its loadout");
      assert.ok(session.getActiveToolNames().includes("msg_write"));
      assert.deepEqual(errors, []);
    } finally {
      await unregisterSession(socketRoot, peer.sessionId);
    }
  } finally {
    try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
    finally {
      session?.dispose();
      if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
      if (previousSocketDir === undefined) delete process.env["PI_SUBAGENT_SOCKET_DIR"];
      else process.env["PI_SUBAGENT_SOCKET_DIR"] = previousSocketDir;
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
