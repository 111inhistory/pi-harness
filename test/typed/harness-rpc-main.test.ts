/**
 * Real-SDK / real-socket acceptance for Main controls through the session host.
 *
 * The embedding runtime is a real AgentSessionRuntime and its replacement
 * callback is the normal public SDK rebind hook. The production Host extension
 * is installed in every replacement factory, while Main business state remains
 * in the production SdkMainControls and the production Harness RPC endpoint.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fauxProvider, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime,
  SessionManager, SettingsManager, type AgentSessionRuntime, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import harnessExtension from "../../extensions/harness.ts";
import { harnessRpcTarget } from "../../src/harness-rpc/discovery.ts";
import { DEFAULT_SOCKET_DIR } from "../../src/ipc/socket.ts";
import { createHarnessSessionHost, type HarnessSessionHost } from "../../src/session/host.ts";
import shellPreflightExtension from "../../src/shell-approval/extension.ts";
import { liveSessions } from "../../src/subagent/session-directory.ts";
import { deferred, waitFor } from "../../test-support/async.ts";

const harnessEntryPath = fileURLToPath(new URL("../../extensions/harness.ts", import.meta.url));

type JsonObject = Record<string, unknown>;

const asRecord = (value: unknown): JsonObject | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;

function asString(value: unknown): string {
  if (typeof value !== "string") assert.fail("expected a string");
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

/** Minimal wire client: request correlation and subscription events on one socket. */
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

interface MainHostFixture {
  readonly cwd: string;
  readonly socketDir: string;
  readonly host: HarnessSessionHost;
  readonly runtime: AgentSessionRuntime;
  readonly client: RpcClient;
  readonly extensionErrors: unknown[];
  cancelReplacement(value: boolean): void;
  holdSwitch(): { entered: Promise<void>; release(): void };
  releaseProvider(): void;
  close(): Promise<void>;
}

interface StartMainHostOptions {
  readonly failDiscovery?: boolean;
  readonly nativeEntry?: boolean;
}

