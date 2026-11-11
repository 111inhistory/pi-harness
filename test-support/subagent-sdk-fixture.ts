// Executed in a disposable child process: short IDs, sockets and relative history
// paths must never touch the developer's live session or workspace.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type {
  AgentSession, AgentToolResult, ExtensionError, ExtensionUIContext, InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type {
  Api, AssistantMessage, ClassifierAnswer, Context, JsonObject, Message, Model, StopReason,
} from "@earendil-works/pi-ai";
import subagentExtension from "../src/subagent/extension.ts";
import { installResultRendering } from "../src/result-rendering.ts";
import capabilityExtension from "../src/capability/extension.ts";
import { deriveSessionUid } from "../src/ipc/socket.ts";
import {
  actorOf, createdItems, readTranscriptEvents,
  type FixtureActor, type FixtureChat, type FixtureClassification, type FixtureControls,
  type FixtureGate, type FixtureToolResult, type FixtureTranscriptEvent, type ScenarioFixture,
} from "../test/typed/support/subagent-sdk-fixture.ts";
import { deferred, waitFor } from "./async.ts";

interface FixtureRoutingRole {
  readonly id?: string;
  instructions?: string;
  excludeTools?: string[];
  enableTools?: string[];
  readonly [key: string]: unknown;
}

interface FixtureRoutingModel {
  provider?: string;
  model?: string;
  readonly [key: string]: unknown;
}

interface FixtureRoutingConfig {
  readonly version?: number;
  readonly classifier?: unknown;
  readonly instructions?: unknown;
  readonly roles: FixtureRoutingRole[];
  readonly models: FixtureRoutingModel[];
  readonly [key: string]: unknown;
}

/** Options for building one real SDK root. */
export interface SdkFixtureOptions {
  readonly scenario: string;
  readonly durable?: boolean;
  readonly systemPrompt?: string;
  readonly config?: JsonObject;
  readonly routing?: (routing: FixtureRoutingConfig) => void;
}

type FixtureAssistant = (
  content: AssistantMessage["content"],
  stopReason?: StopReason,
  errorMessage?: string,
) => AssistantMessage;

/**
 * One real SDK root plus the scripted provider and native tool helpers.
 *
 * `close()` releases held model gates, awaits `session_shutdown` (root
 * retirement), disposes the SDK session, restores the process-wide patches and
 * reports cleanup failures. Use one fixture at a time; the network guards are
 * process globals.
 */
export interface SdkFixture extends ScenarioFixture {
  readonly model: Model<Api>;
  readonly assistant: FixtureAssistant;
  readonly durable: boolean;
  readonly childManagers: WeakRef<SessionManager>[];
  readonly resourceLoader: DefaultResourceLoader;
  readonly networkAttempts: string[];
  readonly uiErrors: Error[];
  readonly streamedFragments: number;
  call(name: string, params: JsonObject): Promise<FixtureToolResult<Record<string, unknown>>>;
  controlledGate(): FixtureGate;
  abortable(gate: FixtureGate, signal: AbortSignal | undefined): Promise<void>;
  listener(socketPath: string): Promise<net.Server>;
  events(file: string): Promise<FixtureTranscriptEvent[]>;
  releaseGates(): void;
  getExternalToolExecutions(): number;
  close(): Promise<void>;
}

interface ActiveHandleProcess {
  _getActiveHandles(): unknown[];
}

interface MutableSocketConnect {
  connect: (this: net.Socket, ...args: unknown[]) => net.Socket;
}

type FixtureSettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;
type FixtureSessionMessage = AgentSession["messages"][number];

function activeHandles(): unknown[] {
  return (process as NodeJS.Process & ActiveHandleProcess)._getActiveHandles();
}

function listeningServers(): net.Server[] {
  return activeHandles().filter(
    (handle): handle is net.Server => handle instanceof net.Server && handle.listening,
  );
}

