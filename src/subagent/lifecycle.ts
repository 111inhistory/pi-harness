/**
 * Pure lifecycle decisions shared by the Subagent runtime and its host adapter.
 *
 * This module intentionally owns no SDK object, timer, socket or registry entry.
 * It answers the questions both sides must answer the same way:
 *
 * - Which reason wins when several terminal transitions become visible?
 * - When is a service generation allowed to finish retirement?
 * - What does one terminal notification say about its Job and execution round?
 */

export type TerminalStatus = "completed" | "failed" | "cancelled";

export interface LifecycleError {
  code: string;
  message: string;
  detail?: unknown;
}

export interface StoppingReason {
  status: TerminalStatus;
  error: LifecycleError | null;
}

export interface TerminalDecisionInput {
  /** Reason recorded when the Job first entered `stopping`, if it did. */
  stopping: StoppingReason | null;
  /** Public Budget failure, or null when the Budget has not failed. */
  budgetError: LifecycleError | null;
  /** Normalized execution error reported by the adapter. */
  executionError: LifecycleError | null;
  /** Status reported by the adapter, if any. */
  executionStatus: string | null;
}

export interface TerminalDecision {
  status: TerminalStatus;
  error: LifecycleError | null;
}

/**
 * Preserve the first effective stopping reason.
 *
 * A later observation must not rewrite why a Job is stopping. Cancellation
 * before a Budget failure therefore stays a cancellation; a Budget failure
 * observed while the Job is still running stays the recorded failure reason.
 */
export function firstEffectiveStopping(
  current: StoppingReason | null,
  next: StoppingReason,
): StoppingReason {
  return current ?? next;
}

/**
 * Freeze the one terminal status and error of a Job.
 *
 * Ordering is part of the contract:
 *
 * 1. A recorded stopping reason wins: it was decided while the native run was
 *    still alive and must survive that run's eventual return value.
 * 2. Otherwise a failed Budget wins over the adapter's own payload.
 * 3. Otherwise the adapter's failed/cancelled report decides.
 * 4. Otherwise the Job completed.
 */
export function adjudicateTerminal(input: TerminalDecisionInput): TerminalDecision {
  if (input.stopping !== null) {
    return { status: input.stopping.status, error: input.stopping.error };
  }
  if (input.budgetError !== null) {
    return { status: "failed", error: input.budgetError };
  }
  if (input.executionError !== null) {
    return { status: "failed", error: input.executionError };
  }
  if (input.executionStatus === "failed") {
    return { status: "failed", error: null };
  }
  if (input.executionStatus === "cancelled") {
    return { status: "cancelled", error: { code: "cancelled", message: "Job cancelled." } };
  }
  return { status: "completed", error: null };
}

export interface TerminalNotificationInput {
  agentId: string;
  jobId: string;
  round: number;
  name?: string | null;
  status: TerminalStatus;
  content: string;
  error?: LifecycleError | null;
  history: unknown;
}

export interface TerminalNotification {
  type: "notification";
  from: string;
  subagentId: string;
  jobId: string;
  round: number;
  name?: string | null;
  status: TerminalStatus;
  content: string;
  error: string | null;
  history: unknown;
}

/**
 * Build the host-owned terminal envelope.
 *
 * `from`, `jobId` and `round` are what let one delivery coordinator merge an
 * undelivered message with the terminal event of the same sender and execution
 * round, without inventing a second wake or cancel state.
 */
export function terminalNotification(input: TerminalNotificationInput): TerminalNotification {
  const notification: TerminalNotification = {
    type: "notification",
    from: input.agentId,
    subagentId: input.agentId,
    jobId: input.jobId,
    round: input.round,
    status: input.status,
    content: input.content,
    error: input.error === null || input.error === undefined ? null : input.error.message,
    history: input.history,
  };
  if (input.name !== undefined) notification.name = input.name;
  return notification;
}

export interface RetirableService {
  active?: boolean;
  closed?: boolean;
}

