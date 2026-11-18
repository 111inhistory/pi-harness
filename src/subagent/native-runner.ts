/**
 * The native half of one Subagent Job.
 *
 * Extraction of the host adapter's `startPiJob` into a typed runner: it opens
 * the child SDK session, owns its AbortController, composes the startup prompt,
 * steers peer input natively while the run streams, parks everything else in
 * the Job's own buffer, replays the SDK's parked queues as further turns of the
 * same Job, and reads the run's own result.
 *
 * Ownership split (do not blur it):
 *
 * - The Subagent runtime alone decides a Job's status, interruption, stopping
 *   and revival.
 * - The runner owns the physical session, its AbortController, the per-Job
 *   admission gate (`closed`), the pending-input buffer and the in-flight
 *   steers. It never writes a logical Job status and never revives an actor.
 *
 * Input hand-over is an admission, not a run: a steer is registered before it
 * is awaited so the end-of-turn loop cannot dispose the session underneath it,
 * and a message accepted into the buffer is delivered by that loop as one more
 * turn of this Job. A message native steering already took is owned by the SDK
 * session and is never replayed.
 */

import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

import { capabilityAllowsTool, capabilityAvailableTools } from "../capability/scope.ts";
import { installModelCallBudget } from "./pi-job-budget.ts";
import { excludedPresetTools } from '../preset/modifiers.ts';
import { SHELL_APPROVAL_WAIT } from '../shell-approval/bridge.ts';
import { resolveSessionCacheKey } from "../session-cache-runtime.ts";
import { formatAddress, parseAddress, MAIN_ACTOR } from './address.ts';
import {
  batchContextText, childContext, childPromptBlocks, composeAssignment, continuationControlPrompt,
  interruptionNotice, msgWriteReminder,
} from './prompt.ts';
import { readTranscript } from "./view.ts";
import { deliveryEntryFor, deliveryMessage, peerDeliveryEntry } from "./delivery.ts";
import { takeQueuedMessages } from "./lifecycle.ts";
import { harnessToolsForDepth, inheritedToolNames } from "./tool-policy.ts";
import { SubagentError } from "./runtime.ts";
import type {
  BudgetTerminal,
  InheritedContext,
  JobBudgetPort,
  JobRequest,
  RuntimeDelivery,
} from "./runtime.ts";
import type {
  NativeChildApi,
  NativeCustomContent,
  NativeCustomHandoff,
  NativeCustomMessage,
  NativeExecution,
  NativeHandoffResult,
  NativeJobOutcome,
  NativeInterruptNotice,
  NativeInterruptResult,
  NativeJobRunnerDeps,
  NativeLiveSnapshot,
  NativeModelRef,
  NativePeerHandoff,
  NativePendingCustom,
  NativePendingInput,
  NativeRetainedActor,
  NativeSession,
  NativeSessionEvent,
  NativeStartedJob,
} from "./native-types.ts";

/** Maximum tool-call-bearing turns the finish guard inspects. */
const MSG_WRITE_ROUND_WINDOW = 5;

/** The custom type of the one self reminder the finish guard may append. */
const MSG_WRITE_REMINDER_CUSTOM_TYPE = "subagent-reminder";

/**
 * Message-write presence of one live native run.
 *
 * The finish guard only needs to know whether this Job attempted `msg_write`
 * in a recent tool-call-bearing turn; targets, arguments and outcomes are never
 * retained, and the tracker is dropped together with its LiveJob.
 */
class RunWritePresence {
  readonly #roundTools = new Set<string>();
  /** Last tool-call-bearing turns: true when msg_write was attempted. */
  readonly #rounds: boolean[] = [];

  observe(event: NativeSessionEvent): void {
    const record = event as { type?: string; toolName?: unknown };
    switch (record.type) {
      case "agent_start":
      case "turn_start":
        this.#roundTools.clear();
        return;
      case "tool_execution_start":
        if (typeof record.toolName === "string") this.#roundTools.add(record.toolName);
        return;
      case "turn_end":
        // One round is one assistant turn that bore at least one tool call. Only
        // the presence of msg_write is kept; targets, arguments and outcomes are
        // not retained.
        if (this.#roundTools.size > 0) {
          this.#rounds.push(this.#roundTools.has("msg_write"));
          while (this.#rounds.length > MSG_WRITE_ROUND_WINDOW) this.#rounds.shift();
        }
        this.#roundTools.clear();
        return;
      case "agent_end":
        this.#roundTools.clear();
        return;
      default:
        return;
    }
  }

  /** Whether msg_write was attempted in any inspected tool-call-bearing turn. */
  hasRecentWrite(): boolean {
    return this.#rounds.some(Boolean);
  }
}

/**
 * One live native run. Everything here is physical and per-Job: the session,
 * its execution wrapper, the AbortController and the input gate. `closed` is
 * the admission gate — it is set by this Job's cancel path or by the end-of-turn
 * loop in the same synchronous step that observes an empty buffer, so a
 * hand-over either lands inside a round or is refused.
 */
class LiveJob {
  readonly jobId: string;
  readonly agentId: string;
  readonly abort = new AbortController();
  readonly steers = new Set<Promise<unknown>>();
  readonly pending: NativePendingInput[] = [];
  session: NativeSession | null = null;
  execution: NativeExecution | null = null;
  child: NativeChildApi | null = null;
  closed = false;
  cancelled = false;
  /** Observers of the full native event stream; they never affect the Job. */
  readonly listeners = new Set<(event: NativeSessionEvent) => void>();
  /** Latest cumulative assistant partial being streamed, for a live snapshot. */
  latestPartial: unknown | null = null;
  /** Message-write presence of this run for the finish guard. */
  readonly writes = new RunWritePresence();
  /** Active SDK tool calls with their start clock; read-only status input. */
  readonly toolStarts = new Map<string, number>();
  /** Interrupts admitted during this Job; a turn whose mark moved was cut. */
  interruptCount = 0;
  /** The one finish-time msg_write reminder has been offered. */
  reminded = false;
  /** Reads the run's current end boundary once its session exists. */
  endEntryId: (() => string | null) | null = null;
  /** Reads the run's current boundary and produced content once its session exists. */
  snapshot: (() => NativeLiveSnapshot) | null = null;
  wake: (() => void) | null = null;
  readonly ready: Promise<void>;
  sessionReady!: () => void;
  startupFailed!: (error: unknown) => void;

