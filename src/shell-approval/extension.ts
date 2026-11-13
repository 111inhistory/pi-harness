import {
  SettingsManager,
  createLocalPowerShellOperations,
  getAgentDir,
  getPowerShellConfig,
  getShellConfig,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { checkShellSyntax, type ShellPreflightResult } from "../shell-preflight.ts";
import { harnessConfigFor } from '../harness-config.ts';
import { argumentCompletionProvider } from '../autocomplete.ts';
import { publishShellCheck, type ShellCheck } from './bridge.ts';
import { runShellPolicy } from './command.ts';
import { loadShellRuleFiles } from './rule-files.ts';
import { extractJobCommands } from './job-command.ts';
import { ManualApprovalController } from './controller.ts';
import { ShellApprovalTuiAdapter, sanitizeTerminalText } from './ui.ts';
import { sendApprovalNotification } from './url-notification.ts';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { createShellReviewer, AUTO_REVIEW_MIN_NODE_MAJOR } from './reviewer.ts';
import type {
  ShellApprovalAction,
  ShellApprovalController,
  ShellApprovalRequest,
  ShellPermissionMode,
} from './types.ts';

const PERMISSION_MODES = [
  { value: 'ask', label: 'Ask', description: 'Ask unless a rule explicitly allows the command' },
  { value: 'auto', label: 'Auto Approve', description: 'Review unmatched commands automatically' },
  { value: 'yolo', label: 'YOLO', description: 'Run without permission checks' },
] as const;

const PERMISSION_MODE_ENTRY = 'harness-shell-permission-mode';

const APPROVAL_CONTROLLER = 'pi-harness:shell-approval-controller';
interface ApprovalControllerExchange { controller?: ShellApprovalController }

/** Typed root integration point for the RPC assembly; it never exposes adapter state. */
export function shellApprovalController(api: ExtensionAPI): ShellApprovalController | undefined {
  const exchange: ApprovalControllerExchange = {};
  api.events.emit(APPROVAL_CONTROLLER, exchange);
  return exchange.controller;
}

/** Read only the active branch; an invalid latest record falls back to config. */
function savedPermissionMode(ctx: ExtensionContext): ShellPermissionMode | undefined {
  let saved: ShellPermissionMode | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== PERMISSION_MODE_ENTRY) continue;
    const data: unknown = entry.data;
    saved = data !== null && typeof data === 'object' && 'version' in data && data.version === 1 && 'mode' in data
      ? PERMISSION_MODES.find(item => item.value === data.mode)?.value
      : undefined;
  }
  return saved;
}

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


