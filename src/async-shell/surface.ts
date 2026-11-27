import {
  createBashToolDefinition, createPowerShellToolDefinition, getAgentDir, SettingsManager,
  getPowerShellConfig, getShellConfig, createLocalBashOperations, createLocalPowerShellOperations,
  type BashToolDetails, type ExtensionAPI, type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { accessSync, constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Text } from '@earendil-works/pi-tui';
import type { AsyncShellHost } from './host.ts';
import type { ShellResult } from './protocol.ts';
import { promptString } from '../prompt-text.ts';
import { checkManagedShell, markManagedShell } from '../shell-approval/bridge.ts';
import { harnessConfigFor } from '../harness-config.ts';
import { piJobExecutable } from './executable.ts';
import { describeShellResult, shellText, type ShellPresentation } from './presentation.ts';
import { renderShellPresentation } from '../result-rendering.ts';
import { readTailFile } from '../text-output.ts';

const jobId = Type.String({ pattern: '^job_[0-9a-f]{8}$' });
const shellOutput = Type.Object({
  output: Type.String(), truncated: Type.Boolean(), full_output_path: Type.Optional(Type.String()),
  full_output_error: Type.Optional(Type.String()),
  exit_code: Type.Union([Type.Number(), Type.Null()]), wall_time_seconds: Type.Number(),
  status: Type.Union([Type.Literal('running'), Type.Literal('completed'), Type.Literal('failed'),
    Type.Literal('timed_out'), Type.Literal('cancelled'), Type.Literal('internal_error')]),
  job_id: Type.Optional(jobId),
});

const STRUCTURED_OUTPUT_BYTES = 1024 * 1024;

async function structuredOutput(result: ShellResult): Promise<{ output: string; truncated: boolean }> {
  if (!result.truncated) return { output: result.output, truncated: false };
  // The delivery snapshot ends at cursor. A running Job may have appended
  // more bytes by the time the script receives this larger, bounded view.
  try {
    const file = await open(result.logPath, 'r');
    try {
      const read = async (size: number, offset: number): Promise<Buffer> => {
        const buffer = Buffer.allocUnsafe(size);
        const { bytesRead } = await file.read(buffer, 0, size, offset);
        if (bytesRead !== size) throw new Error('Incomplete job log snapshot.');
        return buffer;
      };
      if (result.cursor <= STRUCTURED_OUTPUT_BYTES) {
        return { output: (await read(result.cursor, 0)).toString('utf8'), truncated: false };
      }
      const size = STRUCTURED_OUTPUT_BYTES / 2;
      const head = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await read(size, 0), { stream: true });
      const tail = await read(size, result.cursor - size);
      let start = 0;
      while ((tail[start]! & 0xc0) === 0x80) start++;
      return { output: head + tail.subarray(start).toString('utf8'), truncated: true };
    } finally {
      await file.close();
    }
  } catch {
    // The result was already delivered by the backend. If the larger view
    // is unavailable, keep its excerpt rather than misreport the launch.
    return { output: result.output, truncated: true };
  }
}