  constructor(request: JobRequest) {
    this.jobId = request.jobId;
    this.agentId = request.agentId;
    this.ready = new Promise<void>((resolve, reject) => {
      this.sessionReady = resolve;
      this.startupFailed = reject;
    });
    void this.ready.catch(() => {});
    for (const delivery of request.pendingMessages) this.pending.push(pendingInputOf(delivery));
  }

  /** Cancel this native run: the Job's own status stays with the runtime. */
  cancel(): void {
    // Idempotent like the shared execution's abort: a repeated cancel of the
    // same Job must not reach the SDK session twice.
    if (this.cancelled) return;
    this.cancelled = true;
    this.closed = true;
    this.wake?.();
    this.abort.abort();
    const pending = this.execution?.abort();
    if (pending !== undefined) void pending.catch(() => {});
  }
}

/**
 * The native Job runner. One instance serves one root service; the root service
 * decides whether a Job exists at all, which actor it continues and what a
 * terminal outcome means.
 */
export class NativeJobRunner {
  readonly #deps: NativeJobRunnerDeps;
  readonly #jobs = new Map<string, LiveJob>();

  constructor(deps: NativeJobRunnerDeps) {
    this.#deps = deps;
  }

  /**
   * Start one Job's native run and return its physical handle. The runtime
   * owns the returned `done` outcome's adjudication.
   */
  start(request: JobRequest): NativeStartedJob {
    const live = new LiveJob(request);
    // Register before the async body runs: a hand-over racing startup must find
    // this Job and be buffered, never be answered as an unknown Job.
    this.#jobs.set(request.jobId, live);
    const done = this.#run(request, live);
    void done.then((outcome) => live.startupFailed(outcome.error ?? new Error(`Agent ${request.agentId} ended before its session was ready.`)),
      (error: unknown) => live.startupFailed(error));
    return { done, ready: live.ready, cancel: () => { live.cancel(); } };
  }

  /** Wake the existing run when its last child settles, without allocating a Job. */
  wake(agentId: string): void {
    for (const live of this.#jobs.values()) {
      if (live.agentId === agentId && !live.closed) live.wake?.();
    }
  }

  /** The installed child surface of an actor's live run (capability parent scope). */
  childScope(agentId: string): NativeChildApi | null {
    for (const live of this.#jobs.values()) {
      if (live.agentId === agentId && live.child !== null && !live.closed) return live.child;
    }
    return null;
  }

  /**
   * Observe one live Job's full native event stream. Returns null when the Job
   * has no live run (unknown, finished, or not yet started under the runner).
   * The returned function detaches only this observer; it never touches the Job.
   */
  subscribeJobEvents(jobId: string, listener: (event: NativeSessionEvent) => void): (() => void) | null {
    const live = this.#jobs.get(jobId);
    if (live === undefined || live.closed) return null;
    live.listeners.add(listener);
    return () => {
      live.listeners.delete(listener);
    };
  }

  /**
   * Read one live run's current end boundary. Returns undefined when the Job
   * has no live run; null is a real live boundary (the leaf is not recorded).
   */
  liveEndEntryId(jobId: string): string | null | undefined {
    const live = this.#jobs.get(jobId);
    if (live === undefined || live.closed || live.endEntryId === null) return undefined;
    return live.endEntryId();
  }

  /**
   * Read one live run's stream projection. Returns null when the Job has no
   * live run. Reading is a projection and never consumes the event stream.
   */
  liveSnapshot(jobId: string): NativeLiveSnapshot | null {
    const live = this.#jobs.get(jobId);
    if (live === undefined || live.closed || live.snapshot === null) return null;
    return live.snapshot();
  }

  /**
   * The live execution status of one Job as a single string, or null when no
   * phase is observable.
   *
   * A streaming run with active tool calls reports `running(tool-<n>s)` from
   * the earliest still-active tool start; a streaming run without one reports
   * `running(thinking)`. Null covers an unknown or closed Job and a session that
   * is no longer streaming, so the caller keeps its own lifecycle status (bare
   * `running`). Reads retain nothing and start no timer.
   */
  executionStatus(jobId: string): string | null {
    const live = this.#jobs.get(jobId);
    if (live === undefined || live.closed || live.session?.isStreaming !== true) return null;
    if (live.toolStarts.size === 0) return "running(thinking)";
    let earliest = Number.POSITIVE_INFINITY;
    for (const startedAt of live.toolStarts.values()) earliest = Math.min(earliest, startedAt);
    const seconds = Math.max(0, Math.floor((performance.now() - earliest) / 1000));
    return `running(tool-${seconds}s)`;
  }

