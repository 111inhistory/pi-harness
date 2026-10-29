/**
 * Local IPC transport for Agent endpoints.
 *
 * Servers own their endpoint through `createOwnedServer`; this module only
 * frames newline-delimited records, tracks accepted connections, and routes the
 * host's write tool. Ownership of a destination is an explicit registry result:
 * an endpoint-shaped path without `{ isManaged: true }` is never connected to.
 */

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { createOwnedServer, type OwnedServer } from "./endpoint.ts";
import { managedFrame } from "./message.ts";
import {
  DEFAULT_SOCKET_DIR,
  endpointKey,
  ipc,
  isIpcPath,
  isWindowsPipe,
} from "./platform.ts";

export { DEFAULT_SOCKET_DIR, endpointKey, isIpcPath, isWindowsPipe };
export { InboundFrameError, validateInboundFrame } from "./message.ts";
export type { InboundFrame } from "./message.ts";

const DEFAULT_WRITE_TIMEOUT_MS = 5000;

export class SocketWriteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SocketWriteError";
    this.code = code;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function deriveSessionUid(sessionId: unknown): string {
  if (!sessionId || typeof sessionId !== "string") {
    return "default";
  }
  return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 6);
}

export function getAgentSocketPath(id: string, socketDir: string = DEFAULT_SOCKET_DIR): string {
  return ipc.agentPath(id, socketDir);
}

export function getBroadcastSocketPath(parentId: string, socketDir: string = DEFAULT_SOCKET_DIR): string {
  const normalized = (parentId === "Main" || parentId === "main" || !parentId) ? "main" : parentId;
  return ipc.broadcastPath(normalized, socketDir);
}

interface NdjsonReaderOptions {
  onFrame: (frame: unknown) => unknown;
  onError?: ((error: Error) => void) | undefined;
  parseErrorPrefix: string;
  validateFrame?: ((input: unknown) => unknown) | undefined;
}

/**
 * Attach the newline-delimited frame reader to one accepted connection. The
 * ownership helper tracks the socket, so teardown can destroy a connection
 * that is held open or has sent only part of a frame. Raw and validated frames
 * both remain unknown to the transport; the adapter must apply its contract.
 * Each frame returns an empty line on success, or the error on failure. A
 * response is sent only after the callback settles; responses preserve order.
 */
function readNdjson(socket: net.Socket, options: NdjsonReaderOptions): void {
  const { onFrame, onError, parseErrorPrefix, validateFrame } = options;
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let pending = Promise.resolve();
  // Clients finish their request before waiting for the response.
  socket.allowHalfOpen = true;

  socket.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // Keep an incomplete trailing fragment in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      pending = pending.then(async () => {
        try {
          let parsed: unknown;
          try { parsed = JSON.parse(trimmed) as unknown; }
          catch (error) { throw new Error(`${parseErrorPrefix}: ${trimmed}; error: ${asError(error).message}`); }
          const frame = validateFrame === undefined ? parsed : validateFrame(parsed);
          await onFrame(frame);
          if (!socket.destroyed) socket.write("\n");
        } catch (error) {
          if (!socket.destroyed) socket.write(JSON.stringify({ code: errorCode(error), message: asError(error).message }) + "\n");
          onError?.(asError(error));
        }
      }).catch(() => { /* A failing error reporter must not escape the socket callback. */ });
    }
  });

  socket.on("end", () => {
    void pending.then(() => {
      if (!socket.destroyed) socket.end();
    });
  });

  socket.on("error", (error: NodeJS.ErrnoException) => {
    // A disconnected caller cannot receive a response.
    if (error.code !== "EPIPE" && error.code !== "ECONNRESET") {
      onError?.(error);
    }
  });
}

export interface OwnedNdjsonServerOptions {
  address: string;
  root: string;
  /** Receives the raw parsed frame, or the validator's output when supplied. */
  onMessage?: ((message: unknown) => unknown) | undefined;
  onError?: ((error: Error) => void) | undefined;
  validateFrame?: ((input: unknown) => unknown) | undefined;
}

export type OwnedNdjsonServer = OwnedServer & { address: string };

interface OwnedNdjsonEndpointOptions extends OwnedNdjsonServerOptions {
  parseErrorPrefix: string;
}

