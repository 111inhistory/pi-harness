/**
 * Real-SDK contracts of the native Job runner.
 *
 * Each case opens a real AgentSession on a scripted faux provider and drives
 * the real runner through its public ports. The assertions cover behavior that
 * only exists at this boundary: the once-per-Job msg_write finish reminder, its
 * suppression by an attempted (even failed) msg_write, and interruption of the
 * current run that keeps the same Job/Actor/Budget and appends exactly one
 * sender-bound notice.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { DEFAULT_HARNESS_CONFIG } from "../../src/harness-config.ts";
import { JobBudget } from "../../src/subagent/job-budget.ts";
import { openSessionExecution } from "../../src/session/execution.ts";
import { NativeJobRunner } from "../../src/subagent/native-runner.ts";
import type {
  NativeActorStore,
  NativeExecution,
  NativeOpenedSession,
  NativeRetainedActor,
  NativeSessionFactory,
  NativeSessionRequest,
} from "../../src/subagent/native-types.ts";
import type { JobRequest } from "../../src/subagent/runtime.ts";

const SESSION = "0123abcd";
const AGENT = "sub_1";
const ADDRESS = `${SESSION}:${AGENT}`;
const JOB = `${AGENT}#1`;

/** Synchronization record of one raw SDK event; no derived state is kept. */
interface RecordedEvent {
  readonly type: string;
  readonly stream: string | null;
  readonly toolName: string | null;
}

interface Harness {
  readonly root: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly model: Model<any>;
  readonly runner: NativeJobRunner;
  readonly manager: SessionManager;
  readonly budget: JobBudget;
  readonly faux: ReturnType<typeof fauxProvider>;
  readonly events: RecordedEvent[];
  readonly opened: NativeSessionRequest[];
  readonly routingCalls: () => number;
  readonly interruptionAborted: () => boolean;
  readonly cleanups: () => number;
  readonly respond: (responses: Array<(context: TranscriptContext, options?: { signal?: AbortSignal }) => AssistantMessage | Promise<AssistantMessage>>) => void;
  close(): Promise<void>;
}

function contextText(context: TranscriptContext): string {
  return JSON.stringify(context.messages);
}

