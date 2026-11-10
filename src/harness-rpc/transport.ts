/**
 * The independent Harness RPC server.
 *
 * One owned endpoint, one newline-delimited JSON reader per accepted client, and
 * a request/response protocol that also lets the server push subscription
 * events on the same connection. Ownership, stale-endpoint recovery and inode
 * bound cleanup are delegated to `createOwnedServer`; this module owns framing,
 * dispatch and the per-connection subscription/backpressure policy.
 *
 * Slow clients are bounded, never blocking: a connection whose unsent backlog
 * exceeds the limit is destroyed (and its subscriptions released) instead of
 * growing without bound or silently dropping events while pretending the stream
 * is complete.
 */

import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';

import { createOwnedServer, type OwnedServer } from '../ipc/endpoint.ts';
import { ipc } from '../ipc/platform.ts';
import { RpcRequestError } from './error.ts';
import {
  RPC_ERROR,
  type RpcErrorBody,
  type RpcEventFrame,
  type RpcId,
  type RpcRequest,
  type RpcResponseId,
  type RpcServerFrame,
} from './protocol.ts';

const DEFAULT_MAX_BACKLOG_BYTES = 4 * 1024 * 1024;

/** A request handler; `connection` lets a handler register a subscription. */
export type RpcHandler = (request: RpcRequest, connection: RpcConnection) => Promise<unknown>;

export interface HarnessRpcServerOptions {
  readonly address: string;
  /** The managed socket root the address is validated against. */
  readonly root: string;
  readonly handler: RpcHandler;
  readonly maxBacklogBytes?: number;
  readonly onError?: (error: Error) => void;
}

function errorBody(error: unknown): RpcErrorBody {
  if (error instanceof RpcRequestError) {
    return error.detail === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, detail: error.detail };
  }
  return { code: RPC_ERROR.internal, message: error instanceof Error ? error.message : String(error) };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Parse one client frame into a request, or return null with a refusal id. */
function parseRequest(input: unknown): { request: RpcRequest } | { error: RpcErrorBody; id: RpcResponseId } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: { code: RPC_ERROR.invalidRequest, message: 'A request frame must be a JSON object.' }, id: null };
  }
  const record = input as Record<string, unknown>;
  const id = record.id;
  const validId: RpcResponseId = typeof id === 'string' || typeof id === 'number' ? id : null;
  const method = record.method;
  if (typeof method !== 'string' || method.trim() === '') {
    return { error: { code: RPC_ERROR.invalidRequest, message: 'A request needs a non-empty "method".' }, id: validId };
  }
  if (validId === null) {
    return { error: { code: RPC_ERROR.invalidRequest, message: 'A request needs a string or number "id".' }, id: null };
  }
  return { request: { id: validId, method, params: record.params } };
}

let subscriptionCounter = 0;
function nextSubscriptionId(): string {
  subscriptionCounter += 1;
  return `sub-${process.pid.toString(36)}-${subscriptionCounter.toString(36)}`;
}

/** One accepted client. Requests are handled in order; events are pushed out of band. */
export class RpcConnection {
  readonly #socket: net.Socket;
  readonly #handler: RpcHandler;
  readonly #maxBacklogBytes: number;
  readonly #onError: (error: Error) => void;
  readonly #subscriptions = new Map<string, () => void>();
  #decoder = new StringDecoder('utf8');
  #buffer = '';
  #chain: Promise<void> = Promise.resolve();
  #eventSeq = 0;
  #closed = false;
  #inputEnded = false;

