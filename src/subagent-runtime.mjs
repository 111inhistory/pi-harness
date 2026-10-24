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

import { createJobBudget } from "./job-budget.mjs";
import {
  adjudicateTerminal,
  firstEffectiveStopping,
  terminalNotification,
} from "./subagent/lifecycle.ts";
import { getAgentSocketPath } from "./subagent-socket.mjs";

const MAX_AGENT_DEPTH = 2;
const MAX_ACTIVE_CHILDREN = 4;

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
 * Normalized native history bounds of one Job: the entry it started after and
 * the entry its transcript reaches. A malformed adapter report is ignored
 * instead of being stored half-formed.
 */
function historyBounds(value) {
  if (!isPlainObject(value)) return null;
  const start = value.startEntryId ?? null;
  const end = value.endEntryId ?? null;
  if (start !== null && typeof start !== "string") return null;
  if (end !== null && typeof end !== "string") return null;
  return { startEntryId: start, endEntryId: end };
}

function stateError(message, detail = {}) {
  return new SubagentError("invalid_state", message, detail);
}

/**
 * Canonicalize an actor id: `Main` (case-insensitive) or a generated subagent
 * id. The broadcast target `all` is not an actor. Returns null for anything else.
 */
export function canonicalActorId(value) {
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
export function copyInheritedEntries(entries) {
  if (!Array.isArray(entries)) return entries;
  const copy = structuredClone(entries);
  const header = copy.findIndex((entry) => entry?.type === "session" && typeof entry.id === "string");
  if (header !== -1) copy[header] = { ...copy[header], id: randomUUID() };
  return copy;
}

/**
 * The persisted form of a Job spec. A continuation is persisted by name only
 * (its seed is the actor's first spec), and captured conversation entries are
 * never persisted: a durable adapter stores them in the actor's own session.
 */
function persistedSpec(spec) {
  if (spec.kind === "continuation") return { kind: "continuation", name: spec.name ?? null };
  const copy = { ...spec };
  if (isPlainObject(spec.inheritedContext)) {
    const { entries: _entries, ...meta } = spec.inheritedContext;
    copy.inheritedContext = meta;
  }
  return copy;
}

/**
 * Non-fatal warnings that belong to a Job's entry (for example inherited tools
 * that Pi's public API cannot transplant). A continuation reads its seed's.
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
  return lines.join("\n");
}

/**
 * Validate a restored registry description (see `restoreState`).
 *
 * The description is folded from the adapter's own events, but it is still
 * read back from a file that may be truncated or hand-edited, so topology and
 * ownership are checked before anything reaches the registry.
 */
function planRestore(state) {
  if (!isPlainObject(state) || !Array.isArray(state.actors) || !Array.isArray(state.jobs)) {
    throw stateError("The restored subagent state must carry actor and Job lists.");
  }
  const actors = new Map();
  for (const raw of state.actors) {
    const agentId = raw?.agentId;
    if (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId)) throw stateError(`${describe(agentId)} is not a subagent actor id.`);
    if (actors.has(agentId)) throw stateError(`Actor ${agentId} appears more than once.`);
    if (!Number.isInteger(raw.depth) || raw.depth < 1 || raw.depth > MAX_AGENT_DEPTH) {
      throw stateError(`Actor ${agentId} has an invalid depth.`, { agentId });
    }
    actors.set(agentId, {
      agentId,
      name: typeof raw.name === "string" ? raw.name : null,
      parentAgentId: raw.parentAgentId ?? null,
      depth: raw.depth,
      status: "idle",
      jobIds: [],
      pending: [],
      stoppedOrder: Number.isSafeInteger(raw.stoppedOrder) ? raw.stoppedOrder : 0,
    });
  }
  for (const actor of actors.values()) {
    const parent = actor.parentAgentId === null ? null : actors.get(actor.parentAgentId);
    if (parent === undefined) throw stateError(`Actor ${actor.agentId} names unknown parent ${actor.parentAgentId}.`);
    if ((parent?.depth ?? 0) + 1 !== actor.depth) throw stateError(`Actor ${actor.agentId} has an inconsistent depth.`);
  }

  const jobs = new Map();
  for (const raw of state.jobs) {
    const jobId = raw?.jobId;
    if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) throw stateError(`${describe(jobId)} is not a Job id.`);
    if (jobs.has(jobId)) throw stateError(`Job ${jobId} appears more than once.`);
    const actor = actors.get(raw.agentId);
    if (actor === undefined) throw stateError(`Job ${jobId} belongs to unknown actor ${describe(raw.agentId)}.`);
    if (!isPlainObject(raw.spec)) throw stateError(`Job ${jobId} has no spec.`);
    const previous = raw.continuedFromJobId ?? null;
    if (previous !== null && jobs.get(previous)?.agentId !== actor.agentId) {
      throw stateError(`Job ${jobId} continues ${describe(previous)}, which is not an earlier Job of its actor.`);
    }
    const end = isPlainObject(raw.end) ? raw.end : null;
    const spec =
      raw.spec.kind === "continuation"
        ? { kind: "continuation", name: raw.spec.name ?? null, seed: jobs.get(actor.jobIds[0])?.spec ?? null }
        : raw.spec;
    jobs.set(jobId, {
      jobId,
      agentId: actor.agentId,
      index: raw.index ?? null,
      spec,
      origin: raw.origin ?? null,
      createdBy: raw.createdBy ?? MAIN_ACTOR_ID,
      continuedFromJobId: previous,
      status: end === null ? "failed" : terminalStatus(end.status, jobId),
      result: end?.result ?? null,
      error: end === null ? { ...INTERRUPTED } : (end.error ?? null),
      history: historyBounds(end === null ? raw.history : end.history),
      interrupted: end === null,
      budget: null,
      // A restored Job is terminal; its Budget snapshot is reporting only.
      budgetSnapshot: end?.budget ? { ...end.budget, running: false } : null,
      stopping: null,
    });
    actor.jobIds.push(jobId);
  }
  return { actors: [...actors.values()], jobs: [...jobs.values()] };
}

