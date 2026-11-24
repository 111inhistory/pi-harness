/**
 * Shared Preset session application.
 *
 * Main and child creation use the same public session mutations, shared tool
 * baseline and branch records. The resolver still owns sparse-Preset semantics:
 * absent fields stay untouched, and only a declared `tools` selection replaces
 * the preset's base contribution.
 *
 * Tool membership is never computed here. A Preset contributes a normalized tool
 * selection, a resolved name projection and a current-preset blacklist to the one
 * v2 branch record; the tool-access domain owns baseline/dynamic/blacklist
 * collections and recomputes the live loadout after that write, so a blacklist
 * from any other source still wins.
 *
 * This module never writes a system prompt, a forced prompt option or a private
 * AgentSession field. The next ordinary run owns native prompt/tool refresh.
 *
 * `currentPresetView` is the strictly read-only counterpart used by RPC and the
 * TUI. It compares the recorded snapshot with the freshly loaded definition
 * without appending a record and without capturing a tool baseline, so a
 * read-only status query can never change the session.
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
  type PresetApplyOptions,
  type PresetApplyOutcome,
  type PresetClearOutcome,
} from './apply.ts';
import { resolvePreset, type PresetApplyPlan, type PresetIssue } from './resolve.ts';
import {
  presetBaselineAdditions,
  restorePresetSnapshot,
  PRESET_STATE_RECORD,
  PRESET_STATE_VERSION,
  type PresetSnapshot,
  type PresetToolSelection,
} from './state.ts';
import {
  ensureToolBase,
  presetLiveToolsInSync,
  presetRetainedByBranch,
  syncActiveToolsToCollections,
  toolBaselineNames,
} from '../capability/tool-access.ts';
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
  /**
   * Caller-owned session identity check, re-evaluated after the awaited model
   * switch. Returns the reason when this host no longer addresses the session
   * the apply was resolved for (for example a retired RPC session).
   */
  assertSession?(): string | null;
}

/** The currently active preset snapshot, or null when cleared/never set. */
export function currentPreset(
  host: Pick<PresetSessionHost, 'getBranch'>,
): PresetSnapshot | null {
  return restorePresetSnapshot(host.getBranch());
}

/**
 * Capture the session tool baseline the Preset computes from, once.
 *
 * The baseline belongs to the tool-access domain and is captured at
 * `session_start`, before any `--preset` applies, so a resume or reload that
 * already reflects a prior preset cannot become the new baseline. Delegating
 * keeps one base notion for `/capability base` and Preset modifiers.
 */
export function ensureSessionToolBase(
  host: Pick<PresetSessionHost, 'pi' | 'getBranch'>,
): readonly string[] {
  return ensureToolBase(host.pi, host.pi, host.getBranch());
}

/**
 * Registered tool names a preset may select. A hidden tool is registered but
 * cannot be activated, so it must not enter a selection projection either.
 */
function eligibleToolNames(pi: ExtensionAPI): readonly string[] {
  return pi.getAllTools()
    .filter((tool) => tool.exposure !== 'hidden')
    .map((tool) => tool.name);
}

/**
 * The baseline a preset selection is computed from, without writing.
 *
 * A RECORDED baseline wins even when it is empty (a legitimate `tools: []` or
 * `--no-tools` session). Only a branch with no base record previews the capture,
 * and it previews exactly the names `ensureSessionToolBase` would write, so an
 * admitted version and the recorded snapshot cannot diverge afterwards.
 * Permanent `baselineAdditions` are baseline membership in both cases, so an
 * increment is never re-introduced by the next apply.
 */
function previewBaseline(host: Pick<PresetSessionHost, 'pi' | 'getBranch'>): readonly string[] {
  const branch = host.getBranch();
  return effectiveBaseline(toolBaselineNames(host.pi, branch), branch);
}

/**
 * The effective baseline: the recorded baseline plus every permanent
 * `baselineAdditions` increment on the branch.
 */
function effectiveBaseline(
  recorded: readonly string[],
  branch: readonly unknown[],
): readonly string[] {
  const names = [...new Set(recorded)];
  const present = new Set(names);
  for (const name of presetBaselineAdditions(branch)) {
    if (present.has(name)) continue;
    present.add(name);
    names.push(name);
  }
  return names;
}

function isModelSwitchSideEffect(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const type = (entry as { type?: unknown }).type;
  return type === 'model_change' || type === 'thinking_level_change';
}

/**
 * Identity of the branch state an apply resolved against: entry count plus the
 * last entry id, ignoring trailing `model_change` / `thinking_level_change`
 * entries that `pi.setModel` itself appends. Any tree switch to a different
 * anchor, fork or other concurrent branch entry changes the token and rejects a
 * stale apply (sibling branches diverging only in model/thinking share the same
 * anchor; callers such as RPC keep their own session/epoch fence via
 * `assertSession`).
 */
