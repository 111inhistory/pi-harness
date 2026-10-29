/**
 * Pi-independent Subagent lifecycle.
 * Batches register atomically, then every admitted Job starts directly.
 * Limits apply to each parent's active children and nesting depth, not global concurrency.
 * Runtime owns cancellation, Budget verdicts, finalization and terminal publication.
 * Messages received before an adapter is ready are buffered as startup input.
 * Explicit messages revive idle actors on their retained context or original seed.
 * Lifecycle events (`onEvent`) let the adapter persist topology and outcomes;
 * `restoreState` rebuilds them without replaying work.
 */

import { randomUUID } from "node:crypto";

import { createJobBudget } from "../job-budget.mjs";
import {
  adjudicateTerminal,
  firstEffectiveStopping,
  terminalNotification,
} from "./lifecycle.ts";
import type {
  LifecycleError,
  StoppingReason,
  TerminalNotification,
  TerminalStatus,
} from "./lifecycle.ts";
import { formatAgentSocketPath } from "./address.ts";

/** Maximum nesting depth below Main; the host adapter reuses this constant. */
export const MAX_AGENT_DEPTH = 2;
const MAX_ACTIVE_CHILDREN = 4;

export type HistoryState = "ready" | "error";
export type JobStatus = "running" | "stopping" | "finalizing" | TerminalStatus;

export interface HistoryBounds {
  startEntryId: string | null;
  endEntryId: string | null;
}

export interface JobHistoryPaths {
  summary: string;
  cleanJsonl: string;
  [key: string]: unknown;
}

export interface BudgetLimit {
  soft: number;
  hard: number;
}

export interface BudgetProfile {
  modelCalls: BudgetLimit;
  activeTimeMs: BudgetLimit;
  lifetimeMs: number;
}

export type BudgetPhase = "normal" | "warning" | "exhausted";
export type BudgetTermination = "model_final" | "cancelled" | "job_failed" | "budget_exhausted" | "lifetime_expired";

/** The Budget's own error record; the public projection adds a message. */
export interface BudgetTerminalError {
  code: string;
  message?: string;
  detail?: unknown;
}

export interface BudgetTerminal {
  status: TerminalStatus;
  termination: BudgetTermination;
  truncated: boolean;
  error: BudgetTerminalError | null;
}

export interface BudgetSnapshot {
  jobId: string | null;
  depth: number | null;
  phase: BudgetPhase;
  modelCalls: number;
  activeTimeMs: number;
  rejectedProjectedModelCalls: number | null;
  running: boolean;
  warningTaken: boolean;
  terminal: BudgetTerminal | null;
}

export interface BudgetSnapshotDetail extends BudgetSnapshot {
  profile: BudgetProfile;
  elapsedMs: number;
}

export type BudgetCheck = BudgetSnapshot;

export type BudgetChargeResult =
  | { ok: true; sequence: number }
  | { ok: false; reason: string; terminal: BudgetTerminal | null; error: BudgetTerminalError | null };

export type BudgetStartResult =
  | { ok: true; activeTimeMs: number }
  | {
      ok: false;
      reason: string;
      terminal: BudgetTerminal | null;
      error: BudgetTerminalError | null;
      activeTimeMs?: number;
    };

export type BudgetTerminateResult =
  | { ok: true; terminal: BudgetTerminal }
  | { ok: false; reason: string; terminal: BudgetTerminal | null; error: BudgetTerminalError | null };

/** The narrow Budget surface the lifecycle owns; the Budget module owns limits. */
export interface JobBudgetPort {
  beginModelCall(): BudgetChargeResult;
  takeWarning(): string | null;
  check(): BudgetCheck;
  startActive(): BudgetStartResult;
  pauseActive(): { ok: true; activeTimeMs: number };
  terminate(options: { reason: "model_final" | "cancelled" | "failed"; error?: LifecycleError | null }): BudgetTerminateResult;
  snapshot(): BudgetSnapshot;
  snapshot(options: { detail: true }): BudgetSnapshotDetail;
  snapshot(options?: { detail?: boolean }): BudgetSnapshot | BudgetSnapshotDetail;
}

export interface InheritedContext {
  [key: string]: unknown;
}

export interface FreshJobSpec {
  kind?: undefined;
  name: string | null;
  task: string;
  context: string | null;
  inheritContext: boolean;
  inheritedContext: InheritedContext | null;
}

export interface ContinuationJobSpec {
  kind: "continuation";
  name: string | null;
  seed: JobSpec | null;
}

export type JobSpec = FreshJobSpec | ContinuationJobSpec;
export type PersistedJobSpec = Record<string, unknown>;

export interface JobRequest {
  agentId: string;
  jobId: string;
  index: number | null;
  parentAgentId: string | null;
  depth: number | null;
  spec: JobSpec;
  origin: unknown;
  budget: JobBudgetPort;
  continuedFromJobId: string | null;
  pendingMessages: RuntimeDelivery[];
  checkBudget(): BudgetCheck;
  recordStart(startEntryId: string | null): void;
}

export interface StartedJobHandle {
  done: Promise<unknown>;
  cancel?(): void | Promise<void>;
}

export interface MessageEnvelope {
  type: "message";
  from: string;
  content: string;
  jobId?: string;
  round?: number;
}

export type RuntimeDelivery = MessageEnvelope | TerminalNotification;

export interface DeliverMessageRequest {
  agentId: string;
  jobId: string | null;
  message: RuntimeDelivery;
}

export interface DeliveryOutcome {
  accepted: boolean;
  reason?: string;
  mode?: string;
  jobId?: string;
}

export interface FinalizationOutcome {
  status: TerminalStatus;
  error: LifecycleError | null;
  result: unknown;
  transcript: unknown[] | null;
  history: HistoryBounds | null;
  budget: BudgetSnapshot;
  jobId: string;
  round: number;
}

export interface FinalizeJobInput {
  job: JobView;
  outcome: FinalizationOutcome;
}

export interface JobEvent {
  type: "job";
  jobId: string;
  agentId: string;
  actor?: { name: string | null; parentAgentId: string | null; depth: number };
  index: number | null;
  createdBy: string;
  continuedFromJobId: string | null;
  spec: PersistedJobSpec;
  origin: unknown;
}

export interface JobStartEvent {
  type: "job-start";
  jobId: string;
  startEntryId: string | null;
}

export interface JobEndEvent {
  type: "job-end";
  jobId: string;
  status: TerminalStatus;
  error: LifecycleError | null;
  result: unknown;
  history: HistoryBounds | null;
  budget: BudgetSnapshot | null;
  historyState?: HistoryState;
  historyError?: LifecycleError;
}

export type RuntimeEvent = JobEvent | JobStartEvent | JobEndEvent;

export interface RuntimeOptions {
  startJob: (request: JobRequest) => unknown;
  deliverMessage?: (request: DeliverMessageRequest) => DeliveryOutcome | Promise<DeliveryOutcome> | null | undefined;
  deliverToMain?: (message: RuntimeDelivery) => unknown;
  onEvent?: (event: RuntimeEvent) => void;
  allowInherited?: boolean;
  socketDir?: string;
  historyPaths?: (jobId: string) => JobHistoryPaths | null;
  prepareInherited?: (input: { agentId: string; snapshot: InheritedContext }) => unknown;
  isIdTaken?: (id: string) => boolean;
  onIdAllocated?: (id: string) => void;
  finalizeJob?: (input: FinalizeJobInput) => unknown;
  /** Pure address formatting port; the default is SDK/transport free. */
  agentSocketPath?: (id: string, socketDir?: string) => string;
}

export interface RuntimeTaskItem {
  name: string | null;
  agentId: string;
  jobId: string;
  status: JobStatus;
  historyState?: HistoryState;
  historyError?: LifecycleError;
  warnings?: string[];
}

export interface RuntimeTaskResult {
  items: RuntimeTaskItem[];
  warnings?: string[];
}

export interface CreatedAgentItem {
  id: string;
  status: JobStatus;
  socket: string;
  warnings?: string[];
}

export interface CreatedAgents {
  items: CreatedAgentItem[];
  warnings?: string[];
}

export interface AgentView {
  agentId: string;
  name: string | null;
  parentAgentId: string | null;
  status: "running" | "idle" | "stopped";
  depth: number;
}

export interface DetailedAgentItem {
  id: string;
  parentId: string | null;
  status: string;
  socket: string;
  history?: { jobId: string } & JobHistoryPaths;
  historyError?: LifecycleError;
}

export interface JobView {
  jobId: string;
  agentId: string;
  name: string | null;
  parentAgentId: string | null;
  depth: number | null;
  status: JobStatus;
  continuedFromJobId: string | null;
  stopping?: TerminalStatus;
  historyState?: HistoryState;
  historyError?: LifecycleError;
  error?: LifecycleError;
  budget?: BudgetSnapshot;
  warnings?: string[];
}

export interface JobRecordView {
  jobId: string;
  agentId: string;
  name: string | null;
  round: number;
  task: string | null;
  status: JobStatus;
  error: LifecycleError | null;
  result: unknown;
  history: HistoryBounds | null;
  historyState?: HistoryState;
  historyError?: LifecycleError;
  budget: BudgetSnapshot | null;
  previousJobId: string | null;
}

export interface CancelJobResult {
  ok: boolean;
  reason?: string;
  job: JobView;
}

export interface StopResult {
  ok: boolean;
  id: string;
  status: string;
}

export interface MessageReceipt {
  ok: true;
  to: string;
  jobId: string | null;
}

export interface BroadcastReceipt {
  ok: boolean;
  to: "all";
  sent: Array<{ to: string; jobId: string | null }>;
  errors: Array<{ to: string; code: string; message: string }>;
}

export interface ReviveResult {
  woken: boolean;
  jobId?: string;
  reason?: string;
}

export interface RestoreResult {
  actors: number;
  jobs: number;
  /** Jobs whose missing terminal outcome the runtime repaired to job_interrupted. */
  interrupted: string[];
}

interface Agent {
  agentId: string;
  name: string | null;
  parentAgentId: string | null;
  depth: number;
  status: "running" | "idle" | "stopped";
  jobIds: string[];
  pending: Array<MessageEnvelope | TerminalNotification>;
  stoppedOrder?: number;
}

interface EndInfo {
  status: TerminalStatus;
  error: LifecycleError | null;
  historyState?: HistoryState;
  historyError?: LifecycleError | null;
}

