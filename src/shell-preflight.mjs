import { spawn } from "node:child_process";

const MAX_DIAGNOSTIC_CHARS = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

const POWERSHELL_PARSE_COMMAND = String.raw`
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$source = [Console]::In.ReadToEnd()
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) {
  foreach ($parseError in $errors) {
    [Console]::Error.WriteLine(("{0}:{1}: {2}" -f $parseError.Extent.StartLineNumber, $parseError.Extent.StartColumnNumber, $parseError.Message))
  }
  exit 1
}
`;

const SHELL_NAMES = new Map([
  ["bash", "bash"],
  ["sh", "sh"],
  ["dash", "dash"],
  ["ash", "ash"],
  ["ksh", "ksh"],
  ["mksh", "ksh"],
  ["zsh", "zsh"],
  ["fish", "fish"],
  ["pwsh", "powershell"],
  ["powershell", "powershell"],
]);

export function detectShellType(executable) {
  if (typeof executable !== "string" || executable.length === 0) return null;

  const filename = executable.split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.exe$/, "");
  return filename ? (SHELL_NAMES.get(filename) ?? null) : null;
}

function syntaxCheckArgs(shellType) {
  switch (shellType) {
    case "bash":
    case "sh":
    case "dash":
    case "ash":
    case "ksh":
      return ["-n"];
    case "zsh":
      return ["-f", "-n"];
    case "fish":
      return ["--no-config", "--no-execute"];
    case "powershell":
      return ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_PARSE_COMMAND];
    default:
      return null;
  }
}

function diagnosticText(stderr, stdout, exitCode) {
  const diagnostic = (stderr || stdout).trim();
  return diagnostic || `syntax checker exited with code ${exitCode ?? "unknown"}`;
}

export async function checkShellSyntax({
  command,
  executable,
  cwd = process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof command !== "string") {
    throw new TypeError("command must be a string");
  }

  const shellType = detectShellType(executable);
  const args = syntaxCheckArgs(shellType);
  if (!shellType || !args) {
    return {
      ok: false,
      code: "unsupported_shell",
      shellType: null,
      executable,
      diagnostic: `unsupported shell executable: ${executable || "<empty>"}`,
    };
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_DIAGNOSTIC_CHARS) {
        stdout += chunk.slice(0, MAX_DIAGNOSTIC_CHARS - stdout.length);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_DIAGNOSTIC_CHARS) {
        stderr += chunk.slice(0, MAX_DIAGNOSTIC_CHARS - stderr.length);
      }
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ shellType, executable, ...result });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        code: "checker_timeout",
        diagnostic: `syntax checker timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.on("error", (error) => {
      finish({
        ok: false,
        code: "checker_unavailable",
        diagnostic: `cannot start syntax checker ${executable} in ${cwd}: ${error.message}`,
      });
    });

    child.on("close", (exitCode, signal) => {
      if (exitCode === 0) {
        finish({ ok: true, code: "ok", diagnostic: "" });
      } else if (exitCode === null) {
        finish({
          ok: false,
          code: "checker_failed",
          diagnostic: `syntax checker was terminated by ${signal ?? "an unknown signal"}`,
        });
      } else {
        finish({
          ok: false,
          code: "syntax_error",
          diagnostic: diagnosticText(stderr, stdout, exitCode),
        });
      }
    });

    child.stdin.on("error", () => {});
    child.stdin.end(command);
  });
}
