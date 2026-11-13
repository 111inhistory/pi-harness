import type {
  ShellApprovalController,
  ShellApprovalDecision,
  ShellApprovalPending,
  ShellApprovalRequest,
  ShellApprovalRespondResult,
  ShellApprovalResult,
  ShellApprovalSnapshot,
} from './types.ts';

const DEFAULT_TIMEOUT_SECONDS = 30;

let nextApprovalId = 1;

export interface ManualApprovalControllerOptions {
  readonly defaultTimeoutSeconds?: number | undefined;
  /**
   * Composition-level sink check. The approval domain itself has no notion of
   * TUI or RPC; the host supplies whichever adapter can actually present.
   */
  readonly canPresent?: (() => boolean) | undefined;
}

interface PendingEntry {
  readonly id: string;
  readonly request: ShellApprovalRequest;
  readonly timeoutSeconds: number;
  readonly requestedAt: number;
  readonly resolve: (result: ShellApprovalResult) => void;
  removeAbortListener: () => void;
  state: 'queued' | 'active';
  expiresAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

/**
 * Root-lifetime manual approval state.
 *
 * Requests are serialized so terminal adapters can show one permission dialog
 * at a time; the active request owns the timeout. Adapters may answer any
 * queued or active request through `respond`, and the first accepted answer
 * wins. Abort and disposal clear the timer, abort listeners and pending
 * promises before the next root generation can reuse them.
 */
export class ManualApprovalController implements ShellApprovalController {
  readonly #defaultTimeoutSeconds: number;
  readonly #canPresent: (() => boolean) | undefined;
  readonly #listeners = new Map<(snapshot: ShellApprovalSnapshot) => void, boolean>();
  readonly #queue: PendingEntry[] = [];
  #active: PendingEntry | null = null;
  #disposed = false;

  constructor(options?: ManualApprovalControllerOptions) {
    this.#defaultTimeoutSeconds = Math.max(
      1,
      Math.floor(options?.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS),
    );
    this.#canPresent = options?.canPresent;
  }

  request(request: ShellApprovalRequest): Promise<ShellApprovalResult> {
    if (this.#disposed) return Promise.resolve({ approved: false, reason: 'disposed' });
    if (request.signal?.aborted) return Promise.resolve({ approved: false, reason: 'cancelled' });
    if (!this.#canPresent?.() && ![...this.#listeners.values()].some(Boolean)) {
      return Promise.resolve({ approved: false, reason: 'no_ui' });
    }

    const timeoutSeconds = Math.max(
      1,
      Math.floor(request.timeoutSeconds ?? this.#defaultTimeoutSeconds),
    );
    return new Promise<ShellApprovalResult>((resolve) => {
      const entry: PendingEntry = {
        id: `approval-${nextApprovalId++}`,
        request,
        timeoutSeconds,
        requestedAt: Date.now(),
        resolve,
        removeAbortListener: () => {},
        state: 'queued',
        expiresAt: null,
        timer: null,
        settled: false,
      };

      const onAbort = () => {
        this.#settle(entry, { approved: false, reason: 'cancelled' });
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      entry.removeAbortListener = () => {
        request.signal?.removeEventListener('abort', onAbort);
      };

      this.#queue.push(entry);
      this.#promote();
      this.#publish();
    });
  }

  list(): ShellApprovalSnapshot {
    const entries = this.#active === null ? this.#queue : [this.#active, ...this.#queue];
    return entries.filter((entry) => !entry.settled).map((entry) => snapshotOf(entry));
  }

  get(id: string): ShellApprovalPending | undefined {
    const entry = this.#entry(id);
    return entry === undefined ? undefined : snapshotOf(entry);
  }

  respond(id: string, decision: ShellApprovalDecision): ShellApprovalRespondResult {
    if (this.#disposed) return { accepted: false, reason: 'disposed' };
    if (decision !== 'allow' && decision !== 'deny') {
      return { accepted: false, reason: 'invalid_decision' };
    }
    const entry = this.#entry(id);
    if (entry === undefined) return { accepted: false, reason: 'not_pending' };
    // Timer delivery may be delayed; an elapsed deadline cannot be approved.
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.#settle(entry, { approved: false, reason: 'timeout' });
      return { accepted: false, reason: 'not_pending' };
    }

    this.#settle(entry, {
      approved: decision === 'allow',
      reason: decision === 'allow' ? 'approved' : 'rejected',
    });
    return { accepted: true, decision };
  }

  subscribe(listener: (snapshot: ShellApprovalSnapshot) => void, options?: { readonly consumer?: boolean }): () => void {
    if (this.#disposed) { listener([]); return () => {}; }
    this.#listeners.set(listener, options?.consumer !== false);
    try { listener(this.list()); } catch (error) { this.#listeners.delete(listener); throw error; }
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    const pending = this.#active === null ? [...this.#queue] : [this.#active, ...this.#queue];
    this.#active = null;
    this.#queue.length = 0;
    for (const entry of pending) {
      this.#finalize(entry, { approved: false, reason: 'disposed' });
    }
    this.#publish();
    this.#listeners.clear();
  }

  #entry(id: string): PendingEntry | undefined {
    if (this.#active?.id === id) return this.#active;
    return this.#queue.find((entry) => entry.id === id && !entry.settled);
  }

  #promote(): void {
    if (this.#disposed || this.#active !== null) return;
    while (this.#queue.length > 0) {
      const next = this.#queue.shift()!;
      if (next.settled) continue;
      if (next.request.signal?.aborted) {
        this.#finalize(next, { approved: false, reason: 'cancelled' });
        continue;
      }

      next.state = 'active';
      next.expiresAt = Date.now() + next.timeoutSeconds * 1000;
      next.timer = setTimeout(() => {
        this.#settle(next, { approved: false, reason: 'timeout' });
      }, next.timeoutSeconds * 1000);
      next.timer.unref();
      this.#active = next;
      return;
    }
  }

  #settle(entry: PendingEntry, result: ShellApprovalResult): void {
    if (entry.settled || this.#disposed) return;
    this.#finalize(entry, result);
    this.#promote();
    this.#publish();
  }

  #finalize(entry: PendingEntry, result: ShellApprovalResult): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.removeAbortListener();
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (this.#active === entry) {
      this.#active = null;
    } else {
      const index = this.#queue.indexOf(entry);
      if (index !== -1) this.#queue.splice(index, 1);
    }
    entry.resolve(result);
  }

  #publish(): void {
    const snapshot = this.list();
    for (const listener of [...this.#listeners.keys()]) {
      try {
        listener(snapshot);
      } catch {
        /* A broken presentation adapter must not change the approval outcome. */
      }
    }
  }
}

function snapshotOf(entry: PendingEntry): ShellApprovalPending {
  const { request } = entry;
  return {
    id: entry.id,
    sourceAgent: request.sourceAgent,
    shell: request.shell,
    cwd: request.cwd,
    command: request.command,
    reason: request.reason ?? null,
    state: entry.state,
    timeoutSeconds: entry.timeoutSeconds,
    requestedAt: entry.requestedAt,
    expiresAt: entry.expiresAt,
  };
}
