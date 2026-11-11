/**
 * Minimal NDJSON client for the Harness RPC endpoint: one real `net.Socket`, wire
 * frames only, no semantic expectations. `frames` keeps every frame received and
 * requests are matched against it by id, so no resolver map outlives a close.
 */
import net from 'node:net';
import { RPC_METHODS, type RpcRequest, type RpcResponse, type RpcServerFrame } from '../src/harness-rpc/protocol.ts';
import { deferred, waitFor } from './async.ts';

function isResponse(frame: RpcServerFrame): frame is RpcResponse { return 'id' in frame; }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

export class RpcModelClient {
  readonly frames: RpcServerFrame[] = [];
  readonly errors: Error[] = [];
  readonly #socket: net.Socket;
  readonly #connected = deferred();
  readonly #closed = deferred();
  #buffer = '';
  #nextId = 1;
  #active = false;
  #closing = false;

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    // Decoding here keeps split UTF-8 sequences whole across chunks.
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.#onData(chunk));
    socket.on('connect', () => { this.#active = true; this.#connected.resolve(); });
    socket.on('error', (error: Error) => {
      if (!this.#active) this.#connected.reject(error);
      // Teardown races (EPIPE / ECONNRESET) belong to close, not to the run.
      else {
        const code = (error as NodeJS.ErrnoException).code;
        if (!this.#closing || (code !== 'EPIPE' && code !== 'ECONNRESET')) this.errors.push(asError(error));
      }
    });
    socket.on('close', () => { this.#active = false; this.#closed.resolve(); });
  }

  /** Resolve only once connected; a failed connect rejects. */
  static async connect(address: string): Promise<RpcModelClient> {
    const client = new RpcModelClient(net.createConnection(address));
    await client.#connected.promise.catch((error: unknown) => {
      client.#socket.destroy();
      throw error;
    });
    return client;
  }

  get active(): boolean { return this.#active; }

  /** Send one request and wait for its response; bounded by `waitFor`. */
  async request(method: string, params?: unknown): Promise<RpcResponse> {
    if (!this.#active) throw new Error(`Cannot send ${method}: the RPC connection is not open.`);
    const id = this.#nextId++;
    const request: RpcRequest = params === undefined ? { id, method } : { id, method, params };
    this.#socket.write(`${JSON.stringify(request)}\n`);
    return waitFor(() => {
      if (!this.#active) throw new Error(`RPC connection closed while waiting for ${method} (id ${id}).`);
      return this.frames.find((frame): frame is RpcResponse => isResponse(frame) && frame.id === id);
    }, { label: `RPC response ${id} (${method})` });
  }

  /** Round-trip the ordered stream, so earlier frames are already recorded. */
  async barrier(): Promise<void> {
    const response = await this.request(RPC_METHODS.info);
    if (!response.ok) throw new Error(`harness.info failed: ${response.error.code}: ${response.error.message}`);
  }

  /** `half` sends FIN and awaits close; otherwise the socket is destroyed. */
  async close(half = false): Promise<void> {
    if (!this.#closing) {
      this.#closing = true;
      if (this.#active) {
        if (half) this.#socket.end();
        else this.#socket.destroy();
      }
    }
    await this.#closed.promise;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line !== '') {
        try {
          // External wire input; the private fixture types cannot be enforced here.
          this.frames.push(JSON.parse(line) as RpcServerFrame);
        } catch (error) {
          this.errors.push(asError(error));
        }
      }
      index = this.#buffer.indexOf('\n');
    }
  }
}
