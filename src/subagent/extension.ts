/** Root Subagent tools and commands; the session host owns lifecycle and RPC. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installAsyncShellSurface } from '../async-shell/surface.ts';
import { argumentCompletionProvider } from '../autocomplete.ts';
import { DEFAULT_HARNESS_CONFIG } from '../harness-config.ts';
import { installSubagentCommand } from './command.ts';
import { installSessionSurface } from './surface.ts';
import type { HarnessSessionApplication } from '../session/application.ts';

export function installRootSubagentSurface(api: ExtensionAPI, access: Pick<HarnessSessionApplication, 'current' | 'peers' | 'configFor'>): void {
  let autocompleteInstalled = false;
  api.on('session_start', (_event, ctx) => {
    if (autocompleteInstalled) return;
    autocompleteInstalled = true;
    ctx.ui.addAutocompleteProvider(base => argumentCompletionProvider(base, 'subagent'));
  });
  installSubagentCommand(api, access.current, access.peers);
  installAsyncShellSurface(api, async ctx => (await access.current(ctx)).shell, 'Main');
  installSessionSurface(api, access.current, {
    callerId: 'Main', depth: 0, allowInherited: true, cwd: process.cwd(),
    maxDepth: DEFAULT_HARNESS_CONFIG.subagent.maxDepth,
    capacityFor: ctx => access.configFor(ctx).subagent,
  });
}