/** Bind approval to the SDK-prepared command and environment before launch. */
export function installAsyncShellSurface(
  api: ExtensionAPI,
  current: (context: ExtensionContext) => Promise<AsyncShellHost>,
  actorId: string,
  approvalApi = api,
): void {
  let bound: AsyncShellHost | null = null;
  const configFor = harnessConfigFor(api);
  const factories = process.platform === 'win32'
    ? [createBashToolDefinition, createPowerShellToolDefinition]
    : [createBashToolDefinition];
  for (const factory of factories) {
    const definition = factory(process.cwd());
    const parameters = markManagedShell(Type.Object({
      ...definition.parameters.properties,
      timeout: Type.Optional(Type.Number({ description: 'Total runtime limit in seconds. A managed command still running at the foreground wait limit may return as a Job without resetting the timeout.' })),
      background: Type.Optional(Type.Boolean({ description: 'Return the Job immediately after startup. A timeout still limits total runtime.' })),
      pty: Type.Optional(Type.Boolean({ description: 'Allocate a terminal for a Job that needs terminal input or TTY behavior.' })),
    }));
    api.registerTool<typeof parameters, BashToolDetails | { shell: ShellPresentation } | undefined>({
      ...definition,
      outputSchema: shellOutput,
      parameters,
      promptGuidelines: [...(definition.promptGuidelines ?? []), promptString('async-shell.json', 'guideline')],
      renderCall(args, theme) {
        const prompt = definition.name === 'powershell' ? 'PS>' : '$';
        const command = typeof args?.command === 'string' ? args.command : '…';
        const tags = [typeof args?.timeout === 'number' ? ` (timeout ${args.timeout}s)` : '', args?.background ? ' (background)' : '', args?.pty ? ' (pty)' : ''];
        return new Text(theme.fg('toolTitle', theme.bold(`${prompt} ${command}`)) + theme.fg('muted', tags.join('')), 0, 0);
      },
      renderResult(result, options, theme, context) {
        if (result.details && 'shell' in result.details) return renderShellPresentation(result.details.shell, options.expanded, theme);
        return definition.renderResult!({ ...result, details: result.details }, options, theme, { ...context, lastComponent: undefined });
      },
      async execute(id, input, signal, onUpdate, context) {
        // Native shell execution does not depend on callback IPC. Revoke inherited
        // leases first so a degraded root cannot route work into an older context.
        const environment: NodeJS.ProcessEnv = {
          PI_AGENT_ID: undefined, PI_AGENT_SOCKET: undefined,
          PI_ASYNC_SHELL_TOKEN: undefined, PI_ASYNC_SHELL_ROOT: undefined,
          PI_ASYNC_SHELL_HOST_ERROR: undefined,
        };
        let host: AsyncShellHost | undefined;
        try {
          host = await current(context);
          Object.assign(environment, host.environment(actorId));
          bound = host;
        } catch (error) {
          host = undefined;
          environment.PI_ASYNC_SHELL_HOST_ERROR = error instanceof Error
            ? error.message || 'The async-shell callback host is unavailable.'
            : String(error) || 'The async-shell callback host is unavailable.';
        }
        const settings = SettingsManager.create(context.cwd, getAgentDir(), { projectTrusted: context.isProjectTrusted() });
        const shellPath = settings.getShellPath();
        const powershell = definition.name === 'powershell';
        const commandPrefix = settings.getShellCommandPrefix();
        const { background = false, pty = false, timeout, command } = input;
        const explicitJob = background || pty;
        const shell = powershell ? getPowerShellConfig() : getShellConfig(shellPath);
        const native = powershell ? createLocalPowerShellOperations() : createLocalBashOperations({ shellPath: shell.shell });
        const { autoBackgroundAfterMs, maxForegroundWaitMs } = configFor(context).shell;
        const timeoutMs = timeout === undefined ? undefined : timeout * 1000;
        const waitMs = background ? 0 : timeoutMs === undefined ? autoBackgroundAfterMs
          : timeoutMs <= maxForegroundWaitMs ? undefined : maxForegroundWaitMs;
        let jobResult: ShellResult | undefined;
        let startedAt = 0;
        let nativeTimeout: string | undefined;
        const result = await factory(context.cwd, {
          ...(commandPrefix === undefined ? {} : { commandPrefix }),
          spawnHook: spawn => ({ ...spawn, env: { ...spawn.env, ...environment, PI_CODING_AGENT_DIR: getAgentDir() } }),
          operations: {
            async exec(effective, cwd, options) {
              const env = options.env ?? {};
              await checkManagedShell(approvalApi, definition.name, command, context, actorId, api.events, signal,
                { executable: shell.shell, command: effective, cwd, env });
              signal?.throwIfAborted();
              let managed = explicitJob || (shell.commandTransport !== 'stdin' && host !== undefined);
              if (managed) {
                try { accessSync(piJobExecutable(), constants.X_OK); }
                catch (error) { if (explicitJob) throw error; managed = false; }
              }
              if (!managed) {
                if (powershell && getPowerShellConfig().shell !== shell.shell) throw new Error('The approved PowerShell executable changed before launch.');
                try {
                  return await native.exec(effective, cwd, options);
                } catch (error) {
                  if (!(error instanceof Error) || !error.message.startsWith('timeout:')) throw error;
                  // Let the SDK finish its output snapshot for programmatic
                  // callers; preserve the timeout, rather than the sentinel exit.
                  nativeTimeout = error.message.slice('timeout:'.length);
                  return { exitCode: 0 };
                }
              }
              if (host === undefined) throw new Error(environment.PI_ASYNC_SHELL_HOST_ERROR);
              if (shell.commandTransport === 'stdin') throw new Error('This shell requires command text on stdin and cannot start a managed Job.');
              if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647)) {
                throw new Error('Invalid timeout: expected positive seconds, at most 2147483.647.');
              }
              // The SDK adds this fixed output-encoding bootstrap in its local
              // PowerShell operations, not in the user command/policy input.
              const text = powershell ? `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${effective}` : effective;
              startedAt = performance.now();
              let previewTimer: ReturnType<typeof setTimeout> | undefined;
              let previewEnded = false;
              let previousPreview: string | undefined;
              const startPreview = background || !context.hasUI || !onUpdate ? undefined : (directory: string): void => {
                const logPath = join(directory, 'output.log');
                const tick = async (): Promise<void> => {
                  try {
                    const tail = await readTailFile(logPath, { maxLines: 200, maxBytes: 8192 }, signal);
                    if (!previewEnded && !signal?.aborted && tail.text !== previousPreview && tail.text) {
                      previousPreview = tail.text;
                      onUpdate({ content: [], details: { shell: { output: tail.text, terminal: true,
                        ...(tail.truncated ? { footer: `[Showing recent output. Full output: ${logPath}]` } : {}),
                      } } });
                    }
                  } catch {
                    // The log may not exist yet; a preview failure cannot change the launch outcome.
                  }
                  if (!previewEnded && !signal?.aborted) previewTimer = setTimeout(() => void tick(), 250);
                };
                previewTimer = setTimeout(() => void tick(), 250);
              };
              try {
                jobResult = await host.start(actorId, pty, [
                  ...(pty ? [] : ['--pipe']),
                  ...(waitMs === undefined ? ['--foreground'] : ['--wait', String(waitMs)]),
                  ...(timeoutMs === undefined ? [] : ['--timeout', String(Math.ceil(timeoutMs))]),
                  '--', shell.shell, ...shell.args, text,
                ], cwd, env, signal, startPreview);
              } finally {
                previewEnded = true;
                clearTimeout(previewTimer);
              }
              return { exitCode: 0 };
            },
          },
        }).execute(id, { command, ...(timeout === undefined ? {} : { timeout }) }, signal, onUpdate, context);
        if (jobResult === undefined) {
          const value = result.structuredContent;
          if (!value || typeof value !== 'object' || !('exit_code' in value)) return result;
          if (nativeTimeout !== undefined) {
            return {
              ...result, isError: true,
              content: [...result.content, { type: 'text', text: `Command timed out after ${nativeTimeout} seconds` }],
              structuredContent: { ...value, exit_code: null, status: 'timed_out' },
            };
          }
          return { ...result, structuredContent: { ...value, status: value.exit_code === 0 ? 'completed' : 'failed' } };
        }
        const { id: job, status, exitCode, logPath, truncated } = jobResult;
        const jobDelivery = background || status === 'running';
        const view = describeShellResult(jobResult, jobDelivery ? 'background' : 'foreground',
          !background && status === 'running' && waitMs !== undefined
            ? { milliseconds: waitMs, ...(timeout === undefined ? {} : { timeout }) } : undefined);
        return {
          content: [{ type: 'text', text: shellText(view) }],
          details: { shell: view },
          structuredContent: {
            ...await structuredOutput(jobResult), status, exit_code: status === 'completed' || status === 'failed' ? exitCode : null,
            wall_time_seconds: Math.round((performance.now() - startedAt) / 100) / 10,
            ...(jobDelivery ? { job_id: job } : {}),
            ...(jobDelivery || truncated || status === 'internal_error' ? { full_output_path: logPath } : {}),
          },
          isError: status !== 'running' && status !== 'completed',
        };
      },
    });
  }
  const stopParameters = Type.Object({ id: jobId });
  api.registerTool<typeof stopParameters, ShellResult>({
    name: 'job_stop', label: 'Stop Job', description: promptString('async-shell.json', 'stop'),
    parameters: stopParameters,
    renderResult(result, options, theme) {
      return result.details ? renderShellPresentation(describeShellResult(result.details, 'terminal'), options.expanded, theme)
        : new Text(result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n'), 0, 0);
    },
    async execute(_call, { id }, signal, _update, ctx) {
      signal?.throwIfAborted();
      const host = await current(ctx);
      signal?.throwIfAborted();
      const result = await host.stop(actorId, id, ctx.cwd);
      const { status } = result;
      return { content: [{ type: 'text', text: shellText(describeShellResult(result, 'terminal')) }],
        details: result, isError: status === 'internal_error' || status === 'running' };
    },
  });
  api.registerTool({
    name: 'job_send', label: 'Send Job Input', description: promptString('async-shell.json', 'send'),
    parameters: Type.Object({ id: jobId, text: Type.String(), enter: Type.Optional(Type.Boolean()) }),
    async execute(_call, { id, text, enter = false }, signal, _update, ctx) {
      const host = await current(ctx);
      const input = { text, enter };
      await host.input(actorId, id, input, ctx.cwd, signal,
        () => checkManagedShell(approvalApi, 'job_send', { id, ...input }, ctx, actorId, api.events, signal));
      return { content: [{ type: 'text', text: `Input sent to ${id}.` }], details: undefined };
    },
  });
  api.registerTool({
    name: 'job_key', label: 'Send Job Key', description: promptString('async-shell.json', 'key'),
    parameters: Type.Object({ id: jobId, key: Type.String({ minLength: 1 }) }),
    async execute(_call, { id, key }, signal, _update, ctx) {
      const host = await current(ctx);
      await host.input(actorId, id, { key }, ctx.cwd, signal,
        () => checkManagedShell(approvalApi, 'job_key', { id, key }, ctx, actorId, api.events, signal));
      return { content: [{ type: 'text', text: `Key sent to ${id}.` }], details: undefined };
    },
  });
  api.on('session_shutdown', async () => { await bound?.release(actorId); });
}
