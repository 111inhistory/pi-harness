import { stateRoot, taskDirectory } from './task-path.ts';
import { samePath } from '../fs-path.ts';
import { randomBytes } from 'node:crypto';
import { AsyncShellError } from './errors.ts';
import { validateAsyncShellFrame, type ShellResult } from './protocol.ts';
import { runJobCommand } from './job-command.ts';

interface OwnedTask {
  readonly directory: string;
  readonly startedAt: number;
  readonly pty: boolean;
  status: 'running' | 'internal_error';
  stopping?: { cancelled?: ShellResult };
  inputTail?: Promise<void>;
}

export type JobInput = { readonly text: string; readonly enter: boolean } | { readonly key: string };

interface Owner {
  readonly token: string;
  readonly tasks: Map<string, OwnedTask>;
  readonly launches: Map<string, { pty: boolean; abort: (directory: string) => void }>;
  retiring: boolean;
  release: Promise<void> | null;
}

export interface AsyncShellHostOptions {
  /**
   * The root's single external address. Shell callbacks reach it and name their
   * owning Actor in the frame; there is no per-Actor endpoint.
   */
  mainAddress(): string;
  accepting(): boolean;
  deliver(actorId: string, result: ShellResult): Promise<void>;
  wake(actorId: string): void;
  cancel(directory: string, root: string): Promise<void>;
}

/** One root owns execution leases; a shell result never impersonates an Agent. */
export class AsyncShellHost {
  readonly #options: AsyncShellHostOptions;
  readonly #owners = new Map<string, Owner>();
  readonly #root = stateRoot();
  #closed = false;

