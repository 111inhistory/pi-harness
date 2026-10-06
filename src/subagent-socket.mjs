import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export const DEFAULT_SOCKET_DIR = process.env.PI_SUBAGENT_SOCKET_DIR || "/tmp/pi-subagents";

export function getAgentSocketPath(id, socketDir = DEFAULT_SOCKET_DIR) {
  return path.join(socketDir, `${id}.sock`);
}

export function getBroadcastSocketPath(parentId, socketDir = DEFAULT_SOCKET_DIR) {
  const normalized = (parentId === "Main" || parentId === "main" || !parentId) ? "main" : parentId;
  return path.join(socketDir, normalized, "children.sock");
}

export function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function safeUnlinkSync(socketPath) {
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch {
    // Ignore unlink error if already removed
  }
}

/**
 * Start a Unix Domain Socket server for an individual Subagent.
 * Uses connection isolation and newline-delimited JSON buffering.
 */
export function createAgentSocketServer({ id, socketDir = DEFAULT_SOCKET_DIR, onMessage, onError }) {
  const socketPath = getAgentSocketPath(id, socketDir);
  ensureDirSync(path.dirname(socketPath));
  safeUnlinkSync(socketPath);

  const server = net.createServer((socket) => {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
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
          safeUnlinkSync(socketPath);
          resolve();
        });
      }),
  };
}

/**
 * Start a hierarchical direct-child broadcast Unix Domain Socket server.
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
  ensureDirSync(path.dirname(socketPath));
  safeUnlinkSync(socketPath);

  const server = net.createServer((socket) => {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
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
          safeUnlinkSync(socketPath);
          resolve();
        });
      }),
  };
}

/**
 * Client helper to send one-way NDJSON message to a Unix Domain Socket.
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
 * Factory for a WriteOperations adapter that intercepts .sock paths
 * and routes them to Unix Domain Socket one-way delivery.
 */
export function createSocketAwareWriteOperations(baseOperations = {}) {
  const writeFile = baseOperations.writeFile || ((p, c) => fsp.writeFile(p, c, "utf-8"));
  const mkdir = baseOperations.mkdir || ((d) => fsp.mkdir(d, { recursive: true }));

  return {
    mkdir,
    async writeFile(absolutePath, content) {
      if (typeof absolutePath === "string" && absolutePath.endsWith(".sock")) {
        return writeSocketOneWay(absolutePath, content);
      }
      return writeFile(absolutePath, content);
    },
  };
}