  /**
   * Interrupt one live Job's current native work.
   *
   * The SDK exposes one run-level abort and no per-tool handle, so this cancels
   * the executing tool together with the in-flight model turn. The admitted
   * sender-bound notice then becomes one more turn of the SAME Job, Actor and
   * Budget through the ordinary pending-input path; nothing is retried,
   * rolled back or split into another Job, and a Job stop is never implied.
   */
  async interrupt(jobId: string, notice: NativeInterruptNotice): Promise<NativeInterruptResult> {
    const live = this.#jobs.get(jobId);
    if (live === undefined || live.closed || live.cancelled) {
      return { accepted: false, reason: "job_closed" };
    }
    // Admit the notice before the abort: the aborted turn must not be able to
    // outrun the entry that explains why it was cut. The increment marks this
    // turn as deliberately interrupted so its aborted message is not read as
    // the Job's own answer.
    live.interruptCount += 1;
    const entry = peerDeliveryEntry({ ...notice, content: notice.content ?? interruptionNotice(notice.from) });
    live.pending.push({ kind: "custom", from: entry.sourceId, message: deliveryMessage(entry) });
    live.wake?.();
    const execution = live.execution;
    if (execution !== null && live.session?.isStreaming === true) {
      // Request the run-level abort without awaiting SDK idle. The SDK applies
      // the abort synchronously before its first await, but its idle wait can
      // include a successor run: this drain loop may immediately start the next
      // turn (this admitted notice, or parked work) once the cut run settles.
      // Awaiting idle here would therefore wait for that successor, not just
      // the interrupted run, and a held successor would hang the signal call.
      void execution.abort().catch(() => {
        // The notice stays admitted; the drain loop still delivers it when the
        // current turn ends. Interruption is not a Job outcome.
      });
    }
    if (live.cancelled) return { accepted: false, reason: "job_closed" };
    return { accepted: true };
  }

  /**
   * Hand one peer message to a live run. The message becomes the same
   * agent-delivery custom entry the delivery router uses, keeping its sender
   * round and Job id. While the session streams the SDK takes it as a native
   * custom steer; otherwise it is buffered as its own event and delivered by
   * this Job's end-of-turn loop, never concatenated with another message.
   */
  async handoff(jobId: string, message: NativePeerHandoff): Promise<NativeHandoffResult> {
    const live = this.#jobs.get(jobId);
    if (live === undefined || live.closed) return { accepted: false, reason: "job_closed" };
    const entry = peerDeliveryEntry({
      from: message.from,
      content: message.content,
      round: message.round,
      jobId: message.jobId,
      ...(message.external === undefined ? {} : { external: message.external }),
    });
    return this.#handoffMessage(live, entry.sourceId, deliveryMessage(entry), true);
  }

  /**
   * Hand one custom envelope to a live run. A streaming session takes it as a
   * native custom steer; an idle or not-yet-started session must not start a
   * second LLM loop, so the envelope is buffered as its own event for this
   * Job's own loop.
   */
  async handoffCustom(jobId: string, envelope: NativeCustomHandoff): Promise<NativeHandoffResult> {
    const live = this.#jobs.get(jobId);
    if (live === undefined || live.closed) return { accepted: false, reason: "job_closed" };
    const message: NativeCustomMessage = {
      role: "custom",
      customType: envelope.customType,
      content: envelope.content,
      display: envelope.display,
      details: envelope.details,
      timestamp: Date.now(),
    };
    return this.#handoffMessage(live, envelope.from, message, false);
  }

  /**
   * The one admission path for custom input. An idle/setup buffer entry is
   * appended later with `triggerTurn:false`; a streaming steer is registered
   * before it is awaited so the drain cannot dispose the session underneath it.
   * An SDK rejection is not proof that nothing was enqueued, so it is reported
   * as `delivery_uncertain` instead of a safe refusal.
   */
  async #handoffMessage(
    live: LiveJob,
    from: string,
    message: NativeCustomMessage,
    uncertainFailure: boolean,
  ): Promise<NativeHandoffResult> {
    const session = live.session;
    if (session === null || !session.isStreaming) {
      live.pending.push({ kind: "custom", from, message });
      live.wake?.();
      return { accepted: true, mode: "pending" };
    }
    const body = {
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
    };
    // The steer's rejection is captured so the drain never awaits a rejected
    // promise; the caller still sees the failure at the hand-over site.
    const steer = (async (): Promise<{ error: unknown } | null> => {
      try {
        await session.sendCustomMessage(body, { triggerTurn: true, deliverAs: "steer" });
        return null;
      } catch (error) {
        return { error };
      }
    })();
    live.steers.add(steer);
    live.wake?.();
    let failure: { error: unknown } | null;
    try {
      failure = await steer;
    } finally {
      live.steers.delete(steer);
    }
    if (failure !== null) {
      // A peer hand-over cannot prove the SDK enqueued nothing: report the one
      // uncertain code the runtime already understands. A custom envelope keeps
      // the caller's own error contract.
      if (uncertainFailure) throw new SubagentError('delivery_uncertain', `The SDK handoff failed: ${errorMessage(failure.error)}`);
      throw failure.error;
    }
    return { accepted: true, mode: "steered" };
  }

  #run(request: JobRequest, live: LiveJob): Promise<NativeJobOutcome> {
    const deps = this.#deps;
    const isContinuation = request.spec.kind === "continuation";
    const depth = request.depth ?? 0;
    // One resolved snapshot decides this Job's depth boundary and guidance.
    const { maxDepth, prompts } = deps.config.harness.subagent;
    const origin = readOrigin(request.origin);
    let sessionManager: SessionManager | null = null;
    let boundary: string | null = null;
    let boundaryEstablished = false;
    let execution: NativeExecution | null = null;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeBudget: (() => void) | null = null;
    let unsubscribeApproval: (() => void) | null = null;
    let updateRetainedTools: (() => void) | null = null;
    let finalizeActor: (() => void) | null = null;

    // One reusable cleanup set: the execution handle owns it once a native
    // session exists, and the failure path before creation still releases it.
    const releaseJobResources = (): void => {
      unsubscribeBudget?.();
      unsubscribeApproval?.();
      unsubscribe?.();
    };

