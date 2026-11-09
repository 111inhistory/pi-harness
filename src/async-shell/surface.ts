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
        const host = await current(context);
        bound = host;
        const environment = host.environment(actorId);
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
