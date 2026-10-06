/**
 * Job Budget state machine for subagent Jobs
 * (design: docs/capability-and-job-budget-design.md).
 *
 * This module is Pi-free and clock-injected. The adapter owns the wiring
 * points; the budget owns every counter, phase and terminal decision:
 *
 * - `beginModelCall()` is the atomic pre-charge taken before each Provider
 *   request. It projects `modelCalls + 1`; a projection above `hard` is
 *   refused and settles the Job as failed/`budget_exceeded`, so the `hard`-th
 *   call itself is never special-cased.
 * - `takeWarning()` hands out the one-shot soft control message (at most once
 *   per Job) for injection into the next request; it carries no numbers.
 * - `startActive()` / `pauseActive()` open and close the running window, so
 *   queued and waiting time cost nothing while `lifetimeMs` keeps running as
 *   an absolute lease from construction.
 * - `check()` settles time-based exhaustion; `terminate()` settles the Job
 *   when the model returns a final answer or the user cancels.
 *
 * Phases only upgrade (normal -> warning -> exhausted). A terminal budget is
 * frozen: counters, phase and snapshots stop changing and every further
 * transition is refused. Tool Calls are deliberately not a budget dimension.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const DEFAULT_NOW = () => performance.now();

export const BUDGET_PHASES = Object.freeze(["normal", "warning", "exhausted"]);

/**
 * The soft control message injected into the next request once any dimension
 * reaches soft. Concrete limits stay harness-owned and are never included.
 */
export const BUDGET_WARNING_MESSAGE = [
  "Execution resources are becoming limited. Finish the current line of work,",
  "avoid opening unrelated branches, verify the result, and return a final answer.",
].join("\n");

/**
 * Harness-owned safety ceiling per subagent nesting depth. Profiles are only
 * selected by depth: task text, agent name and `effort` never influence them.
 */
export const JOB_BUDGET_BY_DEPTH = deepFreeze({
  1: {
    modelCalls: { soft: 160, hard: 200 },
    activeTimeMs: { soft: 90 * MINUTE_MS, hard: 120 * MINUTE_MS },
    lifetimeMs: 24 * HOUR_MS,
  },
  2: {
    modelCalls: { soft: 48, hard: 64 },
    activeTimeMs: { soft: 45 * MINUTE_MS, hard: 60 * MINUTE_MS },
    lifetimeMs: 12 * HOUR_MS,
  },
});

const BUDGET_DEPTHS = Object.freeze(Object.keys(JOB_BUDGET_BY_DEPTH).map(Number));
const PHASE_RANK = new Map(BUDGET_PHASES.map((phase, index) => [phase, index]));

const OPTION_FIELDS = new Set(["depth", "jobId", "now", "profile"]);
const SNAPSHOT_FIELDS = new Set(["detail"]);
const TERMINATE_FIELDS = new Set(["reason"]);
const TERMINATE_REASONS = new Set(["model_final", "cancelled"]);

const PROFILE_FIELDS = new Set(["modelCalls", "activeTimeMs", "lifetimeMs"]);
const LIMIT_FIELDS = new Set(["soft", "hard"]);

/** Harness-owned error with a stable machine-readable code. */
export class JobBudgetError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "JobBudgetError";
    this.code = code;
    this.detail = Object.freeze({ ...detail });
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

function checkFields(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new JobBudgetError("invalid_options", `${where}: unsupported field "${key}".`);
    }
  }
}

/** Snapshots and terminal records are handed out frozen, recursively. */
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function maxPhase(left, right) {
  return PHASE_RANK.get(left) >= PHASE_RANK.get(right) ? left : right;
}

function phaseForModelCalls(value, limit) {
  if (value > limit.hard) return "exhausted";
  if (value >= limit.soft) return "warning";
  return "normal";
}

function phaseForActiveTime(value, limit) {
  if (value >= limit.hard) return "exhausted";
  if (value >= limit.soft) return "warning";
  return "normal";
}

function completedTerminal() {
  return { status: "completed", termination: "model_final", truncated: false, error: null };
}

function cancelledTerminal() {
  return {
    status: "cancelled",
    termination: "cancelled",
    truncated: true,
    error: { code: "cancelled", message: "Job cancelled." },
  };
}

function budgetExceededTerminal(detail) {
  return {
    status: "failed",
    termination: "budget_exhausted",
    truncated: true,
    error: { code: "budget_exceeded", detail },
  };
}

