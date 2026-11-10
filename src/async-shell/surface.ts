import {
  createBashToolDefinition, createPowerShellToolDefinition, getAgentDir, SettingsManager,
  type ExtensionAPI, type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { AsyncShellHost } from './host.ts';
import { promptString } from '../prompt-text.ts';

/** Keep native shell execution, schemas and rendering; scope only its environment. */
export function installAsyncShellSurface(
  api: ExtensionAPI,
  current: (context: ExtensionContext) => Promise<AsyncShellHost>,
  actorId: string,
): void {
  let bound: AsyncShellHost | null = null;
  const factories = process.platform === 'win32'
    ? [createBashToolDefinition, createPowerShellToolDefinition]
    : [createBashToolDefinition];
  for (const factory of factories) {
    const definition = factory(process.cwd());
    api.registerTool({
      ...definition,
      promptGuidelines: [...(definition.promptGuidelines ?? []), promptString('async-shell.json', 'guideline')],
      async execute(id, input, signal, onUpdate, context) {
        // Native shell execution does not depend on callback IPC. Revoke inherited
        // leases first so a degraded root cannot route work into an older context.
        const environment: NodeJS.ProcessEnv = {
          PI_AGENT_ID: undefined, PI_AGENT_SOCKET: undefined,
          PI_ASYNC_SHELL_TOKEN: undefined, PI_ASYNC_SHELL_ROOT: undefined,
          PI_ASYNC_SHELL_HOST_ERROR: undefined,
        };
        try {
          const host = await current(context);
          Object.assign(environment, host.environment(actorId));
          bound = host;
        } catch (error) {
          environment.PI_ASYNC_SHELL_HOST_ERROR = error instanceof Error
            ? error.message || 'The async-shell callback host is unavailable.'
            : String(error) || 'The async-shell callback host is unavailable.';
        }
        const settings = SettingsManager.create(context.cwd, getAgentDir(), { projectTrusted: context.isProjectTrusted() });
        const shellPath = settings.getShellPath();
        const commandPrefix = settings.getShellCommandPrefix();
        return factory(context.cwd, {
          ...(shellPath === undefined ? {} : { shellPath }),
          ...(commandPrefix === undefined ? {} : { commandPrefix }),
          spawnHook: spawn => ({ ...spawn, env: { ...spawn.env, ...environment, PI_CODING_AGENT_DIR: getAgentDir() } }),
        }).execute(id, input, signal, onUpdate, context);
      },
    });
  }
  api.on('session_shutdown', async () => { await bound?.release(actorId); });
}
