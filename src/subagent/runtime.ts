/**
 * Pi-independent Subagent lifecycle.
 *
 * An Actor is a persistent collaborator: one batch identity, one goal, one
 * retained conversation. A Job is one execution of that Actor; a continuation
 * is another execution of the same Actor and the same goal.
 *
 * Batches register atomically, then every admitted Job starts directly. One
 * creation is admitted against four independent limits: live batches, live
 * Actors (all kinds and the Inherited subset), and the parent's live direct
 * children. Nothing here is a global scheduler.
 *
 * Runtime owns composition and cancellation, Budget verdicts, finalization and
 * the single terminal publication. It never synthesizes a model-facing
 * completion message: a settled Job publishes one `job-end` event and one
 * internal parent wake, while collaborators report through explicit writes.
 * Messages received before an adapter is ready are buffered as startup input.
 * Explicit messages revive idle actors on their retained context or original
 * seed. A parent with nonterminal direct children keeps its current Job: while
 * its runner waits for them it pauses active-time accounting, then resumes it
 * on the next wake. Active time does not accrue while waiting; the lifetime
 * lease does. Lifecycle events (`onEvent`) let the adapter persist topology and
 * outcomes; `restoreState` rebuilds them without replaying work.
 *
 */

import { randomUUID } from "node:crypto";
import { DEFAULT_HARNESS_CONFIG, type HarnessConfig } from '../harness-config.ts';
import { watchSubagentBudget } from './budget-watch.ts';
import {
  actorKey,
  formatAddress,
  formatChildrenAddress,
  formatGroupAddress,
  MAIN_ACTOR,
  parseActorKey,
  parseAddress,
  SESSION_PATTERN,
} from "./address.ts";

import { createJobBudget, profileForDepth, type BudgetPhase, type BudgetSnapshot, type BudgetSnapshotDetail, type BudgetTerminal, type BudgetTerminalError, type BudgetTermination, type JobBudgetPort } from './job-budget.ts';
import {
  adjudicateTerminal,
  firstEffectiveStopping,
} from "./lifecycle.ts";
import type {
  LifecycleError,
  StoppingReason,
  TerminalStatus,
} from "./lifecycle.ts";

/**
 * How many sibling rows `list` shows per parent. This is a display window, not
 * the admission limit: `subagent.maxActiveChildren` decides how many children a
 * parent may have live.
 */
const LIST_SIBLING_WINDOW = 4;

export type HistoryState = "ready" | "error";
export type JobStatus = "running" | "stopping" | "finalizing" | TerminalStatus;

export interface HistoryBounds {
  startEntryId: string | null;
  endEntryId: string | null;
}

export interface JobHistoryPaths {
  summary: string;
  cleanJsonl: string;
  result?: string;
  [key: string]: unknown;
}

export type { BudgetLimit, BudgetProfile, BudgetPhase, BudgetTermination, BudgetTerminalError, BudgetTerminal, BudgetSnapshot, BudgetSnapshotDetail, BudgetChargeResult, BudgetStartResult, BudgetTerminateResult, JobBudgetPort } from './job-budget.ts';

export interface InheritedContext {
  [key: string]: unknown;
}

/**
 * One Job's persisted spec. The Actor owns the goal, the batch context and the
 * roster; a Job only records how it was composed. A continuation repeats no
 * composition: it is another execution of the recorded Actor.
 */
export interface JobSpec {
  readonly kind: "initial" | "continuation";
  readonly inheritedContext: InheritedContext | null;
}
export type PersistedJobSpec = Record<string, unknown>;

/** One declared member of a batch, in the public full-address projection. */
export interface RosterEntry {
  readonly address: string;
  /** The declared display label, or null when the member declared none. */
  readonly name: string | null;
  readonly goal: string;
}

/**
 * One launch-roster member as persisted: only the session-local Actor key,
 * label and goal. The full address is derived from the current root session on
 * load, so a copied/forked root does not inherit another session's prefix.
 */
export interface LocalRosterEntry {
  readonly id: string;
  readonly name: string | null;
  readonly goal: string;
}

export interface JobRequest {
  agentId: string;
  /** This Actor's logical address. */
  address: string;
  jobId: string;
  index: number | null;
  /** The creating Actor's local key, or null for Main. */
  parentAgentId: string | null;
  /** The creating Actor's logical address; null when Main created the batch. */
  parentAddress: string | null;
  depth: number | null;
  batch: number;
  /** This batch's group selector. */
  group: string;
  /** The Actor's persistent goal for this execution. */
  goal: string;
  /** The batch's shared context, or null. */
  context: string | null;
  /** The immutable launch roster of the batch. */
  roster: readonly RosterEntry[];
  spec: JobSpec;
  origin: unknown;
  budget: JobBudgetPort;
  continuedFromJobId: string | null;
  pendingMessages: RuntimeDelivery[];
  checkBudget(): BudgetSnapshot;
  recordStart(startEntryId: string | null): void;
  /**
   * Stop charging active time while the runner waits for its direct children.
   * The lifetime lease keeps running and is still watched.
   */
  pauseActive(): void;
  /**
   * Charge active time again and rearm the Budget deadline watch. Throws when
   * this Job can no longer run (expired, cancelled or already stopping); the
   * first recorded stop cause is preserved.
   */
  resumeActive(): void;
}

export interface StartedJobHandle {
  done: Promise<unknown>;
  cancel?(): void | Promise<void>;
}

/**
 * A sender from another live session, resolved by the host from the shared
 * session directory. The runtime never reads that directory itself: it accepts
 * only a host-validated descriptor, exactly like the local key of a local write.
 */
export interface ExternalSender {
  readonly sessionId: string;
  /** The composite wire identity `<session-uid>:main`, for display. */
  readonly sender: string;
  /** The sender's real managed Main endpoint, usable as a reply address. */
  readonly replyTo: string;
}

export interface MessageEnvelope {
  type: "message";
  from: string;
  content: string;
  jobId?: string;
  round?: number;
  external?: ExternalSender;
}

export type RuntimeDelivery = MessageEnvelope;

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
  actor?: {
    name: string | null;
    parentAgentId: string | null;
    depth: number;
    batch: number;
    member: number | null;
    goal: string;
    context: string | null;
    roster: readonly LocalRosterEntry[];
    kind: "fresh" | "inherited";
  };
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


export type SignalAction = "interrupt" | "stop";

/** One target's outcome inside a signal request. */
export interface SignalTargetResult {
  readonly address: string;
  readonly ok: boolean;
  readonly status: string;
  readonly reason?: string;
}

export interface SignalResult {
  readonly ok: boolean;
  readonly action: SignalAction;
  readonly to: string;
  readonly targets: readonly SignalTargetResult[];
}

/**
 * One interrupt request handed to the execution side.
 *
 * Interrupt cancels the Job's current native run (the in-flight tool call and
 * model turn). The execution side appends one brief sender-bound interruption
 * notice and continues the same Job, Actor and Budget in a fresh turn; the
 * runtime then keeps the Job `running`. `ok: false` is a truthful refusal, never
 * a request to stop.
 */
export interface InterruptJobInput {
  readonly agentId: string;
  readonly jobId: string;
  readonly address: string;
  /** The requesting Actor's logical address. */
  readonly from: string;
}

export type InterruptOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface RuntimeOptions {
  /** The root session's 8-hex uid; the namespace of every logical address. */
  session: string;
  startJob: (request: JobRequest) => unknown;
  deliverMessage?: (request: DeliverMessageRequest) => DeliveryOutcome | Promise<DeliveryOutcome> | null | undefined;
  deliverToMain?: (message: RuntimeDelivery) => unknown;
  onEvent?: (event: RuntimeEvent) => void;
  /**
   * Lightweight wake for a parent whose last direct child just became truly
   * terminal. It runs after that child's terminal event, including when no
   * delivery handler exists; it never schedules, revives or answers anything.
   */
  onChildrenSettled?: (parentId: string) => void;
  allowInherited?: boolean;
  historyPaths?: (jobId: string) => JobHistoryPaths | null;
  prepareInherited?: (input: { agentId: string; snapshot: InheritedContext }) => unknown;
  isIdTaken?: (id: string) => boolean;
  onIdAllocated?: (id: string) => void;
  finalizeJob?: (input: FinalizeJobInput) => unknown;
  /**
   * The execution side's interrupt capability: abort the current native run,
   * append the sender-bound notice and continue the same Job. Absent means this
   * adapter cannot interrupt, which the runtime reports as
   * `interrupt_unsupported` instead of degrading into a stop.
   */
  interruptJob?: (input: InterruptJobInput) => InterruptOutcome | Promise<InterruptOutcome>;
  /** Ephemeral live phase of one Actor's running Job; null when none is known. */
  /** Monotonic clock for ephemeral elapsed times; defaults to `Date.now`. */
  now?: () => number;
  /**
   * The root's resolved Harness settings. Standalone runtimes fall back to the
   * built-in defaults; a root service passes its own snapshot.
   */
  config?: HarnessConfig;
}

export interface CreatedAgentItem {
  /** This Actor's local key, as create and list show it. */
  id: string;
  /** This Actor's full logical address. */
  address: string;
  name: string | null;
  goal: string;
  /** The host attaches the settled identity after local readiness. */
  role?: string | null;
  model?: string | null;
  warnings?: string[];
}

export interface CreatedBatch {
  batch: number;
  /** The batch's group selector. */
  address: string;
  /** The immutable launch roster, in declared order. */
  roster: readonly RosterEntry[];
  items: CreatedAgentItem[];
  warnings?: string[];
}

