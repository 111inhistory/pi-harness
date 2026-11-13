/**
 * Real-SDK / real-socket acceptance for the application RPC group.
 *
 * The fixture boots a real Pi `AgentSession`, the production Harness session
 * assembly, the production Shell approval extension and the production Harness
 * RPC endpoint. Business state is inspected on the same session and approval
 * controller that the endpoint serves; no fake port or command handler decides
 * the outcome for the test.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { harnessRpcTarget } from "../../src/harness-rpc/discovery.ts";
import { PRESET_STATE_RECORD } from "../../src/preset/state.ts";
import { installHarnessSession } from "../../src/session/application.ts";
import shellPreflightExtension, { shellApprovalController } from "../../src/shell-approval/extension.ts";
import type { ShellApprovalController } from "../../src/shell-approval/types.ts";
import { installRootSubagentSurface, type RootSubagentAccess } from "../../src/subagent/extension.ts";
import { registerSession, sessionMainAddress, unregisterSession } from "../../src/subagent/session-directory.ts";
import type { RootService } from "../../src/subagent/root-service.ts";
import { waitFor } from "../../test-support/async.ts";

type JsonObject = Record<string, unknown>;

const asRecord = (value: unknown): JsonObject | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;

function asString(value: unknown): string {
  assert.equal(typeof value, "string");
  return value;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

class RpcFailure extends Error {
  readonly code: string;
  readonly detail: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "RpcFailure";
    this.code = code;
    this.detail = detail;
  }
}

/** Minimal wire client: requests and subscription events on one real socket. */
class RpcClient {
  readonly events: unknown[] = [];
  readonly #socket: net.Socket;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #buffer = "";
  #nextId = 1;
  #closed = false;

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#onData(chunk));
    socket.on("error", (error) => this.#abort(error));
    socket.on("close", () => this.#abort(new Error("Harness RPC client closed.")));
  }

  static async connect(address: string): Promise<RpcClient> {
    const socket = net.connect(address);
    await new Promise<void>((resolve, reject) => {
      const connected = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => {
        socket.off("connect", connected);
        socket.off("error", failed);
      };
      socket.once("connect", connected);
      socket.once("error", failed);
    });
    return new RpcClient(socket);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Harness RPC client is closed."));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#abort(new Error("Harness RPC client closed."));
    this.#socket.destroy();
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      const frame = asRecord(JSON.parse(line));
      assert.ok(frame, "the endpoint writes JSON objects");
      const eventValue = frame["event"];
      if (eventValue !== undefined) {
        const event = asRecord(eventValue);
        assert.ok(event, "subscription frames carry an object event");
        this.events.push(event["payload"]);
        continue;
      }
      const id = frame["id"];
      if (typeof id !== "number") continue;
      const pending = this.#pending.get(id);
      if (pending === undefined) continue;
      this.#pending.delete(id);
      if (frame["ok"] === true) pending.resolve(frame["result"]);
      else {
        const error = asRecord(frame["error"]) ?? {};
        pending.reject(new RpcFailure(
          asString(error["code"] ?? "internal"),
          asString(error["message"] ?? "Harness RPC request failed."),
          error["detail"],
        ));
      }
    }
  }

