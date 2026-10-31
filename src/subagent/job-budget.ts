import { DEFAULT_HARNESS_CONFIG } from '../harness-config.ts';
import { promptString } from '../prompt-text.ts';

export interface BudgetLimit { readonly soft: number; readonly hard: number }
export interface BudgetProfile {
  readonly modelCalls: BudgetLimit;
  readonly activeTimeMs: BudgetLimit;
  readonly lifetimeMs: number;
}
export type BudgetPhase = 'normal' | 'warning' | 'exhausted';
export type BudgetTermination = 'model_final' | 'cancelled' | 'job_failed' | 'budget_exhausted' | 'lifetime_expired';
export interface BudgetTerminalError { readonly code: string; readonly message?: string; readonly detail?: unknown }
export interface BudgetTerminal {
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly termination: BudgetTermination;
  readonly truncated: boolean;
  readonly error: BudgetTerminalError | null;
}
export interface BudgetSnapshot {
  readonly jobId: string | null;
  readonly depth: number | null;
  readonly phase: BudgetPhase;
  readonly modelCalls: number;
  readonly activeTimeMs: number;
  readonly rejectedProjectedModelCalls: number | null;
  readonly running: boolean;
  readonly warningTaken: boolean;
  readonly terminal: BudgetTerminal | null;
}
export interface BudgetSnapshotDetail extends BudgetSnapshot { readonly profile: BudgetProfile; readonly elapsedMs: number }
export interface BudgetRefusal {
  readonly ok: false;
  readonly reason: string;
  readonly terminal: BudgetTerminal | null;
  readonly error: BudgetTerminalError | null;
}
export type BudgetChargeResult = { readonly ok: true; readonly sequence: number } | BudgetRefusal;
export type BudgetStartResult = { readonly ok: true; readonly activeTimeMs: number } | (BudgetRefusal & { readonly activeTimeMs: number });
export type BudgetTerminateResult = { readonly ok: true; readonly terminal: BudgetTerminal } | BudgetRefusal;
export interface BudgetTerminateOptions {
  readonly reason: 'model_final' | 'cancelled' | 'failed';
  readonly error?: { readonly code?: string; readonly message: string } | null;
}
export interface JobBudgetOptions {
  readonly depth?: number;
  readonly jobId?: string;
  readonly now?: () => number;
  readonly profile?: BudgetProfile;
}
/** Complete budget contract shared by the runtime and provider adapter. */
export interface JobBudgetPort {
  readonly terminal: BudgetTerminal | null;
  beginModelCall(): BudgetChargeResult;
  takeWarning(): string | null;
  check(): BudgetSnapshot;
  startActive(): BudgetStartResult;
  pauseActive(): { readonly ok: true; readonly activeTimeMs: number };
  terminate(options: BudgetTerminateOptions): BudgetTerminateResult;
  snapshot(): BudgetSnapshot;
  snapshot(options: { readonly detail: true }): BudgetSnapshotDetail;
  snapshot(options?: { readonly detail?: boolean }): BudgetSnapshot | BudgetSnapshotDetail;
}

export const BUDGET_PHASES = ['normal', 'warning', 'exhausted'] as const;
export const BUDGET_WARNING_MESSAGE: string = promptString('execution-budget.json', 'warning');
export class JobBudgetError extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'JobBudgetError';
    this.code = code;
    this.detail = detail;
  }
}
/**
 * The configured profile of one depth. The default table is only a convenience
 * for callers that construct a standalone Budget; the runtime always passes the
 * root's resolved `budgetsByDepth`.
 */
