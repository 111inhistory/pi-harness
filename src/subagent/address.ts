/**
 * Pure local-IPC address formatting.
 *
 * The lifecycle only needs the address string of an actor; it must not load
 * the Socket transport (or its filesystem ownership code) to print a path.
 * The transport remains the owner of binding, permission checks and cleanup.
 * `src/subagent/runtime.ts` therefore keeps the transport-free default, and a
 * host may inject its own formatter through `RuntimeOptions.agentSocketPath`.
 */

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const PIPE_ROOT = "\\\\.\\pipe\\";

function effectiveUserId(): number | null {
  if (process.platform === "win32") return null;
  if (typeof process.geteuid === "function") return process.geteuid();
  if (typeof process.getuid === "function") return process.getuid();
  return null;
}

/** Mirrors the transport's default root without importing its ownership module. */
export function defaultSocketRoot({
  platform = process.platform,
  env = process.env,
  tmpdir = os.tmpdir(),
  userId = effectiveUserId(),
}: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  tmpdir?: string;
  userId?: number | null;
} = {}): string {
  const override = env.PI_SUBAGENT_SOCKET_DIR;
  if (typeof override === "string" && override !== "") return override;
  if (platform === "win32") return path.join(tmpdir, "pi-subagents");
  return path.join(tmpdir, `pi-subagents-${userId ?? 0}`);
}

function pipePath(root: string, name: string): string {
  const namespace = crypto.createHash("sha256").update(path.win32.resolve(root).toLowerCase()).digest("hex").slice(0, 12);
  return `${PIPE_ROOT}pi-harness-${namespace}-${name}.sock`;
}

/** The address a single actor is bound to, without touching that address. */
export function formatAgentSocketPath(id: string, socketDir: string = defaultSocketRoot()): string {
  if (process.platform === "win32") return pipePath(socketDir, id);
  return path.join(socketDir, `${id}.sock`);
}