    const done = (async (): Promise<NativeJobOutcome> => {
      // A retired or storage-fenced service must not start native work. This is
      // the start admission only; writes are governed by `mayPersist`.
      if (deps.root.storageError !== null) throw deps.root.storageError;
      if (!deps.root.canStartJob) {
        throw new SubagentError("runtime_closed", "This subagent runtime was retired; the Job was not started.");
      }

      // A continuation whose actor never started rebuilds its first native
      // session from the original inherited snapshot; a retained actor ignores
      // the seed. The Actor's goal, batch context and launch roster arrive on
      // every JobRequest, so a revived execution never has to restate identity.
      const retained = isContinuation ? deps.actors.get(request.agentId) : null;
      const snapshot: InheritedContext | null = retained === null ? request.spec.inheritedContext : null;
      // An Inherited actor keeps its captured parent identity; a Fresh actor
      // routes. A retained descriptor is authoritative for an already-settled
      // actor, including an Inherited one revived from disk.
      const inherited = retained === null && snapshot !== null;
      const cwd = retained?.cwd ?? stringField(snapshot, "cwd") ?? origin.cwd ?? process.cwd();
      const trusted = retained === null ? origin.trusted : retained.trusted;
      deps.sessions.assertModelRuntime();
      throwIfBudgetFailed(request.budget);

      // The launch roster is rendered once for this Job; only the Actor's
      // persistent goal and the batch's shared context feed the assignment.
      const assignment = composeAssignment(request.goal, batchContextText({
        context: request.context ?? "",
        roster: request.roster,
      }));
      // What this Job must restate: a first Job carries its own assignment, a
      // continuation carries whatever its conversation never recorded.
      let pendingAssignment = retained !== null ? retained.assignment : assignment;

      // Identity the Job runs with. An Inherited Job keeps the captured parent
      // identity; a settled actor keeps the role/model/loadout already recorded;
      // only a Fresh Job whose routing never completed routes here.
      let identitySettled = retained !== null ? retained.routed : inherited;
      let roleId = retained?.roleId ?? null;
      let roleInstructions = retained?.roleInstructions ?? null;
      let systemPrompt = retained?.systemPrompt
        ?? (inherited && typeof snapshot?.["systemPrompt"] === "string" ? snapshot["systemPrompt"] : null);
      let model: Model<Api> | null = retained?.model ?? null;
      let thinkingLevel = retained?.thinkingLevel ?? null;
      let plannedTools: readonly string[] | null = retained?.tools ?? null;
      let preset = retained?.preset ?? null;
      const retainedRole = retained?.roleId ?? null;
      let excludedTools: readonly string[] | null = retained?.excludedTools
        ?? (retainedRole !== null && retainedRole !== ""
          ? NATIVE_TOOL_NAMES.filter((name) => !plannedTools?.includes(name))
          : []);
      if (retained?.preset !== null && retained?.preset !== undefined) {
        // Keep the durable Actor.excludedTools meaning, but evaluate a retained
        // Preset's current execution exclusions from its recorded config.
        excludedTools = excludedPresetTools(retained.preset.config.tools);
      }
      if (retained !== null && retained.routed && retained.modelRef !== null && model === null) {
        const ref = retained.modelRef;
        throw new SubagentError(
          "model_unavailable",
          `The model ${ref.provider}/${ref.id} recorded for ${request.agentId} is not in the model ` +
            "catalog, so its conversation cannot continue on it.",
          { agentId: request.agentId, model: ref },
        );
      }
      if (retained === null && inherited) {
        // The captured parent identity: same model, thinking level, prompt. An
        // Inherited Job never routes; resolving the captured model through the
        // catalog keeps the same identity on a refreshed catalog entry.
        model = deps.models.inherited(snapshot?.["model"] ?? null);
        thinkingLevel = typeof snapshot?.["thinkingLevel"] === "string" ? snapshot["thinkingLevel"] : null;
        plannedTools = inheritedToolNames(deps.tools.catalog(), snapshot?.["tools"], depth, maxDepth);
        identitySettled = true;
      } else if (!identitySettled) {
        const routed = await deps.routing.route({
          task: request.goal,
          context: request.context ?? "",
          cwd, trusted,
          signal: live.abort.signal,
          budget: request.budget,
        });
        throwIfBudgetFailed(request.budget);
        roleId = routed.roleId;
        roleInstructions = routed.instructions;
        model = routed.model;
        thinkingLevel = routed.thinkingLevel;
        preset = routed.preset;
        excludedTools = excludedPresetTools(preset.config.tools);
        identitySettled = true;
      }

      sessionManager = retained?.sessionManager
        ?? deps.actors.open({ agentId: request.agentId, retained, seed: snapshot, cwd });
      const manager = sessionManager;
      deps.actors.restoreLeaf({ manager, agentId: request.agentId, retained, seed: snapshot });
      boundary = manager.getLeafId();
      boundaryEstablished = true;
      request.recordStart(boundary);
      const sessionFile = deps.actors.durable ? manager.getSessionFile() ?? null : null;
      // A Fresh actor may create Inherited children; an Inherited actor may not
      // nest another inherited capture.
      const allowInherited = retained === null ? !inherited : retained.allowInherited;
      const fixedExcludedTools = depth >= maxDepth
        ? ["capability", "subagent_create", "subagent_signal"]
        : [];
      const executionExcludedTools = excludedTools ?? [];

      // Effective fields are refreshed as soon as the native session exists.
      const effective: {
        tools: string[] | null;
        model: Model<Api> | null;
        thinkingLevel: string | null;
      } = { tools: null, model: null, thinkingLevel: null };
      // Keep the live manager in one descriptor. Identity changes emit field
      // patches; ordinary message progress stays in the native child file.
      const retain = (): void => {
        const descriptor: NativeRetainedActor = {
          sessionManager: manager,
          sessionFile,
          anchor: deps.actors.recordedAnchor(manager, retained?.anchor ?? null),
          cwd,
          trusted,
          allowInherited,
          systemPrompt,
          roleId,
          roleInstructions,
          preset,
          modelRef: modelRefOf(effective.model ?? model),
          model: effective.model ?? model,
          thinkingLevel: effective.thinkingLevel ?? thinkingLevel,
          tools: effective.tools ?? plannedTools,
          excludedTools,
          assignment: pendingAssignment,
          routed: identitySettled,
        };
        deps.actors.retain(request.agentId, descriptor);
      };
      retain();
      const inheritedCacheKey = snapshot !== null
        ? (typeof snapshot["cacheKey"] === "string" || snapshot["cacheKey"] === null
            ? (snapshot["cacheKey"] as string | null)
            : resolveSessionCacheKey(manager))
        : undefined;
      // The native manager now owns the isolated in-memory seed. Keep no second
      // seed in the Job registry.
      if (snapshot !== null) delete snapshot["entries"];

      const opened = await deps.sessions.open({
        ...(preset !== null && plannedTools === null ? { preset } : {}),
        ...(roleId === null && plannedTools !== null ? { inheritedTools: plannedTools } : {}),
        agentId: request.agentId,
        cwd,
        trusted,
        systemPrompt,
        appendSystemPrompt: childPromptBlocks({
          roleInstructions,
          // Common guidance applies to Fresh and Inherited alike; the inherited
          // section belongs only to an actor that captured its parent context.
          common: prompts.common,
          inherited: roleId === null,
          inheritedPrompt: prompts.inherited,
          context: childContext(request.address, request.parentAddress ?? formatAddress(sessionOfAddress(request.address), MAIN_ACTOR)),
        }),
        model,
        thinkingLevel,
        excludedTools: executionExcludedTools,
        fixedExcludedTools,
        sessionManager: manager,
        surface: {
          senderId: request.agentId,
          parentAgentId: request.agentId,
          capabilityParentId: request.parentAgentId,
          depth,
          maxDepth,
          cwd,
          allowInherited,
          excludedTools: executionExcludedTools,
        },
        signal: live.abort.signal,
        cacheKey: inheritedCacheKey,
      });
      // Creation owns the SDK Session immediately: the returned execution handle
      // is registered here, before the next Budget check can throw.
      execution = opened.execution;
      const native = opened.execution;
      live.session = native.session;
      live.execution = native;
      live.child = opened.capabilityScope;
      native.addCleanup(releaseJobResources);
      throwIfBudgetFailed(request.budget);
      plannedTools = [...new Set([
        ...(plannedTools ?? native.session.getActiveToolNames()),
        ...harnessToolsForDepth(depth, maxDepth),
      ])];
      native.session.setActiveToolsByName(
        plannedTools.filter((name) => capabilityAllowsTool(opened.capabilityScope, name)),
      );
      capabilityAvailableTools(opened.capabilityScope);
      // The session's own loadout and model are what a revival must reuse:
      // capability activation opens tools during the run that the pre-run seed
      // never mentioned, and a run that was stopped still keeps them.
      effective.tools = activeToolNames(native.session);
      effective.model = native.session.model ?? null;
      effective.thinkingLevel = native.session.thinkingLevel ?? null;
      retain();
      updateRetainedTools = (): void => {
        const tools = activeToolNames(native.session);
        if (tools !== null) effective.tools = tools;
        retain();
      };
      finalizeActor = (): void => {
        updateRetainedTools?.();
        retain();
      };
      // The budget hook only debits the session's own Agent stream boundary and
      // aborts through the session; hand it those two live handles explicitly.
      unsubscribeBudget = installModelCallBudget(
        {
          ...(native.session.agent !== undefined ? { agent: native.session.agent } : {}),
          abort: () => native.session.abort(),
        },
        request.budget,
      );

      // Root TUI owns the actual dialog; the child's bus accounts for its wait.
      let approvalsWaiting = 0;
      unsubscribeApproval = opened.capabilityScope.events?.on(SHELL_APPROVAL_WAIT, pending => {
        if (pending === true) {
          if (approvalsWaiting++ === 0) request.pauseActive();
        } else if (pending === false && approvalsWaiting > 0) {
          approvalsWaiting -= 1;
          if (approvalsWaiting === 0 && !live.cancelled) request.resumeActive();
        }
      }) ?? null;
      // This Job's history is scoped by the append-only SessionManager tree: the
      // boundary is the leaf at start, and native compaction appends entries
      // instead of rewriting or dropping them.
      const jobMessages = (): unknown[] => messagesAfter(manager, boundary);
      // The live stream projection is read only by stream.subscribe. History
      // reads the end boundary alone, so neither caller builds unused arrays.
      live.endEntryId = () => manager.getLeafId();
      live.snapshot = () => ({
        endEntryId: manager.getLeafId(),
        messages: jobMessages(),
        partial: live.latestPartial,
      });

      let jobErr: unknown = null;

      if (!live.cancelled) {
        // Tool activation can change identity during a run. Observe its
        // finalized boundaries without copying history or appending per-turn
        // root state.
        unsubscribe = native.session.subscribe((event) => {
          // Track msg_write presence before observers run; the guard must see
          // the same turn this event belongs to.
          live.writes.observe(event);
          // Execution status reads the earliest active tool start. Identity is
          // the SDK toolCallId, so parallel calls keep independent start clocks
          // and one call ending never hides another.
          if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
            const { toolCallId } = event as { toolCallId?: unknown };
            if (typeof toolCallId === "string") {
              if (event.type === "tool_execution_start") live.toolStarts.set(toolCallId, performance.now());
              else live.toolStarts.delete(toolCallId);
            }
          } else if (event.type === "agent_end") {
            live.toolStarts.clear();
          }
          // Full-stream observers see the raw native event; an observer failure
          // must never affect the Job's own turn accounting.
          for (const listener of live.listeners) {
            try {
              listener(event);
            } catch {
              /* observation is best-effort and never blocks execution */
            }
          }
          const record = event as { type?: string; message?: unknown };
          if (record.type === "message_update") live.latestPartial = record.message ?? null;
          else if (record.type === "message_end" || record.type === "agent_end") live.latestPartial = null;
          if (event.type !== "message_end" && event.type !== "turn_end" && event.type !== "agent_end") return;
          updateRetainedTools?.();
        });

        // Every event this Job owns is already one native custom entry; the
        // prompt below is only the run's control prompt. It never contains the
        // bodies, so nothing is concatenated or delivered twice.
        const assigned = live.pending.splice(0);
        if (isContinuation && assigned.length === 0) {
          throw new SubagentError(
            "continuation_unavailable",
            `Continuation Job ${request.jobId} has no message to deliver.`,
          );
        }
        const prompt = isContinuation
          ? continuationControlPrompt(pendingAssignment)
          : pendingAssignment ?? "";
        // The assignment belongs to the conversation as soon as the session
        // recorded anything; until then a later revival must restate it.
        const markAssignmentDelivered = (): void => {
          if (pendingAssignment === null) return;
          if (jobMessages().length === 0) return;
          pendingAssignment = null;
          retain();
        };

        try {
          throwIfBudgetFailed(request.budget);
          // Append each buffered event as its own native entry BEFORE the
          // single control prompt. `triggerTurn:false` keeps that prompt the
          // only model call of this step and adds no scheduler.
          for (const entry of assigned) await appendCustomMessage(native.session, entry.message);
          // Whatever the run then does — finish, fail or be stopped — its own
          // outcome decides the Job; the prompt submission itself is final.
          if (live.cancelled) throw new SubagentError('cancelled', 'Subagent startup was cancelled.');
          // Local setup and initial input are complete. Provider projection,
          // authentication and execution now belong to the background run.
          live.sessionReady();
          try {
            await runClassifiedTurn(live, manager, async () => {
              await native.prompt(prompt, { expandPromptTemplates: false });
            });
          } finally {
            markAssignmentDelivered();
          }
          throwIfBudgetFailed(request.budget);
          if (!live.cancelled) {
            await drainLiveMessages(live, manager, request, deps.work);
            throwIfBudgetFailed(request.budget);
          }
        } catch (error) {
          jobErr = error;
        }
      } else {
        try {
          await native.abort();
        } catch {
          // Cancellation before the run started has nothing to stop.
        }
      }

      if (jobErr !== null) throw jobErr;
      return {
        status: live.cancelled ? "cancelled" : "completed",
        result: readFinalText(jobMessages()),
        transcript: readTranscript(entriesAfter(manager, boundary)),
        history: { startEntryId: boundary, endEntryId: manager.getLeafId() },
      };
    })().catch((error: unknown): NativeJobOutcome => ({
      status: "failed",
      error,
      result: sessionManager === null || !boundaryEstablished ? '' : readFinalText(messagesAfter(sessionManager, boundary)),
      history: sessionManager === null || !boundaryEstablished ? null : { startEntryId: boundary, endEntryId: sessionManager.getLeafId() },
      transcript: sessionManager === null || !boundaryEstablished ? [] : readTranscript(entriesAfter(sessionManager, boundary)),
    })).finally(async (): Promise<void> => {
      live.closed = true;
      live.listeners.clear();
      live.endEntryId = null;
      live.snapshot = null;
      live.latestPartial = null;
      live.toolStarts.clear();
      this.#jobs.delete(request.jobId);
      // A revival reuses the loadout the run actually ended with — capability
      // activation can open tools mid-run — never the pre-run allowlist. The
      // final checkpoint belongs to the context that owns it (`mayPersist`),
      // which is not the same question as whether a new Job may start.
      if (deps.root.mayPersist) finalizeActor?.();
      if (execution === null) {
        releaseJobResources();
        return;
      }
      try {
        await execution.dispose();
      } catch (error) {
        deps.notify?.(`Subagent session cleanup failed for ${request.agentId}: ${errorMessage(error)}`, "error");
      }
    });

    return done;
  }
}