async function startMainHost(t: test.TestContext, options: StartMainHostOptions = {}): Promise<MainHostFixture> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-rpc-main-"));
  const agentDir = path.join(cwd, "agent");
  // RootService resolves the same module-level default root; setting the
  // environment after imports cannot retroactively change that constant.
  const socketDir = path.resolve(cwd, DEFAULT_SOCKET_DIR);
  await mkdir(agentDir, { recursive: true });
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  await mkdir(path.join(cwd, "sessions"), { recursive: true });

  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: "main-host-fixture", reasoning: true }] });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = faux.models[0];
  assert.ok(model);
  modelRuntime.getAuth = async () => ({ auth: { apiKey: "offline-fixture" }, env: {} });
  modelRuntime.hasConfiguredAuth = () => true;

  let cancelReplacement = false;
  let releaseProvider: (() => void) | undefined;
  let switchEntered: ReturnType<typeof deferred<void>> | undefined;
  let switchGate: ReturnType<typeof deferred<void>> | undefined;

  modelRuntime.streamSimple = (_model, _context, options) => {
    const stream = new AssistantMessageEventStream();
    let settled = false;
    const complete = (aborted: boolean): void => {
      if (settled) return;
      settled = true;
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: aborted ? [] : [{ type: "text", text: "done" }],
        stopReason: aborted ? "aborted" : "stop",
        ...(aborted ? { errorMessage: "aborted" } : {}),
        timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      if (aborted) stream.push({ type: "error", reason: "aborted", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      stream.end();
    };
    releaseProvider = () => complete(false);
    options?.signal?.addEventListener("abort", () => complete(true), { once: true });
    return stream;
  };

  const host = createHarnessSessionHost();
  const extensionErrors: unknown[] = [];
  const testExtension = {
    name: "main-host-test",
    factory(api: ExtensionAPI) {
      api.registerCommand("handled", { description: "Consume input without a run", handler: async () => {} });
      api.on("session_before_switch", async () => {
        switchEntered?.resolve();
        switchEntered = undefined;
        if (switchGate !== undefined) await switchGate.promise;
        return cancelReplacement ? { cancel: true } : undefined;
      });
    },
  };
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off",
  });

  const createRuntime: Parameters<typeof createAgentSessionRuntime>[0] = async ({
    cwd: targetCwd, sessionManager, sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd: targetCwd, agentDir, modelRuntime, settingsManager,
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
        ...(options.nativeEntry === true
          ? { additionalExtensionPaths: [harnessEntryPath] }
          : {}),
        extensionFactories: [
          // The host bridge must be registered before the Harness session starts
          // looking it up during the session_start hook.
          host.extension,
          { name: "shell-preflight", factory: shellPreflightExtension },
          ...(options.nativeEntry === true
            ? []
            : [{ name: "harness-session", factory: harnessExtension }]),
          testExtension,
        ],
      },
    });
    return {
      ...await createAgentSessionFromServices({
        services, sessionManager, model,
        ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
      }),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd, agentDir, sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
  });
  const discoveryTarget = harnessRpcTarget(socketDir, runtime.session.sessionId);
  if (options.failDiscovery === true) {
    // A directory at the discovery-record path makes publication fail after the
    // real SDK session has bound the host. Create the private session directory
    // first so endpoint binding succeeds and only discovery publication fails.
    await mkdir(discoveryTarget.socketDir, { recursive: true, mode: 0o700 });
    await mkdir(discoveryTarget.recordPath, { recursive: true, mode: 0o700 });
  }
  // The embedding host binds its SDK runtime before the first extension bind.
  host.bindRuntime(runtime);
  // The SDK owns replacement; this callback only rebinds the replacement's
  // extensions. The Harness host synchronizes its Root lease through session_start.
  runtime.setRebindSession(async (next) => {
    await next.bindExtensions({ mode: "rpc", onError: (error) => extensionErrors.push(error) });
  });
  await runtime.session.bindExtensions({ mode: "rpc", onError: (error) => extensionErrors.push(error) });
  if (options.failDiscovery === true) {
    await assert.rejects(host.ready(), /Harness RPC/);
    const failed = host.status();
    assert.equal(failed.enabled, true);
    assert.equal(failed.available, false);
    assert.ok(failed.error);
  } else {
    assert.deepEqual(extensionErrors, []);
  }

  let client: RpcClient | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    releaseProvider?.();
    releaseProvider = undefined;
    switchGate?.resolve();
    switchGate = undefined;
    client?.close();
    try { await runtime.dispose(); }
    catch { /* retirement is best effort */ }
    await host.dispose();
  };
  const cleanup = async (): Promise<void> => {
    await close();
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  };
  t.after(cleanup);

  try {
    if (options.failDiscovery !== true) await host.ready();
    const status = host.status();
    assert.equal(status.enabled, true);
    assert.equal(status.available, options.failDiscovery !== true);
    assert.ok(status.address);
    if (options.failDiscovery !== true) {
      await waitFor(() => existsSync(harnessRpcTarget(socketDir, runtime.session.sessionId).recordPath), {
        label: "Main host discovery record",
      });
    }
    client = await RpcClient.connect(status.address);
    return {
      cwd, socketDir, host, runtime, client, extensionErrors,
      cancelReplacement: (value) => { cancelReplacement = value; },
      holdSwitch: () => {
        const entered = deferred<void>();
        const gate = deferred<void>();
        switchEntered = entered;
        switchGate = gate;
        return {
          entered: entered.promise,
          release: () => {
            if (switchGate === gate) switchGate = undefined;
            gate.resolve();
          },
        };
      },
      releaseProvider: () => { releaseProvider?.(); releaseProvider = undefined; },
      close,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function mainState(result: unknown): {
  generation: number;
  sessionId: string;
  sessionFile: string | null;
  leafId: string | null;
  idle: boolean;
} {
  const state = asRecord(result);
  const session = asRecord(state?.["session"]);
  assert.ok(state);
  assert.ok(session);
  return {
    generation: Number(state["generation"]),
    sessionId: asString(session["sessionId"]),
    sessionFile: typeof session["sessionFile"] === "string" ? session["sessionFile"] : null,
    leafId: typeof session["leafId"] === "string" ? session["leafId"] : null,
    idle: session["idle"] === true,
  };
}

function subscriptionOf(result: unknown): string {
  return asString(asRecord(result)?.["subscription"]);
}

function mainEventFor(events: unknown[], rootSessionId: string, type: string): boolean {
  return events.some((value) => {
    const payload = asRecord(value);
    const event = asRecord(payload?.["event"]);
    return payload?.["kind"] === "main"
      && payload["rootSessionId"] === rootSessionId
      && event?.["type"] === type;
  });
}

test("Main input admission, control interrupt and cleanup use the real SDK host", { timeout: 20000 }, async (t) => {
  const fx = await startMainHost(t);
  const initial = mainState(await fx.client.request("main.state"));
  assert.equal(initial.idle, true);
  assert.equal(fx.runtime.session.sessionId, initial.sessionId);

  const started = new Promise<void>((resolve) => {
    const previous = fx.runtime.session;
    const subscription = previous.subscribe((event) => {
      if (event.type === "agent_start") {
        subscription();
        resolve();
      }
    });
  });

  const admission = asRecord(await fx.client.request("main.input", { text: "hold the model" }));
  assert.equal(admission?.["disposition"], "started");
  assert.equal(admission?.["sessionId"], initial.sessionId);
  await started;
  assert.equal(mainState(await fx.client.request("main.state")).idle, false);

  // Interrupt is control admission: it must answer while the model stream is held.
  const interrupted = asRecord(await fx.client.request("main.interrupt"));
  assert.equal(interrupted?.["requested"], true);
  await waitFor(async () => mainState(await fx.client.request("main.state")).idle, {
    label: "Main idle after interrupt",
  });
  const current = mainState(await fx.client.request("main.state"));
  assert.equal(current.sessionId, initial.sessionId);

  await fx.close();
  assert.equal(fx.host.status().available, false);
  await assert.rejects(
    access(harnessRpcTarget(fx.socketDir, initial.sessionId).recordPath),
    "host cleanup removes the discovery record",
  );
});

test("Main subscriptions follow a real new session while stale Root observers are released", { timeout: 20000 }, async (t) => {
  const fx = await startMainHost(t);
  const initial = mainState(await fx.client.request("main.state"));
  const address = fx.host.status().address;
  assert.ok(address);
  const mainSubscription = subscriptionOf(await fx.client.request("main.subscribe"));
  const approvalsSubscription = subscriptionOf(await fx.client.request("approvals.subscribe"));
  const initialRecord = harnessRpcTarget(fx.socketDir, initial.sessionId).recordPath;
  await waitFor(() => existsSync(initialRecord), { label: "initial Main discovery record" });

  const outcome = asRecord(await fx.client.request("main.new"));
  assert.equal(outcome?.["cancelled"], false);
  const next = mainState(await fx.client.request("main.state"));
  assert.notEqual(next.sessionId, initial.sessionId);
  assert.equal(next.generation, initial.generation + 1);
  assert.equal(fx.host.status().address, address);
  assert.equal(fx.runtime.session.sessionId, next.sessionId);
  assert.equal(asRecord(await fx.client.request("harness.info"))?.["sessionId"], next.sessionId);
  await assert.rejects(
    access(initialRecord),
    "the previous Root's discovery record is removed",
  );
  await waitFor(() => existsSync(harnessRpcTarget(fx.socketDir, next.sessionId).recordPath), {
    label: "new Root discovery record",
  });
  assert.deepEqual(fx.extensionErrors, []);

  // The host-scoped Main observer was rebound to the replacement SDK session.
  fx.runtime.session.setThinkingLevel("low");
  await waitFor(() => mainEventFor(fx.client.events, next.sessionId, "thinking_level_changed"), {
    label: "Main event from the replacement session",
  });

  assert.equal(asRecord(await fx.client.request("stream.unsubscribe", { subscription: mainSubscription }))?.["removed"], true);
  assert.equal(asRecord(await fx.client.request("stream.unsubscribe", { subscription: approvalsSubscription }))?.["removed"], false);

  const nextRecord = harnessRpcTarget(fx.socketDir, next.sessionId).recordPath;
  await fx.close();
  await assert.rejects(
    access(nextRecord),
    "host cleanup removes the current discovery record",
  );
});

test("cancelled navigation keeps the bound Root and reopens its subscriptions", { timeout: 20000 }, async (t) => {
  const fx = await startMainHost(t);
  const initial = mainState(await fx.client.request("main.state"));
  const address = fx.host.status().address;
  assert.ok(address);
  const mainSubscription = subscriptionOf(await fx.client.request("main.subscribe"));
  const approvalsSubscription = subscriptionOf(await fx.client.request("approvals.subscribe"));

  fx.cancelReplacement(true);
  const outcome = asRecord(await fx.client.request("main.new"));
  assert.equal(outcome?.["cancelled"], true);
  const restored = mainState(await fx.client.request("main.state"));
  assert.equal(restored.sessionId, initial.sessionId);
  assert.ok(restored.generation >= initial.generation);
  assert.equal(fx.host.status().address, address);
  assert.deepEqual(fx.extensionErrors, []);

  // The canceled transition suspended the old Root scope; both the host Main
  // observer and the newly recovered Root remain usable without a new endpoint.
  const handled = asRecord(await fx.client.request("main.input", { text: "/handled" }));
  assert.equal(handled?.["disposition"], "handled");
  assert.equal(asRecord(await fx.client.request("stream.unsubscribe", { subscription: mainSubscription }))?.["removed"], true);
  assert.equal(asRecord(await fx.client.request("stream.unsubscribe", { subscription: approvalsSubscription }))?.["removed"], false);

  await fx.close();
  await assert.rejects(
    access(harnessRpcTarget(fx.socketDir, initial.sessionId).recordPath),
    "host cleanup removes the restored discovery record",
  );
});

test("Main switch, fork, navigate and reload exercise the bound SDK runtime", { timeout: 20000 }, async (t) => {
  const fx = await startMainHost(t);
  const anchor = fx.runtime.session.sessionManager.appendMessage({
    role: "user", content: "Main fork and navigate anchor", timestamp: Date.now(),
  });
  const initial = mainState(await fx.client.request("main.state"));
  assert.ok(initial.sessionFile);
  assert.equal(fx.runtime.session.sessionManager.getLeafId(), anchor);
  const address = fx.host.status().address;
  assert.ok(address);

  // Unknown navigation/replacement fields must be ignored, not forwarded to
  // the public SDK options object.
  const created = asRecord(await fx.client.request("main.new", {
    setup: { marker: "must-not-run" },
    cwd: path.join(fx.cwd, "ignored-cwd"),
    unknown: { nested: true },
  }));
  assert.equal(created?.["cancelled"], false);
  const afterNew = mainState(await fx.client.request("main.state"));
  assert.notEqual(afterNew.sessionId, initial.sessionId);
  assert.equal(fx.runtime.cwd, fx.cwd, "unknown cwd must not replace the runtime cwd");
  assert.equal(fx.host.status().address, address);
  assert.ok(afterNew.sessionFile === null || afterNew.sessionFile !== initial.sessionFile);

  const switched = asRecord(await fx.client.request("main.switch", {
    sessionPath: initial.sessionFile,
    unknown: { nested: true },
  }));
  assert.equal(switched?.["cancelled"], false);
  const afterSwitch = mainState(await fx.client.request("main.state"));
  assert.equal(afterSwitch.sessionId, initial.sessionId);
  assert.equal(afterSwitch.sessionFile, initial.sessionFile);
  assert.equal(fx.runtime.session.sessionManager.getEntry(anchor)?.id, anchor);

  const forked = asRecord(await fx.client.request("main.fork", {
    entryId: anchor,
    position: "at",
    unknown: { nested: true },
  }));
  assert.equal(forked?.["cancelled"], false);
  const afterFork = mainState(await fx.client.request("main.state"));
  assert.notEqual(afterFork.sessionId, initial.sessionId);
  assert.ok(afterFork.sessionFile);
  assert.equal(fx.runtime.session.sessionManager.getEntry(anchor)?.id, anchor);

  const later = fx.runtime.session.sessionManager.appendMessage({
    role: "user", content: "later user message", timestamp: Date.now() + 1,
  });
  assert.equal(fx.runtime.session.sessionManager.getLeafId(), later);
  const anchorParent = fx.runtime.session.sessionManager.getEntry(anchor)?.parentId ?? null;
  const navigated = asRecord(await fx.client.request("main.navigate", {
    targetId: anchor,
    summarize: false,
    unknown: { nested: true },
  }));
  assert.equal(navigated?.["cancelled"], false);
  assert.equal(navigated?.["editorText"], "Main fork and navigate anchor");
  const afterNavigate = mainState(await fx.client.request("main.state"));
  assert.equal(afterNavigate.sessionId, afterFork.sessionId);
  assert.equal(afterNavigate.leafId, anchorParent);
  assert.equal(fx.host.status().address, address);

  const reloaded = asRecord(await fx.client.request("main.reload"));
  assert.equal(reloaded?.["requested"], true);
  const afterReload = mainState(await fx.client.request("main.state"));
  assert.equal(afterReload.sessionId, afterFork.sessionId);
  assert.equal(afterReload.sessionFile, afterFork.sessionFile);
  assert.equal(fx.host.status().address, address);
  assert.deepEqual(fx.extensionErrors, []);

  await fx.close();
});

test("the actual file entry preserves a Jiti-domain SubagentError across the ESM host", { timeout: 20000 }, async (t) => {
  const fx = await startMainHost(t, { nativeEntry: true });
  const state = mainState(await fx.client.request("main.state"));
  assert.equal(fx.runtime.session.sessionId, state.sessionId);

  // The native file entry is loaded through the SDK's Jiti loader with
  // moduleCache:false, while host.extension and the assembly remain ESM. A
  // missing routing config makes the child-start failure originate as the
  // Jiti graph's SubagentError. Its code and registered/failures detail must
  // survive the RPC adapter instead of degrading to "internal".
  const failure = await fx.client.request("subagent.create", {
    tasks: [{ task: "native entry error boundary" }],
  }).then(
    () => assert.fail("subagent.create unexpectedly succeeded"),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof RpcFailure, "the endpoint returned an RPC error");
  assert.equal(failure.code, "start_failed", `RPC returned ${failure.code}: ${failure.message}`);
  const detail = asRecord(failure.detail);
  assert.ok(detail, "SubagentError.detail was preserved");
  assert.equal(asArray(detail["registered"]).length, 1);
  assert.equal(asArray(detail["failures"]).length, 1);
  assert.equal(asRecord(asArray(detail["failures"])[0])?.["code"], "session_unavailable");

  await fx.close();
});

test("discovery publication failure is latched and shutdown still retires Root/main resources", { timeout: 20000 }, async (t) => {
  const fx = await startMainHost(t, { failDiscovery: true });
  const failed = fx.host.status();
  assert.equal(failed.enabled, true);
  assert.equal(failed.available, false);
  assert.ok(failed.error);
  assert.ok(fx.extensionErrors.length > 0, "the real SDK bind reports the publication failure");

  const state = mainState(await fx.client.request("main.state"));
  const recordPath = harnessRpcTarget(fx.socketDir, state.sessionId).recordPath;
  t.after(async () => {
    await rm(recordPath, { recursive: true, force: true });
    // A failed publish leaves the private temporary file beside the target.
    await rm(`${recordPath}.tmp-${process.pid}`, { recursive: true, force: true });
  });
  const published = await liveSessions(fx.socketDir);
  assert.ok(published.some((session) => session.sessionId === state.sessionId), "the Root/main session record was published");

  // The host owns the endpoint and Main controls, but not the SDK Root domain.
  // Dispose the host first: this must resolve even after failed publication.
  await fx.host.dispose();
  const afterHostDispose = await liveSessions(fx.socketDir);
  assert.ok(afterHostDispose.some((session) => session.sessionId === state.sessionId),
    "the Root domain is still alive until the SDK runtime shuts down");

  await fx.runtime.dispose();
  await waitFor(async () => {
    const remaining = await liveSessions(fx.socketDir);
    return !remaining.some((session) => session.sessionId === state.sessionId);
  }, { label: "Root/session retirement after runtime disposal" });
  await fx.close();
});

test("a host Main observer can be unsubscribed while the Root binding is suspended", { timeout: 20000 }, async (t) => {
  const fx = await startMainHost(t);
  const initial = mainState(await fx.client.request("main.state"));
  const address = fx.host.status().address;
  assert.ok(address);
  const mainSubscription = subscriptionOf(await fx.client.request("main.subscribe"));

  fx.cancelReplacement(true);
  const held = fx.holdSwitch();
  const navigation = fx.client.request("main.new");
  await held.entered;
  // The Host has suspended the Root slot before the cancel handler returns, so
  // Router deps.sessionId and deps.stream are unavailable here. The wire
  // unsubscribe must still act only on this connection.
  const unsubscribed = asRecord(await fx.client.request("stream.unsubscribe", { subscription: mainSubscription }));
  assert.equal(unsubscribed?.["removed"], true);
  held.release();
  const outcome = asRecord(await navigation);
  assert.equal(outcome?.["cancelled"], true);

  const restored = mainState(await fx.client.request("main.state"));
  assert.equal(restored.sessionId, initial.sessionId);
  assert.equal(fx.host.status().address, address);

  await fx.close();
});
