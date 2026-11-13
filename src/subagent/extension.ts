/** Root Subagent tools and commands; the session host owns lifecycle and RPC. */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installAsyncShellSurface } from '../async-shell/surface.ts';
import { argumentCompletionProvider } from '../autocomplete.ts';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfigProvider } from '../harness-config.ts';
import { installSubagentCommand } from './command.ts';
import { installSessionSurface } from './surface.ts';
import type { RootService } from './root-service.ts';
import type { LiveSession } from './session-directory.ts';

export interface RootSubagentAccess {
  current(ctx: ExtensionContext): Promise<RootService>;
  peers(): Promise<LiveSession[]>;
  readonly configFor: HarnessConfigProvider;
}

export function installRootSubagentSurface(api: ExtensionAPI, access: RootSubagentAccess): void {
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
