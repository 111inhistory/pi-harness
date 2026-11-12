import path from "node:path";
import { parseCreateArgs } from "../async-shell/create-args.ts";

/** Extracted approval action representing a command that requires approval review. */
export interface JobApprovalAction {
  /** The command arguments to be reviewed for approval. */
  readonly argv: readonly string[];
  /** Working directory where the command will execute, resolved to an absolute path. */
  readonly cwd: string;
  /** Whether this action was extracted from a pi-job create invocation. */
  readonly isJob: boolean;
  /** Options extracted from pi-job create (if isJob is true). */
  readonly jobOptions?: {
    readonly waitMs?: number;
    readonly timeoutMs?: number | null;
  };
  /** Raw preview or full command string (optional). */
  readonly raw?: string;
}

export type ExtractJobCommandsResult =
  | {
      readonly kind: "extracted";
      readonly actions: readonly JobApprovalAction[];
      readonly containsPiJob: boolean;
    }
  | { readonly kind: "original" };

export interface ExtractJobCommandsOptions {
  readonly shell: string;
  readonly command: string;
  readonly cwd: string;
  readonly platform?: "posix" | "windows";
}

export const PARSER_MODULE_URL = new URL(
  "../../vendor/codex-command-policy/lib/index.mjs",
  import.meta.url,
);

interface ShellParseRequest {
  readonly version: 1;
  readonly operation: "parse";
  readonly shell: string;
  readonly command: string;
  readonly cwd: string;
  readonly platform: "posix" | "windows";
}

interface ShellParseResponse {
  readonly version: 1;
  readonly operation?: string;
  readonly ok: boolean;
  readonly unknown: boolean;
  readonly commands?: readonly (readonly string[])[];
  readonly reason?: string;
}

type AnalyzeFn = (input: unknown) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateParseResponse(raw: unknown): ShellParseResponse | null {
  if (!isRecord(raw)) return null;
  if (raw["version"] !== 1) return null;
  if (typeof raw["ok"] !== "boolean" || typeof raw["unknown"] !== "boolean") return null;

  let commands: string[][] | undefined;
  if (Array.isArray(raw["commands"])) {
    commands = [];
    for (const item of raw["commands"]) {
      if (!Array.isArray(item)) return null;
      if (!item.every((token): token is string => typeof token === "string")) return null;
      commands.push([...item]);
    }
  }

  return {
    version: 1,
    ok: raw["ok"],
    unknown: raw["unknown"],
    ...(commands === undefined ? {} : { commands }),
    ...(typeof raw["reason"] === "string" ? { reason: raw["reason"] } : {}),
  };
}

async function resolveAnalyzeFn(): Promise<AnalyzeFn | null> {
  try {
    const mod = await import(PARSER_MODULE_URL.href);
    if (typeof mod.analyze === "function") {
      return mod.analyze as AnalyzeFn;
    }
  } catch {
    // Submodule missing or not mounted yet; fail-closed
  }
  return null;
}

