/**
 * `pi-job`: the async-shell CLI.
 *
 * One invoke, one JSON object on stdout. The tool is deliberately stateless: a
 * task id addresses files under the user's private state root, and the detached
 * monitor that owns those files is the only writer of the task's final state.
 *
 * The CLI also runs standalone without any host callback environment, which is
 * what the integration tests use. With `PI_AGENT_SOCKET` and
 * `PI_ASYNC_SHELL_TOKEN` set it reports `register` and `complete` frames to the
 * Harness host over the existing managed IPC endpoint.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AsyncShellError,
  MAX_SEND_BYTES,
  callbackFromEnv,
  cancelTask,
  createTask,
  monitorMain,
  pollTask,
  readTask,
  runnerMain,
  sendInput,
  sendKey,
  taskDirectory,
} from "./tmux.ts";
import type { ShellResult } from "./protocol.ts";

const USAGE = [
  "pi-job create [--wait <duration>] [--timeout <duration>] [--cwd <dir>] -- <command> [args...]",
  "pi-job poll <id> [--cursor <bytes>]",
  "pi-job read <id> [--cursor <bytes>]",
  "pi-job send <id> [--enter]   (literal stdin bytes; --enter adds one Enter key)",
  "pi-job key <id> <key>",
  "pi-job cancel <id>",
].join("\n");

const USAGE_ERRORS: ReadonlySet<string> = new Set([
  "invalid_command_args", "invalid_duration", "invalid_cursor", "invalid_id", "input_too_large", "invalid_key",
]);

/** `250ms`, `5s`, `10m`, `1h`; a bare number is milliseconds. */
export function parseDuration(value: string | undefined): number {
  if (value === undefined) throw new AsyncShellError("invalid_duration", "A duration value is required.");
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (match === null) throw new AsyncShellError("invalid_duration", `Not a duration: ${value}`);
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2] ?? "ms";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const total = amount * factor;
  if (!Number.isSafeInteger(total) || total < 0) throw new AsyncShellError("invalid_duration", `Not a duration: ${value}`);
  return total;
}

function parseCursor(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) throw new AsyncShellError("invalid_cursor", `Not a byte cursor: ${value}`);
  return Number.parseInt(value, 10);
}

/**
 * All of stdin, byte for byte: a heredoc's own newline is part of the payload.
 * The size limit is enforced while reading, so an oversized caller is refused
 * before anything unbounded is buffered.
 */
async function readStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      process.stdin.destroy();
      throw new AsyncShellError("input_too_large", `Input must not exceed ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface CreateArgs {
  readonly argv: string[];
  readonly cwd: string;
  readonly waitMs: number;
  readonly timeoutMs: number | null;
}

/** Options end at `--` or at the first token that is not an option. */
export function parseCreateArgs(tokens: readonly string[]): CreateArgs {
  let waitMs = 0;
  let timeoutMs: number | null = null;
  let cwd = process.cwd();
  let index = 0;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-") || token === "-") break;
    if (token === "--wait") {
      waitMs = parseDuration(tokens[index + 1]);
      index += 1;
    } else if (token === "--timeout") {
      timeoutMs = parseDuration(tokens[index + 1]);
      index += 1;
    } else if (token === "--cwd") {
      const value = tokens[index + 1];
      if (value === undefined || value === "") throw new AsyncShellError("invalid_command_args", "--cwd requires a directory.");
      cwd = value;
      index += 1;
    } else {
      throw new AsyncShellError("invalid_command_args", `Unknown create option: ${token}`);
    }
  }
  const argv = tokens.slice(index);
  if (argv.length === 0) throw new AsyncShellError("invalid_command_args", "create requires a command after --.");
  return { argv, cwd, waitMs, timeoutMs };
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitResult(result: ShellResult): void {
  emit(result);
}

async function run(argv: readonly string[]): Promise<void> {
  const [verb, ...rest] = argv;
  switch (verb) {
    case "create": {
      const parsed = parseCreateArgs(rest);
      emitResult(await createTask({ ...parsed, callback: callbackFromEnv(process.env) }));
      return;
    }
    case "poll": {
      const [id, ...options] = rest;
      const cursor = readCursorOption(options);
      emitResult(pollTask(taskDirectory(requireId(id, "poll")), cursor));
      return;
    }
    case "read": {
      const [id, ...options] = rest;
      const cursor = readCursorOption(options);
      emitResult(readTask(taskDirectory(requireId(id, "read")), cursor));
      return;
    }
    case "send": {
      const enter = rest.includes("--enter");
      const positional = rest.filter((token) => token !== "--enter");
      const unknown = positional.filter((token) => token.startsWith("-"));
      if (unknown.length !== 0) throw new AsyncShellError("invalid_command_args", `Unknown send option: ${unknown[0]}`);
      if (positional.length !== 1) throw new AsyncShellError("invalid_command_args", "send takes one task id.");
      const dir = taskDirectory(requireId(positional[0], "send"));
      const input = await readStdin(MAX_SEND_BYTES);
      sendInput(dir, input, enter);
      emitResult(pollTask(dir, null));
      return;
    }
    case "key": {
      const [id, key, ...extra] = rest;
      if (extra.length !== 0) throw new AsyncShellError("invalid_command_args", "key takes one task id and one key name.");
      const dir = taskDirectory(requireId(id, "key"));
      if (key === undefined) throw new AsyncShellError("invalid_command_args", "key requires a key name.");
      sendKey(dir, key);
      emitResult(pollTask(dir, null));
      return;
    }
    case "cancel": {
      const [id, ...extra] = rest;
      if (extra.length !== 0) throw new AsyncShellError("invalid_command_args", "cancel takes one task id.");
      const dir = taskDirectory(requireId(id, "cancel"));
      await cancelTask(dir);
      emitResult(pollTask(dir, null));
      return;
    }
    case "__run":
      process.exitCode = await runnerMain(requireDirectory(rest[0]));
      return;
    case "__monitor":
      await monitorMain(requireDirectory(rest[0]));
      return;
    default:
      throw new AsyncShellError("invalid_command_args", USAGE);
  }
}

function requireId(value: string | undefined, verb: string): string {
  if (value === undefined || value === "") throw new AsyncShellError("invalid_command_args", `${verb} requires a task id.`);
  return value;
}

function requireDirectory(value: string | undefined): string {
  if (value === undefined || value === "") throw new AsyncShellError("invalid_command_args", "Internal mode requires a task directory.");
  return value;
}

function readCursorOption(options: readonly string[]): number | null {
  if (options.length === 0) return null;
  if (options.length === 2 && options[0] === "--cursor") return parseCursor(options[1]);
  throw new AsyncShellError("invalid_command_args", `Unknown option: ${options[0]}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const internal = argv[0] === "__run" || argv[0] === "__monitor";
  try {
    await run(argv);
  } catch (error) {
    const code = error instanceof AsyncShellError ? error.code : "failed";
    const message = error instanceof Error ? error.message : String(error);
    if (internal) {
      process.stderr.write(`pi-job: ${message}\n`);
    } else if (USAGE_ERRORS.has(code)) {
      emit({ error: { code, message, usage: USAGE } });
    } else {
      emit({ error: { code, message } });
    }
    process.exitCode = 1;
    if (error instanceof AsyncShellError && code === "unsupported_platform") {
      process.stderr.write("pi-job: the async-shell backend requires POSIX with tmux.\n");
    }
  }
}

/** Only the entry module runs the CLI; importing it stays side-effect free. */
function isEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return path.resolve(entry) === self;
  }
}

if (isEntry()) await main();
