import { stateRoot, taskDirectory } from './task-path.ts';
import { samePath } from '../fs-path.ts';
import { randomBytes } from 'node:crypto';
import { AsyncShellError } from './errors.ts';
import { validateAsyncShellFrame, type ShellResult } from './protocol.ts';

interface Owner {
  readonly token: string;
  readonly tasks: Map<string, { directory: string; status: 'running' | 'internal_error' }>;
  retiring: boolean;
  release: Promise<void> | null;
}

export interface AsyncShellHostOptions {
  address(actorId: string): string;
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
      owner = { token: randomBytes(24).toString('hex'), tasks: new Map(), retiring: false, release: null };
      this.#owners.set(actorId, owner);
    }
    if (owner.retiring) throw new Error('The previous async shell execution is still retiring.');
    return {
      PI_AGENT_ID: actorId,
      PI_AGENT_SOCKET: this.#options.address(actorId),
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

  async receive(actorId: string, input: unknown): Promise<void> {
    const frame = validateAsyncShellFrame(input);
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
      owner.tasks.set(frame.id, { directory: frame.directory, status: 'running' });
      return;
    }
    const task = owner.tasks.get(frame.id);
    if (task === undefined) throw new Error(`Unknown async shell task ${frame.id}.`);
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