function record(event: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(event);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function harness(options: { codemodeOnlyWrite?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "native-runner-sdk-"));
  const cwd = path.join(root, "work");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
  const model = faux.models[0];
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);

  const manager = SessionManager.inMemory(cwd);
  let interruptionAborted = false;
  let cleanupCount = 0;
  let slowStarted: () => void = () => {};
  const slowStartedPromise = new Promise<void>((resolve) => { slowStarted = resolve; });

  const msgWrite: ToolDefinition = {
    name: "msg_write",
    label: "Message Write",
    description: "Send one message to a managed address.",
    ...(options.codemodeOnlyWrite === true ? { exposure: "codemode" as const } : {}),
    parameters: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } } },
    execute: async (_id, params) => {
      if (params !== null && typeof params === "object" && (params as Record<string, unknown>)["to"] === "fail") {
        throw new Error("scripted msg_write failure");
      }
      return { content: [{ type: "text", text: "sent" }], details: {} };
    },
  };
  const slowTool: ToolDefinition = {
    name: "slow_tool",
    label: "Slow Tool",
    description: "Wait until the run is interrupted.",
    parameters: { type: "object", properties: {} },
    execute: async (_id, _params, signal) => {
      slowStarted();
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted === true) {
          interruptionAborted = true;
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => {
          interruptionAborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
      return { content: [{ type: "text", text: "unreachable" }], details: {} };
    },
  };
  const noop: ToolDefinition = {
    name: "noop",
    label: "Noop",
    description: "Complete one tool round without side effects.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  };
  const nestedWriter: ToolDefinition = {
    name: "nested_writer",
    label: "Nested Writer",
    description: "Send through the SDK nested tool path, as Codemode does.",
    parameters: { type: "object", properties: {} },
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      const nested = await ctx.executeTool("msg_write", { to: ADDRESS, content: "through nested path" });
      return { content: [{ type: "text", text: "nested done" }], details: {}, isError: nested.isError };
    },
  };
  const catalog = { getAllTools: () => [msgWrite, slowTool, noop, nestedWriter].map(({ name }) => ({ name })) };

  const executionRef: { current: NativeExecution | null } = { current: null };
  const opened: Harness['opened'] = [];
  let routingCalls = 0;
  const sessions: NativeSessionFactory = {
    assertModelRuntime: () => {},
    open: async (request): Promise<NativeOpenedSession> => {
      opened.push(request);
      const execution = await openSessionExecution({
        cwd: request.cwd,
        agentDir,
        modelRuntime: runtime,
        model: request.model ?? model,
        sessionManager: request.sessionManager,
        settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
        noTools: "builtin",
        tools: options.codemodeOnlyWrite === true
          ? ["slow_tool", "noop", "nested_writer"]
          : ["msg_write", "slow_tool", "noop", "nested_writer"],
        customTools: [msgWrite, slowTool, noop, nestedWriter],
      }, { signal: request.signal });
      execution.addCleanup(() => { cleanupCount += 1; });
      executionRef.current = execution;
      return { execution, capabilityScope: catalog };
    },
  };

  const descriptors = new Map<string, NativeRetainedActor>();
  const actors: NativeActorStore = {
    get: (agentId) => descriptors.get(agentId) ?? null,
    retain: (agentId, descriptor) => { descriptors.set(agentId, descriptor); },
    durable: false,
    open: ({ retained }) => retained?.sessionManager ?? manager,
    recordedAnchor: (sessionManager, fallback) => sessionManager?.getLeafId() ?? fallback,
    restoreLeaf: () => {},
  };

  const budget = new JobBudget({ depth: 1, jobId: JOB, profile: {
    modelCalls: { soft: 50, hard: 50 },
    activeTimeMs: { soft: 600_000, hard: 600_000 },
    lifetimeMs: 600_000,
  } });

  const events: RecordedEvent[] = [];
  const runner = new NativeJobRunner({
    root: { storageError: null, canStartJob: true, mayPersist: true },
    config: { harness: DEFAULT_HARNESS_CONFIG },
    actors,
    sessions,
    models: { inherited: (captured) => captured === null || captured === undefined ? null : model },
    routing: { route: async () => {
      routingCalls += 1;
      return {
        roleId: "executor",
        instructions: "ROLE INSTRUCTIONS",
        model,
        thinkingLevel: "off",
        preset: { name: "test", config: {} },
      };
    } },
    tools: { catalog: () => [{ name: "msg_write" }, { name: "slow_tool" }, { name: "noop" }, { name: "nested_writer" }] },
    work: { hasPending: () => false },
  });

  const h: Harness = {
    root, cwd, agentDir, model, runner, manager, budget, faux, events, opened,
    routingCalls: () => routingCalls,
    interruptionAborted: () => interruptionAborted,
    cleanups: () => cleanupCount,
    respond: (responses) => faux.setResponses(responses),
    close: async () => {
      await executionRef.current?.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
  return h;
}

function request(h: Harness, overrides: Partial<JobRequest> = {}): JobRequest {
  return {
    agentId: AGENT,
    address: ADDRESS,
    jobId: JOB,
    index: 0,
    parentAgentId: null,
    parentAddress: null,
    depth: 1,
    batch: 1,
    group: `${SESSION}:batch_1`,
    goal: "GUARD_GOAL",
    context: null,
    roster: [{ address: ADDRESS, name: null, goal: "GUARD_GOAL" }],
    spec: { kind: "initial", inheritedContext: null },
    origin: { cwd: h.cwd, trusted: true },
    budget: h.budget,
    continuedFromJobId: null,
    pendingMessages: [],
    checkBudget: () => h.budget.snapshot(),
    recordStart: () => {},
    pauseActive: () => { h.budget.pauseActive(); },
    resumeActive: () => {},
    ...overrides,
  };
}

function observeEvents(h: Harness): void {
  const detached = h.runner.subscribeJobEvents(JOB, (event) => {
    const record = event as { type?: string; assistantMessageEvent?: { type?: string }; toolName?: string };
    h.events.push({
      type: record.type ?? "unknown",
      stream: record.assistantMessageEvent?.type ?? null,
      toolName: record.toolName ?? null,
    });
  });
  assert.ok(detached !== null);
}

function reminderEntries(h: Harness): unknown[] {
  return h.manager.getBranch().filter((entry) =>
    entry.type === "custom_message" && entry.customType === "subagent-reminder");
}

function deliveryEntries(h: Harness, needle: string): unknown[] {
  return h.manager.getBranch().filter((entry) =>
    entry.type === "custom_message" && entry.customType === "agent-delivery"
    && typeof entry.content === "string" && entry.content.includes(needle));
}

test("an Inherited first Job keeps the captured identity and never routes", async () => {
  const h = await harness();
  const snapshot = {
    cwd: h.cwd,
    model: { provider: h.model.provider, id: h.model.id },
    thinkingLevel: "off",
    systemPrompt: "CAPTURED PARENT PROMPT",
    tools: ["msg_write"],
  };
  try {
    h.respond([
      () => fauxAssistantMessage([
        fauxToolCall("msg_write", { to: ADDRESS, content: "inherited progress" }, { id: "inherited-write" }),
      ], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("INHERITED DONE")]),
    ]);
    const handle = h.runner.start(request(h, {
      spec: { kind: "initial", inheritedContext: snapshot },
      roster: [{ address: ADDRESS, name: null, goal: "GUARD_GOAL" }],
    }));
    const outcome = await handle.done;
    assert.equal(outcome.status, "completed");
    assert.equal(h.routingCalls(), 0, "an Inherited Job never routes");
    const opened = h.opened[0];
    assert.equal(opened?.systemPrompt, "CAPTURED PARENT PROMPT");
    assert.equal(opened?.surface.allowInherited, false, "an Inherited actor may not nest another capture");
    assert.ok(opened?.inheritedTools?.includes("msg_write"), "the captured loadout reaches the child");
    assert.equal(reminderEntries(h).length, 0, "the inherited run already attempted msg_write");
    assert.equal(h.faux.state.callCount, 2);
  } finally {
    await h.close();
  }
});

test("normal finish without msg_write offers exactly one reminder in the same Job", async () => {
  const h = await harness();
  try {
    h.respond([
      () => fauxAssistantMessage([fauxText("FIRST ANSWER")]),
      (context) => {
        assert.match(contextText(context), /msg_write/, "the reminder names the missing delivery tool");
        return fauxAssistantMessage([fauxText("SECOND ANSWER")]);
      },
    ]);
    const handle = h.runner.start(request(h));
    const outcome = await handle.done;
    assert.equal(outcome.status, "completed");
    assert.equal(h.faux.state.callCount, 2, "one original turn plus one reminder turn");
    assert.equal(reminderEntries(h).length, 1, "at most one reminder per Job");
    assert.equal(deliveryEntries(h, "[Message from").length, 0, "the host synthesizes no result message");
  } finally {
    await h.close();
  }
});

test("a peer message queued during the reminder turn is delivered exactly once", async () => {
  const h = await harness();
  try {
    h.respond([
      () => fauxAssistantMessage([fauxText("FIRST")]),
      async () => {
        await h.runner.handoff(JOB, { from: `${SESSION}:main`, content: "QUEUED_AFTER_REMINDER" });
        return fauxAssistantMessage([fauxText("REMINDER ANSWER")]);
      },
      (context) => {
        assert.equal((contextText(context).match(/QUEUED_AFTER_REMINDER/g) ?? []).length, 1,
          "the queued peer message is not duplicated");
        return fauxAssistantMessage([fauxText("AFTER QUEUE")]);
      },
    ]);
    const handle = h.runner.start(request(h));
    const outcome = await handle.done;
    assert.equal(outcome.status, "completed");
    assert.equal(reminderEntries(h).length, 1);
    assert.equal(deliveryEntries(h, "QUEUED_AFTER_REMINDER").length, 1);
    assert.equal(h.faux.state.callCount, 3, "reminder turn plus the queued message turn, no hidden loop");
  } finally {
    await h.close();
  }
});

test("an attempted msg_write suppresses the reminder regardless of target or failure", async () => {
  const h = await harness();
  try {
    h.respond([
      () => fauxAssistantMessage([
        fauxToolCall("msg_write", { to: "fail", content: "not delivered" }, { id: "write-1" }),
      ], { stopReason: "toolUse" }),
      (context) => {
        assert.doesNotMatch(contextText(context), /finishing this Job without/);
        return fauxAssistantMessage([fauxText("AFTER FAILED WRITE")]);
      },
    ]);
    const handle = h.runner.start(request(h));
    const outcome = await handle.done;
    assert.equal(outcome.status, "completed");
    assert.equal(reminderEntries(h).length, 0, "a failed write still counts as an attempt");
    assert.equal(h.faux.state.callCount, 2, "no hidden loop after the suppressed reminder");
  } finally {
    await h.close();
  }
});

test("a msg_write invoked through the nested tool path counts as presence", async () => {
  const h = await harness();
  try {
    h.respond([
      () => fauxAssistantMessage([
        fauxToolCall("nested_writer", {}, { id: "nested-1" }),
      ], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("AFTER NESTED WRITE")]),
    ]);
    const handle = h.runner.start(request(h));
    observeEvents(h);
    const outcome = await handle.done;
    assert.equal(outcome.status, "completed");
    assert.equal(reminderEntries(h).length, 0, "the nested msg_write attempt suppresses the reminder");
    assert.equal(h.faux.state.callCount, 2);
    assert.ok(h.events.some((entry) => entry.type === "tool_execution_start"
      && entry.toolName === "msg_write"), "the SDK emits the nested msg_write execution event");
  } finally {
    await h.close();
  }
});

