import {
  SettingsManager,
  getAgentDir,
  getPowerShellConfig,
  getShellConfig,
} from "@earendil-works/pi-coding-agent";
import { checkShellSyntax } from "../src/shell-preflight.mjs";

function bashConfiguration(ctx, configurationCache) {
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

function commandConfiguration(toolName, ctx, configurationCache) {
  if (toolName === "powershell") {
    const cached = configurationCache.get("powershell");
    if (cached) return cached;

    const configuration = { executable: getPowerShellConfig().shell, prefix: undefined };
    configurationCache.set("powershell", configuration);
    return configuration;
  }
  return bashConfiguration(ctx, configurationCache);
}

function combineCommand(prefix, command) {
  return prefix ? `${prefix}\n${command}` : command;
}

function failureReason(result) {
  const checker = result.executable ?? result.toolName ?? "unknown shell";
  return `Command not executed: shell preflight failed (${checker}, ${result.code}): ${result.diagnostic}`;
}

async function preflight(toolName, command, ctx, configurationCache) {
  try {
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

export default function shellPreflightExtension(pi) {
  const configurationCache = new Map();

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
    const result = await preflight("bash", event.command, ctx, configurationCache);
    if (result.ok) return undefined;

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
