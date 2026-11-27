import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ConfigStaleError, configLifecycleFor } from '../src/config-lifecycle.ts';
import { installHarnessSession } from '../src/session/application.ts';
import { installRootSubagentSurface } from '../src/subagent/extension.ts';
import { sanitizeTerminalText } from '../src/shell-approval/ui.ts';

/** Compose the root host; child sessions install their own scoped surfaces. */
export default function harnessExtension(api: ExtensionAPI): void {
  const session = installHarnessSession(api);
  installRootSubagentSurface(api, session);
  const lifecycle = configLifecycleFor(api);
  let pending: (() => boolean) | undefined;
  api.registerCommand('config', {
    description: 'Reload Hook and Shell rule files: /config reload',
    async handler(args, ctx) {
      if (args.trim() !== 'reload') {
        ctx.ui.notify('Usage: /config reload', 'info');
        return;
      }
      let current: (() => boolean) | undefined;
      try {
        current = lifecycle.captureScope(ctx);
        if (pending?.()) {
          ctx.ui.notify('A configuration reload is running.', 'info');
          return;
        }
        pending = current;
        const results = await lifecycle.refreshLeaves(ctx);
        if (!current()) return;
        if (results.length === 0) ctx.ui.notify('No reloadable configuration is installed.', 'info');
        for (const result of results) {
          if (!current()) return;
          if (result.status === 'failed') {
            const reason = result.error instanceof Error ? result.error.message : String(result.error);
            const state = result.keptPrevious ? ' (previous snapshot retained)' : '';
            ctx.ui.notify(`${result.name}: failed${state}. ${sanitizeTerminalText(reason)}`, 'warning');
          } else ctx.ui.notify(`${result.name}: ${result.status}.`, 'info');
        }
      } catch (error) {
        if (!(error instanceof ConfigStaleError) && current?.()) throw error;
      } finally {
        if (pending === current) pending = undefined;
      }
    },
  });
}
