/**
 * Async-shell task engine, shared by every platform.
 *
 * A task owns one private multiplexer server: `tmux` on POSIX, `psmux` on
 * Windows (see `platform*.ts`). Either way the server is addressed only by the
 * task directory, so a task can never reach the user's own sessions. The pane
 * runs this same binary in `__run` mode; the real command's argv is written to
 * the task file and handed to `spawn`, so an executable target is never touched
 * by a shell. The one exception is a Windows `.cmd`/`.bat` target, which no
 * process can start without `cmd.exe`; `platform.ts` escapes its arguments for
 * exactly that one hop and refuses only what cmd cannot represent.
 *
 * Capture starts before the command: the pane is attached to a `pipe-pane` raw
 * log, the runner announces itself with an OSC marker that the filter strips,
 * and only when the monitor has seen that marker in the raw log (proof the pipe
 * is live) does the runner start the command. A detached per-task monitor
 * (`__monitor`) tails the raw log through `OutputFilter`, writes the complete
 * filtered transcript, enforces the timeout, and sends the one `complete` frame.
 * There is no global daemon and no cross-task state.
 *
 * Cancellation kills the task's own server: the pane's process group is hung up,
 * which stops the runner and the command, and `cancelTask` waits until the
 * monitor has finalized the task and finished its cleanup.
 */

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensurePrivateDirectory } from "../ipc/endpoint.ts";
import { writeSocket } from "../ipc/socket.ts";
import { AsyncShellError } from "./errors.ts";
import { isTaskId } from "./task-id.ts";
import { samePath } from "../fs-path.ts";
import { OutputFilter } from "./output.ts";
import {
  childCommand,
  selfArgv,
  SESSION,
  type ShellBackend,
} from "./platform.ts";
import { posixBackend } from "./platform-posix.ts";
import { windowsBackend } from "./platform-windows.ts";
import {
  ASYNC_SHELL_KIND,
  MAX_RESULT_BYTES,
  type AsyncShellFrame,
  type ShellResult,
  type ShellStatus,
} from "./protocol.ts";

/** The multiplexer backend this process drives. */
const backend: ShellBackend = process.platform === "win32" ? windowsBackend : posixBackend;

const MONITOR_TICK_MS = 60;
const QUIET_FLUSH_MS = 150;
const DRAIN_QUIET_MS = 200;
const DRAIN_LIMIT_MS = 5000;
const CANCEL_WAIT_MS = 15000;
/**
 * How long `create` waits for the command to actually start when the caller did
 * not ask to wait for a result. It never shortens the reply of a task that did
 * start, and it never delays a final result.
 */
const STARTUP_WAIT_MS = 5000;
/** How long the monitor waits for the creator's delivery decision, then notifies. */
const DECISION_WAIT_MS = 3000;
const CAPTURE_WAIT_MS = 20000;
/** Input is bounded at the stream boundary, before any buffer grows. */
export const MAX_SEND_BYTES = 64 * 1024;
/** Each capture read is bounded; a pump still drains the backlog in full. */
const READ_CHUNK_BYTES = 64 * 1024;
/** Announced by the runner; the filter removes it, so it never reaches a response. */
const CAPTURE_MARKER = "\u001b]5511;pi-async-capture\u0007";

export interface TaskPaths {
  readonly dir: string;
  readonly task: string;
  readonly state: string;
  readonly raw: string;
  readonly filtered: string;
  readonly captureOk: string;
  readonly exit: string;
  readonly cancel: string;
  readonly closed: string;
  /** The creator's one decision: this reply returned the result, or a later completion will. */
  readonly delivery: string;
  readonly pollCursor: string;
  readonly monitorPid: string;
  readonly runnerPid: string;
  readonly childPid: string;
}

export interface CallbackTarget {
  readonly socket: string;
  readonly token: string;
}

interface TaskFile {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly createdAt: number;
  /** How long the creator asked to wait for a result; 0 returns once the command starts. */
  readonly waitMs: number;
  readonly timeoutMs: number | null;
}

interface TaskState {
  readonly id: string;
  readonly status: ShellStatus;
  readonly exitCode: number | null;
  readonly createdAt: number;
  readonly finalizedAt: number | null;
}

interface ExitFile {
  readonly code: number | null;
  readonly signal: string | null;
  readonly error: string | null;
}