  constructor(socket: net.Socket, handler: RpcHandler, maxBacklogBytes: number, onError: (error: Error) => void) {
    this.#socket = socket;
    this.#handler = handler;
    this.#maxBacklogBytes = maxBacklogBytes;
    this.#onError = onError;
    // A client may finish its request before reading the response. Stop new
    // observations at FIN, but let the ordered request chain queue its
    // responses before ending the writable side; `end()` flushes those bytes
    // instead of discarding a backpressured response. An unresolved handler
    // keeps this connection as in-flight ownership; it is not a subscription
    // cancellation path.
    socket.allowHalfOpen = true;
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('end', () => {
      this.#inputEnded = true;
      void this.#chain.then(() => this.#finishInput());
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') this.#onError(asError(error));
    });
    socket.on('close', () => this.close());
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Register a subscription's teardown and return its id. */
  addSubscription(unsubscribe: () => void): string {
    const id = nextSubscriptionId();
    this.#subscriptions.set(id, unsubscribe);
    return id;
  }

  /** Remove one subscription; returns whether it existed. */
  removeSubscription(id: string): boolean {
    const unsubscribe = this.#subscriptions.get(id);
    if (unsubscribe === undefined) return false;
    this.#subscriptions.delete(id);
    try {
      unsubscribe();
    } catch (error) {
      this.#onError(asError(error));
    }
    return true;
  }

  /** Push one event for a subscription. No-op once input ended or the connection closed. */
  pushEvent(subscription: string, payload: unknown): void {
    if (this.#closed || this.#inputEnded) return;
    this.#eventSeq += 1;
    const frame: RpcEventFrame = { event: { subscription, seq: this.#eventSeq, payload } };
    this.#write(frame);
  }

  /**
   * Release subscriptions and drop the socket. Idempotent.
   *
   * A FIN'd connection is logically closed but may still be flushing a
   * backpressured response. Server retirement must still be able to destroy
   * that live socket, so only the subscription release is skipped on a second
   * call; the owned socket is always checked and released.
   */
  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#releaseSubscriptions();
    }
    if (!this.#socket.destroyed) {
      try {
        this.#socket.destroy();
      } catch {
        /* teardown must not throw */
      }
    }
  }

  /** Finish after input ended: release observations, then flush queued writes. */
  #finishInput(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseSubscriptions();
    if (!this.#socket.destroyed) {
      try {
        this.#socket.end();
      } catch {
        /* teardown must not throw */
      }
    }
  }

  #releaseSubscriptions(): void {
    for (const unsubscribe of this.#subscriptions.values()) {
      try {
        unsubscribe();
      } catch (error) {
        this.#onError(asError(error));
      }
    }
    this.#subscriptions.clear();
  }

  #onData(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer += this.#decoder.write(chunk);
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      // Serialize per-connection so responses keep request order.
      this.#chain = this.#chain.then(() => this.#handleLine(trimmed)).catch(() => {});
    }
  }

  async #handleLine(line: string): Promise<void> {
    if (this.#closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#write({ id: null, ok: false, error: { code: RPC_ERROR.invalidRequest, message: 'Frame is not valid JSON.' } });
      return;
    }
    const result = parseRequest(parsed);
    if ('error' in result) {
      this.#write({ id: result.id, ok: false, error: result.error });
      return;
    }
    try {
      const value = await this.#handler(result.request, this);
      this.#write({ id: result.request.id, ok: true, result: value });
    } catch (error) {
      const body = errorBody(error);
      this.#write({ id: result.request.id, ok: false, error: body });
      if (!(error instanceof RpcRequestError)) this.#onError(asError(error));
    }
  }

  #write(frame: RpcServerFrame): void {
    if (this.#closed || this.#socket.destroyed) return;
    // Bound the unsent backlog: a client that cannot keep up is disconnected
    // rather than allowed to grow memory or to make the producer block.
    if (this.#socket.writableLength > this.#maxBacklogBytes) {
      this.#onError(new Error('Harness RPC client exceeded its event backlog and was disconnected.'));
      this.close();
      return;
    }
    this.#socket.write(`${JSON.stringify(frame)}\n`);
  }
}

export interface HarnessRpcServer {
  readonly address: string;
  readonly ready: Promise<void>;
  readonly connections: Set<RpcConnection>;
  close(): Promise<void>;
}

/** Start the owned Harness RPC endpoint at `options.address`. */
export function createHarnessRpcServer(options: HarnessRpcServerOptions): HarnessRpcServer {
  const connections = new Set<RpcConnection>();
  const onError = options.onError ?? (() => {});
  const maxBacklogBytes = options.maxBacklogBytes ?? DEFAULT_MAX_BACKLOG_BYTES;
  const owned: OwnedServer = createOwnedServer({
    address: options.address,
    isNamespace: ipc.isNamespace(options.address),
    root: options.root,
    onConnection(socket: net.Socket) {
      const connection = new RpcConnection(socket, options.handler, maxBacklogBytes, onError);
      connections.add(connection);
      socket.once('close', () => connections.delete(connection));
    },
    onError,
  });

  return {
    address: options.address,
    ready: owned.ready,
    connections,
    async close() {
      for (const connection of [...connections]) connection.close();
      connections.clear();
      await owned.close();
    },
  };
}