interface Job {
  jobId: string;
  agentId: string;
  index: number | null;
  spec: JobSpec;
  origin: unknown;
  createdBy: string;
  continuedFromJobId: string | null;
  status: JobStatus;
  result: unknown;
  error: LifecycleError | null;
  history: HistoryBounds | null;
  budget: JobBudgetPort | null;
  budgetSnapshot: BudgetSnapshot | null;
  stopping: StoppingReason | null;
  historyState?: HistoryState;
  historyError?: LifecycleError;
  completionQueued?: boolean;
}

interface TaskOptions {
  parentAgentId?: string | null;
  origin?: unknown;
  allowInherited?: boolean;
  captureInheritedContext?: () => unknown;
}

interface PlannedEntry {
  index: number;
  spec: FreshJobSpec;
}

interface HistoryFilter {
  id?: string;
  agentId?: string;
  status?: string;
  all?: boolean;
}

interface JobsFilter {
  jobIds?: unknown;
}

interface MessagePlan {
  from: string;
  to: string;
  content: string;
}

const MAX_MESSAGE_CHARS = 32768;
const MAIN_ACTOR_ID = "Main";
const BROADCAST_TARGET = "all";

const BATCH_FIELDS = new Set(["context", "tasks"]);
const TASK_FIELDS = new Set(["name", "task", "inheritContext"]);

/** A live Job occupies its actor and its parent's active-child allowance. */
const LIVE_STATUSES = new Set(["running", "stopping", "finalizing"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// Actor ids are `sub_NN` under Main and `<parent>_NN` below it; a Job id is its
// actor id for the first round and `<actor>#rN` for continuations. `all` and
// `Main` can never match, which keeps the broadcast target and the root actor
// outside the resolvable actor space.
const AGENT_ID_PATTERN = /^sub_[0-9a-zA-Z_]+$/;
const JOB_ID_PATTERN = /^sub_[0-9a-zA-Z_]+(#r[0-9]+)?$/;

/** Terminal state of a Job that was still live when the process went away. */
const INTERRUPTED: LifecycleError = Object.freeze({
  code: "job_interrupted",
  message: "The process ended before this Job settled.",
});

/** Harness-owned error with a stable machine-readable code. */
export class SubagentError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "SubagentError";
    this.code = code;
    this.detail = detail;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isPlainObject(value) && typeof value.then === "function";
}

function isStartedJobHandle(value: unknown): value is StartedJobHandle {
  return isPlainObject(value) && isPromiseLike(value.done) && (value.cancel === undefined || typeof value.cancel === "function");
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new SubagentError("invalid_state", `Missing value at index ${index}.`);
  return value;
}

function describe(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isPlainObject(error) && typeof error.message === "string") return error.message;
  return String(error);
}

function errorCode(error: unknown): string | null {
  if (isPlainObject(error) && typeof error.code === "string") return error.code;
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return null;
}

function errorInfo(error: unknown, fallbackCode: string): LifecycleError {
  if (isPlainObject(error)) {
    const code = typeof error.code === "string" ? error.code : fallbackCode;
    const message = typeof error.message === "string" ? error.message : errorMessage(error);
    const info: LifecycleError = { code, message };
    if (isPlainObject(error.detail)) info.detail = cloneValue(error.detail);
    return info;
  }
  const code = errorCode(error) ?? fallbackCode;
  const info: LifecycleError = { code, message: errorMessage(error) };
  if (isPlainObject(error) && isPlainObject(error.detail)) info.detail = cloneValue(error.detail);
  return info;
}

// Stored payloads are cloned so callers can never mutate registry state and
// repeated reads never hand out shared references.
function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function publicBudgetError(error: unknown): LifecycleError | null {
  if (!isPlainObject(error) && !(error instanceof Error)) return null;
  const code = errorCode(error) ?? "budget_exceeded";
  return {
    code,
    message: code === "job_expired" ? "Job lifetime expired." : "Job execution budget exhausted.",
  };
}

function publicBudgetSnapshot(budget: JobBudgetPort): BudgetSnapshot {
  const snapshot = cloneValue(budget.snapshot());
  if (snapshot.terminal?.error) {
    const publicError = publicBudgetError(snapshot.terminal.error);
    if (publicError !== null) snapshot.terminal.error = publicError;
  }
  return snapshot;
}

/**
 * Normalized native history bounds of one Job: the entry it started after and
 * the entry its transcript reaches. A malformed adapter report is ignored
 * instead of being stored half-formed.
 */
function historyBounds(value: unknown): HistoryBounds | null {
  if (!isPlainObject(value)) return null;
  const start = value.startEntryId ?? null;
  const end = value.endEntryId ?? null;
  if (start !== null && typeof start !== "string") return null;
  if (end !== null && typeof end !== "string") return null;
  return { startEntryId: start, endEntryId: end };
}

function stateError(message: string, detail: Record<string, unknown> = {}): SubagentError {
  return new SubagentError("invalid_state", message, detail);
}

/**
 * Canonicalize an actor id: `Main` (case-insensitive) or a generated subagent
 * id. The broadcast target `all` is not an actor. Returns null for anything else.
 */
export function canonicalActorId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === MAIN_ACTOR_ID.toLowerCase()) return MAIN_ACTOR_ID;
  return AGENT_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Deep-copy captured native session entries for one in-memory consumer.
 *
 * `SessionManager.inMemory(cwd, {}, entries)` keeps the array it is handed and
 * appends to it, so two sessions built from one snapshot would share storage
 * and one session identity. Every consumer gets its own copy with a fresh
 * session id on the copied header; native blocks are cloned verbatim.
 */
export function copyInheritedEntries(entries: unknown): unknown {
  if (!Array.isArray(entries)) return entries;
  const copy: unknown[] = structuredClone(entries);
  const header = copy.findIndex((entry) => isPlainObject(entry) && entry.type === "session" && typeof entry.id === "string");
  if (header !== -1) {
    const original = copy[header];
    if (isPlainObject(original)) copy[header] = { ...original, id: randomUUID() };
  }
  return copy;
}

/**
 * The persisted form of a Job spec. A continuation is persisted by name only
 * (its seed is the actor's first spec), and captured conversation entries are
 * never persisted: a durable adapter stores them in the actor's own session.
 */
function persistedSpec(spec: JobSpec): PersistedJobSpec {
  if (spec.kind === "continuation") return { kind: "continuation", name: spec.name ?? null };
  const copy: PersistedJobSpec = { ...spec };
  if (spec.inheritedContext !== null) {
    const { entries: _entries, ...meta } = spec.inheritedContext;
    // Model definitions can carry headers, provider callbacks and runtime
    // references. Persist identity only, never credentials or live SDK graphs.
    const model = meta.model;
    copy.inheritedContext = {
      ...meta,
      ...(isPlainObject(model) && typeof model.provider === "string" && typeof model.id === "string"
        ? { model: { provider: model.provider, id: model.id } }
        : {}),
    };
  }
  return copy;
}

function inheritedContextOf(spec: JobSpec | null | undefined): InheritedContext | null {
  if (spec === null || spec === undefined) return null;
  if (spec.kind === "continuation") return inheritedContextOf(spec.seed);
  return spec.inheritedContext;
}

/**
 * Non-fatal warnings that belong to a Job's entry (for example inherited tools
 * that Pi's public API cannot transplant). A continuation reads its seed's.
 */
function inheritedWarnings(spec: JobSpec | null | undefined): string[] {
  const warnings = inheritedContextOf(spec)?.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((warning): warning is string => typeof warning === "string");
}

/** One-line prose of a terminal Job for its creator; never the answer itself. */
function completionText(job: Job): string {
  const name = typeof job.spec.name === "string" && job.spec.name !== "" ? ` (${job.spec.name})` : "";
  const lines = [`Subagent ${job.agentId}${name} finished Job ${job.jobId} with status ${job.status}.`];
  if (job.error !== null && job.error !== undefined) {
    lines.push(`Error: [${job.error.code}] ${job.error.message}`);
  }
  return lines.join("\n");
}

function isBudgetPhase(value: unknown): value is BudgetPhase {
  return value === "normal" || value === "warning" || value === "exhausted";
}

function isBudgetTermination(value: unknown): value is BudgetTermination {
  return value === "model_final" || value === "cancelled" || value === "job_failed"
    || value === "budget_exhausted" || value === "lifetime_expired";
}

function restoredBudgetTerminal(value: unknown, jobId: string): BudgetTerminal | null {
  if (!isPlainObject(value) || typeof value.status !== "string") return null;
  const status = terminalStatus(value.status, jobId);
  if (!isBudgetTermination(value.termination) || typeof value.truncated !== "boolean") return null;
  let error: BudgetTerminalError | null = null;
  if (value.error !== null) {
    if (!isPlainObject(value.error) || typeof value.error.code !== "string") return null;
    error = {
      code: value.error.code,
      ...(typeof value.error.message === "string" ? { message: value.error.message } : {}),
      ...(value.error.detail === undefined ? {} : { detail: cloneValue(value.error.detail) }),
    };
  }
  return { status, termination: value.termination, truncated: value.truncated, error };
}

function restoredBudgetSnapshot(value: unknown, jobId: string): BudgetSnapshot | null {
  if (!isPlainObject(value)) return null;
  if (!isBudgetPhase(value.phase) || typeof value.modelCalls !== "number" || typeof value.activeTimeMs !== "number") return null;
  if (typeof value.rejectedProjectedModelCalls !== "number" && value.rejectedProjectedModelCalls !== null) return null;
  if (typeof value.warningTaken !== "boolean") return null;
  if (value.jobId !== null && typeof value.jobId !== "string") return null;
  if (value.depth !== null && typeof value.depth !== "number") return null;
  let terminal: BudgetTerminal | null = null;
  if (value.terminal !== null) {
    terminal = restoredBudgetTerminal(value.terminal, jobId);
    if (terminal === null) return null;
  }
  return {
    jobId: value.jobId,
    depth: value.depth,
    phase: value.phase,
    modelCalls: value.modelCalls,
    activeTimeMs: value.activeTimeMs,
    rejectedProjectedModelCalls: value.rejectedProjectedModelCalls,
    running: false,
    warningTaken: value.warningTaken,
    terminal,
  };
}

function restoredHistoryState(value: unknown, jobId: string): HistoryState | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "ready" || value === "error") return value;
  throw stateError(`Job ${jobId} has an invalid historyState.`);
}