/**
 * Deliver everything this Job still owns as further turns of the same Job and
 * Budget: texts native steering left parked when the run settled, and messages
 * buffered while no stream was active. Clearing the native queue hands each
 * parked text to this loop exactly once, so nothing is replayed.
 *
 * The loop first waits for every steer that is still in flight, then checks
 * sources and only closes when both queues and the owned work set are empty.
 * A parent waiting for children or shell tasks keeps this Job and session, pauses active-time
 * accounting, and wakes on new input, final-child settlement or cancellation.
 * A hand-over therefore lands inside this Job or is refused by the closed flag.
 */
async function drainLiveMessages(
  live: LiveJob, sessionManager: SessionManager, request: JobRequest,
  work: NativeJobRunnerDeps['work'],
): Promise<void> {
  const session = live.session;
  if (session === null) return;
  for (;;) {
    if (live.cancelled) return;
    while (live.steers.size > 0) await Promise.all([...live.steers]);
    if (live.cancelled) return;
    const parked = takeParkedMessages(session);
    const buffered = live.pending.splice(0);
    if (parked.length === 0 && buffered.length === 0) {
      if (work.hasPending(live.agentId)) {
        await waitForWork(live, request, work);
        continue;
      }
      // Normal finish: one opportunity to send the explicit msg_write the
      // recent tool rounds never produced. The decision is recorded before the
      // turn is awaited, so no later loop can offer a second reminder.
      if (!live.reminded && !live.writes.hasRecentWrite()) {
        live.reminded = true;
        await remindMissingMsgWrite(live, request, sessionManager);
        continue;
      }
      live.closed = true;
      return;
    }
    // Replay each parked native message unchanged, with its original type.
    for (const message of parked) {
      if (live.cancelled) return;
      const custom = readParkedCustom(message);
      if (custom !== null) await replayParkedCustom(live, sessionManager, custom);
      else await replayParkedUser(live, sessionManager, message);
    }
    if (buffered.length > 0 && !live.cancelled) {
      // Buffered events were never handed to the SDK. Append each one as its
      // own native entry and let ONE control prompt consume them all: no
      // per-message model loop, no concatenated body.
      for (const entry of buffered) await appendCustomMessage(session, entry.message);
      await runClassifiedTurn(live, sessionManager, async () => {
        await requireExecution(live).prompt(continuationControlPrompt(null), { expandPromptTemplates: false });
      });
    }
  }
}

