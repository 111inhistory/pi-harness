/**
 * Wire contract between the async-shell CLI/monitor and the Harness host.
 *
 * The host owns admission: it hands the CLI a per-Actor token in the
 * environment and tracks outstanding tasks. `complete` ends result waiting;
 * internal_error retains its resource lease for existing owner cleanup. Frames
 * travel over the existing managed NDJSON endpoint with `writeSocket`; an empty response line is the acknowledgement, and an unknown
 * handoff result is never replayed by the sender.
 *
 * `ShellResult.cursor` is a private byte offset in the filtered log. The host
 * can consume an entire window while showing only parts of it. The window's
 * line coordinates let the caller find the omitted regions with `read`.
 */

import { isTaskId } from "./task-id.ts";

export const ASYNC_SHELL_KIND = "async-shell";

/** Upper bound of one result's `output`, in bytes of UTF-8. */
export const MAX_RESULT_BYTES = 32 * 1024;
export const MAX_FOREGROUND_RESULT_BYTES = 50 * 1024;

const MAX_ID_CHARS = 12;
const MAX_AGENT_ID_CHARS = 64;
const MAX_TOKEN_CHARS = 512;
const MAX_PATH_CHARS = 4096;

export type ShellStatus = "running" | "completed" | "failed" | "internal_error" | "cancelled" | "timed_out";

export interface ShellOutputWindow {
  readonly firstLine: number;
  readonly headLines: number;
  readonly headBytes: number;
  readonly tailFirstLine: number;
  readonly totalLines: number;
}

export interface ShellResult {
  readonly id: string;
  readonly status: ShellStatus;
  readonly exitCode: number | null;
  /** Filtered output, possibly two concatenated excerpts (see `window`). */
  readonly output: string;
  /** End of the consumed range in the filtered log. */
  readonly cursor: number;
  readonly window: ShellOutputWindow;
  /** The complete filtered transcript on disk; it is never capped. */
  readonly logPath: string;
  /** Some output was omitted or remains after `cursor`. */
  readonly truncated: boolean;
  /** Internal-error reminder; output and cursor retain their normal log semantics. */
  readonly message?: string;
}

export interface AsyncShellRegisterFrame {
  readonly kind: typeof ASYNC_SHELL_KIND;
  /** The Actor that owns this execution lease; the root routes by it. */
  readonly agentId: string;
  readonly token: string;
  readonly operation: "register";
  readonly id: string;
  readonly directory: string;
  readonly pid: number;
  readonly pty: boolean;
  readonly callId?: string;
}

export interface AsyncShellCompleteFrame {
  readonly kind: typeof ASYNC_SHELL_KIND;
  /** The Actor that owns this execution lease; the root routes by it. */
  readonly agentId: string;
  readonly token: string;
  readonly operation: "complete";
  readonly id: string;
  /** Whether the host should notify the Actor; internal errors retain cleanup ownership. */
  readonly notify: boolean;
  readonly result: ShellResult;
}

export type AsyncShellFrame = AsyncShellRegisterFrame | AsyncShellCompleteFrame;

/** A malformed or out-of-bounds frame. The host refuses it, never repairs it. */
export class AsyncShellFrameError extends Error {
  readonly code = "invalid_async_shell_frame";

  constructor(message: string) {
    super(message);
    this.name = "AsyncShellFrameError";
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || value === "" || value.length > maxChars) {
    throw new AsyncShellFrameError(`${field} must be a non-empty string of at most ${maxChars} characters.`);
  }
  return value;
}

function status(value: unknown): ShellStatus {
  switch (value) {
    case "running":
    case "completed":
    case "failed":
    case "internal_error":
    case "cancelled":
    case "timed_out":
      return value;
    default:
      throw new AsyncShellFrameError("result.status is not a known task status.");
  }
}

function exitCode(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AsyncShellFrameError("result.exitCode must be an integer or null.");
  }
  return value;
}

function cursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AsyncShellFrameError("result.cursor must be a non-negative integer.");
  }
  return value;
}

function lineNumber(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new AsyncShellFrameError(`result.window.${field} is outside the allowed range.`);
  }
  return value;
}

