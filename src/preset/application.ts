/**
 * Shared Preset session application.
 *
 * Main and child creation use the same public session mutations, stable
 * pre-Preset tool baseline, retention rules and branch records. The resolver
 * still owns sparse-Preset semantics: absent fields stay untouched, and only a
 * declared `tools` selection replaces the active loadout.
 *
 * This module never writes a system prompt, a forced prompt option or a private
 * AgentSession field. The next ordinary run owns native prompt/tool refresh.
 */

import type { Api, Model } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ModelRegistry,
} from '@earendil-works/pi-coding-agent';

import {
  applyPresetPlan,
  clearActivePreset,
  type PresetApplyHost,
  type PresetApplyOutcome,
  type PresetClearOutcome,
} from './apply.ts';
import { resolvePreset } from './resolve.ts';
import {
  appendPresetBase,
  readPresetBase,
  restorePresetSnapshot,
  PRESET_STATE_RECORD,
  PRESET_STATE_VERSION,
  type PresetSnapshot,
} from './state.ts';
import { appendCodemodeMode } from '../capability/codemode-mode.ts';
import { branchToolSelection } from '../capability/admission.ts';
import { createToolPermissionResolver } from '../capability/tool-permission.ts';
import { applyToolModifiers, parseToolModifiers } from './modifiers.ts';
import type { PresetConfig } from './config.ts';

/** Catalog loading stays in `config.ts`; this module is the shared session-facing entry. */
export { loadPresets, type LoadedPresets, type PresetConfig } from './config.ts';

/** The public session surface Main and child creation both expose. */
export interface PresetSessionHost {
  readonly pi: ExtensionAPI;
  getBranch(): readonly unknown[];
  readonly modelRegistry: Pick<ModelRegistry, 'find'>;
  /** Child creation can skip re-selecting its already-routed exact model. */
  selectModel?(model: Model<Api>): Promise<boolean>;
}

/** The currently active preset snapshot, or null when cleared/never set. */
export function currentPreset(
  host: Pick<PresetSessionHost, 'getBranch'>,
): PresetSnapshot | null {
  return restorePresetSnapshot(host.getBranch());
}

/**
 * Read or capture the exact pre-Preset baseline. A recorded base is historical
 * and is never reconstructed from current settings or the live active set.
 */
export function ensurePresetBase(
  host: Pick<PresetSessionHost, 'pi' | 'getBranch'>,
): readonly string[] {
  const recorded = readPresetBase(host.getBranch());
  if (recorded !== undefined) return recorded;
  const captured = host.pi.getActiveTools();
  appendPresetBase(host.pi, captured);
  return captured;
}

/**
 * Shared apply host. `modifiers` are the current preset's raw tool tokens; they
 * preserve dynamic Capability/permission tools only under the same modifier
 * semantics as Main, and an explicit final minus still removes them.
 */
export function createPresetApplyHost(
  host: PresetSessionHost,
  modifiers: readonly string[] = [],
): PresetApplyHost {
  return {
    setModel: async (provider, id) => {
      const model = host.modelRegistry.find(provider, id);
      if (model === undefined) return false;
      return host.selectModel === undefined
        ? host.pi.setModel(model)
        : host.selectModel(model);
    },
    setThinkingLevel: (level) => {
      host.pi.setThinkingLevel(level as unknown as Parameters<typeof host.pi.setThinkingLevel>[0]);
    },
    setActiveTools: (tools) => {
      const branch = host.getBranch();
      const { selected } = branchToolSelection(branch);
      const permission = createToolPermissionResolver(host.pi, host.pi.getAllTools(), branch);
      const active = host.pi.getActiveTools()
        .filter((name) => selected.has(name) || permission.enabled(name));
      // The same native modifiers honor explicit removals and bare-name
      // replacements; intersecting with active never resurrects an old grant.
      const retained = applyToolModifiers(active, parseToolModifiers(modifiers).tokens)
        .filter((name) => active.includes(name));
      host.pi.setActiveTools([...new Set([...tools, ...retained])]);
    },
    appendState: (record) => {
      host.pi.appendEntry(PRESET_STATE_RECORD, {
        version: PRESET_STATE_VERSION,
        ...record,
      });
    },
    applyCodemodeMode: (mode) => appendCodemodeMode(host.pi, mode),
    clearCodemodeMode: () => appendCodemodeMode(host.pi, null),
  };
}

/** Clear through the shared session host without rolling model/thinking/tools back. */
export function clearPresetFromSession(host: PresetSessionHost): PresetClearOutcome {
  return clearActivePreset(createPresetApplyHost(host));
}

/**
 * Resolve and apply one Preset through the shared host. Resolution issues and
 * runtime problems are returned for the surface adapter to render.
 */
export async function applyPresetToSession(
  host: PresetSessionHost,
  name: string,
  config: PresetConfig,
): Promise<PresetApplyOutcome> {
  const base = ensurePresetBase(host);
  const resolution = resolvePreset(name, config, {
    hasModel: (provider, id) => host.modelRegistry.find(provider, id) !== undefined,
    allToolNames: () => host.pi.getAllTools().map((tool) => tool.name),
    baseToolSet: () => base,
  });
  if (resolution.plan === null) {
    return {
      applied: false,
      snapshot: null,
      issues: resolution.issues,
      problems: [],
      codemodeNotApplied: false,
    };
  }
  return applyPresetPlan(
    resolution.plan,
    resolution.issues,
    createPresetApplyHost(host, config.tools ?? []),
  );
}
