import {
  createOwnedNdjsonServer,
  deriveSessionUid,
  endpointKey,
  getAgentSocketPath,
  getBroadcastSocketPath,
  validateInboundFrame,
  type EndpointResolverResult,
} from '../ipc/socket.ts';
import type { OwnedServer } from '../ipc/endpoint.ts';
import { canonicalActorId, SubagentError, type BroadcastReceipt, type ExternalSender, type MessageReceipt } from './runtime.ts';
import { parseSessionSenderId, sessionByUid, sessionMainAddress, sessionSenderId } from './session-directory.ts';

interface ListenerActor {
  readonly agentId: string;
  readonly parentAgentId: string | null;
  readonly depth: number;
}

export interface ListenerRegistryOptions {
  readonly socketDir: string;
  readonly baseSocketDir: string;
  /** The root's own session id; a frame naming it is local Main traffic. */
  readonly sessionId: string;
  /** The root's resolved maximum nesting depth; a child at it has no broadcast endpoint. */
  readonly maxDepth: number;
  actors(): readonly ListenerActor[];
  isAccepting(): boolean;
  send(command: { from: string; to: string; content: string; external?: ExternalSender }): Promise<MessageReceipt | BroadcastReceipt>;
  receiveShell?(actorId: string, frame: unknown): Promise<void>;
  onError(error: Error): void;
}

interface Destination {
  readonly address: string;
  readonly owner: string;
  readonly broadcast: boolean;
}

/** Listener lifetime follows the root registry, never the model's list window. */
export class AgentListeners {
  readonly #options: ListenerRegistryOptions;
  readonly #servers = new Map<string, OwnedServer>();
  #changes: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: ListenerRegistryOptions) { this.#options = options; }

  #destinations(): Destination[] {
    const actors = [{ agentId: 'Main', parentAgentId: null, depth: 0 }, ...this.#options.actors()];
    return actors.flatMap((actor) => {
      const receive: Destination = { address: getAgentSocketPath(actor.agentId, this.#options.socketDir), owner: actor.agentId, broadcast: false };
      return actor.depth < this.#options.maxDepth
        ? [receive, { address: getBroadcastSocketPath(actor.agentId, this.#options.socketDir), owner: actor.agentId, broadcast: true }]
        : [receive];
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.#changes.then(operation);
    this.#changes = run.catch(() => {});
    return run;
  }

  /**
   * Turn one claimed sending session into an external sender descriptor.
   *
   * The directory is the only source: an unregistered, dead or malformed
   * session refuses the frame instead of creating an unaddressed sender. The
   * reply address is the sender's real managed Main endpoint, never a second
   * addressing scheme.
   */
  async #externalSender(uid: string): Promise<ExternalSender> {
    const session = await sessionByUid(this.#options.baseSocketDir, uid);
    if (session === null) {
      throw new SubagentError('unknown_session', 'The sending session is not registered under this socket root.');
    }
    return { sessionId: session.sessionId, sender: sessionSenderId(uid), replyTo: sessionMainAddress(session) };
  }

  async resolve(address: string): Promise<EndpointResolverResult> {
    const destination = this.#destinations().find((entry) => endpointKey(entry.address) === endpointKey(address));
    if (destination !== undefined) {
      return destination.broadcast
        ? { isManaged: true, isBroadcast: true, parentId: destination.owner }
        : { isManaged: true, isBroadcast: false, targetId: destination.owner };
    }
    return { isManaged: false };
  }

  sync(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#closed || !this.#options.isAccepting()) throw new SubagentError('runtime_closed', 'The root no longer accepts IPC listeners.');
      const desired = this.#destinations();
      const keys = new Set(desired.map((entry) => endpointKey(entry.address)));
      for (const [key, server] of this.#servers) {
        if (keys.has(key)) continue;
        await server.close();
        this.#servers.delete(key);
      }
      for (const destination of desired) {
        const key = endpointKey(destination.address);
        if (this.#servers.has(key)) continue;
        const server = createOwnedNdjsonServer({
          address: destination.address,
          root: this.#options.baseSocketDir,
          onError: (error: Error) => this.#options.onError(error),
          onMessage: async (input: unknown) => {
            if (this.#closed) throw new SubagentError('runtime_closed', 'This IPC root is closed.');
            if (input !== null && typeof input === 'object' && 'kind' in input && input.kind === 'async-shell') {
              if (destination.broadcast || this.#options.receiveShell === undefined) {
                throw new SubagentError('invalid_target', 'Async shell events require their owning Agent endpoint.');
              }
              await this.#options.receiveShell(destination.owner, input);
              return;
            }
            if (this.#closed || !this.#options.isAccepting()) throw new SubagentError('runtime_closed', 'This IPC root is quiescing.');
            const message = validateInboundFrame(input);
            // One `from` field carries both identities: a plain local Actor ID,
            // or the composite `<session-uid>:Main` that only a sending host
            // builds for a cross-session frame.
            const claimed = parseSessionSenderId(message.from);
            let sender: string;
            let external: ExternalSender | undefined;
            if (claimed === null) {
              const local = canonicalActorId(message.from);
              if (local === null) throw new SubagentError('unknown_sender', 'The IPC sender is not a valid Actor ID.');
              if (destination.broadcast && local !== destination.owner) throw new SubagentError('invalid_target', 'Only the parent may write its broadcast endpoint.');
              sender = local;
            } else {
              // Only Main sends and only Main receives across sessions. A
              // composite identity at any other endpoint is out of scope.
              if (destination.owner !== 'Main' || destination.broadcast) {
                throw new SubagentError('invalid_target', 'Cross-session messages are Main-to-Main only.');
              }
              if (claimed.uid === deriveSessionUid(this.#options.sessionId)) {
                // The sender addressed its own Main. The runtime rejects the
                // self-send; it is never framed as another session.
                sender = 'Main';
              } else {
                sender = 'Main';
                external = await this.#externalSender(claimed.uid);
              }
            }
            // Registry membership is checked by Runtime. A supplied sender is
            // not authenticated merely because it is a valid registered ID.
            const result = await this.#options.send({ from: sender, to: destination.broadcast ? 'all' : destination.owner,
              content: message.content, ...(external === undefined ? {} : { external }) });
            if ('errors' in result && result.errors.length !== 0) {
              const failures = result.errors.map(error => `${error.to}: ${error.message}`).join('; ');
              throw new SubagentError('broadcast_partial_failure', `Some broadcast recipients rejected the message. ${failures}`,
                { errors: result.errors, sent: result.sent });
            }
          },
        });
        try {
          await server.ready;
          this.#servers.set(key, server);
        } catch (readyError) {
          const outcome = await server.close();
          if (outcome.releaseError !== null) {
            this.#options.onError(outcome.releaseError);
          }
          throw readyError;
        }
      }
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    return this.#enqueue(async () => {
      const results = await Promise.allSettled([...this.#servers.values()].map((server) => server.close()));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length !== 0) throw new AggregateError(failures.map((result) => result.reason), 'IPC listeners did not all close.');
      this.#servers.clear();
    });
  }
}
