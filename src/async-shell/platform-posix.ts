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
import {
  CONTROL_TIMEOUT_MS,
  pasteLiteral,
  SESSION,
  type CommandResult,
  type ControlClient,
  type ShellBackend,
} from "./platform.ts";

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
  pasteLiteral(client, dir, input, SESSION);
}

function sendKey(dir: string, key: string): void {
  runOk(dir, ["send-keys", "-t", SESSION, key], "send_failed");
}

function paneGone(dir: string): boolean {
  const result = run(dir, ["display-message", "-p", "-t", SESSION, "#{pane_dead}"]);
  return result.code !== 0 || result.stdout.trim() !== "0";
}

/**
 * Whether `pid` is provably this task's own process.
 *
 * A bare boolean cannot carry "I could not look": a cancelled task must keep its
 * resource fence when the control query itself failed, instead of recording a
 * cleanup that was never proved. So an unavailable `ps`, a timeout, or an
 * unexpected status throws; `false` means the query succeeded and showed either
 * no such process or a foreign command line.
 */
function ownsProcess(pid: number, marker: string, dir: string): boolean {
  const probe = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: CONTROL_TIMEOUT_MS,
  });
  if (probe.error !== undefined) {
    throw new AsyncShellError("process_inspection_failed", `Could not inspect pid ${String(pid)}: ${describe(probe.error)}`);
  }
  const command = (probe.stdout ?? "").trim();
  if (probe.status !== 0) {
    // POSIX ps exits 1 with no output for a pid that does not exist.
    if (probe.status === 1 && command === "" && probe.stderr.trim() === "") return false;
    throw new AsyncShellError(
      "process_inspection_failed",
      `Could not inspect pid ${String(pid)}: ps exited ${String(probe.status)} ${probe.stderr.trim()}`,
    );
  }
  if (command === "") {
    throw new AsyncShellError("process_inspection_failed", `Could not read the command line of pid ${String(pid)}.`);
  }
  return command.includes(marker) && command.includes(dir);
}

const client: ControlClient = { run, runOk };

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
