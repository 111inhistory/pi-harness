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
  if (platform === "win32") return path.join(tmpdir, "pi-subagents");
  return path.join(tmpdir, `pi-subagents-${userId ?? 0}`);
}

export function pipePath(root: string, name: string): string {
  const namespace = crypto.createHash("sha256").update(path.win32.resolve(root).toLowerCase()).digest("hex").slice(0, 12);
  return `${PIPE_ROOT}pi-harness-${namespace}-${name}.sock`;
}