/** Fail with an actionable error unless this platform's multiplexer can run. */
function assertSupported(): void {
  backend.assertAvailable();
}

export function stateRoot(): string {
  return path.resolve(process.env["PI_ASYNC_SHELL_ROOT"] || path.join(os.tmpdir(), `pi-async-shell-${process.getuid?.() ?? 0}`));
}

export function taskDirectory(id: string, root = stateRoot()): string {
  if (!isTaskId(id)) {
    throw new AsyncShellError("invalid_id", `Not an async-shell task id: ${id}`);
  }
  return path.join(root, id);
}

/**
 * A task directory is `<stateRoot>/<id>` and nothing else. `cancelTask` is called
 * with a directory that arrived in an external frame, so the shape is checked
 * here instead of trusting the caller: a task may only ever stop its own server.
 */
function checkedTaskDirectory(dir: string, root: string): string {
  const resolved = path.resolve(dir);
  if (!samePath(path.dirname(resolved), root) || !isTaskId(path.basename(resolved))) {
    throw new AsyncShellError("invalid_directory", `Not an async-shell task directory under ${root}: ${dir}`);
  }
  return resolved;
}

function taskPaths(dir: string): TaskPaths {
  const file = (name: string): string => path.join(dir, name);
  return {
    dir,
    task: file("task.json"),
    state: file("state.json"),
    raw: file("raw.log"),
    filtered: file("output.log"),
    captureOk: file("capture-ok"),
    exit: file("exit.json"),
    cancel: file("cancel.requested"),
    closed: file("closed"),
    delivery: file("delivery.json"),
    pollCursor: file("poll.cursor"),
    monitorPid: file("monitor.pid"),
    runnerPid: file("runner.pid"),
    childPid: file("child.pid"),
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readTaskFile(paths: TaskPaths): TaskFile {
  const value = readJson(paths.task);
  if (!record(value)) throw new AsyncShellError("task_missing", `No async-shell task at ${paths.dir}.`);
  const { id, argv, cwd, createdAt, waitMs, timeoutMs } = value;
  if (typeof id !== "string" || !Array.isArray(argv) || argv.length === 0 || !argv.every((item) => typeof item === "string")) {
    throw new AsyncShellError("task_corrupt", `The task file at ${paths.task} is not readable.`);
  }
  if (typeof cwd !== "string" || typeof createdAt !== "number" || typeof waitMs !== "number") {
    throw new AsyncShellError("task_corrupt", `The task file at ${paths.task} is not readable.`);
  }
  if (timeoutMs !== null && typeof timeoutMs !== "number") {
    throw new AsyncShellError("task_corrupt", `The task file at ${paths.task} is not readable.`);
  }
  return { id, argv: argv as string[], cwd, createdAt, waitMs, timeoutMs: timeoutMs as number | null };
}

function readStateFile(paths: TaskPaths, task: TaskFile): TaskState {
  const value = readJson(paths.state);
  if (!record(value)) return { id: task.id, status: "running", exitCode: null, createdAt: task.createdAt, finalizedAt: null };
  const { status, exitCode, finalizedAt } = value;
  const known = status === "running" || status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";
  return {
    id: task.id,
    status: known ? status : "running",
    exitCode: typeof exitCode === "number" ? exitCode : null,
    createdAt: typeof value["createdAt"] === "number" ? value["createdAt"] : task.createdAt,
    finalizedAt: typeof finalizedAt === "number" ? finalizedAt : null,
  };
}

function writeState(paths: TaskPaths, state: TaskState): void {
  writeJsonAtomic(paths.state, state);
}

/** The last complete UTF-8 sequence boundary at or before `length`. */
function utf8Boundary(buffer: Buffer, length: number): number {
  if (length <= 0) return 0;
  for (let back = 1; back <= 4 && length - back >= 0; back += 1) {
    const byte = buffer[length - back]!;
    if (byte < 0x80) return length;
    if (byte >= 0xc0) {
      const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
      return back >= needed ? length : length - back;
    }
  }
  return length;
}

export interface OutputChunk {
  readonly text: string;
  /** Byte offset just past the returned text. Never inside a character. */
  readonly cursor: number;
  /** More filtered output remains after this chunk. */
  readonly truncated: boolean;
}

/** Read at most one bounded, character-aligned chunk of the filtered log. */
function readOutput(file: string, cursor: number): OutputChunk {
  let handle: number;
  try {
    handle = fs.openSync(file, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { text: "", cursor: Math.max(0, cursor), truncated: false };
    throw error;
  }
  try {
    const size = fs.fstatSync(handle).size;
    const start = Math.min(Math.max(0, cursor), size);
    if (start >= size) return { text: "", cursor: start, truncated: false };
    const want = Math.min(MAX_RESULT_BYTES, size - start);
    const buffer = Buffer.allocUnsafe(want);
    const read = fs.readSync(handle, buffer, 0, want, start);
    const length = utf8Boundary(buffer, read);
    const next = start + length;
    return { text: buffer.subarray(0, length).toString("utf8"), cursor: next, truncated: next < size };
  } finally {
    fs.closeSync(handle);
  }
}

function readCursor(paths: TaskPaths): number {
  try {
    const value = Number.parseInt(fs.readFileSync(paths.pollCursor, "utf8").trim(), 10);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function hasMore(file: string, cursor: number): boolean {
  try {
    return fs.statSync(file).size > cursor;
  } catch {
    return false;
  }
}

function resultOf(paths: TaskPaths, state: TaskState, cursor: number): ShellResult {
  const chunk = readOutput(paths.filtered, cursor);
  return {
    id: state.id,
    status: state.status,
    exitCode: state.exitCode,
    output: chunk.text,
    cursor: chunk.cursor,
    logPath: paths.filtered,
    truncated: chunk.truncated,
  };
}

/**
 * The default consumption pointer: the byte offset this caller has already been
 * given. Every answer that carries text advances it; `read` never does.
 */
function consumeOutput(paths: TaskPaths, state: TaskState): ShellResult {
  const result = resultOf(paths, state, readCursor(paths));
  fs.writeFileSync(paths.pollCursor, `${result.cursor}\n`, { mode: 0o600 });
  return result;
}

/** Status at the current cursor, carrying no text and consuming nothing. */
function statusResult(paths: TaskPaths, state: TaskState): ShellResult {
  const cursor = readCursor(paths);
  return {
    id: state.id,
    status: state.status,
    exitCode: state.exitCode,
    output: "",
    cursor,
    logPath: paths.filtered,
    truncated: hasMore(paths.filtered, cursor),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function readPid(file: string): number | null {
  try {
    const value = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function exists(file: string): boolean {
  return fs.existsSync(file);
}

/**
 * The creator's delivery decision: `sync` means this reply already carried the
 * final result, `async` means a later completion must be notified. Without a
 * decision (a creator that died) a completion is notified, never dropped.
 */
async function readDelivery(paths: TaskPaths, timeoutMs: number): Promise<"sync" | "async"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = readJson(paths.delivery);
    if (record(value) && value["mode"] === "sync") return "sync";
    if (record(value) && value["mode"] === "async") return "async";
    if (Date.now() >= deadline) return "async";
    await sleep(25);
  }
}

async function sendFrame(target: CallbackTarget, frame: AsyncShellFrame): Promise<void> {
  try {
    await writeSocket(target.socket, frame);
  } catch (error) {
    const code = errorCode(error) === "registration_rejected" ? "registration_rejected" : "callback_failed";
    throw new AsyncShellError(code, `The async-shell host did not accept a frame: ${messageOf(error)}`);
  }
}

/** Read the callback target from the environment; null keeps the CLI standalone. */
export function callbackFromEnv(env: NodeJS.ProcessEnv): CallbackTarget | null {
  const unavailable = env['PI_ASYNC_SHELL_HOST_ERROR'];
  if (unavailable) throw new AsyncShellError('host_unavailable', `The async-shell callback host is unavailable: ${unavailable}`);
  const socket = env["PI_AGENT_SOCKET"];
  const token = env["PI_ASYNC_SHELL_TOKEN"];
  if (typeof socket !== "string" || socket === "" || typeof token !== "string" || token === "") return null;
  return { socket, token };
}

export interface CreateTaskOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number | null;
  readonly waitMs: number;
  readonly callback: CallbackTarget | null;
}

/**
 * Start one task. Registration completes before the command can run, so a host
 * that admits the task can always account for it; a start failure reports the
 * failure through `complete` and leaves nothing running.
 */
export async function createTask(options: CreateTaskOptions): Promise<ShellResult> {
  assertSupported();
  if (options.argv.length === 0) throw new AsyncShellError("invalid_command_args", "create requires a command.");
  const root = stateRoot();
  ensurePrivateDirectory(root);
  let id: string;
  let dir: string;
  for (;;) {
    id = `job_${crypto.randomBytes(4).toString("hex")}`;
    dir = taskDirectory(id, root);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  ensurePrivateDirectory(dir);
  const paths = taskPaths(dir);
  const createdAt = Date.now();
  const task: TaskFile = {
    id,
    argv: options.argv,
    cwd: options.cwd,
    createdAt,
    waitMs: options.waitMs,
    timeoutMs: options.timeoutMs,
  };
  writeJsonAtomic(paths.task, task);
  fs.writeFileSync(paths.raw, "", { mode: 0o600 });
  fs.writeFileSync(paths.filtered, "", { mode: 0o600 });

  if (options.callback !== null) {
    try {
      await sendFrame(options.callback, {
        kind: ASYNC_SHELL_KIND, token: options.callback.token, operation: "register", id, directory: dir, pid: process.pid,
      });
    } catch (error) {
      // Keep ambiguous submissions fenced and never replay registration. A
      // distinct completion releases a possibly accepted submission; an explicit
      // registration rejection proves this submission needs no unregistration.
      const state: TaskState = { id, status: "failed", exitCode: null, createdAt, finalizedAt: Date.now() };
      fs.appendFileSync(paths.filtered, `async-shell: ${messageOf(error)}\n`);
      writeState(paths, state);
      fs.writeFileSync(paths.closed, "", { mode: 0o600 });
      if (errorCode(error) !== "registration_rejected") {
        try {
          await sendFrame(options.callback, {
            kind: ASYNC_SHELL_KIND, token: options.callback.token, operation: "complete", id, notify: false,
            result: consumeOutput(paths, state),
          });
        } catch {
          // Still ambiguous: the directory stays closed, so a later release is a no-op.
        }
      }
      throw new AsyncShellError(
        "register_failed",
        `The async-shell host did not accept the registration of task ${id}: ${messageOf(error)}. The task directory ${dir} was kept and released; re-running create starts a new task.`,
      );
    }
  }

  const failed = (message: string): ShellResult => {
    backend.killServer(dir);
    const state: TaskState = { id, status: "failed", exitCode: null, createdAt, finalizedAt: Date.now() };
    fs.appendFileSync(paths.filtered, `async-shell: ${message}\n`);
    writeState(paths, state);
    return consumeOutput(paths, state);
  };

  try {
    backend.start(dir, selfArgv(dir, "__run"), paths.raw);
    const monitor = spawn(process.execPath, [...process.execArgv, path.resolve(process.argv[1]!), "__monitor", dir], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    monitor.unref();
    if (monitor.pid !== undefined) fs.writeFileSync(paths.monitorPid, `${monitor.pid}\n`, { mode: 0o600 });
  } catch (error) {
    const result = failed(messageOf(error));
    if (options.callback !== null) {
      await sendFrame(options.callback, {
        kind: ASYNC_SHELL_KIND, token: options.callback.token, operation: "complete", id, notify: false, result,
      });
    }
    throw new AsyncShellError("start_failed", messageOf(error));
  }

  // One explicit decision, taken here and honoured by the monitor: a reply that
  // carries the final result is not notified again, and a reply that only carries
  // a running id is always notified later. There is no hidden wait floor.
  const decide = (mode: "sync" | "async", state: TaskState): ShellResult => {
    // The reply owns its chunk first: the cursor is recorded before the decision
    // exists, so the monitor can never take text this reply already returned.
    const result = consumeOutput(paths, state);
    fs.writeFileSync(paths.delivery, `${JSON.stringify({ mode })}\n`, { mode: 0o600 });
    return result;
  };
  // An explicit --wait is honoured exactly; `--wait 0` is the only value that
  // uses the startup bound, so a zero-wait reply never hides a completion.
  const waitDeadline = createdAt + (task.waitMs === 0 ? STARTUP_WAIT_MS : task.waitMs);
  for (;;) {
    const state = readStateFile(paths, task);
    if (state.finalizedAt !== null) return decide("sync", state);
    // A zero wait returns `create` once the command actually runs.
    if (task.waitMs === 0 && exists(paths.childPid)) return decide("async", state);
    if (Date.now() >= waitDeadline) return decide("async", state);
    await sleep(MONITOR_TICK_MS / 2);
  }
}

/** Nonblocking incremental read. `cursor` defaults to the last polled position. */
export function pollTask(dir: string, cursor: number | null): ShellResult {
  const paths = taskPaths(dir);
  const task = readTaskFile(paths);
  const state = readStateFile(paths, task);
  if (cursor !== null) {
    const explicit = resultOf(paths, state, cursor);
    fs.writeFileSync(paths.pollCursor, `${explicit.cursor}\n`, { mode: 0o600 });
    return explicit;
  }
  return consumeOutput(paths, state);
}

/** A deliberate replay from `cursor` (default the beginning); never consumes. */
export function readTask(dir: string, cursor: number | null): ShellResult {
  const paths = taskPaths(dir);
  const task = readTaskFile(paths);
  return resultOf(paths, readStateFile(paths, task), cursor ?? 0);
}

function requireRunning(paths: TaskPaths): TaskFile {
  const task = readTaskFile(paths);
  if (readStateFile(paths, task).status !== "running") {
    throw new AsyncShellError("task_finished", `Task ${task.id} is no longer running.`);
  }
  return task;
}

/**
 * Paste literal bytes into the task's pane, optionally followed by Enter.
 *
 * The bytes are moved through a per-task tmux buffer and `paste-buffer`, so a
 * bracketed-paste-aware target keeps its own interpretation of newlines and
 * multi-line input cannot execute line by line the way `send-keys -l` would. The
 * input is never filtered, trimmed or re-encoded: a heredoc's final newline is
 * part of the payload, and `--enter` only adds the Enter key after it.
 */
export function sendInput(dir: string, input: string, enter: boolean): void {
  const paths = taskPaths(dir);
  requireRunning(paths);
  if (Buffer.byteLength(input, "utf8") > MAX_SEND_BYTES) {
    throw new AsyncShellError("input_too_large", `Input must not exceed ${MAX_SEND_BYTES} bytes.`);
  }
  backend.sendInput(dir, input);
  if (enter) backend.sendKey(dir, "Enter");
}

/** Send one named key (Enter, C-c, Up, BSpace, ...). */
export function sendKey(dir: string, key: string): void {
  const paths = taskPaths(dir);
  requireRunning(paths);
  if (!/^[A-Za-z0-9-]{1,32}$/.test(key)) {
    throw new AsyncShellError("invalid_key", `Not a tmux key name: ${key}`);
  }
  backend.sendKey(dir, key);
}

/**
 * Cancel one task and wait for its monitor to finish cleanup, so a retiring root
 * can fence the resource. Idempotent; a finished task resolves immediately.
 */
export async function cancelTask(dir: string, root = stateRoot()): Promise<void> {
  const paths = taskPaths(checkedTaskDirectory(dir, root));
  if (exists(paths.closed)) return;
  const task = readTaskFile(paths);
  fs.writeFileSync(paths.cancel, "", { mode: 0o600 });
  backend.killServer(paths.dir);
  if (await waitForClose(paths, 400)) return;
  if (backend.serverRunning(paths.dir)) {
    throw new AsyncShellError("cancel_incomplete", `The multiplexer server of task ${task.id} did not stop.`);
  }

  // The monitor is the only finalizer. It is given the cancellation deadline, and
  // its pid is only ever signalled when the command line proves it is this task's
  // monitor: a recycled pid is a different process.
  const monitorPid = readPid(paths.monitorPid);
  const ours = monitorPid !== null && alive(monitorPid) && backend.ownsProcess(monitorPid, "__monitor", paths.dir);
  if (ours && await waitForClose(paths, CANCEL_WAIT_MS)) return;
  if (ours && monitorPid !== null) {
    try { process.kill(monitorPid, "SIGKILL"); } catch { /* already gone */ }
    if (await waitForClose(paths, 2000)) return;
  }
  if (await waitForClose(paths, 200)) return;

  if (backend.serverRunning(paths.dir)) {
    throw new AsyncShellError("cancel_incomplete", `The multiplexer server of task ${task.id} is still running.`);
  }
  if (monitorPid !== null && alive(monitorPid) && backend.ownsProcess(monitorPid, "__monitor", paths.dir)) {
    // The monitor neither finalized nor died: keep the fence instead of claiming
    // a cleanup that cannot be proved.
    throw new AsyncShellError("cancel_incomplete", `The monitor of task ${task.id} did not report cleanup.`);
  }

  // No server and no monitor for this task remain: finalize the state here.
  const state = readStateFile(paths, task);
  if (state.status === "running") {
    writeState(paths, { id: task.id, status: "cancelled", exitCode: null, createdAt: task.createdAt, finalizedAt: Date.now() });
  }
  fs.writeFileSync(paths.closed, "", { mode: 0o600 });
}

async function waitForClose(paths: TaskPaths, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exists(paths.closed)) return true;
    await sleep(MONITOR_TICK_MS);
  }
  return exists(paths.closed);
}

function writeExit(paths: TaskPaths, exit: ExitFile): void {
  try {
    writeJsonAtomic(paths.exit, exit);
  } catch {
    // The monitor's runner-liveness fallback reports the missing status.
  }
}

/** Internal mode: the pane process that waits for capture, then runs the command. */
export async function runnerMain(dir: string): Promise<number> {
  const paths = taskPaths(dir);
  const task = readTaskFile(paths);
  fs.writeFileSync(paths.runnerPid, `${process.pid}\n`, { mode: 0o600 });

  // Announce readiness through the PTY until the monitor confirms it saw the
  // marker in the raw log: only then is the capture pipe live, so the command
  // cannot run before capture starts. The filter strips the marker.
  const captureDeadline = Date.now() + CAPTURE_WAIT_MS;
  while (!exists(paths.captureOk)) {
    if (Date.now() > captureDeadline) {
      writeExit(paths, { code: null, signal: null, error: "capture did not start" });
      return 1;
    }
    process.stdout.write(CAPTURE_MARKER);
    await sleep(40);
  }

  let child: ChildProcess;
  try {
    const command = childCommand(task.argv, process.platform, process.env, task.cwd);
    child = spawn(command.file, [...command.args], {
      cwd: task.cwd,
      env: process.env,
      stdio: "inherit",
      windowsVerbatimArguments: command.verbatim,
    });
  } catch (error) {
    writeExit(paths, { code: null, signal: null, error: messageOf(error) });
    return 1;
  }
  if (child.pid !== undefined) fs.writeFileSync(paths.childPid, `${child.pid}\n`, { mode: 0o600 });

  const stopped = (signal: NodeJS.Signals): void => {
    if (child.pid !== undefined) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    writeExit(paths, { code: null, signal, error: null });
    setTimeout(() => process.exit(0), 150);
  };
  process.on("SIGTERM", stopped);
  process.on("SIGHUP", stopped);
  process.on("SIGINT", stopped);

  return await new Promise<number>((resolve) => {
    child.once("exit", (code, signal) => {
      writeExit(paths, { code, signal, error: null });
      resolve(0);
    });
    child.once("error", (error) => {
      writeExit(paths, { code: null, signal: null, error: messageOf(error) });
      resolve(1);
    });
  });
}

/** Internal mode: the detached per-task monitor. */
export async function monitorMain(dir: string): Promise<void> {
  const paths = taskPaths(dir);
  if (exists(paths.closed)) return;
  const task = readTaskFile(paths);
  writeState(paths, { id: task.id, status: "running", exitCode: null, createdAt: task.createdAt, finalizedAt: null });

  const filter = new OutputFilter();
  let rawOffset = 0;
  let probe = "";
  let captureOk = false;
  let lastGrowth = Date.now();
  let lastFlush = Date.now();
  let cancelled = false;
  let timedOut = false;
  let closing = false;

  // One pump drains everything the raw log currently holds, in bounded reads, so
  // a large backlog is never allocated at once and never left behind a quiet tick.
  const pump = (): boolean => {
    let handle: number;
    try {
      handle = fs.openSync(paths.raw, "r");
    } catch {
      return false;
    }
    let grew = false;
    try {
      const size = fs.fstatSync(handle).size;
      for (;;) {
        // Drain only this snapshot: a producer faster than the filter must not
        // keep us here forever and starve cancellation or timeout checks.
        if (rawOffset >= size) break;
        const want = Math.min(READ_CHUNK_BYTES, size - rawOffset);
        const buffer = Buffer.allocUnsafe(want);
        const read = fs.readSync(handle, buffer, 0, want, rawOffset);
        if (read <= 0) break;
        rawOffset += read;
        grew = true;
        const chunk = buffer.subarray(0, read);
        probe = (probe + chunk.toString("latin1")).slice(-256);
        if (!captureOk && probe.includes(CAPTURE_MARKER)) {
          captureOk = true;
          fs.writeFileSync(paths.captureOk, "", { mode: 0o600 });
        }
        const text = filter.write(chunk);
        if (text !== "") fs.appendFileSync(paths.filtered, text, { mode: 0o600 });
      }
    } finally {
      fs.closeSync(handle);
    }
    return grew;
  };

  const flushPending = (force: boolean): void => {
    if (!force && (Date.now() - lastGrowth < QUIET_FLUSH_MS || Date.now() - lastFlush < QUIET_FLUSH_MS)) return;
    const text = filter.flush();
    if (text !== "") fs.appendFileSync(paths.filtered, text, { mode: 0o600 });
    lastFlush = Date.now();
  };

  const paneAlive = (): boolean => !backend.paneGone(dir);

  const finish = async (): Promise<void> => {
    // Drain the capture pipe: the pane is (or soon will be) gone, so the raw log
    // stops growing; only then may the last bytes be attributed.
    const startedAt = Date.now();
    let quietSince = Date.now();
    let nextProbe = 0;
    for (;;) {
      if (pump()) quietSince = Date.now();
      if (Date.now() - quietSince >= DRAIN_QUIET_MS) {
        let busy = false;
        if (Date.now() >= nextProbe) {
          nextProbe = Date.now() + 200;
          busy = paneAlive();
        }
        if (!busy) break;
      }
      if (Date.now() - startedAt > DRAIN_LIMIT_MS) break;
      await sleep(25);
    }
    pump();
    flushPending(true);

    const value = readJson(paths.exit);
    const exit = record(value) && "code" in value ? value as unknown as ExitFile : null;
    let status: ShellStatus = "failed";
    let exitCode: number | null = null;
    if (cancelled) {
      status = "cancelled";
    } else if (timedOut) {
      status = "timed_out";
    } else if (exit !== null) {
      exitCode = typeof exit.code === "number" ? exit.code : null;
      status = exit.error === null && exitCode === 0 && exit.signal === null ? "completed" : "failed";
      if (exit.error !== null) fs.appendFileSync(paths.filtered, `async-shell: ${exit.error}\n`);
      if (exit.signal !== null) fs.appendFileSync(paths.filtered, `async-shell: terminated by ${exit.signal}\n`);
    } else {
      fs.appendFileSync(paths.filtered, "async-shell: the task exited without reporting a status\n");
    }

    const finalizedAt = Date.now();
    const state: TaskState = { id: task.id, status, exitCode, createdAt: task.createdAt, finalizedAt };
    writeState(paths, state);
    backend.killServer(dir);

    const callback = callbackFromEnv(process.env);
    if (callback !== null) {
      const decision = await readDelivery(paths, DECISION_WAIT_MS);
      try {
        await sendFrame(callback, {
          kind: ASYNC_SHELL_KIND, token: callback.token, operation: "complete", id: task.id,
          notify: decision === "async",
          // A notified completion consumes the chunk it delivers; a synchronous
          // reply already carried the final text, so only the status remains.
          result: decision === "async" ? consumeOutput(paths, state) : statusResult(paths, state),
        });
      } catch {
        // The host is gone or refused the frame; the task is finalized on disk
        // and its server is already released.
      }
    }
    fs.writeFileSync(paths.closed, "", { mode: 0o600 });
  };

  for (;;) {
    if (pump()) lastGrowth = Date.now();
    else flushPending(false);

    if (exists(paths.cancel)) cancelled = true;
    if (!cancelled && task.timeoutMs !== null && Date.now() >= task.createdAt + task.timeoutMs) timedOut = true;
    if ((cancelled || timedOut) && !closing) {
      closing = true;
      backend.killServer(dir);
    }

    if (!closing) {
      const exit = readJson(paths.exit);
      const reported = record(exit) && "code" in exit;
      const runnerPid = readPid(paths.runnerPid);
      const runnerGone = runnerPid !== null && !alive(runnerPid) && !reported;
      if (reported || runnerGone) closing = true;
    }
    if (closing) {
      await finish();
      return;
    }
    await sleep(MONITOR_TICK_MS);
  }
}
