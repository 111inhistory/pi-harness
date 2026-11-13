/**
 * Strongly-typed client for the Harness RPC endpoint, driven directly by
 * `HARNESS_RPC_CONTRACT`.
 *
 * Incoming wire frames are validated against `RpcServerFrameSchema` before any
 * field dispatch so malformed external payloads fail the connection cleanly,
 * reject pending calls without retrying, and never throw uncaught errors from
 * socket listeners.
 */

import net from 'node:net';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { Compile } from 'typebox/compile';

import {
  RpcServerFrameSchema,
  validateMethodResult,
  type MethodCallArgs,
  type MethodResult,
} from './contract.ts';
import type {
  RpcEventEnvelope,
  RpcId,
  RpcMethod,
  RpcRequest,
  RpcResponse,
  RpcServerFrame,
} from './protocol.ts';

const serverFrameValidator = Compile(RpcServerFrameSchema);

export class RpcClientError extends Error {
  readonly code: string;
  readonly detail?: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'RpcClientError';
    this.code = code;
    this.detail = detail;
  }
}

export type RpcClientSender = (request: RpcRequest) => Promise<RpcResponse>;

export interface TypedRpcClientOptions {
  readonly validateResults?: boolean;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRpcServerFrame(value: unknown): value is RpcServerFrame {
  return serverFrameValidator.Check(value);
}

/**
 * Contract-typed RPC client over any request/response sender.
 * Method names, parameter requirements and concrete return types are inferred
 * directly from `HARNESS_RPC_CONTRACT`.
 */
export class TypedRpcClient {
  #seq = 0;
  readonly #send: RpcClientSender;
  readonly #validateResults: boolean;

  constructor(send: RpcClientSender, options: TypedRpcClientOptions = {}) {
    this.#send = send;
    this.#validateResults = options.validateResults ?? false;
  }

  async call<M extends RpcMethod>(
    method: M,
    ...args: MethodCallArgs<M>
  ): Promise<MethodResult<M>> {
    const id: RpcId = ++this.#seq;
    const params = args.length > 0 ? args[0] : undefined;
    const response = await this.#send({
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });

    if (!isRpcServerFrame(response) || 'event' in response) {
      throw new RpcClientError('invalid_frame', 'Server response failed frame schema validation.');
    }

    if (!response.ok) {
      throw new RpcClientError(
        response.error.code,
        response.error.message,
        response.error.detail,
      );
    }

    if (this.#validateResults) {
      const validation = validateMethodResult(method, response.result);
      if (!validation.ok) {
        throw new RpcClientError(
          'invalid_response',
          `Result for "${method}" failed contract validation: ${validation.errors.join('; ')}`,
          validation.errors,
        );
      }
      return validation.value;
    }

    return response.result as MethodResult<M>;
  }
}

export interface ConnectHarnessRpcOptions extends TypedRpcClientOptions {
  readonly onEvent?: (event: RpcEventEnvelope) => void;
  readonly onError?: (error: Error) => void;
}

export interface HarnessRpcClient extends TypedRpcClient {
  readonly closed: boolean;
  close(): Promise<void>;
}

interface PendingCall {
  readonly resolve: (response: RpcResponse) => void;
  readonly reject: (error: Error) => void;
}

/** Connect to a Harness RPC Unix socket or Windows Named Pipe endpoint. */
export async function connectHarnessRpc(
  address: string,
  options: ConnectHarnessRpcOptions = {},
): Promise<HarnessRpcClient> {
  const socket = net.connect(address);
  await once(socket, 'connect');

  const pending = new Map<RpcId, PendingCall>();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let closed = false;
  let failure: Error | null = null;

  const notifyError = (error: Error): void => {
    if (options.onError === undefined) return;
    try {
      options.onError(error);
    } catch {
      // User error listeners must never throw back into socket I/O handlers.
    }
  };

  const rejectAll = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  const failConnection = (error: Error): void => {
    if (failure !== null) return;
    failure = error;
    closed = true;
    rejectAll(error);
    notifyError(error);
    if (!socket.destroyed) socket.destroy();
  };

  const handleLine = (line: string): void => {
    if (failure !== null) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      failConnection(new RpcClientError('invalid_frame', `Malformed JSON frame from server: ${asError(error).message}`));
      return;
    }

    if (!isRpcServerFrame(parsed)) {
      const errors = [...serverFrameValidator.Errors(parsed)].map((err) => `${err.instancePath || '/'}: ${err.message}`);
      failConnection(new RpcClientError('invalid_frame', `Invalid server frame: ${errors.join('; ')}`, errors));
      return;
    }

    if ('event' in parsed) {
      if (options.onEvent !== undefined) {
        try {
          options.onEvent(parsed.event);
        } catch (error) {
          notifyError(asError(error));
        }
      }
      return;
    }

    if (parsed.id === null) {
      if (!parsed.ok) {
        notifyError(new RpcClientError(parsed.error.code, parsed.error.message, parsed.error.detail));
      }
      return;
    }

    const waiter = pending.get(parsed.id);
    if (waiter === undefined) return;
    pending.delete(parsed.id);
    waiter.resolve(parsed);
  };

  socket.on('data', (chunk: Buffer) => {
    if (failure !== null) return;
    buffer += decoder.write(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (failure !== null) return;
      const trimmed = line.trim();
      if (trimmed !== '') handleLine(trimmed);
    }
  });

  socket.on('error', (error: Error) => {
    if (failure !== null) return;
    failConnection(error);
  });

  socket.on('close', () => {
    closed = true;
    rejectAll(failure ?? new Error('Harness RPC connection closed.'));
  });

  const send: RpcClientSender = (request) => {
    if (closed || socket.destroyed) {
      return Promise.reject(failure ?? new Error('Harness RPC connection is closed.'));
    }
    let frame: string;
    try {
      frame = `${JSON.stringify(request)}\n`;
    } catch (error) {
      return Promise.reject(asError(error));
    }

    return new Promise<RpcResponse>((resolve, reject) => {
      pending.set(request.id, { resolve, reject });
      try {
        socket.write(frame, (error) => {
          if (error !== null && error !== undefined) {
            if (pending.delete(request.id)) reject(error);
          }
        });
      } catch (error) {
        pending.delete(request.id);
        reject(asError(error));
      }
    });
  };

  return new (class extends TypedRpcClient implements HarnessRpcClient {
    get closed(): boolean {
      return closed;
    }

    async close(): Promise<void> {
      if (socket.destroyed) return;
      const onClose = once(socket, 'close').then(() => undefined);
      socket.destroy();
      await onClose;
    }
  })(send, options);
}