  #abort(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

interface ApplicationFixture {
  readonly cwd: string;
  readonly session: AgentSession;
  readonly root: RootService;
  readonly api: ExtensionAPI;
  readonly client: RpcClient;
  readonly controller: ShellApprovalController;
}

async function startApplication(t: test.TestContext): Promise<ApplicationFixture> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-rpc-application-"));
  const agentDir = path.join(cwd, "agent");
  const socketDir = path.join(cwd, "uds");
  await mkdir(agentDir, { recursive: true });
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(agentDir, "presets.json"), JSON.stringify({
    "rpc-apply": {
      tools: ["+read", "-write"],
      codemode: { mode: "only" },
      instructions: "RPC_PRESET_INSTRUCTION",
    },
  }));

  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const previousSocketDir = process.env["PI_SUBAGENT_SOCKET_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  process.env["PI_SUBAGENT_SOCKET_DIR"] = socketDir;

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: "app-rpc-fixture", reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.models[0];
  assert.ok(model);
  runtime.getAuth = async () => ({ auth: { apiKey: "offline-fixture" }, env: {} });
  runtime.hasConfiguredAuth = () => true;

  let api!: ExtensionAPI;
  let access!: RootSubagentAccess;
  const extensionErrors: unknown[] = [];
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off",
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [
      { name: "shell-preflight", factory: shellPreflightExtension },
      { name: "harness-session", factory(pi) {
        api = pi;
        access = installHarnessSession(pi);
        installRootSubagentSurface(pi, access);
      } },
    ],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);

  let session: AgentSession | undefined;
  let client: RpcClient | undefined;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    client?.close();
    try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
    catch { /* retirement is best effort */ }
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    if (previousSocketDir === undefined) delete process.env["PI_SUBAGENT_SOCKET_DIR"];
    else process.env["PI_SUBAGENT_SOCKET_DIR"] = previousSocketDir;
    await rm(cwd, { recursive: true, force: true });
  };
  t.after(cleanup);

  try {
    const created = await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    session = created.session;
    // Bind the SDK extension runner in RPC mode before session_start so the
    // production assembly opens the Harness endpoint for this real session.
    await session.bindExtensions({ mode: "rpc", onError: (error) => extensionErrors.push(error) });
    assert.deepEqual(extensionErrors, []);

    const context = session.extensionRunner.createCommandContext();
    const root = await access.current(context);
    const target = harnessRpcTarget(root.socketRoot, root.sessionId);
    await waitFor(() => existsSync(target.recordPath), { label: "application RPC discovery record" });
    client = await RpcClient.connect(target.address);
    const controller = shellApprovalController(api);
    assert.ok(controller, "the real Shell approval extension provides its controller");
    return { cwd, session, root, api, client, controller };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function presetEntries(session: AgentSession): JsonObject[] {
  return session.sessionManager.getBranch()
    .filter((entry): entry is Extract<typeof entry, { type: "custom" }> =>
      entry.type === "custom" && entry.customType === PRESET_STATE_RECORD)
    .map((entry) => asRecord(entry.data) ?? {});
}

test("preset RPC apply/clear records the same branch state and tool selection as the session", { timeout: 20000 }, async (t) => {
  const fixture = await startApplication(t);
  const catalog = asRecord(await fixture.client.request("presets.catalog"));
  assert.ok(catalog);
  const presets = asArray(catalog["presets"]).map(asRecord);
  assert.ok(presets.some((preset) => preset?.["name"] === "rpc-apply"));
  assert.deepEqual(catalog["warnings"], []);

  const applied = asRecord(await fixture.client.request("presets.apply", { name: "rpc-apply" }));
  assert.ok(applied);
  assert.equal(applied["applied"], true);
  assert.equal(applied["codemodeNotApplied"], false);
  assert.equal(asRecord(applied["snapshot"])?.["name"], "rpc-apply");
  assert.equal(fixture.session.getActiveToolNames().includes("read"), true);
  assert.equal(fixture.session.getActiveToolNames().includes("write"), false);

  const entries = presetEntries(fixture.session);
  assert.ok(entries.length >= 1);
  assert.equal(asRecord(entries.at(-1)?.["snapshot"])?.["name"], "rpc-apply");

  const current = asRecord(await fixture.client.request("presets.current"));
  assert.equal(asRecord(current?.["preset"])?.["name"], "rpc-apply");

  const cleared = asRecord(await fixture.client.request("presets.clear"));
  assert.deepEqual(cleared, { cleared: true, snapshot: null, codemodeCleared: true });
  assert.equal(fixture.session.getActiveToolNames().includes("read"), true,
    "clear does not roll back the selected tool set");
  assert.equal(fixture.session.getActiveToolNames().includes("write"), false,
    "clear does not resurrect a tool removed by the preset");
  const afterClear = asRecord(await fixture.client.request("presets.current"));
  assert.equal(afterClear?.["preset"], null);
  assert.equal(asRecord(presetEntries(fixture.session).at(-1)?.["snapshot"]), null);
});

test("approval RPC observes and decides the live controller; unsubscribe, timeout and dispose stay fail-closed", { timeout: 20000 }, async (t) => {
  const fixture = await startApplication(t);
  const subscribed = asRecord(await fixture.client.request("approvals.subscribe"));
  assert.ok(subscribed);
  const subscription = asString(subscribed["subscription"]);
  assert.deepEqual(subscribed["items"], []);

  const pending = fixture.controller.request({
    sourceAgent: "sub_fixture", shell: "bash", cwd: fixture.cwd,
    command: "printf approve", reason: "approval-rpc-fixture", timeoutSeconds: 30,
  });
  await waitFor(() => fixture.client.events.some((event) => {
    const value = asRecord(event);
    return value?.["kind"] === "approvals" && asArray(value["items"]).length === 1;
  }), { label: "approval subscription event" });

  const listed = asRecord(await fixture.client.request("approvals.list"));
  const items = asArray(listed?.["items"]).map(asRecord);
  const item = items[0];
  assert.ok(item);
  const id = asString(item["id"]);
  assert.equal(item["sourceAgent"], "sub_fixture");
  assert.equal(item["command"], "printf approve");
  assert.equal(asRecord(await fixture.client.request("approvals.get", { id }))?.["item"] !== null, true);

  const responded = asRecord(await fixture.client.request("approvals.respond", { id, decision: "allow" }));
  assert.deepEqual(responded, { accepted: true, decision: "allow" });
  assert.deepEqual(await pending, { approved: true, reason: "approved" });
  assert.deepEqual(asArray(asRecord(await fixture.client.request("approvals.list"))?.["items"]), []);

  const second = fixture.controller.request({
    sourceAgent: "sub_fixture", shell: "bash", cwd: fixture.cwd,
    command: "printf no-decision", reason: "unsubscribe-fixture", timeoutSeconds: 30,
  });
  await waitFor(() => fixture.controller.list().some((entry) => entry.command === "printf no-decision"), {
    label: "second pending approval",
  });
  const secondId = fixture.controller.list().find((entry) => entry.command === "printf no-decision")!.id;
  const unsubscribed = asRecord(await fixture.client.request("stream.unsubscribe", { subscription }));
  assert.equal(unsubscribed?.["removed"], true);
  assert.equal(fixture.controller.get(secondId)?.command, "printf no-decision",
    "removing the RPC observer does not settle or cancel the admitted approval");
  const secondResponse = asRecord(await fixture.client.request("approvals.respond", { id: secondId, decision: "allow" }));
  assert.deepEqual(secondResponse, { accepted: true, decision: "allow" });
  assert.deepEqual(await second, { approved: true, reason: "approved" });

  // The previous observation was intentionally removed. A new consumer is
  // required for a later request because the controller refuses to queue when
  // no presentation path exists; this keeps the timeout case about timeout.
  await fixture.client.request("approvals.subscribe");
  const timed = fixture.controller.request({
    sourceAgent: "sub_fixture", shell: "bash", cwd: fixture.cwd,
    command: "printf timeout", reason: "timeout-fixture", timeoutSeconds: 1,
  });
  await waitFor(() => fixture.controller.list().some((entry) => entry.command === "printf timeout"), {
    label: "timeout pending approval",
  });
  const timedId = fixture.controller.list().find((entry) => entry.command === "printf timeout")!.id;
  assert.deepEqual(await timed, { approved: false, reason: "timeout" });
  assert.deepEqual(asRecord(await fixture.client.request("approvals.respond", { id: timedId, decision: "allow" })),
    { accepted: false, reason: "not_pending" });

  fixture.controller.dispose();
  assert.deepEqual(asArray(asRecord(await fixture.client.request("approvals.list"))?.["items"]), []);
  assert.deepEqual(asRecord(await fixture.client.request("approvals.respond", { id: "approval-missing", decision: "allow" })),
    { accepted: false, reason: "disposed" });
});

test("session RPC lists published peers and connects by host-resolved identity only", { timeout: 20000 }, async (t) => {
  const fixture = await startApplication(t);
  const peer = await registerSession(fixture.root.socketRoot, {
    sessionId: "peer-application-rpc", cwd: fixture.cwd, name: "Peer fixture",
  });
  t.after(() => unregisterSession(fixture.root.socketRoot, peer.sessionId));

  const listed = asRecord(await fixture.client.request("sessions.list"));
  const sessions = asArray(listed?.["sessions"]).map(asRecord);
  assert.ok(sessions.some((session) => session?.["uid"] === peer.uid));
  assert.ok(sessions.some((session) => session?.["sessionId"] === fixture.root.sessionId));

  const connected = asRecord(await fixture.client.request("sessions.connect", {
    target: peer.uid,
    // Extra caller fields are not authority: the port must use only target and
    // resolve the peer, address and grant through the host.
    sessionId: "caller-chosen-session",
    address: "/tmp/caller-chosen.sock",
    sourceAgent: "caller-chosen-source",
  }));
  assert.ok(connected);
  assert.equal(asRecord(connected["session"])?.["uid"], peer.uid);
  assert.equal(connected["address"], sessionMainAddress(peer));
  assert.ok(asArray(connected["enabled"]).includes("msg_write")
    || asArray(connected["alreadyEnabled"]).includes("msg_write"));
  const contacts = fixture.session.sessionManager.getBranch()
    .filter((entry): entry is Extract<typeof entry, { type: "custom_message" }> => entry.type === "custom_message")
    .filter((entry) => entry.customType === "subagent-session-contact");
  assert.ok(contacts.some((entry) => JSON.stringify(entry).includes(sessionMainAddress(peer))),
    "the host appends the resolved contact message to the live branch");

  await assert.rejects(
    fixture.client.request("sessions.connect", { target: fixture.root.sessionId }),
    (error: unknown) => error instanceof RpcFailure && error.code === "invalid_target",
  );
  await assert.rejects(
    fixture.client.request("sessions.connect", { target: "missing-session" }),
    (error: unknown) => error instanceof RpcFailure && error.code === "session_not_found",
  );
});
