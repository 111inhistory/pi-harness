/** Own in-flight retrieval lifetimes for one Capability surface. */
export class CapabilityManager {
  readonly #runs = new Set<AbortController>();
  #closed = false;

  /** Keep ownership until the operation has finished its session cleanup. */
  async run<T>(signals: readonly (AbortSignal | undefined)[], operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.#runs.add(controller);
    for (const signal of signals) {
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    }
    if (this.#closed) abort();
    try { return await operation(controller.signal); }
    finally {
      for (const signal of signals) signal?.removeEventListener('abort', abort);
      this.#runs.delete(controller);
    }
  }

  invalidate(): void {
    for (const controller of this.#runs) controller.abort();
  }

  dispose(): void {
    this.#closed = true;
    this.invalidate();
  }
}
