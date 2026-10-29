/**
 * Focused contract tests for the native Job runner.
 *
 * These exercise the real runner: the fakes only implement the narrow ports it
 * declares, plus a real in-memory SessionManager so the run's own result,
 * transcript and history bounds are read from the same append-only tree the
 * production adapter uses. Nothing here copies the legacy adapter.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, ImageContent, Model, Usage } from "@earendil-works/pi-ai";

import { promptText } from "../../src/prompt-text.mjs";
import { setCapabilityParent } from "../../src/capability/scope.ts";
import type { SubagentExecution } from "../../src/subagent/execution.ts";
import { NativeJobRunner } from "../../src/subagent/native-runner.ts";
import { SubagentError } from "../../src/subagent/runtime.ts";
import type {
  BudgetChargeResult,
  BudgetCheck,
  BudgetSnapshot,
  BudgetSnapshotDetail,
  BudgetStartResult,
  BudgetTerminateResult,
  FreshJobSpec,
  InheritedContext,
  JobBudgetPort,
  JobRequest,
  JobSpec,
} from "../../src/subagent/runtime.ts";
import type { TerminalNotification } from "../../src/subagent/lifecycle.ts";
import type {
  NativeActorStore,
  NativeChildApi,
  NativeCustomMessageBody,
  NativeCustomMessageOptions,
  NativeExecution,
  NativeHandoffResult,
  NativeJobRunnerDeps,
  NativeListenerPort,
  NativeListenerRequest,
  NativeOpenedSession,
  NativeQueueAgent,
  NativeRetainedActor,
  NativeRouteResult,
  NativeRoutingPort,
  NativeSession,
  NativeSessionEvent,
  NativeSessionFactory,
  NativeSessionRequest,
  NativeToolDescriptor,
} from "../../src/subagent/native-types.ts";

// Compile-time proof that the production SDK objects satisfy the runner ports
// without a cast: the shared execution wrapper is a NativeExecution, and a real
// child Pi is a NativeChildApi.
const executionContract: (execution: SubagentExecution<AgentSession>) => NativeExecution = (execution) => execution;
const childSurfaceContract: (pi: ExtensionAPI) => NativeChildApi = (pi) => pi;
void executionContract;
void childSurfaceContract;

const USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  text: string,
  stopReason: "stop" | "error" | "aborted" = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "fake",
    model: "fake-1",
    usage: USAGE,
    stopReason,
    timestamp: Date.now(),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function fakeModel(id = "fake-1"): Model<Api> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "fake",
    baseUrl: "https://example.invalid",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 1_000,
    maxTokens: 100,
  };
}

function emptyScope(): NativeChildApi {
  return { getAllTools: () => [] };
}

type PromptHandler = (
  text: string,
  options: { expandPromptTemplates: false; images?: ImageContent[] },
) => Promise<null | string | { text: string; stopReason: "stop" | "error" | "aborted"; errorMessage?: string }>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForSession(h: Harness): Promise<FakeSession> {
  await waitFor(() => h.factory.sessions[0] !== undefined, "the child session");
  const session = h.factory.sessions[0];
  assert.ok(session !== undefined);
  return session;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read turn-control text from the asset instead of copying its prose. */
function turnsText(key: string): string {
  const parsed: unknown = JSON.parse(promptText("subagent-turns.json"));
  const value = isRecord(parsed) ? parsed[key] : undefined;
  if (typeof value !== "string") throw new Error(`subagent-turns.json has no string ${key}`);
  return value;
}

const CONTROL = turnsText("control");

interface CustomEntryView {
  readonly customType: string;
  readonly content: string;
  readonly details: unknown;
}

/** The custom entries native history actually recorded, in branch order. */
function customEntries(manager: SessionManager): CustomEntryView[] {
  const views: CustomEntryView[] = [];
  for (const entry of manager.getBranch()) {
    if (entry.type !== "custom_message") continue;
    views.push({
      customType: entry.customType,
      content: typeof entry.content === "string"
        ? entry.content
        : entry.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join(""),
      details: entry.details,
    });
  }
  return views;
}

function runManager(h: Harness): SessionManager {
  const manager = h.factory.requests[0]?.sessionManager;
  assert.ok(manager !== undefined);
  return manager;
}

/** A Budget that never fails; the runner only observes it. */
class FakeBudget implements JobBudgetPort {
  terminal: BudgetSnapshot["terminal"] = null;

  beginModelCall(): BudgetChargeResult {
    return { ok: true, sequence: 1 };
  }

  takeWarning(): string | null {
    return null;
  }

  check(): BudgetCheck {
    return this.snapshot();
  }

  startActive(): BudgetStartResult {
    return { ok: true, activeTimeMs: 0 };
  }

  pauseActive(): { ok: true; activeTimeMs: number } {
    return { ok: true, activeTimeMs: 0 };
  }

  terminate(): BudgetTerminateResult {
    return {
      ok: true,
      terminal: { status: "completed", termination: "model_final", truncated: false, error: null },
    };
  }

