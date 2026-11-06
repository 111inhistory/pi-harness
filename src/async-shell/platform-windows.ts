/**
 * Windows backend: one private `psmux` server per task, addressed by a label.
 *
 * `psmux` (3.4.0+) is a native Windows tmux port driving ConPTY, so the pane's
 * process gets a real console: `stdin.isTTY` and `stdout.isTTY` are both true and
 * the window size is available. There is no socket file to own, so a task is
 * addressed only by its label (`pi-job-<task id>`) and liveness is answered by
 * the server itself.
 *
 * Two behaviours differ from POSIX and are handled here, not above:
 * - The pane command is passed as structured arguments (psmux quotes them), so
 *   the runner is started without any shell at all.
 * - Input is delivered through the multiplexer's own literal buffer (payload on
 *   stdin, one bracketed paste), exactly like POSIX: base64 or other payload on
 *   the command line would cross the 32767-character Windows command line at
 *   ~24 KiB of input, and `send-paste` rewrote the payload's newline.
 *   `pipe-pane 'cat >> "<path>"'` is served by the psmux server itself, so
 *   capture never runs through a Windows shell.
 */

import { spawnSync } from "node:child_process";

import { AsyncShellError } from "./errors.ts";
import {
  CONTROL_TIMEOUT_MS,
  pasteLiteral,
  SESSION,
  type CommandResult,
  type ControlClient,
  type ShellBackend,
} from "./platform.ts";

const BINARY = "psmux.exe";
const MIN_VERSION: readonly [number, number, number] = [3, 4, 0];
/** A process query is a bounded probe, never a wait. */
const OWNERSHIP_TIMEOUT_MS = 10_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The label of this task's own server; the id is the task directory's name. */
function labelOf(dir: string): string {
  const name = dir.split(/[\\/]/).filter((part) => part !== "").pop() ?? "";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new AsyncShellError("invalid_task_id", `Not usable as a psmux label: ${name}`);
  }
  return `pi-job-${name}`;
}

function run(dir: string, args: readonly string[], stdin?: string): CommandResult {
  const result = spawnSync(BINARY, ["-L", labelOf(dir), ...args], {
    encoding: "utf8",
    timeout: CONTROL_TIMEOUT_MS,
    windowsHide: true,
    ...(stdin === undefined ? {} : { input: stdin }),
  });
  if (result.error !== undefined) throw new AsyncShellError("psmux_unavailable", describe(result.error));
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runOk(dir: string, args: readonly string[], code: string, stdin?: string): CommandResult {
  const result = run(dir, args, stdin);
  if (result.code !== 0) {
    throw new AsyncShellError(code, `psmux ${args[0] ?? ""} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`);
  }
  return result;
}

function parseVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (match === null) return null;
  return [Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10), Number.parseInt(match[3] ?? "0", 10)];
}

