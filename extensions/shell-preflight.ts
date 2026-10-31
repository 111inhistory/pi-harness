import {
  SettingsManager,
  createLocalPowerShellOperations,
  getAgentDir,
  getPowerShellConfig,
  getShellConfig,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { checkShellSyntax, type ShellPreflightResult } from "../src/shell-preflight.ts";

interface ShellConfiguration { executable: string; prefix: string | undefined }
type ConfigurationCache = Map<string, ShellConfiguration>;
type PreflightResult = ShellPreflightResult | { ok: false; code: 'preflight_error'; toolName: string; diagnostic: string };

function bashConfiguration(ctx: ExtensionContext, configurationCache: ConfigurationCache): ShellConfiguration {
  const cacheKey = `bash\u0000${ctx.cwd}\u0000${ctx.isProjectTrusted()}`;
  const cached = configurationCache.get(cacheKey);
  if (cached) return cached;

  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const shell = getShellConfig(settings.getShellPath());
  const configuration = {
    executable: shell.shell,
    prefix: settings.getShellCommandPrefix(),
  };
  configurationCache.set(cacheKey, configuration);
  return configuration;
}

function commandConfiguration(toolName: string, ctx: ExtensionContext, configurationCache: ConfigurationCache): ShellConfiguration {
  if (toolName === "powershell") {
    const cached = configurationCache.get("powershell");
    if (cached) return cached;

    const configuration = { executable: getPowerShellConfig().shell, prefix: undefined };
    configurationCache.set("powershell", configuration);
    return configuration;
  }
  return bashConfiguration(ctx, configurationCache);
}

function combineCommand(prefix: string | undefined, command: string): string {
  return prefix ? `${prefix}\n${command}` : command;
}

function failureReason(result: Extract<PreflightResult, { ok: false }>): string {
  const checker = 'executable' in result ? result.executable : result.toolName;
  return `Command not executed: shell preflight failed (${checker}, ${result.code}): ${result.diagnostic}`;
}

async function preflight(toolName: string, command: unknown, ctx: ExtensionContext, configurationCache: ConfigurationCache): Promise<PreflightResult> {
  try {
    if (typeof command !== 'string') throw new TypeError('command must be a string');
    const { executable, prefix } = commandConfiguration(toolName, ctx, configurationCache);
    return checkShellSyntax({
      command: combineCommand(prefix, command),
      executable,
      cwd: ctx.cwd,
    });
  } catch (error) {
    return {
      ok: false,
      code: "preflight_error",
      toolName,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}

export default function shellPreflightExtension(pi: ExtensionAPI): void {
  const configurationCache: ConfigurationCache = new Map();

  pi.on("session_start", () => {
    configurationCache.clear();
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;

    const result = await preflight(event.toolName, event.input.command, ctx, configurationCache);
    if (result.ok) return undefined;

    return {
      block: true,
      reason: failureReason(result),
    };
  });

  pi.on("user_bash", async (event, ctx) => {
    const windows = process.platform === "win32";
    const result = await preflight(windows ? "powershell" : "bash", event.command, ctx, configurationCache);
    if (result.ok) return windows ? { operations: createLocalPowerShellOperations() } : undefined;

    return {
      result: {
        output: failureReason(result),
        exitCode: 2,
        cancelled: false,
        truncated: false,
      },
    };
  });
}