  snapshot(): BudgetSnapshot;
  snapshot(options: { detail: true }): BudgetSnapshotDetail;
  snapshot(options?: { detail?: boolean }): BudgetSnapshot | BudgetSnapshotDetail {
    const base: BudgetSnapshot = {
      jobId: "sub_01",
      depth: 0,
      phase: "normal",
      modelCalls: 0,
      activeTimeMs: 0,
      rejectedProjectedModelCalls: null,
      running: false,
      warningTaken: false,
      terminal: this.terminal,
    };
    if (options?.detail === true) {
      return {
        ...base,
        profile: {
          modelCalls: { soft: 10, hard: 20 },
          activeTimeMs: { soft: 1_000, hard: 2_000 },
          lifetimeMs: 10_000,
        },
        elapsedMs: 0,
      };
    }
    return base;
  }
}

/** The Agent queues the end-of-turn loop reads parked input from. */
class FakeAgent implements NativeQueueAgent {
  steeringMode: NativeQueueAgent["steeringMode"] = "one-at-a-time";
  followUpMode: NativeQueueAgent["followUpMode"] = "one-at-a-time";
  streamFunction: ((...args: unknown[]) => unknown) | undefined = () => undefined;
  prepareRequest: ((...args: unknown[]) => Promise<unknown>) | undefined;
  readonly #steering: unknown[] = [];
  readonly #followUp: unknown[] = [];

  hasQueuedMessages(): boolean {
    return this.#steering.length + this.#followUp.length > 0;
  }

  steer(message: unknown): void {
    this.#steering.push(message);
  }

  followUp(message: unknown): void {
    this.#followUp.push(message);
  }

  peekQueuedMessages(): unknown[] {
    if (this.steeringMode !== "all") {
      if (this.#steering.length > 0) return [this.#steering[0]];
      return this.#followUp.length > 0 ? [this.#followUp[0]] : [];
    }
    return this.#steering.length > 0 ? [...this.#steering] : [...this.#followUp];
  }

  clearSteeringQueue(): void {
    this.#steering.splice(0);
  }

  clearFollowUpQueue(): void {
    this.#followUp.splice(0);
  }
}

class FakeSession implements NativeSession {
  model: Model<Api> | null = null;
  thinkingLevel: string | null = "low";
  readonly agent = new FakeAgent();
  activeTools: string[] = ["read", "grep", "write"];
  readonly prompts: string[] = [];
  readonly promptOptions: Array<{ expandPromptTemplates: false; images?: ImageContent[] }> = [];
  readonly steers: string[] = [];
  readonly custom: Array<{ message: NativeCustomMessageBody; options: NativeCustomMessageOptions | undefined }> = [];
  aborts = 0;
  queueClears = 0;
  disposed = 0;
  onRunEnd: (() => void) | null = null;
  failCustom: Error | null = null;
  #streaming = false;
  #runs = 0;
  maxRuns = 0;
  readonly #listeners = new Set<(event: NativeSessionEvent) => void>();
  readonly #manager: SessionManager;

  constructor(manager: SessionManager) {
    this.#manager = manager;
  }

  get isStreaming(): boolean {
    return this.#streaming;
  }

