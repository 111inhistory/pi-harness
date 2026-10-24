import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { ipc, DEFAULT_SOCKET_DIR, endpointKey, isIpcPath, isWindowsPipe } from "./subagent-ipc.mjs";
import { createOwnedServer } from "./ipc/endpoint.ts";
import { managedFrame } from "./ipc/message.ts";
export { DEFAULT_SOCKET_DIR, endpointKey, isIpcPath, isWindowsPipe };

export function deriveSessionUid(sessionId) {
  if (!sessionId || typeof sessionId !== "string") {
    return "default";
  }
  return crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 6);
}

export function getAgentSocketPath(id, socketDir = DEFAULT_SOCKET_DIR) {
  return ipc.agentPath(id, socketDir);
}

export function getBroadcastSocketPath(parentId, socketDir = DEFAULT_SOCKET_DIR) {
  const normalized = (parentId === "Main" || parentId === "main" || !parentId) ? "main" : parentId;
  return ipc.broadcastPath(normalized, socketDir);
}

/**
 * Attach the newline-delimited frame reader to one accepted connection. The
 * ownership helper tracks the socket, so teardown can destroy a connection
 * that is held open or has sent only part of a frame.
 */
function readNdjson(socket, { onFrame, onError, parseErrorPrefix }) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop(); // Keep an incomplete trailing fragment in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        if (typeof onError === "function") {
          onError(new Error(`${parseErrorPrefix}: ${trimmed}; error: ${err.message}`));
        }
        continue;
      }
      onFrame(parsed);
    }
  });

  socket.on("error", (err) => {
    // EPIPE or connection resets are normal in one-way deliveries
    if (err.code !== "EPIPE" && err.code !== "ECONNRESET" && typeof onError === "function") {
      onError(err);
    }
  });
}

/**
 * Start a local IPC server for an individual Subagent (Unix Socket / Named Pipe).
 * The returned `ready` rejects for an active, foreign, insecure or non-socket
 * endpoint; `close` is idempotent and force-closes accepted clients.
 */
