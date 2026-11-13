/** Own activation generations and retirement fences independently of Job state. */
export interface ServiceLifecycleAdapter<TService> {
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

interface Retirement {
  readonly report: Promise<void>;
}

/**
 * Per-service activation and retirement.
 *
 * A completed retirement is forgotten, so the next branch/session switch
 * retires the service that is current then. Retirement is idempotent while in
 * flight, but identity checks keep a stale generation from clearing a newer
 * retirement record.
 */
export class ServiceLifecycle<TService> {
  #service: TService | null = null;
  #retirement: Retirement | null = null;
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

  get retiring(): boolean {
    return this.#retirement !== null;
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

  /** Invalidate pending activation, then retire the current service and its resources. */
  retire(): Promise<void> {
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
    const retirement: Retirement = { report };
    this.#retirement = retirement;
    const timer = setTimeout(() => {
      const error = new ServiceRetirementTimeoutError(generation);
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