function restoredHistoryError(value: unknown, jobId: string): LifecycleError | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value) || typeof value.code !== "string" || typeof value.message !== "string") {
    throw stateError(`Job ${jobId} has a malformed historyError.`);
  }
  return errorInfo(value, "history_write_failed");
}

/**
 * Validate a restored registry description (see `restoreState`).
 *
 * The description is folded from the adapter's own events, but it is still
 * read back from a file that may be truncated or hand-edited, so topology and
 * ownership are checked before anything reaches the registry. The runtime
 * itself decides the terminal outcome of every Job that never ended.
 */
function planRestore(state: unknown): { actors: Agent[]; jobs: Array<Job & { interrupted: boolean }> } {
  if (!isPlainObject(state) || !Array.isArray(state.actors) || !Array.isArray(state.jobs)) {
    throw stateError("The restored subagent state must carry actor and Job lists.");
  }
  const actors = new Map<string, Agent>();
  for (const candidate of state.actors) {
    if (!isPlainObject(candidate)) throw stateError("A restored actor entry must be an object.");
    const agentId = candidate.agentId;
    if (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId)) throw stateError(`${describe(agentId)} is not a subagent actor id.`);
    if (actors.has(agentId)) throw stateError(`Actor ${agentId} appears more than once.`);
    const depth = candidate.depth;
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > MAX_AGENT_DEPTH) {
      throw stateError(`Actor ${agentId} has an invalid depth.`, { agentId });
    }
    const parentAgentId = candidate.parentAgentId ?? null;
    if (parentAgentId !== null && typeof parentAgentId !== "string") {
      throw stateError(`Actor ${agentId} has an invalid parent.`, { agentId });
    }
    const stoppedOrder = candidate.stoppedOrder;
    actors.set(agentId, {
      agentId,
      name: typeof candidate.name === "string" ? candidate.name : null,
      parentAgentId,
      depth,
      status: "idle",
      jobIds: [],
      pending: [],
      stoppedOrder: typeof stoppedOrder === "number" && Number.isSafeInteger(stoppedOrder) ? stoppedOrder : 0,
    });
  }
  for (const actor of actors.values()) {
    const parent = actor.parentAgentId === null ? null : actors.get(actor.parentAgentId);
    if (parent === undefined) throw stateError(`Actor ${actor.agentId} names unknown parent ${actor.parentAgentId}.`);
    if ((parent?.depth ?? 0) + 1 !== actor.depth) throw stateError(`Actor ${actor.agentId} has an inconsistent depth.`);
  }

  const jobs = new Map<string, Job & { interrupted: boolean }>();
  for (const candidate of state.jobs) {
    if (!isPlainObject(candidate)) throw stateError("A restored Job entry must be an object.");
    const jobId = candidate.jobId;
    if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) throw stateError(`${describe(jobId)} is not a Job id.`);
    if (jobs.has(jobId)) throw stateError(`Job ${jobId} appears more than once.`);
    const actor = typeof candidate.agentId === "string" ? actors.get(candidate.agentId) : undefined;
    if (actor === undefined) throw stateError(`Job ${jobId} belongs to unknown actor ${describe(candidate.agentId)}.`);
    const rawSpec = candidate.spec;
    if (!isPlainObject(rawSpec)) throw stateError(`Job ${jobId} has no spec.`);
    if (rawSpec.kind !== undefined && rawSpec.kind !== "continuation") throw stateError(`Job ${jobId} has an unknown spec kind.`);
    if (rawSpec.kind !== "continuation" && (typeof rawSpec.task !== "string" || rawSpec.task.trim() === "")) {
      throw stateError(`Job ${jobId} has no non-empty task.`);
    }
    const createdBy = candidate.createdBy ?? MAIN_ACTOR_ID;
    if (typeof createdBy !== "string" || (createdBy !== MAIN_ACTOR_ID && !actors.has(createdBy))) {
      throw stateError(`Job ${jobId} names unknown creator ${describe(createdBy)}.`);
    }
    const started = candidate.started === true;
    const startEntryId = candidate.startEntryId ?? null;
    if (started && startEntryId !== null && typeof startEntryId !== "string") throw stateError(`Job ${jobId} has malformed start bounds.`);
    const previousRaw = candidate.continuedFromJobId ?? null;
    if (previousRaw !== null && typeof previousRaw !== "string") throw stateError(`Job ${jobId} has a malformed continuation predecessor.`);
    const previous = previousRaw;
    if (previous !== null && jobs.get(previous)?.agentId !== actor.agentId) {
      throw stateError(`Job ${jobId} continues ${describe(previous)}, which is not an earlier Job of its actor.`);
    }
    if (rawSpec.kind === "continuation" && previous === null) throw stateError(`Job ${jobId} has no continuation predecessor.`);
    if (candidate.end != null && !isPlainObject(candidate.end)) throw stateError(`Job ${jobId} has a malformed terminal outcome.`);
    const end = isPlainObject(candidate.end) ? candidate.end : null;
    const bounds = end === null ? (candidate.history ?? (started ? { startEntryId, endEntryId: null } : null)) : end.history;
    if (bounds != null && historyBounds(bounds) === null) throw stateError(`Job ${jobId} has malformed history bounds.`);
    const spec: JobSpec = rawSpec.kind === "continuation"
      ? {
          kind: "continuation",
          name: typeof rawSpec.name === "string" ? rawSpec.name : null,
          seed: jobs.get(actor.jobIds[0] ?? "")?.spec ?? null,
        }
      : {
          name: typeof rawSpec.name === "string" ? rawSpec.name : null,
          task: typeof rawSpec.task === "string" ? rawSpec.task : "",
          context: typeof rawSpec.context === "string" ? rawSpec.context : null,
          inheritContext: rawSpec.inheritContext === true,
          inheritedContext: isPlainObject(rawSpec.inheritedContext) ? cloneValue(rawSpec.inheritedContext) : null,
        };
    const historyState = end === null ? undefined : restoredHistoryState(end.historyState, jobId);
    const historyError = end === null ? undefined : restoredHistoryError(end.historyError, jobId);
    const restored: Job & { interrupted: boolean } = {
      jobId,
      agentId: actor.agentId,
      index: typeof candidate.index === "number" ? candidate.index : null,
      spec,
      origin: candidate.origin ?? null,
      createdBy,
      continuedFromJobId: previous,
      status: end === null ? "failed" : terminalStatus(end.status, jobId),
      result: end?.result ?? null,
      error: end === null ? { ...INTERRUPTED } : (end.error == null ? null : errorInfo(end.error, "job_failed")),
      history: historyBounds(bounds),
      interrupted: end === null,
      budget: null,
      // A restored Job is terminal; its Budget snapshot is reporting only.
      budgetSnapshot: restoredBudgetSnapshot(end?.budget, jobId),
      stopping: null,
      ...(historyState === undefined ? {} : { historyState }),
      ...(historyError === undefined ? {} : { historyError }),
    };
    jobs.set(jobId, restored);
    actor.jobIds.push(jobId);
  }
  return { actors: [...actors.values()], jobs: [...jobs.values()] };
}

function terminalStatus(status: unknown, jobId: string): TerminalStatus {
  if (status === "completed" || status === "failed" || status === "cancelled") return status;
  throw stateError(`Job ${jobId} ends with non-terminal status ${describe(status)}.`);
}

/**
 * Registry + scheduler for subagents.
 *
 * task(batch, options) validates the whole batch, registers every entry in
 * input order, then starts every admitted Job without a global execution cap.
 * Nothing touches the registry before validation succeeds.
 */
export class SubagentRuntime {
  #startJob: (request: JobRequest) => unknown;
  #deliverMessage: ((request: DeliverMessageRequest) => DeliveryOutcome | Promise<DeliveryOutcome> | null | undefined) | null;
  #deliverToMain: ((message: RuntimeDelivery) => unknown) | null;
  #onEvent: ((event: RuntimeEvent) => void) | null;
  #allowInherited: boolean;
  #socketDir: string | undefined;
  #historyPaths: ((jobId: string) => JobHistoryPaths | null) | null;
  #prepareInherited: ((input: { agentId: string; snapshot: InheritedContext }) => unknown) | null;
  #isIdTaken: ((id: string) => boolean) | null;
  #onIdAllocated: ((id: string) => void) | null;
  #finalizeJob: ((input: FinalizeJobInput) => unknown) | null;
  #agentSocketPath: (id: string, socketDir?: string) => string;

  #agents = new Map<string, Agent>();
  #stoppedSequence = 0;
  #jobs = new Map<string, Job>();
  #handles = new Map<string, StartedJobHandle | null>();
  #lifetimeTimers = new Map<string, NodeJS.Timeout>();
  #waiters = new Map<string, Array<(view: JobView) => void>>();
  #childSequences = new Map<string, number>();
  #transitionDepth = 0;
  #completions: Job[] = [];

  constructor(options: RuntimeOptions) {
    const rawOptions: unknown = options;
    if (!isPlainObject(rawOptions)) {
      throw new SubagentError("invalid_options", "Runtime options must be an object.");
    }
    const {
      startJob,
      deliverMessage,
      deliverToMain,
      onEvent,
      allowInherited = true,
      socketDir,
      historyPaths,
      prepareInherited,
      isIdTaken,
      onIdAllocated,
      finalizeJob,
      agentSocketPath,
    } = options;

    if (typeof startJob !== "function") {
      throw new SubagentError("invalid_options", "A startJob adapter function is required.");
    }
    if (finalizeJob !== undefined && typeof finalizeJob !== "function") {
      throw new SubagentError("invalid_options", "finalizeJob must be a function when provided.");
    }
    if (deliverMessage !== undefined && typeof deliverMessage !== "function") {
      throw new SubagentError("invalid_options", "deliverMessage must be a function when provided.");
    }
    if (deliverToMain !== undefined && typeof deliverToMain !== "function") {
      throw new SubagentError("invalid_options", "deliverToMain must be a function when provided.");
    }
    for (const [name, value] of Object.entries({ onEvent, historyPaths, prepareInherited, isIdTaken, onIdAllocated })) {
      if (value !== undefined && typeof value !== "function") {
        throw new SubagentError("invalid_options", `${name} must be a function when provided.`);
      }
    }
    if (typeof allowInherited !== "boolean") {
      throw new SubagentError("invalid_options", "allowInherited must be a boolean.");
    }
    if (agentSocketPath !== undefined && typeof agentSocketPath !== "function") {
      throw new SubagentError("invalid_options", "agentSocketPath must be a function when provided.");
    }

    this.#startJob = startJob;
    this.#deliverMessage = deliverMessage ?? null;
    this.#deliverToMain = deliverToMain ?? null;
    this.#onEvent = onEvent ?? null;
    this.#allowInherited = allowInherited;
    this.#socketDir = socketDir;
    this.#historyPaths = historyPaths ?? null;
    this.#prepareInherited = prepareInherited ?? null;
    this.#isIdTaken = isIdTaken ?? null;
    this.#onIdAllocated = onIdAllocated ?? null;
    this.#finalizeJob = typeof finalizeJob === "function" ? finalizeJob : null;
    this.#agentSocketPath = agentSocketPath ?? formatAgentSocketPath;
  }