export interface AgentView {
  agentId: string;
  address: string;
  name: string | null;
  goal: string;
  batch: number;
  parentAgentId: string | null;
  status: "running" | "idle";
  depth: number;
  /** Which admission pool the actor belongs to; recorded with its topology. */
  kind: "fresh" | "inherited";
}

export interface DetailedAgentItem {
  id: string;
  address: string;
  name: string | null;
  status: string;
  /** Absent for the Main node. */
  kind?: "fresh" | "inherited";
  /** Settled routing identity, assembled once by the root for list and CLI. */
  role?: string | null;
  history?: JobHistoryPaths;
  historyError?: LifecycleError;
  children: DetailedAgentItem[];
}

export interface JobView {
  jobId: string;
  agentId: string;
  address: string;
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
  address: string;
  name: string | null;
  round: number;
  /** The Actor's persistent goal. */
  goal: string;
  status: JobStatus;
  error: LifecycleError | null;
  result: unknown;
  history: HistoryBounds | null;
  historyState?: HistoryState;
  historyError?: LifecycleError;
  budget: BudgetSnapshot | null;
  previousJobId: string | null;
}

/**
 * A Job's readable boundary while it is still running or after it settled.
 * Unlike {@link JobRecordView}, this is available for `running` Jobs so a client
 * can read what the Job has produced so far and then consume live deltas.
 * `history.endEntryId` is the start boundary for a running Job (the native end
 * is owned by the live session); the stream/history adapter fills it from the
 * live snapshot.
 */
export interface JobSnapshotView {
  jobId: string;
  agentId: string;
  address: string;
  name: string | null;
  round: number;
  status: JobStatus;
  history: HistoryBounds | null;
  error: LifecycleError | null;
  previousJobId: string | null;
}

export interface CancelJobResult {
  ok: boolean;
  reason?: string;
  job: JobView;
}

export interface MessageReceipt {
  ok: true;
  to: string;
  jobId: string | null;
}

export interface BroadcastReceipt {
  ok: boolean;
  to: string;
  sent: Array<{ to: string; jobId: string | null }>;
  errors: Array<{ to: string; code: string; message: string }>;
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
  goal: string;
  context: string | null;
  roster: readonly RosterEntry[];
  kind: "fresh" | "inherited";
  batch: number;
  member: number | null;
  parentAgentId: string | null;
  depth: number;
  status: "running" | "idle";
  jobIds: string[];
  pending: MessageEnvelope[];
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
  /** Ephemeral timing of the current status; never persisted. */
  /** Ephemeral start of a parent-hold pause; null while active. */
  waitingSince: number | null;
  /** Ephemeral end time of the terminal transition; never persisted. */
}

interface TaskOptions {
  parentAgentId?: string | null;
  origin?: unknown;
  allowInherited?: boolean;
  captureInheritedContext?: () => unknown;
}

interface PlannedEntry {
  index: number;
  /** Optional display label; the address is the identity. */
  name: string | null;
  goal: string;
  inheritContext: boolean;
  /** Prepared per-member inherited conversation; null until prepared. */
  inheritedContext: InheritedContext | null;
}

interface HistoryFilter {
  id?: string;
  status?: string;
  all?: boolean;
}

interface JobsFilter {
  jobIds?: unknown;
}

/** One validated write handed to a delivery path. */
interface SendPlan {
  fromKey: string;
  fromAddress: string;
  /** The requested target address, echoed in the receipt. */
  to: string;
  content: string;
  external?: ExternalSender;
}

/** One resolved logical target and the Actor keys it selects. */
type ResolvedTarget =
  | { readonly kind: "main" | "actor"; readonly address: string; readonly key: string }
  | { readonly kind: "broadcast"; readonly address: string; readonly keys: readonly string[] };

const MAX_MESSAGE_CHARS = 32768;

const BATCH_FIELDS = new Set(["context", "agents"]);
const MEMBER_FIELDS = new Set(["name", "goal", "inheritContext"]);