function connectTarget(args: readonly unknown[]): unknown {
  const first = args[0];
  return Array.isArray(first) ? (first as unknown[])[0] : first;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireEnvDir(name: string, cwd: string): string {
  const value = process.env[name];
  assert.ok(value, `${name} must be set`);
  assert.ok(value.startsWith(cwd), `${name} must live under the disposable cwd`);
  return value;
}

function messageSource(message: FixtureSessionMessage): unknown {
  if (message.role !== "custom") return undefined;
  return recordOf(message.details)?.source;
}

function toolResultOf(result: AgentToolResult<unknown>): FixtureToolResult<Record<string, unknown>> {
  return {
    content: result.content,
    ...(result.details === undefined ? {} : { details: result.details as Record<string, unknown> }),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

/**
 * Build one real SDK root for native scenarios.
 *
 * `scenario` selects the scripted root, `durable` overrides whether it writes a
 * session file, and `systemPrompt` plus `routing(routing)` let callers pin
 * identity inputs on that same root.
 */
export async function createSdkFixture(options: SdkFixtureOptions): Promise<SdkFixture> {
  const scenario = options.scenario;
  assert.ok(typeof scenario === "string" && scenario.length > 0, "createSdkFixture requires a scenario name");
  if (options.durable !== undefined) assert.equal(typeof options.durable, "boolean", "durable must be a boolean");
  const cwd = process.cwd();
  const agentDir = requireEnvDir("PI_CODING_AGENT_DIR", cwd);
  const socketDir = requireEnvDir("PI_SUBAGENT_SOCKET_DIR", cwd);
  await fsp.mkdir(agentDir, { recursive: true });

  // Fail closed if a supposedly offline test accidentally uses credentials/network.
  const originalFetch = globalThis.fetch;
  const socketPrototype = net.Socket.prototype as unknown as MutableSocketConnect;
  const originalConnect = socketPrototype.connect;
  const originalSessionOpen = SessionManager.open;
  const restoreGlobals = (): void => {
    globalThis.fetch = originalFetch;
    socketPrototype.connect = originalConnect;
    SessionManager.open = originalSessionOpen;
  };
  const networkAttempts: string[] = [];
  globalThis.fetch = async (url) => {
    networkAttempts.push(String(url));
    throw new Error(`Network forbidden in SDK test: ${url}`);
  };
  socketPrototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
    const target = connectTarget(args);
    const targetPath = recordOf(target)?.path;
    if (!(typeof target === "string" || typeof targetPath === "string")) {
      networkAttempts.push("TCP connect");
      throw new Error("TCP network forbidden in SDK test");
    }
    return originalConnect.apply(this, args);
  };

  let session: AgentSession | null = null;
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const model = (scenario.startsWith("responses-") || scenario === "reviewer-sol") ? runtime.getModel("openai-codex", "gpt-6.1-sol") : runtime.getModel("google", "gemini-3.8-flash");
    assert.ok(model, "the installed Pi catalog must contain the offline fixture candidate");
    const fixtureModel: Model<Api> = model;
    // Isolated Pi user config: no dependency on the real user's routing file or
    // third-party Antigravity extension. All calls use the scripted runtime below.
    const routing = JSON.parse(await fsp.readFile(new URL("../config/subagent-routing.json", import.meta.url), "utf8")) as FixtureRoutingConfig;
    for (const candidate of routing.models) Object.assign(candidate, { provider: fixtureModel.provider, model: fixtureModel.id });
    options.routing?.(routing);
    await fsp.writeFile(path.join(agentDir, "subagent-routing.json"), JSON.stringify(routing));
    await fsp.writeFile(path.join(agentDir, "harness.json"), JSON.stringify(options.config ?? {}));
    const childManagers: WeakRef<SessionManager>[] = [];
    if (scenario === "memory-owners") SessionManager.open = (...args: Parameters<typeof originalSessionOpen>): SessionManager => {
      const manager = originalSessionOpen(...args);
      if (String(args[0]).includes("subagent-sessions")) childManagers.push(new WeakRef(manager));
      return manager;
    };
    const classifications: FixtureClassification[] = [];
    const chats: FixtureChat[] = [];
    // Automatic host notifications run through the actual root SDK too. Track
    // their requests separately so actor-count assertions do not mistake them for
    // another execution of the delegated task.
    const notificationChats: FixtureChat[] = [];
    let streamedFragments = 0;
    const controls: FixtureControls = { classify: null, chat: null };
    let externalToolExecutions = 0;
    const gates: FixtureGate[] = [];
    function controlledGate(): FixtureGate {
      const gate = deferred();
      gates.push(gate);
      return gate;
    }
    runtime.getAuth = async () => ({ auth: { apiKey: "offline-test-only" }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    runtime.classify = async (classifier, context, options) => {
      classifications.push({ context, options });
      if (controls.classify) await controls.classify(context, options);
      const key = Object.keys(context.questions)[0];
      if (key === undefined) throw new Error("A classification request must contain one question.");
      const question = context.questions[key];
      assert.ok(question, "A classification request must name a declared question.");
      const selected = key === "role" ? (scenario === "reviewer-sol" ? "reviewer" : scenario.startsWith("upstream-") ? "researcher" : "executor") : "gemini";
      const probabilities = Object.fromEntries(Object.keys(question.criteria).map((name) => [name, name === selected ? 1 : 0]));
      const answer: ClassifierAnswer = { type: "choice", choice: selected, probabilities, confidence: 1 };
      return { api: classifier.api, provider: classifier.provider, model: classifier.id, answers: {
        [key]: answer,
      }, stopReason: "stop", timestamp: Date.now() };
    };
    function assistant(content: AssistantMessage["content"], stopReason: StopReason = "stop", errorMessage?: string): AssistantMessage {
      return {
        role: "assistant", content, api: fixtureModel.api, provider: fixtureModel.provider, model: fixtureModel.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason, timestamp: Date.now(), ...(errorMessage === undefined ? {} : { errorMessage }),
      };
    }
    const textAnswer = (text: string): AssistantMessage => assistant([{ type: "text", text }]);
    const toolAnswer = (name: string, args: JsonObject, id = "local-tool-call"): AssistantMessage => assistant([{ type: "toolCall", id, name, arguments: args }], "toolUse");
    function textOf(context: Context): string {
      return context.messages.map((message: Message): string => message.role === "system" ? getSystemMessageText(message) :
        typeof message.content === "string" ? message.content :
          (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n")).join("\n");
    }
    runtime.streamSimple = (actualModel, context, options) => {
      assert.equal(actualModel.id, fixtureModel.id);
      assert.ok(options !== undefined, "streamSimple options are required by the fixture");
      const stream = new AssistantMessageEventStream();
      const call = { context, options, text: textOf(context) };
      const latest = options.sessionId === sessionManager.getSessionId()
        ? session?.messages.findLast((message) => message.role !== "system") : null;
      const afterAssistant = options.sessionId === sessionManager.getSessionId()
        ? (session?.messages.slice(session.messages.findLastIndex((message) => message.role === "assistant") + 1) ?? []) : [];
      const hasOrdinary = afterAssistant.some((message) => message.role === "custom" && message.customType === "agent-delivery" && messageSource(message) === "agent");
      const latestCustom = latest?.role === "custom" ? latest : null;
      const notice = !hasOrdinary && latestCustom !== null &&
        (latestCustom.customType === "agent-completion" || (latestCustom.customType === "agent-delivery" && messageSource(latestCustom) === "host")) &&
        !String(typeof latestCustom.content === "string" ? latestCustom.content : JSON.stringify(latestCustom.content)).includes("[Message from ");
      (notice ? notificationChats : chats).push(call);
      (async () => {
        try {
          const message = notice ? textAnswer("Root received the host task notification.") :
            controls.chat ? await controls.chat(call) : textAnswer("Local result. Difficulty: low — scripted offline response.");
          const text = message.content.find((block) => block.type === "text");
          if (text) {
            const startMessage: AssistantMessage = { ...message, content: [], stopReason: "pending" };
            stream.push({ type: "start", partial: startMessage });
            const split = Math.max(1, Math.floor(text.text.length / 2));
            for (const end of [split, text.text.length]) {
              const partial: AssistantMessage = { ...message, content: [{ type: "text", text: text.text.slice(0, end) }], stopReason: "pending" };
              stream.push({ type: "text_delta", contentIndex: 0, delta: text.text.slice(end === split ? 0 : split, end), partial });
              streamedFragments += 1;
            }
          }
          // Scripted replies may carry an error status. Preserve the fixture's
          // original done event; the SDK still observes the message stopReason.
          const doneReason = message.stopReason as Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
          stream.push({ type: "done", reason: doneReason, message });
          stream.end();
        } catch (error) {
          const aborted = options.signal?.aborted === true;
          stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: assistant([], aborted ? "aborted" : "error", error instanceof Error ? error.message : String(error)) });
          stream.end();
        }
      })();
      return stream;
    };
    function abortable(gate: FixtureGate, signal: AbortSignal | undefined): Promise<void> {
      if (signal?.aborted) return Promise.reject(new Error("cancelled local request"));
      return new Promise((resolve, reject) => {
        const abort = (): void => reject(new Error("cancelled local request"));
        signal?.addEventListener("abort", abort, { once: true });
        gate.promise.then(
          () => { signal?.removeEventListener("abort", abort); resolve(); },
          (error: unknown) => { signal?.removeEventListener("abort", abort); reject(error); },
        );
      });
    }

    const durable = options.durable ?? ["reload", "upstream-main-reload", "listener-cache", "revive", "history", "upstream-parent", "upstream-parent-steer", "stopping", "stop-history", "failure", "memory-owners", "restore-invalid"].includes(scenario);
    const sessionManager = durable ? SessionManager.create(cwd, path.join(cwd, "root-sessions")) : SessionManager.inMemory(cwd);
    if (durable) {
      sessionManager.appendMessage({ role: "user", content: "Root seed", timestamp: Date.now() });
      sessionManager.appendMessage(textAnswer("Root seed acknowledged"));
    }
    const settings: FixtureSettings = { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" as const,
      ...(scenario === "responses-only" ? { codemode: { mode: "only" as const } } : {}),
    };
    let packageSkillPath: string | undefined;
    let cliSkillPath: string | undefined;
    if (scenario.startsWith("package-skills")) {
      const packageRoot = path.join(cwd, "ppt-package");
      packageSkillPath = path.join(packageRoot, "guidance", "ppt.md");
      cliSkillPath = path.join(cwd, "cli-ppt.md");
      await fsp.mkdir(path.join(packageRoot, "guidance"), { recursive: true });
      await fsp.mkdir(path.join(packageRoot, "extensions"), { recursive: true });
      await fsp.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "local-ppt-package", pi: { skills: ["guidance/*.md"], extensions: ["extensions/*.mjs"] } }));
      await fsp.writeFile(path.join(packageRoot, "extensions", "forbidden.mjs"), 'throw new Error("Package extensions must not execute in discovery")');
      const body = (name: string, extra = ""): string => `---\nname: ${name}\ndescription: PPT presentation workflow\n${extra}---\n# Native package PPT guidance\n`;
      await fsp.writeFile(packageSkillPath, body("ppt-master"));
      await fsp.writeFile(path.join(packageRoot, "guidance", "filtered.md"), body("filtered-ppt"));
      await fsp.writeFile(path.join(packageRoot, "guidance", "private.md"), body("private-ppt", "disable-model-invocation: true\n"));
      await fsp.writeFile(cliSkillPath, body("cli-ppt"));
      settings.packages = [{ source: packageRoot, skills: ["!guidance/filtered.md"] }, "git:https://example.invalid/missing-package"];
      settings.enableSkillCommands = false;
    }
    await fsp.writeFile(path.join(agentDir, "settings.json"), JSON.stringify(settings));
    const settingsManager = SettingsManager.inMemory(settings);
    const extensionFactories: InlineExtension[] = [
      { name: "result-rendering", factory: installResultRendering },
      ...(scenario !== "namespace-reverse" ? [{ name: "capability", factory: capabilityExtension }] : []),
      ...(scenario === "capability-missing" ? [] : [{ name: "subagent", factory: subagentExtension }]),
      ...(scenario === "namespace-reverse" ? [{ name: "capability", factory: capabilityExtension }] : []),
      ...(scenario.startsWith("responses-") ? [{ name: "codemode", factory: createCodemodeExtension(), replaceable: true }] : []),
      { name: "external-test-tool", factory(pi) {
        pi.registerTool({ name: "external_test_tool", label: "External Test Tool", description: "A non-transplantable test extension tool.",
          parameters: { type: "object", properties: {} }, execute: async () => { externalToolExecutions++; return { content: [{ type: "text", text: "unused" }], details: undefined }; },
        });
      } },
    ];
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noExtensions: true, noSkills: scenario !== "package-skills", noThemes: true, noPromptTemplates: true, noContextFiles: true,
      ...(scenario === "package-skills" ? { additionalSkillPaths: [cliSkillPath!] } : {}),
      ...(scenario === "inherited" || options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt ?? "Custom inherited system identity" } : {}),
      extensionFactories,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, [], "extension initialization must succeed in a real loader");
    const created = await createAgentSession({ cwd, agentDir, sessionManager, settingsManager, resourceLoader, modelRuntime: runtime, model, thinkingLevel: "low" });
    const activeSession = created.session;
    session = activeSession;
    // Extension failures must not be swallowed: collect both the runner's error
    // callback and error-level UI notifications. UI notifications raised by an
    // intentionally corrupt scenario (for example restore-invalid) are
    // observable evidence, so only new notifications produced while closing
    // are treated as cleanup failures.
    const extensionErrors: ExtensionError[] = [];
    const uiErrors: Error[] = [];
    const ui: ExtensionUIContext = activeSession.extensionRunner.createContext().ui;
    await activeSession.bindExtensions({
      uiContext: {
        ...ui,
        notify(message, level) {
          if (level === "error") uiErrors.push(new Error(String(message)));
          ui.notify(message, level);
        },
      },
      onError: (error) => extensionErrors.push(error),
    });
    const sessionUid = deriveSessionUid(sessionManager.getSessionId());
    const sessionSocketDir = path.join(socketDir, sessionUid);
    let toolSequence = 0;
    async function call(name: string, params: JsonObject): Promise<FixtureToolResult<Record<string, unknown>>> {
      if (name.startsWith("subagent_")) activeSession.setActiveToolsByName([...activeSession.getActiveToolNames(), ...["subagent_create", "subagent_list", "subagent_stop"].filter((tool) => activeSession.getToolDefinition(tool))]);
      const tool = activeSession.getToolDefinition(name);
      assert.ok(tool, `missing native registered tool ${name}`);
      const toolCallId = `test-call-${++toolSequence}`;
      return toolResultOf(await tool.execute(toolCallId, params, undefined, undefined, activeSession.extensionRunner.createToolContext(toolCallId, undefined)));
    }
    async function listener(socketPath: string): Promise<net.Server> {
      return waitFor(() => listeningServers().find((server) => server.address() === socketPath), { label: "host listener ready" });
    }
    async function create(task: string, extra: JsonObject = {}): Promise<FixtureActor> {
      const [first] = createdItems(await call("subagent_create", { tasks: [{ name: "LocalTask", task, ...extra }] }));
      assert.ok(first, "subagent_create must return one Actor");
      return first;
    }
    async function item(id: string): Promise<FixtureActor | undefined> {
      const result = await call("subagent_list", { id, all: true });
      return result.details === undefined ? undefined : actorOf(result.details);
    }
    async function stopped(id: string): Promise<FixtureActor> {
      return waitFor(async () => {
        const found = await item(id);
        return found?.status === "stopped" ? found : undefined;
      }, { label: `terminal state of ${id}` });
    }

    const fixture: SdkFixture = {
      get scenario() { return scenario; },
      cwd, agentDir, socketDir, sessionSocketDir,
      session: activeSession, sessionManager, chats, notificationChats, classifications, controls,
      call, create, item, stopped, gate: controlledGate, controlledGate, textAnswer, toolAnswer,
      model: fixtureModel, assistant, durable, childManagers, abortable, listener, events: readTranscriptEvents,
      resourceLoader, networkAttempts, uiErrors,
      releaseGates() { for (const gate of gates) gate.resolve(); },
      get streamedFragments() { return streamedFragments; },
      getExternalToolExecutions: () => externalToolExecutions,
      close: () => (closeReport ??= close()),
    };

    let closeReport: Promise<void> | null = null;
    async function close(): Promise<void> {
      const failures: Error[] = [];
      const uiErrorsBeforeCleanup = uiErrors.length;
      const collect = async (label: string, action: () => void | Promise<void>): Promise<void> => {
        try { await action(); }
        catch (error) {
          failures.push(new Error(`SDK fixture cleanup failed while ${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
        }
      };
      try {
        for (const gate of gates) {
          try { gate.resolve(); }
          catch (error) { failures.push(new Error(`SDK fixture cleanup failed while releasing a held model gate: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
        }
        await collect("awaiting session_shutdown and root retirement", () => activeSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
        await collect("disposing the native SDK session", () => activeSession.dispose());
        await collect("checking for swallowed extension errors", () => assert.deepEqual(extensionErrors, [], "shutdown errors must not be silently swallowed by the test"));
        await collect("checking for error notifications during cleanup", () => assert.deepEqual(uiErrors.slice(uiErrorsBeforeCleanup), [], "cleanup must not report extension failures through the UI"));
        await collect("checking offline isolation", () => assert.deepEqual(networkAttempts, [], "the entire integration scenario must be offline"));
        await collect("checking listener endpoint cleanup", async () => {
          const sockets = await fsp.readdir(socketDir, { recursive: true }).catch((error: unknown) => {
            const code = recordOf(error)?.code;
            if (code === "ENOENT") return [];
            throw error;
          });
          assert.equal(sockets.some((file) => file.endsWith(".sock")), false, "shutdown must remove every listener endpoint");
        });
        await collect("checking for leaked listening servers", () => {
          assert.equal(listeningServers().length, 0, "shutdown must not leave listening servers");
        });
      } finally {
        // Process-wide guards must be restored even when a cleanup check throws.
        try { restoreGlobals(); }
        catch (error) { failures.push(new Error(`SDK fixture cleanup failed while restoring process globals: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `SDK fixture cleanup reported ${failures.length} failure(s) for scenario ${scenario}.`);
      }
    }

    return fixture;
  } catch (error) {
    // A partial setup must not keep patched globals or a started extension root.
    const failures: unknown[] = [error];
    if (session !== null) {
      try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } catch (cleanupError) { failures.push(cleanupError); }
      try { await session.dispose(); } catch (cleanupError) { failures.push(cleanupError); }
    }
    try { restoreGlobals(); } catch (cleanupError) { failures.push(cleanupError); }
    if (failures.length > 1) throw new AggregateError(failures, "SDK fixture setup and cleanup both failed");
    throw error;
  }
}
