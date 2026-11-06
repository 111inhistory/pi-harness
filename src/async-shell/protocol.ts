/**
 * Wire contract between the async-shell CLI/monitor and the Harness host.
 *
 * The host owns admission: it hands the CLI a per-Actor token in the
 * environment, tracks outstanding tasks, and treats `complete` as the only
 * unregistration. Frames travel over the existing managed NDJSON endpoint with
 * `writeSocket`; an empty response line is the acknowledgement, and an unknown
 * handoff result is never replayed by the sender.
 *
 * `ShellResult.cursor` is the byte offset just past the text this result carried,
 * inside the task's complete filtered output log — not a character count and not
 * a raw-log offset. The log keeps every filtered byte; only a response is bounded
 * (`MAX_RESULT_BYTES`), so a result may report `truncated` and the caller
 * continues from `cursor`.
 */

export const ASYNC_SHELL_KIND = "async-shell";

/** Upper bound of one result's `output`, in bytes of UTF-8. */
export const MAX_RESULT_BYTES = 32 * 1024;

const MAX_ID_CHARS = 64;
const MAX_TOKEN_CHARS = 512;
const MAX_PATH_CHARS = 4096;

export type ShellStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out";


export interface ShellResult {
  readonly id: string;
  readonly status: ShellStatus;
  readonly exitCode: number | null;
  /** Filtered text of this response, at most `MAX_RESULT_BYTES`. */
  readonly output: string;
  /** Byte offset just past `output` in the complete filtered log. */
  readonly cursor: number;
  /** The complete filtered transcript on disk; it is never capped. */
  readonly logPath: string;
  /** More filtered output remains after `cursor`; read on from there. */
  readonly truncated: boolean;
}

export interface AsyncShellRegisterFrame {
  readonly kind: typeof ASYNC_SHELL_KIND;
  readonly token: string;
  readonly operation: "register";
  readonly id: string;
  readonly directory: string;
  readonly pid: number;
}

export interface AsyncShellCompleteFrame {
  readonly kind: typeof ASYNC_SHELL_KIND;
  readonly token: string;
  readonly operation: "complete";
  readonly id: string;
  /** Whether the host should notify the Actor; unregistration happens either way. */
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

function shellResult(value: unknown, id: string): ShellResult {
  if (!record(value)) throw new AsyncShellFrameError("frames carry one result object.");
  if (value["id"] !== id) throw new AsyncShellFrameError("result.id must equal the frame id.");
  const reported = status(value["status"]);
  if (reported === "running") {
    throw new AsyncShellFrameError("a completion cannot report a running task.");
  }
  const output = value["output"];
  if (typeof output !== "string") throw new AsyncShellFrameError("result.output must be a string.");
  if (Buffer.byteLength(output, "utf8") > MAX_RESULT_BYTES) {
    throw new AsyncShellFrameError(`result.output must not exceed ${MAX_RESULT_BYTES} bytes.`);
  }
  if (typeof value["truncated"] !== "boolean") throw new AsyncShellFrameError("result.truncated must be a boolean.");
  return {
    id,
    status: reported,
    exitCode: exitCode(value["exitCode"]),
    output,
    cursor: cursor(value["cursor"]),
    logPath: text(value["logPath"], "result.logPath", MAX_PATH_CHARS),
    truncated: value["truncated"],
  };
}

/**
 * Validate one inbound frame. Fields are read one by one and every bound is
 * checked before the frame reaches a host task map.
 */
export function validateAsyncShellFrame(value: unknown): AsyncShellFrame {
  if (!record(value)) throw new AsyncShellFrameError("The frame must be an object.");
  if (value["kind"] !== ASYNC_SHELL_KIND) throw new AsyncShellFrameError("The frame is not an async-shell frame.");
  const token = text(value["token"], "token", MAX_TOKEN_CHARS);
  const id = text(value["id"], "id", MAX_ID_CHARS);
  const operation = value["operation"];
  if (operation === "register") {
    const directory = text(value["directory"], "directory", MAX_PATH_CHARS);
    const pid = value["pid"];
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      throw new AsyncShellFrameError("pid must be a positive integer.");
    }
    return { kind: ASYNC_SHELL_KIND, token, operation, id, directory, pid };
  }
  if (operation === "complete") {
    if (typeof value["notify"] !== "boolean") throw new AsyncShellFrameError("notify must be a boolean.");
    return {
      kind: ASYNC_SHELL_KIND, token, operation, id, notify: value["notify"],
      result: shellResult(value["result"], id),
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
