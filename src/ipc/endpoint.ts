/**
 * Endpoint ownership and lifetime for local IPC.
 *
 * This module owns the filesystem decisions that are too easy to get wrong in
 * the transport adapters: private per-user directories, safe recovery of an
 * abandoned Unix socket, inode-bound removal of the endpoint this process
 * bound, and prompt teardown of accepted clients. Named Pipes are a kernel
 * namespace, so namespace callers skip every Unix path rule here.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { defaultSocketRoot, effectiveUserId } from "./address.ts";
import path from "node:path";

export type EndpointKind = "missing" | "socket" | "symlink" | "file" | "directory" | "other";

export interface EndpointIdentity {
  dev: number;
  ino: number;
}

export interface EndpointInspection {
  address: string;
  kind: EndpointKind;
  identity: EndpointIdentity | null;
  uid: number | null;
  mode: number | null;
}

export interface EndpointLease {
  address: string;
  namespace: boolean;
  identity: EndpointIdentity | null;
  staleRemoved: boolean;
}

export interface EndpointRelease {
  removed: boolean;
  reason: "released" | "missing" | "not_owned" | "namespace" | "error";
  error?: Error;
}

export interface SocketRootValidation {
  root: string;
  created: boolean;
  inspection: EndpointInspection;
}

export interface OwnedServerOptions {
  address: string;
  isNamespace?: boolean;
  root?: string;
  userId?: number | null;
  probeTimeoutMs?: number;
  onConnection: (socket: net.Socket) => void;
  onError?: (error: Error) => void;
}

export interface OwnedServerClose {
  startupError: Error | null;
  release: EndpointRelease | null;
  releaseError: Error | null;
}

export interface OwnedServer {
  server: net.Server;
  ready: Promise<void>;
  close: () => Promise<OwnedServerClose>;
  clients: Set<net.Socket>;
}

/** Stable machine-readable ownership refusal. */
export class IpcOwnershipError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "IpcOwnershipError";
    this.code = code;
    this.detail = detail;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function kindOf(stats: fs.Stats): EndpointKind {
  if (stats.isSocket()) return "socket";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

export function inspectEndpoint(address: string): EndpointInspection {
  try {
    const stats = fs.lstatSync(address);
    return {
      address,
      kind: kindOf(stats),
      identity: { dev: stats.dev, ino: stats.ino },
      uid: typeof stats.uid === "number" ? stats.uid : null,
      mode: typeof stats.mode === "number" ? stats.mode : null,
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { address, kind: "missing", identity: null, uid: null, mode: null };
    }
    throw error;
  }
}

function privateDirectory(stats: fs.Stats, userId: number | null): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  if (userId !== null && stats.uid !== userId) return false;
  return (stats.mode & 0o077) === 0;
}

/**
 * Create or verify the directory that will hold a bound endpoint. Existing
 * insecure or foreign directories are refused; this function never chmods,
 * chowns or "repairs" a path it does not own.
 */
export function ensurePrivateDirectory(directory: string, userId: number | null = effectiveUserId()): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(directory);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    stats = fs.lstatSync(directory);
  }
  if (stats.isSymbolicLink()) {
    throw new IpcOwnershipError("ipc_directory_symlink", `Refusing IPC directory symlink: ${directory}`, { path: directory });
  }
  if (!stats.isDirectory()) {
    throw new IpcOwnershipError("ipc_directory_not_directory", `IPC parent is not a directory: ${directory}`, { path: directory });
  }
  if (!privateDirectory(stats, userId)) {
    throw new IpcOwnershipError(
      "ipc_directory_insecure",
      `IPC directory is not private to the effective user: ${directory}`,
      { path: directory, uid: stats.uid, mode: stats.mode },
    );
  }
}

/**
 * Validate (or safely create) the configured/default namespace root itself.
 * The session directory is created inside this root, so an attacker-controlled
 * parent such as a world-writable or symlinked root would otherwise allow the
 * session directory or endpoint to be renamed/replaced through that parent.
 * System temp ancestors are not revalidated; only the managed root boundary is.
 */