export interface ServiceLifecycleAdapter<TService extends RetirableService> {
  /** Must resolve only after the native resources really stopped. */
  retire(service: TService): void | Promise<void>;
  retirementTimeoutMs?: number;
}

export class ServiceRetirementTimeoutError extends Error {
  readonly code = 'service_retirement_timeout';
  readonly generation: number;
  constructor(generation: number) {
    super(`Service generation ${generation} did not quiesce before its retirement deadline; resources remain fenced.`);
    this.name = 'ServiceRetirementTimeoutError';
    this.generation = generation;
  }
}

interface Retirement<TService> {
  readonly service: TService;
  readonly report: Promise<void>;
  failure: unknown;
}

/**
 * Per-service activation and retirement.
 *
 * A completed retirement is forgotten, so the next branch/session switch
 * retires the service that is current then. Retirement is idempotent while in
 * flight, but identity checks keep a stale generation from clearing a newer
 * retirement record.
 */
export class ServiceLifecycle<TService extends RetirableService> {
  #service: TService | null = null;
  #retirement: Retirement<TService> | null = null;
  #activation: Promise<TService> | null = null;
  #generation = 0;
  /** Bumped by every explicit retire; an older activation may not publish. */
  #invalidation = 0;
  readonly #adapter: ServiceLifecycleAdapter<TService>;
  readonly #retirementTimeoutMs: number;

