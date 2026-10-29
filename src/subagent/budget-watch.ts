/**
 * Deadline watching for both Budget owners.
 *
 * The wall-clock part is identical everywhere: while the Budget is not
 * terminal, look again at the earliest of the lifetime lease and the Active
 * Time hard limit, using an unref'd timer so a pending watch never holds the
 * process open, and clear that timer when the owner releases the watch.
 *
 * The domain policies stay separate:
 *
 * - Subagent: the runtime is the observation point (`request.checkBudget`).
 *   Its verdict, including the stopping transition a failed Budget triggers,
 *   decides what happens; this watcher only schedules the next look and stops
 *   on any terminal verdict.
 * - Capability discovery: the engine asks the Budget directly (`budget.check`)
 *   and aborts its own internal session only when the terminal status is
 *   `failed`; a completed or cancelled budget merely ends the watch.
 *
 * The two exported wrappers are deliberately policy-specific rather than a
 * generic session engine.
 */

/** The minimal profile surface needed to compute the next deadline. */
export interface BudgetDeadlineLimit {
  readonly hard: number;
}

export interface BudgetDeadlineProfile {
  readonly activeTimeMs: BudgetDeadlineLimit;
  readonly lifetimeMs: number;
}

export interface BudgetDeadlineSnapshot {
  readonly profile: BudgetDeadlineProfile;
  readonly elapsedMs: number;
  readonly activeTimeMs: number;
  readonly running: boolean;
}

export interface BudgetDeadlineSource {
  snapshot(options: { readonly detail: true }): BudgetDeadlineSnapshot;
}

export interface BudgetTerminalView {
  readonly status: string;
  readonly error?: {
    readonly code?: string;
    readonly detail?: unknown;
  } | null;
}

/** The observation both policies need from their own Budget entry point. */
export interface BudgetObservation {
  readonly terminal: BudgetTerminalView | null;
}

/** Capability checks its own internal Budget directly. */
export interface CapabilityBudgetWatch extends BudgetDeadlineSource {
  check(): BudgetObservation;
}

export type SubagentBudgetCheck = () => BudgetObservation;

/**
 * Earliest wall-clock bound that can expire: the absolute lifetime lease or,
 * while the Job holds a running window, the remaining Active Time.
 */
function nextDeadlineMs(detail: BudgetDeadlineSnapshot): number {
  const lifetimeRemaining = detail.profile.lifetimeMs - detail.elapsedMs;
  const activeRemaining = detail.running
    ? detail.profile.activeTimeMs.hard - detail.activeTimeMs
    : Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(lifetimeRemaining, activeRemaining));
}

function watchBudgetDeadline(
  budget: BudgetDeadlineSource,
  observe: () => BudgetObservation,
  onFailedTerminal: ((terminal: BudgetTerminalView) => void) | null,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = (): void => {
    if (stopped) return;
    const state = observe();
    if (state.terminal !== null) {
      if (state.terminal.status === "failed") onFailedTerminal?.(state.terminal);
      return;
    }
    timer = setTimeout(schedule, nextDeadlineMs(budget.snapshot({ detail: true })));
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/**
 * Subagent policy: schedule from the wall-clock bounds, but take the verdict
 * from the runtime. A terminal verdict ends the watch; the runtime owns the
 * stopping transition for a failed Budget.
 */
export function watchSubagentBudget(
  budget: BudgetDeadlineSource,
  checkBudget: SubagentBudgetCheck,
): () => void {
  return watchBudgetDeadline(budget, checkBudget, null);
}

/**
 * Capability policy: check the run's own Budget and abort only on a failed
 * terminal. Completed or cancelled budgets end the watch without aborting.
 */
export function watchCapabilityBudget(
  budget: CapabilityBudgetWatch,
  onExpire: (terminal: BudgetTerminalView) => void,
): () => void {
  return watchBudgetDeadline(budget, () => budget.check(), onExpire);
}