  /** Create a subagent batch according to the public contract (id, status, socket). */
  create(batch: unknown, options: TaskOptions = {}): CreatedAgents {
    const res = this.task(batch, options);
    const result: CreatedAgents = {
      items: res.items.map((item): CreatedAgentItem => {
        const mapped: CreatedAgentItem = {
          id: item.agentId,
          status: item.status,
          socket: this.#agentSocketPath(item.agentId, this.#socketDir),
        };
        if (item.warnings !== undefined) {
          mapped.warnings = item.warnings;
        }
        return mapped;
      }),
    };
    if (res.warnings !== undefined) {
      result.warnings = res.warnings;
    }
    return result;
  }

  /**
   * Validate, atomically register and schedule a task batch.
   *
   * @param {{ context?: string, tasks: unknown[] }} batch
   * @param {{
   *   parentAgentId?: string | null,
   *   origin?: unknown,
   *   allowInherited?: boolean,
   *   captureInheritedContext?: () => unknown,
   * }} [options]
   * @returns {{ items: object[] }}
   */
  task(batch: unknown, options: TaskOptions = {}): RuntimeTaskResult {
    const rawOptions: unknown = options;
    if (!isPlainObject(rawOptions)) {
      throw new SubagentError("invalid_options", "task options must be an object.");
    }
    return this.#withTransition(() => {
      const { entries, snapshot } = this.#planBatch(batch, options);
      // Task language is not a lifecycle decision. The router may prefer
      // English, but the runtime no longer rejects a batch by character ratio.
      const parentAgentId = options.parentAgentId ?? null;
      const parent = parentAgentId === null ? null : this.#agents.get(parentAgentId);
      if (parentAgentId !== null && !parent) {
        throw new SubagentError("unknown_parent", `No parent agent registered as ${describe(parentAgentId)}.`);
      }
      const depth = (parent?.depth ?? 0) + 1;
      if (depth > MAX_AGENT_DEPTH) {
        throw new SubagentError(
          "max_depth_exceeded",
          `Agent depth ${depth} exceeds the maximum depth ${MAX_AGENT_DEPTH}; depth-${MAX_AGENT_DEPTH} agents cannot create children.`,
          { parentAgentId, depth, maxDepth: MAX_AGENT_DEPTH },
        );
      }
      const activeChildren = this.#activeChildren(parentAgentId);
      if (activeChildren + entries.length > MAX_ACTIVE_CHILDREN) {
        throw new SubagentError(
          "child_limit_exceeded",
          `Agent ${parentAgentId ?? "Main"} already has ${activeChildren} active children; at most ${MAX_ACTIVE_CHILDREN} are allowed.`,
          {
            parentAgentId,
            activeChildren,
            requestedChildren: entries.length,
            maxActiveChildren: MAX_ACTIVE_CHILDREN,
          },
        );
      }
      const agentIds = entries.map(() => this.#allocateAgentId(parentAgentId));
      // Same batch, same parent context instant. Each inherited child gets its
      // own conversation: materialized by the adapter, or an in-memory copy.
      entries.forEach((entry, position) => {
        if (!entry.spec.inheritContext) return;
        const agentId = at(agentIds, position);
        try {
          if (snapshot === null) throw new Error("no calling context was captured");
          const prepared = this.#prepareInherited === null
            ? { ...snapshot, entries: copyInheritedEntries(snapshot.entries) }
            : this.#prepareInherited({ agentId, snapshot });
          if (!isPlainObject(prepared)) throw new Error("the prepared inherited context is not an object");
          entry.spec.inheritedContext = prepared;
        } catch (error) {
          throw new SubagentError("inherited_snapshot_failed", `Failed to store the calling context for ${agentId}: ${errorMessage(error)}`);
        }
      });
      const registered: Job[] = [];

      for (const [position, entry] of entries.entries()) {
        const agentId = at(agentIds, position);
        const agent: Agent = { agentId, name: entry.spec.name, parentAgentId, depth, status: "running", jobIds: [], pending: [] };
        this.#agents.set(agentId, agent);
        registered.push(
          this.#createJob(agent, {
            index: entry.index,
            spec: entry.spec,
            origin: options.origin ?? null,
            createdBy: parentAgentId ?? MAIN_ACTOR_ID,
          }),
        );
      }