  constructor(adapter: ServiceLifecycleAdapter<TService>) {
    this.#adapter = adapter;
    this.#retirementTimeoutMs = adapter.retirementTimeoutMs ?? 5000;
    if (!Number.isFinite(this.#retirementTimeoutMs) || this.#retirementTimeoutMs <= 0) {
      throw new RangeError('retirementTimeoutMs must be a positive finite number.');
    }
  }

  get service(): TService | null {
    return this.#service;
  }

  get generation(): number {
    return this.#generation;
  }

  get retiring(): boolean {
    return this.#retirement !== null;
  }

  /** A failed/timed-out retire stays fenced until real quiescence is known. */
  get retirementFailure(): unknown {
    return this.#retirement?.failure ?? null;
  }

  /** Current service, or a new one after retiring the previous generation. */
  async current(create: (generation: number) => Promise<TService>): Promise<TService> {
    const service = this.#service;
    if (service !== null && service.active !== false) return service;
    return this.activate(create);
  }

  /**
   * Build the next service generation. Concurrent callers share one activation,
   * and the previous generation is fully retired before the replacement is
   * exposed.
   *
   * An explicit retirement that lands while `create` is still awaiting
   * invalidates this activation. The newly created service is retired before
   * the activation rejects, so it can never become current after shutdown.
   */
  activate(create: (generation: number) => Promise<TService>): Promise<TService> {
    const inFlight = this.#activation;
    if (inFlight !== null) return inFlight;

    const invalidationBefore = this.#invalidation;
    const run = (async (): Promise<TService> => {
      // This is the transition's own cleanup, not an external retirement, so
      // it must neither invalidate the new generation nor await itself.
      await this.#retireCurrent();
      if (this.#invalidation !== invalidationBefore) {
        throw activationRetiredError();
      }
      const generation = this.#generation + 1;
      const service = await create(generation);
      if (this.#invalidation !== invalidationBefore) {
        // The caller may have shut down while creation was in flight. Clean up
        // what was created and never publish it as the current service.
        await this.#beginRetirement(service, generation);
        throw activationRetiredError();
      }
      this.#generation = generation;
      this.#service = service;
      return service;
    })();
    let tracked: Promise<TService>;
    tracked = run.finally(() => {
      if (this.#activation === tracked) this.#activation = null;
    });
    this.#activation = tracked;
    return tracked;
  }

  /**
   * Retire the current generation, or only `target` when it is still current.
   *
   * Passing a service is how a callback proves it speaks for the generation it
   * captured: a stale callback cannot retire its successor.
   *
   * A retirement without a target invalidates any in-flight activation and
   * waits for its creation cleanup, then retires a service that was published
   * just before the call. A later activation is allowed to build a new service.
   */
  retire(target?: TService): Promise<void> {
    if (target !== undefined) {
      if (target === this.#service) return this.#retireCurrent();
      return target === this.#retirement?.service ? this.#retirement.report : Promise.resolve();
    }

    this.#invalidation += 1;
    const activation = this.#activation;
    if (activation !== null) {
      return (async (): Promise<void> => {
        try {
          await activation;
        } catch {
          // An invalidated activation rejects after cleaning up its service.
        }
        await this.#retireCurrent();
      })();
    }
    return this.#retireCurrent();
  }

  #retireCurrent(): Promise<void> {
    if (this.#retirement !== null) return this.#retirement.report;
    const service = this.#service;
    if (service === null) return Promise.resolve();
    this.#service = null;
    return this.#beginRetirement(service, this.#generation);
  }

  #beginRetirement(service: TService, generation: number): Promise<void> {
    // The public deadline is not the resource lifetime. A timeout rejects the
    // caller but never removes the fence or disposes a still-running session.
    let resolveReport!: () => void;
    let rejectReport!: (error: unknown) => void;
    const report = new Promise<void>((resolve, reject) => {
      resolveReport = resolve;
      rejectReport = reject;
    });
    const retirement: Retirement<TService> = { service, report, failure: null };
    this.#retirement = retirement;
    const timer = setTimeout(() => {
      const error = new ServiceRetirementTimeoutError(generation);
      retirement.failure = error;
      rejectReport(error);
    }, this.#retirementTimeoutMs);
    // Deferring the adapter also captures a synchronous throw. Both completion
    // paths are observed, even if the public report already timed out.
    void Promise.resolve().then(() => this.#adapter.retire(service)).then(() => {
      clearTimeout(timer);
      if (this.#retirement === retirement) this.#retirement = null;
      resolveReport();
    }, (error: unknown) => {
      clearTimeout(timer);
      retirement.failure = error;
      // Rejection does not prove native exit. Keep this generation fenced.
      rejectReport(error);
    });
    return report;
  }
}

function activationRetiredError(): Error {
  const error = new Error("Service activation was retired before it became current.");
  error.name = "ServiceRetiredError";
  return error;
}

export type QueueMode = "all" | "one-at-a-time";

/**
 * The public queue surface shared by Pi's Agent and AgentSession.
 *
 * `peekQueuedMessages()` intentionally returns only the next batch in the
 * configured mode. Reading both queues losslessly therefore needs a temporary
 * probe: with both modes set to `all`, a probe in one queue makes that queue
 * selected, so every original message in it can be read before clearing it.
 */
export interface QueueCapable {
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  steer(message: unknown): void;
  followUp(message: unknown): void;
  peekQueuedMessages(): unknown[];
  clearSteeringQueue(): void;
  clearFollowUpQueue(): void;
}

/**
 * Read and clear every queued steering and follow-up message, preserving order
 * within each queue. The probe messages are removed by identity, so arbitrary
 * custom-message content (including text that looks like a probe) is untouched.
 *
 * Modes are restored even if a queue operation throws. The caller remains
 * responsible for clearing any AgentSession text mirrors after the Agent queues
 * are empty.
 */
export function takeQueuedMessages(
  agent: QueueCapable,
  createProbe: (queue: "steering" | "followUp") => unknown,
): unknown[] {
  const steeringMode = agent.steeringMode;
  const followUpMode = agent.followUpMode;
  try {
    agent.steeringMode = "all";
    agent.followUpMode = "all";

    const steeringProbe = createProbe("steering");
    agent.steer(steeringProbe);
    const steering = agent.peekQueuedMessages().filter((message) => message !== steeringProbe);
    agent.clearSteeringQueue();

    const followUpProbe = createProbe("followUp");
    agent.followUp(followUpProbe);
    const followUp = agent.peekQueuedMessages().filter((message) => message !== followUpProbe);
    agent.clearFollowUpQueue();

    return [...steering, ...followUp];
  } finally {
    agent.steeringMode = steeringMode;
    agent.followUpMode = followUpMode;
  }
}