test("a Codemode-only msg_write nested call also counts as presence", async () => {
  const h = await harness({ codemodeOnlyWrite: true });
  try {
    h.respond([
      () => fauxAssistantMessage([
        fauxToolCall("nested_writer", {}, { id: "codemode-only-1" }),
      ], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("AFTER CODEMODE WRITE")]),
    ]);
    const handle = h.runner.start(request(h));
    observeEvents(h);
    const outcome = await handle.done;
    assert.equal(outcome.status, "completed");
    assert.equal(reminderEntries(h).length, 0, "a nested Codemode msg_write suppresses the reminder");
    assert.equal(h.faux.state.callCount, 2);
    assert.ok(h.events.some((entry) => entry.type === "tool_execution_start"
      && entry.toolName === "msg_write"), "the nested execution event names msg_write");
  } finally {
    await h.close();
  }
});

test("a successful msg_write also suppresses the reminder", async () => {
  const h = await harness();
  try {
    h.respond([
      () => fauxAssistantMessage([
        fauxToolCall("msg_write", { to: ADDRESS, content: "sent" }, { id: "write-ok" }),
      ], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("AFTER SEND")]),
    ]);
    const outcome = await h.runner.start(request(h)).done;
    assert.equal(outcome.status, "completed");
    assert.equal(reminderEntries(h).length, 0);
    assert.equal(h.faux.state.callCount, 2);
  } finally {
    await h.close();
  }
});