async function waitForWork(
  live: LiveJob, request: JobRequest, work: NativeJobRunnerDeps['work'],
): Promise<void> {
  // Install the signal before pausing; pause can observe expiry and cancel the run.
  const wake = new Promise<void>(resolve => { live.wake = resolve; });
  let paused = false;
  try {
    request.pauseActive();
    paused = true;
    if (live.cancelled || live.pending.length > 0 || !work.hasPending(live.agentId)) live.wake?.();
    await wake;
  } finally {
    live.wake = null;
    if (paused && !live.cancelled) request.resumeActive();
  }
}

async function replayParkedCustom(
  live: LiveJob,
  sessionManager: SessionManager,
  message: NativeCustomMessage,
): Promise<void> {
  const session = live.session;
  if (session === null) return;
  // The supported AgentSession path preserves customType/display/details and
  // runs the same ModelCall Budget hooks as any other turn.
  const operation = (async (): Promise<void> => {
    await session.sendCustomMessage({
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
    }, { triggerTurn: true, deliverAs: "steer" });
  })();
  live.steers.add(operation);
  try {
    await runClassifiedTurn(live, sessionManager, async () => { await operation; });
  } finally {
    live.steers.delete(operation);
  }
}

async function replayParkedUser(live: LiveJob, sessionManager: SessionManager, message: unknown): Promise<void> {
  const content = readParkedUser(message);
  if (content.text.trim() === "" && content.images.length === 0) return;
  await runClassifiedTurn(live, sessionManager, async () => {
    await requireExecution(live).prompt(content.text, {
      expandPromptTemplates: false,
      ...(content.images.length > 0 ? { images: content.images } : {}),
    });
  });
}