export function profileForDepth(
  depth: number,
  budgetsByDepth: Readonly<Record<number, BudgetProfile>> = DEFAULT_HARNESS_CONFIG.subagent.budgetsByDepth,
): BudgetProfile {
  const profile = budgetsByDepth[depth];
  if (!profile) throw new JobBudgetError('invalid_depth', `No budget profile is configured for depth ${depth}.`);
  return profile;
}
function validateProfile(profile: BudgetProfile): void {
  for (const [name, limit] of [['modelCalls', profile.modelCalls], ['activeTimeMs', profile.activeTimeMs]] as const) {
    if (!Number.isInteger(limit.soft) || limit.soft < 1 || !Number.isInteger(limit.hard) || limit.hard < limit.soft) {
      throw new JobBudgetError('invalid_options', `${name} requires integer limits with 1 <= soft <= hard.`);
    }
  }
  if (!Number.isInteger(profile.lifetimeMs) || profile.lifetimeMs < 1) throw new JobBudgetError('invalid_options', 'lifetimeMs must be a positive integer.');
}
function maxPhase(left: BudgetPhase, right: BudgetPhase): BudgetPhase {
  return BUDGET_PHASES.indexOf(left) >= BUDGET_PHASES.indexOf(right) ? left : right;
}
function refusal(reason: string, terminal: BudgetTerminal | null): BudgetRefusal {
  return { ok: false, reason, terminal, error: terminal?.error ?? null };
}
function exhausted(termination: 'budget_exhausted' | 'lifetime_expired', code: string, detail: unknown): BudgetTerminal {
  return { status: 'failed', termination, truncated: true, error: { code, detail } };
}

/** One Job's counters and deadlines. The first terminal decision wins. */
export class JobBudget implements JobBudgetPort {
  readonly depth: number | null;
  readonly jobId: string | null;
  readonly profile: BudgetProfile;
  readonly #now: () => number;
  readonly #startedAt: number;
  #modelCalls = 0;
  #rejectedProjectedModelCalls: number | null = null;
  #accruedActiveMs = 0;
  #activeSince: number | null = null;
  #phase: BudgetPhase = 'normal';
  #warningTaken = false;
  #terminal: BudgetTerminal | null = null;
  #settledElapsedMs = 0;