      // Register the complete batch before any adapter can observe or start it.
      for (const job of registered) this.#start(job);
      return { items: registered.map((job) => this.#itemView(job)) };
    });
  }

  /** Register one more Job for an existing agent. */
  #createJob(
    agent: Agent,
    input: {
      index?: number | null;
      spec: JobSpec;
      origin?: unknown;
      createdBy: string;
      continuedFromJobId?: string | null;
    },
  ): Job {
    const { index = null, spec, origin = null, createdBy, continuedFromJobId = null } = input;
    const jobId = continuedFromJobId === null ? agent.agentId : this.#allocateJobId(agent);
    // `job-budget.mjs` is still an untyped dependency; this boundary assertion
    // is the single place where its real API is bound to the closed domain port.
    const budget = createJobBudget({ depth: agent.depth, jobId }) as JobBudgetPort;
    const job: Job = {
      jobId,
      agentId: agent.agentId,
      index,
      spec,
      origin,
      createdBy,
      status: "running",
      result: null,
      error: null,
      // Native entry bounds of the transcript this Job recorded.
      history: null,
      budget,
      budgetSnapshot: null,
      continuedFromJobId,
      // Set while an explicit cancel or an expired Budget waits for the native
      // run to exit; the terminal payload is published from there.
      stopping: null,
    };
    agent.jobIds.push(jobId);
    this.#jobs.set(jobId, job);
    this.#emit({
      type: "job",
      jobId,
      agentId: agent.agentId,
      ...(agent.jobIds.length === 1 ? { actor: { name: agent.name, parentAgentId: agent.parentAgentId, depth: agent.depth } } : {}),
      index,
      createdBy,
      continuedFromJobId,
      spec: persistedSpec(spec),
      origin: cloneValue(origin),
    });
    this.#scheduleLifetime(job);
    this.#refreshAgent(agent.agentId);
    return job;
  }

  /** A continuation's id: never one used before, on any branch of this root. */
  #allocateJobId(agent: Agent): string {
    let round = agent.jobIds.length + 1;
    while (this.#jobs.has(`${agent.agentId}#r${round}`) || this.#isIdTaken?.(`${agent.agentId}#r${round}`)) round += 1;
    const jobId = `${agent.agentId}#r${round}`;
    this.#onIdAllocated?.(jobId);
    return jobId;
  }

  #emit(event: RuntimeEvent): void {
    if (this.#onEvent === null) return;
    try {
      this.#onEvent(event);
    } catch {
      // A settled transition cannot be rolled back and a storage failure must
      // never change a Job outcome; the adapter reports persistence errors.
    }
  }

  /** Agent-level snapshot; job status is reported by jobs(), not here. */
  list(filter: HistoryFilter | null = null): { agents: AgentView[] } {
    const targetId = filter?.id || filter?.agentId;
    const agents: AgentView[] = [];
    for (const agent of this.#agents.values()) {
      if (targetId && agent.agentId !== targetId) continue;
      if (filter?.status !== undefined && filter.status !== agent.status) continue;
      agents.push({
        agentId: agent.agentId,
        name: agent.name,
        parentAgentId: agent.parentAgentId,
        status: agent.status,
        depth: agent.depth,
      });
    }
    return { agents };
  }

  /** Public contract view for list tool, including unified ID, socket and history paths. */
  listDetailed(
    filter: HistoryFilter | null = null,
    { callerId }: { callerId?: string } = {},
  ): { items: DetailedAgentItem[] } {
    const targetId = filter?.id || filter?.agentId;
    const agents = [...this.#agents.values()];
    const visible = new Set<string>();
    const scoped = callerId !== undefined;
    const main: DetailedAgentItem = {
      id: MAIN_ACTOR_ID,
      parentId: null,
      status: "running",
      socket: this.#agentSocketPath(MAIN_ACTOR_ID, this.#socketDir),
    };
    if (scoped) {
      if (filter?.all === true) {
        visible.add(MAIN_ACTOR_ID);
        for (const agent of agents) visible.add(agent.agentId);
      } else {
        const group = (parentId: string | null, selfId?: string) => this.#visibleGroup(parentId, selfId);
        const addChildren = (agent: Agent): void => {
          if (agent.status !== "running") return;
          for (const child of group(agent.agentId)) visible.add(child.agentId);
        };
        if (callerId === MAIN_ACTOR_ID) {
          visible.add(MAIN_ACTOR_ID);
          for (const child of group(null)) {
            visible.add(child.agentId);
            addChildren(child);
          }
        } else {
          const caller = this.#agents.get(callerId);
          if (!caller) throw new SubagentError("unknown_agent", `No subagent registered as ${callerId}.`);
          visible.add(caller.parentAgentId ?? MAIN_ACTOR_ID);
          for (const peer of group(caller.parentAgentId, callerId)) visible.add(peer.agentId);
          addChildren(caller);
        }
      }
    }
    const items: DetailedAgentItem[] = [];
    if (visible.has(MAIN_ACTOR_ID) && (!targetId || targetId === MAIN_ACTOR_ID) && (!filter?.status || filter.status === main.status)) items.push(main);
    const listed: Agent[] = scoped
      ? [...visible]
          .filter((id) => id !== MAIN_ACTOR_ID)
          .map((id) => this.#agents.get(id))
          .filter((agent): agent is Agent => agent !== undefined)
      : agents;
    for (const agent of listed) {
      if (targetId && agent.agentId !== targetId) continue;
      const liveJob = this.#liveJobOf(agent);
      const currentStatus = liveJob ? liveJob.status : (agent.status === "idle" ? "stopped" : agent.status);
      if (filter?.status !== undefined && filter.status !== currentStatus && filter.status !== agent.status) continue;
      const item: DetailedAgentItem = {
        id: agent.agentId,
        parentId: agent.parentAgentId ?? "Main",
        status: currentStatus,
        socket: this.#agentSocketPath(agent.agentId, this.#socketDir),
      };
      const latest = [...agent.jobIds]
        .reverse()
        .map((jobId) => this.#jobs.get(jobId))
        .find((job): job is Job => job !== undefined && TERMINAL_STATUSES.has(job.status));
      if (latest !== undefined && this.#historyPaths !== null) {
        try {
          const history = this.#historyPaths(latest.jobId);
          if (history) item.history = { jobId: latest.jobId, ...history };
        } catch (error) {
          // A derived view belongs to this row only. One unreadable history
          // must neither hide healthy siblings nor rewrite the Job outcome.
          item.historyError = errorInfo(error, "history_unavailable");
        }
      }
      items.push(item);
    }
    return { items };
  }

  assertMessageAdmission(id: string): void {
    if (id === MAIN_ACTOR_ID) return;
    const agent = this.#agents.get(id);
    if (!agent) throw new SubagentError("unknown_agent", `No subagent registered as ${id}.`);
    const live = this.#liveJobOf(agent);
    if (live && live.status !== "running") throw new SubagentError("agent_stopping", `Agent ${id} is ${live.status}.`);
    if (!live) {
      const refusal = this.#reviveRefusal(agent);
      if (refusal) throw refusal;
    }
  }

  #visibleGroup(parentId: string | null, selfId?: string): Agent[] {
    const siblings = [...this.#agents.values()].filter((agent) => agent.parentAgentId === parentId);
    const active = siblings.filter((agent) => agent.status === "running");
    const stopped = siblings.filter((agent) => agent.status !== "running").reverse()
      .sort((a, b) => (b.stoppedOrder ?? 0) - (a.stoppedOrder ?? 0));
    const self = siblings.find((agent) => agent.agentId === selfId);
    return [...(self ? [self] : []), ...active.filter((agent) => agent !== self), ...stopped.filter((agent) => agent !== self)]
      .slice(0, MAX_ACTIVE_CHILDREN);
  }

  /** Job-level snapshot, optionally restricted to specific job ids. */
  jobs(filter: JobsFilter | null = null): { jobs: JobView[] } {
    let jobIds: string[] | null = null;
    if (filter?.jobIds !== undefined) {
      if (!Array.isArray(filter.jobIds) || filter.jobIds.length === 0) {
        throw new SubagentError("invalid_filter", "jobIds must be a non-empty array of job ids.");
      }
      jobIds = filter.jobIds.map((jobId) => this.#requireJob(jobId).jobId);
    }
    const jobs: Job[] = jobIds === null
      ? [...this.#jobs.values()]
      : jobIds
          .map((jobId) => this.#jobs.get(jobId))
          .filter((job): job is Job => job !== undefined);
    return { jobs: jobs.map((job) => this.#jobView(job)) };
  }

  /**
   * Accept a write for a same-runtime actor or for the reserved broadcast
   * target.
   *
   * The sender identity comes from the host surface, never from message text.
   * The receipt means "this message entered a delivery path" — a live Job took
   * it, a starting adapter will receive buffered input, or an idle agent was revived with a
   * new Job for it — and never waits for a model response.
   *
   * Reviving an idle agent creates a Job, so it is admitted exactly like a new
   * child: while the parent already holds the maximum number of active children
   * the whole write is rejected with `child_limit_exceeded` before any message
   * or Job is registered.
   *
   * A write that arrives while the agent is stopping, or while its run closes
   * underneath the hand-over, is rejected with `agent_busy` instead of being
   * parked in a deferred state: the caller retries against the successor state.
   *
   * `to: "all"` broadcasts to the sender's direct children and answers with
   * one explicit outcome per recipient.
   *
   * @param {{ from: string, to: string, content: string, signal?: AbortSignal }} message
   * @returns {Promise<{ ok: true, to: string, jobId: string | null } | { ok: boolean, to: "all", sent: object[], errors: object[] }>}
   */
  async sendMessage(
    input: { from?: unknown; to?: unknown; content?: unknown; signal?: AbortSignal } = {},
  ): Promise<MessageReceipt | BroadcastReceipt> {
    const { from, to, content, signal } = input;
    if (signal?.aborted) {
      throw new SubagentError("aborted", "The write was aborted before it was delivered.");
    }
    const plan = this.#planMessage({ from, to, content });

    if (plan.to === MAIN_ACTOR_ID) {
      return this.#sendToMain(plan);
    }
    if (plan.to === BROADCAST_TARGET) {
      return this.#broadcast(plan);
    }
    return this.#sendToAgent(plan);
  }

  /**
   * Cancel one job without touching any other job or agent.
   *
   * A Job whose adapter has not started goes directly through finalization.
   * A started Job stays `stopping` (occupying its actor and topology allowance)
   * until the adapter's handle settles, then publishes its cancelled payload.
   *
   * @returns {{ ok: boolean, reason?: string, job: object }}
   */
  cancelJob(jobId: unknown): CancelJobResult {
    return this.#withTransition(() => {
      const job = this.#requireJob(jobId);

      if (TERMINAL_STATUSES.has(job.status)) {
        return { ok: false, reason: "already_finished", job: this.#jobView(job) };
      }
      if (job.status === "finalizing") {
        return { ok: false, reason: "finalizing", job: this.#jobView(job) };
      }
      if (job.status === "stopping") {
        return { ok: false, reason: "stopping", job: this.#jobView(job) };
      }

      const budget = job.budget;
      if (budget === null) throw stateError(`Job ${job.jobId} has no Budget.`);
      const budgetVerdict = budget.check();
      if (budgetVerdict.terminal?.status === "failed") {
        const error = publicBudgetError(budgetVerdict.terminal.error);
        this.#beginStopping(job, "failed", error);
        return { ok: false, reason: "budget_exceeded", job: this.#jobView(job) };
      }

      const message = this.#handles.has(job.jobId) ? "Job cancelled while running." : "Job cancelled before it started.";
      this.#beginStopping(job, "cancelled", { code: "cancelled", message });
      return { ok: true, job: this.#jobView(job) };
    });
  }

  /**
   * Stop one subagent by id gracefully.
   * Stops native execution, or finalizes immediately if no adapter has started.
   */
  stop(target: unknown): StopResult {
    const id = typeof target === "string"
      ? target
      : isPlainObject(target) ? (target.id || target.jobId || target.agentId) : undefined;
    if (typeof id !== "string" || id === "") {
      throw new SubagentError("invalid_request", "stop requires an id.");
    }
    const agent = this.#agents.get(id);
    if (!agent) {
      const job = this.#jobs.get(id);
      if (job) {
        const res = this.cancelJob(job.jobId);
        return { ok: res.ok, id, status: res.job?.status ?? "stopping" };
      }
      throw new SubagentError("unknown_agent", `No subagent found with id "${id}".`);
    }
    const liveJob = this.#liveJobOf(agent);
    if (liveJob) {
      const res = this.cancelJob(liveJob.jobId);
      return { ok: res.ok, id, status: res.job?.status ?? "stopping" };
    }
    return { ok: true, id, status: agent.status };
  }

  /** Resolves once the job reaches a terminal status (or immediately if it already has). */
  jobDone(jobId: unknown): Promise<JobView> {
    const job = this.#requireJob(jobId);
    if (TERMINAL_STATUSES.has(job.status)) return Promise.resolve(this.#jobView(job));
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(job.jobId) ?? [];
      waiters.push(resolve);
      this.#waiters.set(job.jobId, waiters);
    });
  }

  /**
   * Stable fields for a terminal or finalizing Job's readable view. Null for
   * an unknown Job or one whose execution has not settled.
   */
  jobRecord(jobId: unknown): JobRecordView | null {
    const job = typeof jobId === "string" ? this.#jobs.get(jobId) : undefined;
    if (job === undefined || (!TERMINAL_STATUSES.has(job.status) && job.status !== "finalizing")) return null;
    const agent = this.#agents.get(job.agentId);
    const record: JobRecordView = {
      jobId: job.jobId,
      agentId: job.agentId,
      name: agent?.name ?? null,
      round: Math.max(1, (agent?.jobIds.indexOf(job.jobId) ?? 0) + 1),
      task: job.spec.kind === "continuation" ? null : job.spec.task,
      status: job.status,
      error: cloneValue(job.error),
      result: cloneValue(job.result),
      history: job.history === null ? null : { ...job.history },
      budget: this.#budgetView(job),
      previousJobId: job.continuedFromJobId,
    };
    if (job.historyState !== undefined) record.historyState = job.historyState;
    if (job.historyError !== undefined) record.historyError = job.historyError;
    return record;
  }

  /**
   * Restore a registry folded from persisted events into a fresh runtime.
   *
   * `state.actors` carry `{ agentId, name, parentAgentId, depth, stoppedOrder }`;
   * `state.jobs` carry the registered Job fields plus `end` (the terminal
   * outcome, or null) in creation order. A Job without an end was live when
   * its process went away: it becomes `failed` with `job_interrupted`, is
   * never re-run or re-notified, and its terminal event is emitted now (with
   * the `history` bounds the adapter sealed for it). The returned `interrupted`
   * ids plus `jobRecord` are the repair payloads an adapter can persist after
   * this call validated the whole registry.
   *
   * @returns {{ actors: number, jobs: number, interrupted: string[] }}
   */
  restoreState(state: unknown): RestoreResult {
    if (this.#agents.size > 0 || this.#jobs.size > 0) {
      throw new SubagentError("invalid_state", "restoreState requires a fresh runtime; this runtime already has registered actors or jobs.");
    }
    const restored = planRestore(state);
    for (const actor of restored.actors) {
      this.#agents.set(actor.agentId, actor);
      this.#noteSequence(actor);
    }
    this.#stoppedSequence = Math.max(0, ...restored.actors.map((actor) => actor.stoppedOrder ?? 0));
    const interrupted: string[] = [];
    for (const job of restored.jobs) {
      const { interrupted: wasLive, ...record } = job;
      this.#jobs.set(job.jobId, record);
      if (!wasLive) continue;
      interrupted.push(job.jobId);
      const agent = this.#agents.get(job.agentId);
      if (agent !== undefined) agent.stoppedOrder = ++this.#stoppedSequence;
      this.#emitEnd(record);
    }
    for (const agent of this.#agents.values()) this.#refreshAgent(agent.agentId);
    return { actors: this.#agents.size, jobs: this.#jobs.size, interrupted };
  }

  /** Terminal notifications wait until the transition that produced them settled. */
  #flushCompletions() {
    if (this.#completions.length === 0) return;
    const jobs = this.#completions;
    this.#completions = [];
    for (const job of jobs) this.#notifyTerminal(job);
  }

  /**
   * Coalesce one synchronous transition: a batch that registers four Jobs,
   * starts them and fails one of them publishes its notification once the
   * whole batch is registered.
   */
  #withTransition<T>(run: () => T): T {
    this.#transitionDepth += 1;
    try {
      return run();
    } finally {
      this.#transitionDepth -= 1;
      if (this.#transitionDepth === 0) this.#flushCompletions();
    }
  }

  #planBatch(batch: unknown, options: TaskOptions): { entries: PlannedEntry[]; snapshot: InheritedContext | null } {
    if (!isPlainObject(batch)) {
      throw new SubagentError("invalid_batch", "task expects an object with a tasks array.");
    }
    for (const key of Object.keys(batch)) {
      if (!BATCH_FIELDS.has(key)) {
        throw new SubagentError("invalid_batch", `Unknown batch field ${describe(key)}.`);
      }
    }
    if (!Array.isArray(batch.tasks) || batch.tasks.length === 0) {
      throw new SubagentError("invalid_batch", "tasks must be a non-empty array.");
    }

    const rawContext = batch.context;
    if (rawContext !== undefined && typeof rawContext !== "string") {
      throw new SubagentError("invalid_batch", "context must be a string when provided.");
    }
    const context = rawContext ?? null;
    const entries = batch.tasks.map((raw, index) => this.#planTask(raw, index, context));

    if (entries.some((entry) => entry.spec.inheritContext)) {
      const allowInherited = options.allowInherited ?? this.#allowInherited;
      if (!allowInherited) {
        throw new SubagentError(
          "inherited_not_allowed",
          "An Inherited Subagent cannot create another Inherited Subagent; create a Fresh Subagent instead.",
        );
      }
      const capture = options.captureInheritedContext;
      if (typeof capture !== "function") {
        throw new SubagentError("inherited_snapshot_unavailable", "This runtime cannot snapshot a calling context for inheritContext: true.");
      }
      let snapshot;
      try {
        snapshot = capture();
      } catch (error) {
        throw new SubagentError("inherited_snapshot_failed", `Failed to snapshot the calling context: ${errorMessage(error)}`);
      }
      if (!isPlainObject(snapshot)) {
        throw new SubagentError("inherited_snapshot_failed", "The inherited-context snapshot function returned no snapshot.");
      }
      return { entries, snapshot };
    }

    return { entries, snapshot: null };
  }

  #planTask(raw: unknown, index: number, context: string | null): PlannedEntry {
    const where = `tasks[${index}]`;
    const reject = (message: string, detail: Record<string, unknown> = {}): never => {
      throw new SubagentError("invalid_task", message, { index, ...detail });
    };

    if (!isPlainObject(raw)) throw new SubagentError("invalid_task", `${where} must be an object.`, { index });
    for (const key of Object.keys(raw)) {
      if (!TASK_FIELDS.has(key)) reject(`${where} has unknown field ${describe(key)}.`, { field: key });
    }
    if (raw.inheritContext !== undefined && typeof raw.inheritContext !== "boolean") {
      reject(`${where}.inheritContext must be a boolean when provided.`, { field: "inheritContext" });
    }

    let name: string | null = null;
    const rawName = raw.name;
    if (rawName !== undefined) {
      if (typeof rawName !== "string") throw new SubagentError("invalid_task", `${where}.name must be a non-empty string.`, { index, field: "name" });
      const trimmedName = rawName.trim();
      if (trimmedName === "") reject(`${where}.name must be a non-empty string.`, { field: "name" });
      name = trimmedName;
    }
    const rawTask = raw.task;
    if (typeof rawTask !== "string") throw new SubagentError("invalid_task", `${where}.task must be a non-empty string.`, { index, field: "task" });
    const task = rawTask.trim();
    if (task === "") reject(`${where}.task must be a non-empty string.`, { field: "task" });

    return {
      index,
      spec: {
        name,
        task,
        context,
        inheritContext: raw.inheritContext === true,
        inheritedContext: null,
      },
    };
  }

  #start(job: Job): void {
    return this.#withTransition(() => {
      if (job.status !== "running" || this.#handles.has(job.jobId)) return;

      const budget = job.budget;
      if (budget === null) throw stateError(`Job ${job.jobId} has no Budget.`);
      const budgetStart = budget.startActive();
      if (!budgetStart.ok) {
        const terminal = budgetStart.terminal;
        this.#beginFinalization(job, {
          status: terminal?.status ?? "failed",
          error: publicBudgetError(terminal?.error) ?? { code: "budget_exceeded", message: "Job execution budget exhausted." },
        });
        return;
      }

      // Reserve the handle entry before invoking the adapter so synchronous aborts
      // wait for its returned handle rather than finalizing a run still starting.
      this.#handles.set(job.jobId, null);
      let handle: unknown;
      try {
        handle = this.#startJob(this.#jobRequest(job));
      } catch (error) {
        this.#fail(job, errorInfo(error, "start_failed"));
        return;
      }
      if (!isStartedJobHandle(handle)) {
        this.#fail(job, {
          code: "invalid_adapter",
          message: "The startJob adapter must return an object with a done promise (and optionally cancel()).",
        });
        return;
      }

      this.#handles.set(job.jobId, handle);
      // The adapter may observe its Budget before it has a handle to return: a
      // failure routed during `startJob` is cancelled here, exactly once, now
      // that the handle exists. The slots are released only when it exits.
      if (job.stopping !== null) this.#cancelHandle(job);
      handle.done.then(
        (outcome) => this.#beginFinalization(job, outcome),
        (error) => this.#fail(job, error),
      );
    });
  }

  #jobRequest(job: Job): JobRequest {
    const agent = this.#agents.get(job.agentId);
    // Assign startup input to the run when its adapter is invoked.
    const pending = agent === undefined ? [] : agent.pending.splice(0);
    const budget = job.budget;
    if (budget === null) throw stateError(`Job ${job.jobId} has no Budget.`);
    return {
      agentId: job.agentId,
      jobId: job.jobId,
      index: job.index,
      parentAgentId: agent?.parentAgentId ?? null,
      depth: agent?.depth ?? null,
      spec: job.spec,
      origin: job.origin,
      budget,
      continuedFromJobId: job.continuedFromJobId,
      pendingMessages: pending.map((envelope) => cloneValue(envelope)),
      checkBudget: () => this.#checkBudget(job),
      recordStart: (startEntryId) => this.#recordStart(job, startEntryId),
    };
  }

  /**
   * The native entry this Job's transcript starts after, recorded once before
   * its first prompt. A process that dies mid-run is recovered from here.
   */
  #recordStart(job: Job, startEntryId: unknown): void {
    if (job.history !== null || TERMINAL_STATUSES.has(job.status)) return;
    if (startEntryId !== null && typeof startEntryId !== "string") return;
    job.history = { startEntryId, endEntryId: null };
    this.#emit({ type: "job-start", jobId: job.jobId, startEntryId });
  }

  #beginFinalization(job: Job, execution: unknown = {}): void | Promise<void> {
    if (job.status === "finalizing" || TERMINAL_STATUSES.has(job.status)) return;

    const budget = job.budget;
    if (budget === null) throw stateError(`Job ${job.jobId} has no Budget.`);
    budget.pauseActive();
    clearTimeout(this.#lifetimeTimers.get(job.jobId));
    this.#lifetimeTimers.delete(job.jobId);

    const payload = isPlainObject(execution) ? execution : {};
    if (payload.result !== undefined && payload.result !== null) job.result = cloneValue(payload.result);
    const bounds = historyBounds(payload.history);
    if (bounds !== null) job.history = bounds;

    const budgetTerminal = budget.check().terminal;
    const decision = adjudicateTerminal({
      stopping: job.stopping,
      budgetError: budgetTerminal?.status === "failed" ? publicBudgetError(budgetTerminal.error) : null,
      executionError: payload.error ? errorInfo(payload.error, "job_failed") : null,
      executionStatus: typeof payload.status === "string" ? payload.status : null,
    });
    const { status, error } = decision;
    budget.terminate({ reason: status === "completed" ? "model_final" : status, error });

    const agent = this.#agents.get(job.agentId);
    const outcome: FinalizationOutcome = Object.freeze({
      status,
      error,
      result: job.result,
      // Passed through to finalization only; the runtime keeps no transcript.
      transcript: Array.isArray(payload.transcript) ? payload.transcript : null,
      history: job.history,
      budget: budget.snapshot(),
      jobId: job.jobId,
      round: Math.max(1, (agent?.jobIds.indexOf(job.jobId) ?? -1) + 1),
    });

    // Set before calling the hook: reentrant stop or finalization cannot change this outcome.
    job.status = "finalizing";
    const finalizeJob = this.#finalizeJob;
    if (finalizeJob === null) {
      this.#end(job, outcome);
      return;
    }
    return (async () => {
      let historyState: HistoryState = "ready";
      let historyError: LifecycleError | null = null;
      try {
        await finalizeJob({ job: this.#jobView(job), outcome });
      } catch (err) {
        historyState = "error";
        historyError = errorInfo(err, "history_write_failed");
      }
      this.#end(job, { status, error, historyState, historyError });
    })();
  }

  #fail(job: Job, error: LifecycleError): void {
    this.#beginFinalization(job, { error });
  }

  #checkBudget(job: Job): BudgetCheck {
    return this.#withTransition(() => {
      const budget = job.budget;
      if (budget === null) throw stateError(`Job ${job.jobId} has no Budget.`);
      const verdict = budget.check();
      if (verdict.terminal?.status !== "failed") return verdict;
      const error = publicBudgetError(verdict.terminal.error);
      if (job.status === "running") {
        this.#beginStopping(job, "failed", error);
      }
      return verdict;
    });
  }

  #scheduleLifetime(job: Job): void {
    const schedule = (): void => {
      const budget = job.budget;
      if (budget === null) return;
      const detail = budget.snapshot({ detail: true });
      const remaining = Math.max(1, detail.profile.lifetimeMs - detail.elapsedMs);
      const timer = setTimeout(() => {
        this.#lifetimeTimers.delete(job.jobId);
        if (TERMINAL_STATUSES.has(job.status) || job.status === "stopping") return;
        // The same observation the adapter takes through `checkBudget()`: an
        // an expired lease stops execution through that shared observation point.
        if (this.#checkBudget(job).terminal?.status !== "failed") schedule();
      }, remaining);
      timer.unref?.();
      this.#lifetimeTimers.set(job.jobId, timer);
    };
    schedule();
  }

  /**
   * Stop a running Job's native run and hold its slots until the adapter's
   * `done` settles. `#beginFinalization` observes `job.stopping` and publishes the
   * one terminal payload from there.
   */
  #beginStopping(job: Job, status: TerminalStatus, error: LifecycleError | null): void {
    return this.#withTransition(() => {
      // The first effective reason wins: a later cancellation or Budget
      // observation cannot rewrite what this generation is stopping for.
      job.stopping = firstEffectiveStopping(job.stopping, { status, error });
      job.status = "stopping";
      clearTimeout(this.#lifetimeTimers.get(job.jobId));
      this.#lifetimeTimers.delete(job.jobId);
      if (this.#handles.has(job.jobId)) this.#cancelHandle(job);
      else this.#beginFinalization(job);
    });
  }

  /**
   * Abort the adapter's native run. A no-op when no handle exists yet — the
   * caller cancels the handle once it is assigned — and best effort
   * otherwise: the terminal publication never depends on the abort succeeding.
   */
  #cancelHandle(job: Job): void {
    try {
      const pending = this.#handles.get(job.jobId)?.cancel?.();
      if (pending !== undefined && typeof pending.then === "function") pending.catch(() => {});
    } catch {
      // See the doc comment: the abort is best effort.
    }
  }

  #end(job: Job, terminalInfo: EndInfo): void {
    this.#withTransition(() => {
      clearTimeout(this.#lifetimeTimers.get(job.jobId));
      this.#lifetimeTimers.delete(job.jobId);
      job.status = terminalInfo.status;
      job.error = terminalInfo.error ?? null;
      if (terminalInfo.historyState !== undefined) {
        job.historyState = terminalInfo.historyState;
      }
      if (terminalInfo.historyError !== undefined && terminalInfo.historyError !== null) {
        job.historyError = terminalInfo.historyError;
      }
      this.#handles.delete(job.jobId);
      this.#emitEnd(job);
      this.#settle(job);
    });
    // The notification is the only thing a terminal transition sends outwards;
    // it is attempted after the terminal event of this transition was emitted.
    this.#queueCompletion(job);
  }

  #emitEnd(job: Job): void {
    const event: JobEndEvent = {
      type: "job-end",
      jobId: job.jobId,
      status: terminalStatus(job.status, job.jobId),
      error: cloneValue(job.error),
      result: job.result,
      history: job.history === null ? null : { ...job.history },
      budget: this.#budgetView(job),
    };
    if (job.historyState !== undefined) event.historyState = job.historyState;
    if (job.historyError !== undefined) event.historyError = job.historyError;
    this.#emit(event);
  }

  #settle(job: Job): void {
    const waiters = this.#waiters.get(job.jobId);
    if (waiters) {
      this.#waiters.delete(job.jobId);
      const view = this.#jobView(job);
      for (const resolve of waiters) resolve(view);
    }
    this.#refreshAgent(job.agentId);
  }

  /**
   * Notify the Job's creator exactly once that it became terminal.
   *
   * The envelope carries references and a one-line summary, never the answer.
   * Delivery is best effort: one attempt, no retry, no acknowledgement, and a
   * failure here can never change the Job's outcome.
   */
  #queueCompletion(job: Job): void {
    if (job.completionQueued === true) return;
    job.completionQueued = true;
    this.#completions.push(job);
    if (this.#transitionDepth > 0) return;
    this.#flushCompletions();
  }

  #notifyTerminal(job: Job): void {
    // Completed, cancelled and failed rounds all publish one typed terminal
    // event. The delivery coordinator decides how it delivers or wakes; the
    // runtime never suppresses a normal completion.
    if (!TERMINAL_STATUSES.has(job.status)) return;
    const sourceAgent = this.#agents.get(job.agentId);
    // Host notifications follow topology, not whoever revived this round. A
    // peer that wakes an idle agent must not steal its terminal notice from
    // the direct parent. `createdBy` stays the audit field on the Job.
    const creator = sourceAgent?.parentAgentId ?? MAIN_ACTOR_ID;
    if (typeof creator !== "string") return;
    const round = Math.max(1, (sourceAgent?.jobIds.indexOf(job.jobId) ?? 0) + 1);
    let history: JobHistoryPaths | null = null;
    try {
      history = this.#historyPaths?.(job.jobId) ?? null;
    } catch {
      // A derived view may be unavailable. It must not suppress the one terminal
      // notice or reject the already-settled execution's completion chain.
    }
    const envelope = terminalNotification({
      agentId: job.agentId,
      jobId: job.jobId,
      round,
      name: job.spec.name,
      status: terminalStatus(job.status, job.jobId),
      content: completionText(job),
      error: job.error ?? null,
      history,
    });
    if (creator === MAIN_ACTOR_ID) {
      if (this.#deliverToMain === null) return;
      const deliverToMain = this.#deliverToMain;
      this.#attempt(() => deliverToMain(envelope));
      return;
    }
    const agent = this.#agents.get(creator);
    if (agent === undefined || this.#deliverMessage === null) return;
    const live = this.#liveJobOf(agent);
    const targetJobId = live !== null && live.status === "running" ? live.jobId : null;
    const deliverMessage = this.#deliverMessage;
    this.#attempt(() => deliverMessage({ agentId: creator, jobId: targetJobId, message: envelope }));
  }

  #attempt(run: () => unknown): void {
    try {
      const pending = run();
      if (isPromiseLike(pending)) pending.then(undefined, () => {});
    } catch {
      // See #notifyTerminal: one attempt, never retried.
    }
  }

  /**
   * Admission for waking an idle agent: revival creates a Job, so it counts as
   * an active child exactly like a new `task` entry. When it does not fit, the
   * caller rejects the whole write instead of holding a deferred revival.
   */
  #reviveRefusal(agent: Agent): SubagentError | null {
    const activeChildren = this.#activeChildren(agent.parentAgentId);
    if (activeChildren + 1 <= MAX_ACTIVE_CHILDREN) return null;
    return new SubagentError(
      "child_limit_exceeded",
      `Agent ${agent.parentAgentId ?? "Main"} already has ${activeChildren} active children; reviving ${agent.agentId} ` +
        `would exceed ${MAX_ACTIVE_CHILDREN}.`,
      {
        agentId: agent.agentId,
        parentAgentId: agent.parentAgentId,
        activeChildren,
        maxActiveChildren: MAX_ACTIVE_CHILDREN,
      },
    );
  }

  /**
   * Wake an idle agent with one host terminal notification.
   *
   * This uses the same admission and Budget path as an explicit write: the
   * notification becomes the trigger of a normal continuation Job, so a
   * completed child can wake a stopped/idle parent without a second execution
   * orchestrator. A busy agent is not woken here; the caller appends the notice
   * to its current conversation instead.
   *
   * @param {string} agentId
   * @param {object} envelope host-owned terminal notification
   * @returns {{ woken: boolean, jobId?: string, reason?: string }}
   */
  reviveWithNotification(agentId: string, envelope: RuntimeDelivery): ReviveResult {
    const agent = this.#agents.get(agentId);
    if (agent === undefined) return { woken: false, reason: "unknown_agent" };
    return this.#withTransition(() => {
      const live = this.#liveJobOf(agent);
      if (live !== null) return { woken: false, reason: live.status };
      const refusal = this.#reviveRefusal(agent);
      if (refusal !== null) return { woken: false, reason: refusal.code };
      agent.pending.push(cloneValue(envelope));
      const revived = this.#scheduleContinuation(agent, agent.parentAgentId ?? MAIN_ACTOR_ID);
      this.#start(revived);
      return { woken: true, jobId: revived.jobId };
    });
  }

  /**
   * Register the continuation Job for an idle agent that should wake.
   *
   * A continuation has no task of its own; it carries the agent's original
   * seed (the first Job's spec) so an actor that never started at all — a task
   * cancelled before its SDK initialized, so no native session exists — can
   * still be revived into its first session. The adapter uses the seed only
   * when there is no retained conversation; a live session is never re-seeded
   * and never re-runs the original task on its own.
   */
  #scheduleContinuation(agent: Agent, createdBy: string): Job {
    const previousId = agent.jobIds[agent.jobIds.length - 1];
    const seedId = agent.jobIds[0];
    const previous = previousId === undefined ? undefined : this.#jobs.get(previousId);
    const seed = seedId === undefined ? null : (this.#jobs.get(seedId)?.spec ?? null);
    return this.#createJob(agent, {
      spec: { kind: "continuation", name: agent.name, seed },
      origin: previous?.origin ?? null,
      createdBy,
      continuedFromJobId: previous?.jobId ?? null,
    });
  }

  #activeChildren(parentAgentId: string | null): number {
    let active = 0;
    for (const agent of this.#agents.values()) {
      if (agent.parentAgentId === parentAgentId && agent.status === "running") active += 1;
    }
    return active;
  }

  #refreshAgent(agentId: string): void {
    const agent = this.#agents.get(agentId);
    if (!agent) return;
    const active = agent.jobIds.some((jobId) => {
      const job = this.#jobs.get(jobId);
      return job !== undefined && LIVE_STATUSES.has(job.status);
    });
    if (!active && agent.status === "running") agent.stoppedOrder = ++this.#stoppedSequence;
    agent.status = active ? "running" : "idle";
  }

  #planMessage(input: { from?: unknown; to?: unknown; content?: unknown }): MessagePlan {
    const { from, to, content } = input;
    if (typeof content !== "string" || content.trim() === "") {
      throw new SubagentError("invalid_message", "A message body must be a non-empty string.");
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      throw new SubagentError(
        "invalid_message",
        `A message body must be at most ${MAX_MESSAGE_CHARS} characters; received ${content.length}.`,
        { length: content.length },
      );
    }
    const sender = canonicalActorId(from);
    if (sender === null || (sender !== MAIN_ACTOR_ID && !this.#agents.has(sender))) {
      throw new SubagentError("unknown_sender", `${describe(from)} is not a sender registered in this runtime.`, {
        from: typeof from === "string" ? from : null,
      });
    }
    const recipient =
      typeof to === "string" && to.trim().toLowerCase() === BROADCAST_TARGET ? BROADCAST_TARGET : canonicalActorId(to);
    if (recipient === null || (recipient !== MAIN_ACTOR_ID && recipient !== BROADCAST_TARGET && !this.#agents.has(recipient))) {
      throw new SubagentError("unknown_agent", `${describe(to)} is not a recipient registered in this runtime.`, {
        to: typeof to === "string" ? to : null,
      });
    }
    if (recipient === sender) {
      throw new SubagentError("invalid_target", "An actor cannot send a message to itself.", { actorId: sender });
    }
    return { from: sender, to: recipient, content };
  }

  /** The typed envelope of one explicit write; `type` and `from` are host-owned. */
  #messageEnvelope(plan: MessagePlan): MessageEnvelope {
    const envelope: MessageEnvelope = { type: "message", from: plan.from, content: plan.content };
    // A Subagent message belongs to its sender's current execution round. The
    // host can therefore correlate it with that round's terminal notice without
    // asking the caller to supply transport or run identity.
    if (plan.from !== MAIN_ACTOR_ID) {
      const source = this.#agents.get(plan.from);
      const live = source === undefined ? null : this.#liveJobOf(source);
      if (live !== null) {
        envelope.jobId = live.jobId;
        envelope.round = Math.max(1, (source?.jobIds.indexOf(live.jobId) ?? -1) + 1);
      }
    }
    return envelope;
  }

  async #sendToMain(plan: MessagePlan): Promise<MessageReceipt> {
    if (this.#deliverToMain === null) {
      throw new SubagentError("delivery_unavailable", "This runtime cannot deliver messages to Main.");
    }
    try {
      await this.#deliverToMain(this.#messageEnvelope(plan));
    } catch (error) {
      throw new SubagentError("delivery_failed", `Could not deliver the message to Main: ${errorMessage(error)}`);
    }
    return { ok: true, to: MAIN_ACTOR_ID, jobId: null };
  }

  /**
   * Hand over to a live adapter, buffer startup input, or explicitly revive an idle actor.
   */
  async #sendToAgent(plan: MessagePlan): Promise<MessageReceipt> {
    const agent = this.#agents.get(plan.to);
    if (agent === undefined) throw new SubagentError("unknown_agent", `No subagent registered as ${describe(plan.to)}.`);
    // At most two transitions: the first hand-over, and — if the run closed
    // while that was in flight — one fresh decision against the successor
    // state. Never a third: parking or retrying is the caller's business.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const live = this.#liveJobOf(agent);

      if (live === null) {
        // No live Job: the agent is idle, so this write revives it. The
        // admission check and the new Job happen in the same synchronous step.
        const refusal = this.#reviveRefusal(agent);
        if (refusal !== null) throw refusal;
        agent.pending.push(this.#messageEnvelope(plan));
        const revived = this.#scheduleContinuation(agent, plan.from);
        this.#start(revived);
        return this.#receipt(plan, revived.jobId);
      }
      if (live.status === "stopping") {
        throw this.#busyError(agent, "stopping");
      }
      if (live.status === "finalizing") {
        throw this.#busyError(agent, "finalizing");
      }
      if (!this.#handles.has(live.jobId)) {
        // A registered sibling has not entered its adapter yet; buffer its initial input.
        agent.pending.push(this.#messageEnvelope(plan));
        return this.#receipt(plan, live.jobId);
      }

      if (await this.#handToJob(live, plan)) {
        return this.#receipt(plan, live.jobId);
      }
      // Refused: the native run closed underneath the hand-over. Loop once
      // more to revive the now-idle agent or to report the successor state.
    }

    throw this.#busyError(agent, "running");
  }

  /**
   * Broadcast one write to the sender's direct children.
   *
   * The recipient set is a snapshot of actor ids whose `parentAgentId` is the
   * sender — no grandchildren, no siblings, no ancestors and never the sender
   * itself. Each recipient gets the same single-target send (so idle children
   * are revived under the ordinary admission rules) and its own explicit
   * outcome; partial fanout is reported, never hidden, and never retried.
   */
  async #broadcast(plan: MessagePlan): Promise<BroadcastReceipt> {
    // Root-level children are parented to `null`, so the reserved Main actor
    // resolves to that same key here and nowhere else.
    const parentKey = plan.from === MAIN_ACTOR_ID ? null : plan.from;
    const recipients: string[] = [];
    for (const agent of this.#agents.values()) {
      if (agent.parentAgentId === parentKey) recipients.push(agent.agentId);
    }
    const sent: BroadcastReceipt["sent"] = [];
    const errors: BroadcastReceipt["errors"] = [];
    for (const agentId of recipients) {
      try {
        const receipt = await this.#sendToAgent({ from: plan.from, to: agentId, content: plan.content });
        sent.push({ to: agentId, jobId: receipt.jobId });
      } catch (error) {
        const info = errorInfo(error, "delivery_failed");
        errors.push({ to: agentId, code: info.code, message: info.message });
      }
    }
    return { ok: errors.length === 0, to: BROADCAST_TARGET, sent, errors };
  }

  /** Hand one message to a live Job; the adapter owns it from there. */
  async #handToJob(job: Job, plan: MessagePlan): Promise<boolean> {
    if (this.#deliverMessage === null) return false;
    let outcome;
    try {
      outcome = await this.#deliverMessage({
        agentId: job.agentId,
        jobId: job.jobId,
        message: this.#messageEnvelope(plan),
      });
    } catch (error) {
      // A thrown SDK handoff error does not prove the message stayed outside
      // the native queue. Only an explicit refusal is safe to reconsider.
      throw new SubagentError('delivery_failed', `Message handoff failed without a safe retry: ${errorMessage(error)}`);
    }
    return outcome?.accepted === true;
  }

  #receipt(plan: MessagePlan, jobId: string | null): MessageReceipt {
    return { ok: true, to: plan.to, jobId };
  }

  #busyError(agent: Agent, status: "stopping" | "finalizing" | "running"): SubagentError {
    const reason =
      status === "stopping"
        ? "is stopping its current run; its terminal result is published when that run exits"
        : "is finishing its current run";
    return new SubagentError("agent_busy", `Agent ${agent.agentId} ${reason}; send the message again when it is idle.`, {
      agentId: agent.agentId,
      status,
    });
  }

  /** The single live Job of an agent, or null when the agent is idle. */
  #liveJobOf(agent: Agent): Job | null {
    for (const jobId of agent.jobIds) {
      const job = this.#jobs.get(jobId);
      if (job !== undefined && LIVE_STATUSES.has(job.status)) return job;
    }
    return null;
  }

  #allocateAgentId(parentAgentId: string | null): string {
    const prefix = parentAgentId ?? "sub";
    let sequence = this.#childSequences.get(prefix) ?? 0;
    let candidate: string;
    do {
      sequence += 1;
      candidate = `${prefix}_${String(sequence).padStart(2, "0")}`;
    } while (this.#agents.has(candidate) || this.#isIdTaken?.(candidate));
    this.#childSequences.set(prefix, sequence);
    this.#onIdAllocated?.(candidate);
    return candidate;
  }

  /** Keep generated ids ahead of every restored actor. */
  #noteSequence(actor: Agent): void {
    const prefix = actor.parentAgentId ?? "sub";
    if (!actor.agentId.startsWith(`${prefix}_`)) return;
    const sequence = Number.parseInt(actor.agentId.slice(prefix.length + 1), 10);
    if (Number.isSafeInteger(sequence) && sequence > (this.#childSequences.get(prefix) ?? 0)) this.#childSequences.set(prefix, sequence);
  }

  #requireJob(jobId: unknown): Job {
    const job = typeof jobId === "string" ? this.#jobs.get(jobId) : null;
    if (!job) throw new SubagentError("unknown_job", `No job registered as ${describe(jobId)}.`);
    return job;
  }

  #budgetView(job: Job): BudgetSnapshot | null {
    if (job.budget !== null) return publicBudgetSnapshot(job.budget);
    return job.budgetSnapshot === null ? null : cloneValue(job.budgetSnapshot);
  }

  #itemView(job: Job): RuntimeTaskItem {
    const item: RuntimeTaskItem = {
      name: job.spec.name,
      agentId: job.agentId,
      jobId: job.jobId,
      status: job.status,
    };
    if (TERMINAL_STATUSES.has(job.status)) {
      if (job.historyState !== undefined) item.historyState = job.historyState;
      if (job.historyError !== undefined && job.historyError !== null) item.historyError = job.historyError;
    }
    const warnings = inheritedWarnings(job.spec);
    if (warnings.length > 0) item.warnings = warnings;
    return item;
  }

  #jobView(job: Job): JobView {
    const view: JobView = {
      jobId: job.jobId,
      agentId: job.agentId,
      name: job.spec.name,
      parentAgentId: this.#agents.get(job.agentId)?.parentAgentId ?? null,
      depth: this.#agents.get(job.agentId)?.depth ?? null,
      status: job.status,
      continuedFromJobId: job.continuedFromJobId,
    };
    if (job.stopping !== null) view.stopping = job.stopping.status;
    if (TERMINAL_STATUSES.has(job.status)) {
      if (job.historyState !== undefined) view.historyState = job.historyState;
      if (job.historyError !== undefined && job.historyError !== null) view.historyError = job.historyError;
    }
    if (job.error !== null) view.error = cloneValue(job.error);
    const budget = this.#budgetView(job);
    if (budget !== null) view.budget = budget;
    const warnings = inheritedWarnings(job.spec);
    if (warnings.length > 0) view.warnings = warnings;
    return view;
  }
}

export function createSubagentRuntime(options: RuntimeOptions): SubagentRuntime {
  return new SubagentRuntime(options);
}