function atLeast(found: readonly [number, number, number], wanted: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    const left = found[index] ?? 0;
    const right = wanted[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function assertAvailable(): void {
  if (process.platform !== "win32") {
    throw new AsyncShellError("unsupported_platform", "The psmux backend is only available on Windows.");
  }
  const probe = spawnSync(BINARY, ["-V"], { encoding: "utf8", timeout: CONTROL_TIMEOUT_MS, windowsHide: true });
  if (probe.error !== undefined || probe.status !== 0) {
    throw new AsyncShellError("psmux_unavailable", "psmux 3.4.0 or newer is required for async shell tasks and was not found on PATH.");
  }
  const version = parseVersion(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`);
  if (version === null || !atLeast(version, MIN_VERSION)) {
    throw new AsyncShellError("psmux_version", `async shell tasks require psmux 3.4.0 or newer; found ${version === null ? "an unknown version" : version.join(".")}.`);
  }
}

function killServer(dir: string): void {
  run(dir, ["kill-server"]);
}

function serverRunning(dir: string): boolean {
  return run(dir, ["list-sessions"]).code === 0;
}

/** The server itself writes the pane's raw bytes; no shell is involved. */
function captureSink(rawPath: string): string {
  if (rawPath.includes('"')) {
    throw new AsyncShellError("invalid_path", `The capture log path cannot contain a quote: ${rawPath}`);
  }
  return `cat >> "${rawPath}"`;
}

function start(dir: string, selfArgv: readonly string[], rawPath: string): void {
  runOk(dir, ["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", "--", ...selfArgv], "session_failed");
  runOk(dir, ["pipe-pane", "-o", "-t", SESSION, captureSink(rawPath)], "capture_failed");
}

function sendInput(dir: string, input: string): void {
  if (input === "") return;
  // The payload travels on stdin, not on the command line: Windows caps a
  // process command line at 32767 UTF-16 characters, and base64 on argv would
  // cross it at ~24 KiB of input. One buffer, one paste, nothing interpreted.
  pasteLiteral(client, dir, input, SESSION);
}

function sendKey(dir: string, key: string): void {
  runOk(dir, ["send-keys", "-t", SESSION, key], "send_failed");
}

function paneGone(dir: string): boolean {
  const result = run(dir, ["display-message", "-p", "-t", SESSION, "#{pane_dead}"]);
  return result.code !== 0 || result.stdout.trim() !== "0";
}

/** `pwsh` when present, else Windows PowerShell; both are queried the same way. */
function shellForQuery(): readonly string[] {
  for (const candidate of ["pwsh", "powershell"]) {
    const probe = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
      timeout: 5_000,
      windowsHide: true,
    });
    if (probe.error === undefined && probe.status === 0) return [candidate, "-NoProfile", "-NonInteractive", "-Command"];
  }
  throw new AsyncShellError(
    "process_inspection_failed",
    "Neither pwsh nor Windows PowerShell could be started to inspect process ownership; the task fence is kept.",
  );
}

/**
 * A pid alone proves nothing: Windows recycles pids. The command line is read
 * back and must show this task's own marker and directory before a signal.
 *
 * The query answers three distinct things and they must not collapse into one
 * boolean: the process is gone, the process is someone else's, or the query
 * itself failed. Only the first two may release a cancellation fence.
 */
function ownsProcess(pid: number, marker: string, dir: string): boolean {
  const shell = shellForQuery();
  // The command line must be read as UTF-8: a task directory may be non-ASCII,
  // and Windows PowerShell defaults to the console code page. A command line that
  // cannot be read back proves nothing, so the caller keeps its fence.
  // Report absence, unreadable metadata, or the command line explicitly.
  const script = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop`,
    `$answer = 'absent'`,
    `if ($p) { $answer = 'unreadable' }`,
    `if ($p -and -not [string]::IsNullOrEmpty($p.CommandLine)) { $answer = 'cmd:' + $p.CommandLine }`,
    "[Console]::Out.Write($answer)",
  ].join("; ");
  const probe = spawnSync(shell[0]!, [...shell.slice(1), script], {
    encoding: "utf8",
    timeout: OWNERSHIP_TIMEOUT_MS,
    windowsHide: true,
  });
  if (probe.error !== undefined) {
    throw new AsyncShellError("process_inspection_failed", `Could not inspect pid ${String(pid)}: ${describe(probe.error)}`);
  }
  if (probe.status !== 0) {
    throw new AsyncShellError(
      "process_inspection_failed",
      `Could not inspect pid ${String(pid)}: the process query exited ${String(probe.status)} ${(probe.stderr ?? "").trim()}`,
    );
  }
  const answer = (probe.stdout ?? "").trim();
  if (answer === "absent") return false;
  if (!answer.startsWith("cmd:")) {
    throw new AsyncShellError("process_inspection_failed", `Could not read the command line of pid ${String(pid)}.`);
  }
  const command = answer.slice("cmd:".length);
  return command.includes(marker) && command.includes(dir);
}

const client: ControlClient = { run, runOk };

export const windowsBackend: ShellBackend = {
  kind: "windows",
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
