/**
 * POSIX backend: one private `tmux` server per task, addressed by a socket path
 * inside the task directory.
 *
 * The pane is created with the internal runner as a single shell-quoted command
 * (the pane's shell is only ever asked to run this process's own paths), and the
 * capture pipe is armed immediately after: `pipe-pane` starts from the pane's
 * current offset, so the runner's marker handshake — not a sleep — is what proves
 * capture is live before the command starts.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import { AsyncShellError } from "./errors.ts";
import { CONTROL_TIMEOUT_MS, SESSION, type CommandResult, type ShellBackend } from "./platform.ts";

/** The pane's shell only ever sees this process's own absolute paths. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function socketOf(dir: string): string {
  return path.join(dir, "tmux.sock");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function run(dir: string, args: readonly string[], stdin?: string): CommandResult {
  const result = spawnSync("tmux", ["-S", socketOf(dir), ...args], {
    encoding: "utf8",
    timeout: CONTROL_TIMEOUT_MS,
    ...(stdin === undefined ? {} : { input: stdin }),
  });
  if (result.error !== undefined) throw new AsyncShellError("tmux_unavailable", describe(result.error));
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runOk(dir: string, args: readonly string[], code: string, stdin?: string): CommandResult {
  const result = run(dir, args, stdin);
  if (result.code !== 0) {
    throw new AsyncShellError(code, `tmux ${args[0] ?? ""} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`);
  }
  return result;
}

function assertAvailable(): void {
  if (process.platform === "win32") {
    throw new AsyncShellError("unsupported_platform", "The POSIX tmux backend is not available on Windows.");
  }
  const probe = spawnSync("tmux", ["-V"], { encoding: "utf8", timeout: CONTROL_TIMEOUT_MS });
  if (probe.error !== undefined || probe.status !== 0) {
    throw new AsyncShellError("tmux_unavailable", "tmux is required for async shell tasks and was not found.");
  }
}

function killServer(dir: string): void {
  run(dir, ["kill-server"]);
}

function serverRunning(dir: string): boolean {
  return run(dir, ["list-sessions"]).code === 0;
}

function start(dir: string, selfArgv: readonly string[], rawPath: string): void {
  runOk(dir, ["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", selfArgv.map(shellQuote).join(" ")], "session_failed");
  runOk(dir, ["pipe-pane", "-t", SESSION, "-o", `cat >> ${shellQuote(rawPath)}`], "capture_failed");
}

function sendInput(dir: string, input: string): void {
  if (input === "") return;
  const buffer = `pi-${path.basename(dir)}`;
  runOk(dir, ["load-buffer", "-b", buffer, "-"], "send_failed", input);
  try {
    runOk(dir, ["paste-buffer", "-p", "-r", "-b", buffer, "-t", SESSION], "send_failed");
  } finally {
    run(dir, ["delete-buffer", "-b", buffer]);
  }
}

function sendKey(dir: string, key: string): void {
  runOk(dir, ["send-keys", "-t", SESSION, key], "send_failed");
}

function paneGone(dir: string): boolean {
  const result = run(dir, ["display-message", "-p", "-t", SESSION, "#{pane_dead}"]);
  return result.code !== 0 || result.stdout.trim() !== "0";
}

function ownsProcess(pid: number, marker: string, dir: string): boolean {
  const probe = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: CONTROL_TIMEOUT_MS });
  if (probe.error !== undefined || probe.status !== 0) return false;
  const command = probe.stdout ?? "";
  return command.includes(marker) && command.includes(dir);
}

export const posixBackend: ShellBackend = {
  kind: "posix",
  assertAvailable,
  run,
  killServer,
  serverRunning,
  start,
  sendInput,
  sendKey,
  paneGone,
  ownsProcess,
};