function createOwnedNdjsonEndpoint(options: OwnedNdjsonEndpointOptions): OwnedNdjsonServer {
  const { address, root, onMessage, onError, validateFrame, parseErrorPrefix } = options;
  const owned = createOwnedServer({
    address,
    isNamespace: ipc.isNamespace(address),
    root,
    onConnection(socket) {
      readNdjson(socket, {
        parseErrorPrefix,
        ...(onError === undefined ? {} : { onError }),
        ...(validateFrame === undefined ? {} : { validateFrame }),
        onFrame(frame: unknown) {
          if (typeof onMessage === "function") return onMessage(frame);
          return undefined;
        },
      });
    },
    ...(onError === undefined ? {} : { onError }),
  });

  return {
    address,
    server: owned.server,
    ready: owned.ready,
    clients: owned.clients,
    close: owned.close,
  };
}

/**
 * Start one owned NDJSON endpoint at an explicit address. Binding, frame
 * reading, callback error reporting and inode-bound cleanup live here; domain
 * validation and recipient routing stay with the caller.
 */
export function createOwnedNdjsonServer(options: OwnedNdjsonServerOptions): OwnedNdjsonServer {
  return createOwnedNdjsonEndpoint({
    ...options,
    parseErrorPrefix: "Failed to parse NDJSON line",
  });
}

export interface AgentSocketServerOptions {
  id: string;
  socketDir?: string | undefined;
  root?: string | undefined;
  /** Receives the raw parsed frame, or the validator's output when supplied. */
  onMessage?: ((message: unknown) => unknown) | undefined;
  onError?: ((error: Error) => void) | undefined;
  validateFrame?: ((input: unknown) => unknown) | undefined;
}

export type AgentSocketServer = OwnedServer & { id: string; socketPath: string };

/**
 * Start a local IPC server for an individual Subagent (Unix Socket / Named Pipe).
 * The returned `ready` rejects for an active, foreign, insecure or non-socket
 * endpoint; `close` is idempotent and force-closes accepted clients.
 */
export function createAgentSocketServer(options: AgentSocketServerOptions): AgentSocketServer {
  const { id, socketDir = DEFAULT_SOCKET_DIR, root, onMessage, onError, validateFrame } = options;
  const socketPath = getAgentSocketPath(id, socketDir);
  const owned = createOwnedNdjsonEndpoint({
    address: socketPath,
    root: root ?? path.resolve(DEFAULT_SOCKET_DIR),
    parseErrorPrefix: "Failed to parse NDJSON line",
    ...(onMessage === undefined ? {} : { onMessage }),
    ...(onError === undefined ? {} : { onError }),
    ...(validateFrame === undefined ? {} : { validateFrame }),
  });

  return {
    id,
    socketPath,
    server: owned.server,
    ready: owned.ready,
    clients: owned.clients,
    close: owned.close,
  };
}

export interface BroadcastSocketServerOptions {
  parentId: string;
  socketDir?: string | undefined;
  root?: string | undefined;
  getDirectChildren?: (() => readonly string[]) | undefined;
  /** Receives the raw parsed frame, or the validator's output when supplied. */
  deliverMessage?: ((childId: string, message: unknown) => unknown) | undefined;
  onError?: ((error: Error) => void) | undefined;
  validateFrame?: ((input: unknown) => unknown) | undefined;
}

export type BroadcastSocketServer = OwnedServer & { parentId: string; socketPath: string };

/**
 * Start a hierarchical direct-child broadcast IPC server.
 * When written to, fans out the message to all current direct children.
 */
