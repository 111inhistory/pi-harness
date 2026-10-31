import {
  createOwnedNdjsonServer,
  endpointKey,
  getAgentSocketPath,
  getBroadcastSocketPath,
  validateInboundFrame,
  type EndpointResolverResult,
} from '../ipc/socket.ts';
import type { OwnedServer } from '../ipc/endpoint.ts';
import { canonicalActorId, MAX_AGENT_DEPTH, SubagentError, type BroadcastReceipt, type MessageReceipt } from './runtime.ts';

interface ListenerActor {
  readonly agentId: string;
  readonly parentAgentId: string | null;
  readonly depth: number;
}

export interface ListenerRegistryOptions {
  readonly socketDir: string;
  readonly baseSocketDir: string;
  actors(): readonly ListenerActor[];
  isAccepting(): boolean;
  send(command: { from: string; to: string; content: string }): Promise<MessageReceipt | BroadcastReceipt>;
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
      return actor.depth < MAX_AGENT_DEPTH
        ? [receive, { address: getBroadcastSocketPath(actor.agentId, this.#options.socketDir), owner: actor.agentId, broadcast: true }]
        : [receive];
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.#changes.then(operation);
    this.#changes = run.catch(() => {});
    return run;
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
            if (this.#closed || !this.#options.isAccepting()) throw new SubagentError('runtime_closed', 'This IPC root is quiescing.');
            const message = validateInboundFrame(input);
            const sender = canonicalActorId(message.from);
            if (sender === null) throw new SubagentError('unknown_sender', 'The IPC sender is not a valid Actor ID.');
            if (destination.broadcast && sender !== destination.owner) throw new SubagentError('invalid_target', 'Only the parent may write its broadcast endpoint.');
            // Registry membership is checked by Runtime. A supplied sender is
            // not authenticated merely because it is a valid registered ID.
            const result = await this.#options.send({ from: sender, to: destination.broadcast ? 'all' : destination.owner, content: message.content });
            if ('errors' in result && result.errors.length !== 0) {
              const failures = result.errors.map(error => `${error.to}: ${error.message}`).join('; ');
              throw new SubagentError('broadcast_partial_failure', `Some broadcast recipients rejected the message. ${failures}`,
                { errors: result.errors, sent: result.sent });
            }
          },
        });
        this.#servers.set(key, server);
        await server.ready;
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