  constructor({ depth, jobId, now = () => performance.now(), profile }: JobBudgetOptions = {}) {
    if (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 1)) {
      throw new JobBudgetError('invalid_depth', `Budget depth must be a positive safe integer, received ${depth}.`);
    }
    if (profile === undefined && depth === undefined) throw new JobBudgetError('invalid_depth', 'A depth or explicit budget profile is required.');
    this.depth = depth ?? null;
    this.jobId = jobId ?? null;
    // An explicit profile is authoritative for any positive depth, including
    // depths above the default table.
    this.profile = profile ?? profileForDepth(depth!);
    validateProfile(this.profile);
    this.#now = now;
    this.#startedAt = this.#readClock();
  }
  get terminal(): BudgetTerminal | null { return this.#terminal; }

  beginModelCall(): BudgetChargeResult {
    const now = this.#readClock();
    const wasTerminal = this.#terminal !== null;
    this.#refresh(now);
    if (this.#terminal) return refusal(wasTerminal ? 'already_terminal' : this.#terminal.error!.code, this.#terminal);
    const limit = this.profile.modelCalls;
    const projected = this.#modelCalls + 1;
    if (projected > limit.hard) {
      this.#rejectedProjectedModelCalls = projected;
      this.#phase = 'exhausted';
      this.#settle(exhausted('budget_exhausted', 'budget_exceeded', {
        dimension: 'model_calls', soft: limit.soft, hard: limit.hard, observed: this.#modelCalls, rejectedProjected: projected,
      }), now);
      return refusal('budget_exceeded', this.#terminal);
    }
    this.#modelCalls = projected;
    if (projected >= limit.soft) this.#phase = maxPhase(this.#phase, 'warning');
    return { ok: true, sequence: projected };
  }
  takeWarning(): string | null {
    const now = this.#readClock();
    this.#refresh(now);
    if (this.#terminal || this.#warningTaken || this.#observe(now).phase === 'normal') return null;
    this.#warningTaken = true;
    return BUDGET_WARNING_MESSAGE;
  }
  check(): BudgetSnapshot {
    const now = this.#readClock();
    this.#refresh(now);
    return this.#view(now, false);
  }
  startActive(): BudgetStartResult {
    const now = this.#readClock();
    this.#refresh(now);
    const activeTimeMs = this.#activeTimeAt(now);
    if (this.#terminal) return { ...refusal('already_terminal', this.#terminal), activeTimeMs };
    if (this.#activeSince !== null) return { ...refusal('already_running', null), activeTimeMs };
    this.#activeSince = now;
    return { ok: true, activeTimeMs };
  }
  pauseActive(): { ok: true; activeTimeMs: number } {
    const now = this.#readClock();
    this.#refresh(now);
    if (this.#activeSince !== null) {
      this.#accruedActiveMs = this.#activeTimeAt(now);
      this.#activeSince = null;
    }
    return { ok: true, activeTimeMs: this.#accruedActiveMs };
  }
  terminate({ reason, error }: BudgetTerminateOptions): BudgetTerminateResult {
    if (this.#terminal) return refusal('already_terminal', this.#terminal);
    const terminal: BudgetTerminal = reason === 'model_final'
      ? { status: 'completed', termination: 'model_final', truncated: false, error: null }
      : reason === 'cancelled'
        ? { status: 'cancelled', termination: 'cancelled', truncated: true, error: { code: 'cancelled', message: 'Job cancelled.' } }
        : { status: 'failed', termination: 'job_failed', truncated: false,
            error: error ? { code: error.code || 'job_failed', message: error.message } : { code: 'job_failed', message: 'Job failed.' } };
    return { ok: true, terminal: this.#settle(terminal, this.#readClock()) };
  }
  snapshot(): BudgetSnapshot;
  snapshot(options: { readonly detail: true }): BudgetSnapshotDetail;
  snapshot(options?: { readonly detail?: boolean }): BudgetSnapshot | BudgetSnapshotDetail;
  snapshot({ detail = false }: { readonly detail?: boolean } = {}): BudgetSnapshot | BudgetSnapshotDetail {
    return this.#view(this.#readClock(), detail);
  }
  #view(now: number, detail: boolean): BudgetSnapshot | BudgetSnapshotDetail {
    const observation = this.#terminal
      ? { phase: this.#phase, elapsedMs: this.#settledElapsedMs, activeTimeMs: this.#accruedActiveMs }
      : this.#observe(now);
    const view: BudgetSnapshot = {
      jobId: this.jobId, depth: this.depth, phase: observation.phase, modelCalls: this.#modelCalls,
      activeTimeMs: observation.activeTimeMs, rejectedProjectedModelCalls: this.#rejectedProjectedModelCalls,
      running: this.#activeSince !== null, warningTaken: this.#warningTaken, terminal: this.#terminal,
    };
    return detail ? { ...view, profile: this.profile, elapsedMs: observation.elapsedMs } : view;
  }
  #observe(now: number): { phase: BudgetPhase; elapsedMs: number; activeTimeMs: number } {
    const elapsedMs = Math.max(0, now - this.#startedAt);
    const activeTimeMs = this.#activeTimeAt(now);
    let phase = this.#phase;
    if (this.#modelCalls >= this.profile.modelCalls.soft || activeTimeMs >= this.profile.activeTimeMs.soft) phase = maxPhase(phase, 'warning');
    if (this.#rejectedProjectedModelCalls !== null || elapsedMs >= this.profile.lifetimeMs || activeTimeMs >= this.profile.activeTimeMs.hard) phase = 'exhausted';
    return { elapsedMs, activeTimeMs, phase };
  }
  #refresh(now: number): void {
    if (this.#terminal) return;
    const state = this.#observe(now);
    this.#phase = state.phase;
    if (state.elapsedMs >= this.profile.lifetimeMs) {
      this.#settle(exhausted('lifetime_expired', 'job_expired', { lifetimeMs: this.profile.lifetimeMs, elapsedMs: state.elapsedMs }), now);
    } else if (state.activeTimeMs >= this.profile.activeTimeMs.hard) {
      const limit = this.profile.activeTimeMs;
      this.#settle(exhausted('budget_exhausted', 'budget_exceeded', { dimension: 'active_time', soft: limit.soft, hard: limit.hard, observed: state.activeTimeMs }), now);
    }
  }
  #activeTimeAt(now: number): number {
    return this.#accruedActiveMs + (this.#activeSince === null ? 0 : Math.max(0, now - this.#activeSince));
  }
  #settle(terminal: BudgetTerminal, now: number): BudgetTerminal {
    if (this.#terminal) return this.#terminal;
    this.#accruedActiveMs = this.#activeTimeAt(now);
    this.#activeSince = null;
    this.#settledElapsedMs = Math.max(0, now - this.#startedAt);
    this.#terminal = terminal;
    return terminal;
  }
  #readClock(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) throw new JobBudgetError('invalid_options', 'The budget clock must return a finite timestamp.');
    return value;
  }
}
export function createJobBudget(options: JobBudgetOptions): JobBudget { return new JobBudget(options); }
