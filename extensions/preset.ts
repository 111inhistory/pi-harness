/**
 * Model preset extension.
 *
 * Composes the pure preset modules into a Pi extension: it loads `presets.json`
 * (global + trusted project), exposes `/preset` and the `--preset` startup flag,
 * applies model / thinking / tools live, records a resolved snapshot on the
 * branch, and projects the preset's instruction text as a journaled system
 * section. Model/thinking/tool selection go through the public SDK session API;
 * the instruction text goes through `prompt-section-journal` so it survives
 * resume, tree navigation, fork and reload.
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

import { loadPresets, type PresetConfig } from '../src/preset/config.ts';
import { resolvePreset } from '../src/preset/resolve.ts';
import { applyPresetPlan, clearActivePreset, type PresetApplyHost } from '../src/preset/apply.ts';
import { parsePresetCommand } from '../src/preset/command.ts';
import { appendPresetBase, readPresetBase, restorePresetSnapshot } from '../src/preset/state.ts';
import { installPresetInstruction } from '../src/preset/instruction.ts';
import { appendCodemodeMode } from '../src/capability/codemode-mode.ts';
import { branchToolSelection } from '../src/capability/admission.ts';
import { createToolPermissionResolver } from '../src/capability/tool-permission.ts';
import { applyToolModifiers, parseToolModifiers } from '../src/preset/modifiers.ts';

/** `customType` of the applied-preset snapshot on the branch. */
const PRESET_STATE_RECORD = 'preset-state';
const PRESET_STATE_VERSION = 1;

export default function presetExtension(pi: ExtensionAPI): void {
  pi.registerFlag('preset', { description: 'Preset configuration to apply at startup', type: 'string' });

  // Stable base selection captured once per session: preset tool modifiers are
  // always computed from this, never from the running (possibly preset-shaped)
  // selection, so switching A then B lands where applying B directly would.
  let baseTools: readonly string[] = [];
  let currentName: string | undefined;

  const renderStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus('preset', currentName === undefined ? undefined : `preset:${currentName}`);
  };

  const host = (ctx: ExtensionContext, modifiers: readonly string[] = []): PresetApplyHost => ({
    setModel: (provider, id) => {
      const model = ctx.modelRegistry.find(provider, id);
      return model === undefined ? Promise.resolve(false) : pi.setModel(model);
    },
    setThinkingLevel: (level) => pi.setThinkingLevel(level as unknown as Parameters<typeof pi.setThinkingLevel>[0]),
    setActiveTools: (tools) => {
      // Preserve active Capability selections without adding them to the preset
      // snapshot: only the stable resolved selection is a compaction baseline.
      const branch = ctx.sessionManager.getBranch();
      const { selected } = branchToolSelection(branch);
      const permission = createToolPermissionResolver(pi, pi.getAllTools(), branch);
      const active = pi.getActiveTools().filter(name => selected.has(name) || permission.enabled(name));
      // The same native modifiers honor explicit removals and bare-name
      // replacements; intersecting with active never resurrects an old grant.
      const retained = applyToolModifiers(active, parseToolModifiers(modifiers).tokens)
        .filter(name => active.includes(name));
      pi.setActiveTools([...new Set([...tools, ...retained])]);
    },
    appendState: (record) => pi.appendEntry(PRESET_STATE_RECORD, { version: PRESET_STATE_VERSION, ...record }),
    notify: (message, level) => ctx.ui.notify(message, level),
    applyCodemodeMode: (mode) => appendCodemodeMode(pi, mode),
    clearCodemodeMode: () => appendCodemodeMode(pi, null),
  });

  const apply = async (ctx: ExtensionContext, name: string, preset: PresetConfig): Promise<void> => {
    const resolution = resolvePreset(name, preset, {
      hasModel: (provider, id) => ctx.modelRegistry.find(provider, id) !== undefined,
      allToolNames: () => pi.getAllTools().map((tool) => tool.name),
      baseToolSet: () => baseTools,
    });
    for (const issue of resolution.issues) {
      ctx.ui.notify(`Preset "${name}": ${issue.detail}`, issue.severity === 'error' ? 'error' : 'warning');
    }
    if (resolution.plan === null) {
      ctx.ui.notify(`Preset "${name}" was not applied.`, 'error');
      return;
    }
    const outcome = await applyPresetPlan(resolution.plan, resolution.issues, host(ctx, preset.tools));
    if (outcome.applied) {
      currentName = name;
      renderStatus(ctx);
    }
  };

  const loaded = (ctx: ExtensionContext) => {
    const catalog = loadPresets({ cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() });
    for (const warning of catalog.warnings) ctx.ui.notify(warning, 'warning');
    return catalog.presets;
  };

  pi.on('session_start', async (_event, ctx) => {
    // Stable base: the true initial active set — native defaults, CLI `--tools`
    // modifier results and default-active extension tools such as `capability`.
    // Capture it once and persist it on the branch; a resume/reload that already
    // reflects a prior preset then reads the recorded base instead of the live
    // (preset-shaped) active set, so B computes from the same base as a fresh
    // apply and no extension tool is silently dropped.
    const recordedBase = readPresetBase(ctx.sessionManager.getBranch());
    if (recordedBase !== undefined) {
      baseTools = recordedBase;
    } else {
      baseTools = pi.getActiveTools();
      appendPresetBase(pi, baseTools);
    }
    currentName = restorePresetSnapshot(ctx.sessionManager.getBranch())?.name;
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
        clearActivePreset(host(ctx));
        currentName = undefined;
        renderStatus(ctx);
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
          clearActivePreset(host(ctx));
          currentName = undefined;
          renderStatus(ctx);
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
