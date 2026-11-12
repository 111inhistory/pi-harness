/**
 * Pure parser for `pi-job create` used by the shell-approval layer. The native
 * CLI owns execution; this copy exists because approval extraction must stay
 * synchronous and in-process. Keep it in sync with `go/internal/asyncshell/cli.go`.
 */
import { AsyncShellError } from "./errors.ts";

/** How long a reply waits for the command by default. */
export const DEFAULT_WAIT_MS = 5000;

export interface CreateArgs {
  readonly argv: string[];
  readonly cwd: string;
  readonly waitMs: number;
  readonly timeoutMs: number | null;
}

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

/** Options end at `--` or at the first token that is not an option. */
export function parseCreateArgs(tokens: readonly string[]): CreateArgs {
  let waitMs = DEFAULT_WAIT_MS;
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
