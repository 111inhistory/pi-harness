/**
 * Subagent registry, scheduler, topology admission, message routing, Job
 * Budget ownership and serializable registry state.
 *
 * This module is deliberately Pi-free: it owns batch validation, atomic
 * registration, reload-unique ids, queueing, depth/width limits, statuses,
 * cancellation, result/history references, one Budget per Job and the state
 * the adapter persists into native Pi storage. Execution is delegated to an
 * injected `startJob` adapter. The Pi extension in extensions/subagent.mjs
 * supplies that adapter; tests use deterministic fakes.
 *
 * Public batch: `{ context?, tasks: [{ name?, task, inheritContext? }] }`.
 * Role and model selection, tool resolution and prompt construction happen
 * inside the adapter's job starter after routing; the registry only carries
 * the assignment (task plus batch context) and the inherited-context snapshot
 * that one capture instant produced per child.
 *
 * Messaging:
 * - `sendMessage({from, to, content})` accepts one message for a same-runtime
 *   agent or for the reserved `Main` actor and answers with a plain success
 *   result (`{ok, to, jobId}`) as soon as the message entered a delivery path,
 *   never after a model response.
 * - Envelopes are typed. An explicit write is
 *   `{type: "message", from, content}`; a terminal notification is
 *   `{type: "completion", from, content, jobId, status, resultRef, historyRef}`.
 *   `type` and `from` are host-owned: message text can never forge a
 *   completion, and completions are only ever produced by the runtime.
 * - A running recipient takes the message exactly once through the adapter
 *   (`deliverMessage`). When the run closes while that hand-over is in flight
 *   the write makes one fresh transition instead of parking state: the agent is
 *   now idle and gets one continuation Job, or the write is rejected with
 *   `agent_busy`.
 * - A recipient whose Job is queued receives the message when that Job starts;
 *   an idle recipient is revived with an explicit NEW Job that continues its
 *   retained native conversation (`continuedFromJobId`) on a fresh Budget. The
 *   continuation also carries the actor's original seed (the first Job's spec),
 *   which the adapter needs only when the actor never started at all — a task
 *   cancelled while queued has no retained session to continue.
 * - Delivery carries no bookkeeping: no message ids, no acknowledgements, no
 *   automatic retry of failed work and no replay of already consumed steering.
 *   `agent.pending` is only the minimal queue that bridges a write and the
 *   start of the Job that carries it.
 * - Reviving an idle agent is part of the same topology accounting as creating
 *   a child: the write is rejected atomically while the parent already holds
 *   the maximum number of active children.
 * - `to: "all"` (canonical `agent://all`) is a reserved, write-only broadcast
 *   target: it fans one write out to the sender's DIRECT children only — never
 *   itself, an ancestor, a sibling or a grandchild — through the same
 *   single-target send each child would get on its own, so idle children are
 *   revived under the ordinary admission rules. The answer reports every
 *   recipient explicitly (`{ok, to: "all", sent: [{to, jobId}], errors:
 *   [{to, code, message}]}`); an empty child set succeeds. Partial fanout is
 *   never hidden and never retried.
 * - Terminal transitions notify: a Job notifies its creator exactly once, at
 *   the single point where it becomes terminal, with its Job, actor, status,
 *   result and history references and an error summary — never the answer
 *   itself. The creator is the `parentAgentId` a batch was created for, or the
 *   sender of the message that revived the actor; the root creator is `Main`.
 *   Main is notified through `deliverToMain`; an agent creator is notified
 *   through `deliverMessage` with its live running Job id, or with `jobId:
 *   null` when it is idle, queued or stopping, so the adapter appends the
 *   notification to that agent's conversation without starting a turn. A
 *   completion never creates a Job, never revives an idle actor, is attempted
 *   exactly once, is never replayed after a reload and can never change a
 *   Job's outcome.
 * - One capture instant per batch, one deep copy per child: sibling inherited
 *   sessions never share append-only entries or a session identity, and the
 *   captured snapshot is never mutated by a session that consumes it.
 * - The original `agent://` result is immutable; later activity is exposed
 *   through `history://`.
 *
 * Lifecycle:
 * - Cancelling a running Job or letting its Budget expire stops the native run
 *   but keeps the concurrency and topology slot (`status: "stopping"`) until
 *   the adapter's `done` settles. Only then is the immutable terminal payload
 *   published and `jobDone` released, so no successor Job can overlap an
 *   unwinding session and no reader observes a payload that changes later.
 * - A `stopping` agent rejects new writes with `agent_busy`.
 * - Each runtime instance namespaces its ids with a fresh UUID, so an address
 *   discarded by a reload (or from an earlier process) can never alias a later
 *   actor or Job.
 *
 * Adapter hooks (all optional except `startJob`):
 * - `startJob(request)`: runs one Job. `request.pendingMessages` are the typed
 *   envelopes assigned to this Job at start; the adapter reports its outcome
 *   through `done` (`{result, messages, history}`) and exposes partial history
 *   with `request.recordHistory(messages, {startEntryId, endEntryId})`.
 *   `request.checkBudget()` returns the same verdict as `request.budget.check()`
 *   and routes an observed hard failure through the runtime immediately: a
 *   running Job stops its native run (cancelling the handle, including one
 *   assigned only after this call) and keeps its slots until that run exits,
 *   so the terminal outcome is published exactly when the adapter's `done`
 *   settles. A later observation is a plain read of the frozen verdict.
 * - `deliverMessage({agentId, jobId, message})`: hands an envelope to a live
 *   running Job; returns `{accepted: true}` when that Job took it. `jobId` is
 *   `null` when a completion is appended for an actor that has no running Job.
 * - `deliverToMain(message)`: delivers an envelope to the root session.
 * - `onStateChange(state)`: called at every mutating boundary with a fresh,
 *   JSON-safe copy of `exportState()`. It is never called for read-only polls
 *   and it must not throw: a settled transition cannot be rolled back, so the
 *   runtime ignores callback failures and the adapter owns reporting
 *   persistence errors.
 * - `readHistory({agentId, jobId, history})`: resolves, synchronously, the
 *   native transcript of a Job whose in-memory messages are gone (restored
 *   state) from the native entry bounds; returns the same serialized message
 *   array the adapter passed to `recordHistory`. Without it, restored
 *   transcripts fail explicitly, and a pending read is refused.
 *
 * Persistence (state version 1):
 * - `exportState()` returns actors (id, label, parent link, depth, job ids),
 *   jobs (status, spec, origin, creator, immutable result, public error, native
 *   history bounds, public Budget snapshot) and every pending envelope. Actor
 *   status is derived from Job statuses and is never persisted.
 * - Transcripts are not duplicated into the state; each Job keeps only the
 *   native entry bounds it last recorded, and restored reads resolve the native
 *   entries through `readHistory`.
 * - A job's inherited-context snapshot is exported with its native entries
 *   array SHARED, never cloned: a captured context can be large and can itself
 *   contain registry snapshots. The adapter must replace `spec.inheritedContext`
 *   in the exported copy with a native seed-session reference before persisting
 *   and hydrate it back before `restoreState`, so a persisted state never
 *   embeds a whole conversation or a nested registry snapshot.
 * - Non-fatal warnings the adapter records on that snapshot
 *   (`spec.inheritedContext.warnings`, e.g. inherited tools Pi cannot
 *   transplant) ride the `task` entry and `hub jobs` views, including through a
 *   revival (through the continuation's seed) and a restore.
 * - `restoreState(state)` validates exactly this shape, preserves every
 *   restored actor and Job id and its immutable terminal result, and
 *   terminalizes every Job that was still queued, running or stopping as
 *   `failed` with `interrupted`: interrupted work is never re-run and never
 *   re-notified. New allocations use a fresh id namespace, so ids from an
 *   abandoned branch can never alias a later actor.
 *
 * Current boundaries:
 * - Every accepted job is deferred.
 * - Agent states are `running` / `idle`; there is no parked state, but idle
 *   agents can be revived by an explicit message.
 * - Nothing here talks to `work`, and Job completion never wakes Main.
 */

