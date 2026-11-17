/**
 * Model preset extension.
 *
 * Composes the pure preset modules into a Pi extension: it loads `presets.json`
 * (global + trusted project), exposes `/preset` and the `--preset` startup flag,
 * applies model / thinking / tools live, records a resolved snapshot on the
 * branch, and renders its current instructions as request-local system sections.
 * Model/thinking/tool selection use the public SDK session API; resume, tree
 * navigation, fork and reload restore instructions from the resolved snapshot.
 *
 * Registered in `package.json` `pi.extensions`. Codemode mode is applied through
 * a `codemode-mode` branch record, which the harness loadout reads from the next
 * request. Hosts without this override report a warning instead of claiming
 * that the mode changed.
 */

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import {
  applyPresetToSession,
  clearPresetFromSession,
  currentPreset,
  ensureSessionToolBase,
  loadPresets,
  type PresetConfig,
} from '../src/preset/application.ts';
import { parsePresetCommand } from '../src/preset/command.ts';
import { installPresetInstruction } from '../src/preset/instruction.ts';

export default function presetExtension(pi: ExtensionAPI): void {
  pi.registerFlag('preset', { description: 'Preset configuration to apply at startup', type: 'string' });

  let currentName: string | undefined;

  const sessionHost = (ctx: ExtensionContext) => ({
    pi,
    getBranch: () => ctx.sessionManager.getBranch(),
    modelRegistry: ctx.modelRegistry,
  });

  const renderStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus('preset', currentName === undefined ? undefined : `preset:${currentName}`);
  };

  const clear = (ctx: ExtensionContext): void => {
    const outcome = clearPresetFromSession(sessionHost(ctx));
    currentName = undefined;
    renderStatus(ctx);
    // Clearing ends the preset's blacklist lifetime without rolling the base,
    // model or thinking level back. The records are already withdrawn, so never
    // claim the live loadout was synchronized when that effect failed.
    if (outcome.toolSyncError !== null) {
      ctx.ui.notify(
        `Preset cleared; its tool blacklist was withdrawn, but the tool loadout could not be synchronized: ${outcome.toolSyncError}. `
        + 'Model, thinking and the tool baseline are unchanged.',
        'warning',
      );
      return;
    }
    ctx.ui.notify(
      'Preset cleared; its tool blacklist was withdrawn. Model, thinking and the tool baseline are unchanged.',
      'info',
    );
  };

  const apply = async (ctx: ExtensionContext, name: string, preset: PresetConfig): Promise<void> => {
    let outcome: Awaited<ReturnType<typeof applyPresetToSession>>;
    try {
      outcome = await applyPresetToSession(sessionHost(ctx), name, preset);
    } catch (error) {
      // A record write can fail before any outcome exists. Report it instead of
      // escaping the event/command handler; there is no rollback or retry.
      const detail = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Preset "${name}" could not be applied: ${detail}`, 'error');
      return;
    }
    for (const issue of outcome.issues) {
      ctx.ui.notify(`Preset "${name}": ${issue.detail}`, issue.severity);
    }
    for (const problem of outcome.problems) {
      ctx.ui.notify(`Preset "${name}": ${problem.detail}`, problem.severity);
    }
    if (outcome.applied) {
      if (outcome.problems.some((problem) => problem.kind === 'tool_sync_failed')) {
        ctx.ui.notify(`Preset "${name}" applied; the tool loadout could not be synchronized.`, 'warning');
      } else {
        ctx.ui.notify(
          outcome.codemodeNotApplied
            ? `Preset "${name}" applied; codemode mode was recorded but not switched.`
            : `Preset "${name}" applied.`,
          outcome.codemodeNotApplied ? 'warning' : 'info',
        );
      }
      currentName = name;
      renderStatus(ctx);
    } else if (outcome.issues.length === 0 && outcome.problems.length === 0) {
      ctx.ui.notify(`Preset "${name}" was not applied.`, 'error');
    }
  };

  const loaded = (ctx: ExtensionContext) => {
    const catalog = loadPresets({ cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() });
    for (const warning of catalog.warnings) ctx.ui.notify(warning, 'warning');
    return catalog.presets;
  };

  pi.on('session_start', async (_event, ctx) => {
    // Shared session tool baseline: the true initial active set — native
    // defaults, CLI initial-selection modifiers and default-active extension
    // tools such as `capability`. Captured once before any `--preset` applies, so
    // a resume/reload that already reflects a prior preset cannot become the new
    // baseline while every modifier still computes from the same starting set.
    // The capability extension may already have reported the same write
    // failure; never let a second unguarded attempt abort the startup handler.
    try {
      ensureSessionToolBase(sessionHost(ctx));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Preset: the tool baseline could not be recorded: ${detail}. Tool selections are unavailable until it can be written.`,
        'error',
      );
    }
    currentName = currentPreset(sessionHost(ctx))?.name;
    const presets = loaded(ctx);
    const flag = pi.getFlag('preset');
    if (typeof flag === 'string' && flag !== '') {
      const preset = presets.get(flag);
      if (preset === undefined) ctx.ui.notify(`Unknown preset "${flag}".`, 'warning');
      else await apply(ctx, flag, preset);
    }
    renderStatus(ctx);
  });

  pi.registerCommand('preset', {
    description: 'Switch model preset',
    handler: async (args, ctx) => {
      const command = parsePresetCommand(args);
      if (command.kind === 'clear') {
        clear(ctx);
        return;
      }
      const presets = loaded(ctx);
      if (command.kind === 'show') {
        const names = [...presets.keys()].sort();
        if (names.length === 0) {
          ctx.ui.notify('No presets configured.', 'warning');
          return;
        }
        const choice = await ctx.ui.select('Select preset', [...names, '(none)']);
        if (choice === undefined) return;
        if (choice === '(none)') {
          clear(ctx);
          return;
        }
        const preset = presets.get(choice);
        if (preset !== undefined) await apply(ctx, choice, preset);
        return;
      }
      const preset = presets.get(command.name);
      if (preset === undefined) {
        ctx.ui.notify(`Unknown preset "${command.name}".`, 'error');
        return;
      }
      await apply(ctx, command.name, preset);
    },
  });

  installPresetInstruction(pi);
}