function lifetimeExpiredTerminal(detail) {
  return {
    status: "failed",
    termination: "lifetime_expired",
    truncated: true,
    error: { code: "job_expired", detail },
  };
}

function refused(reason, terminal = null, extra = null) {
  const result = { ok: false, reason, terminal, error: terminal ? terminal.error : null };
  return Object.freeze(extra === null ? result : Object.assign(result, extra));
}

function requireLimit(value, where) {
  if (!isPlainObject(value)) {
    throw new JobBudgetError("invalid_options", `${where} must be an object with soft and hard limits.`);
  }
  checkFields(value, LIMIT_FIELDS, where);
  const { soft, hard } = value;
  if (!Number.isInteger(soft) || soft < 1) {
    throw new JobBudgetError("invalid_options", `${where}.soft must be an integer >= 1, received ${describe(soft)}.`);
  }
  if (!Number.isInteger(hard) || hard < soft) {
    throw new JobBudgetError("invalid_options", `${where}.hard must be an integer >= soft, received ${describe(hard)}.`);
  }
  return Object.freeze({ soft, hard });
}

function requireProfile(value, where) {
  if (!isPlainObject(value)) {
    throw new JobBudgetError("invalid_options", `${where} must be an object with modelCalls, activeTimeMs and lifetimeMs.`);
  }
  checkFields(value, PROFILE_FIELDS, where);
  const modelCalls = requireLimit(value.modelCalls, `${where}.modelCalls`);
  const activeTimeMs = requireLimit(value.activeTimeMs, `${where}.activeTimeMs`);
  const lifetimeMs = value.lifetimeMs;
  if (!Number.isInteger(lifetimeMs) || lifetimeMs < 1) {
    throw new JobBudgetError("invalid_options", `${where}.lifetimeMs must be an integer >= 1, received ${describe(lifetimeMs)}.`);
  }
  return Object.freeze({ modelCalls, activeTimeMs, lifetimeMs });
}

function requireDepth(depth) {
  if (!Number.isInteger(depth) || !Object.hasOwn(JOB_BUDGET_BY_DEPTH, depth)) {
    throw new JobBudgetError(
      "invalid_depth",
      `depth must be one of ${BUDGET_DEPTHS.join(", ")}, received ${describe(depth)}.`,
    );
  }
  return JOB_BUDGET_BY_DEPTH[depth];
}

/** Harness-owned profile for a subagent nesting depth. */
export function profileForDepth(depth) {
  return requireDepth(depth);
}

/**
 * Budget for one Job. Constructed per `jobId`; a continuation Job gets a new
 * budget (and a new `jobId`) even when it continues the same Agent.
 */
export class JobBudget {
  #depth;
  #jobId;
  #profile;
  #now;

  #startedAt;
  #modelCalls = 0;
  #rejectedProjectedModelCalls = null;
  #accruedActiveMs = 0;
  #activeSince = null;
  #phase = "normal";
  #warningTaken = false;
  #terminal = null;
  #settledElapsedMs = null;

  /**
   * @param {{
   *   depth?: 1 | 2,
   *   jobId?: string,
   *   now?: () => number,
   *   profile?: { modelCalls: { soft: number, hard: number }, activeTimeMs: { soft: number, hard: number }, lifetimeMs: number },
   * }} [options]
   *   `now` must be a monotonic clock in milliseconds. `depth` selects
   *   `JOB_BUDGET_BY_DEPTH[depth]`; `profile` overrides it for internal
   *   execution paths that are not depth-derived, and then `depth` is
   *   optional.
   */
  constructor(options = {}) {
    if (!isPlainObject(options)) {
      throw new JobBudgetError("invalid_options", `Job budget options must be an object, received ${describe(options)}.`);
    }
    checkFields(options, OPTION_FIELDS, "Job budget options");

    const { depth, jobId, now = DEFAULT_NOW, profile } = options;
    if (depth !== undefined) requireDepth(depth);
    if (typeof now !== "function") {
      throw new JobBudgetError("invalid_options", `now must be a clock function, received ${describe(now)}.`);
    }
    if (jobId !== undefined && (typeof jobId !== "string" || jobId === "")) {
      throw new JobBudgetError("invalid_options", `jobId must be a non-empty string, received ${describe(jobId)}.`);
    }
    if (depth === undefined && profile === undefined) {
      throw new JobBudgetError("invalid_depth", "A depth (1 or 2) is required to select a job budget profile.");
    }

    this.#depth = depth ?? null;
    this.#jobId = jobId ?? null;
    this.#profile = profile === undefined ? JOB_BUDGET_BY_DEPTH[depth] : requireProfile(profile, "profile");
    this.#now = now;
    this.#startedAt = this.#readClock();
  }

