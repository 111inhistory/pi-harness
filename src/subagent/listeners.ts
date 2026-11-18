import { createOwnedNdjsonServer, validateInboundFrame } from '../ipc/socket.ts';
import {
  inspectEndpoint,
  releaseOwnedEmptyDirectory,
  type EndpointIdentity,
} from '../ipc/endpoint.ts';
import { SubagentError, type BroadcastReceipt, type MessageReceipt } from './runtime.ts';

export interface RootListenerOptions {
  /** The root's only external address: `<socket root>/<session uid>/main.sock`. */
  readonly mainAddress: string;
  /** The shared per-user socket root; binding and ownership checks use it. */
  readonly socketRoot: string;
  /**
   * The private directory that holds main.sock, or null where the transport has
   * no filesystem directory (Windows Named Pipes). Only this exact path is
   * considered for empty-directory cleanup.
   */
  readonly mainDirectory: string | null;
  isAccepting(): boolean;
  /**
   * Bind a declared wire sender and deliver one message to its logical target.
   * The root owns sender binding, target classification and the domain target
   * expansion; this listener owns transport framing only.
   */
  deliver(input: { readonly from: string; readonly to: string; readonly content: string }): Promise<MessageReceipt | BroadcastReceipt>;
  /** Route one validated async-shell frame to the Actor it names. */
  receiveShell(actorId: string, frame: unknown): Promise<void>;
  onError(error: Error): void;
}

/**
 * The root's one external listener.
 *
 * A session exposes exactly one managed endpoint, its Main address. Same-root
 * traffic goes through Runtime directly, so no per-Actor or per-parent endpoint
 * is bound and no address is derived from a filesystem path: a frame names the
 * sender and the logical target, and the root resolves both.
 *
 * The lifetime follows the root generation. `sync` binds the endpoint (or
 * reports why it cannot); `close` releases the bound endpoint only after its
 * recorded device/inode identity still matches, then removes the now-empty
 * session directory this root created. All cleanup is best effort with errors
 * surfaced, never retried and never applied to a path this root did not bind.
 */
export class RootListener {
  readonly #options: RootListenerOptions;
  #server: Awaited<ReturnType<typeof createOwnedNdjsonServer>> | null = null;
  #changes: Promise<void> = Promise.resolve();
  #closed = false;
  #directory: EndpointIdentity | null = null;

  constructor(options: RootListenerOptions) {
    this.#options = options;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.#changes.then(operation);
    this.#changes = run.catch(() => {});
    return run;
  }

  /** Bind the single endpoint. A failed bind releases what it published and rethrows. */
  sync(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed || !this.#options.isAccepting()) {
        throw new SubagentError('runtime_closed', 'The root no longer accepts an IPC listener.');
      }
      if (this.#server !== null) return;
      const server = createOwnedNdjsonServer({
        address: this.#options.mainAddress,
        root: this.#options.socketRoot,
        onError: (error: Error) => this.#options.onError(error),
        onMessage: (input: unknown) => this.#receive(input),
      });
      try {
        await server.ready;
      } catch (readyError) {
        const outcome = await server.close();
        if (outcome.releaseError !== null) this.#options.onError(outcome.releaseError);
        throw readyError;
      }
      const directory = this.#options.mainDirectory === null ? null : inspectEndpoint(this.#options.mainDirectory);
      this.#directory = directory !== null && directory.kind === 'directory' ? directory.identity : null;
      this.#server = server;
    });
  }

  async #receive(input: unknown): Promise<void> {
    if (this.#closed) throw new SubagentError('runtime_closed', 'This root is closed.');
    if (this.#options.isAccepting() === false) {
      throw new SubagentError('runtime_closed', 'This root is quiescing.');
    }
    if (typeof input === 'object' && input !== null && 'kind' in input && input.kind === 'async-shell') {
      const actorId = (input as { agentId?: unknown }).agentId;
      if (typeof actorId !== 'string' || actorId === '') {
        throw new SubagentError('invalid_message', 'An async shell frame must name its Agent.');
      }
      await this.#options.receiveShell(actorId, input);
      return;
    }
    const message = validateInboundFrame(input);
    const result = await this.#options.deliver(message);
    if ('errors' in result && result.errors.length !== 0) {
      const failures = result.errors.map(error => `${error.to}: ${error.message}`).join('; ');
      throw new SubagentError('broadcast_partial_failure', `Some broadcast recipients rejected the message. ${failures}`,
        { errors: result.errors, sent: result.sent });
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    return this.#enqueue(async () => {
      const failures: unknown[] = [];
      const server = this.#server;
      this.#server = null;
      if (server !== null) {
        const outcome = await server.close();
        if (outcome.startupError !== null) failures.push(outcome.startupError);
        if (outcome.releaseError !== null) failures.push(outcome.releaseError);
        // A replaced or foreign endpoint is left in place, but the caller must
        // not treat this generation as released.
        if (outcome.release !== null && !['released', 'missing', 'namespace'].includes(outcome.release.reason)) {
          failures.push(new SubagentError('ipc_release_refused',
            `The bound endpoint was not released: ${outcome.release.reason}.`));
        }
      }
      // The session directory only ever held this endpoint. Removing it after
      // the verified endpoint release keeps an empty owned directory from
      // accumulating; a non-empty or foreign directory stays untouched.
      const mainDirectory = this.#options.mainDirectory;
      if (mainDirectory !== null && this.#directory !== null) {
        const removed = releaseOwnedEmptyDirectory(mainDirectory, this.#directory);
        if (removed.error !== null) failures.push(removed.error);
        // `not_owned` means the directory was replaced or is not private; a
        // retained RPC endpoint is `not_empty` and deliberately stays.
        if (removed.reason === 'not_owned') {
          failures.push(new SubagentError('ipc_directory_refused',
            'The session directory no longer belongs to this root and was left in place.'));
        }
        this.#directory = null;
      }
      if (failures.length !== 0) {
        throw new AggregateError(failures, 'The root main endpoint did not retire cleanly.');
      }
    });
  }
}