function contextTokenOf(branch: readonly unknown[]): string {
  let end = branch.length;
  while (end > 0 && isModelSwitchSideEffect(branch[end - 1])) end -= 1;
  const last = end > 0 ? branch[end - 1] : undefined;
  const id = typeof last === 'object' && last !== null ? (last as { id?: unknown }).id : undefined;
  return `${end}:${typeof id === 'string' ? id : ''}`;
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
      // The record is already durable, so this reads the same branch state a
      // later request would see: baseline plus dynamic membership minus every
      // blacklist source. A throw becomes an honest result: the caller reports it
      // instead of un-writing the record or retrying.
      try {
        syncActiveToolsToCollections(host.pi, host.getBranch());
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    toolsInSync: () => presetLiveToolsInSync(host.pi, host.getBranch()),
    retainedToolNames: () => presetRetainedByBranch(host.pi, host.getBranch()),
    appendState: (record) => {
      host.pi.appendEntry(PRESET_STATE_RECORD, {
        version: PRESET_STATE_VERSION,
        snapshot: record.snapshot,
        ...(record.baselineAdditions === undefined
          ? {}
          : { baselineAdditions: record.baselineAdditions }),
      });
    },
    recordedSnapshot: () => restorePresetSnapshot(host.getBranch()),
    contextToken: () => contextTokenOf(host.getBranch()),
    ...(host.assertSession === undefined ? {} : { assertSession: () => host.assertSession!() }),
  };
}

/**
 * Clear through the shared session host: the preset layer (selection, blacklist
 * and codemode intent) is withdrawn while the manual `/capability base` layer,
 * the permanent `baselineAdditions` and the model/thinking stay untouched. The
 * loadout is then recomputed from the recorded baseline plus that manual layer.
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
  options: PresetApplyOptions = {},
): Promise<PresetApplyOutcome> {
  const resolveWith = (base: readonly string[]) => resolvePreset(name, config, {
    hasModel: (provider, id) => host.modelRegistry.find(provider, id) !== undefined,
    allToolNames: () => eligibleToolNames(host.pi),
    baseToolSet: () => base,
  });
  const denied = (issues: readonly PresetIssue[]): PresetApplyOutcome =>
    ({ applied: false, unchanged: false, snapshot: null, issues, problems: [] });

  // Resolution only READS the branch. Capturing the session baseline is a write,
  // so it waits for admission: neither a version mismatch nor an unresolvable
  // preset may leave a record behind on an otherwise untouched branch.
  const previewBase = previewBaseline(host);
  const preview = resolveWith(previewBase);
  if (preview.plan === null) return denied(preview.issues);
  if (options.expectedVersion !== undefined && options.expectedVersion !== preview.plan.contentHash) {
    // Admission refuses before the capture; this call writes nothing.
    return applyPresetPlan(preview.plan, preview.issues, createPresetApplyHost(host), options);
  }
  let plan = preview.plan;
  let issues = preview.issues;
  if (config.tools !== undefined) {
    // The one-time baseline capture is the only write before the preset record.
    // A read-only branch still fails closed here, before any live effect. On a
    // recorded branch this is a pure read, so the preview already matched.
    const captured = effectiveBaseline(ensureSessionToolBase(host), host.getBranch());
    if (!sameNameSet(captured, previewBase)) {
      // The live set moved between the preview and the capture (a concurrent run
      // or a discovery activation): re-resolve so the record matches replay.
      const reread = resolveWith(captured);
      if (reread.plan !== null) {
        plan = reread.plan;
        issues = reread.issues;
      }
    }
  }
  return applyPresetPlan(plan, issues, createPresetApplyHost(host), options);
}

/** How a branch's recorded preset compares with the currently loaded definition. */
export type PresetVersionStatus = 'current' | 'outdated' | 'missing' | 'unresolvable';

/** A read-only version decision for the active preset. */
export interface CurrentPresetView {
  /** The recorded branch snapshot; null when no preset is active. */
  readonly preset: PresetSnapshot | null;
  /** Null exactly when {@link preset} is null. */
  readonly status: PresetVersionStatus | null;
  /** The candidate content hash; null when there is no candidate to compare. */
  readonly currentVersion: string | null;
  /** Stable, human-readable field and tool-name differences; empty when current. */
  readonly changes: readonly string[];
}

function modelLabel(model: { readonly provider: string; readonly id: string } | undefined): string {
  return model === undefined ? '(none)' : `${model.provider}/${model.id}`;
}

/**
 * A selection's signed tokens in display form: `+add`, `-remove` for modifiers,
 * `+name` for a replacement. Comparing these exposes an intent change that
 * leaves the projected tool set unchanged.
 */
function selectionTokens(selection: PresetToolSelection): readonly string[] {
  if (selection.kind === 'modifiers') {
    return [...selection.add.map((name) => `+${name}`), ...selection.remove.map((name) => `-${name}`)];
  }
  if (selection.kind === 'replace') return selection.names.map((name) => `+${name}`);
  return [];
}

/**
 * Signed-token difference: a token that disappears is reported with the
 * opposite sign, because "no longer adding x" means "x is not selected".
 */
function tokenDelta(before: readonly string[], after: readonly string[]): string {
  const previous = new Set(before);
  const next = new Set(after);
  const added = [...next].filter((token) => !previous.has(token));
  const removed = [...previous]
    .filter((token) => !next.has(token))
    .map((token) => (token.startsWith('-') ? `+${token.slice(1)}` : `-${token.slice(1)}`));
  return [...new Set([...added, ...removed])].sort().join(' ');
}

