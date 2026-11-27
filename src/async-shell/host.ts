import { stateRoot, taskDirectory } from './task-path.ts';
import { samePath } from '../fs-path.ts';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { sliceUtf8Head } from '../text-output.ts';
import { AsyncShellError } from './errors.ts';
import { validateAsyncShellFrame, type ShellResult, type ShellStatus } from './protocol.ts';
import { runJobCommand } from './job-command.ts';

interface TerminalJob {
  readonly finishedAt: number;
  readonly status: Exclude<ShellStatus, 'running'>;
  readonly exitCode: number | null;
  readonly truncated: boolean;
}

export interface BackgroundShellJob {
  readonly jobId: string;
  readonly agentId: string;
  readonly pty: boolean;
  readonly shell: string | null;
  readonly cwd: string | null;
  readonly command: string | null;
  readonly commandTruncated: boolean;
  readonly pid: number;
  readonly startedAt: number;
  readonly logPath: string;
}

export type ShellJobObservation =
  | ({ readonly phase: 'backgrounded' } & BackgroundShellJob)
  | ({ readonly phase: 'finished' } & BackgroundShellJob & TerminalJob);

interface OwnedTask {
  readonly directory: string;
  readonly startedAt: number;
  readonly pty: boolean;
  readonly job: BackgroundShellJob;
  observed: boolean;
  terminal?: TerminalJob;
  status: 'running' | 'internal_error';
  stopping?: { cancelled?: ShellResult };
  inputTail?: Promise<void>;
}

export type JobInput = { readonly text: string; readonly enter: boolean } | { readonly key: string };

interface Owner {
  readonly token: string;
  readonly tasks: Map<string, OwnedTask>;
  readonly launches: Map<string, {
    pty: boolean;
    metadata: Pick<BackgroundShellJob, 'shell' | 'cwd' | 'command' | 'commandTruncated'>;
    registered: (task: OwnedTask) => void;
  }>;
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
  readonly #observers = new Set<(event: ShellJobObservation) => void>();
  readonly #root = stateRoot();
  #closed = false;

