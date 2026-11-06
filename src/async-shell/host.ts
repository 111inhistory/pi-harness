import path from 'node:path';
import { taskDirectory } from './tmux.ts';
import { randomBytes } from 'node:crypto';
import { validateAsyncShellFrame, type ShellResult } from './protocol.ts';

interface Owner {
  readonly token: string;
  readonly tasks: Map<string, string>;
  retiring: boolean;
  release: Promise<void> | null;
}

export interface AsyncShellHostOptions {
  address(actorId: string): string;
  accepting(): boolean;
  deliver(actorId: string, result: ShellResult): Promise<void>;
  wake(actorId: string): void;
  cancel(directory: string): Promise<void>;
}

/** One root owns execution leases; a shell result never impersonates an Agent. */
export class AsyncShellHost {
  readonly #options: AsyncShellHostOptions;
  readonly #owners = new Map<string, Owner>();
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
    };
  }

  hasPending(actorId: string): boolean { return (this.#owners.get(actorId)?.tasks.size ?? 0) > 0; }

  async receive(actorId: string, input: unknown): Promise<void> {
    const frame = validateAsyncShellFrame(input);
    const owner = this.#owners.get(actorId);
    if (owner === undefined || frame.token !== owner.token) {
      throw new Error('The async shell execution no longer owns this Agent context.');
    }
    if (this.#closed || owner.retiring) {
      // The original lease still owns cancellation. Acknowledge its terminal
      // cleanup without delivering into a retiring context or a revived Actor.
      if (frame.operation === 'complete' && owner.tasks.has(frame.id)) return;
      throw new Error('The async shell execution no longer owns this Agent context.');
    }
    if (frame.operation === 'register') {
      if (!this.#options.accepting()) throw new Error('The async shell host is retiring.');
      if (path.resolve(frame.directory) !== taskDirectory(frame.id)) throw new Error('The async shell task directory does not match its ID.');
      if (owner.tasks.has(frame.id)) throw new Error(`Async shell task ${frame.id} is already registered.`);
      owner.tasks.set(frame.id, frame.directory);
      return;
    }
    if (!owner.tasks.has(frame.id)) throw new Error(`Unknown async shell task ${frame.id}.`);
    try {
      // Queue the result before releasing the wait: the runner must observe
      // either an outstanding task or its completion entry, with no gap.
      if (frame.notify && this.#options.accepting()) await this.#options.deliver(actorId, frame.result);
    } finally {
      owner.tasks.delete(frame.id);
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
      const settled = await Promise.allSettled([...owner.tasks.values()].map(directory => this.#options.cancel(directory)));
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