import { randomUUID } from "node:crypto";

import { createJobBudget } from "./job-budget.mjs";
import { getAgentSocketPath } from "./subagent-socket.mjs";
import { getSubagentHistoryPaths } from "./subagent-history.mjs";

const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_AGENT_DEPTH = 2;
const MAX_ACTIVE_CHILDREN = 4;

const MAX_MESSAGE_CHARS = 32768;
const MAIN_ACTOR_ID = "Main";
const BROADCAST_TARGET = "all";

const STATE_VERSION = 1;

const BATCH_FIELDS = new Set(["context", "tasks"]);
const TASK_FIELDS = new Set(["name", "task", "inheritContext"]);

/** A Job occupies its agent, its concurrency slot and its topology slot. */
const LIVE_STATUSES = new Set(["queued", "running", "stopping"]);
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
  return error instanceof Error ? error.message : String(error);
}

function errorInfo(error, fallbackCode) {
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
    const actor = { agentId, name, parentAgentId, depth, jobIds: [...raw.jobIds], pending: [] };
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
 * input order, and then starts as many jobs as the concurrency cap allows.
 * Nothing touches the registry before validation succeeds.
 */
export class SubagentRuntime {
  #startJob;
  #deliverMessage;
  #deliverToMain;
  #onStateChange;
  #readHistory;
  #maxConcurrency;
  #allowInherited;
  #socketDir;
  #historyDir;
  #isAgentIdTaken;
  #onAgentIdAllocated;

  #agents = new Map();
  #jobs = new Map();
  #queue = [];
  #running = new Set();
  #handles = new Map();
  #lifetimeTimers = new Map();
  #waiters = new Map();
  #pumping = false;
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
      maxConcurrency = DEFAULT_MAX_CONCURRENCY,
      allowInherited = true,
      socketDir,
      historyDir,
      isAgentIdTaken,
      onAgentIdAllocated,
    } = options;

    if (typeof startJob !== "function") {
      throw new SubagentError("invalid_options", "A startJob adapter function is required.");
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
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new SubagentError("invalid_options", `maxConcurrency must be an integer >= 1, received ${describe(maxConcurrency)}.`);
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
    this.#maxConcurrency = maxConcurrency;
    this.#allowInherited = allowInherited;
    this.#socketDir = socketDir;
    this.#historyDir = historyDir;
    this.#isAgentIdTaken = typeof isAgentIdTaken === "function" ? isAgentIdTaken : null;
    this.#onAgentIdAllocated = typeof onAgentIdAllocated === "function" ? onAgentIdAllocated : null;
    this.#idToken = randomUUID().replaceAll("-", "");
  }

  get maxConcurrency() {
    return this.#maxConcurrency;
  }

  /** Create subagents batch according to the public contract (returns unified id, socket, history). */
  create(batch, options = {}) {
    const res = this.task(batch, options);
    const result = {
      items: res.items.map((item) => {
        const historyPaths = getSubagentHistoryPaths(item.agentId, this.#historyDir);
        const mapped = {
          id: item.agentId,
          name: item.name,
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

      this.#pump();
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
      status: "queued",
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
    this.#queue.push(jobId);
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
  listDetailed(filter) {
    const targetId = filter?.id || filter?.agentId;
    const items = [];
    for (const agent of this.#agents.values()) {
      if (targetId && agent.agentId !== targetId) continue;
      const liveJob = this.#liveJobOf(agent);
      const latestJob = agent.jobIds.length > 0 ? this.#jobs.get(agent.jobIds[agent.jobIds.length - 1]) : null;
      const budgetJob = liveJob || latestJob;
      const currentStatus = liveJob ? liveJob.status : (agent.status === "idle" ? "stopped" : agent.status);
      if (filter?.status !== undefined && filter.status !== currentStatus && filter.status !== agent.status) continue;
      const historyPaths = getSubagentHistoryPaths(agent.agentId, this.#historyDir);
      items.push({
        id: agent.agentId,
        name: agent.name,
        depth: agent.depth,
        parentId: agent.parentAgentId ?? "Main",
        status: currentStatus,
        budget: budgetJob?.budget ? budgetJob.budget.snapshot() : null,
        socket: getAgentSocketPath(agent.agentId, this.#socketDir),
        history: {
          summary: historyPaths.summary,
          cleanJsonl: historyPaths.cleanJsonl,
        },
      });
    }
    return { items };
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
   * it, a queued Job will take it at start, or an idle agent was revived with a
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
   * A queued Job is terminal immediately. A running Job stops its native run
   * but stays `stopping` (still holding its concurrency and topology slot)
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
      if (job.status === "stopping") {
        return { ok: false, reason: "stopping", job: this.#jobView(job) };
      }

      if (job.status === "queued") {
        const at = this.#queue.indexOf(job.jobId);
        if (at !== -1) this.#queue.splice(at, 1);
        job.budget.terminate({ reason: "cancelled" });
        this.#end(job, "cancelled", { code: "cancelled", message: "Job cancelled before it started." });
        return { ok: true, job: this.#jobView(job) };
      }

      // Running: stop the native run and keep the slot until it has exited, so
      // the aborted session never overlaps a successor Job on the same agent.
      job.budget.terminate({ reason: "cancelled" });
      this.#beginStopping(job, "cancelled", { code: "cancelled", message: "Job cancelled while running." });
      return { ok: true, job: this.#jobView(job) };
    });
  }

  /**
   * Stop one subagent by id gracefully.
   * If queued, marks cancelled immediately. If running, enters stopping.
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
   * while a Job that was still queued, running or stopping becomes `failed`
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
          pending: actor.pending,
        });
      }
      const interrupted = [];
      for (const job of restored.jobs) {
        this.#jobs.set(job.jobId, job);
        if (job.error?.code === INTERRUPTED.code) interrupted.push(job.jobId);
      }
      for (const agent of this.#agents.values()) this.#refreshAgent(agent.agentId);
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

  // Re-entrant-safe: a synchronous start failure calls back into #pump while
  // the active loop is still running, and that loop already re-checks capacity.
  #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#running.size < this.#maxConcurrency && this.#queue.length > 0) {
        const jobId = this.#queue.shift();
        const job = this.#jobs.get(jobId);
        if (!job || job.status !== "queued") continue;
        this.#start(job);
      }
    } finally {
      this.#pumping = false;
    }
  }

  #start(job) {
    return this.#withCheckpoint(() => {
      job.status = "running";
      this.#running.add(job.jobId);
      this.#markDirty();

      const budgetStart = job.budget.startActive();
      if (!budgetStart.ok) {
        const terminal = budgetStart.terminal;
        this.#end(
          job,
          terminal?.status ?? "failed",
          publicBudgetError(terminal?.error) ?? { code: "budget_exceeded", message: "Job execution budget exhausted." },
        );
        return;
      }

      let handle;
      try {
        handle = this.#startJob(this.#jobRequest(job));
      } catch (error) {
        this.#failStart(job, errorInfo(error, "start_failed"));
        return;
      }
      if (!isPlainObject(handle) || typeof handle.done?.then !== "function") {
        this.#failStart(job, {
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
        (outcome) => this.#finish(job, outcome),
        (error) => this.#fail(job, error),
      );
    });
  }

  #jobRequest(job) {
    const agent = this.#agents.get(job.agentId);
    // Messages are assigned at start, not at registration, so a message that
    // arrives while the Job is queued still belongs to this run.
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

  #finish(job, outcome) {
    return this.#withCheckpoint(() => {
      const payload = isPlainObject(outcome) ? outcome : {};
      const messages = Array.isArray(payload.messages) ? cloneValue(payload.messages) : job.messages;
      const result = payload.result === undefined ? job.result : cloneValue(payload.result);
      // The terminal outcome may repeat the native bounds the last
      // recordHistory call reported; it never has to.
      const bounds = historyBounds(payload.history);
      if (bounds !== null) job.history = bounds;

      if (job.stopping !== null) {
        // Cancelled or expired: keep the partial output of the aborted run and
        // publish one frozen terminal payload now that the native handle exited.
        if (messages !== null) job.messages = messages;
        if (result !== null) job.result = result;
        this.#end(job, job.stopping.status, job.stopping.error);
        return;
      }
      if (job.status !== "running") return;

      job.messages = messages;
      job.result = result;
      const terminal = job.budget.terminate({ reason: "model_final" }).terminal;
      this.#end(job, terminal?.status ?? "completed", publicBudgetError(terminal?.error));
    });
  }

  #fail(job, error) {
    return this.#withCheckpoint(() => {
      if (job.stopping !== null) {
        this.#end(job, job.stopping.status, job.stopping.error);
        return;
      }
      const terminal = job.budget.check().terminal;
      if (terminal?.status === "failed") {
        this.#end(job, "failed", publicBudgetError(terminal.error));
        return;
      }
      this.#end(job, "failed", errorInfo(error, "job_failed"));
    });
  }

  /**
   * A run that never reached a handle still publishes a stopping outcome that
   * was already observed and checkpointed during `startJob`: the Budget
   * failure the adapter saw is not replaced by the start failure that followed
   * it. Without an observed failure this is the start failure itself.
   */
  #failStart(job, error) {
    if (job.stopping !== null) this.#end(job, job.stopping.status, job.stopping.error);
    else this.#end(job, "failed", error);
  }

  /**
   * Observation point shared by the adapter (`request.checkBudget()`) and the
   * runtime's own lifetime timer: settle the Budget, then route an observed
   * hard failure through the one transition that owns it. A queued Job fails
   * in place; a running Job stops its native run first, keeps its slots until
   * that run exits and is published from there — never earlier. Once the Job
   * is stopping or terminal this is a plain read of the frozen verdict, so a
   * repeated observation cannot cancel twice or notify twice.
   */
  #checkBudget(job) {
    return this.#withCheckpoint(() => {
      const verdict = job.budget.check();
      if (verdict.terminal?.status !== "failed") return verdict;
      const error = publicBudgetError(verdict.terminal.error);
      if (job.status === "queued") {
        const at = this.#queue.indexOf(job.jobId);
        if (at !== -1) this.#queue.splice(at, 1);
        this.#end(job, "failed", error);
      } else if (job.status === "running") {
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
        // expired lease routes to the queued or stopping terminal path there.
        if (this.#checkBudget(job).terminal?.status !== "failed") schedule();
      }, remaining);
      timer.unref?.();
      this.#lifetimeTimers.set(job.jobId, timer);
    };
    schedule();
  }

  /**
   * Stop a running Job's native run and hold its slots until the adapter's
   * `done` settles. `#finish` / `#fail` observe `job.stopping` and publish the
   * one terminal payload from there.
   */
  #beginStopping(job, status, error) {
    return this.#withCheckpoint(() => {
      job.stopping = { status, error };
      job.status = "stopping";
      this.#markDirty();
      clearTimeout(this.#lifetimeTimers.get(job.jobId));
      this.#lifetimeTimers.delete(job.jobId);
      this.#cancelHandle(job);
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

  #end(job, status, error) {
    this.#withCheckpoint(() => {
      job.budget.pauseActive();
      clearTimeout(this.#lifetimeTimers.get(job.jobId));
      this.#lifetimeTimers.delete(job.jobId);
      job.status = status;
      job.error = error ?? null;
      this.#running.delete(job.jobId);
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
    this.#pump();
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
   * cancelled while it was still queued, so no native session exists — can
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
   * One ordinary single-target write: hand over to the live Job, hold it for a
   * queued Job, or revive an idle agent with a continuation Job.
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
        this.#pump();
        return this.#receipt(plan, revived.jobId);
      }
      if (live.status === "stopping") {
        throw this.#busyError(agent, "stopping");
      }
      if (live.status === "queued") {
        // A queued Job owns the agent and picks the message up when it starts.
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