function outputWindow(value: unknown, output: Buffer): ShellOutputWindow {
  if (!record(value)) throw new AsyncShellFrameError('result.window must be an object.');
  const firstLine = lineNumber(value['firstLine'], 'firstLine', 1);
  const headLines = lineNumber(value['headLines'], 'headLines', 0);
  const headBytes = lineNumber(value['headBytes'], 'headBytes', 0);
  const tailFirstLine = lineNumber(value['tailFirstLine'], 'tailFirstLine', firstLine);
  const totalLines = lineNumber(value['totalLines'], 'totalLines', 0);
  if ((headBytes === 0) !== (headLines === 0) || headBytes > output.length ||
    ((output[headBytes] ?? 0) & 0xc0) === 0x80 || tailFirstLine > totalLines + 1 ||
    (output.length > 0 && tailFirstLine > totalLines)) {
    throw new AsyncShellFrameError('result.window does not match the output range.');
  }
  return { firstLine, headLines, headBytes, tailFirstLine, totalLines };
}

export function validateShellResult(value: unknown, maxOutputBytes = MAX_RESULT_BYTES): ShellResult {
  if (!record(value)) throw new AsyncShellFrameError("frames carry one result object.");
  const id = value["id"];
  if (typeof id !== 'string' || !isTaskId(id)) throw new AsyncShellFrameError('Invalid job result ID.');
  const reported = status(value["status"]);
  const output = value["output"];
  if (typeof output !== "string") throw new AsyncShellFrameError("result.output must be a string.");
  if (Buffer.byteLength(output, "utf8") > maxOutputBytes) {
    throw new AsyncShellFrameError(`result.output must not exceed ${maxOutputBytes} bytes.`);
  }
  if (typeof value["truncated"] !== "boolean") throw new AsyncShellFrameError("result.truncated must be a boolean.");
  return {
    id,
    status: reported,
    exitCode: exitCode(value["exitCode"]),
    output,
    cursor: cursor(value["cursor"]),
    window: outputWindow(value['window'], Buffer.from(output)),
    logPath: text(value["logPath"], "result.logPath", MAX_PATH_CHARS),
    truncated: value["truncated"],
    ...(reported === "internal_error"
      ? { message: text(value["message"], "result.message", 4096) } : {}),
  };
}

/**
 * Validate one inbound frame. Fields are read one by one and every bound is
 * checked before the frame reaches a host task map.
 */
export function validateAsyncShellFrame(value: unknown): AsyncShellFrame {
  if (!record(value)) throw new AsyncShellFrameError("The frame must be an object.");
  if (value["kind"] !== ASYNC_SHELL_KIND) throw new AsyncShellFrameError("The frame is not an async-shell frame.");
  const agentId = text(value["agentId"], "agentId", MAX_AGENT_ID_CHARS);
  const token = text(value["token"], "token", MAX_TOKEN_CHARS);
  const id = text(value["id"], "id", MAX_ID_CHARS);
  if (!isTaskId(id)) throw new AsyncShellFrameError("id must have the form job_<8 lowercase hexadecimal digits>.");
  const operation = value["operation"];
  if (operation === "register") {
    const directory = text(value["directory"], "directory", MAX_PATH_CHARS);
    const pid = value["pid"];
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      throw new AsyncShellFrameError("pid must be a positive integer.");
    }
    const pty = value['pty'];
    if (typeof pty !== 'boolean') throw new AsyncShellFrameError('pty must be a boolean.');
    const callId = value['callId'];
    return { kind: ASYNC_SHELL_KIND, agentId, token, operation, id, directory, pid, pty,
      ...(callId === undefined ? {} : { callId: text(callId, 'callId', MAX_TOKEN_CHARS) }) };
  }
  if (operation === "complete") {
    if (typeof value["notify"] !== "boolean") throw new AsyncShellFrameError("notify must be a boolean.");
    const result = validateShellResult(value['result']);
    if (result.id !== id) throw new AsyncShellFrameError('result.id must equal the frame id.');
    if (result.status === 'running') throw new AsyncShellFrameError('a completion cannot report a running task.');
    return {
      kind: ASYNC_SHELL_KIND, agentId, token, operation, id, notify: value["notify"],
      result,
    };
  }
  throw new AsyncShellFrameError("operation must be register or complete.");
}

/** Whether a value is a well-formed async-shell frame. */
export function isAsyncShellFrame(value: unknown): value is AsyncShellFrame {
  try {
    validateAsyncShellFrame(value);
    return true;
  } catch {
    return false;
  }
}