export function createBroadcastSocketServer(options: BroadcastSocketServerOptions): BroadcastSocketServer {
  const {
    parentId,
    socketDir = DEFAULT_SOCKET_DIR,
    root,
    getDirectChildren,
    deliverMessage,
    onError,
    validateFrame,
  } = options;
  const socketPath = getBroadcastSocketPath(parentId, socketDir);
  const owned = createOwnedNdjsonEndpoint({
    address: socketPath,
    root: root ?? path.resolve(DEFAULT_SOCKET_DIR),
    parseErrorPrefix: "Broadcast failed to parse NDJSON line",
    ...(onError === undefined ? {} : { onError }),
    ...(validateFrame === undefined ? {} : { validateFrame }),
    async onMessage(frame: unknown) {
      const children = typeof getDirectChildren === "function" ? getDirectChildren() : [];
      const results = await Promise.allSettled(children.map(async (childId) => deliverMessage?.(childId, frame)));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  });

  return {
    parentId,
    socketPath,
    server: owned.server,
    ready: owned.ready,
    clients: owned.clients,
    close: owned.close,
  };
}

/**
 * Send NDJSON and wait for the receiver's result. An empty response line means
 * success; errors retain their code and message. No automatic retry.
 */
export function writeSocket(
  socketPath: string,
  payload: unknown,
  { timeoutMs = DEFAULT_WRITE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (typeof serialized !== "string") {
      reject(new Error(`Cannot serialize socket payload for: ${socketPath}`));
      return;
    }
    let text = serialized;
    if (!text.endsWith("\n")) text += "\n";

    const expected = text.split("\n").filter((line) => line.trim() !== "").length;
    const decoder = new StringDecoder("utf8");
    let response = "";
    let received = 0;
    let settled = false;
    // Do not half-close before the response: Windows Named Pipes do not have
    // Unix sockets' half-close behavior.
    const client = net.connect(socketPath, () => {
      client.write(text, "utf8");
      if (expected === 0) { settled = true; client.destroy(); resolve(); }
    });
    client.on("data", (chunk: Buffer) => {
      response += decoder.write(chunk);
      try {
        for (;;) {
          const newline = response.indexOf("\n");
          if (newline < 0 || settled) return;
          const line = response.slice(0, newline);
          response = response.slice(newline + 1);
          if (line !== "") {
            const error: unknown = JSON.parse(line);
            if (typeof error !== "object" || error === null || !("message" in error) || typeof error.message !== "string") {
              throw new SocketWriteError("invalid_response", "Invalid socket response.");
            }
            throw new SocketWriteError(errorCode(error) ?? "delivery_failed", error.message);
          }
          received += 1;
          if (received === expected) { settled = true; client.destroy(); resolve(); }
        }
      } catch (error) { settled = true; client.destroy(); reject(error); }
    });
    client.setTimeout(timeoutMs, () => {
      client.destroy(new SocketWriteError("timeout", `Timeout waiting for socket response: ${socketPath}`));
    });
    client.on("error", reject);
    client.on("close", () => {
      if (!settled) reject(new SocketWriteError("missing_response", "Socket closed before returning the delivery result."));
    });
  });
}

// Retain the old import name for callers; it now waits for the result too.
export { writeSocket as writeSocketOneWay };