/**
 * Classify one prompt turn after it settles. An aborted assistant message is a
 * real failure only when the turn was not deliberately cut: an admitted
 * interrupt increments the Job's mark, and the aborted message is then the
 * expected shape of the cut, never the Job's own answer.
 */
async function runClassifiedTurn(
  live: LiveJob,
  sessionManager: SessionManager,
  operation: () => Promise<void>,
): Promise<void> {
  const boundary = sessionManager.getLeafId();
  const interrupts = live.interruptCount;
  await operation();
  if (live.cancelled) return;
  if (live.interruptCount !== interrupts) return;
  assertRunCompleted(messagesAfter(sessionManager, boundary));
}

/**
 * Offer the one finish-time self reminder when the recent tool-call-bearing
 * turns never attempted msg_write.
 *
 * The reminder is one self entry in the same native session and Budget. It
 * never forces a send, never starts a second Job and is used at most once;
 * the drain loop records that decision before awaiting this turn.
 */
async function remindMissingMsgWrite(
  live: LiveJob,
  request: JobRequest,
  sessionManager: SessionManager,
): Promise<void> {
  const session = live.session;
  if (session === null || live.cancelled) return;
  throwIfBudgetFailed(request.budget);
  await runClassifiedTurn(live, sessionManager, async () => {
    await session.sendCustomMessage({
      customType: MSG_WRITE_REMINDER_CUSTOM_TYPE,
      content: msgWriteReminder,
      display: false,
      details: null,
    }, { triggerTurn: true });
  });
  if (!live.cancelled) throwIfBudgetFailed(request.budget);
}

function requireExecution(live: LiveJob): NativeExecution {
  const execution = live.execution;
  if (execution === null) {
    throw new SubagentError("job_closed", `Job ${live.jobId} has no live SDK execution.`);
  }
  return execution;
}

/**
 * Remove and return every message parked in the session's own queues. They were
 * never consumed, so the Job's end-of-turn loop owns their delivery; a steering
 * message the run already consumed is gone from the queue and is never
 * replayed. Custom messages stay custom instead of being flattened.
 */
function takeParkedMessages(session: NativeSession): unknown[] {
  const agent = session.agent;
  if (agent === undefined || typeof agent.hasQueuedMessages !== "function" || !agent.hasQueuedMessages()) return [];
  let probeSequence = 0;
  // Both queue modes are forced to "all" only for this synchronous read; the
  // probes make `peekQueuedMessages()` select each queue in turn.
  const queued = takeQueuedMessages(agent, (queue) => ({
    role: "user",
    content: [{ type: "text", text: `\u0000subagent-queue-probe-${queue}-${++probeSequence}` }],
    timestamp: 0,
  }));
  // Agent queues are empty now; clear the AgentSession text mirrors without
  // dropping any custom message (they were returned above).
  session.clearQueue?.();
  return queued;
}

/** Native messages appended since a boundary, for run classification. */
function messagesAfter(sessionManager: SessionManager, boundary: string | null): unknown[] {
  const branch = sessionManager.getBranch();
  let start = 0;
  if (boundary !== null) {
    const at = branch.findIndex((entry) => entry.id === boundary);
    if (at === -1) return [];
    start = at + 1;
  }
  const messages: unknown[] = [];
  for (let index = start; index < branch.length; index += 1) {
    const entry = branch[index];
    if (entry?.type === "message") messages.push(entry.message);
  }
  return messages;
}

/**
 * Raw SessionManager entries appended since a boundary. A Job's history is
 * scoped by the append-only entry tree rather than the compaction-aware
 * projection: a summarization entry or projection cannot move the boundary or
 * truncate this Job's own entries.
 */