async function runDefaultWasmParser(
  request: ShellParseRequest,
): Promise<ShellParseResponse> {
  const analyze = await resolveAnalyzeFn();
  if (!analyze) {
    return {
      version: 1,
      ok: false,
      unknown: true,
      reason: "Parser artifact not found; falling back to original review",
    };
  }

  try {
    const raw = await analyze(request);
    const validated = validateParseResponse(raw);
    if (!validated) {
      return {
        version: 1,
        ok: false,
        unknown: true,
        reason: "Parser returned malformed response; falling back to original review",
      };
    }
    return validated;
  } catch (err) {
    return {
      version: 1,
      ok: false,
      unknown: true,
      reason: `WASM analyzer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function crossPlatformBasename(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? "";
}

const PI_JOB_COMMAND_NAMES = new Set([
  "pi-job",
  "pi-job.exe",
  "pi-job.cmd",
  "pi-job.bat",
]);

const RECOGNIZED_PI_JOB_SUBCOMMANDS = new Set([
  "create",
  "send",
  "key",
  "poll",
  "read",
  "cancel",
]);

function parsePiJobInvocation(argv: readonly string[]): {
  readonly isPiJob: boolean;
  readonly subcommand?: string | undefined;
  readonly restArgs: readonly string[];
} {
  if (argv.length === 0) return { isPiJob: false, restArgs: [] };
  const first = argv[0]!;
  const firstBase = crossPlatformBasename(first).toLowerCase();

  let subIndex = -1;
  if (PI_JOB_COMMAND_NAMES.has(firstBase)) {
    subIndex = 1;
  }

  if (subIndex === -1) {
    return { isPiJob: false, restArgs: [] };
  }

  const subcommand = argv[subIndex];
  const restArgs = argv.slice(subIndex + 1);
  return { isPiJob: true, subcommand, restArgs };
}

const STATE_CHANGING_EXECUTABLES = new Set([
  "cd",
  "chdir",
  "pushd",
  "popd",
  "export",
  "unset",
  "setenv",
  "unsetenv",
  "alias",
  "unalias",
  "source",
  ".",
  "set-location",
  "sl",
]);

function hasStateChangingSideEffect(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const first = argv[0]!.toLowerCase();
  const base = crossPlatformBasename(first).replace(/\.exe$/, "").toLowerCase();

  // Directory changes or environment modifications
  if (STATE_CHANGING_EXECUTABLES.has(base)) return true;

  // Environment variable assignments: e.g. FOO=bar
  if (first.includes("=") && !first.startsWith("-")) return true;

  // PowerShell env drives: e.g. $env:VAR = ...
  if (first.startsWith("$env:") || first.startsWith("env:")) return true;

  return false;
}

function resolvePlatform(shell: string, explicit?: "posix" | "windows"): "posix" | "windows" {
  if (explicit) return explicit;
  const base = crossPlatformBasename(shell).toLowerCase().replace(/\.exe$/, "");
  if (base === "pwsh" || base === "powershell") return "windows";
  return process.platform === "win32" ? "windows" : "posix";
}

function hasCreateOption(tokens: readonly string[], option: string): boolean {
  for (const token of tokens) {
    if (token === "--") break;
    if (!token.startsWith("-") || token === "-") break;
    if (token === option) return true;
  }
  return false;
}

export async function extractJobCommands(
  options: ExtractJobCommandsOptions,
): Promise<ExtractJobCommandsResult> {
  const { shell, command, cwd } = options;

  if (typeof command !== "string" || command.trim() === "") {
    return { kind: "extracted", actions: [], containsPiJob: false };
  }

  const platform = resolvePlatform(shell, options.platform);
  const pathOps = platform === "windows" ? path.win32 : path.posix;

  let parseResponse: ShellParseResponse;
  try {
    parseResponse = await runDefaultWasmParser({
      version: 1,
      operation: "parse",
      shell,
      command,
      cwd,
      platform,
    });
  } catch {
    // Missing parse artifact or runtime failure -> fail-closed to original review
    return { kind: "original" };
  }

  if (!parseResponse.ok || parseResponse.unknown || !Array.isArray(parseResponse.commands)) {
    return { kind: "original" };
  }

  // If there are multiple commands (compound execution), check if any command
  // changes working directory or environment (e.g. cd, export, Set-Location),
  // which makes subsequent cwd / context uncertain.
  // In that case, fall back to whole original review without simulating shell state machine.
  if (parseResponse.commands.length > 1) {
    for (const cmd of parseResponse.commands) {
      if (hasStateChangingSideEffect(cmd)) {
        return { kind: "original" };
      }
    }
  }

  const actions: JobApprovalAction[] = [];
  let containsPiJob = false;

  for (const cmdArgv of parseResponse.commands) {
    if (cmdArgv.length === 0) continue;

    const invocation = parsePiJobInvocation(cmdArgv);
    if (invocation.isPiJob) {
      const { subcommand, restArgs } = invocation;
      if (!subcommand || !RECOGNIZED_PI_JOB_SUBCOMMANDS.has(subcommand)) {
        // Unknown subcommand -> fall back to original review
        return { kind: "original" };
      }

      containsPiJob = true;

      if (subcommand === "create") {
        let parsed: ReturnType<typeof parseCreateArgs>;
        try {
          parsed = parseCreateArgs(restArgs);
        } catch {
          return { kind: "original" };
        }

        const hasExplicitCwd = hasCreateOption(restArgs, "--cwd");
        const resolvedCwd = hasExplicitCwd
          ? pathOps.resolve(cwd, parsed.cwd)
          : pathOps.resolve(cwd);

        actions.push({
          argv: parsed.argv,
          cwd: resolvedCwd,
          isJob: true,
          jobOptions: {
            waitMs: parsed.waitMs,
            timeoutMs: parsed.timeoutMs,
          },
        });
      } else if (subcommand === "send" || subcommand === "key") {
        // send/key excluded from inspection
        continue;
      } else if (subcommand === "poll" || subcommand === "read" || subcommand === "cancel") {
        // Read-only / control commands on jobs; excluded from inspection
        continue;
      }
    } else {
      // Non-pi-job command (e.g. sibling command in compound execution)
      actions.push({
        argv: cmdArgv,
        cwd: pathOps.resolve(cwd),
        isJob: false,
      });
    }
  }

  return { kind: "extracted", actions, containsPiJob };
}