  beginRun(): void {
    this.#streaming = true;
    this.#runs += 1;
    this.maxRuns = Math.max(this.maxRuns, this.#runs);
  }

  endRun(): void {
    this.#streaming = false;
    this.#runs -= 1;
    // Mimic a hand-over accepted in the gap between two turns.
    this.onRunEnd?.();
  }

  append(message: AssistantMessage): void {
    this.#manager.appendMessage(message);
  }

  emit(type: string): void {
    for (const listener of this.#listeners) listener({ type });
  }

  getActiveToolNames(): string[] {
    return [...this.activeTools];
  }

  setActiveToolsByName(names: string[]): void {
    this.activeTools = [...names];
  }

  async sendCustomMessage(
    message: NativeCustomMessageBody,
    options?: NativeCustomMessageOptions,
  ): Promise<void> {
    if (this.failCustom !== null) throw this.failCustom;
    this.custom.push({ message, options });
    if (this.#streaming) {
      // A steering custom message is owned by the live run's own queue.
      return;
    }
    // An idle session records the custom entry; only triggerTurn starts a turn.
    this.#manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    if (options?.triggerTurn === true) {
      this.beginRun();
      try {
        this.append(assistant("custom turn"));
      } finally {
        this.endRun();
      }
    }
  }

  subscribe(listener: (event: NativeSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  clearQueue(): unknown {
    this.queueClears += 1;
    return { steering: [], followUp: [] };
  }

  async steer(text: string): Promise<unknown> {
    this.steers.push(text);
    return "queued";
  }

  async abort(): Promise<void> {
    this.aborts += 1;
    this.#streaming = false;
  }
}

class FakeExecution implements NativeExecution {
  readonly session: FakeSession;
  readonly cleanups: Array<() => void | Promise<void>> = [];
  disposeCount = 0;
  readonly #handler: PromptHandler;

  constructor(session: FakeSession, handler: PromptHandler) {
    this.session = session;
    this.#handler = handler;
  }

  async prompt(
    prompt: string,
    options: { expandPromptTemplates: false; images?: ImageContent[] },
  ): Promise<void> {
    this.session.beginRun();
    try {
      this.session.prompts.push(prompt);
      this.session.promptOptions.push(options);
      const reply = await this.#handler(prompt, options);
      if (reply === null) return;
      if (typeof reply === "string") this.session.append(assistant(reply));
      else this.session.append(assistant(reply.text, reply.stopReason, reply.errorMessage));
    } finally {
      this.session.endRun();
    }
  }

  async steer(text: string): Promise<unknown> {
    return this.session.steer(text);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  addCleanup(cleanup: () => void | Promise<void>): void {
    this.cleanups.push(cleanup);
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    this.session.disposed += 1;
    for (const cleanup of [...this.cleanups].reverse()) await cleanup();
  }
}

class RecordingActors implements NativeActorStore {
  readonly descriptors = new Map<string, NativeRetainedActor>();
  readonly retained: NativeRetainedActor[] = [];
  readonly opens: Array<Parameters<NativeActorStore["open"]>[0]> = [];
  readonly leafRestores: Array<Parameters<NativeActorStore["restoreLeaf"]>[0]> = [];
  durable = false;

  seed(agentId: string, descriptor: NativeRetainedActor): void {
    this.descriptors.set(agentId, descriptor);
  }

  get(agentId: string): NativeRetainedActor | null {
    return this.descriptors.get(agentId) ?? null;
  }

  retain(agentId: string, descriptor: NativeRetainedActor): void {
    this.descriptors.set(agentId, descriptor);
    this.retained.push(descriptor);
  }

  open(input: Parameters<NativeActorStore["open"]>[0]): SessionManager {
    this.opens.push(input);
    return SessionManager.inMemory(input.cwd);
  }

  recordedAnchor(manager: SessionManager | null, fallback: string | null): string | null {
    return manager?.getLeafId() ?? fallback;
  }

  restoreLeaf(input: Parameters<NativeActorStore["restoreLeaf"]>[0]): void {
    this.leafRestores.push(input);
  }
}

class RecordingModels {
  readonly captured: unknown[] = [];
  result: Model<Api> | null = null;
  fail = false;

  inherited(captured: unknown): Model<Api> | null {
    this.captured.push(captured);
    if (this.fail) throw new SubagentError("model_unavailable", "captured model is not in the catalog");
    return this.result;
  }
}

class RecordingRouting implements NativeRoutingPort {
  readonly calls: Array<Parameters<NativeRoutingPort["route"]>[0]> = [];
  result: NativeRouteResult | null = null;

  async route(input: Parameters<NativeRoutingPort["route"]>[0]): Promise<NativeRouteResult> {
    this.calls.push(input);
    if (this.result === null) throw new Error("routing is not configured for this test");
    return this.result;
  }
}

class RecordingListeners implements NativeListenerPort {
  readonly calls: NativeListenerRequest[] = [];

  async restore(input: NativeListenerRequest): Promise<void> {
    this.calls.push(input);
  }
}

class RecordingSessionFactory implements NativeSessionFactory {
  readonly requests: NativeSessionRequest[] = [];
  readonly sessions: FakeSession[] = [];
  readonly executions: FakeExecution[] = [];
  readonly capabilityScope: NativeChildApi;
  beforeOpen: ((request: NativeSessionRequest) => Promise<void>) | null = null;
  openError: Error | null = null;
  modelRuntimeChecks = 0;
  #handler: PromptHandler;

  constructor(scope: NativeChildApi, handler: PromptHandler) {
    this.capabilityScope = scope;
    this.#handler = handler;
  }

  assertModelRuntime(): void {
    this.modelRuntimeChecks += 1;
    if (this.modelRuntimeChecks === 1 && this.openError !== null) throw this.openError;
  }

  async open(request: NativeSessionRequest): Promise<NativeOpenedSession> {
    this.requests.push(request);
    if (this.beforeOpen !== null) await this.beforeOpen(request);
    const session = new FakeSession(request.sessionManager);
    session.model = request.model;
    session.thinkingLevel = request.thinkingLevel;
    const execution = new FakeExecution(session, this.#handler);
    this.sessions.push(session);
    this.executions.push(execution);
    return { execution, capabilityScope: this.capabilityScope };
  }
}

interface Harness {
  runner: NativeJobRunner;
  actors: RecordingActors;
  factory: RecordingSessionFactory;
  models: RecordingModels;
  routing: RecordingRouting;
  tools: { catalog: () => readonly NativeToolDescriptor[] };
  root: { storageError: Error | null; canStartJob: boolean; mayPersist: boolean };
  listeners: RecordingListeners;
  notifications: string[];
}

function harness(options: {
  scope?: NativeChildApi;
  promptHandler?: PromptHandler;
  catalog?: readonly NativeToolDescriptor[];
  route?: NativeRouteResult | null;
} = {}): Harness {
  const actors = new RecordingActors();
  const factory = new RecordingSessionFactory(
    options.scope ?? emptyScope(),
    options.promptHandler ?? (async () => "reply"),
  );
  const models = new RecordingModels();
  const routing = new RecordingRouting();
  if (options.route !== undefined) routing.result = options.route;
  const tools = { catalog: (): readonly NativeToolDescriptor[] => options.catalog ?? [] };
  const root = { storageError: null as Error | null, canStartJob: true, mayPersist: true };
  const listeners = new RecordingListeners();
  const notifications: string[] = [];
  const deps: NativeJobRunnerDeps = {
    root,
    config: { socketDir: "/tmp/sockets" },
    actors,
    sessions: factory,
    models,
    routing,
    tools,
    listeners,
    notify: (message) => { notifications.push(message); },
  };
  return { runner: new NativeJobRunner(deps), actors, factory, models, routing, tools, root, listeners, notifications };
}

function freshSpec(overrides: Partial<FreshJobSpec> = {}): FreshJobSpec {
  return {
    name: null,
    task: "do the task",
    context: "batch context",
    inheritContext: false,
    inheritedContext: null,
    ...overrides,
  };
}

function jobRequest(spec: JobSpec, overrides: Partial<JobRequest> = {}): JobRequest {
  const budget = overrides.budget ?? new FakeBudget();
  const base: JobRequest = {
    agentId: "sub_01",
    jobId: "sub_01",
    index: null,
    parentAgentId: null,
    depth: 0,
    spec,
    origin: { cwd: "/tmp/project", trusted: true, agentId: null },
    budget,
    continuedFromJobId: null,
    pendingMessages: [],
    checkBudget: () => budget.check(),
    recordStart: () => {},
  };
  return { ...base, ...overrides };
}

function routedIdentity(overrides: Partial<NativeRouteResult> = {}): NativeRouteResult {
  return {
    roleId: "role-runner",
    instructions: "ROLE INSTRUCTIONS",
    model: fakeModel(),
    thinkingLevel: "low",
    excludeTools: [],
    enableTools: [],
    ...overrides,
  };
}

function retainedActor(manager: SessionManager, overrides: Partial<NativeRetainedActor> = {}): NativeRetainedActor {
  return {
    sessionManager: manager,
    sessionFile: null,
    anchor: manager.getLeafId(),
    cwd: "/tmp/project",
    trusted: true,
    allowInherited: false,
    systemPrompt: null,
    roleId: "role-runner",
    roleInstructions: "ROLE INSTRUCTIONS",
    modelRef: { provider: "fake", id: "fake-1" },
    model: fakeModel(),
    thinkingLevel: "low",
    tools: ["read"],
    excludedTools: null,
    assignment: "ORIGINAL ASSIGNMENT",
    routed: true,
    ...overrides,
  };
}

function notification(content: string): TerminalNotification {
  return {
    type: "notification",
    from: "sub_03",
    subagentId: "sub_03",
    jobId: "sub_03",
    round: 1,
    status: "completed",
    content,
    error: null,
    history: null,
  };
}

test("a fresh Job routes, installs its child surface and completes with its own result", async () => {
  const h = harness({ route: routedIdentity({ excludeTools: ["write"] }) });
  setCapabilityParent(h.factory.capabilityScope, null, ["grep"]);
  const started: Array<string | null> = [];
  const request = jobRequest(freshSpec(), { recordStart: (id) => { started.push(id); } });

  const outcome = await h.runner.start(request).done;

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.result, "reply");
  assert.equal(h.routing.calls.length, 1);
  assert.equal(h.routing.calls[0]?.task, "do the task");
  assert.equal(h.routing.calls[0]?.context, "batch context");
  assert.equal(h.routing.calls[0]?.signal.aborted, false);

  const open = h.factory.requests[0];
  assert.ok(open !== undefined);
  assert.equal(open.model?.id, "fake-1");
  assert.equal(open.thinkingLevel, "low");
  assert.equal(open.systemPrompt, null);
  assert.equal(open.appendSystemPrompt[0], "ROLE INSTRUCTIONS");
  assert.ok(open.excludedTools.includes("write"));
  assert.equal(open.surface.allowInherited, true);
  assert.equal(open.surface.senderId, "sub_01");
  assert.equal(open.surface.parentAgentId, "sub_01");
  assert.equal(open.surface.capabilityParentId, null);
  assert.ok(open.appendSystemPrompt[1]?.includes("sub_01"));
  assert.deepEqual(started, [null]);
  assert.equal(outcome.history?.startEntryId, null);
  assert.equal(outcome.history?.endEntryId, open.sessionManager.getLeafId());

  const session = h.factory.sessions[0];
  assert.ok(session !== undefined);
  // The role's tool blacklist excludes write from the session options; the
  // capability scope denies grep, so the active loadout is filtered.
  assert.ok(session.activeTools.includes("read"));
  assert.ok(session.activeTools.includes("subagent_create"));
  assert.ok(!session.activeTools.includes("grep"));

  const descriptor = h.actors.retained.at(-1);
  assert.ok(descriptor !== undefined);
  assert.equal(descriptor.routed, true);
  assert.deepEqual(descriptor.modelRef, { provider: "fake", id: "fake-1" });
  // The assignment is recorded by the conversation only while it is not yet
  // present; after the first turn it is not restated.
  assert.equal(descriptor.assignment, null);
  assert.ok(descriptor.tools?.includes("subagent_create"));
  assert.equal(h.factory.executions[0]?.disposeCount, 1);
  assert.equal(session.disposed, 1);
});

test("a continuation restates its assignment and appends startup input as native entries", async () => {
  const h = harness({ promptHandler: async () => "continued" });
  const manager = SessionManager.inMemory("/tmp/project");
  manager.appendMessage(assistant("earlier answer"));
  const retained = retainedActor(manager);
  h.actors.seed("sub_01", retained);
  const request = jobRequest(
    { kind: "continuation", name: null, seed: freshSpec() },
    {
      continuedFromJobId: "sub_01#r1",
      pendingMessages: [
        { type: "message", from: "sub_02", content: "peer says hi" },
        notification("terminal says done"),
      ],
    },
  );

  const outcome = await h.runner.start(request).done;

  assert.equal(outcome.status, "completed");
  assert.equal(h.actors.opens.length, 0);
  const session = h.factory.sessions[0];
  assert.ok(session !== undefined);
  assert.equal(session.prompts.length, 1);
  const prompt = session.prompts[0] ?? "";
  assert.ok(prompt.includes("# Original assignment"));
  assert.ok(prompt.includes("ORIGINAL ASSIGNMENT"));
  assert.ok(prompt.endsWith(CONTROL));
  // Startup events are separate native entries, never text merged into the prompt.
  assert.ok(!prompt.includes("peer says hi"));
  assert.ok(!prompt.includes("terminal says done"));
  const entries = customEntries(manager);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.customType, "agent-delivery");
  assert.equal(entries[0]?.content, "[Message from sub_02]\npeer says hi");
  assert.deepEqual(entries[0]?.details, { sourceId: "sub_02", round: 1, source: "agent", status: "running" });
  assert.equal(entries[1]?.customType, "agent-delivery");
  assert.ok(entries[1]?.content.includes("terminal says done"));
  assert.ok(entries[1]?.content.includes("[Subagent sub_03 completed (round 1)]"));
  assert.deepEqual(entries[1]?.details, {
    sourceId: "sub_03", round: 1, source: "host", status: "completed",
    terminal: {
      status: "completed",
      details: {
        type: "notification", from: "sub_03", subagentId: "sub_03", jobId: "sub_03",
        round: 1, status: "completed", error: null, history: null, content: "terminal says done",
      },
    },
  });
  assert.equal(h.actors.retained[0]?.sessionManager, manager);
  assert.equal(h.factory.requests[0]?.sessionManager, manager);
});

test("a continuation without a retained session or seed fails explicitly", async () => {
  const h = harness();
  const request = jobRequest(
    { kind: "continuation", name: null, seed: null },
    { continuedFromJobId: "sub_01#r1" },
  );

  const outcome = await h.runner.start(request).done;

  assert.equal(outcome.status, "failed");
  assert.ok(outcome.error instanceof SubagentError);
  assert.equal(outcome.error.code, "continuation_unavailable");
  assert.equal(h.factory.requests.length, 0);
  assert.equal(h.actors.opens.length, 0);
});

test("custom input handed over during startup is appended before the primary prompt", async () => {
  const h = harness({ route: routedIdentity() });
  let handled = false;
  h.factory.beforeOpen = async () => {
    if (handled) return;
    handled = true;
    const result = await h.runner.handoffCustom("sub_01", {
      from: "sub_02",
      customType: "agent-delivery",
      content: "welcome",
      display: true,
      details: { sourceId: "sub_02" },
    });
    assert.deepEqual(result, { accepted: true, mode: "pending" });
  };

  const outcome = await h.runner.start(jobRequest(freshSpec())).done;

  assert.equal(outcome.status, "completed");
  const session = h.factory.sessions[0];
  assert.ok(session !== undefined);
  assert.equal(session.custom.length, 1);
  assert.equal(session.custom[0]?.message.customType, "agent-delivery");
  assert.deepEqual(session.custom[0]?.options, { triggerTurn: false });
  // The custom snapshot was appended before the primary turn, not merged into it.
  assert.equal(session.prompts.length, 1);
  assert.ok(!(session.prompts[0] ?? "").includes("welcome"));
  const entries = customEntries(runManager(h));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.content, "welcome");
  assert.deepEqual(entries[0]?.details, { sourceId: "sub_02" });
});

test("native steering owns live input and parked queues are replayed exactly once", async () => {
  const gate = deferred<null | string>();
  const h = harness({
    route: routedIdentity(),
    promptHandler: async (text) => (text.includes("do the task") ? gate.promise : "later answer"),
  });
  const started = h.runner.start(jobRequest(freshSpec()));
  await waitFor(() => h.factory.sessions[0]?.prompts.length === 1, "the primary prompt");
  const session = h.factory.sessions[0];
  assert.ok(session !== undefined);

  // Input that arrives while the run streams is a native custom steer that
  // keeps the sender's round and Job id.
  const steered = await h.runner.handoff("sub_01", {
    from: "sub_02", content: "live update", round: 2, jobId: "sub_02#r2",
  });
  assert.deepEqual(steered, { accepted: true, mode: "steered" });
  assert.equal(session.steers.length, 0);
  assert.equal(session.custom.length, 1);
  assert.equal(session.custom[0]?.message.customType, "agent-delivery");
  assert.equal(session.custom[0]?.message.content, "[Message from sub_02]\nlive update");
  assert.deepEqual(session.custom[0]?.options, { triggerTurn: true, deliverAs: "steer" });
  assert.deepEqual(session.custom[0]?.message.details, {
    sourceId: "sub_02", round: 2, source: "agent", status: "running", jobId: "sub_02#r2",
  });

  const customSteer = await h.runner.handoffCustom("sub_01", {
    from: "sub_03",
    customType: "agent-delivery",
    content: "live custom",
    display: true,
    details: {},
  });
  assert.deepEqual(customSteer, { accepted: true, mode: "steered" });

  // Messages the SDK left parked when the run settled are the loop's own input.
  session.agent.steer({ role: "user", content: "parked steer" });
  session.agent.followUp({ role: "user", content: "parked follow-up" });
  session.agent.steer({
    role: "custom",
    customType: "agent-delivery",
    content: "parked custom",
    display: true,
    details: {},
    timestamp: 0,
  });
  assert.equal(session.agent.hasQueuedMessages(), true);

  gate.resolve("primary answer");
  const outcome = await started.done;

  assert.equal(outcome.status, "completed");
  assert.equal(session.maxRuns, 1);
  assert.equal(session.queueClears, 1);
  assert.equal(session.agent.hasQueuedMessages(), false);
  assert.deepEqual(session.prompts.length, 3);
  assert.ok(session.prompts[1]?.includes("parked steer"));
  assert.ok(session.prompts[2]?.includes("parked follow-up"));
  assert.ok(!session.prompts.some((prompt) => prompt.includes("parked custom")));
  // The peer steer, one extra custom steer, then the parked custom replayed once.
  assert.equal(session.custom.length, 3);
  assert.equal(session.custom[0]?.message.content, "[Message from sub_02]\nlive update");
  assert.deepEqual(session.custom[0]?.options, { triggerTurn: true, deliverAs: "steer" });
  assert.equal(session.custom[1]?.message.content, "live custom");
  assert.deepEqual(session.custom[1]?.options, { triggerTurn: true, deliverAs: "steer" });
  assert.equal(session.custom[2]?.message.content, "parked custom");
  assert.deepEqual(session.custom[2]?.options, { triggerTurn: true, deliverAs: "steer" });
  assert.ok(!session.prompts.some((prompt) => prompt.includes("live update")));
  assert.equal(outcome.result, "later answer");
});

test("buffered input becomes one more turn of the same Job without a second loop", async () => {
  const gate = deferred<null | string>();
  const h = harness({
    route: routedIdentity(),
    promptHandler: async (text) => (text.includes("do the task") ? gate.promise : "second answer"),
  });
  const started = h.runner.start(jobRequest(freshSpec()));
  const session = await waitForSession(h);
  await waitFor(() => session.prompts.length === 1, "the primary prompt");
  let handled = false;
  session.onRunEnd = () => {
    if (handled) return;
    handled = true;
    void h.runner.handoff("sub_01", { from: "sub_02", content: "queued update" }).then((result) => {
      assert.deepEqual(result, { accepted: true, mode: "pending" });
    });
  };
  gate.resolve("first answer");

  const outcome = await started.done;

  assert.equal(outcome.status, "completed");
  assert.equal(session.maxRuns, 1);
  assert.equal(session.prompts.length, 2);
  // Buffered input is its own native entry; one control prompt consumes it.
  assert.equal(session.prompts[1], CONTROL);
  assert.ok(!(session.prompts[1] ?? "").includes("queued update"));
  const buffered = customEntries(runManager(h));
  assert.equal(buffered.length, 1);
  assert.equal(buffered[0]?.customType, "agent-delivery");
  assert.equal(buffered[0]?.content, "[Message from sub_02]\nqueued update");
  assert.deepEqual(buffered[0]?.details, { sourceId: "sub_02", round: 1, source: "agent", status: "running" });
  assert.equal(outcome.result, "second answer");
  // The ended Job refuses further input instead of accepting it into a disposed session.
  const late = await h.runner.handoff("sub_01", { from: "sub_02", content: "too late" });
  assert.deepEqual(late, { accepted: false, reason: "job_closed" });
  assert.equal(h.runner.done("sub_01"), null);
});

test("independent peer events stay one native entry each and share one control turn", async () => {
  const gate = deferred<null | string>();
  const h = harness({
    route: routedIdentity(),
    promptHandler: async (text) => (text.includes("do the task") ? gate.promise : "second answer"),
  });
  const started = h.runner.start(jobRequest(freshSpec()));
  const session = await waitForSession(h);
  await waitFor(() => session.prompts.length === 1, "the primary prompt");
  let handoffs: Array<Promise<NativeHandoffResult>> = [];
  let handled = false;
  session.onRunEnd = () => {
    if (handled) return;
    handled = true;
    // All three are handed over in the gap before the loop takes the buffer.
    handoffs = [
      h.runner.handoff("sub_01", { from: "sub_02", content: "alpha-event", round: 2, jobId: "sub_02#r2" }),
      h.runner.handoff("sub_01", { from: "sub_03", content: "beta-event" }),
      h.runner.handoff("sub_01", { from: "sub_04", content: "gamma-event", round: 4, jobId: "sub_04#r4" }),
    ];
  };
  gate.resolve("first answer");

  const outcome = await started.done;

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.result, "second answer");
  assert.deepEqual(await Promise.all(handoffs), [
    { accepted: true, mode: "pending" },
    { accepted: true, mode: "pending" },
    { accepted: true, mode: "pending" },
  ]);
  assert.equal(h.factory.requests.length, 1, "one native session request");
  assert.equal(session.maxRuns, 1);
  assert.equal(session.prompts.length, 2, "one primary prompt and one control prompt");
  assert.ok(session.prompts[0]?.includes("do the task"));
  assert.equal(session.prompts[1], CONTROL);
  for (const body of ["alpha-event", "beta-event", "gamma-event"]) {
    assert.equal(session.prompts.some((prompt) => prompt.includes(body)), false, `${body} is never merged into a prompt`);
  }
  const manager = runManager(h);
  const entries = customEntries(manager);
  assert.deepEqual(entries.map((entry) => entry.customType), ["agent-delivery", "agent-delivery", "agent-delivery"]);
  assert.deepEqual(entries.map((entry) => entry.content), [
    "[Message from sub_02]\nalpha-event",
    "[Message from sub_03]\nbeta-event",
    "[Message from sub_04]\ngamma-event",
  ]);
  // Sender, round and Job id appear once each, never duplicated or regrouped.
  assert.deepEqual(entries.map((entry) => entry.details), [
    { sourceId: "sub_02", round: 2, source: "agent", status: "running", jobId: "sub_02#r2" },
    { sourceId: "sub_03", round: 1, source: "agent", status: "running" },
    { sourceId: "sub_04", round: 4, source: "agent", status: "running", jobId: "sub_04#r4" },
  ]);
  // Each event appears exactly once in native history, before the control turn.
  const branch = manager.getBranch();
  const customIndices = branch.flatMap((entry, index) => (entry.type === "custom_message" ? [index] : []));
  assert.equal(customIndices.length, 3);
  const [first, second, third] = customIndices;
  assert.ok(first !== undefined && second !== undefined && third !== undefined);
  assert.ok(first < second && second < third);
  const assistantIndex = (text: string): number => branch.findIndex(
    (entry) => entry.type === "message" && entry.message.role === "assistant" &&
      entry.message.content.some((part) => part.type === "text" && part.text.includes(text)),
  );
  const firstAnswer = assistantIndex("first answer");
  const secondAnswer = assistantIndex("second answer");
  // All three entries land after the first turn and before the control turn's
  // model output; the control prompt itself is not stored by this fake.
  assert.ok(firstAnswer >= 0 && secondAnswer > firstAnswer);
  assert.ok(first > firstAnswer && third < secondAnswer);
});

test("an SDK steer failure is delivery_uncertain, never a safe refusal", async () => {
  const gate = deferred<null | string>();
  const h = harness({ route: routedIdentity(), promptHandler: async () => gate.promise });
  const started = h.runner.start(jobRequest(freshSpec()));
  const session = await waitForSession(h);
  await waitFor(() => session.prompts.length === 1, "the primary prompt");
  session.failCustom = new Error("sdk refused the steer");
  const verify = (error: unknown): boolean =>
    error instanceof SubagentError && error.code === "delivery_uncertain" && /sdk refused the steer/.test(error.message);
  await assert.rejects(h.runner.handoff("sub_01", { from: "sub_02", content: "peer lost?" }), verify);
  // The custom envelope keeps its own caller contract: still a throw, never a
  // safe refusal, and the original SDK error reaches the router.
  await assert.rejects(h.runner.handoffCustom("sub_01", {
    from: "sub_03", customType: "agent-delivery", content: "custom lost?", display: true, details: {},
  }), (error: unknown) => error === session.failCustom);
  session.failCustom = null;
  gate.resolve("primary answer");
  const outcome = await started.done;
  assert.equal(outcome.status, "completed");
});

test("a provider error fails the Job instead of reporting an earlier answer", async () => {
  const gate = deferred<null | string>();
  const h = harness({
    route: routedIdentity(),
    promptHandler: async (text) => {
      if (text.includes("do the task")) return gate.promise;
      return { text: "", stopReason: "error", errorMessage: "provider exploded" };
    },
  });
  const started = h.runner.start(jobRequest(freshSpec()));
  const session = await waitForSession(h);
  await waitFor(() => session.prompts.length === 1, "the primary prompt");
  let handled = false;
  session.onRunEnd = () => {
    if (handled) return;
    handled = true;
    void h.runner.handoff("sub_01", { from: "sub_02", content: "second round" });
  };
  gate.resolve("first answer");

  const outcome = await started.done;

  assert.equal(outcome.status, "failed");
  assert.ok(outcome.error instanceof SubagentError);
  assert.equal(outcome.error.code, "provider_error");
  assert.match(outcome.error.message, /provider exploded/);
  // The earlier answer of this Job is never reported as the failed run's result.
  assert.equal(outcome.result, undefined);
  assert.equal(outcome.history?.startEntryId, null);
});

test("cancelling aborts the owned session, refuses late input and disposes once", async () => {
  const gate = deferred<null | string>();
  const h = harness({ route: routedIdentity(), promptHandler: async () => gate.promise });
  const started = h.runner.start(jobRequest(freshSpec()));
  await waitFor(() => h.factory.sessions[0]?.prompts.length === 1, "the primary prompt");
  const session = h.factory.sessions[0];
  assert.ok(session !== undefined);

  assert.equal(h.runner.cancel("sub_01"), true);
  assert.equal(h.runner.cancel("sub_01"), true);
  assert.deepEqual(
    await h.runner.handoff("sub_01", { from: "sub_02", content: "late" }),
    { accepted: false, reason: "job_closed" },
  );
  assert.deepEqual(
    await h.runner.handoffCustom("sub_01", {
      from: "sub_02",
      customType: "agent-delivery",
      content: "late custom",
      display: true,
      details: {},
    }),
    { accepted: false, reason: "job_closed" },
  );

  gate.resolve("aborted answer");
  const outcome = await started.done;

  assert.equal(outcome.status, "cancelled");
  assert.equal(session.aborts, 1);
  assert.equal(h.factory.executions[0]?.disposeCount, 1);
  assert.equal(session.maxRuns, 1);
});

test("a retired or storage-fenced root refuses to start native work", async () => {
  const fenced = harness();
  const storageError = new Error("storage latched");
  fenced.root.storageError = storageError;
  const fencedOutcome = await fenced.runner.start(jobRequest(freshSpec())).done;
  assert.equal(fencedOutcome.status, "failed");
  assert.equal(fencedOutcome.error, storageError);
  assert.equal(fenced.factory.requests.length, 0);
  assert.equal(fenced.actors.opens.length, 0);

  const retired = harness();
  retired.root.canStartJob = false;
  const retiredOutcome = await retired.runner.start(jobRequest(freshSpec())).done;
  assert.equal(retiredOutcome.status, "failed");
  assert.ok(retiredOutcome.error instanceof SubagentError);
  assert.equal(retiredOutcome.error.code, "runtime_closed");
  assert.equal(retired.factory.requests.length, 0);
});

test("root quiescence refuses new Jobs while an owned run still writes its final checkpoint", async () => {
  const gate = deferred<null | string>();
  const h = harness({ route: routedIdentity(), promptHandler: async () => gate.promise });
  const started = h.runner.start(jobRequest(freshSpec(), { jobId: "sub_01", agentId: "sub_01" }));
  await waitForSession(h);
  await waitFor(() => h.factory.sessions[0]?.prompts.length === 1, "the primary prompt");

  // Quiescing: a new Job is refused, the owned run is untouched.
  h.root.canStartJob = false;
  const rejected = await h.runner.start(jobRequest(freshSpec(), { jobId: "sub_09", agentId: "sub_09" })).done;
  assert.equal(rejected.status, "failed");
  assert.ok(rejected.error instanceof SubagentError);
  assert.equal(rejected.error.code, "runtime_closed");

  const retainedBefore = h.actors.retained.length;
  gate.resolve("owned answer");
  const outcome = await started.done;

  assert.equal(outcome.status, "completed");
  // The context still owns its writes even though no new Job may start.
  assert.ok(h.actors.retained.length > retainedBefore);
  assert.equal(h.actors.retained.at(-1)?.assignment, null);
});

test("a context that no longer owns persistence skips its final checkpoint", async () => {
  // The same run twice, differing only in whether the context still owns its
  // writes when the native run ends. The final checkpoint is the `mayPersist`
  // pair (effective loadout + leaf); the run's own interim writes are not
  // governed by it.
  const retainedFor = async (mayPersist: boolean): Promise<number> => {
    const gate = deferred<null | string>();
    const h = harness({ route: routedIdentity(), promptHandler: async () => gate.promise });
    const started = h.runner.start(jobRequest(freshSpec()));
    await waitForSession(h);
    await waitFor(() => h.factory.sessions[0]?.prompts.length === 1, "the primary prompt");
    if (!mayPersist) h.root.mayPersist = false;
    gate.resolve("answer");
    const outcome = await started.done;
    assert.equal(outcome.status, "completed");
    assert.equal(h.factory.executions[0]?.disposeCount, 1);
    return h.actors.retained.length;
  };

  const owned = await retainedFor(true);
  const released = await retainedFor(false);
  assert.equal(owned - released, 2);
});

test("an inherited Job keeps the captured identity and the transplantable loadout", async () => {
  const snapshot: InheritedContext = {
    cwd: "/tmp/parent",
    systemPrompt: "PARENT PROMPT",
    model: { provider: "fake", id: "captured-1" },
    thinkingLevel: "high",
    tools: ["read", "extension_tool", "write"],
    entries: [{ id: "entry-1" }],
  };
  const h = harness({
    catalog: [
      { name: "read", sourceInfo: { source: "builtin" } },
      { name: "write", sourceInfo: { source: "builtin" } },
      { name: "extension_tool", sourceInfo: { source: "extension" } },
    ],
    route: routedIdentity(),
  });
  h.models.result = fakeModel("catalog-1");

  const outcome = await h.runner.start(
    jobRequest(freshSpec({ inheritContext: true, inheritedContext: snapshot })),
  ).done;

  assert.equal(outcome.status, "completed");
  assert.equal(h.routing.calls.length, 0);
  assert.deepEqual(h.models.captured, [{ provider: "fake", id: "captured-1" }]);
  const open = h.factory.requests[0];
  assert.ok(open !== undefined);
  assert.equal(open.cwd, "/tmp/parent");
  assert.equal(open.systemPrompt, "PARENT PROMPT");
  assert.equal(open.thinkingLevel, "high");
  assert.equal(open.model?.id, "catalog-1");
  const session = h.factory.sessions[0];
  assert.ok(session !== undefined);
  assert.ok(session.activeTools.includes("read"));
  assert.ok(session.activeTools.includes("write"));
  assert.ok(session.activeTools.includes("subagent_create"));
  // A parent tool that Pi's public API cannot transplant is excluded, never
  // silently registered on the child.
  assert.ok(!session.activeTools.includes("extension_tool"));
  // The native manager owns the seed now; the Job registry keeps no second copy.
  assert.equal("entries" in snapshot, false);
  assert.deepEqual(h.actors.retained.at(-1)?.modelRef, { provider: "fake", id: "catalog-1" });
});