test("only the last five tool-call-bearing rounds decide the reminder", async () => {
  const h = await harness();
  try {
    const round = (name: string, id: string): AssistantMessage => fauxAssistantMessage([
      name === "msg_write"
        ? fauxToolCall("msg_write", { to: ADDRESS, content: "early" }, { id })
        : fauxToolCall("noop", {}, { id }),
    ], { stopReason: "toolUse" });
    h.respond([
      () => round("msg_write", "early-write"),
      () => round("noop", "n2"),
      () => round("noop", "n3"),
      () => round("noop", "n4"),
      () => round("noop", "n5"),
      () => round("noop", "n6"),
      () => fauxAssistantMessage([fauxText("TOOL ROUNDS DONE")]),
      (context) => {
        assert.match(contextText(context), /finishing this Job without/,
          "the early msg_write fell outside the five-round window");
        return fauxAssistantMessage([fauxText("REMINDED")]);
      },
    ]);
    const outcome = await h.runner.start(request(h)).done;
    assert.equal(outcome.status, "completed");
    assert.equal(reminderEntries(h).length, 1);
    assert.equal(h.faux.state.callCount, 8);
  } finally {
    await h.close();
  }
});

test("a failed run never offers the finish reminder", async () => {
  const h = await harness();
  try {
    h.respond([
      () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "scripted provider failure" }),
    ]);
    const outcome = await h.runner.start(request(h)).done;
    assert.equal(outcome.status, "failed");
    assert.equal(reminderEntries(h).length, 0);
    assert.equal(h.faux.state.callCount, 1);
  } finally {
    await h.close();
  }
});