  constructor(options: AsyncShellHostOptions) { this.#options = options; }

  observe(agentId: string | undefined, listener: (event: ShellJobObservation) => void) {
    const jobs: BackgroundShellJob[] = [];
    for (const [id, owner] of this.#owners) {
      if (agentId !== undefined && agentId !== id) continue;
      for (const task of owner.tasks.values()) if (task.observed && task.terminal === undefined) jobs.push({ ...task.job });
    }
    const forward = (event: ShellJobObservation) => {
      if (agentId === undefined || agentId === event.agentId) listener(event);
    };
    this.#observers.add(forward);
    return { jobs, unsubscribe: () => { this.#observers.delete(forward); } };
  }

  #emit(event: ShellJobObservation): void {
    for (const observer of this.#observers) {
      try { observer({ ...event }); } catch { /* Observers cannot affect task ownership or result delivery. */ }
    }
  }

  #background(task: OwnedTask): void {
    if (task.observed) return;
    task.observed = true;
    this.#emit({ phase: 'backgrounded', ...task.job });
    if (task.terminal !== undefined) this.#emit({ phase: 'finished', ...task.job, ...task.terminal });
  }

  #finish(task: OwnedTask, result: Pick<ShellResult, 'status' | 'exitCode' | 'truncated'>): void {
    if (task.terminal !== undefined || result.status === 'running') return;
    const terminal = { finishedAt: Date.now(), status: result.status, exitCode: result.exitCode, truncated: result.truncated };
    task.terminal = terminal;
    if (task.observed) this.#emit({ phase: 'finished', ...task.job, ...terminal });
  }

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
  async start(actorId: string, pty: boolean, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, onRegister?: (directory: string) => void,
    display?: { readonly shell: string; readonly command: string }): Promise<ShellResult> {
    signal?.throwIfAborted();
    const owner = this.#owners.get(actorId);
    if (this.#closed || !this.#options.accepting() || !owner || owner.retiring || owner.token !== env.PI_ASYNC_SHELL_TOKEN) {
      throw new AsyncShellError('execution_rejected', 'The approved Job execution lease is no longer active.');
    }
    const callId = randomBytes(24).toString('hex');
    let registered: OwnedTask | undefined;
    let cancellation: Promise<void> | undefined;
    const abort = (): void => {
      if (registered === undefined || cancellation !== undefined || owner.retiring) return;
      // The native startup gate prevents cancellation from releasing an
      // unbound task that the create process could still start afterwards.
      cancellation = this.#options.cancel(registered.directory, this.#root);
      void cancellation.catch(() => {});
    };
    // Encode at most a preview's worth of characters, plus room for a surrogate pair.
    const command = display === undefined ? null : sliceUtf8Head(display.command.slice(0, 4098), 4096);
    owner.launches.set(callId, { pty, metadata: { shell: display?.shell ?? null, cwd, command,
      commandTruncated: display !== undefined && command !== display.command }, registered: task => {
      registered = task;
      if (signal?.aborted) queueMicrotask(abort);
      else onRegister?.(task.directory);
    } });
    signal?.addEventListener('abort', abort, { once: true });
    let result: ShellResult;
    try {
      result = await runJobCommand(['create', ...args], { cwd, env: { ...env, PI_ASYNC_SHELL_CALL_ID: callId } });
    } finally {
      signal?.removeEventListener('abort', abort);
      owner.launches.delete(callId);
      await cancellation;
      signal?.throwIfAborted();
    }
    if (result.status === 'running' && registered !== undefined && registered.job.jobId === result.id &&
      !this.#closed && !owner.retiring && this.#owners.get(actorId) === owner && this.#options.accepting()) this.#background(registered);
    return result;
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
      this.#finish(task, stop.cancelled ?? result);
      return reportedCancellation ? stop.cancelled ?? result : result;
    } finally {
      delete task.stopping;
      if (reportedCancellation || stop.cancelled !== undefined) {
        if (stop.cancelled !== undefined) this.#finish(task, stop.cancelled);
        try {
          if (!reportedCancellation && stop.cancelled !== undefined && !this.#closed && this.#options.accepting() && !this.#owners.get(actorId)?.retiring) {
            await this.#options.deliver(actorId, stop.cancelled);
          }
        } finally {
          // Native cancel may finalize after an exited monitor without a callback.
          const tasks = this.#owners.get(actorId)?.tasks;
          if (tasks?.get(id) === task) {
            tasks.delete(id);
            this.#options.wake(actorId);
          }
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
      const pty = launch?.pty ?? frame.pty;
      const task: OwnedTask = { directory: frame.directory, status: 'running', startedAt: performance.now(), pty, observed: false,
        job: { jobId: frame.id, agentId: actorId, pid: frame.pid, pty, startedAt: Date.now(), logPath: join(frame.directory, 'output.log'),
          ...(launch?.metadata ?? { shell: null, cwd: null, command: null, commandTruncated: false }) } };
      owner.tasks.set(frame.id, task);
      if (launch !== undefined) launch.registered(task);
      else this.#background(task);
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
      this.#finish(task, frame.result);
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
      const tasks = [...owner.tasks.values()];
      const settled = await Promise.allSettled(tasks.map(async task => {
        let status: 'cancelled' | 'internal_error' = 'internal_error';
        try { await this.#options.cancel(task.directory, this.#root); status = 'cancelled'; }
        finally { this.#finish(task, { status, exitCode: null, truncated: false }); }
      }));
      this.#options.wake(actorId);
      const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Async shell tasks did not all stop.');
      this.#owners.delete(actorId);
    })();
    return owner.release;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#observers.clear();
    const settled = await Promise.allSettled([...this.#owners.keys()].map(actor => this.release(actor)));
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'The async shell host did not retire all tasks.');
  }
}