  constructor(options: AsyncShellHostOptions) { this.#options = options; }

  environment(actorId: string): NodeJS.ProcessEnv {
    if (this.#closed || !this.#options.accepting()) throw new Error('The async shell host is retiring.');
    let owner = this.#owners.get(actorId);
    if (owner === undefined) {
      owner = { token: randomBytes(24).toString('hex'), tasks: new Map(), launches: new Map(), retiring: false, release: null };
      this.#owners.set(actorId, owner);
    }
    if (owner.retiring) throw new Error('The previous async shell execution is still retiring.');
    return {
      PI_AGENT_ID: actorId,
      PI_AGENT_SOCKET: this.#options.mainAddress(),
      PI_ASYNC_SHELL_TOKEN: owner.token,
      PI_ASYNC_SHELL_ROOT: this.#root,
    };
  }

  hasPending(actorId: string): boolean {
    for (const task of this.#owners.get(actorId)?.tasks.values() ?? []) {
      if (task.status === 'running') return true;
    }
    return false;
  }

  /** Correlate registration with the admitted launch without exposing its lease. */
  async start(actorId: string, pty: boolean, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<ShellResult> {
    signal?.throwIfAborted();
    const owner = this.#owners.get(actorId);
    if (this.#closed || !this.#options.accepting() || !owner || owner.retiring || owner.token !== env.PI_ASYNC_SHELL_TOKEN) {
      throw new AsyncShellError('execution_rejected', 'The approved Job execution lease is no longer active.');
    }
    const callId = randomBytes(24).toString('hex');
    let directory: string | undefined;
    let cancellation: Promise<void> | undefined;
    const abort = (): void => {
      if (directory === undefined || cancellation !== undefined || owner.retiring) return;
      // The native startup gate prevents cancellation from releasing an
      // unbound task that the create process could still start afterwards.
      cancellation = this.#options.cancel(directory, this.#root);
      void cancellation.catch(() => {});
    };
    owner.launches.set(callId, { pty, abort: registered => {
      directory = registered;
      if (signal?.aborted) queueMicrotask(abort);
    } });
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await runJobCommand(['create', ...args], { cwd, env: { ...env, PI_ASYNC_SHELL_CALL_ID: callId } });
      return result;
    } finally {
      signal?.removeEventListener('abort', abort);
      owner.launches.delete(callId);
      await cancellation;
      signal?.throwIfAborted();
    }
  }

  #requireTask(actorId: string, id: string): OwnedTask {
    const owner = this.#owners.get(actorId);
    const task = owner?.tasks.get(id);
    if (!this.#closed && this.#options.accepting() && owner && !owner.retiring && task) return task;
    throw new AsyncShellError('execution_rejected', 'This execution does not own that Job.');
  }

  async stop(actorId: string, id: string, cwd: string): Promise<ShellResult> {
    const task = this.#requireTask(actorId, id);
    if (task.stopping) throw new AsyncShellError('execution_rejected', 'The Job is already stopping.');
    const stop: NonNullable<OwnedTask['stopping']> = {};
    task.stopping = stop;
    let reportedCancellation = false;
    try {
      const result = await runJobCommand(['cancel', id], { cwd, env: { ...process.env, PI_ASYNC_SHELL_ROOT: this.#root } });
      reportedCancellation = result.status === 'cancelled';
      return reportedCancellation ? stop.cancelled ?? result : result;
    } finally {
      delete task.stopping;
      if (stop.cancelled) {
        try {
          if (!reportedCancellation && !this.#closed && this.#options.accepting() && !this.#owners.get(actorId)?.retiring) {
            await this.#options.deliver(actorId, stop.cancelled);
          }
        } finally {
          this.#owners.get(actorId)?.tasks.delete(id);
          this.#options.wake(actorId);
        }
      }
    }
  }

  async input(actorId: string, id: string, input: JobInput, cwd: string, signal: AbortSignal | undefined, approve: () => Promise<void>): Promise<void> {
    const task = this.#requireTask(actorId, id);
    const assertWritable = (): void => {
      signal?.throwIfAborted();
      if (this.#requireTask(actorId, id) !== task || !task.pty || task.status !== 'running' || task.stopping) {
        throw new AsyncShellError('execution_rejected', 'The Job is not accepting terminal input.');
      }
    };
    assertWritable();
    await approve();
    assertWritable();
    // Native load, paste and Enter are separate; serialize the entire input.
    const pending = (task.inputTail ?? Promise.resolve()).then(async () => {
      assertWritable();
      const env = { ...process.env, PI_ASYNC_SHELL_ROOT: this.#root };
      if ('key' in input) await runJobCommand(['key', id, input.key], { cwd, env });
      else await runJobCommand(['send', id, ...(input.enter ? ['--enter'] : [])], { cwd, env, input: input.text });
    });
    const tail = pending.then(() => {}, () => {});
    task.inputTail = tail;
    try { await pending; }
    finally { if (task.inputTail === tail) delete task.inputTail; }
  }

  /** Running tasks of one Actor, for the live status projection. */
  pending(actorId: string): { readonly since: number; readonly tasks: number } | null {
    let since: number | null = null;
    let tasks = 0;
    for (const task of this.#owners.get(actorId)?.tasks.values() ?? []) {
      if (task.status !== 'running') continue;
      tasks += 1;
      if (since === null || task.startedAt < since) since = task.startedAt;
    }
    return since === null ? null : { since, tasks };
  }

  async receive(actorId: string, input: unknown): Promise<void> {
    const frame = validateAsyncShellFrame(input);
    // Routing already selected the owner; a frame naming another Actor was
    // mis-routed and is refused instead of being applied to the wrong lease.
    if (frame.agentId !== actorId) throw new AsyncShellError('execution_rejected', 'The async shell frame names another Agent.');
    const owner = this.#owners.get(actorId);
    function refuse(message: string): never {
      throw new AsyncShellError(frame.operation === 'register' ? 'registration_rejected' : 'execution_rejected', message);
    }
    if (owner === undefined || frame.token !== owner.token) {
      refuse('The async shell execution no longer owns this Agent context.');
    }
    if (this.#closed || owner.retiring) {
      // The original lease still owns cancellation. Acknowledge its terminal
      // cleanup without delivering into a retiring context or a revived Actor.
      if (frame.operation === 'complete' && owner.tasks.has(frame.id)) return;
      refuse('The async shell execution no longer owns this Agent context.');
    }
    if (frame.operation === 'register') {
      if (!this.#options.accepting()) refuse('The async shell host is retiring.');
      if (!samePath(frame.directory, taskDirectory(frame.id, this.#root))) refuse('The async shell task directory does not match its ID.');
      if (owner.tasks.has(frame.id)) refuse(`Async shell task ${frame.id} is already registered.`);
      const launch = frame.callId === undefined ? undefined : owner.launches.get(frame.callId);
      if (frame.callId !== undefined && launch === undefined) refuse('The Job launch no longer owns this registration.');
      owner.tasks.set(frame.id, { directory: frame.directory, status: 'running', startedAt: performance.now(), pty: launch?.pty ?? true });
      launch?.abort(frame.directory);
      return;
    }
    const task = owner.tasks.get(frame.id);
    if (task === undefined) throw new Error(`Unknown async shell task ${frame.id}.`);
    if (frame.notify && frame.result.status === 'cancelled' && task.stopping) {
      task.stopping.cancelled = frame.result;
      return;
    }
    try {
      // Queue the result before releasing the wait: the runner must observe
      // either an outstanding task or its completion entry, with no gap.
      if (frame.notify && this.#options.accepting()) await this.#options.deliver(actorId, frame.result);
    } finally {
      // An internal error ends the wait, but does not certify cleanup. The
      // existing owner release still holds and cancels that resource lease.
      if (frame.result.status === 'internal_error') task.status = 'internal_error';
      else owner.tasks.delete(frame.id);
      this.#options.wake(actorId);
    }
  }

  async release(actorId: string): Promise<void> {
    const owner = this.#owners.get(actorId);
    if (owner === undefined) return;
    if (owner.release !== null) return owner.release;
    // Revoke first and keep the resource lease until cancellation finishes.
    owner.retiring = true;
    owner.release = (async () => {
      const settled = await Promise.allSettled([...owner.tasks.values()].map(({ directory }) => this.#options.cancel(directory, this.#root)));
      this.#options.wake(actorId);
      const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Async shell tasks did not all stop.');
      this.#owners.delete(actorId);
    })();
    return owner.release;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const settled = await Promise.allSettled([...this.#owners.keys()].map(actor => this.release(actor)));
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'The async shell host did not retire all tasks.');
  }
}
