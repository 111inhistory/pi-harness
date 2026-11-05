/**
 * Local IPC transport for Agent endpoints.
 *
 * Servers own their endpoint through `createOwnedServer`; this module only
 * frames newline-delimited records, tracks accepted connections, and reports
 * receiver failures. Ownership of a destination is an explicit registry result:
 * an endpoint-shaped path without `{ isManaged: true }` is never connected to.
 */

import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { createOwnedServer, type OwnedServer } from "./endpoint.ts";
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

/**
 * The stable session uid: a short, addressable fold of the native session id.
 *
 * Eight hex characters (32 bits) are shared by every platform so the session
 * directory, the published record and the wire identity `<uid>:Main` follow one
 * rule. It addresses concurrently active sessions, not a lifetime-global id.
 */
export function deriveSessionUid(sessionId: unknown): string {
  if (!sessionId || typeof sessionId !== "string") {
    return "default";
  }
  return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
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
  const { onFrame, onError, validateFrame } = options;
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
          catch (error) { throw new Error(`Failed to parse NDJSON line: ${trimmed}; error: ${asError(error).message}`); }
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

/**
 * Start one owned NDJSON endpoint at an explicit address. Binding, frame
 * reading, callback error reporting and inode-bound cleanup live here; domain
 * validation and recipient routing stay with the caller.
 */
export function createOwnedNdjsonServer(options: OwnedNdjsonServerOptions): OwnedNdjsonServer {
  const { address, root, onMessage, onError, validateFrame } = options;
  const owned = createOwnedServer({
    address,
    isNamespace: ipc.isNamespace(address),
    root,
    onConnection(socket) {
      readNdjson(socket, {
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

/** The registry answer for one endpoint-shaped address. */
export interface EndpointResolverResult {
  isManaged: boolean;
  isBroadcast?: boolean | undefined;
  targetId?: string | undefined;
  parentId?: string | undefined;
}

// Keep the platform contract available to typed callers without requiring them
// to import the implementation module directly.
export type { IpcPlatform } from "./platform.ts";