test("interrupt cancels the running tool, keeps the Job, and appends one sender-bound notice", async () => {
  const h = await harness();
  try {
    h.respond([
      () => fauxAssistantMessage([
        fauxThinking("CHECKING"),
        fauxToolCall("msg_write", { to: ADDRESS, content: "progress" }, { id: "write-1" }),
        fauxToolCall("slow_tool", {}, { id: "slow-1" }),
      ], { stopReason: "toolUse" }),
      (context) => {
        const text = contextText(context);
        assert.equal((text.match(/Interrupted by 0123abcd:main/g) ?? []).length, 1,
          "the default interruption notice appears once");
        assert.equal((text.match(/not retried automatically/g) ?? []).length, 1,
          "the notice states the interrupted work is not retried");
        return fauxAssistantMessage([fauxText("AFTER INTERRUPT")]);
      },
    ]);
    const handle = h.runner.start(request(h));
    observeEvents(h);
    const outcome = handle.done;
    // Wait until the parallel msg_write has ended and slow_tool still runs: the
    // status must keep the earliest active tool instead of dropping to thinking
    // when one sibling finishes.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const slowRunning = h.events.some((entry) => entry.type === "tool_execution_start" && entry.toolName === "slow_tool");
        const writeEnded = h.events.some((entry) => entry.type === "tool_execution_end" && entry.toolName === "msg_write");
        if (slowRunning && writeEnded) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    assert.match(h.runner.executionStatus(JOB) ?? "", /^running\(tool-\d+s\)$/,
      "the earliest still-active tool is reported in whole seconds");
    assert.deepEqual(await h.runner.interrupt(JOB, {
      from: `${SESSION}:main`,
    }), { accepted: true });
    const result = await outcome;
    assert.equal(result.status, "completed", "interrupt is not a Job stop");
    assert.equal(h.interruptionAborted(), true, "the running tool received the abort signal");
    assert.equal(deliveryEntries(h, "Interrupted by").length, 1, "one sender-bound notice");
    assert.equal(reminderEntries(h).length, 0, "the interrupted round attempted msg_write");
    assert.equal(h.faux.state.callCount, 2, "one interrupted turn plus one continuation turn");
    assert.equal(h.cleanups(), 1, "the execution disposed exactly once");
    assert.equal(h.runner.subscribeJobEvents(JOB, () => {}), null, "no live observer survives the Job");
    assert.equal(h.runner.executionStatus(JOB), null, "a closed Job reports no execution status");
    assert.deepEqual(await h.runner.interrupt(JOB, { from: `${SESSION}:main`, content: "again" }),
      { accepted: false, reason: "job_closed" });
  } finally {
    await h.close();
  }
});


test("interrupt returns while a held model run and its successor are both pending", async () => {
  const h = await harness();
  let firstStartedResolve: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
  let releaseHeld: () => void = () => {};
  const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let noticeStartedResolve: () => void = () => {};
  const noticeStarted = new Promise<void>((resolve) => { noticeStartedResolve = resolve; });
  let releaseNotice: () => void = () => {};
  const noticeGate = new Promise<void>((resolve) => { releaseNotice = resolve; });
  try {
    h.respond([
      // Hold the first model run until the test releases it. The provider only
      // observes the abort after that release, so awaiting SDK idle in
      // interrupt() would remain blocked right here.
      (_context, options) => {
        firstStartedResolve();
        return held.then((): AssistantMessage => {
          if (options?.signal?.aborted === true) throw new Error("aborted");
          return fauxAssistantMessage([fauxText("unreachable")]);
        });
      },
      () => {
        // The admitted notice starts the same Job's next run and stays held.
        noticeStartedResolve();
        return noticeGate.then(() => fauxAssistantMessage([fauxText("AFTER INTERRUPT")]));
      },
      () => fauxAssistantMessage([fauxText("done")]),
    ]);
    const handle = h.runner.start(request(h));
    const outcome = handle.done;
    await firstStarted;
    assert.equal(h.runner.executionStatus(JOB), "running(thinking)",
      "a streaming run with no active tool reports thinking");
    let returned = false;
    const interrupt = h.runner.interrupt(JOB, { from: `${SESSION}:main` }).then((result) => {
      returned = true;
      return result;
    });
    // No released provider and no successor yet: only the abort request can
    // settle this call. A second macrotask is enough to expose an idle await.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(returned, true, "interrupt must not await SDK idle");
    releaseHeld();
    assert.deepEqual(await interrupt, { accepted: true });
    await noticeStarted;
    assert.equal(deliveryEntries(h, "Interrupted by").length, 1);
    releaseNotice();
    const ended = await outcome;
    assert.equal(ended.status, "completed");
    assert.equal(h.runner.executionStatus(JOB), null, "no execution status survives the Job");
    assert.equal(h.faux.state.callCount, 3, "held run, notice turn, finish reminder");
  } finally {
    releaseHeld();
    releaseNotice();
    await h.close();
  }
});
