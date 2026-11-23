import {
  createBashToolDefinition, createPowerShellToolDefinition, getAgentDir, SettingsManager,
  getPowerShellConfig, getShellConfig, createLocalBashOperations, createLocalPowerShellOperations,
  type ExtensionAPI, type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { accessSync, constants } from 'node:fs';
import type { AsyncShellHost } from './host.ts';
import type { ShellResult } from './protocol.ts';
import { promptString } from '../prompt-text.ts';
import { checkManagedShell, markManagedShell } from '../shell-approval/bridge.ts';
import { harnessConfigFor } from '../harness-config.ts';
import { piJobExecutable } from './executable.ts';

const jobId = Type.String({ pattern: '^job_[0-9a-f]{8}$' });

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
    api.registerTool({
      ...definition,
      parameters: markManagedShell(Type.Object({
        ...definition.parameters.properties,
        background: Type.Optional(Type.Boolean({ description: 'Return the Job immediately after startup.' })),
        pty: Type.Optional(Type.Boolean({ description: 'Allocate a terminal for a Job that needs terminal input or TTY behavior.' })),
      })),
      promptGuidelines: [...(definition.promptGuidelines ?? []), promptString('async-shell.json', 'guideline')],
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
        const autoWait = configFor(context).shell.autoBackgroundAfterMs;
        let jobResult: ShellResult | undefined;
        const result = await factory(context.cwd, {
          ...(commandPrefix === undefined ? {} : { commandPrefix }),
          spawnHook: spawn => ({ ...spawn, env: { ...spawn.env, ...environment, PI_CODING_AGENT_DIR: getAgentDir() } }),
          operations: {
            async exec(effective, cwd, options) {
              const env = options.env ?? {};
              await checkManagedShell(approvalApi, definition.name, command, context, actorId, api.events, signal,
                { executable: shell.shell, command: effective, cwd, env });
              signal?.throwIfAborted();
              let managed = explicitJob || (timeout === undefined && shell.commandTransport !== 'stdin' && host !== undefined);
              if (managed) {
                try { accessSync(piJobExecutable(), constants.X_OK); }
                catch (error) { if (explicitJob) throw error; managed = false; }
              }
              if (!managed) {
                if (powershell && getPowerShellConfig().shell !== shell.shell) throw new Error('The approved PowerShell executable changed before launch.');
                return native.exec(effective, cwd, options);
              }
              if (host === undefined) throw new Error(environment.PI_ASYNC_SHELL_HOST_ERROR);
              if (shell.commandTransport === 'stdin') throw new Error('This shell requires command text on stdin and cannot start a managed Job.');
              if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647)) {
                throw new Error('Invalid timeout: expected positive seconds, at most 2147483.647.');
              }
              // The SDK adds this fixed output-encoding bootstrap in its local
              // PowerShell operations, not in the user command/policy input.
              const text = powershell ? `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${effective}` : effective;
              jobResult = await host.start(actorId, pty, [
                ...(pty ? [] : ['--pipe']),
                ...(background ? ['--wait', '0'] : timeout !== undefined ? ['--foreground'] : ['--wait', String(autoWait)]),
                ...(timeout === undefined ? [] : ['--timeout', String(Math.ceil(timeout * 1000))]),
                '--', shell.shell, ...shell.args, text,
              ], cwd, env, signal);
              return { exitCode: 0 };
            },
          },
        }).execute(id, { command, ...(timeout === undefined ? {} : { timeout }) }, signal, onUpdate, context);
        if (jobResult === undefined) return result;
        const { id: job, status, exitCode, output, logPath, message, truncated } = jobResult;
        // Return a Job reference only when the caller requested one or the wait
        // window actually moved the command into the background.
        const text = background || status === 'running'
          ? JSON.stringify({ id: job, status, exitCode, output, logPath, message })
          : [output || '(no output)',
            exitCode !== null && exitCode !== 0 ? `Command exited with code ${exitCode}`
              : status !== 'completed' ? message ?? `Command ${status.replaceAll('_', ' ')}.` : undefined,
            truncated || status === 'internal_error' ? `Full output: ${logPath}` : undefined,
          ].filter(part => part !== undefined).join('\n\n');
        return {
          content: [{ type: 'text', text }],
          details: undefined,
          isError: status !== 'running' && status !== 'completed',
        };
      },
    });
  }
  api.registerTool({
    name: 'job_stop', label: 'Stop Job', description: promptString('async-shell.json', 'stop'),
    parameters: Type.Object({ id: jobId }),
    async execute(_call, { id }, signal, _update, ctx) {
      signal?.throwIfAborted();
      const host = await current(ctx);
      signal?.throwIfAborted();
      const result = await host.stop(actorId, id, ctx.cwd);
      const { status, exitCode, output, logPath, message } = result;
      return { content: [{ type: 'text', text: JSON.stringify({ id, status, exitCode, output, logPath, message }) }],
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
