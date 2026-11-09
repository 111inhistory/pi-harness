/** Pure local IPC address calculations shared by transport and runtime. */
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const PIPE_ROOT = "\\\\.\\pipe\\";

export function effectiveUserId(): number | null {
  if (process.platform === "win32") return null;
  if (typeof process.geteuid === "function") return process.geteuid();
  if (typeof process.getuid === "function") return process.getuid();
  return null;
}

/** The default private socket root, without binding any transport. */
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
  if (platform === "win32") return path.join(tmpdir, "pi-session");
  return path.join(tmpdir, `pi-session-${userId ?? 0}`);
}

/**
 * The kernel namespace shared by every endpoint of one socket root.
 *
 * A Named Pipe has no directory of its own, so the root is folded into the
 * name: one root maps to one prefix, and every endpoint below it keeps that
 * prefix. The hash is taken over the resolved, case-folded path because the
 * Windows filesystem compares paths that way; this is the only place a root
 * becomes a pipe name.
 *
 * Eight hex characters (32 bits) identify the namespaces that are concurrently
 * active on this machine, not a lifetime-global id: a collision at that scale is
 * negligible, and the kernel's own first-instance bind refuses a colliding name.
 */
export function pipeNamespace(root: string): string {
  const namespace = crypto.createHash("sha256").update(path.win32.resolve(root).toLowerCase()).digest("hex").slice(0, 8);
  return `${PIPE_ROOT}pi-harness-${namespace}-`;
}

export function pipePath(root: string, name: string): string {
  return `${pipeNamespace(root)}${name}.sock`;
}