/** Check reserved IPC directories without creating a root service. */
export async function isInSocketDirectory(address: string, root: string): Promise<boolean> {
  if (ipc.isNamespace(address)) return false;
  const inside = (value: string, base: string): boolean => {
    const relative = path.relative(base, value);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  const absolute = path.resolve(address);
  const base = path.resolve(root);
  if (inside(absolute, base)) return true;
  const canonical = async (value: string): Promise<string> => {
    let current = value;
    const suffix: string[] = [];
    for (;;) {
      try {
        return path.join(await fsp.realpath(current), ...suffix);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        const parent = path.dirname(current);
        if (parent === current) return value;
        suffix.unshift(path.basename(current));
        current = parent;
      }
    }
  };
  return inside(await canonical(absolute), await canonical(base));
}

/** The registry answer for one endpoint-shaped address. */
export interface EndpointResolverResult {
  isManaged: boolean;
  isBroadcast?: boolean | undefined;
  targetId?: string | undefined;
  parentId?: string | undefined;
}

export interface ManagedEndpointResult extends EndpointResolverResult {
  isManaged: true;
}

export type ResolveEndpoint = (
  address: string,
) => EndpointResolverResult | null | undefined | Promise<EndpointResolverResult | null | undefined>;

export type MaybePromise<T> = T | Promise<T>;

export interface SocketTransport {
  isEndpoint(address: unknown): boolean;
  isNamespace(address: unknown): boolean;
}

export interface SocketWriteOperationOptions {
  writeFile?: ((absolutePath: string, content: unknown) => MaybePromise<unknown>) | undefined;
  mkdir?: ((directory: string) => MaybePromise<unknown>) | undefined;
  onCheckStatus?: ((agentId: string) => MaybePromise<string | null | undefined>) | undefined;
  senderId?: string | undefined;
  resolveEndpoint?: ResolveEndpoint | undefined;
  isReservedPath?: ((address: string) => MaybePromise<boolean>) | undefined;
  sendManaged?: ((
    endpoint: ManagedEndpointResult,
    address: string,
    frame: string,
  ) => MaybePromise<unknown>) | undefined;
}

/** The subset of the SDK `WriteOperations` contract this adapter provides. */
export interface SocketWriteOperations {
  mkdir(directory: string): Promise<void>;
  writeFile(absolutePath: string, content: string | Uint8Array): Promise<void>;
}

function isManagedEndpoint(
  value: EndpointResolverResult | null | undefined,
): value is ManagedEndpointResult {
  return value !== null && value !== undefined && value.isManaged === true;
}

export function createSocketAwareWriteOperations(
  baseOperations: SocketWriteOperationOptions = {},
  transport: SocketTransport = ipc,
): SocketWriteOperations {
  const writeFile = baseOperations.writeFile ||
    ((absolutePath: string, content: unknown) => fsp.writeFile(
      absolutePath,
      typeof content === "string" || content instanceof Uint8Array ? content : String(content),
      "utf-8",
    ));
  const mkdir = baseOperations.mkdir ||
    ((directory: string) => fsp.mkdir(directory, { recursive: true }));
  const onCheckStatus = baseOperations.onCheckStatus;
  const senderId = baseOperations.senderId || "main";
  const resolveEndpoint = baseOperations.resolveEndpoint;
  const isReservedPath = baseOperations.isReservedPath;
  const sendManaged = baseOperations.sendManaged;

  return {
    async mkdir(directory: string): Promise<void> {
      if (transport.isNamespace(directory) || (isReservedPath && await isReservedPath(directory))) return;
      await mkdir(directory);
    },
    async writeFile(absolutePath: string, content: string | Uint8Array): Promise<void> {
      if (transport.isEndpoint(absolutePath)) {
        const resolved = typeof resolveEndpoint === "function" ? await resolveEndpoint(absolutePath) : null;
        if (!isManagedEndpoint(resolved)) {
          throw new SocketWriteError(
            "unmanaged_endpoint",
            `Refusing to connect to an unmanaged IPC endpoint: ${absolutePath}`,
          );
        }

        const targetId = resolved.targetId || path.basename(absolutePath, ".sock");
        if (resolved.isBroadcast) {
          const expectedParent = resolved.parentId || "main";
          const normExpected = (expectedParent === "Main" || expectedParent === "main") ? "main" : expectedParent;
          const normSender = (senderId === "Main" || senderId === "main") ? "main" : senderId;
          if (normSender !== normExpected) {
            throw new SocketWriteError(
              "invalid_target",
              "invalid_target: Sender is not the parent of this broadcast endpoint.",
            );
          }
        } else if (typeof onCheckStatus === "function" && targetId && targetId !== "children") {
          const status = await onCheckStatus(targetId);
          if (status === "stopping") {
            throw new SocketWriteError(
              "agent_stopping",
              `agent_stopping: Subagent ${targetId} is currently stopping. Cannot accept messages until fully stopped.`,
            );
          }
        }

        // The caller's text is content, never a transport frame. The host
        // constructs one sender envelope even for multiline, JSON-looking or
        // scalar-looking text.
        const { frame } = managedFrame({ senderId, content });
        if (typeof sendManaged === "function") {
          await sendManaged(resolved, absolutePath, frame);
        } else {
          await writeSocket(absolutePath, frame);
        }
        return;
      }
      if (isReservedPath && await isReservedPath(absolutePath)) {
        throw new SocketWriteError(
          "ipc_directory_reserved",
          "IPC directories cannot contain files written by write.",
        );
      }
      await writeFile(absolutePath, content);
    },
  };
}

// Keep the platform contract available to typed callers without requiring them
// to import the implementation module directly.
export type { IpcPlatform } from "./platform.ts";
