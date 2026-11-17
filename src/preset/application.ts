/**
 * Shared Preset session application.
 *
 * Main and child creation use the same public session mutations, shared tool
 * baseline and branch records. The resolver still owns sparse-Preset semantics:
 * absent fields stay untouched, and only a declared `tools` selection replaces
 * the preset's base contribution.
 *
 * Tool membership is never computed here. A Preset contributes a base selection
 * and a current-preset blacklist to the branch snapshot; the tool-access domain
 * owns baseline/dynamic/blacklist collections and recomputes the live loadout
 * after the snapshot write, so a blacklist from any other source still wins.
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
  restorePresetSnapshot,
  PRESET_STATE_RECORD,
  PRESET_STATE_VERSION,
  type PresetSnapshot,
} from './state.ts';
import { appendCodemodeMode } from '../capability/codemode-mode.ts';
import { ensureToolBase, syncActiveToolsToCollections } from '../capability/tool-access.ts';
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
 * Read or capture the session tool baseline the Preset computes from.
 *
 * The baseline belongs to the tool-access domain and is captured once at
 * `session_start`, before any `--preset` applies, so a resume or reload that
 * already reflects a prior preset cannot become the new baseline. Delegating
 * keeps one base notion for `/capability base` and Preset modifiers.
 */
export function ensureSessionToolBase(
  host: Pick<PresetSessionHost, 'pi' | 'getBranch'>,
): readonly string[] {
  return ensureToolBase(host.pi, host.pi, host.getBranch());
}

/** Shared apply host backed by the real session mutations. */
export function createPresetApplyHost(host: PresetSessionHost): PresetApplyHost {
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
    syncTools: () => {
      // The records are already durable, so this reads the same branch state a
      // later request would see: base selection plus dynamic membership minus
      // every blacklist source. A throw is turned into an honest result: the
      // caller reports it instead of un-writing the records or retrying.
      try {
        syncActiveToolsToCollections(host.pi, host.getBranch());
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
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

/**
 * Clear through the shared session host without rolling model, thinking or base
 * membership back; the preset blacklist lifetime ends and the loadout is
 * recomputed from the preserved memberships.
 */
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
  // The session baseline is only needed to compute a tool selection. A preset
  // that declares no tools must still apply on a session whose baseline record
  // could not be captured, so resolve it lazily and read it at most once.
  let base: readonly string[] | undefined;
  const resolution = resolvePreset(name, config, {
    hasModel: (provider, id) => host.modelRegistry.find(provider, id) !== undefined,
    allToolNames: () => host.pi.getAllTools().map((tool) => tool.name),
    baseToolSet: () => (base ??= ensureSessionToolBase(host)),
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
    createPresetApplyHost(host),
  );
}