/** A live Job occupies its actor and its admission slots. */
const LIVE_STATUSES = new Set(["running", "stopping", "finalizing"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** A Job id is its actor key for the first round and `<actor>#rN` after that. */
const JOB_ID_PATTERN = /^sub_[1-9][0-9]*(-[1-9][0-9]*)?(#r[1-9][0-9]*)?$/;

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
  const record = isPlainObject(error);
  const code = errorCode(error) ?? fallbackCode;
  const message = record && typeof error.message === "string" ? error.message : errorMessage(error);
  const info: LifecycleError = { code, message };
  if (record) {
    const detail = detachedDetail(error.detail);
    if (detail !== null) info.detail = detail;
  }
  return info;
}

/**
 * A detached copy of optional diagnostic detail.
 *
 * Lifecycle errors travel with persisted Job events, so the accepted detail is
 * structured-cloneable data. Uncloneable detail (for example, an object with
 * a function or a live handle) is omitted rather than sharing the thrown
 * object's mutable graph with registry state; the error code and message still
 * describe the failure.
 */
function detachedDetail(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  try {
    return structuredClone(value);
  } catch {
    return null;
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
  const snapshot = budget.snapshot();
  const terminal = snapshot.terminal;
  if (terminal?.error) {
    const publicError = publicBudgetError(terminal.error);
    if (publicError !== null) return { ...snapshot, terminal: { ...terminal, error: publicError } };
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
 * Give one inherited consumer its own native session containers.
 *
 * A captured history is immutable data: `SessionManager` appends by pushing new
 * entries onto its own `fileEntries` array, moves only its leaf pointer, and
 * projects context edits as replacement objects. Session identity, the append
 * array, the branch index and the leaf therefore belong to each child, while the
 * captured entries and their message bodies stay shared. `SessionManager`
 * indexes the array it is handed and appends to it, so the array must never be
 * the capture's or a sibling's; the header carries the child's own session id.
 *
 * The capture comes from a live current-version session, so the SDK's in-place
 * entry migrations (older headers only) never touch these shared entries.
 */
export function copyInheritedEntries(entries: unknown): unknown {
  if (!Array.isArray(entries)) return entries;
  const copy = [...entries];
  const header = copy.findIndex((entry) => isPlainObject(entry) && entry.type === "session" && typeof entry.id === "string");
  if (header !== -1) {
    const original = copy[header];
    if (isPlainObject(original)) copy[header] = { ...original, id: randomUUID() };
  }
  return copy;
}

/**
 * The persisted form of a Job spec. Captured conversation entries are never
 * persisted: a durable adapter stores them in the actor's own session.
 */
function persistedSpec(spec: JobSpec): PersistedJobSpec {
  const copy: PersistedJobSpec = { kind: spec.kind };
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

/**
 * Non-fatal warnings that belong to a Job's entry (for example inherited tools
 * that Pi's public API cannot transplant).
 */
function inheritedWarnings(spec: JobSpec | null | undefined): string[] {
  const warnings = spec?.inheritedContext?.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((warning): warning is string => typeof warning === "string");
}

/**
 * The launch roster as persisted: the session-local Actor key, label and goal
 * only. Full addresses are deliberately not stored. A stored full address, an
 * unknown key, a reordered member or a changed label/goal is invalid.
 */
function localRosterEntries(value: unknown): LocalRosterEntry[] | null {
  if (!Array.isArray(value)) return null;
  const roster: LocalRosterEntry[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) return null;
    if (Object.keys(item).some((key) => key !== "id" && key !== "name" && key !== "goal")) return null;
    const { id, name, goal } = item;
    if (typeof id !== "string" || typeof goal !== "string") return null;
    const parsed = parseActorKey(id);
    if (parsed === null || parsed.batch === null) return null;
    if (name !== null && typeof name !== "string") return null;
    roster.push({ id, name, goal });
  }
  return roster;
}

/** Project the stored local roster to the current root's full addresses. */
function projectRoster(session: string, roster: readonly LocalRosterEntry[]): RosterEntry[] {
  return roster.map((entry) => ({ address: formatAddress(session, entry.id), name: entry.name, goal: entry.goal }));
}

/** The local roster a batch must have for its member layout, in declared order. */
function expectedLocalRoster(members: readonly { key: string; name: string | null; goal: string }[]): LocalRosterEntry[] {
  return members.map((member) => ({ id: member.key, name: member.name, goal: member.goal }));
}

function sameLocalRoster(a: readonly LocalRosterEntry[], b: readonly LocalRosterEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => {
    const other = b[index];
    return other !== undefined && entry.id === other.id && entry.name === other.name && entry.goal === other.goal;
  });
}

/** Convert this runtime's full launch projection into its stored local form. */
function storedRoster(roster: readonly RosterEntry[]): LocalRosterEntry[] {
  return roster.map((entry) => {
    const parsed = parseAddress(entry.address);
    if (parsed === null || parsed.kind !== "actor") {
      throw stateError(`Launch roster address ${describe(entry.address)} is not a local Actor address.`);
    }
    return { id: parsed.key, name: entry.name, goal: entry.goal };
  });
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
      ...(value.error.detail === undefined ? {} : { detail: structuredClone(value.error.detail) }),
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
 * read back from a file that may be truncated or hand-edited, so topology,
 * batch identity and ownership are checked before anything reaches the
 * registry. Batch identity is never inferred from the local segment alone: the
 * recorded topology and the local roster of its batch must agree. The roster is
 * stored without a session prefix; this runtime projects it onto the current
 * root session when restoring. The runtime itself decides the terminal outcome
 * of every Job that never ended.
 */
function planRestore(session: string, state: unknown): { actors: Agent[]; jobs: Array<Job & { interrupted: boolean }> } {
  if (!isPlainObject(state) || !Array.isArray(state.actors) || !Array.isArray(state.jobs)) {
    throw stateError("The restored subagent state must carry actor and Job lists.");
  }
  const actors = new Map<string, Agent>();
  const localRosters = new Map<string, LocalRosterEntry[]>();
  for (const candidate of state.actors) {
    if (!isPlainObject(candidate)) throw stateError("A restored actor entry must be an object.");
    const agentId = candidate.agentId;
    if (typeof agentId !== "string") throw stateError(`${describe(agentId)} is not a subagent actor id.`);
    const keyRef = parseActorKey(agentId);
    if (keyRef === null || keyRef.batch === null) throw stateError(`${describe(agentId)} is not a subagent actor id.`);
    if (actors.has(agentId)) throw stateError(`Actor ${agentId} appears more than once.`);
    const depth = candidate.depth;
    // Historical topology stays readable even when the configured maximum depth
    // is lower now; admission of new work refuses such an actor separately.
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1) {
      throw stateError(`Actor ${agentId} has an invalid depth.`, { agentId });
    }
    const parentAgentId = candidate.parentAgentId ?? null;
    if (parentAgentId !== null && typeof parentAgentId !== "string") {
      throw stateError(`Actor ${agentId} has an invalid parent.`, { agentId });
    }
    if (candidate.batch !== keyRef.batch) throw stateError(`Actor ${agentId} records batch ${describe(candidate.batch)}.`, { agentId });
    if (candidate.member !== keyRef.member) throw stateError(`Actor ${agentId} records member ${describe(candidate.member)}.`, { agentId });
    const goal = candidate.goal;
    if (typeof goal !== "string" || goal.trim() === "") throw stateError(`Actor ${agentId} has no goal.`, { agentId });
    const context = candidate.context ?? null;
    if (context !== null && typeof context !== "string") throw stateError(`Actor ${agentId} has an invalid context.`, { agentId });
    const localRoster = localRosterEntries(candidate.roster);
    if (localRoster === null) throw stateError(`Actor ${agentId} has no valid launch roster.`, { agentId });
    localRosters.set(agentId, localRoster);
    if (candidate.kind !== "fresh" && candidate.kind !== "inherited") throw stateError(`Actor ${agentId} has an invalid kind.`, { agentId });
    const stoppedOrder = candidate.stoppedOrder;
    actors.set(agentId, {
      agentId,
      name: typeof candidate.name === "string" ? candidate.name : null,
      goal,
      context,
      roster: projectRoster(session, localRoster),
      kind: candidate.kind,
      batch: keyRef.batch,
      member: keyRef.member,
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

  // Every batch must be exactly the set of Actors its recorded roster names,
  // in one parent, with one shared context.
  const batches = new Map<number, Agent[]>();
  for (const actor of actors.values()) {
    const members = batches.get(actor.batch) ?? [];
    members.push(actor);
    batches.set(actor.batch, members);
  }
  for (const [batch, members] of batches) {
    const first = at(members, 0);
    const expected = expectedLocalRoster(members
      .map((member) => ({ key: member.agentId, name: member.name, goal: member.goal }))
      .sort((a, b) => (parseActorKey(a.key)?.member ?? 0) - (parseActorKey(b.key)?.member ?? 0)));
    for (const member of members) {
      if (member.parentAgentId !== first.parentAgentId) {
        throw stateError(`Batch ${batch} spans more than one parent.`, { batch });
      }
      if (member.context !== first.context) throw stateError(`Batch ${batch} records more than one context.`, { batch });
      const recordedRoster = localRosters.get(member.agentId);
      if (recordedRoster === undefined || !sameLocalRoster(recordedRoster, expected)) {
        throw stateError(`Actor ${member.agentId} does not match the recorded roster of batch ${batch}.`, { batch, agentId: member.agentId });
      }
    }
    const recorded = members.map((member) => member.agentId).sort();
    const rostered = expected.map((entry) => entry.id).sort();
    if (recorded.join("\u0000") !== rostered.join("\u0000")) {
      throw stateError(`Batch ${batch} does not match its recorded roster.`, { batch });
    }
  }

  const jobs = new Map<string, Job & { interrupted: boolean }>();
  for (const candidate of state.jobs) {
    if (!isPlainObject(candidate)) throw stateError("A restored Job entry must be an object.");
    const jobId = candidate.jobId;
    if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) throw stateError(`${describe(jobId)} is not a Job id.`);
    if (jobs.has(jobId)) throw stateError(`Job ${jobId} appears more than once.`);
    const actor = typeof candidate.agentId === "string" ? actors.get(candidate.agentId) : undefined;
    if (actor === undefined) throw stateError(`Job ${jobId} belongs to unknown actor ${describe(candidate.agentId)}.`);
    if (jobId !== actor.agentId && !jobId.startsWith(`${actor.agentId}#r`)) {
      throw stateError(`Job ${jobId} does not belong to ${actor.agentId}.`);
    }
    const rawSpec = candidate.spec;
    if (!isPlainObject(rawSpec)) throw stateError(`Job ${jobId} has no spec.`);
    if (rawSpec.kind !== "initial" && rawSpec.kind !== "continuation") throw stateError(`Job ${jobId} has an unknown spec kind.`);
    if (rawSpec.inheritedContext != null && !isPlainObject(rawSpec.inheritedContext)) {
      throw stateError(`Job ${jobId} has a malformed inherited snapshot.`);
    }
    if (actor.kind === "fresh" && rawSpec.inheritedContext != null) throw stateError(`Fresh Job ${jobId} has an inherited snapshot.`);
    const createdBy = candidate.createdBy ?? MAIN_ACTOR;
    if (typeof createdBy !== "string" || (createdBy !== MAIN_ACTOR && !actors.has(createdBy))) {
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
    const spec: JobSpec = {
      kind: rawSpec.kind === "continuation" ? "continuation" : "initial",
      inheritedContext: isPlainObject(rawSpec.inheritedContext) ? { ...rawSpec.inheritedContext } : null,
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
      waitingSince: null,
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
 * Registry of Actors and their Jobs.
 *
 * An Actor is a persistent collaborator (one batch identity, one goal, one
 * retained conversation); a Job is one execution of it. create(batch, options)
 * validates the whole batch, admits it against the parent's three limits,
 * registers every member in declared order and starts every Job. Nothing touches
 * the registry before validation and admission succeed.
 */
export class SubagentRuntime {
  /** The root session's address namespace. */
  readonly session: string;
  #startJob: (request: JobRequest) => unknown;
  #deliverMessage: ((request: DeliverMessageRequest) => DeliveryOutcome | Promise<DeliveryOutcome> | null | undefined) | null;
  #deliverToMain: ((message: RuntimeDelivery) => unknown) | null;
  #onEvent: ((event: RuntimeEvent) => void) | null;
  #onChildrenSettled: ((parentId: string) => void) | null;
  #allowInherited: boolean;
  #historyPaths: ((jobId: string) => JobHistoryPaths | null) | null;
  #prepareInherited: ((input: { agentId: string; snapshot: InheritedContext }) => unknown) | null;
  #isIdTaken: ((id: string) => boolean) | null;
  #onIdAllocated: ((id: string) => void) | null;
  #finalizeJob: ((input: FinalizeJobInput) => unknown) | null;
  #interruptJob: ((input: InterruptJobInput) => InterruptOutcome | Promise<InterruptOutcome>) | null;
  #now: () => number;
  #config: HarnessConfig;

  #agents = new Map<string, Agent>();
  #stoppedSequence = 0;
  #jobs = new Map<string, Job>();
  #handles = new Map<string, StartedJobHandle | null>();
  #budgetWatches = new Map<string, () => void>();
  #waiters = new Map<string, Set<(view: JobView) => void>>();
  /** Highest batch number this runtime ever allocated or restored. */
  #highestBatch = 0;
  #transitionDepth = 0;
  #settledParents = new Set<string>();

  constructor(options: RuntimeOptions) {
    const {
      session,
      startJob,
      deliverMessage,
      deliverToMain,
      onEvent,
      onChildrenSettled,
      allowInherited = true,
      historyPaths,
      prepareInherited,
      isIdTaken,
      onIdAllocated,
      finalizeJob,
      interruptJob,
      now,
      config = DEFAULT_HARNESS_CONFIG,
    } = options;

    if (typeof session !== "string" || !SESSION_PATTERN.test(session)) {
      throw new SubagentError("invalid_session", `A Subagent runtime needs the root session's 8-hex uid; received ${describe(session)}.`);
    }
    this.session = session;
    this.#startJob = startJob;
    this.#deliverMessage = deliverMessage ?? null;
    this.#deliverToMain = deliverToMain ?? null;
    this.#onEvent = onEvent ?? null;
    this.#onChildrenSettled = onChildrenSettled ?? null;
    this.#allowInherited = allowInherited;
    this.#historyPaths = historyPaths ?? null;
    this.#prepareInherited = prepareInherited ?? null;
    this.#isIdTaken = isIdTaken ?? null;
    this.#onIdAllocated = onIdAllocated ?? null;
    this.#finalizeJob = finalizeJob ?? null;
    this.#interruptJob = interruptJob ?? null;
    this.#now = now ?? Date.now;
    this.#config = config;
  }

  /** Validate, atomically register and start a batch; return its launch projection. */
  create(batch: unknown, options: TaskOptions = {}): CreatedBatch {
    return this.#withTransition(() => {
      const { members, snapshot, context } = this.#planBatch(batch, options);
      const parentAgentId = options.parentAgentId ?? null;
      const parent = parentAgentId === null ? null : this.#agents.get(parentAgentId);
      if (parentAgentId !== null && parent === undefined) {
        throw new SubagentError("unknown_parent", `No parent agent registered as ${describe(parentAgentId)}.`);
      }
      const depth = (parent?.depth ?? 0) + 1;
      const requestedInherited = members.filter((member) => member.inheritContext).length;
      const refusal = this.#admissionRefusal({
        parentAgentId,
        depth,
        requested: members.length,
        inherited: requestedInherited,
        newBatch: true,
      });
      if (refusal !== null) throw refusal;

      const batchNumber = this.#allocateBatch();
      const multi = members.length > 1;
      const keys = members.map((_member, position) => actorKey(batchNumber, multi ? position + 1 : null));
      const roster: RosterEntry[] = members.map((member, position) => ({
        address: formatAddress(this.session, at(keys, position)),
        name: member.name,
        goal: member.goal,
      }));
      // Same batch, same parent context instant. Each inherited child gets its
      // own conversation: materialized by the adapter, or an in-memory copy.
      members.forEach((member, position) => {
        if (!member.inheritContext) return;
        const agentId = at(keys, position);
        try {
          if (snapshot === null) throw new Error("no calling context was captured");
          const prepared = this.#prepareInherited === null
            ? { ...snapshot, entries: copyInheritedEntries(snapshot.entries) }
            : this.#prepareInherited({ agentId, snapshot });
          if (!isPlainObject(prepared)) throw new Error("the prepared inherited context is not an object");
          member.inheritedContext = prepared;
        } catch (error) {
          throw new SubagentError("inherited_snapshot_failed", `Failed to store the calling context for ${agentId}: ${errorMessage(error)}`);
        }
      });

      const createdBy = parentAgentId ?? MAIN_ACTOR;
      const registered: Job[] = [];
      const warnings = new Set<string>();
      for (const [position, member] of members.entries()) {
        const agentId = at(keys, position);
        const agent: Agent = {
          agentId,
          name: member.name,
          goal: member.goal,
          context,
          roster,
          kind: member.inheritContext ? "inherited" : "fresh",
          batch: batchNumber,
          member: multi ? position + 1 : null,
          parentAgentId,
          depth,
          status: "running",
          jobIds: [],
          pending: [],
        };
        this.#agents.set(agentId, agent);
        this.#onIdAllocated?.(agentId);
        const spec: JobSpec = { kind: "initial", inheritedContext: member.inheritedContext };
        for (const warning of inheritedWarnings(spec)) warnings.add(warning);
        registered.push(this.#createJob(agent, {
          index: position,
          spec,
          origin: options.origin ?? null,
          createdBy,
        }));
      }

      // Register the complete batch before any adapter can observe or start it.
      for (const job of registered) this.#start(job);
      const created: CreatedBatch = {
        batch: batchNumber,
        address: formatGroupAddress(this.session, batchNumber),
        roster,
        items: registered.map((job): CreatedAgentItem => ({
          id: job.agentId,
          address: formatAddress(this.session, job.agentId),
          name: this.#agents.get(job.agentId)?.name ?? null,
          goal: this.#agents.get(job.agentId)?.goal ?? "",
          ...(inheritedWarnings(job.spec).length === 0 ? {} : { warnings: inheritedWarnings(job.spec) }),
        })),
      };
      if (warnings.size > 0) created.warnings = [...warnings];
      return created;
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
    // Every new Job takes this depth's resolved profile. A Job that already
    // exists never re-reads configuration.
    const budget = createJobBudget({
      depth: agent.depth,
      jobId,
      profile: profileForDepth(agent.depth, this.#config.subagent.budgetsByDepth),
    });
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
      waitingSince: null,
    };
    agent.jobIds.push(jobId);
    this.#jobs.set(jobId, job);
    this.#emit({
      type: "job",
      jobId,
      agentId: agent.agentId,
      ...(agent.jobIds.length === 1
        ? {
            actor: {
              name: agent.name,
              parentAgentId: agent.parentAgentId,
              depth: agent.depth,
              batch: agent.batch,
              member: agent.member,
              goal: agent.goal,
              context: agent.context,
              roster: storedRoster(agent.roster),
              kind: agent.kind,
            },
          }
        : {}),
      index,
      createdBy,
      continuedFromJobId,
      spec: persistedSpec(spec),
      origin,
    });
    this.#watchBudget(job);
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

  /**
   * A batch number this root never used: monotonic over the session and checked
   * against every branch and Actor file, so a rewound or abandoned branch never
   * hands its identity to a new batch.
   */
  #allocateBatch(): number {
    let batch = this.#highestBatch + 1;
    while (this.#batchIsTaken(batch)) batch += 1;
    this.#highestBatch = batch;
    return batch;
  }

  #batchIsTaken(batch: number): boolean {
    if (this.#isIdTaken?.(actorKey(batch)) === true) return true;
    if (this.#isIdTaken?.(actorKey(batch, 1)) === true) return true;
    return this.#agents.has(actorKey(batch));
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
    const targetId = filter?.id === undefined ? null : this.#localKey(filter.id);
    if (filter?.id !== undefined && targetId === null) return { agents: [] };
    const agents: AgentView[] = [];
    for (const agent of this.#agents.values()) {
      if (targetId !== null && agent.agentId !== targetId) continue;
      if (filter?.status !== undefined && filter.status !== agent.status) continue;
      agents.push({
        agentId: agent.agentId,
        address: formatAddress(this.session, agent.agentId),
        name: agent.name,
        goal: agent.goal,
        batch: agent.batch,
        parentAgentId: agent.parentAgentId,
        status: agent.status,
        depth: agent.depth,
        kind: agent.kind,
      });
    }
    return { agents };
  }

  /**
   * Public projection of the visible tree, shared by the list tool and the CLI.
   *
   * A node carries addresses and topology, not goals, model configuration or
   * activity. The root attaches the role from its retained identity.
   */
  listDetailed(
    filter: HistoryFilter | null,
    { callerId }: { callerId: string },
  ): DetailedAgentItem | null {
    const caller = this.#localKey(callerId);
    if (caller === null) throw new SubagentError("unknown_agent", `${describe(callerId)} is not an actor address of this session.`);
    const targetId = filter?.id === undefined ? null : this.#localKey(filter.id);
    if (filter?.id !== undefined && targetId === null) return null;
    const agents = [...this.#agents.values()];
    const visible = new Set<string>();
    const main: DetailedAgentItem = {
      id: MAIN_ACTOR,
      address: formatAddress(this.session, MAIN_ACTOR),
      name: null,
      status: "running",
      role: null,
      children: [],
    };
    if (filter?.all === true) {
      visible.add(MAIN_ACTOR);
      for (const agent of agents) visible.add(agent.agentId);
    } else {
      const group = (parentId: string | null, selfId?: string) => this.#visibleGroup(parentId, selfId);
      const addChildren = (agent: Agent): void => {
        if (agent.status !== "running") return;
        for (const child of group(agent.agentId)) visible.add(child.agentId);
      };
      if (caller === MAIN_ACTOR) {
        visible.add(MAIN_ACTOR);
        for (const child of group(null)) {
          visible.add(child.agentId);
          addChildren(child);
        }
      } else {
        const self = this.#agents.get(caller);
        if (!self) throw new SubagentError("unknown_agent", `No subagent registered as ${caller}.`);
        visible.add(self.parentAgentId ?? MAIN_ACTOR);
        for (const peer of group(self.parentAgentId, caller)) visible.add(peer.agentId);
        addChildren(self);
      }
    }
    const nodes = new Map<string, DetailedAgentItem>();
    if (visible.has(MAIN_ACTOR)) nodes.set(MAIN_ACTOR, main);
    const listed = [...visible]
      .filter((id) => id !== MAIN_ACTOR)
      .map((id) => this.#agents.get(id))
      .filter((agent): agent is Agent => agent !== undefined);
    for (const agent of listed) {
      const liveJob = this.#liveJobOf(agent);
      const currentStatus = liveJob ? liveJob.status : agent.status;
      if (filter?.status !== undefined && filter.status !== currentStatus && filter.status !== agent.status) continue;
      const item: DetailedAgentItem = {
        id: agent.agentId,
        address: formatAddress(this.session, agent.agentId),
        name: agent.name,
        status: liveJob ? "running" : "stopped(unknown)",
        kind: agent.kind,
        role: null,
        children: [],
      };
      const latest = [...agent.jobIds]
        .reverse()
        .map((jobId) => this.#jobs.get(jobId))
        .find((job): job is Job => job !== undefined && TERMINAL_STATUSES.has(job.status));
      if (!liveJob && latest !== undefined) {
        item.status = latest.status === "completed" ? "idle" : `stopped(${latest.status})`;
      }
      if (latest !== undefined && this.#historyPaths !== null) {
        try {
          const history = this.#historyPaths(latest.jobId);
          if (history) item.history = history;
        } catch (error) {
          // A derived view belongs to this row only. One unreadable history
          // must neither hide healthy siblings nor rewrite the Job outcome.
          item.historyError = errorInfo(error, "history_unavailable");
        }
      }
      nodes.set(item.id, item);
    }
    for (const agent of listed) {
      const node = nodes.get(agent.agentId);
      const parent = nodes.get(agent.parentAgentId ?? MAIN_ACTOR);
      if (node && parent) parent.children.push(node);
    }
    const rootId = targetId ?? (filter?.all === true || caller === MAIN_ACTOR
      ? MAIN_ACTOR : this.#agents.get(caller)?.parentAgentId ?? MAIN_ACTOR);
    return nodes.get(rootId) ?? null;
  }

  #visibleGroup(parentId: string | null, selfId?: string): Agent[] {
    const siblings = [...this.#agents.values()].filter((agent) => agent.parentAgentId === parentId);
    const active = siblings.filter((agent) => agent.status === "running");
    const stopped = siblings.filter((agent) => agent.status !== "running").reverse()
      .sort((a, b) => (b.stoppedOrder ?? 0) - (a.stoppedOrder ?? 0));
    const self = siblings.find((agent) => agent.agentId === selfId);
    return [...(self ? [self] : []), ...active.filter((agent) => agent !== self), ...stopped.filter((agent) => agent !== self)]
      .slice(0, LIST_SIBLING_WINDOW);
  }

  /**
   * The live direct children of one parent, for the three independent limits.
   * A batch counts once while any of its members is live; `stopping` and
   * `finalizing` Jobs still occupy their slots until the native run exits.
   */
  #liveChildren(parentAgentId: string | null): { total: number; inherited: number; batches: Set<number> } {
    let total = 0;
    let inherited = 0;
    const batches = new Set<number>();
    for (const agent of this.#agents.values()) {
      if (agent.parentAgentId !== parentAgentId || !this.#hasActiveJob(agent)) continue;
      total += 1;
      if (agent.kind === "inherited") inherited += 1;
      batches.add(agent.batch);
    }
    return { total, inherited, batches };
  }

  /**
   * One creation or revival against one parent's three limits. All three count
   * that parent's live direct children, so no session-wide scheduler appears
   * here; batch identity itself is session-wide and unlimited in scope.
   */
  #admissionRefusal(input: {
    parentAgentId: string | null;
    depth: number;
    requested: number;
    inherited: number;
    newBatch: boolean;
  }): SubagentError | null {
    const { maxDepth, maxActiveBatches, maxActiveSubagents, maxActiveInheritedSubagents } = this.#config.subagent;
    const parentLabel = input.parentAgentId ?? MAIN_ACTOR;
    // Historical topology stays readable when the configured maximum depth is
    // lower now; admission of new work refuses it here.
    if (input.depth > maxDepth) {
      return new SubagentError(
        "max_depth_exceeded",
        `Agent depth ${input.depth} exceeds the maximum depth ${maxDepth}; depth-${maxDepth} agents cannot create children.`,
        { parentAgentId: input.parentAgentId, depth: input.depth, maxDepth },
      );
    }
    const live = this.#liveChildren(input.parentAgentId);
    if (input.newBatch && live.batches.size + 1 > maxActiveBatches) {
      return new SubagentError(
        "batch_limit_exceeded",
        `${parentLabel} already has ${live.batches.size} live batches; at most ${maxActiveBatches} are allowed.`,
        { parentAgentId: input.parentAgentId, activeBatches: live.batches.size, maxActiveBatches },
      );
    }
    if (live.total + input.requested > maxActiveSubagents) {
      return new SubagentError(
        "subagent_limit_exceeded",
        `${parentLabel} already has ${live.total} live direct children; at most ${maxActiveSubagents} are allowed.`,
        { parentAgentId: input.parentAgentId, activeChildren: live.total, requestedChildren: input.requested, maxActiveSubagents },
      );
    }
    if (live.inherited + input.inherited > maxActiveInheritedSubagents) {
      return new SubagentError(
        "inherited_limit_exceeded",
        `${parentLabel} already has ${live.inherited} live inherited children; at most ${maxActiveInheritedSubagents} are allowed.`,
        { parentAgentId: input.parentAgentId, activeInherited: live.inherited, requestedInherited: input.inherited, maxActiveInheritedSubagents },
      );
    }
    return null;
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
   * Whether an actor has any direct child whose current Job is still
   * nonterminal (`running`, `stopping` or `finalizing`).
   *
   * Topology is direct-child only: a grandchild stays the responsibility of
   * its own parent. This is a query, so an unknown actor simply has none.
   * A cancelled or failed parent may still have active children; that is a
   * legitimate late-notice case, not a state invariant to repair here.
   */
  hasActiveChildren(agentId: string): boolean {
    if (typeof agentId !== "string" || agentId === "") return false;
    if (agentId !== MAIN_ACTOR && !this.#agents.has(agentId)) return false;
    const parentKey = agentId === MAIN_ACTOR ? null : agentId;
    for (const agent of this.#agents.values()) {
      if (agent.parentAgentId === parentKey && this.#hasActiveJob(agent)) return true;
    }
    return false;
  }

  /**
   * Accept a write for a local Actor or for one broadcast selector.
   *
   * The sender identity comes from the host, never from message text. The
   * receipt means "this message entered a delivery path" — a live Job took it,
   * a starting adapter will receive buffered input, or an idle Actor was revived
   * with a new Job for it — and never waits for a model response.
   *
   * Reviving an idle Actor creates a Job, so it is admitted exactly like a new
   * child: while the parent already holds its live-child or live-batch
   * allowance, the whole write is rejected before any message or Job exists.
   *
   * A write that arrives while the Actor is stopping, or while its run closes
   * underneath the hand-over, is rejected with `agent_busy` instead of being
   * parked in a deferred state: the caller retries against the successor state.
   *
   * `to` is one logical address: an Actor, a batch group (`batch_<n>`) or an
   * Actor's direct children (`<actor>/children`). Broadcasts always exclude the
   * sender; an empty recipient set after that filter is an ordinary zero-target
   * receipt, while a single target equal to the sender is a direct self-send.
   *
   * A sender that is not registered here is accepted only with an `external`
   * descriptor that the host resolved from the shared session directory. That
   * path is Main-to-Main only: another session may reach this Main, nothing else.
   */
  async sendMessage(
    input: { from?: unknown; to?: unknown; content?: unknown; signal?: AbortSignal; external?: ExternalSender } = {},
  ): Promise<MessageReceipt | BroadcastReceipt> {
    const { from, to, content, signal, external } = input;
    if (signal?.aborted) {
      throw new SubagentError("aborted", "The write was aborted before it was delivered.");
    }
    const body = this.#messageBody(content);
    const sender = this.#sender(from, external);
    const target = this.#target(to, sender.key);
    if (external !== undefined && target.kind !== "main") {
      throw new SubagentError("invalid_target", "A cross-session message is delivered to the target session's Main only.", { actorId: target.address });
    }
    if (target.kind === "main") {
      if (external === undefined && sender.key === MAIN_ACTOR) {
        throw new SubagentError("invalid_target", "An actor cannot send a message to itself.", { actorId: sender.address });
      }
      return this.#sendToMain({ fromKey: sender.key, fromAddress: sender.address, to: target.address, content: body, ...(external === undefined ? {} : { external }) });
    }
    if (target.kind === "broadcast") {
      return this.#broadcast(sender.key, sender.address, target, body);
    }
    if (target.key === sender.key) {
      throw new SubagentError("invalid_target", "An actor cannot send a message to itself.", { actorId: sender.address });
    }
    return this.#sendToAgent(sender.key, sender.address, target.key, target.address, body);
  }

  /**
   * Control one Actor or one selector: `interrupt` or `stop`.
   *
   * `stop` ends the current Job, keeps the Actor's goal, identity and history,
   * and occupies capacity until the native resource has actually exited (exactly
   * like `cancelJob`). `interrupt` never ends the Job: the execution side
   * aborts the current native run, appends one brief sender-bound interruption
   * notice and continues the same Job, Actor and Budget; when that capability is
   * unavailable the truthful answer is `interrupt_unsupported`.
   */
  async signal(input: { from?: unknown; to?: unknown; action?: unknown } = {}): Promise<SignalResult> {
    const action = input.action;
    if (action !== "interrupt" && action !== "stop") {
      throw new SubagentError("invalid_request", 'signal requires an action of "interrupt" or "stop".');
    }
    const sender = this.#sender(input.from, undefined);
    const target = this.#target(input.to, sender.key);
    if (target.kind === "actor" && target.key === sender.key) {
      throw new SubagentError("invalid_target", "An actor cannot signal itself.", { actorId: sender.address });
    }
    if (target.kind === "main") {
      throw new SubagentError("invalid_target", "Main has no Job in this runtime to signal.", { actorId: target.address });
    }
    const keys = target.kind === "broadcast" ? target.keys : [target.key];
    const targets: SignalTargetResult[] = [];
    for (const key of keys) targets.push(await this.#signalOne(key, action, sender.address));
    return { ok: targets.every((entry) => entry.ok), action, to: target.address, targets };
  }

  async #signalOne(key: string, action: SignalAction, fromAddress: string): Promise<SignalTargetResult> {
    const address = formatAddress(this.session, key);
    const agent = this.#agents.get(key);
    if (agent === undefined) return { address, ok: false, status: "unknown", reason: "unknown_agent" };
    const live = this.#liveJobOf(agent);
    if (action === "stop") {
      if (live === null) return { address, ok: true, status: "idle" };
      const result = this.cancelJob(live.jobId);
      return {
        address,
        ok: result.ok,
        status: result.job.status,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
    }
    if (live === null) return { address, ok: false, status: "idle", reason: "not_running" };
    if (live.status !== "running" || live.stopping !== null) return { address, ok: false, status: live.status, reason: live.status };
    if (this.#interruptJob === null) return { address, ok: false, status: "running", reason: "interrupt_unsupported" };
    let outcome: InterruptOutcome;
    try {
      outcome = await this.#interruptJob({ agentId: key, jobId: live.jobId, address, from: fromAddress });
    } catch (error) {
      return { address, ok: false, status: live.status, reason: errorInfo(error, "interrupt_failed").code };
    }
    // The native run may have settled while the interruption was in flight.
    if (this.#jobs.get(live.jobId) !== live || !LIVE_STATUSES.has(live.status)) {
      return { address, ok: false, status: live.status, reason: "already_finished" };
    }
    if (live.status !== "running" || live.stopping !== null) {
      return { address, ok: false, status: live.status, reason: live.status === "running" ? "stopping" : live.status };
    }
    if (isPlainObject(outcome) && outcome.ok === true) {
      return { address, ok: true, status: "running" };
    }
    const reason = isPlainObject(outcome) && typeof outcome.reason === "string" ? outcome.reason : "interrupt_unsupported";
    return { address, ok: false, status: "running", reason };
  }

  /**
   * Cancel one Job without touching any other Job or Actor.
   *
   * A Job whose adapter has not started goes directly through finalization.
   * A started Job stays `stopping` (occupying its Actor and admission slots)
   * until the adapter's handle settles, then publishes its cancelled payload.
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

  /** Resolves once the job reaches a terminal status (or immediately if it already has). */
  jobDone(jobId: unknown): Promise<JobView> {
    const job = this.#requireJob(jobId);
    if (TERMINAL_STATUSES.has(job.status)) return Promise.resolve(this.#jobView(job));
    return new Promise((resolve) => {
      this.#addWaiter(job, resolve);
    });
  }

  /**
   * Observe one Job's terminal transition without an uncancellable Promise.
   * The detach removes only this listener; it never affects the Job or another
   * observer. A listener registered for an already-terminal Job is called
   * immediately, matching `jobDone`'s resolved value.
   */
  observeJobDone(jobId: unknown, listener: (view: JobView) => void): () => void {
    const job = this.#requireJob(jobId);
    if (TERMINAL_STATUSES.has(job.status)) {
      try {
        listener(this.#jobView(job));
      } catch {
        // Observation is best-effort and must not turn a terminal read into an error.
      }
      return () => {};
    }
    return this.#addWaiter(job, listener);
  }

  #addWaiter(job: Job, listener: (view: JobView) => void): () => void {
    const waiters = this.#waiters.get(job.jobId) ?? new Set<(view: JobView) => void>();
    waiters.add(listener);
    this.#waiters.set(job.jobId, waiters);
    return () => {
      const current = this.#waiters.get(job.jobId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.#waiters.delete(job.jobId);
    };
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
      address: formatAddress(this.session, job.agentId),
      name: agent?.name ?? null,
      round: Math.max(1, (agent?.jobIds.indexOf(job.jobId) ?? 0) + 1),
      goal: agent?.goal ?? "",
      status: job.status,
      error: structuredClone(job.error),
      result: structuredClone(job.result),
      history: job.history === null ? null : { ...job.history },
      budget: this.#budgetView(job),
      previousJobId: job.continuedFromJobId,
    };
    if (job.historyState !== undefined) record.historyState = job.historyState;
    if (job.historyError !== undefined) record.historyError = job.historyError;
    return record;
  }

  /**
   * Readable boundary for any registered Job, including a `running` one.
   * Returns null only for an unknown Job. The native end/partial belong to the
   * live session and are supplied by the adapter's live snapshot.
   */
  jobSnapshot(jobId: unknown): JobSnapshotView | null {
    const job = typeof jobId === "string" ? this.#jobs.get(jobId) : undefined;
    if (job === undefined) return null;
    const agent = this.#agents.get(job.agentId);
    return {
      jobId: job.jobId,
      agentId: job.agentId,
      address: formatAddress(this.session, job.agentId),
      name: agent?.name ?? null,
      round: Math.max(1, (agent?.jobIds.indexOf(job.jobId) ?? 0) + 1),
      status: job.status,
      history: job.history === null ? null : { ...job.history },
      error: structuredClone(job.error),
      previousJobId: job.continuedFromJobId,
    };
  }

  /**
   * Restore a registry folded from persisted events into a fresh runtime.
   *
   * `state.actors` carry the recorded topology
   * (`{ agentId, name, parentAgentId, depth, batch, member, goal, context,
   * roster, kind, stoppedOrder }`);
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
    const restored = planRestore(this.session, state);
    for (const actor of restored.actors) {
      this.#agents.set(actor.agentId, actor);
      if (actor.batch > this.#highestBatch) this.#highestBatch = actor.batch;
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

  /**
   * Queue a parent wake when the just-ended Job was its last active direct
   * child. The wake is deferred until the current transition settles, so it
   * cannot overtake the terminal event that made the child terminal.
   */
  #queueChildrenSettled(job: Job): void {
    if (this.#onChildrenSettled === null) return;
    const parentId = this.#agents.get(job.agentId)?.parentAgentId ?? null;
    // Main has no runner to wake.
    if (parentId === null) return;
    if (this.hasActiveChildren(parentId)) return;
    this.#settledParents.add(parentId);
    if (this.#transitionDepth > 0) return;
    this.#flushChildrenSettled();
  }

  #flushChildrenSettled(): void {
    if (this.#settledParents.size === 0 || this.#onChildrenSettled === null) {
      this.#settledParents.clear();
      return;
    }
    const parents = [...this.#settledParents];
    this.#settledParents.clear();
    const notify = this.#onChildrenSettled;
    for (const parentId of parents) {
      // A child admitted during the same transition may still be live. Then
      // that child's own terminal transition owns the next wake.
      if (this.hasActiveChildren(parentId)) continue;
      this.#attempt(() => notify(parentId));
    }
  }

  /**
   * Coalesce one synchronous transition: a batch that registers four Jobs,
   * starts them and fails one of them publishes its events and its one parent
   * wake once the whole batch is registered.
   */
  #withTransition<T>(run: () => T): T {
    this.#transitionDepth += 1;
    try {
      return run();
    } finally {
      this.#transitionDepth -= 1;
      if (this.#transitionDepth === 0) this.#flushChildrenSettled();
    }
  }

  /**
   * Validate one batch description. Creation is minimal: one optional shared
   * context and one or more members, each with a goal and an optional display
   * label. The old task-batch fields are not aliases; an unknown field is an
   * error, so a caller cannot half-migrate.
   */
  #planBatch(batch: unknown, options: TaskOptions): { members: PlannedEntry[]; snapshot: InheritedContext | null; context: string | null } {
    if (!isPlainObject(batch)) {
      throw new SubagentError("invalid_batch", "subagent_create expects an object with a non-empty agents array.");
    }
    for (const key of Object.keys(batch)) {
      if (!BATCH_FIELDS.has(key)) {
        throw new SubagentError("invalid_batch", `Unknown batch field ${describe(key)}.`);
      }
    }
    if (!Array.isArray(batch.agents) || batch.agents.length === 0) {
      throw new SubagentError("invalid_batch", "agents must be a non-empty array.");
    }
    const rawContext = batch.context;
    if (rawContext !== undefined && rawContext !== null && typeof rawContext !== "string") {
      throw new SubagentError("invalid_batch", "context must be a string when provided.");
    }
    const context = typeof rawContext === "string" ? rawContext : null;
    const members = batch.agents.map((raw, index) => this.#planMember(raw, index));

    if (members.some((member) => member.inheritContext)) {
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
      return { members, snapshot, context };
    }

    return { members, snapshot: null, context };
  }

  #planMember(raw: unknown, index: number): PlannedEntry {
    const where = `agents[${index}]`;
    const reject = (message: string, detail: Record<string, unknown> = {}): never => {
      throw new SubagentError("invalid_task", message, { index, ...detail });
    };

    if (!isPlainObject(raw)) throw new SubagentError("invalid_task", `${where} must be an object.`, { index });
    for (const key of Object.keys(raw)) {
      if (!MEMBER_FIELDS.has(key)) reject(`${where} has unknown field ${describe(key)}.`, { field: key });
    }
    if (raw.inheritContext !== undefined && typeof raw.inheritContext !== "boolean") {
      reject(`${where}.inheritContext must be a boolean when provided.`, { field: "inheritContext" });
    }

    let name: string | null = null;
    const rawName = raw.name;
    if (rawName !== undefined && rawName !== null) {
      if (typeof rawName !== "string") throw new SubagentError("invalid_task", `${where}.name must be a non-empty string.`, { index, field: "name" });
      const trimmedName = rawName.trim();
      if (trimmedName === "") reject(`${where}.name must be a non-empty string.`, { field: "name" });
      name = trimmedName;
    }
    const rawGoal = raw.goal;
    if (typeof rawGoal !== "string") {
      throw new SubagentError("invalid_task", `${where}.goal must be a non-empty string.`, { index, field: "goal" });
    }
    const goal = rawGoal.trim();
    if (goal === "") reject(`${where}.goal must be a non-empty string.`, { field: "goal" });

    return { index, name, goal, inheritContext: raw.inheritContext === true, inheritedContext: null };
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

      this.#watchBudget(job);
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
    if (agent === undefined) throw stateError(`Job ${job.jobId} has no Actor.`);
    return {
      agentId: job.agentId,
      address: formatAddress(this.session, job.agentId),
      jobId: job.jobId,
      index: job.index,
      parentAgentId: agent.parentAgentId,
      parentAddress: agent.parentAgentId === null ? null : formatAddress(this.session, agent.parentAgentId),
      depth: agent.depth,
      batch: agent.batch,
      group: formatGroupAddress(this.session, agent.batch),
      goal: agent.goal,
      context: agent.context,
      roster: agent.roster,
      spec: job.spec,
      origin: job.origin,
      budget,
      continuedFromJobId: job.continuedFromJobId,
      pendingMessages: pending,
      checkBudget: () => this.#checkBudget(job),
      recordStart: (startEntryId) => this.#recordStart(job, startEntryId),
      pauseActive: () => this.#pauseActive(job),
      resumeActive: () => this.#resumeActive(job),
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
    this.#clearBudgetWatch(job.jobId);

    const payload = isPlainObject(execution) ? execution : {};
    // The runtime owns a detached result: views and terminal events hand out
    // copies, so the accepted payload is a structured-cloneable value (the
    // native adapter yields a string). A result that cannot be detached fails
    // the Job through the normal terminal path instead of retaining a shared
    // mutable payload.
    let resultError: LifecycleError | null = null;
    if (payload.result !== undefined && payload.result !== null) {
      try {
        job.result = structuredClone(payload.result);
      } catch {
        resultError = {
          code: "invalid_result",
          message: "The adapter returned a Job result that cannot be detached; the result was discarded and the Job failed.",
        };
      }
    }
    const bounds = historyBounds(payload.history);
    if (bounds !== null) job.history = bounds;

    const budgetTerminal = budget.check().terminal;
    const decision = adjudicateTerminal({
      stopping: job.stopping,
      budgetError: budgetTerminal?.status === "failed" ? publicBudgetError(budgetTerminal.error) : null,
      executionError: payload.error ? errorInfo(payload.error, "job_failed") : resultError,
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
    job.waitingSince = null;
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

  #checkBudget(job: Job): BudgetSnapshot {
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

  #clearBudgetWatch(jobId: string): void {
    this.#budgetWatches.get(jobId)?.();
    this.#budgetWatches.delete(jobId);
  }

  /**
   * Freeze active-time accounting while the runner waits for direct children.
   * `#watchBudget` re-arms from the paused snapshot, so the lifetime lease is
   * still observed; no active-time deadline remains while the Job is parked.
   */
  #pauseActive(job: Job): void {
    this.#withTransition(() => {
      if (job.status !== "running") return;
      const budget = job.budget;
      if (budget === null) throw stateError(`Job ${job.jobId} has no Budget.`);
      budget.pauseActive();
      if (job.waitingSince === null) job.waitingSince = this.#now();
      this.#watchBudget(job);
    });
  }

  /**
   * Charge active time again after waiting and rearm its Budget deadline.
   *
   * A Job that expired while paused, was cancelled, or is already stopping
   * cannot resume. Starting that stopping transition goes through
   * `firstEffectiveStopping`, so an earlier cause is never rewritten; the
   * caller receives that same cause as the thrown error.
   */
  #resumeActive(job: Job): void {
    this.#withTransition(() => {
      if (job.status !== "running") throw this.#resumeRefusal(job);
      const budget = job.budget;
      if (budget === null) throw stateError(`Job ${job.jobId} has no Budget.`);
      job.waitingSince = null;
      const started = budget.startActive();
      if (!started.ok) {
        if (started.terminal === null) {
          // already_running: the active window never closed; only rearm.
          this.#watchBudget(job);
          return;
        }
        const error = publicBudgetError(started.terminal.error);
        const status: TerminalStatus = started.terminal.status === "cancelled" ? "cancelled" : "failed";
        this.#beginStopping(job, status, error ?? { code: started.reason, message: "Job cannot resume active time." });
        throw new SubagentError(
          error?.code ?? started.reason,
          `Job ${job.jobId} cannot resume active time: ${started.reason}.`,
          { jobId: job.jobId, status: started.terminal.status, termination: started.terminal.termination },
        );
      }
      this.#watchBudget(job);
    });
  }

  #resumeRefusal(job: Job): SubagentError {
    const stopping = job.stopping;
    return new SubagentError(
      stopping?.error?.code ?? stopping?.status ?? "agent_busy",
      stopping === null
        ? `Job ${job.jobId} cannot resume: it is ${job.status}.`
        : `Job ${job.jobId} cannot resume: it is already stopping for ${stopping.status}.`,
      { jobId: job.jobId, status: job.status, ...(stopping === null ? {} : { stopping: stopping.status }) },
    );
  }

  #watchBudget(job: Job): void {
    this.#clearBudgetWatch(job.jobId);
    if (job.budget === null) return;
    const stop = watchSubagentBudget(job.budget, () => this.#checkBudget(job));
    if (TERMINAL_STATUSES.has(job.status) || job.status === 'stopping' || job.status === 'finalizing') stop();
    else this.#budgetWatches.set(job.jobId, stop);
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
      this.#clearBudgetWatch(job.jobId);
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
      this.#clearBudgetWatch(job.jobId);
      job.status = terminalInfo.status;
      job.error = terminalInfo.error ?? null;
      if (terminalInfo.historyState !== undefined) {
        job.historyState = terminalInfo.historyState;
      }
      if (terminalInfo.historyError !== undefined && terminalInfo.historyError !== null) {
        job.historyError = terminalInfo.historyError;
      }
      this.#handles.delete(job.jobId);
      job.waitingSince = null;
      this.#emitEnd(job);
      this.#settle(job);
    });
    // A settled Job never synthesizes a model-facing completion message: the
    // durable outcome lives in the job-end event, the views and the record. The
    // parent wake stays internal and cannot carry a collaborator result.
    this.#queueChildrenSettled(job);
  }

  #emitEnd(job: Job): void {
    const event: JobEndEvent = {
      type: "job-end",
      jobId: job.jobId,
      status: terminalStatus(job.status, job.jobId),
      error: structuredClone(job.error),
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
    if (waiters !== undefined) {
      // Detach the bucket and its listeners before invoking any callback: a
      // callback may unsubscribe or re-enter, and must not be able to leave a
      // stale waiter behind or affect another observer.
      this.#waiters.delete(job.jobId);
      const listeners = [...waiters];
      waiters.clear();
      const view = this.#jobView(job);
      for (const listener of listeners) {
        try {
          listener(view);
        } catch {
          // Observation is best-effort; one observer must not break settlement
          // or suppress the remaining observers.
        }
      }
    }
    this.#refreshAgent(job.agentId);
  }

  #attempt(run: () => unknown): void {
    try {
      const pending = run();
      if (isPromiseLike(pending)) pending.then(undefined, () => {});
    } catch {
      // One attempt, never retried.
    }
  }

  /**
   * Admission for waking an idle Actor: revival creates a Job and makes the
   * Actor live again, so it is admitted exactly like a new member — the same
   * three limits of its parent, and a batch counts once more when no member of
   * it is live any more. When it does not fit, the caller rejects the whole
   * write instead of holding a deferred revival.
   */
  #reviveRefusal(agent: Agent): SubagentError | null {
    const live = this.#liveChildren(agent.parentAgentId);
    return this.#admissionRefusal({
      parentAgentId: agent.parentAgentId,
      depth: agent.depth,
      requested: 1,
      inherited: agent.kind === "inherited" ? 1 : 0,
      newBatch: !live.batches.has(agent.batch),
    });
  }

  /**
   * Register the continuation Job for an idle Actor that should wake.
   *
   * A continuation repeats no composition: the Actor's recorded goal, context,
   * roster and retained conversation are the execution's context. An Actor that
   * never started at all — its first Job was cancelled before the SDK
   * initialized — still revives into its first session; the adapter uses the
   * retained conversation when there is one and never re-runs the goal alone.
   */
  #scheduleContinuation(agent: Agent, createdBy: string): Job {
    const previousId = agent.jobIds[agent.jobIds.length - 1];
    const previous = previousId === undefined ? undefined : this.#jobs.get(previousId);
    return this.#createJob(agent, {
      // Until the first native session exists, the original capture is the
      // Actor's only execution identity. A retained session supersedes it in the adapter.
      spec: { kind: "continuation", inheritedContext: previous?.spec.inheritedContext ?? null },
      origin: previous?.origin ?? null,
      createdBy,
      continuedFromJobId: previous?.jobId ?? null,
    });
  }

  /** A Job occupies its actor until it is truly terminal, finalizing included. */
  #hasActiveJob(agent: Agent): boolean {
    return agent.jobIds.some((jobId) => {
      const job = this.#jobs.get(jobId);
      return job !== undefined && LIVE_STATUSES.has(job.status);
    });
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

  /** Message body validation shared by every write path. */
  #messageBody(content: unknown): string {
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
    return content;
  }

  /**
   * Canonicalize a local Actor identity: a local segment or a full address of
   * this session. `Main` is accepted as the display spelling of `main`, never
   * as a second key.
   */
  #localKey(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const address = parseAddress(trimmed);
    if (address !== null) {
      if (address.session !== this.session || address.kind !== "actor") return null;
      return address.key;
    }
    return parseActorKey(trimmed)?.key ?? null;
  }

  /**
   * The sender of one write. A local frame names a local key; an external frame
   * arrives with a host-validated descriptor whose `sender` is the remote
   * `<session>:main` address, and is delivered to this Main as that sender.
   */
  #sender(from: unknown, external: ExternalSender | undefined): { key: string; address: string } {
    if (external !== undefined) {
      if (!isPlainObject(external)
        || typeof external.sessionId !== "string" || external.sessionId === ""
        || typeof external.sender !== "string" || typeof external.replyTo !== "string" || external.replyTo === "") {
        throw new SubagentError("unknown_sender", "The external sender descriptor is malformed.");
      }
      const remote = parseAddress(external.sender);
      if (remote === null || remote.kind !== "actor" || remote.key !== MAIN_ACTOR || remote.session === this.session) {
        throw new SubagentError("invalid_sender", "Only another live session's Main may send a cross-session message.", {
          actorId: typeof from === "string" ? from : null,
        });
      }
      if (from !== undefined && from !== external.sender) {
        throw new SubagentError("invalid_sender", "The declared sender does not match the resolved external session.", {
          actorId: typeof from === "string" ? from : null,
        });
      }
      return { key: MAIN_ACTOR, address: external.sender };
    }
    const key = this.#localKey(from);
    if (key === null) {
      throw new SubagentError("unknown_sender", `${describe(from)} is not a sender registered in this runtime.`, {
        from: typeof from === "string" ? from : null,
      });
    }
    if (key !== MAIN_ACTOR && !this.#agents.has(key)) {
      throw new SubagentError("unknown_sender", `${describe(from)} is not a sender registered in this runtime.`, {
        from: typeof from === "string" ? from : null,
      });
    }
    return { key, address: formatAddress(this.session, key) };
  }

  /**
   * Resolve one full logical target into its recipients. A foreign session is
   * refused here: only the host's cross-session path may write another session,
   * and only to its Main. Broadcast recipients never include the sender.
   */
  #target(value: unknown, senderKey?: string): ResolvedTarget {
    const address = parseAddress(value);
    if (address === null) {
      throw new SubagentError("invalid_target", `${describe(value)} is not a logical address of this session.`, {
        to: typeof value === "string" ? value : null,
      });
    }
    if (address.session !== this.session) {
      throw new SubagentError("cross_session_target", `The address ${address.address} belongs to another session; only Main reaches another Main.`, {
        to: address.address,
        session: address.session,
      });
    }
    if (address.kind === "actor") {
      if (address.key !== MAIN_ACTOR && !this.#agents.has(address.key)) {
        throw new SubagentError("unknown_agent", `No subagent registered as ${address.address}.`, { to: address.address });
      }
      return { kind: address.key === MAIN_ACTOR ? "main" : "actor", address: address.address, key: address.key };
    }
    const keys = address.kind === "group"
      ? [...this.#agents.values()]
          .filter((agent) => agent.batch === address.batch)
          .map((agent) => agent.agentId)
      : [...this.#agents.values()]
          .filter((agent) => agent.parentAgentId === (address.actor.key === MAIN_ACTOR ? null : address.actor.key))
          .map((agent) => agent.agentId);
    return {
      kind: "broadcast",
      address: address.address,
      keys: keys.filter((key) => key !== senderKey),
    };
  }

  /** The typed envelope of one explicit write; `type` and the sender are host-owned. */
  #messageEnvelope(input: { fromKey: string; fromAddress: string; content: string; external?: ExternalSender }): MessageEnvelope {
    const envelope: MessageEnvelope = {
      type: "message",
      from: input.fromAddress,
      content: input.content,
      ...(input.external === undefined ? {} : { external: input.external }),
    };
    // A Subagent message belongs to its sender's current execution round. The
    // host can therefore correlate it with that round without asking the caller
    // to supply transport or run identity.
    if (input.fromKey !== MAIN_ACTOR) {
      const source = this.#agents.get(input.fromKey);
      const live = source === undefined ? null : this.#liveJobOf(source);
      if (live !== null) {
        envelope.jobId = live.jobId;
        envelope.round = Math.max(1, (source?.jobIds.indexOf(live.jobId) ?? -1) + 1);
      }
    }
    return envelope;
  }

  async #sendToMain(plan: SendPlan): Promise<MessageReceipt> {
    if (this.#deliverToMain === null) {
      throw new SubagentError("delivery_unavailable", "This runtime cannot deliver messages to Main.");
    }
    try {
      await this.#deliverToMain(this.#messageEnvelope(plan));
    } catch (error) {
      throw new SubagentError("delivery_failed", `Could not deliver the message to Main: ${errorMessage(error)}`);
    }
    return { ok: true, to: plan.to, jobId: null };
  }

  /**
   * Hand over to a live adapter, buffer startup input, or explicitly revive an idle Actor.
   */
  async #sendToAgent(fromKey: string, fromAddress: string, toKey: string, toAddress: string, content: string): Promise<MessageReceipt> {
    const agent = this.#agents.get(toKey);
    if (agent === undefined) throw new SubagentError("unknown_agent", `No subagent registered as ${toAddress}.`);
    // At most two transitions: the first hand-over, and — if the run closed
    // while that was in flight — one fresh decision against the successor
    // state. Never a third: parking or retrying is the caller's business.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const live = this.#liveJobOf(agent);

      if (live === null) {
        // No live Job: the Actor is idle, so this write revives it. The
        // admission check and the new Job happen in the same synchronous step.
        const refusal = this.#reviveRefusal(agent);
        if (refusal !== null) throw refusal;
        agent.pending.push(this.#messageEnvelope({ fromKey, fromAddress, content }));
        const revived = this.#scheduleContinuation(agent, fromKey);
        this.#start(revived);
        return { ok: true, to: toAddress, jobId: revived.jobId };
      }
      if (live.status === "stopping") {
        throw this.#busyError(agent, "stopping");
      }
      if (live.status === "finalizing") {
        throw this.#busyError(agent, "finalizing");
      }
      if (!this.#handles.has(live.jobId)) {
        // A registered sibling has not entered its adapter yet; buffer its initial input.
        agent.pending.push(this.#messageEnvelope({ fromKey, fromAddress, content }));
        return { ok: true, to: toAddress, jobId: live.jobId };
      }

      if (await this.#handToJob(live, { fromKey, fromAddress, content })) {
        return { ok: true, to: toAddress, jobId: live.jobId };
      }
      // Refused: the native run closed underneath the hand-over. Loop once
      // more to revive the now-idle Actor or to report the successor state.
    }

    throw this.#busyError(agent, "running");
  }

  /**
   * Broadcast one write to a resolved selector.
   *
   * The recipient set is a snapshot taken by {@link #target}: a batch's members
   * or one Actor's direct children, never the sender. An empty set after that
   * filter is an ordinary zero-recipient receipt, not an error. Each recipient
   * gets the same single-target send (so idle children are revived under the
   * ordinary admission rules) and its own explicit outcome; partial fanout is
   * reported, never hidden, and never retried.
   */
  async #broadcast(fromKey: string, fromAddress: string, target: ResolvedTarget, content: string): Promise<BroadcastReceipt> {
    const keys = target.kind === "broadcast" ? target.keys : [];
    const sent: BroadcastReceipt["sent"] = [];
    const errors: BroadcastReceipt["errors"] = [];
    for (const agentId of keys) {
      const to = formatAddress(this.session, agentId);
      try {
        const receipt = await this.#sendToAgent(fromKey, fromAddress, agentId, to, content);
        sent.push({ to, jobId: receipt.jobId });
      } catch (error) {
        const info = errorInfo(error, "delivery_failed");
        errors.push({ to, code: info.code, message: info.message });
      }
    }
    return { ok: errors.length === 0, to: target.address, sent, errors };
  }

  /** Hand one message to a live Job; the adapter owns it from there. */
  async #handToJob(job: Job, message: { fromKey: string; fromAddress: string; content: string }): Promise<boolean> {
    if (this.#deliverMessage === null) return false;
    let outcome;
    try {
      outcome = await this.#deliverMessage({
        agentId: job.agentId,
        jobId: job.jobId,
        message: this.#messageEnvelope(message),
      });
    } catch (error) {
      // A thrown SDK handoff error does not prove the message stayed outside
      // the native queue. Only an explicit refusal is safe to reconsider.
      throw new SubagentError('delivery_failed', `Message handoff failed without a safe retry: ${errorMessage(error)}`);
    }
    return outcome?.accepted === true;
  }

  #busyError(agent: Agent, status: "stopping" | "finalizing" | "running"): SubagentError {
    const reason =
      status === "stopping"
        ? "is stopping its current run; its outcome is published when that run exits"
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

  #requireJob(jobId: unknown): Job {
    const job = typeof jobId === "string" ? this.#jobs.get(jobId) : null;
    if (!job) throw new SubagentError("unknown_job", `No job registered as ${describe(jobId)}.`);
    return job;
  }

  #budgetView(job: Job): BudgetSnapshot | null {
    if (job.budget !== null) return publicBudgetSnapshot(job.budget);
    return job.budgetSnapshot === null ? null : structuredClone(job.budgetSnapshot);
  }

  #jobView(job: Job): JobView {
    const agent = this.#agents.get(job.agentId);
    const view: JobView = {
      jobId: job.jobId,
      agentId: job.agentId,
      address: formatAddress(this.session, job.agentId),
      name: agent?.name ?? null,
      parentAgentId: agent?.parentAgentId ?? null,
      depth: agent?.depth ?? null,
      status: job.status,
      continuedFromJobId: job.continuedFromJobId,
    };
    if (job.stopping !== null) view.stopping = job.stopping.status;
    if (TERMINAL_STATUSES.has(job.status)) {
      if (job.historyState !== undefined) view.historyState = job.historyState;
      if (job.historyError !== undefined && job.historyError !== null) view.historyError = job.historyError;
    }
    if (job.error !== null) view.error = structuredClone(job.error);
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