export function ensurePrivateSocketRoot(
  root: string = defaultSocketRoot(),
  userId: number | null = effectiveUserId(),
): SocketRootValidation {
  const resolved = path.resolve(root);
  let created = false;
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    created = true;
    stats = fs.lstatSync(resolved);
  }
  if (stats.isSymbolicLink()) {
    throw new IpcOwnershipError("ipc_root_symlink", `Refusing symlinked IPC root: ${resolved}`, { root: resolved });
  }
  if (!stats.isDirectory()) {
    throw new IpcOwnershipError("ipc_root_not_directory", `IPC root is not a directory: ${resolved}`, { root: resolved });
  }
  if (!privateDirectory(stats, userId)) {
    throw new IpcOwnershipError(
      "ipc_root_insecure",
      `IPC root is not private to the effective user: ${resolved}`,
      { root: resolved, uid: stats.uid, mode: stats.mode },
    );
  }
  return {
    root: resolved,
    created,
    inspection: {
      address: resolved,
      kind: "directory",
      identity: { dev: stats.dev, ino: stats.ino },
      uid: typeof stats.uid === "number" ? stats.uid : null,
      mode: typeof stats.mode === "number" ? stats.mode : null,
    },
  };
}

/**
 * Strict containment inside one Unix endpoint directory.
 *
 * Unix endpoints are filesystem entries, so this is a pure POSIX path
 * calculation: it keeps POSIX case sensitivity even when the caller runs on a
 * host whose own path rules are case-insensitive. Windows endpoints are kernel
 * pipe names and never take this route.
 */
function insidePath(base: string, value: string): boolean {
  const resolvedBase = path.posix.resolve(base);
  const resolvedValue = path.posix.resolve(value);
  const relative = path.posix.relative(resolvedBase, resolvedValue);
  return relative !== "" && relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative);
}

/** True when a Unix endpoint is strictly inside one endpoint directory. */
export function endpointInsideDirectory(address: string, directory: string): boolean {
  return insidePath(directory, address);
}

export type EndpointProbe = "active" | "refused" | "missing" | "unknown";

/**
 * A successful connection proves the endpoint is active. A refusal is only a
 * classification hint: callers must combine it with path type, owner and
 * private-directory checks before treating the endpoint as abandoned.
 */
export function probeEndpoint(address: string, timeoutMs = 300): Promise<EndpointProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const client = net.connect(address);
    const finish = (result: EndpointProbe) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(result);
    };
    client.once("connect", () => finish("active"));
    client.once("error", (error) => {
      const code = errorCode(error);
      if (code === "ECONNREFUSED") finish("refused");
      else if (code === "ENOENT") finish("missing");
      else finish("unknown");
    });
    client.setTimeout(timeoutMs, () => finish("unknown"));
  });
}

/**
 * Prepare an endpoint for binding. A missing path is ready to bind. An
 * existing live endpoint is left untouched. Only a socket owned by the
 * effective user inside a private directory, proven inactive by a probe and
 * re-checked by inode identity, may be recovered.
 */
