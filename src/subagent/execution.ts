import { createAgentSession } from '@earendil-works/pi-coding-agent';
import type {
  AgentSession,
  CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';

/** The lifetime operations shared by delegated and internal retrieval sessions. */
export interface ExecutionSession {
  readonly isIdle: boolean;
  prompt: AgentSession['prompt'];
  steer: AgentSession['steer'];
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

type Cleanup = () => void | Promise<void>;

/** Owns a session immediately, including failures after asynchronous creation. */
export class SubagentExecution<S extends ExecutionSession = AgentSession> {
  readonly session: S;
  readonly #signal: AbortSignal | undefined;
  readonly #cleanups: Cleanup[] = [];
  readonly #onAbort: () => void;
  #closed = false;
  #disposal: Promise<void> | undefined;
  #abort: Promise<void> | undefined;
  #abortFailure: unknown;

  constructor(session: S, signal?: AbortSignal) {
    this.session = session;
    this.#signal = signal;
    this.#onAbort = () => {
      void this.abort().catch((error: unknown) => { this.#abortFailure = error; });
    };
    signal?.addEventListener('abort', this.#onAbort, { once: true });
    if (signal?.aborted) this.#onAbort();
  }

  async prompt(...args: Parameters<AgentSession['prompt']>): Promise<void> {
    this.#assertOpen();
    await this.session.prompt(...args);
  }

  async steer(...args: Parameters<AgentSession['steer']>): ReturnType<AgentSession['steer']> {
    this.#assertOpen();
    return this.session.steer(...args);
  }

  addCleanup(cleanup: Cleanup): void {
    if (this.#closed) throw new Error('Cannot register cleanup on a closed Subagent execution');
    this.#cleanups.push(cleanup);
  }

  abort(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    if (this.#abort) return this.#abort;
    const operation = this.session.abort();
    this.#abort = operation;
    void operation.then(
      () => { if (this.#abort === operation) this.#abort = undefined; },
      () => { if (this.#abort === operation) this.#abort = undefined; },
    );
    return operation;
  }

  /** Close once; every cleanup still runs if a preceding cleanup fails. */
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#closed = true;
    this.#signal?.removeEventListener('abort', this.#onAbort);
    this.#disposal = Promise.resolve().then(() => this.#dispose());
    return this.#disposal;
  }

  async #dispose(): Promise<void> {
    const failures: unknown[] = [];
    const attempt = async (operation: Cleanup): Promise<void> => {
      try { await operation(); } catch (error) { failures.push(error); }
    };
    if (this.#abort) await attempt(() => this.#abort);
    else if (!this.session.isIdle) await attempt(() => this.session.abort());
    await attempt(() => this.session.waitForIdle());
    for (const cleanup of this.#cleanups.splice(0).reverse()) await attempt(cleanup);
    await attempt(() => this.session.dispose());
    if (this.#abortFailure !== undefined) failures.push(this.#abortFailure);
    if (failures.length) throw new AggregateError(failures, 'Subagent execution cleanup failed');
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Subagent execution is closed');
    if (this.#signal?.aborted) throw new DOMException('Subagent execution was aborted', 'AbortError');
  }
}

/** Both public Subagents and Capability retrieval use this entry point. */
export async function openSubagentExecution(
  options: CreateAgentSessionOptions,
  controls: { signal?: AbortSignal } = {},
): Promise<SubagentExecution> {
  const { session } = await createAgentSession(options);
  const execution = new SubagentExecution(session, controls.signal);
  if (controls.signal?.aborted) {
    await execution.dispose();
    throw new DOMException('Subagent execution was aborted during session creation', 'AbortError');
  }
  return execution;
}