function terminalStatus(status, jobId) {
  if (!TERMINAL_STATUSES.has(status)) throw stateError(`Job ${jobId} ends with non-terminal status ${describe(status)}.`);
  return status;
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
  #onEvent;
  #allowInherited;
  #socketDir;
  #historyPaths;
  #prepareInherited;
  #isIdTaken;
  #onIdAllocated;
  #finalizeJob;

  #agents = new Map();
  #stoppedSequence = 0;
  #jobs = new Map();
  #handles = new Map();
  #lifetimeTimers = new Map();
  #waiters = new Map();
  #childSequences = new Map();
  #transitionDepth = 0;
  #completions = [];

  constructor(options = {}) {
    if (!isPlainObject(options)) {
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
  }

  /** Create a subagent batch according to the public contract (id, status, socket). */
  create(batch, options = {}) {
    const res = this.task(batch, options);
    const result = {
      items: res.items.map((item) => {
        const mapped = {
          id: item.agentId,
          status: item.status,
          socket: getAgentSocketPath(item.agentId, this.#socketDir),
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
        const agentId = agentIds[position];
        try {
          entry.spec.inheritedContext =
            this.#prepareInherited === null
              ? { ...snapshot, entries: copyInheritedEntries(snapshot.entries) }
              : this.#prepareInherited({ agentId, snapshot });
        } catch (error) {
          throw new SubagentError("inherited_snapshot_failed", `Failed to store the calling context for ${agentId}: ${errorMessage(error)}`);
        }
      });
      const registered = [];

      for (const [position, entry] of entries.entries()) {
        const agentId = agentIds[position];
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
    const jobId = continuedFromJobId === null ? agent.agentId : this.#allocateJobId(agent);
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
      // Native entry bounds of the transcript this Job recorded.
      history: null,
      budget: createJobBudget({ depth: agent.depth, jobId }),
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
  #allocateJobId(agent) {
    let round = agent.jobIds.length + 1;
    while (this.#jobs.has(`${agent.agentId}#r${round}`) || this.#isIdTaken?.(`${agent.agentId}#r${round}`)) round += 1;
    const jobId = `${agent.agentId}#r${round}`;
    this.#onIdAllocated?.(jobId);
    return jobId;
  }

  #emit(event) {
    if (this.#onEvent === null) return;
    try {
      this.#onEvent(event);
    } catch {
      // A settled transition cannot be rolled back and a storage failure must
      // never change a Job outcome; the adapter reports persistence errors.
    }
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
      const item = {
        id: agent.agentId,
        parentId: agent.parentAgentId ?? "Main",
        status: currentStatus,
        socket: getAgentSocketPath(agent.agentId, this.#socketDir),
      };
      const latest = [...agent.jobIds].reverse().map((jobId) => this.#jobs.get(jobId)).find((job) => TERMINAL_STATUSES.has(job.status));
      const history = latest === undefined ? null : this.#historyPaths?.(latest.jobId);
      if (history) item.history = { jobId: latest.jobId, ...history };
      items.push(item);
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
   * Cancel one job without touching any other job or agent.
   *
   * A Job whose adapter has not started goes directly through finalization.
   * A started Job stays `stopping` (occupying its actor and topology allowance)
   * until the adapter's handle settles, then publishes its cancelled payload.
   *
   * @returns {{ ok: boolean, reason?: string, job: object }}
   */
  cancelJob(jobId) {
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
   * Everything a readable view of one terminal Job needs. Null for a Job that
   * is unknown or still live.
   */
  jobRecord(jobId) {
    const job = this.#jobs.get(jobId);
    if (job === undefined || !TERMINAL_STATUSES.has(job.status)) return null;
    const agent = this.#agents.get(job.agentId);
    const seed = job.spec.kind === "continuation" ? job.spec.seed : job.spec;
    return {
      jobId: job.jobId,
      agentId: job.agentId,
      name: agent?.name ?? null,
      round: Math.max(1, (agent?.jobIds.indexOf(job.jobId) ?? 0) + 1),
      task: job.spec.kind === "continuation" ? null : (seed?.task ?? null),
      status: job.status,
      error: cloneValue(job.error),
      result: job.result,
      history: job.history === null ? null : { ...job.history },
      budget: this.#budgetView(job),
      previousJobId: job.continuedFromJobId,
    };
  }

  /**
   * Restore a registry folded from persisted events into a fresh runtime.
   *
   * `state.actors` carry `{ agentId, name, parentAgentId, depth, stoppedOrder }`;
   * `state.jobs` carry the registered Job fields plus `end` (the terminal
   * outcome, or null) in creation order. A Job without an end was live when
   * its process went away: it becomes `failed` with `interrupted`, is never
   * re-run or re-notified, and its terminal event is emitted now (with the
   * `history` bounds the adapter sealed for it).
   *
   * @returns {{ actors: number, jobs: number, interrupted: string[] }}
   */
  restoreState(state) {
    if (this.#agents.size > 0 || this.#jobs.size > 0) {
      throw new SubagentError("invalid_state", "restoreState requires a fresh runtime; this runtime already has registered actors or jobs.");
    }
    const restored = planRestore(state);
    for (const actor of restored.actors) {
      this.#agents.set(actor.agentId, actor);
      this.#noteSequence(actor);
    }
    this.#stoppedSequence = Math.max(0, ...restored.actors.map((actor) => actor.stoppedOrder));
    const interrupted = [];
    for (const job of restored.jobs) {
      const { interrupted: wasLive, ...record } = job;
      this.#jobs.set(job.jobId, record);
      if (!wasLive) continue;
      interrupted.push(job.jobId);
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
  #withTransition(run) {
    this.#transitionDepth += 1;
    try {
      return run();
    } finally {
      this.#transitionDepth -= 1;
      if (this.#transitionDepth === 0) this.#flushCompletions();
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
    return this.#withTransition(() => {
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
      recordStart: (startEntryId) => this.#recordStart(job, startEntryId),
    };
  }

  /**
   * The native entry this Job's transcript starts after, recorded once before
   * its first prompt. A process that dies mid-run is recovered from here.
   */
  #recordStart(job, startEntryId) {
    if (job.history !== null || TERMINAL_STATUSES.has(job.status)) return;
    if (startEntryId !== null && typeof startEntryId !== "string") return;
    job.history = { startEntryId, endEntryId: null };
    this.#emit({ type: "job-start", jobId: job.jobId, startEntryId });
  }

  #beginFinalization(job, execution = {}) {
    if (job.status === "finalizing" || TERMINAL_STATUSES.has(job.status)) return;

    job.budget.pauseActive();
    clearTimeout(this.#lifetimeTimers.get(job.jobId));
    this.#lifetimeTimers.delete(job.jobId);

    const payload = isPlainObject(execution) ? execution : {};
    if (payload.result !== undefined && payload.result !== null) job.result = cloneValue(payload.result);
    const bounds = historyBounds(payload.history);
    if (bounds !== null) job.history = bounds;

    const budgetTerminal = job.budget.check().terminal;
    const decision = adjudicateTerminal({
      stopping: job.stopping,
      budgetError: budgetTerminal?.status === "failed" ? publicBudgetError(budgetTerminal.error) : null,
      executionError: payload.error ? errorInfo(payload.error, "job_failed") : null,
      executionStatus: typeof payload.status === "string" ? payload.status : null,
    });
    const { status, error } = decision;
    job.budget.terminate({ reason: status === "completed" ? "model_final" : status, error });

    const agent = this.#agents.get(job.agentId);
    const outcome = Object.freeze({
      status,
      error,
      result: job.result,
      // Passed through to finalization only; the runtime keeps no transcript.
      transcript: Array.isArray(payload.transcript) ? payload.transcript : null,
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
    return this.#withTransition(() => {
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
  #cancelHandle(job) {
    try {
      const pending = this.#handles.get(job.jobId)?.cancel?.();
      if (pending && typeof pending.then === "function") pending.catch(() => {});
    } catch {
      // See the doc comment: the abort is best effort.
    }
  }

  #end(job, terminalInfo) {
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

  #emitEnd(job) {
    const event = {
      type: "job-end",
      jobId: job.jobId,
      status: job.status,
      error: cloneValue(job.error),
      result: job.result,
      history: job.history === null ? null : { ...job.history },
      budget: this.#budgetView(job),
    };
    if (job.historyState !== undefined) event.historyState = job.historyState;
    if (job.historyError !== undefined) event.historyError = job.historyError;
    this.#emit(event);
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
    if (job.completionQueued === true) return;
    job.completionQueued = true;
    this.#completions.push(job);
    if (this.#transitionDepth > 0) return;
    this.#flushCompletions();
  }

  #notifyTerminal(job) {
    // Completed, cancelled and failed rounds all publish one typed terminal
    // event. The delivery coordinator decides how it merges or wakes; the
    // runtime never suppresses a normal completion.
    if (!TERMINAL_STATUSES.has(job.status)) return;
    const sourceAgent = this.#agents.get(job.agentId);
    // Host notifications follow topology, not whoever revived this round. A
    // peer that wakes an idle agent must not steal its terminal notice from
    // the direct parent. `createdBy` stays the audit field on the Job.
    const creator = sourceAgent?.parentAgentId ?? MAIN_ACTOR_ID;
    if (typeof creator !== "string") return;
    const round = Math.max(1, (sourceAgent?.jobIds.indexOf(job.jobId) ?? 0) + 1);
    const envelope = terminalNotification({
      agentId: job.agentId,
      jobId: job.jobId,
      round,
      name: job.spec?.name,
      status: job.status,
      content: completionText(job),
      error: job.error ?? null,
      history: this.#historyPaths?.(job.jobId) ?? null,
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
  reviveWithNotification(agentId, envelope) {
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
    const envelope = { type: "message", from: plan.from, content: plan.content };
    // A Subagent message belongs to its sender's current execution round. The
    // host can therefore merge it with that round's terminal notice without
    // asking the caller to supply transport or run identity.
    if (plan.from !== MAIN_ACTOR_ID) {
      const source = this.#agents.get(plan.from);
      const live = source === undefined ? null : this.#liveJobOf(source);
      if (live !== null) {
        envelope.jobId = live.jobId;
        envelope.round = Math.max(1, source.jobIds.indexOf(live.jobId) + 1);
      }
    }
    return envelope;
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

  #allocateAgentId(parentAgentId) {
    const prefix = parentAgentId ?? "sub";
    let sequence = this.#childSequences.get(prefix) ?? 0;
    let candidate;
    do {
      sequence += 1;
      candidate = `${prefix}_${String(sequence).padStart(2, "0")}`;
    } while (this.#agents.has(candidate) || this.#isIdTaken?.(candidate));
    this.#childSequences.set(prefix, sequence);
    this.#onIdAllocated?.(candidate);
    return candidate;
  }

  /** Keep generated ids ahead of every restored actor. */
  #noteSequence(actor) {
    const prefix = actor.parentAgentId ?? "sub";
    if (!actor.agentId.startsWith(`${prefix}_`)) return;
    const sequence = Number.parseInt(actor.agentId.slice(prefix.length + 1), 10);
    if (Number.isSafeInteger(sequence) && sequence > (this.#childSequences.get(prefix) ?? 0)) this.#childSequences.set(prefix, sequence);
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