export async function prepareEndpoint({
  address,
  namespace = false,
  root = defaultSocketRoot(),
  userId = effectiveUserId(),
  probeTimeoutMs = 300,
}: {
  address: string;
  namespace?: boolean;
  root?: string;
  userId?: number | null;
  probeTimeoutMs?: number;
}): Promise<EndpointLease> {
  if (namespace) {
    return { address, namespace: true, identity: null, staleRemoved: false };
  }
  if (process.platform === "win32") {
    // Windows has no Unix socket-file ownership rules. The caller selected a
    // filesystem path on Windows: preserve plain path behaviour without
    // applying Linux uid/mode assumptions.
    return { address, namespace: false, identity: null, staleRemoved: false };
  }

  // A managed endpoint nested under the configured/default namespace root
  // validates that root itself first. An arbitrary external socket outside the
  // managed namespace keeps the previous leaf-only ownership rules.
  if (endpointInsideDirectory(address, root)) ensurePrivateSocketRoot(root, userId);
  ensurePrivateDirectory(path.dirname(address), userId);
  const before = inspectEndpoint(address);
  if (before.kind === "missing") {
    return { address, namespace: false, identity: null, staleRemoved: false };
  }
  if (before.kind === "symlink") {
    throw new IpcOwnershipError("ipc_endpoint_symlink", `Refusing to replace symlink endpoint: ${address}`, { path: address });
  }
  if (before.kind !== "socket") {
    throw new IpcOwnershipError(
      "ipc_endpoint_not_socket",
      `Refusing to replace non-socket endpoint (${before.kind}): ${address}`,
      { path: address, kind: before.kind },
    );
  }
  if (userId !== null && before.uid !== userId) {
    throw new IpcOwnershipError(
      "ipc_endpoint_foreign",
      `Refusing endpoint owned by another effective user: ${address}`,
      { path: address, uid: before.uid },
    );
  }

  const probe = await probeEndpoint(address, probeTimeoutMs);
  if (probe === "active") {
    throw new IpcOwnershipError("ipc_endpoint_in_use", `Endpoint is already in use: ${address}`, { path: address });
  }
  if (probe === "unknown") {
    throw new IpcOwnershipError(
      "ipc_endpoint_unverifiable",
      `Endpoint activity could not be determined; refusing to remove it: ${address}`,
      { path: address, probe },
    );
  }

  // Re-read immediately before unlinking: only the inode inspected above may
  // be removed, never a replacement endpoint that appeared during the probe.
  const current = inspectEndpoint(address);
  if (current.kind === "missing") {
    return { address, namespace: false, identity: null, staleRemoved: false };
  }
  if (current.kind !== "socket" || current.identity === null || before.identity === null ||
      current.identity.dev !== before.identity.dev || current.identity.ino !== before.identity.ino) {
    throw new IpcOwnershipError(
      "ipc_endpoint_changed",
      `Endpoint changed while probing; refusing to remove it: ${address}`,
      { path: address },
    );
  }
  try {
    fs.unlinkSync(address);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return { address, namespace: false, identity: null, staleRemoved: true };
}

/**
 * Remove only the endpoint this process bound. The identity recorded after
 * listen must still match, so a later instance's endpoint or an ordinary file
 * replacing the path is preserved.
 */
export function releaseEndpoint(lease: EndpointLease): EndpointRelease {
  if (lease.namespace) return { removed: false, reason: "namespace" };
  try {
    const current = inspectEndpoint(lease.address);
    if (current.kind === "missing") return { removed: false, reason: "missing" };
    if (current.kind !== "socket" || current.identity === null) return { removed: false, reason: "not_owned" };
    if (lease.identity === null ||
        current.identity.dev !== lease.identity.dev || current.identity.ino !== lease.identity.ino) {
      return { removed: false, reason: "not_owned" };
    }
    fs.unlinkSync(lease.address);
    return { removed: true, reason: "released" };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { removed: false, reason: "missing" };
    return { removed: false, reason: "error", error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function bind(server: net.Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address);
  });
}

/**
 * Create a server whose accepted clients are tracked for teardown and whose
 * filesystem endpoint is released only if it still has the identity bound by
 * this server. `ready` settles after the endpoint is proven bindable and the
 * server is listening; `close` is idempotent and resolves even when a client
 * holds the connection open or has sent only half a frame.
 */
export function createOwnedServer({
  address,
  isNamespace = false,
  root = defaultSocketRoot(),
  userId = effectiveUserId(),
  probeTimeoutMs = 300,
  onConnection,
  onError,
}: OwnedServerOptions): OwnedServer {
  const clients = new Set<net.Socket>();
  let lease: EndpointLease | null = null;
  let boundLease: EndpointLease | null = null;
  let published = false;

  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    onConnection(socket);
  });

  const ready = (async () => {
    try {
      lease = await prepareEndpoint({ address, namespace: isNamespace, root, userId, probeTimeoutMs });
      if (lease.namespace) {
        try {
          await bind(server, address);
        } catch (error) {
          // The kernel namespace is the owner here: an already bound name is the
          // same refusal a live Unix endpoint produces, so callers see one code.
          if (errorCode(error) === "EADDRINUSE") {
            throw new IpcOwnershipError("ipc_endpoint_in_use", `Endpoint is already in use: ${address}`, { path: address });
          }
          throw error;
        }
      } else {
        // libuv unlinks the exact path passed to listen() when the server
        // closes. Bind a short private path in the same directory, then rename
        // it into place, so libuv can only unlink that temporary name. The
        // real endpoint is removed later by inode identity in releaseEndpoint.
        const temporary = path.join(
          path.dirname(address),
          `.b-${process.pid.toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
        );
        await bind(server, temporary);
        try {
          try {
            // Hard-linking is the atomic no-replace publish. A live endpoint
            // that appeared after preparation remains untouched.
            fs.linkSync(temporary, address);
            try {
              fs.unlinkSync(temporary);
            } catch {
              // libuv will unlink the private temporary name on close.
            }
          } catch (error) {
            if (errorCode(error) === "EEXIST") {
              throw new IpcOwnershipError("ipc_endpoint_in_use", `Endpoint is already in use: ${address}`, { path: address });
            }
            // A check-then-rename fallback would race a live endpoint. Fail
            // closed instead of publishing through a non-atomic mechanism.
            throw new IpcOwnershipError(
              "ipc_endpoint_publish_unsupported",
              `Cannot atomically publish endpoint without hard-link support: ${address}`,
              { path: address, cause: errorCode(error) },
            );
          }
        } catch (error) {
          try {
            fs.unlinkSync(temporary);
          } catch {
            // The bind error is the primary failure.
          }
          throw error;
        }
        published = true;
        // Keep server.address() reporting the public endpoint. libuv retains
        // the temporary bind name internally for its own close-time unlink.
        (server as unknown as { _pipeName?: string })._pipeName = address;
      }
      if (lease.namespace) {
        // A kernel-namespace endpoint owns no file identity: nothing is recorded
        // and nothing is probed. `fs.lstat` on an active Windows Named Pipe opens
        // a client handle to the endpoint this server just bound, which accepts as
        // a phantom connection that never carries a frame.
        boundLease = lease;
      } else {
        const identity = inspectEndpoint(address);
        boundLease = identity.kind === "socket"
          ? { ...lease, identity: identity.identity }
          : lease;
      }
      server.on("error", (error) => onError?.(error));
    } catch (error) {
      if (lease !== null && !lease.namespace) {
        try {
          // Only clean a path this startup actually published; an EEXIST race
          // leaves another instance's endpoint untouched.
          if (published) {
            const current = inspectEndpoint(address);
            if (current.kind === "socket" && current.identity !== null) {
              releaseEndpoint({ ...lease, identity: current.identity });
            }
          }
        } catch {
          // The startup error below is the primary failure.
        }
      }
      throw error;
    }
  })();
  // Keep an unobserved startup failure from becoming an unhandled rejection;
  // callers that await `ready` still receive the rejection.
  ready.catch(() => {});

  let closing: Promise<OwnedServerClose> | null = null;
  const close = (): Promise<OwnedServerClose> => {
    if (closing !== null) return closing;
    closing = (async () => {
      let startupError: Error | null = null;
      try {
        await ready;
      } catch (error) {
        startupError = error instanceof Error ? error : new Error(String(error));
      }

      for (const socket of [...clients]) {
        try {
          socket.destroy();
        } catch {
          // A failed destroy must not prevent closing the remaining clients.
        }
      }
      clients.clear();

      if (server.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }

      let release: EndpointRelease | null = null;
      let releaseError: Error | null = null;
      if (boundLease !== null) {
        try {
          release = releaseEndpoint(boundLease);
          if (release.reason === "error" && release.error) releaseError = release.error;
        } catch (error) {
          releaseError = error instanceof Error ? error : new Error(String(error));
        }
      }
      return { startupError, release, releaseError };
    })();
    return closing;
  };

  return { server, ready, close, clients };
}