/** One `+name`/`-name` token list for the names that differ. */
function nameDelta(before: readonly string[] | undefined, after: readonly string[] | undefined): string {
  const previous = new Set(before ?? []);
  const next = new Set(after ?? []);
  const added = [...next].filter((name) => !previous.has(name)).sort().map((name) => `+${name}`);
  const removed = [...previous].filter((name) => !next.has(name)).sort().map((name) => `-${name}`);
  return [...added, ...removed].join(' ');
}

/**
 * The field and tool-name differences between a recorded snapshot and the
 * candidate resolution of the same preset name. Pure and order-stable so RPC and
 * the TUI render the same summary.
 */
export function presetVersionChanges(
  recorded: PresetSnapshot,
  plan: PresetApplyPlan,
): readonly string[] {
  const changes: string[] = [];
  const recordedModel = modelLabel(recorded.model);
  const candidateModel = modelLabel(plan.model);
  if (recordedModel !== candidateModel) {
    changes.push(`model: ${recordedModel} -> ${candidateModel}`);
  }
  const recordedThinking = recorded.thinkingLevel ?? '(none)';
  const candidateThinking = plan.thinkingLevel ?? '(none)';
  if (recordedThinking !== candidateThinking) {
    changes.push(`thinkingLevel: ${recordedThinking} -> ${candidateThinking}`);
  }
  if (recorded.toolSelection.kind !== plan.toolSelection.kind) {
    changes.push(`toolSelection: ${recorded.toolSelection.kind} -> ${plan.toolSelection.kind}`);
  } else {
    // The kinds can match while the normalized intent differs: replacing a
    // redundant `+read` with a redundant `+bash` projects the same tool set but
    // is still a different definition.
    const intent = tokenDelta(selectionTokens(recorded.toolSelection), selectionTokens(plan.toolSelection));
    if (intent !== '') changes.push(`toolSelection: ${intent}`);
  }
  const tools = nameDelta(recorded.tools, plan.tools);
  if (tools !== '') changes.push(`tools: ${tools}`);
  const disabled = nameDelta(recorded.disabledTools, plan.disabledTools);
  if (disabled !== '') changes.push(`disabledTools: ${disabled}`);
  const recordedCodemode = recorded.codemode?.mode ?? '(none)';
  const candidateCodemode = plan.codemode?.mode ?? '(none)';
  if (recordedCodemode !== candidateCodemode) {
    changes.push(`codemode: ${recordedCodemode} -> ${candidateCodemode}`);
  }
  if (recorded.instructions !== plan.instructions) changes.push('instructions: changed');
  return changes;
}

/** Order-insensitive name-set equality for two baseline reads. */
function sameNameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const names = new Set(left);
  return right.every((name) => names.has(name));
}

/** The loaded catalog facts a version decision needs. */
export interface PresetCatalogStatus {
  readonly presets: ReadonlyMap<string, PresetConfig>;
  /** Names the loader rejected: the name exists, its definition is broken. */
  readonly invalidNames?: ReadonlySet<string>;
  /** A whole preset document was unusable, so no name can be judged missing. */
  readonly invalidDocument?: boolean;
}

/**
 * Compare the recorded preset with the loaded definition without any session
 * write: the baseline comes from the branch records, never from a capture.
 *
 * A rejected name or an unreadable document is `unresolvable`, not `missing`:
 * the preset was not deleted, so the user must fix the config instead of
 * re-creating it. `missing` is reserved for a name the catalog really no longer
 * defines.
 */
export function currentPresetView(
  host: Pick<PresetSessionHost, 'pi' | 'getBranch' | 'modelRegistry'>,
  catalog: PresetCatalogStatus,
): CurrentPresetView {
  const recorded = currentPreset(host);
  if (recorded === null) return { preset: null, status: null, currentVersion: null, changes: [] };
  const config = catalog.presets.get(recorded.name);
  if (config === undefined) {
    const known = catalog.invalidNames?.has(recorded.name) === true || catalog.invalidDocument === true;
    return {
      preset: recorded,
      status: known ? 'unresolvable' : 'missing',
      currentVersion: null,
      changes: [],
    };
  }
  const baseline = previewBaseline(host);
  const resolution = resolvePreset(recorded.name, config, {
    hasModel: (provider, id) => host.modelRegistry.find(provider, id) !== undefined,
    allToolNames: () => eligibleToolNames(host.pi),
    baseToolSet: () => baseline,
  });
  const plan = resolution.plan;
  if (plan === null) {
    return { preset: recorded, status: 'unresolvable', currentVersion: null, changes: [] };
  }
  if (plan.contentHash === recorded.contentHash) {
    return { preset: recorded, status: 'current', currentVersion: plan.contentHash, changes: [] };
  }
  return {
    preset: recorded,
    status: 'outdated',
    currentVersion: plan.contentHash,
    changes: presetVersionChanges(recorded, plan),
  };
}