/** Shared optional entrypoint: syntax and approval have independent configuration. */
export default function shellPreflightExtension(pi: ExtensionAPI): void {
  const configurationCache: ConfigurationCache = new Map();
  const configFor = harnessConfigFor(pi);
  let rootContext: ExtensionContext | undefined;
  let lifetime = new AbortController();
  const notifyManualApproval = (request: ShellApprovalRequest): void => {
    const root = rootContext;
    if (!root) return;
    const ownerLifetime = lifetime;
    const signal = request.signal === undefined ? ownerLifetime.signal : AbortSignal.any([ownerLifetime.signal, request.signal]);
    const url = configFor(root).shell.approval.notificationUrl;
    if (url === '' || signal.aborted) return;
    const summary = sanitizeTerminalText(truncateToWidth(sanitizeTerminalText(request.command), 300));
    const body = `Agent: ${sanitizeTerminalText(request.sourceAgent)}\nDirectory: ${sanitizeTerminalText(request.cwd)}\nCommand: ${summary}`;
    void sendApprovalNotification(url, { title: 'Shell approval required', body }, signal).catch(() => {
      if (!signal.aborted) {
        try { root.ui.notify('URL notification failed.', 'warning'); } catch {}
      }
    });
  };
  let manualController!: ManualApprovalController;
  let manualTui!: ShellApprovalTuiAdapter;
  const createManualApproval = (): void => {
    manualTui?.dispose();
    manualController?.dispose();
    const controller = new ManualApprovalController({
      canPresent: () => manualTui?.canPresent() ?? false,
    });
    manualController = controller;
    manualTui = new ShellApprovalTuiAdapter({
      controller,
      context: () => rootContext,
      onDisplay: notifyManualApproval,
    });
  };
  createManualApproval();
  let manualActive = true;
  pi.events.on(APPROVAL_CONTROLLER, data => {
    if (manualActive) (data as ApprovalControllerExchange).controller = manualController;
  });
  let mode: ShellPermissionMode | undefined;
  let autocompleteInstalled = false;
  let ruleSources: Promise<readonly string[]> | undefined;

  const status = (ctx: ExtensionContext): void => {
    const config = configFor(ctx).shell.approval;
    if (!config.enabled) return ctx.ui.setStatus('shell-permission', undefined);
    const selected = mode ?? config.mode;
    const label = PERMISSION_MODES.find(item => item.value === selected)!.label;
    ctx.ui.setStatus('shell-permission', 'Permissions: ' + label +
      (selected === 'auto' && (!config.reviewer.enabled || Number(process.versions.node.split('.')[0]) < AUTO_REVIEW_MIN_NODE_MAJOR)
        ? ' (manual fallback)' : ''));
  };
  const cancel = (): void => {
    manualActive = false;
    lifetime.abort();
    manualTui.dispose();
    manualController.dispose();
  };
  const activate = (ctx: ExtensionContext): void => {
    rootContext = ctx;
    manualActive = true;
    if (lifetime.signal.aborted) {
      lifetime = new AbortController();
      createManualApproval();
    }
    configurationCache.clear();
    status(ctx);
  };

  const check: ShellCheck = async (tool, command, ctx, source, waiting) => {
    const root = rootContext ?? ctx;
    const ownerLifetime = lifetime;
    const signal = ctx.signal === undefined ? ownerLifetime.signal : AbortSignal.any([ownerLifetime.signal, ctx.signal]);
    const shell = configFor(root).shell;
    if (shell.preflight) {
      const result = await preflight(tool, command, ctx, configurationCache);
      if (!result.ok) return failureReason(result);
    }
    if (signal.aborted) return 'Command not executed: approval cancelled.';
    const approval = shell.approval;
    const selected = mode ?? approval.mode;
    if (!approval.enabled || selected === 'yolo') return null;
    if (typeof command !== 'string') return 'Command not executed: command must be a string.';
    const configuration = commandConfiguration(tool, ctx, configurationCache);
    const action: ShellApprovalAction = {
      version: 1, shell: configuration.executable,
      command: combineCommand(configuration.prefix, command), cwd: ctx.cwd,
      platform: process.platform === 'win32' ? 'windows' : 'posix', source,
    };
    const extracted = await extractJobCommands({
      shell: action.shell, command: action.command, cwd: action.cwd, platform: action.platform,
    });
    if (signal.aborted) return 'Command not executed: approval cancelled.';
    // Ordinary shell commands retain their original syntax. Only pi-job calls
    // replace the wrapper with actual argv; every sibling remains represented.
    const hasJob = extracted.kind === 'extracted' && extracted.containsPiJob;
    const candidates: readonly ShellApprovalAction[] = hasJob && extracted.kind === 'extracted'
      ? extracted.actions.map(item => ({ ...action, cwd: item.cwd, argv: item.argv }))
      : [action];
    if (candidates.length === 0) return null;
    let rules: readonly string[];
    try {
      rules = await (ruleSources ??= loadShellRuleFiles(approval.ruleFiles));
    } catch (error) {
      if (signal.aborted) return 'Command not executed: approval cancelled.';
      const reason = error instanceof Error ? error.message : String(error);
      root.ui.notify(`Rule file error: ${sanitizeTerminalText(reason)}`, 'error');
      return 'Command not executed: ' + reason;
    }
    if (signal.aborted) return 'Command not executed: approval cancelled.';
    const needsReview: string[] = [];
    for (const candidate of candidates) {
      const decision = await runShellPolicy(approval.command, { ...candidate, rules }, signal, approval.commandTimeoutMs);
      if (signal.aborted) return 'Command not executed: approval cancelled.';
      if (decision.decision === 'deny') return 'Command not executed: ' + decision.reason;
      if (decision.decision === 'review') needsReview.push(decision.reason);
    }
    if (needsReview.length === 0) return null;
    const extractedDetails = hasJob ? '\nExecution arguments: ' + JSON.stringify(candidates.map(item => ({ cwd: item.cwd, argv: item.argv }))) : '';
    let decisionReason = [...new Set(needsReview)].join('\n') + extractedDetails;
    if (selected === 'auto' && approval.reviewer.enabled) {
      const reviewer = createShellReviewer({
        modelRegistry: root.modelRegistry, provider: approval.reviewer.provider,
        model: approval.reviewer.model, timeoutMs: approval.reviewer.timeoutMs,
      });
      root.ui.setStatus('shell-permission', 'Permissions: Auto Approve (reviewing)');
      const reviewed = await reviewer.review({
        action: { ...action, reason: decisionReason },
        context: { branch: ctx.sessionManager.getBranch() }, signal,
      });
      if (signal.aborted) {
        if (!ownerLifetime.signal.aborted) status(root);
        return 'Command not executed: approval cancelled.';
      }
      const summary = sanitizeTerminalText(truncateToWidth(sanitizeTerminalText(action.command), 100));
      const origin = sanitizeTerminalText(source);
      if (reviewed.decision === 'allow') {
        status(root);
        root.ui.notify(`Auto-review allowed [${origin}]: ${summary}`, 'info');
        return null;
      }
      if (reviewed.decision === 'deny') {
        status(root);
        root.ui.notify(`Auto-review denied [${origin}]: ${summary}`, 'warning');
        return 'Command not executed: ' + reviewed.reason;
      }
      root.ui.notify(`Auto-review could not decide; manual approval required [${origin}]: ${summary}`, 'warning');
      decisionReason = reviewed.reason + extractedDetails;
      root.ui.setStatus('shell-permission', 'Permissions: Auto Approve (manual fallback)');
    }
    waiting?.(true);
    let result;
    try {
      result = await manualController.request({
        sourceAgent: source, shell: action.shell, cwd: action.cwd, command: action.command,
        reason: decisionReason, timeoutSeconds: approval.manualTimeoutMs / 1000, signal,
      });
    } finally { waiting?.(false); }
    if (!ownerLifetime.signal.aborted) status(root);
    if (signal.aborted) return 'Command not executed: approval cancelled.';
    return result.approved ? null : 'Command not executed: Manual approval denied (' + result.reason + ').';
  };
  publishShellCheck(pi, check);
  pi.on('session_start', (_event, ctx) => {
    mode = savedPermissionMode(ctx);
    ruleSources = undefined;
    activate(ctx);
    if (!autocompleteInstalled) {
      autocompleteInstalled = true;
      ctx.ui.addAutocompleteProvider(base => argumentCompletionProvider(base, 'permissions'));
    }
  });
  pi.on('session_tree', (_event, ctx) => {
    mode = savedPermissionMode(ctx);
    ruleSources = undefined;
    activate(ctx);
  });
  pi.on('agent_start', (_event, ctx) => activate(ctx));
  pi.on('session_before_tree', cancel);
  pi.on('session_before_switch', cancel);
  pi.on('session_before_fork', cancel);
  pi.on('session_shutdown', (_event, ctx) => { cancel(); ctx.ui.setStatus('shell-permission', undefined); });
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash' && event.toolName !== 'powershell') return;
    const reason = await check(event.toolName, event.input.command, ctx, 'Main');
    return reason === null ? undefined : { block: true, reason };
  });
  // Explicit user shell input is already authorized by the user; retain syntax checking.
  pi.on('user_bash', async (event, ctx) => {
    const signal = lifetime.signal;
    const windows = process.platform === 'win32';
    if (!configFor(ctx).shell.preflight) return windows ? { operations: createLocalPowerShellOperations() } : undefined;
    const result = await preflight(windows ? 'powershell' : 'bash', event.command, ctx, configurationCache);
    if (signal.aborted) return { result: { output: 'Command not executed: session changed.', exitCode: 2, cancelled: true, truncated: false } };
    if (result.ok) return windows ? { operations: createLocalPowerShellOperations() } : undefined;
    return { result: { output: failureReason(result), exitCode: 2, cancelled: false, truncated: false } };
  });
  pi.registerCommand('permissions', {
    description: 'Show or change Shell permissions: ask, auto, yolo',
    getArgumentCompletions: prefix => {
      const fragment = prefix.trimStart().toLowerCase();
      if (/\s/.test(fragment)) return null;
      const matches = PERMISSION_MODES.filter(choice => choice.value.startsWith(fragment));
      return matches.length === 0 ? null : matches;
    },
    handler: async (args, ctx) => {
      const ownerLifetime = lifetime;
      let selected = args.trim().toLowerCase();
      if (!configFor(ctx).shell.approval.enabled) {
        ctx.ui.notify('Shell approval is disabled. Set shell.approval.enabled to true.', 'warning');
        return;
      }
      if (selected === '') {
        const current = PERMISSION_MODES.find(item => item.value === (mode ?? configFor(ctx).shell.approval.mode))!;
        if (!ctx.hasUI || ctx.mode !== 'tui') {
          status(ctx);
          ctx.ui.notify(`Permissions: ${current.label}. Use /permissions ask|auto|yolo to change mode.`, 'info');
          return;
        }
        const options = PERMISSION_MODES.map(item => `${item.label}: ${item.description}`);
        const choice = await ctx.ui.select(`Shell permissions (current: ${current.label})`, options);
        const index = choice === undefined ? -1 : options.indexOf(choice);
        if (index < 0) return;
        selected = PERMISSION_MODES[index]!.value;
      }
      if (selected !== 'ask' && selected !== 'auto' && selected !== 'yolo') {
        ctx.ui.notify('Usage: /permissions ask|auto|yolo', 'warning'); return;
      }
      if (ownerLifetime.signal.aborted) return;
      if (mode !== selected) {
        try {
          pi.appendEntry(PERMISSION_MODE_ENTRY, { version: 1, mode: selected });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not save permissions: ${sanitizeTerminalText(reason)}`, 'error');
          return;
        }
      }
      mode = selected;
      status(ctx);
      const label = PERMISSION_MODES.find(item => item.value === selected)!.label;
      ctx.ui.notify(`Permissions set to ${label}. Applies to subsequent requests.`, 'info');
    },
  });
}
