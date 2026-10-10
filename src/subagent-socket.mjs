import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { ipc, DEFAULT_SOCKET_DIR, endpointKey, isIpcPath, isWindowsPipe } from "./subagent-ipc.mjs";
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
 * Start a local IPC server for an individual Subagent (Unix Socket / Named Pipe).
 * Uses connection isolation and newline-delimited JSON buffering.
 */
export function createAgentSocketServer({ id, socketDir = DEFAULT_SOCKET_DIR, onMessage, onError }) {
  const socketPath = getAgentSocketPath(id, socketDir);
  ipc.prepare(socketPath);

  const server = net.createServer((socket) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop(); // Keep incomplete trailing fragment in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof onMessage === "function") {
            onMessage(parsed);
          }
        } catch (err) {
          if (typeof onError === "function") {
            onError(new Error(`Failed to parse NDJSON line: ${trimmed}; error: ${err.message}`));
          }
        }
      }
    });

    socket.on("error", (err) => {
      // EPIPE or connection resets are normal in one-way deliveries
      if (err.code !== "EPIPE" && err.code !== "ECONNRESET" && typeof onError === "function") {
        onError(err);
      }
    });
  });

  server.listen(socketPath);

  return {
    id,
    socketPath,
    server,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          ipc.remove(socketPath);
          resolve();
        });
      }),
  };
}

/**
 * Start a hierarchical direct-child broadcast IPC server.
 * When written to, fans out the message to all current direct children.
 */
export function createBroadcastSocketServer({
  parentId,
  socketDir = DEFAULT_SOCKET_DIR,
  getDirectChildren,
  deliverMessage,
  onError,
}) {
  const socketPath = getBroadcastSocketPath(parentId, socketDir);
  ipc.prepare(socketPath);

  const server = net.createServer((socket) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const parsed = JSON.parse(trimmed);
          const children = typeof getDirectChildren === "function" ? getDirectChildren() : [];
          if (Array.isArray(children)) {
            for (const childId of children) {
              if (typeof deliverMessage === "function") {
                deliverMessage(childId, parsed).catch((err) => {
                  if (typeof onError === "function") onError(err);
                });
              }
            }
          }
        } catch (err) {
          if (typeof onError === "function") {
            onError(new Error(`Broadcast failed to parse NDJSON line: ${trimmed}; error: ${err.message}`));
          }
        }
      }
    });

    socket.on("error", (err) => {
      if (err.code !== "EPIPE" && err.code !== "ECONNRESET" && typeof onError === "function") {
        onError(err);
      }
    });
  });

  server.listen(socketPath);

  return {
    parentId,
    socketPath,
    server,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          ipc.remove(socketPath);
          resolve();
        });
      }),
  };
}

/**
 * Client helper to send one-way NDJSON through Node's platform IPC transport.
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
          return writeSocketOneWay(absolutePath, content);
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

        let text = typeof content === "string" ? content : content.toString("utf-8");
        const lines = text.split("\n");
        const processedLines = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === "") continue;
          let parsed;
          try {
            parsed = JSON.parse(trimmed);
          } catch (e) {
            const err = new Error(`invalid_message: Malformed NDJSON frame: ${e.message}`);
            err.code = "invalid_message";
            throw err;
          }
          if (parsed && typeof parsed === "object") {
            if ("from" in parsed) {
              const err = new Error("invalid_message: Caller-supplied 'from' is rejected; sender is bound by the session host.");
              err.code = "invalid_message";
              throw err;
            }
            parsed.from = senderId;
          }
          processedLines.push(JSON.stringify(parsed));
        }
        const outbound = processedLines.join("\n") + "\n";
        return sendManaged ? sendManaged(ep, absolutePath, outbound) : writeSocketOneWay(absolutePath, outbound);
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
