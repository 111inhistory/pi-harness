/**
 * Pi-independent Subagent lifecycle.
 * Batches register atomically, then every admitted Job starts directly.
 * Limits apply to each parent's active children and nesting depth, not global concurrency.
 * Runtime owns cancellation, Budget verdicts, finalization and terminal publication.
 * Messages received before an adapter is ready are buffered as startup input.
 * Explicit messages revive idle actors on their retained context or original seed.
 * Checkpoints restore actor identity and native history bounds without replaying work.
 */

import { randomUUID } from "node:crypto";

import { createJobBudget } from "./job-budget.mjs";
import { getAgentSocketPath } from "./subagent-socket.mjs";
import { getSubagentHistoryPaths } from "./subagent-history.mjs";

const MAX_AGENT_DEPTH = 2;
const MAX_ACTIVE_CHILDREN = 4;

const MAX_MESSAGE_CHARS = 32768;
const MAIN_ACTOR_ID = "Main";
const BROADCAST_TARGET = "all";

const STATE_VERSION = 1;

const BATCH_FIELDS = new Set(["context", "tasks"]);
const TASK_FIELDS = new Set(["name", "task", "inheritContext"]);

/** A live Job occupies its actor and its parent's active-child allowance. */
const LIVE_STATUSES = new Set(["running", "stopping", "finalizing"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const JOB_STATUSES = new Set([...LIVE_STATUSES, ...TERMINAL_STATUSES]);

// Agent and Job ids carry a per-runtime namespace, so `agent://agent_..` and
// `hub cancel job_..` addresses from before a reload (or from an earlier
// process) can never reach an unrelated later actor. `all` and `Main` can
// never match a generated id, which keeps the broadcast target and the root
// actor outside the resolvable actor space.
const AGENT_ID_PATTERN = /^(agent_[0-9a-z]+-[0-9]+|sub_[0-9a-zA-Z_]+)$/;
const JOB_ID_PATTERN = /^(job_[0-9a-z]+-[0-9]+|job_sub_[0-9a-zA-Z_]+|sub_[0-9a-zA-Z_]+(#r[0-9]+)?)$/;
const REF_PATTERN = /^(agent|history):\/\/((?!all$|Main$)(agent_[0-9a-z]+-[0-9]+|sub_[0-9a-zA-Z_]+))$/;
const PROTOCOL_URI_PATTERN = /^(agent|history):\/\/(.*)$/;

/** Terminal state of a Job that was still live when the process went away. */
const INTERRUPTED = Object.freeze({
  code: "interrupted",
  message: "The process ended before this Job finished; the Job was not restarted. Send an explicit message to continue this agent.",
});

/** Harness-owned error with a stable machine-readable code. */
export class SubagentError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "SubagentError";
    this.code = code;
    this.detail = detail;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value) {
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (isPlainObject(error) && typeof error.message === "string") return error.message;
  return String(error);
}

function errorInfo(error, fallbackCode) {
  if (isPlainObject(error)) {
    const code = typeof error.code === "string" ? error.code : fallbackCode;
    const message = typeof error.message === "string" ? error.message : errorMessage(error);
    const info = { code, message };
    if (isPlainObject(error.detail)) info.detail = cloneValue(error.detail);
    return info;
  }
  const code = error instanceof Error && typeof error.code === "string" ? error.code : fallbackCode;
  const info = { code, message: errorMessage(error) };
  if (error && typeof error === "object" && isPlainObject(error.detail)) info.detail = cloneValue(error.detail);
  return info;
}

// Stored payloads are cloned so callers can never mutate registry state and
// repeated reads never hand out shared references.
function cloneValue(value) {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function publicBudgetError(error) {
  if (!error || typeof error !== "object") return null;
  const code = typeof error.code === "string" ? error.code : "budget_exceeded";
  return {
    code,
    message: code === "job_expired" ? "Job lifetime expired." : "Job execution budget exhausted.",
  };
}

function publicBudgetSnapshot(budget) {
  const snapshot = cloneValue(budget.snapshot());
  if (snapshot.terminal?.error) {
    snapshot.terminal.error = publicBudgetError(snapshot.terminal.error);
  }
  return snapshot;
}

/**
 * Normalized native history bounds of one Job.
 *
 * `startEntryId` is the append-only entry the Job started after and
 * `endEntryId` the entry its transcript currently reaches. A value that does
 * not have that shape is ignored instead of being stored half-formed, so a
 * malformed adapter report can never make a restored transcript unreadable in
 * a way the reader cannot see.
 */
function historyBounds(value) {
  if (!isPlainObject(value)) return null;
  const start = value.startEntryId ?? null;
  const end = value.endEntryId ?? null;
  if (start === null && end === null) return null;
  if (start !== null && typeof start !== "string") return null;
  if (end !== null && typeof end !== "string") return null;
  return { startEntryId: start, endEntryId: end };
}

function stateError(message, detail = {}) {
  return new SubagentError("invalid_state", message, detail);
}

/**
 * Parse a model-facing subagent reference.
 *
 * @param {unknown} ref
 * @returns {{ kind: "result" | "history", agentId: string } | null}
 */
export function parseRef(ref) {
  if (typeof ref !== "string") return null;
  const match = REF_PATTERN.exec(ref.trim());
  if (!match) return null;
  return { kind: match[1] === "agent" ? "result" : "history", agentId: match[2] };
}

export function resultRef(agentId) {
  return `agent://${agentId}`;
}

export function historyRef(agentId) {
  return `history://${agentId}`;
}

/**
 * Canonicalize an actor id.
 *
 * `Main` is the reserved root actor and is matched case-insensitively; every
 * other actor is a stable `agent_<token>-<n>` id. The reserved broadcast
 * target `all` is not an actor and never resolves here. Returns null for
 * anything else.
 */
export function canonicalActorId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === MAIN_ACTOR_ID.toLowerCase()) return MAIN_ACTOR_ID;
  return AGENT_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Parse a protocol URI owned by this runtime:
 *
 *   agent://                 list visible actors
 *   agent://all              write-only broadcast to the sender's direct children
 *   agent://<agentId>        immutable initial result of that agent
 *   history://<agentId>      conversation spanning every Job of that agent
 *
 * Returns null for any other URI; callers reject those explicitly instead of
 * falling back to filesystem paths.
 */
export function parseProtocolRef(uri) {
  if (typeof uri !== "string") return null;
  const match = PROTOCOL_URI_PATTERN.exec(uri.trim());
  if (!match) return null;
  const [, scheme, rest] = match;
  if (scheme === "history") {
    const agentId = canonicalActorId(rest);
    return agentId === null ? null : { scheme, kind: "history", agentId };
  }
  if (rest === "") return { scheme, kind: "list", agentId: null };
  if (rest.toLowerCase() === BROADCAST_TARGET) return { scheme, kind: "broadcast", agentId: null };
  const agentId = canonicalActorId(rest);
  return agentId === null ? null : { scheme, kind: "result", agentId };
}

/**
 * Deep-copy captured native session entries for one consumer.
 *
 * `SessionManager.inMemory(cwd, {}, entries)` keeps the array it is handed and
 * appends its own entries to it, so two sessions built from one snapshot would
 * share append-only storage and one session identity. Every consumer therefore
 * gets its own structural copy with a fresh session id on the copied header.
 * Native blocks are cloned verbatim — thinking with its provider signature,
 * tool calls, tool results, custom entries — never flattened or rebuilt, and
 * the snapshot passed in is never mutated.
 */
export function copyInheritedEntries(entries) {
  if (!Array.isArray(entries)) return entries;
  let copy;
  try {
    copy = structuredClone(entries);
  } catch {
    // Session entries are plain data, so this is the theoretical path only;
    // the array is still private to the consumer, which is what matters.
    copy = [...entries];
  }
  let replaced = false;
  for (let index = 0; index < copy.length; index += 1) {
    const entry = copy[index];
    if (replaced || entry?.type !== "session" || typeof entry.id !== "string") continue;
    replaced = true;
    copy[index] = { ...entry, id: randomUUID() };
  }
  return copy;
}

/**
 * One child's copy of a captured context snapshot: the same capture instant,
 * its own top-level object and its own native entries.
 */
function snapshotForChild(snapshot) {
  if (!isPlainObject(snapshot)) return snapshot;
  const copy = { ...snapshot };
  if (Array.isArray(snapshot.entries)) copy.entries = copyInheritedEntries(snapshot.entries);
  return copy;
}

/**
 * Copy one Job spec for the persisted state.
 *
 * The spec itself is small, but an inherited-context snapshot is not: its
 * native entries are shared with the live spec instead of being deep-copied
 * on every checkpoint. The adapter replaces the whole `inheritedContext`
 * value with a native seed-session reference, so sharing the entries array is
 * safe as long as it is never mutated in place — which nothing here does.
 */
function exportSpec(spec) {
  if (!isPlainObject(spec)) return spec;
  if (spec.kind === "continuation") {
    return { kind: "continuation", name: spec.name ?? null, seed: spec.seed === null ? null : exportSpec(spec.seed) };
  }
  const copy = { ...spec };
  copy.name = spec.name ?? null;
  copy.context = spec.context ?? null;
  copy.inheritContext = spec.inheritContext === true;
  copy.inheritedContext = isPlainObject(spec.inheritedContext)
    ? { ...spec.inheritedContext, entries: spec.inheritedContext.entries ?? null }
    : null;
  return copy;
}

/**
 * Non-fatal warnings that belong to a Job's entry.
 *
 * The adapter records them on the inherited-context snapshot it captures (for
 * example the inherited tools that Pi's public API cannot transplant), so they
 * survive persistence and revival. An initial Job carries the snapshot itself;
 * a continuation carries it as its seed.
 */
function inheritedWarnings(spec) {
  const warnings = spec?.inheritedContext?.warnings ?? spec?.seed?.inheritedContext?.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((warning) => typeof warning === "string");
}

/** One-line prose of a terminal Job for its creator; never the answer itself. */
function completionText(job) {
  const name = typeof job.spec?.name === "string" && job.spec.name !== "" ? ` (${job.spec.name})` : "";
  const lines = [`Subagent ${job.agentId}${name} finished Job ${job.jobId} with status ${job.status}.`];
  if (job.error !== null && job.error !== undefined) {
    lines.push(`Error: [${job.error.code}] ${job.error.message}`);
  }
  const historyPaths = getSubagentHistoryPaths(job.agentId);
  lines.push(`Summary: ${historyPaths.summary}`, `Clean JSONL: ${historyPaths.cleanJsonl}`);
  return lines.join("\n");
}

function requireStateString(value, where) {
  if (typeof value !== "string" || value === "") throw stateError(`${where} must be a non-empty string.`);
  return value;
}

/**
 * Validate and normalize a persisted state into registry structures.
 *
 * Persisted state is a trust boundary: it is read back from a native session
 * file that may be truncated, hand-edited or written by another build, so
 * every id, link, status and reference is checked before it reaches the
 * registry. Reserved actor names (`Main`, `all`) can never be restored.
 */
function planRestore(state) {
  if (!isPlainObject(state)) throw stateError("The persisted subagent state must be an object.");
  if (state.version !== STATE_VERSION) {
    throw stateError(
      `Unsupported subagent state version ${describe(state.version)}; this runtime restores version ${STATE_VERSION} only.`,
      { version: state.version ?? null },
    );
  }
  const sequences = state.sequences;
  if (!isPlainObject(sequences) || !Number.isInteger(sequences.agent) || sequences.agent < 0 || !Number.isInteger(sequences.job) || sequences.job < 0) {
    throw stateError("state.sequences must carry non-negative integer agent and job counters.");
  }
  if (!Array.isArray(state.actors)) throw stateError("state.actors must be an array.");
  if (!Array.isArray(state.jobs)) throw stateError("state.jobs must be an array.");
  if (state.pending !== undefined && !Array.isArray(state.pending)) throw stateError("state.pending must be an array when present.");

  const actors = [];
  const actorsById = new Map();
  for (const [index, raw] of state.actors.entries()) {
    const where = `state.actors[${index}]`;
    if (!isPlainObject(raw)) throw stateError(`${where} must be an object.`);
    const agentId = raw.agentId;
    if (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId)) {
      const reserved =
        typeof agentId === "string" &&
        (agentId.trim().toLowerCase() === BROADCAST_TARGET || agentId.trim().toLowerCase() === MAIN_ACTOR_ID.toLowerCase());
      throw stateError(
        reserved
          ? `${where}.agentId ${describe(agentId)} is a reserved actor name and can never be restored.`
          : `${where}.agentId ${describe(agentId)} is not a subagent actor id.`,
      );
    }
    if (actorsById.has(agentId)) throw stateError(`${where}.agentId ${agentId} appears more than once.`);
    const name = raw.name === undefined || raw.name === null ? null : requireStateString(raw.name, `${where}.name`);
    const depth = raw.depth;
    if (!Number.isInteger(depth) || depth < 1 || depth > MAX_AGENT_DEPTH) {
      throw stateError(`${where}.depth must be an integer between 1 and ${MAX_AGENT_DEPTH}.`, { agentId });
    }
    const parentAgentId = raw.parentAgentId ?? null;
    if (parentAgentId !== null && typeof parentAgentId !== "string") {
      throw stateError(`${where}.parentAgentId must be an actor id or null.`, { agentId });
    }
    if (!Array.isArray(raw.jobIds) || raw.jobIds.some((jobId) => typeof jobId !== "string" || jobId === "")) {
      throw stateError(`${where}.jobIds must be an array of Job ids.`, { agentId });
    }
    if (raw.stoppedOrder !== undefined && (!Number.isSafeInteger(raw.stoppedOrder) || raw.stoppedOrder < 0)) {
      throw stateError(`${where}.stoppedOrder must be a non-negative integer.`);
    }
    const actor = { agentId, name, parentAgentId, depth, jobIds: [...raw.jobIds], pending: [], stoppedOrder: raw.stoppedOrder ?? 0 };
    actors.push(actor);
    actorsById.set(agentId, actor);
  }
  for (const actor of actors) {
    if (actor.parentAgentId === null) {
      if (actor.depth !== 1) throw stateError(`Actor ${actor.agentId} has no parent but depth ${actor.depth}.`, { agentId: actor.agentId });
      continue;
    }
    const parent = actorsById.get(actor.parentAgentId);
    if (parent === undefined) {
      throw stateError(`Actor ${actor.agentId} names unknown parent ${actor.parentAgentId}.`, { agentId: actor.agentId });
    }
    if (parent.agentId === actor.agentId) throw stateError(`Actor ${actor.agentId} is its own parent.`, { agentId: actor.agentId });
    if (parent.depth + 1 !== actor.depth) {
      throw stateError(`Actor ${actor.agentId} declares depth ${actor.depth} under a depth-${parent.depth} parent.`, { agentId: actor.agentId });
    }
  }

  const rawJobs = [];
  const jobsById = new Map();
  for (const [index, raw] of state.jobs.entries()) {
    const where = `state.jobs[${index}]`;
    if (!isPlainObject(raw)) throw stateError(`${where} must be an object.`);
    const jobId = raw.jobId;
    if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) throw stateError(`${where}.jobId ${describe(jobId)} is not a Job id.`);
    if (jobsById.has(jobId)) throw stateError(`${where}.jobId ${jobId} appears more than once.`);
    if (typeof raw.agentId !== "string" || !actorsById.has(raw.agentId)) {
      throw stateError(`${where}.agentId ${describe(raw.agentId)} is not a registered actor.`, { jobId });
    }
    const status = raw.status;
    if (typeof status !== "string" || !JOB_STATUSES.has(status)) {
      throw stateError(`${where}.status ${describe(status)} is not a Job status.`, { jobId });
    }
    const createdBy = raw.createdBy;
    if (typeof createdBy !== "string" || (createdBy !== MAIN_ACTOR_ID && !actorsById.has(createdBy))) {
      throw stateError(`${where}.createdBy ${describe(createdBy)} is not the root actor or a registered actor.`, { jobId });
    }
    if (raw.index !== undefined && raw.index !== null && (!Number.isInteger(raw.index) || raw.index < 0)) {
      throw stateError(`${where}.index must be a non-negative integer or null.`, { jobId });
    }
    if (raw.origin !== undefined && raw.origin !== null && !isPlainObject(raw.origin)) {
      throw stateError(`${where}.origin must be an object or null.`, { jobId });
    }
    if (raw.error !== undefined && raw.error !== null && !isPlainObject(raw.error)) {
      throw stateError(`${where}.error must be an object or null.`, { jobId });
    }
    if (!isPlainObject(raw.budget)) throw stateError(`${where}.budget must be the public Budget snapshot.`, { jobId });
    const interrupted = LIVE_STATUSES.has(status);
    const job = {
      jobId,
      agentId: raw.agentId,
      index: raw.index ?? null,
      spec: restoreSpec(raw.spec, where),
      origin: raw.origin ?? null,
      createdBy,
      continuedFromJobId: raw.continuedFromJobId ?? null,
      status: interrupted ? "failed" : status,
      result: raw.result === undefined ? null : cloneValue(raw.result),
      error: interrupted
        ? { ...INTERRUPTED }
        : raw.error === undefined || raw.error === null
          ? null
          : cloneValue(raw.error),
      history: historyBounds(raw.history),
      messages: null,
      budget: null,
      // A restored Job is terminal, so its Budget snapshot is reporting only:
      // it is preserved verbatim except that nothing can still be running.
      budgetSnapshot: { ...cloneValue(raw.budget), running: false },
      stopping: null,
    };
    rawJobs.push(job);
    jobsById.set(jobId, job);
  }

  const jobIdsByActor = new Map();
  for (const job of rawJobs) {
    const ids = jobIdsByActor.get(job.agentId) ?? [];
    ids.push(job.jobId);
    jobIdsByActor.set(job.agentId, ids);
  }
  for (const actor of actors) {
    const declared = actor.jobIds;
    if (declared.length === 0) throw stateError(`Actor ${actor.agentId} has no Jobs; an actor always owns at least its first Job.`, { agentId: actor.agentId });
    if (new Set(declared).size !== declared.length) throw stateError(`Actor ${actor.agentId} lists one Job more than once.`, { agentId: actor.agentId });
    const owned = jobIdsByActor.get(actor.agentId) ?? [];
    if (owned.length !== declared.length || owned.some((jobId) => !declared.includes(jobId))) {
      throw stateError(
        `Actor ${actor.agentId} and its Jobs disagree about which Jobs belong to it (actor: ${declared.join(", ") || "none"}; jobs: ${owned.join(", ") || "none"}).`,
        { agentId: actor.agentId },
      );
    }
  }
  for (const job of rawJobs) {
    if (job.continuedFromJobId === null) continue;
    const previous = jobsById.get(job.continuedFromJobId);
    if (previous === undefined) {
      throw stateError(`Job ${job.jobId} continues unknown Job ${job.continuedFromJobId}.`, { jobId: job.jobId });
    }
    if (previous.agentId !== job.agentId) {
      throw stateError(`Job ${job.jobId} continues a Job of another actor.`, { jobId: job.jobId });
    }
  }

  const pendingEntries = state.pending ?? [];
  for (const [index, raw] of pendingEntries.entries()) {
    const where = `state.pending[${index}]`;
    if (!isPlainObject(raw)) throw stateError(`${where} must be an object.`);
    const actor = typeof raw.agentId === "string" ? actorsById.get(raw.agentId) : undefined;
    if (actor === undefined) throw stateError(`${where}.agentId ${describe(raw.agentId)} is not a registered actor.`);
    if (!Array.isArray(raw.messages)) throw stateError(`${where}.messages must be an array.`);
    for (const [position, envelope] of raw.messages.entries()) {
      actor.pending.push(restoreEnvelope(envelope, `${where}.messages[${position}]`, actorsById));
    }
  }

  // Jobs keep the exact order they were persisted in: the registry map's
  // order is the global Job creation chronology, and a reload must not
  // regroup it by actor. Each actor's own `jobIds` carry its per-actor order
  // for result and history reads.
  return { sequences: { agent: sequences.agent, job: sequences.job }, actors, jobs: rawJobs };
}

function restoreSpec(value, where) {
  if (!isPlainObject(value)) throw stateError(`${where}.spec must be an object.`, { jobId: where });
  const name = value.name === undefined || value.name === null ? null : requireStateString(value.name, `${where}.spec.name`);
  if (value.kind === "continuation") {
    const seed = value.seed === undefined || value.seed === null ? null : restoreSpec(value.seed, `${where}.spec.seed`);
    return { kind: "continuation", name, seed };
  }
  if (typeof value.task !== "string" || value.task.trim() === "") {
    throw stateError(`${where}.spec.task must be a non-empty string.`);
  }
  if (value.context !== undefined && value.context !== null && typeof value.context !== "string") {
    throw stateError(`${where}.spec.context must be a string or null.`);
  }
  if (value.inheritedContext !== undefined && value.inheritedContext !== null && !isPlainObject(value.inheritedContext)) {
    throw stateError(`${where}.spec.inheritedContext must be an object or null.`);
  }
  return {
    name,
    task: value.task,
    context: value.context ?? null,
    inheritContext: value.inheritContext === true,
    inheritedContext: value.inheritedContext ?? null,
  };
}

function restoreEnvelope(value, where, actorsById) {
  if (!isPlainObject(value)) throw stateError(`${where} must be an object.`);
  const type = value.type;
  if (type !== "message" && type !== "completion") throw stateError(`${where}.type ${describe(type)} is not a notification type.`);
  const from = canonicalActorId(value.from);
  if (from === null || (from !== MAIN_ACTOR_ID && !actorsById.has(from))) {
    throw stateError(`${where}.from ${describe(value.from)} is not a registered actor.`);
  }
  const content = value.content;
  if (typeof content !== "string" || content.trim() === "") throw stateError(`${where}.content must be a non-empty message body.`);
  if (content.length > MAX_MESSAGE_CHARS) {
    throw stateError(`${where}.content is longer than ${MAX_MESSAGE_CHARS} characters.`, { length: content.length });
  }
  if (type === "message") return { type, from, content };
  const envelope = { type, from, content };
  if (value.jobId !== undefined && value.jobId !== null) envelope.jobId = requireStateString(value.jobId, `${where}.jobId`);
  if (value.status !== undefined && value.status !== null) envelope.status = requireStateString(value.status, `${where}.status`);
  if (value.resultRef !== undefined && value.resultRef !== null) envelope.resultRef = requireStateString(value.resultRef, `${where}.resultRef`);
  if (value.historyRef !== undefined && value.historyRef !== null) envelope.historyRef = requireStateString(value.historyRef, `${where}.historyRef`);
  return envelope;
}

/**
 * Registry + scheduler for subagents.
 *
 * task(batch, options) validates the whole batch, registers every entry in
 * input order, then starts every admitted Job without a global execution cap.
 * Nothing touches the registry before validation succeeds.
 */
export class SubagentRuntime {
  #startJob;
  #deliverMessage;
  #deliverToMain;
  #onStateChange;
  #readHistory;
  #allowInherited;
  #socketDir;
  #historyDir;
  #isAgentIdTaken;
  #onAgentIdAllocated;
  #finalizeJob;

  #agents = new Map();
  #stoppedSequence = 0;
  #jobs = new Map();
  #handles = new Map();
  #lifetimeTimers = new Map();
  #waiters = new Map();
  #agentSequence = 0;
  #jobSequence = 0;
  #idToken;
  #checkpointDepth = 0;
  #checkpointPending = false;
  #completions = [];

  constructor(options = {}) {
    if (!isPlainObject(options)) {
      throw new SubagentError("invalid_options", "Runtime options must be an object.");
    }
    const {
      startJob,
      deliverMessage,
      deliverToMain,
      onStateChange,
      readHistory,
      allowInherited = true,
      socketDir,
      historyDir,
      isAgentIdTaken,
      onAgentIdAllocated,
      finalizeJob,
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
    if (onStateChange !== undefined && typeof onStateChange !== "function") {
      throw new SubagentError("invalid_options", "onStateChange must be a function when provided.");
    }
    if (readHistory !== undefined && typeof readHistory !== "function") {
      throw new SubagentError("invalid_options", "readHistory must be a function when provided.");
    }
    if (typeof allowInherited !== "boolean") {
      throw new SubagentError("invalid_options", "allowInherited must be a boolean.");
    }
    if (onAgentIdAllocated !== undefined && typeof onAgentIdAllocated !== "function") {
      throw new SubagentError("invalid_options", "onAgentIdAllocated must be a function when provided.");
    }

    this.#startJob = startJob;
    this.#deliverMessage = deliverMessage ?? null;
    this.#deliverToMain = deliverToMain ?? null;
    this.#onStateChange = onStateChange ?? null;
    this.#readHistory = readHistory ?? null;
    this.#allowInherited = allowInherited;
    this.#socketDir = socketDir;
    this.#historyDir = historyDir;
    this.#isAgentIdTaken = typeof isAgentIdTaken === "function" ? isAgentIdTaken : null;
    this.#onAgentIdAllocated = typeof onAgentIdAllocated === "function" ? onAgentIdAllocated : null;
    this.#finalizeJob = typeof finalizeJob === "function" ? finalizeJob : null;
    this.#idToken = randomUUID().replaceAll("-", "");
  }

  /** Create subagents batch according to the public contract (returns unified id, socket, history). */
  create(batch, options = {}) {
    const res = this.task(batch, options);
    const result = {
      items: res.items.map((item) => {
        const historyPaths = getSubagentHistoryPaths(item.agentId, this.#historyDir);
        const mapped = {
          id: item.agentId,
          status: item.status,
          socket: getAgentSocketPath(item.agentId, this.#socketDir),
          history: {
            summary: historyPaths.summary,
            cleanJsonl: historyPaths.cleanJsonl,
          },
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
  task(batch, options = {}) {
    if (!isPlainObject(options)) {
      throw new SubagentError("invalid_options", "task options must be an object.");
    }
    return this.#withCheckpoint(() => {
      const entries = this.#planBatch(batch, options);
      for (const { spec } of entries) {
        const assignment = spec.context?.trim() ? `# Batch context\n\n${spec.context}\n\n# Task\n\n${spec.task}` : spec.task;
        const chars = Array.from(assignment);
        if (chars.filter((char) => char.codePointAt(0) > 127).length > chars.length * 0.2) {
          throw new SubagentError("assignment_language", "Write subagent requirements in English.");
        }
      }
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
      const registered = [];

      for (const entry of entries) {
        const agentId = this.#allocateAgentId(parentAgentId, depth);
        const agent = { agentId, name: entry.spec.name, parentAgentId, depth, status: "running", jobIds: [], pending: [] };
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
  #createJob(agent, { index = null, spec, origin = null, createdBy, continuedFromJobId = null }) {
    const jobId = continuedFromJobId ? `${agent.agentId}#r${agent.jobIds.length + 1}` : agent.agentId;
    const job = {
      jobId,
      agentId: agent.agentId,
      index,
      spec,
      origin,
      createdBy,
      status: "running",
      result: null,
      error: null,
      // Native entry bounds of the transcript this Job recorded, and the live
      // in-memory messages; only the bounds are ever persisted.
      history: null,
      messages: null,
      budget: createJobBudget({ depth: agent.depth, jobId }),
      budgetSnapshot: null,
      continuedFromJobId,
      // Set while an explicit cancel or an expired Budget waits for the native
      // run to exit; the terminal payload is published from there.
      stopping: null,
    };
    agent.jobIds.push(jobId);
    this.#jobs.set(jobId, job);
    this.#scheduleLifetime(job);
    this.#refreshAgent(agent.agentId);
    this.#markDirty();
    return job;
  }

  /** Agent-level snapshot; job status is reported by jobs(), not here. */
  list(filter) {
    const targetId = filter?.id || filter?.agentId;
    const agents = [];
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
  listDetailed(filter, { callerId } = {}) {
    const targetId = filter?.id || filter?.agentId;
    const agents = [...this.#agents.values()];
    const visible = new Set();
    const scoped = callerId !== undefined;
    const main = { id: MAIN_ACTOR_ID, parentId: null, status: "running", socket: getAgentSocketPath(MAIN_ACTOR_ID, this.#socketDir) };
    if (scoped) {
      if (filter?.all === true) {
        visible.add(MAIN_ACTOR_ID);
        for (const agent of agents) visible.add(agent.agentId);
      } else {
        const group = (parentId, selfId) => this.#visibleGroup(parentId, selfId);
        const addChildren = (agent) => {
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
    const items = [];
    if (visible.has(MAIN_ACTOR_ID) && (!targetId || targetId === MAIN_ACTOR_ID) && (!filter?.status || filter.status === main.status)) items.push(main);
    const listed = scoped ? [...visible].filter((id) => id !== MAIN_ACTOR_ID).map((id) => this.#agents.get(id)) : agents;
    for (const agent of listed) {
      if (targetId && agent.agentId !== targetId) continue;
      const liveJob = this.#liveJobOf(agent);
      const currentStatus = liveJob ? liveJob.status : (agent.status === "idle" ? "stopped" : agent.status);
      if (filter?.status !== undefined && filter.status !== currentStatus && filter.status !== agent.status) continue;
      const historyPaths = getSubagentHistoryPaths(agent.agentId, this.#historyDir);
      items.push({
        id: agent.agentId,
        parentId: agent.parentAgentId ?? "Main",
        status: currentStatus,
        socket: getAgentSocketPath(agent.agentId, this.#socketDir),
        history: {
          summary: historyPaths.summary,
          cleanJsonl: historyPaths.cleanJsonl,
        },
      });
    }
    return { items };
  }

  /** Listener cache uses the same per-parent window as the public list. */
  listenerGroup(parentId = null, includeId) {
    return this.#visibleGroup(parentId, includeId).map((agent) => agent.agentId);
  }

  assertMessageAdmission(id) {
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

  #visibleGroup(parentId, selfId) {
    const siblings = [...this.#agents.values()].filter((agent) => agent.parentAgentId === parentId);
    const active = siblings.filter((agent) => agent.status === "running");
    const stopped = siblings.filter((agent) => agent.status !== "running").reverse()
      .sort((a, b) => (b.stoppedOrder ?? 0) - (a.stoppedOrder ?? 0));
    const self = siblings.find((agent) => agent.agentId === selfId);
    return [...(self ? [self] : []), ...active.filter((agent) => agent !== self), ...stopped.filter((agent) => agent !== self)]
      .slice(0, MAX_ACTIVE_CHILDREN);
  }

  /** Job-level snapshot, optionally restricted to specific job ids. */
  jobs(filter) {
    let jobIds = null;
    if (filter?.jobIds !== undefined) {
      if (!Array.isArray(filter.jobIds) || filter.jobIds.length === 0) {
        throw new SubagentError("invalid_filter", "jobIds must be a non-empty array of job ids.");
      }
      jobIds = filter.jobIds.map((jobId) => this.#requireJob(jobId).jobId);
    }
    const jobs = jobIds === null ? [...this.#jobs.values()] : jobIds.map((jobId) => this.#jobs.get(jobId));
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
  async sendMessage({ from, to, content, signal } = {}) {
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
   * Resolve an `agent://` or `history://` protocol reference to a structured
   * payload. A restored Job's transcript is resolved from native storage
   * through the synchronous `readHistory` hook, so this stays a plain read.
   */
  readProtocol(uri, options = {}) {
    const parsed = parseProtocolRef(uri);
    if (parsed === null) {
      throw new SubagentError(
        "invalid_ref",
        `${describe(uri)} is not a supported subagent reference; use agent://, agent://<agentId> or history://<agentId>.`,
      );
    }
    if (parsed.kind === "broadcast") {
      throw new SubagentError(
        "invalid_ref",
        "agent://all is a write-only broadcast target; it has no result or history to read.",
        { agentId: null },
      );
    }
    if (parsed.kind === "list") {
      return { ref: "agent://", kind: "list", actors: this.#actorList(options.mainStatus) };
    }
    if (parsed.agentId === MAIN_ACTOR_ID) {
      throw new SubagentError(
        "invalid_ref",
        "Main is the root actor and has no agent result or history; use agent:// to list actors.",
        { agentId: MAIN_ACTOR_ID },
      );
    }
    return parsed.kind === "result" ? this.readRef(resultRef(parsed.agentId)) : this.readRef(historyRef(parsed.agentId));
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
  cancelJob(jobId) {
    return this.#withCheckpoint(() => {
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

      const budgetVerdict = job.budget.check();
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
  stop(target) {
    const id = typeof target === "string" ? target : target?.id || target?.jobId || target?.agentId;
    if (!id || typeof id !== "string") {
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

  /**
   * Resolve agent:// or history:// to repeatable content. A running job has a
   * result only once it finishes, but its history can already be read. A job
   * whose transcript lives only in native storage is resolved through the
   * `readHistory` hook. `jobs()` never reads a transcript, so it stays a
   * synchronous poll.
   */
  readRef(ref) {
    const parsed = parseRef(ref);
    if (!parsed) {
      throw new SubagentError("invalid_ref", `${describe(ref)} is not a subagent reference; use agent://<agentId> or history://<agentId>.`);
    }
    const agent = this.#agents.get(parsed.agentId);
    if (!agent) {
      throw new SubagentError("unknown_agent", `No subagent registered as ${parsed.agentId}.`);
    }
    const jobs = agent.jobIds.map((jobId) => this.#jobs.get(jobId));
    const initial = jobs[0];
    const latest = jobs[jobs.length - 1];
    if (parsed.kind === "result") {
      // The initial result is immutable: continuation Jobs and their messages
      // are read through history://, never by rewriting this payload.
      return {
        ref: resultRef(agent.agentId),
        kind: "result",
        agentId: agent.agentId,
        jobId: initial.jobId,
        name: initial.spec.name,
        status: initial.status,
        result: cloneValue(initial.result),
        error: cloneValue(initial.error),
      };
    }
    const messages = [];
    const jobViews = [];
    for (const job of jobs) {
      const transcript = this.#jobTranscript(job);
      if (transcript !== null) messages.push(...transcript);
      jobViews.push({
        jobId: job.jobId,
        kind: job.continuedFromJobId === null ? "initial" : "continuation",
        status: job.status,
        continuedFromJobId: job.continuedFromJobId,
        messageCount: transcript === null ? 0 : transcript.length,
      });
    }
    return {
      ref: historyRef(agent.agentId),
      kind: "history",
      agentId: agent.agentId,
      jobId: latest.jobId,
      name: latest.spec.name,
      status: latest.status,
      agentStatus: agent.status,
      messages,
      jobs: jobViews,
    };
  }

  /** Resolves once the job reaches a terminal status (or immediately if it already has). */
  jobDone(jobId) {
    const job = this.#requireJob(jobId);
    if (TERMINAL_STATUSES.has(job.status)) return Promise.resolve(this.#jobView(job));
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(job.jobId) ?? [];
      waiters.push(resolve);
      this.#waiters.set(job.jobId, waiters);
    });
  }

  /**
   * JSON-safe snapshot of the registry for persistence (state version 1).
   *
   * Transcripts and inherited-context entries are not copied; see the module
   * header for the exact shape and for what the adapter must substitute before
   * the state is written to native storage.
   */
  exportState() {
    const actors = [];
    for (const agent of this.#agents.values()) {
      actors.push({
        agentId: agent.agentId,
        name: agent.name,
        parentAgentId: agent.parentAgentId,
        depth: agent.depth,
        jobIds: [...agent.jobIds],
        stoppedOrder: agent.stoppedOrder ?? 0,
      });
    }
    const jobs = [];
    for (const job of this.#jobs.values()) {
      jobs.push({
        jobId: job.jobId,
        agentId: job.agentId,
        index: job.index,
        status: job.status,
        createdBy: job.createdBy,
        continuedFromJobId: job.continuedFromJobId,
        spec: exportSpec(job.spec),
        origin: cloneValue(job.origin),
        error: cloneValue(job.error),
        result: cloneValue(job.result),
        history: job.history === null ? null : { ...job.history },
        budget: this.#budgetView(job),
      });
    }
    const pending = [];
    for (const agent of this.#agents.values()) {
      if (agent.pending.length === 0) continue;
      pending.push({ agentId: agent.agentId, messages: agent.pending.map((envelope) => cloneValue(envelope)) });
    }
    return {
      version: STATE_VERSION,
      sequences: { agent: this.#agentSequence, job: this.#jobSequence },
      actors,
      jobs,
      pending,
    };
  }

  /**
   * Restore a state produced by exportState().
   *
   * The runtime must be fresh: a reload builds a new runtime and restores into
   * it, so no live Job can be overwritten by an older snapshot. Every restored
   * actor and Job keeps its original id and its immutable terminal result,
   * while a Job that was still running, stopping or finalizing becomes `failed`
   * with `interrupted` — it is never re-run and never re-notified.
   *
   * @returns {{ actors: number, jobs: number, interrupted: string[] }}
   */
  restoreState(state) {
    if (this.#agents.size > 0 || this.#jobs.size > 0) {
      throw new SubagentError(
        "invalid_state",
        "restoreState requires a fresh runtime; this runtime already has registered actors or jobs.",
      );
    }
    const restored = planRestore(state);
    return this.#withCheckpoint(() => {
      this.#agentSequence = restored.sequences.agent;
      this.#jobSequence = restored.sequences.job;
      this.#syncSequencesFromActors(restored.actors);
      for (const actor of restored.actors) {
        this.#agents.set(actor.agentId, {
          agentId: actor.agentId,
          name: actor.name,
          parentAgentId: actor.parentAgentId,
          depth: actor.depth,
          status: "idle",
          jobIds: actor.jobIds,
          stoppedOrder: actor.stoppedOrder,
          pending: actor.pending,
        });
      }
      this.#stoppedSequence = Math.max(0, ...restored.actors.map((actor) => actor.stoppedOrder));
      const interrupted = [];
      for (const job of restored.jobs) {
        this.#jobs.set(job.jobId, job);
        if (job.error?.code === INTERRUPTED.code) interrupted.push(job.jobId);
      }
      const interruptedActors = new Set(interrupted.map((jobId) => this.#jobs.get(jobId).agentId));
      for (const agent of this.#agents.values()) {
        if (interruptedActors.has(agent.agentId)) agent.status = "running";
        this.#refreshAgent(agent.agentId);
      }
      this.#markDirty();
      return { actors: this.#agents.size, jobs: this.#jobs.size, interrupted };
    });
  }

  /** Publish the current state to the persistence hook, never during polls. */
  #markDirty() {
    this.#checkpointPending = true;
    if (this.#checkpointDepth > 0) return;
    this.#flushTransition();
  }

  /**
   * Deliver one settled transition: the state checkpoint first, then the
   * terminal notifications it produced. Both are skipped when nothing is
   * pending, so a runtime without a persistence hook pays nothing.
   */
  #flushTransition() {
    if (this.#checkpointPending) {
      this.#checkpointPending = false;
      if (this.#onStateChange !== null) {
        try {
          this.#onStateChange(this.exportState());
        } catch {
          // A settled transition cannot be rolled back and a storage failure
          // must never change a Job outcome; the adapter reports persistence
          // errors.
        }
      }
    }
    if (this.#completions.length === 0) return;
    const jobs = this.#completions;
    this.#completions = [];
    for (const job of jobs) this.#notifyTerminal(job);
  }

  /**
   * Coalesce the checkpoints of one synchronous transition: a batch that
   * registers four Jobs, starts them and fails one of them emits one state
   * (and its one notification) instead of seven.
   */
  #withCheckpoint(run) {
    this.#checkpointDepth += 1;
    try {
      return run();
    } finally {
      this.#checkpointDepth -= 1;
      if (this.#checkpointDepth === 0) this.#flushTransition();
    }
  }

  #planBatch(batch, options) {
    if (!isPlainObject(batch)) {
      throw new SubagentError("invalid_batch", "task expects an object with a tasks array.");
    }
    for (const key of Object.keys(batch)) {
      if (!BATCH_FIELDS.has(key)) {
        throw new SubagentError("invalid_batch", `Unknown batch field ${describe(key)}.`);
      }
    }
    if (batch.context !== undefined && typeof batch.context !== "string") {
      throw new SubagentError("invalid_batch", "context must be a string when provided.");
    }
    if (!Array.isArray(batch.tasks) || batch.tasks.length === 0) {
      throw new SubagentError("invalid_batch", "tasks must be a non-empty array.");
    }

    const context = batch.context ?? null;
    const entries = batch.tasks.map((raw, index) => this.#planTask(raw, index, context));

    const inherited = entries.filter((entry) => entry.spec.inheritContext);
    if (inherited.length > 0) {
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
      if (snapshot === undefined || snapshot === null) {
        throw new SubagentError("inherited_snapshot_failed", "The inherited-context snapshot function returned no snapshot.");
      }
      // Same batch, same parent context instant — but each child gets its own
      // copy of the captured entries, so sibling sessions can neither share
      // append-only storage nor reuse one session identity.
      for (const entry of inherited) entry.spec.inheritedContext = snapshotForChild(snapshot);
    }

    return entries;
  }

  #planTask(raw, index, context) {
    const where = `tasks[${index}]`;
    const reject = (message, detail = {}) => {
      throw new SubagentError("invalid_task", message, { index, ...detail });
    };

    if (!isPlainObject(raw)) reject(`${where} must be an object.`);
    for (const key of Object.keys(raw)) {
      if (!TASK_FIELDS.has(key)) reject(`${where} has unknown field ${describe(key)}.`, { field: key });
    }
    if (raw.inheritContext !== undefined && typeof raw.inheritContext !== "boolean") {
      reject(`${where}.inheritContext must be a boolean when provided.`, { field: "inheritContext" });
    }

    let name = null;
    if (raw.name !== undefined) {
      if (typeof raw.name !== "string" || raw.name.trim() === "") reject(`${where}.name must be a non-empty string.`, { field: "name" });
      name = raw.name.trim();
    }
    if (typeof raw.task !== "string" || raw.task.trim() === "") {
      reject(`${where}.task must be a non-empty string.`, { field: "task" });
    }
    const task = raw.task.trim();

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

  #start(job) {
    return this.#withCheckpoint(() => {
      if (job.status !== "running" || this.#handles.has(job.jobId)) return;

      const budgetStart = job.budget.startActive();
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
      let handle;
      try {
        handle = this.#startJob(this.#jobRequest(job));
      } catch (error) {
        this.#fail(job, errorInfo(error, "start_failed"));
        return;
      }
      if (!isPlainObject(handle) || typeof handle.done?.then !== "function") {
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

  #jobRequest(job) {
    const agent = this.#agents.get(job.agentId);
    // Assign startup input to the run when its adapter is invoked.
    const pending = agent === undefined ? [] : agent.pending.splice(0);
    return {
      agentId: job.agentId,
      jobId: job.jobId,
      index: job.index,
      parentAgentId: agent?.parentAgentId ?? null,
      depth: agent?.depth ?? null,
      spec: job.spec,
      origin: job.origin,
      budget: job.budget,
      continuedFromJobId: job.continuedFromJobId,
      pendingMessages: pending.map((envelope) => cloneValue(envelope)),
      checkBudget: () => this.#checkBudget(job),
      recordHistory: (messages, history) => this.#recordHistory(job, messages, history),
    };
  }

  #recordHistory(job, messages, history) {
    if (TERMINAL_STATUSES.has(job.status)) return;
    if (Array.isArray(messages)) job.messages = cloneValue(messages);
    // Only the bounds are persisted, so a checkpoint is emitted exactly when
    // they move: a turn that adds no new native entry does not rewrite state.
    const bounds = historyBounds(history);
    if (bounds !== null && (job.history === null || job.history.startEntryId !== bounds.startEntryId || job.history.endEntryId !== bounds.endEntryId)) {
      job.history = bounds;
      this.#markDirty();
    }
  }

  #beginFinalization(job, execution = {}) {
    if (job.status === "finalizing" || TERMINAL_STATUSES.has(job.status)) return;

    job.budget.pauseActive();
    clearTimeout(this.#lifetimeTimers.get(job.jobId));
    this.#lifetimeTimers.delete(job.jobId);

    const payload = isPlainObject(execution) ? execution : {};
    if (Array.isArray(payload.messages)) job.messages = cloneValue(payload.messages);
    if (payload.result !== undefined && payload.result !== null) job.result = cloneValue(payload.result);
    const bounds = historyBounds(payload.history);
    if (bounds !== null) job.history = bounds;

    let status;
    let error = null;
    if (job.stopping !== null) {
      ({ status, error } = job.stopping);
    } else {
      const terminal = job.budget.check().terminal;
      if (terminal?.status === "failed") {
        status = "failed";
        error = publicBudgetError(terminal.error);
      } else if (payload.error || payload.status === "failed") {
        status = "failed";
        error = errorInfo(payload.error, "job_failed");
      } else if (payload.status === "cancelled") {
        status = "cancelled";
        error = { code: "cancelled", message: "Job cancelled." };
      } else {
        status = "completed";
      }
    }
    job.budget.terminate({ reason: status === "completed" ? "model_final" : status, error });

    const agent = this.#agents.get(job.agentId);
    const outcome = Object.freeze({
      status,
      error,
      result: job.result,
      messages: job.messages,
      history: job.history,
      budget: job.budget.snapshot(),
      jobId: job.jobId,
      round: Math.max(1, agent.jobIds.indexOf(job.jobId) + 1),
    });

    // Set before calling the hook: reentrant stop or finalization cannot change this outcome.
    job.status = "finalizing";
    if (this.#finalizeJob === null) {
      this.#end(job, outcome);
      return;
    }
    return (async () => {
      let historyState = "ready";
      let historyError = null;
      try {
        await this.#finalizeJob({ job: this.#jobView(job), outcome });
      } catch (err) {
        historyState = "error";
        historyError = errorInfo(err, "history_write_failed");
      }
      this.#end(job, { status, error, historyState, historyError });
    })();
  }

  #fail(job, error) {
    this.#beginFinalization(job, { error });
  }

  #checkBudget(job) {
    return this.#withCheckpoint(() => {
      const verdict = job.budget.check();
      if (verdict.terminal?.status !== "failed") return verdict;
      const error = publicBudgetError(verdict.terminal.error);
      if (job.status === "running") {
        this.#beginStopping(job, "failed", error);
      }
      return verdict;
    });
  }

  #scheduleLifetime(job) {
    const schedule = () => {
      const detail = job.budget.snapshot({ detail: true });
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
  #beginStopping(job, status, error) {
    return this.#withCheckpoint(() => {
      job.stopping = { status, error };
      job.status = "stopping";
      this.#markDirty();
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
  #cancelHandle(job) {
    try {
      const pending = this.#handles.get(job.jobId)?.cancel?.();
      if (pending && typeof pending.then === "function") pending.catch(() => {});
    } catch {
      // See the doc comment: the abort is best effort.
    }
  }

  #end(job, terminalInfo) {
    this.#withCheckpoint(() => {
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
      this.#markDirty();
      this.#settle(job);
    });
    // The notification is the only thing a terminal transition sends outwards;
    // it is attempted after the state of this transition is persisted.
    this.#queueCompletion(job);
  }

  #settle(job) {
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
  #queueCompletion(job) {
    this.#completions.push(job);
    if (this.#checkpointDepth > 0) return;
    this.#flushTransition();
  }

  #notifyTerminal(job) {
    if (job.status !== "failed" && job.status !== "error") {
      return;
    }
    const creator = job.createdBy;
    if (typeof creator !== "string") return;
    const historyPaths = getSubagentHistoryPaths(job.agentId, this.#historyDir);
    const envelope = {
      type: "notification",
      subagentId: job.agentId,
      name: job.spec?.name,
      status: job.status,
      content: completionText(job),
      error: job.error ? String(job.error.message || job.error) : null,
      history: {
        summary: historyPaths.summary,
        cleanJsonl: historyPaths.cleanJsonl,
      },
    };
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

  #attempt(run) {
    try {
      const pending = run();
      if (pending && typeof pending.then === "function") pending.then(undefined, () => {});
    } catch {
      // See #notifyTerminal: one attempt, never retried.
    }
  }

  /**
   * Admission for waking an idle agent: revival creates a Job, so it counts as
   * an active child exactly like a new `task` entry. When it does not fit, the
   * caller rejects the whole write instead of holding a deferred revival.
   */
  #reviveRefusal(agent) {
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
   * Register the continuation Job for an idle agent that should wake.
   *
   * A continuation has no task of its own; it carries the agent's original
   * seed (the first Job's spec) so an actor that never started at all — a task
   * cancelled before its SDK initialized, so no native session exists — can
   * still be revived into its first session. The adapter uses the seed only
   * when there is no retained conversation; a live session is never re-seeded
   * and never re-runs the original task on its own.
   */
  #scheduleContinuation(agent, createdBy) {
    const previous = this.#jobs.get(agent.jobIds[agent.jobIds.length - 1]);
    const seed = this.#jobs.get(agent.jobIds[0])?.spec ?? null;
    return this.#createJob(agent, {
      spec: { kind: "continuation", name: agent.name, seed },
      origin: previous?.origin ?? null,
      createdBy,
      continuedFromJobId: previous?.jobId ?? null,
    });
  }

  #activeChildren(parentAgentId) {
    let active = 0;
    for (const agent of this.#agents.values()) {
      if (agent.parentAgentId === parentAgentId && agent.status === "running") active += 1;
    }
    return active;
  }

  #refreshAgent(agentId) {
    const agent = this.#agents.get(agentId);
    if (!agent) return;
    const active = agent.jobIds.some((jobId) => LIVE_STATUSES.has(this.#jobs.get(jobId)?.status));
    if (!active && agent.status === "running") agent.stoppedOrder = ++this.#stoppedSequence;
    agent.status = active ? "running" : "idle";
  }

  #planMessage({ from, to, content }) {
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
  #messageEnvelope(plan) {
    return { type: "message", from: plan.from, content: plan.content };
  }

  async #sendToMain(plan) {
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
  async #sendToAgent(plan) {
    const agent = this.#agents.get(plan.to);
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
        this.#markDirty();
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
  async #broadcast(plan) {
    // Root-level children are parented to `null`, so the reserved Main actor
    // resolves to that same key here and nowhere else.
    const parentKey = plan.from === MAIN_ACTOR_ID ? null : plan.from;
    const recipients = [];
    for (const agent of this.#agents.values()) {
      if (agent.parentAgentId === parentKey) recipients.push(agent.agentId);
    }
    const sent = [];
    const errors = [];
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
  async #handToJob(job, plan) {
    if (this.#deliverMessage === null) return false;
    let outcome;
    try {
      outcome = await this.#deliverMessage({
        agentId: job.agentId,
        jobId: job.jobId,
        message: this.#messageEnvelope(plan),
      });
    } catch {
      return false;
    }
    return outcome?.accepted === true;
  }

  #receipt(plan, jobId) {
    return { ok: true, to: plan.to, jobId: jobId ?? null };
  }

  #busyError(agent, status) {
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
  #liveJobOf(agent) {
    for (const jobId of agent.jobIds) {
      const job = this.#jobs.get(jobId);
      if (job !== undefined && LIVE_STATUSES.has(job.status)) return job;
    }
    return null;
  }

  /**
   * The transcript of one Job: the live in-memory messages, or the native
   * entries a restored Job resolves through the readHistory hook. A Job that
   * never recorded anything contributes nothing.
   */
  #jobTranscript(job) {
    if (job.messages !== null) return cloneValue(job.messages);
    if (job.history === null) return null;
    if (this.#readHistory === null) {
      throw new SubagentError(
        "history_unavailable",
        `The transcript of Job ${job.jobId} is not in memory and this runtime has no readHistory hook to resolve it.`,
        { jobId: job.jobId, agentId: job.agentId },
      );
    }
    let resolved;
    try {
      resolved = this.#readHistory({ agentId: job.agentId, jobId: job.jobId, history: { ...job.history } });
    } catch (error) {
      throw new SubagentError(
        "history_unavailable",
        `Could not read the native transcript of Job ${job.jobId}: ${errorMessage(error)}`,
        { jobId: job.jobId, agentId: job.agentId },
      );
    }
    if (resolved !== null && typeof resolved === "object" && typeof resolved.then === "function") {
      throw new SubagentError(
        "history_unavailable",
        `The readHistory hook must return the transcript synchronously; Job ${job.jobId} cannot be read through a pending read.`,
        { jobId: job.jobId, agentId: job.agentId },
      );
    }
    if (!Array.isArray(resolved)) {
      throw new SubagentError("history_unavailable", `The readHistory hook returned no transcript for Job ${job.jobId}.`, {
        jobId: job.jobId,
        agentId: job.agentId,
      });
    }
    return resolved;
  }

  #childSequences = new Map();

  #allocateAgentId(parentAgentId, depth) {
    const parentKey = (!parentAgentId || parentAgentId === MAIN_ACTOR_ID)
      ? "Main"
      : parentAgentId;
    const prefix = parentKey === "Main" ? "sub" : parentKey;
    let currentSeq = (this.#childSequences.get(parentKey) ?? 0) + 1;
    let candidate = `${prefix}_${String(currentSeq).padStart(2, "0")}`;
    while (this.#agents.has(candidate) || (this.#isAgentIdTaken && this.#isAgentIdTaken(candidate))) {
      currentSeq += 1;
      candidate = `${prefix}_${String(currentSeq).padStart(2, "0")}`;
    }
    this.#childSequences.set(parentKey, currentSeq);
    if (this.#onAgentIdAllocated) {
      this.#onAgentIdAllocated(candidate);
    }
    return candidate;
  }

  #syncSequencesFromActors(actors) {
    if (!Array.isArray(actors)) return;
    for (const actor of actors) {
      if (!actor || typeof actor.agentId !== "string") continue;
      const parentKey = (!actor.parentAgentId || actor.parentAgentId === MAIN_ACTOR_ID) ? "Main" : actor.parentAgentId;
      const prefix = parentKey === "Main" ? "sub" : parentKey;
      if (actor.agentId.startsWith(prefix + "_")) {
        const numStr = actor.agentId.slice(prefix.length + 1);
        const num = parseInt(numStr, 10);
        if (!Number.isNaN(num)) {
          const current = this.#childSequences.get(parentKey) ?? 0;
          if (num > current) {
            this.#childSequences.set(parentKey, num);
          }
        }
      }
    }
  }

  #nextId(kind) {
    if (kind === "agent") {
      this.#agentSequence += 1;
      return `agent_${this.#idToken}-${String(this.#agentSequence).padStart(2, "0")}`;
    }
    this.#jobSequence += 1;
    return `job_${this.#idToken}-${String(this.#jobSequence).padStart(2, "0")}`;
  }

  #actorList(mainStatus) {
    const actors = [
      {
        agentId: MAIN_ACTOR_ID,
        name: MAIN_ACTOR_ID,
        parentAgentId: null,
        depth: 0,
        status: typeof mainStatus === "string" ? mainStatus : "running",
        root: true,
      },
    ];
    for (const agent of this.#agents.values()) {
      actors.push({
        agentId: agent.agentId,
        name: agent.name,
        parentAgentId: agent.parentAgentId,
        depth: agent.depth,
        status: agent.status,
        root: false,
      });
    }
    return actors;
  }

  #requireJob(jobId) {
    const job = typeof jobId === "string" ? this.#jobs.get(jobId) : null;
    if (!job) throw new SubagentError("unknown_job", `No job registered as ${describe(jobId)}.`);
    return job;
  }

  #budgetView(job) {
    if (job.budget !== null) return publicBudgetSnapshot(job.budget);
    return job.budgetSnapshot === null ? null : cloneValue(job.budgetSnapshot);
  }

  #itemView(job) {
    const item = {
      name: job.spec.name,
      agentId: job.agentId,
      jobId: job.jobId,
      status: job.status,
    };
    if (TERMINAL_STATUSES.has(job.status)) {
      item.resultRef = resultRef(job.agentId);
      item.historyRef = historyRef(job.agentId);
      if (job.historyState !== undefined) item.historyState = job.historyState;
      if (job.historyError !== undefined && job.historyError !== null) item.historyError = job.historyError;
    }
    const warnings = inheritedWarnings(job.spec);
    if (warnings.length > 0) item.warnings = warnings;
    return item;
  }

  #jobView(job) {
    const view = {
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
      view.resultRef = resultRef(job.agentId);
      view.historyRef = historyRef(job.agentId);
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

export function createSubagentRuntime(options) {
  return new SubagentRuntime(options);
}