function entriesAfter(sessionManager: SessionManager, boundary: string | null): SessionEntry[] {
  const branch = sessionManager.getBranch();
  if (boundary === null) return branch;
  const at = branch.findIndex((entry) => entry.id === boundary);
  return at === -1 ? [] : branch.slice(at + 1);
}

/**
 * Classify the attempt that just settled. `AgentSession.prompt()` resolves on a
 * provider failure too — the transcript just keeps an assistant message with
 * `stopReason: "error"` — so a Job must inspect the run's own output instead of
 * assuming success, and it must never fall back to an earlier Job's answer.
 */
function assertRunCompleted(messages: readonly unknown[]): void {
  let last: Record<string, unknown> | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message["role"] === "assistant") {
      last = message;
      break;
    }
  }
  if (last === null) {
    throw new SubagentError(
      "empty_response",
      "The run produced no assistant message; the Job is marked failed instead of reporting an earlier answer.",
    );
  }
  const stopReason = last["stopReason"];
  if (stopReason === "error") {
    const errorMessage = last["errorMessage"];
    const detail = typeof errorMessage === "string" && errorMessage !== ""
      ? errorMessage
      : "the provider reported an error";
    throw new SubagentError("provider_error", `The provider request failed: ${detail}`, { stopReason });
  }
  if (stopReason === "aborted") {
    throw new SubagentError("run_aborted", "The run was aborted before it produced a final answer.", { stopReason });
  }
}

/** Final assistant text inside exactly these messages. */
function readFinalText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    const text = textOf(message["content"]);
    return message["stopReason"] === "toolUse" ? "" : text;
  }
  return "";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (isTextContent(part)) texts.push(part.text);
  }
  return texts.join("\n");
}

/**
 * Startup input is not prose to merge: it is the very envelope the delivery
 * path would have sent, kept as one independent entry per event. The shared
 * entry mapping preserves sender, round and Job id.
 */
function pendingInputOf(delivery: RuntimeDelivery): NativePendingCustom {
  const entry = deliveryEntryFor(delivery);
  return { kind: "custom", from: entry.sourceId, message: deliveryMessage(entry) };
}

/** Append one custom event with no turn of its own. */
async function appendCustomMessage(session: NativeSession, message: NativeCustomMessage): Promise<void> {
  await session.sendCustomMessage({
    customType: message.customType,
    content: message.content,
    display: message.display,
    details: message.details,
  }, { triggerTurn: false });
}

function readParkedCustom(value: unknown): NativeCustomMessage | null {
  if (!isRecord(value) || value["role"] !== "custom" || typeof value["customType"] !== "string") return null;
  return {
    role: "custom",
    customType: value["customType"],
    content: readCustomContent(value["content"]),
    display: value["display"] === true,
    details: value["details"],
    timestamp: typeof value["timestamp"] === "number" ? value["timestamp"] : 0,
  };
}

function readParkedUser(value: unknown): { text: string; images: ImageContent[] } {
  const content = isRecord(value) ? value["content"] : undefined;
  const texts: string[] = [];
  const images: ImageContent[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (isTextContent(part)) texts.push(part.text);
      else if (isImageContent(part)) images.push(part);
    }
  }
  return { text: texts.join("\n"), images };
}

/**
 * Preserve a custom body's content verbatim. A content part that does not
 * match the SDK's own text/image shape cannot be sent through the typed custom
 * path, so it is dropped instead of fabricating a replacement block.
 */
function readCustomContent(value: unknown): NativeCustomContent {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: Array<TextContent | ImageContent> = [];
  for (const part of value) {
    if (isTextContent(part) || isImageContent(part)) parts.push(part);
  }
  return parts;
}

function isTextContent(value: unknown): value is TextContent {
  if (!isRecord(value) || value["type"] !== "text" || typeof value["text"] !== "string") return false;
  const signature = value["textSignature"];
  return signature === undefined || typeof signature === "string";
}

function isImageContent(value: unknown): value is ImageContent {
  return isRecord(value)
    && value["type"] === "image"
    && typeof value["data"] === "string"
    && typeof value["mimeType"] === "string";
}

/** The session's own tool loadout, or null when it cannot be read. */
function activeToolNames(session: NativeSession): string[] | null {
  try {
    const names = session.getActiveToolNames();
    return Array.isArray(names) && names.length > 0 ? [...names] : null;
  } catch {
    return null;
  }
}

function modelRefOf(model: Model<Api> | null): NativeModelRef | null {
  if (model === null) return null;
  if (typeof model.provider !== "string" || typeof model.id !== "string") return null;
  return { provider: model.provider, id: model.id };
}

function budgetFailure(terminal: BudgetTerminal): SubagentError {
  const code = terminal.error?.code === "job_expired" ? "job_expired" : "budget_exceeded";
  const message = code === "job_expired" ? "Subagent job lifetime expired." : "Subagent execution budget exhausted.";
  const detail = terminal.error?.detail;
  return new SubagentError(code, message, isRecord(detail) ? detail : {});
}

function throwIfBudgetFailed(budget: JobBudgetPort): void {
  const terminal = budget.check().terminal;
  if (terminal?.status === "failed") throw budgetFailure(terminal);
}

function readOrigin(origin: unknown): { cwd: string | null; trusted: boolean } {
  if (!isRecord(origin)) return { cwd: null, trusted: false };
  return {
    cwd: typeof origin["cwd"] === "string" ? origin["cwd"] : null,
    trusted: origin["trusted"] === true,
  };
}

/** The sessionHex of one full job address; an invalid address is a bug. */
function sessionOfAddress(address: string): string {
  const parsed = parseAddress(address);
  if (parsed === null) {
    throw new SubagentError("invalid_state", `Job address "${address}" is not a logical address.`);
  }
  return parsed.session;
}

function stringField(value: InheritedContext | null, field: string): string | null {
  if (value === null) return null;
  const found = value[field];
  return typeof found === "string" ? found : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Built-in native tool names a role can exclude. */
const NATIVE_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
