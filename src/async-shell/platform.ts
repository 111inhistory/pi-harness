/**
 * The narrow platform boundary of the async-shell backend.
 *
 * Everything above this file — task layout, state files, the incremental filter,
 * the delivery decision, polling cursors, the frames — is platform-neutral. A
 * backend only answers "how do I drive one private multiplexer server for this
 * task directory": how a server is addressed, how a pane is started, captured,
 * fed and probed, and how a pid is proven to belong to this task before it is
 * signalled. POSIX uses `tmux -S <taskDir>/tmux.sock`; Windows uses the native
 * `psmux.exe -L pi-job-<id>` port.
 */

import fs from "node:fs";
import path from "node:path";

import { AsyncShellError } from "./errors.ts";

/** The pane's session name inside a task's own server. */
export const SESSION = "task";

/** Every control command is bounded: a wedged client must not hold the CLI. */
export const CONTROL_TIMEOUT_MS = 20_000;

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** One multiplexer backend, scoped per task directory. */
export interface ShellBackend {
  readonly kind: "posix" | "windows";
  /** Fail with an actionable error unless the backend can run here. */
  assertAvailable(): void;
  /** Run one control command against this task's own server. */
  run(dir: string, args: readonly string[], stdin?: string): CommandResult;
  /** Stop this task's own server; never removes or reuses another path. */
  killServer(dir: string): void;
  /** Whether this task's server still answers. */
  serverRunning(dir: string): boolean;
  /** Create the pane with its capture pipe already armed. */
  start(dir: string, selfArgv: readonly string[], rawPath: string): void;
  /** Deliver literal stdin bytes to the pane, with no interpretation. */
  sendInput(dir: string, input: string): void;
  /** Send one key name (`Enter`, `C-c`, ...). */
  sendKey(dir: string, key: string): void;
  /** Whether the pane's process is gone (or its server is). */
  paneGone(dir: string): boolean;
  /** Whether `pid` is provably this task's own process, not a recycled one. */
  ownsProcess(pid: number, marker: string, dir: string): boolean;
}

/** The argv that runs this same binary in an internal mode inside the pane. */
export function selfArgv(dir: string, mode: string): readonly string[] {
  const script = process.argv[1];
  if (typeof script !== "string" || script === "") {
    throw new AsyncShellError("self_unresolved", "The async-shell CLI cannot locate its own entry point.");
  }
  return [process.execPath, ...process.execArgv, path.resolve(script), mode, dir];
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** The command a pane runs for a task's argv, resolved for the platform. */
export interface ChildCommand {
  readonly file: string;
  readonly args: readonly string[];
  /** `cmd.exe` needs the prepared line verbatim; Node must not re-quote it. */
  readonly verbatim: boolean;
}

/*!
 * Command-line escaping adapted from cross-spawn.
 * https://github.com/moxystudio/node-cross-spawn/blob/master/lib/util/escape.js
 *
 * The MIT License (MIT)
 * Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
/** cmd.exe meta characters, as handled by the established cross-spawn escaping. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Escape the command word itself; it is not quoted as a unit. */
function escapeCommand(value: string): string {
  return value.replace(CMD_META, "^$1");
}

/**
 * Escape one argument for `cmd.exe`.
 *
 * Backslashes that precede a quote must be doubled, and a trailing run of
 * backslashes must be doubled as well, or cmd would consume the closing quote.
 * The value is then quoted, and meta characters are prefixed with `^` twice
 * because cmd parses a `/c` line in two passes.
 */
function escapeArgument(value: string): string {
  let text = value.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  text = text.replace(/(?=(\\+?)?)\1$/, "$1$1");
  text = `"${text}"`;
  text = text.replace(CMD_META, "^$1");
  return text.replace(CMD_META, "^$1");
}

/** Environment names are case-insensitive on Windows. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Resolve the task's argv into something a pane can execute.
 *
 * POSIX hands the argv to `spawn` unchanged. Windows cannot: `CreateProcess`
 * applies no `PATHEXT` search, so `npm` would not find `npm.cmd`, and a `.cmd`
 * or `.bat` target cannot be executed at all without `cmd.exe`. Those two
 * extensions are therefore routed through `cmd.exe /d /s /c`, which is the one
 * place a Windows argv is parsed by a shell. Metacharacters are escaped for
 * that transport; literal line breaks are refused instead of being interpreted
 * as command separators. Every other target keeps its argv literal.
 */
export function childCommand(
  argv: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  cwd: string,
): ChildCommand {
  const file = argv[0];
  if (file === undefined || file === "") {
    throw new AsyncShellError("invalid_command_args", "create requires a command.");
  }
  const rest = argv.slice(1);
  if (platform !== "win32") return { file, args: rest, verbatim: false };

  const resolved = resolveWindowsExecutable(file, env, cwd);
  if (!/\.(bat|cmd)$/i.test(resolved)) return { file: resolved, args: rest, verbatim: false };
  const broken = rest.find((arg) => /[\r\n]/.test(arg));
  if (broken !== undefined) {
    throw new AsyncShellError(
      "unsupported_script_argument",
      `Cannot pass a line break to ${path.win32.basename(resolved)}: cmd.exe treats it as a command separator.`,
    );
  }
  const line = `"${[escapeCommand(resolved), ...rest.map(escapeArgument)].join(" ")}"`;
  return { file: envValue(env, "ComSpec") ?? "cmd.exe", args: ["/d", "/s", "/c", line], verbatim: true };
}

/**
 * `npm` -> the full path of `npm.cmd`, the way the command would be found: a
 * relative command resolves against the task's own directory, a bare one is
 * searched there and then on PATH, and every candidate honours PATHEXT.
 */
function resolveWindowsExecutable(file: string, env: NodeJS.ProcessEnv, cwd: string): string {
  const hasDirectory = /[\\/]/.test(file);
  const absolute = hasDirectory ? path.win32.resolve(cwd, file) : file;
  const basename = path.win32.basename(absolute);
  const extensions = (envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT).split(";").map((entry) => entry.trim()).filter((entry) => entry !== "");
  const names = path.win32.extname(basename) === "" ? [...extensions.map((extension) => basename + extension), basename] : [basename];
  const directories = hasDirectory
    ? [path.win32.dirname(absolute)]
    : [cwd, ...(envValue(env, "PATH") ?? "").split(";").map((entry) => entry.trim()).filter((entry) => entry !== "")];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.win32.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return absolute;
}
