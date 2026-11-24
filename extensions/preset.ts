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
  currentPresetView,
  ensureSessionToolBase,
  loadPresets,
  type PresetConfig,
} from '../src/preset/application.ts';
import { parsePresetCommand } from '../src/preset/command.ts';
import { installPresetInstruction } from '../src/preset/instruction.ts';
import { appendSkippedVersion, PRESET_VERSION_SKIPPED_VERSION, readSkippedVersion } from '../src/preset/state.ts';
import { argumentCompletionProvider } from '../src/autocomplete.ts';

export default function presetExtension(pi: ExtensionAPI): void {
  pi.registerFlag('preset', { description: 'Preset configuration to apply at startup', type: 'string' });

  let completionContext: ExtensionContext | undefined;
  let autocompleteInstalled = false;

  const sessionHost = (ctx: ExtensionContext) => ({
    pi,
    getBranch: () => ctx.sessionManager.getBranch(),
    modelRegistry: ctx.modelRegistry,
  });

  const renderStatus = (ctx: ExtensionContext, view: ReturnType<typeof currentPresetView>, warn = false): void => {
    const name = view.preset?.name;
    const marker = view.status === 'missing' ? 'missing' : view.status === 'unresolvable' ? 'invalid'
      : view.status === 'outdated' ? 'update available' : undefined;
    ctx.ui.setStatus('preset', name === undefined ? undefined : `preset:${name}${marker === undefined ? '' : ` (${marker})`}`);
    if (warn && name !== undefined && (view.status === 'missing' || view.status === 'unresolvable')) {
      ctx.ui.notify(`Preset "${name}" is ${marker}; keeping its recorded version.`, 'warning');
    }
  };

  const clear = (ctx: ExtensionContext): void => {
    const outcome = clearPresetFromSession(sessionHost(ctx));
    ctx.ui.setStatus('preset', undefined);
    if (outcome.toolSyncError !== null) {
      ctx.ui.notify(
        `Preset cleared; its tool contributions were withdrawn. The live tool loadout could not be synchronized: ${outcome.toolSyncError}.`,
        'warning',
      );
      return;
    }
    ctx.ui.notify(
      'Preset cleared; tools now follow the branch baseline and manual choices. Model and thinking are unchanged.',
      'info',
    );
  };

  const apply = async (ctx: ExtensionContext, name: string, preset: PresetConfig, expectedVersion?: string): Promise<void> => {
    let outcome: Awaited<ReturnType<typeof applyPresetToSession>>;
    try {
      outcome = await applyPresetToSession(sessionHost(ctx), name, preset, expectedVersion === undefined ? {} : { expectedVersion });
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
    if (outcome.unchanged) {
      ctx.ui.notify(`Preset "${name}" is already current.`, 'info');
    } else if (outcome.applied) {
      if (outcome.problems.some((problem) => problem.kind === 'tool_sync_failed')) {
        ctx.ui.notify(`Preset "${name}" applied; the tool loadout could not be synchronized.`, 'warning');
      } else {
        ctx.ui.notify(`Preset "${name}" applied.`, 'info');
      }
    } else if (outcome.issues.length === 0 && outcome.problems.length === 0) {
      ctx.ui.notify(`Preset "${name}" was not applied.`, 'error');
    }
    renderStatus(ctx, compare(ctx, catalog(ctx)));
  };

  const catalog = (ctx: ExtensionContext) => loadPresets({ cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() });
  const compare = (ctx: ExtensionContext, config: ReturnType<typeof catalog>) =>
    currentPresetView(sessionHost(ctx), config);
  const loaded = (ctx: ExtensionContext) => {
    const config = catalog(ctx);
    for (const warning of config.warnings) ctx.ui.notify(warning, 'warning');
    return config;
  };

  pi.on('session_start', async (_event, ctx) => {
    completionContext = ctx;
    if (!autocompleteInstalled && ctx.hasUI && ctx.mode === 'tui') {
      ctx.ui.addAutocompleteProvider(base => argumentCompletionProvider(base, 'preset'));
      autocompleteInstalled = true;
    }
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
    const config = loaded(ctx);
    const flag = pi.getFlag('preset');
    if (typeof flag === 'string' && flag !== '') {
      const preset = config.presets.get(flag);
      if (preset === undefined) ctx.ui.notify(`Unknown preset "${flag}".`, 'warning');
      else {
        await apply(ctx, flag, preset);
        return;
      }
    }
    const host = sessionHost(ctx);
    const view = compare(ctx, config);
    renderStatus(ctx, view, true);
    if (!(ctx.hasUI && ctx.mode === 'tui') || view.status !== 'outdated' || view.preset === null || !view.currentVersion) return;
    const { name, contentHash } = view.preset;
    const branch = host.getBranch();
    const leaf = branch.at(-1)?.id;
    const skipped = readSkippedVersion(branch);
    if (skipped?.name === name && skipped.fromHash === contentHash && skipped.candidateHash === view.currentVersion) return;
    const update = 'Switch to the current version';
    const keep = 'Keep the recorded version';
    const choice = await ctx.ui.select(`Preset "${name}" has an update: ${view.changes.join(', ')}`, [update, keep]);
    if (host.getBranch().at(-1)?.id !== leaf) return;
    if (choice === update) {
      const preset = loaded(ctx).presets.get(name);
      if (preset !== undefined) await apply(ctx, name, preset, view.currentVersion);
      else renderStatus(ctx, compare(ctx, catalog(ctx)), true);
    } else if (choice === keep) {
      appendSkippedVersion(pi, { version: PRESET_VERSION_SKIPPED_VERSION, name, fromHash: contentHash, candidateHash: view.currentVersion });
    }
  });

  pi.on('session_tree', (_event, ctx) => renderStatus(ctx, compare(ctx, catalog(ctx)), true));

  pi.registerCommand('preset', {
    description: 'Switch model preset',
    getArgumentCompletions: prefix => {
      const configured = completionContext === undefined ? [] : [...catalog(completionContext).presets.keys()];
      const matches = [...new Set(['clear', 'show', ...configured.sort()])]
        .filter(name => name.startsWith(prefix.trimStart()))
        .map(name => ({ value: name, label: name }));
      return matches.length === 0 ? null : matches;
    },
    handler: async (args, ctx) => {
      const command = parsePresetCommand(args);
      if (command.kind === 'clear') {
        clear(ctx);
        return;
      }
      const { presets } = loaded(ctx);
      if (command.kind === 'show') {
        const names = [...presets.keys()].sort();
        if (names.length === 0 && currentPreset(sessionHost(ctx)) === null) {
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