export function createAgentSocketServer({ id, socketDir = DEFAULT_SOCKET_DIR, root, onMessage, onError }) {
  const socketPath = getAgentSocketPath(id, socketDir);
  const owned = createOwnedServer({
    address: socketPath,
    isNamespace: ipc.isNamespace(socketPath),
    root: root ?? path.resolve(DEFAULT_SOCKET_DIR),
    onConnection(socket) {
      readNdjson(socket, {
        parseErrorPrefix: "Failed to parse NDJSON line",
        onError,
        onFrame(parsed) {
          if (typeof onMessage === "function") onMessage(parsed);
        },
      });
    },
    onError,
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

/**
 * Start a hierarchical direct-child broadcast IPC server.
 * When written to, fans out the message to all current direct children.
 */
export function createBroadcastSocketServer({
  parentId,
  socketDir = DEFAULT_SOCKET_DIR,
  root,
  getDirectChildren,
  deliverMessage,
  onError,
}) {
  const socketPath = getBroadcastSocketPath(parentId, socketDir);
  const owned = createOwnedServer({
    address: socketPath,
    isNamespace: ipc.isNamespace(socketPath),
    root: root ?? path.resolve(DEFAULT_SOCKET_DIR),
    onConnection(socket) {
      readNdjson(socket, {
        parseErrorPrefix: "Broadcast failed to parse NDJSON line",
        onError,
        onFrame(parsed) {
          const children = typeof getDirectChildren === "function" ? getDirectChildren() : [];
          if (!Array.isArray(children)) return;
          for (const childId of children) {
            if (typeof deliverMessage !== "function") continue;
            try {
              const pending = deliverMessage(childId, parsed);
              if (pending && typeof pending.catch === "function") {
                pending.catch((err) => {
                  if (typeof onError === "function") onError(err);
                });
              }
            } catch (err) {
              if (typeof onError === "function") onError(err);
            }
          }
        },
      });
    },
    onError,
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
 * Client helper to send one already-formed transport frame through Node's
 * platform IPC transport. Framing and sender binding belong to the managed
 * write path, not to callers.
 */
export function writeSocketOneWay(socketPath, payload, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let text = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (!text.endsWith("\n")) text += "\n";

    const client = net.connect(socketPath, () => {
      client.write(text, "utf-8", (err) => {
        if (err) {
          client.destroy();
          return reject(err);
        }
        client.end();
        resolve();
      });
    });

    client.setTimeout(timeoutMs, () => {
      client.destroy(new Error(`Timeout connecting or writing to socket: ${socketPath}`));
    });

    client.on("error", reject);
  });
}

/**
 * Factory for a WriteOperations adapter that intercepts platform IPC addresses
 * and routes them to one-way delivery without filesystem operations on pipes.
 */
export async function isInSocketDirectory(address, root) {
  if (ipc.isNamespace(address)) return false;
  const inside = (value, base) => {
    const relative = path.relative(base, value);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  const absolute = path.resolve(address);
  const base = path.resolve(root);
  if (inside(absolute, base)) return true;
  const canonical = async (value) => {
    let current = value;
    const suffix = [];
    for (;;) {
      try { return path.join(await fsp.realpath(current), ...suffix); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = path.dirname(current);
        if (parent === current) return value;
        suffix.unshift(path.basename(current));
        current = parent;
      }
    }
  };
  return inside(await canonical(absolute), await canonical(base));
}

export function createSocketAwareWriteOperations(baseOperations = {}, transport = ipc) {
  const writeFile = baseOperations.writeFile || ((p, c) => fsp.writeFile(p, c, "utf-8"));
  const mkdir = baseOperations.mkdir || ((d) => fsp.mkdir(d, { recursive: true }));
  const onCheckStatus = baseOperations.onCheckStatus;
  const senderId = baseOperations.senderId || "main";
  const resolveEndpoint = baseOperations.resolveEndpoint;
  const isReservedPath = baseOperations.isReservedPath;
  const sendManaged = baseOperations.sendManaged;

  return {
    mkdir: async (dir) => {
      if (transport.isNamespace(dir) || (isReservedPath && await isReservedPath(dir))) return;
      return mkdir(dir);
    },
    async writeFile(absolutePath, content) {
      if (transport.isEndpoint(absolutePath)) {
        const ep = typeof resolveEndpoint === "function" ? await resolveEndpoint(absolutePath) : null;
        const isManaged = ep ? ep.isManaged : (typeof onCheckStatus === "function");

        if (!isManaged) {
          const text = typeof content === "string"
            ? content
            : (content instanceof Uint8Array ? Buffer.from(content).toString("utf-8") : String(content));
          return writeSocketOneWay(absolutePath, text);
        }

        const targetId = ep?.targetId || path.basename(absolutePath, ".sock");
        if (ep?.isBroadcast) {
          const expectedParent = ep.parentId || "main";
          const normExpected = (expectedParent === "Main" || expectedParent === "main") ? "main" : expectedParent;
          const normSender = (senderId === "Main" || senderId === "main") ? "main" : senderId;
          if (normSender !== normExpected) {
            const err = new Error("invalid_target: Sender is not the parent of this broadcast endpoint.");
            err.code = "invalid_target";
            throw err;
          }
        } else if (typeof onCheckStatus === "function" && targetId && targetId !== "children") {
          const status = await onCheckStatus(targetId);
          if (status === "stopping") {
            const err = new Error(`agent_stopping: Subagent ${targetId} is currently stopping. Cannot accept messages until fully stopped.`);
            err.code = "agent_stopping";
            throw err;
          }
        }

        // The caller's text is content, never a transport frame. The host
        // constructs one sender envelope even for multiline, JSON-looking or
        // scalar-looking text.
        const { frame } = managedFrame({ senderId, content });
        return sendManaged ? sendManaged(ep, absolutePath, frame) : writeSocketOneWay(absolutePath, frame);
      }
      if (isReservedPath && await isReservedPath(absolutePath)) {
        const error = new Error("IPC directories cannot contain files written by write.");
        error.code = "ipc_directory_reserved";
        throw error;
      }
      return writeFile(absolutePath, content);
    },
  };
}