  get depth() {
    return this.#depth;
  }

  get jobId() {
    return this.#jobId;
  }

  get profile() {
    return this.#profile;
  }

  /** Frozen terminal record, or null while the Job is still running. */
  get terminal() {
    return this.#terminal;
  }

  /**
   * Atomically pre-charge one Model Call before dispatching it to the
   * Provider. Provider errors still consume the charge; a refused projection
   * never increments `modelCalls`.
   *
   * @returns {{ ok: true, sequence: number } | { ok: false, reason: string, terminal: object, error: object | null }}
   */
  beginModelCall() {
    const nowMs = this.#readClock();
    const wasTerminal = this.#terminal !== null;
    this.#refresh(nowMs);
    if (this.#terminal) {
      return refused(wasTerminal ? "already_terminal" : this.#terminal.error.code, this.#terminal);
    }

    const limit = this.#profile.modelCalls;
    const projected = this.#modelCalls + 1;
    if (projected > limit.hard) {
      this.#rejectedProjectedModelCalls = projected;
      this.#phase = "exhausted";
      this.#settle(
        budgetExceededTerminal({
          dimension: "model_calls",
          soft: limit.soft,
          hard: limit.hard,
          observed: this.#modelCalls,
          rejectedProjected: projected,
        }),
        nowMs,
      );
      return refused("budget_exceeded", this.#terminal);
    }

    this.#modelCalls = projected;
    this.#phase = maxPhase(this.#phase, phaseForModelCalls(projected, limit));
    return Object.freeze({ ok: true, sequence: projected });
  }

  /**
   * The one-shot soft control message, or null when the budget is still
   * normal, the message was already taken, or the Job is terminal.
   */
  takeWarning() {
    const nowMs = this.#readClock();
    this.#refresh(nowMs);
    if (this.#terminal || this.#warningTaken) return null;
    if (this.#observe(nowMs).phase === "normal") return null;
    this.#warningTaken = true;
    return BUDGET_WARNING_MESSAGE;
  }

  /** Observation point that settles Active Time and lifetime exhaustion. */
  check() {
    const nowMs = this.#readClock();
    this.#refresh(nowMs);
    return this.#view(nowMs, false);
  }

  /** Open the running window (the Job holds an execution slot). */
  startActive() {
    const nowMs = this.#readClock();
    this.#refresh(nowMs);
    const activeTimeMs = this.#activeTimeAt(nowMs);
    if (this.#terminal) {
      return refused("already_terminal", this.#terminal, { activeTimeMs });
    }
    if (this.#activeSince !== null) {
      return refused("already_running", null, { activeTimeMs });
    }
    this.#activeSince = nowMs;
    return Object.freeze({ ok: true, activeTimeMs });
  }

  /**
   * Close the running window without resetting anything. Idempotent: pausing
   * a frozen or already-paused budget reports the frozen total.
   */
  pauseActive() {
    const nowMs = this.#readClock();
    this.#refresh(nowMs);
    if (this.#terminal) {
      return Object.freeze({ ok: true, activeTimeMs: this.#accruedActiveMs });
    }
    if (this.#activeSince !== null) {
      this.#accruedActiveMs = this.#activeTimeAt(nowMs);
      this.#activeSince = null;
    }
    return Object.freeze({ ok: true, activeTimeMs: this.#accruedActiveMs });
  }

  /**
   * Settle the Job from the runtime side: `model_final` when the model
   * returned a final answer, `cancelled` for an explicit user cancel. The
   * first terminal wins; a settled budget is frozen and cannot be reopened.
   */
  terminate(options = {}) {
    if (!isPlainObject(options)) {
      throw new JobBudgetError("invalid_options", `terminate options must be an object, received ${describe(options)}.`);
    }
    checkFields(options, TERMINATE_FIELDS, "terminate options");
    const { reason } = options;
    if (!TERMINATE_REASONS.has(reason)) {
      throw new JobBudgetError(
        "invalid_options",
        `terminate reason must be "model_final" or "cancelled", received ${describe(reason)}.`,
      );
    }
    if (this.#terminal) return refused("already_terminal", this.#terminal);

    const nowMs = this.#readClock();
    this.#settle(reason === "model_final" ? completedTerminal() : cancelledTerminal(), nowMs);
    return Object.freeze({ ok: true, terminal: this.#terminal });
  }

  /**
   * Immutable usage view. Limits appear only in the detailed form; the
   * default snapshot is suitable for read-only reporting such as `hub jobs`.
   */
  snapshot(options = {}) {
    if (!isPlainObject(options)) {
      throw new JobBudgetError("invalid_options", `snapshot options must be an object, received ${describe(options)}.`);
    }
    checkFields(options, SNAPSHOT_FIELDS, "snapshot options");
    const { detail = false } = options;
    if (typeof detail !== "boolean") {
      throw new JobBudgetError("invalid_options", `snapshot detail must be a boolean, received ${describe(detail)}.`);
    }
    return this.#view(this.#readClock(), detail);
  }

  #view(nowMs, detail) {
    const observation = this.#terminal ? this.#frozenObservation() : this.#observe(nowMs);
    const view = {
      jobId: this.#jobId,
      depth: this.#depth,
      phase: observation.phase,
      modelCalls: this.#modelCalls,
      activeTimeMs: observation.activeTimeMs,
      rejectedProjectedModelCalls: this.#rejectedProjectedModelCalls,
      running: this.#activeSince !== null,
      warningTaken: this.#warningTaken,
      terminal: this.#terminal,
    };
    if (detail) {
      view.profile = this.#profile;
      view.elapsedMs = observation.elapsedMs;
    }
    return deepFreeze(view);
  }

  // Pure observation of the current instant; never mutates state.
  #observe(nowMs) {
    const elapsedMs = Math.max(0, nowMs - this.#startedAt);
    const activeTimeMs = this.#activeTimeAt(nowMs);
    let phase = maxPhase(this.#phase, phaseForModelCalls(this.#modelCalls, this.#profile.modelCalls));
    phase = maxPhase(phase, phaseForActiveTime(activeTimeMs, this.#profile.activeTimeMs));
    if (this.#rejectedProjectedModelCalls !== null || elapsedMs >= this.#profile.lifetimeMs) {
      phase = "exhausted";
    }
    return { elapsedMs, activeTimeMs, phase };
  }

  #frozenObservation() {
    return {
      elapsedMs: this.#settledElapsedMs,
      activeTimeMs: this.#accruedActiveMs,
      phase: this.#phase,
    };
  }

  // Time-based exhaustion settles here; model-call exhaustion settles at the
  // rejected pre-charge. Called before any state-changing operation.
  #refresh(nowMs) {
    if (this.#terminal) return this.#terminal;
    const observation = this.#observe(nowMs);
    this.#phase = observation.phase;

    const { lifetimeMs, activeTimeMs: activeLimit } = this.#profile;
    if (observation.elapsedMs >= lifetimeMs) {
      return this.#settle(
        lifetimeExpiredTerminal({ lifetimeMs, elapsedMs: observation.elapsedMs }),
        nowMs,
      );
    }
    if (observation.activeTimeMs >= activeLimit.hard) {
      return this.#settle(
        budgetExceededTerminal({
          dimension: "active_time",
          soft: activeLimit.soft,
          hard: activeLimit.hard,
          observed: observation.activeTimeMs,
        }),
        nowMs,
      );
    }
    return null;
  }

  #activeTimeAt(nowMs) {
    if (this.#activeSince === null) return this.#accruedActiveMs;
    return this.#accruedActiveMs + Math.max(0, nowMs - this.#activeSince);
  }

  #settle(terminal, nowMs) {
    if (this.#terminal) return this.#terminal;
    if (this.#activeSince !== null) {
      this.#accruedActiveMs = this.#activeTimeAt(nowMs);
      this.#activeSince = null;
    }
    this.#settledElapsedMs = Math.max(0, nowMs - this.#startedAt);
    this.#terminal = deepFreeze(terminal);
    return this.#terminal;
  }

  #readClock() {
    const value = this.#now();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new JobBudgetError("invalid_options", `now must return a finite timestamp, received ${describe(value)}.`);
    }
    return value;
  }
}

export function createJobBudget(options) {
  return new JobBudget(options);
}
