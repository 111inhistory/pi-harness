/**
 * Branch persistence for the applied preset.
 *
 * A preset application is written to the current branch as one append-only
 * `preset-state` entry carrying a *resolved snapshot*: the exact provider/id,
 * thinking level, stable tool selection, codemode mode and instruction text
 * resolved at apply time. The tool selection is the compaction baseline, not
 * the dynamic Capability tools retained during application. Branch readers use
 * the snapshot for instructions, status and that baseline; model/thinking/tools
 * recovery belongs to Pi rather than replaying this snapshot. Re-running
 * `/preset NAME` re-resolves against the current definition.
 *
 * Recording the snapshot rather than the preset name is deliberate: the same
 * reproducibility rule the subagent store uses for its sessions. A name alone
 * would silently follow later config edits and restore a different session than
 * the branch recorded.
 *
 * `snapshot === null` records a clear: the session stopped being managed by a
 * preset. Clearing never claims to roll authorization back; it only stops the
 * preset from owning model/thinking/tools/instructions going forward.
 *
 * Entries are append-only and never rewritten, matching every other branch
 * memory in this harness. Restoration reads the last entry on the branch.
 */

import type { CodemodeMode, PresetModel, ThinkingLevelName } from './config.ts';

/** `customType` of one applied-preset snapshot. */
export const PRESET_STATE_RECORD = 'preset-state';
export const PRESET_STATE_VERSION = 1;

/**
 * `customType` of the captured base tool set.
 *
 * The base is the true initial active set of the session — native defaults, CLI
 * `--tools` modifier results and default-active extension tools such as
 * `capability` — captured once at first `session_start` and recorded on the
 * branch. Preset tool modifiers always compute from this base, so a resume or
 * reload that already reflects a prior preset cannot become the new base, while
 * the base still contains the extension tools a settings-only view would miss.
 */
export const PRESET_BASE_RECORD = 'preset-base';
export const PRESET_BASE_VERSION = 1;

/** The fully resolved state a preset apply froze onto the branch. */
export interface PresetSnapshot {
  readonly name: string;
  readonly model?: PresetModel;
  readonly thinkingLevel?: ThinkingLevelName;
  /** Stable preset selection; excludes dynamically retained Capability tools. */
  readonly tools?: readonly string[];
  readonly disabledTools?: readonly string[];
  readonly codemode?: { readonly mode: CodemodeMode };
  /** Resolved instruction text; null means the preset carried no instructions. */
  readonly instructions: string | null;
}

/** One branch entry: a resolved snapshot, or a null clear. */
export interface PresetStateRecord {
  readonly version: typeof PRESET_STATE_VERSION;
  readonly snapshot: PresetSnapshot | null;
  /** Fields the user overrode after applying (informational). */
  readonly overrides?: readonly string[];
}

/** The minimal writer this module needs; an ExtensionAPI satisfies it. */
export interface PresetStateWriter {
  appendEntry(customType: string, data: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function malformed(detail: string): never {
  throw new Error(`Malformed ${PRESET_STATE_RECORD} entry on the session branch: ${detail}`);
}

function parseSnapshot(raw: unknown): PresetSnapshot {
  if (!isRecord(raw)) malformed('snapshot must be an object');
  const name = raw['name'];
  if (typeof name !== 'string' || name === '') malformed('snapshot.name must be a non-empty string');
  const snapshot: {
    name: string;
    model?: PresetModel;
    thinkingLevel?: ThinkingLevelName;
    tools?: readonly string[];
    disabledTools?: readonly string[];
    codemode?: { readonly mode: CodemodeMode };
    instructions: string | null;
  } = { name, instructions: raw['instructions'] as string | null };
  if (raw['instructions'] !== null && typeof raw['instructions'] !== 'string') {
    malformed('snapshot.instructions must be a string or null');
  }
  const model = raw['model'];
  if (model !== undefined) {
    if (!isRecord(model) || typeof model['provider'] !== 'string' || typeof model['id'] !== 'string') {
      malformed('snapshot.model must be { provider, id }');
    }
    snapshot.model = { provider: model['provider'], id: model['id'] };
  }
  const thinkingLevel = raw['thinkingLevel'];
  if (thinkingLevel !== undefined) {
    if (typeof thinkingLevel !== 'string') malformed('snapshot.thinkingLevel must be a string');
    snapshot.thinkingLevel = thinkingLevel as ThinkingLevelName;
  }
  const disabledTools = raw['disabledTools'];
  if (disabledTools !== undefined) {
    if (!isStringArray(disabledTools)) malformed('snapshot.disabledTools must be a string array');
    snapshot.disabledTools = disabledTools;
  }
  const tools = raw['tools'];
  if (tools !== undefined) {
    if (!isStringArray(tools)) malformed('snapshot.tools must be a string array');
    snapshot.tools = [...tools];
  }
  const codemode = raw['codemode'];
  if (codemode !== undefined) {
    if (!isRecord(codemode) || (codemode['mode'] !== 'on' && codemode['mode'] !== 'only')) {
      malformed('snapshot.codemode.mode must be "on" or "only"');
    }
    snapshot.codemode = { mode: codemode['mode'] };
  }
  return snapshot;
}

function parseRecord(data: unknown): PresetStateRecord {
  if (!isRecord(data)) malformed('expected an object payload');
  if (data['version'] !== PRESET_STATE_VERSION) {
    malformed(`expected version ${PRESET_STATE_VERSION}, got ${String(data['version'])}`);
  }
  const rawSnapshot = data['snapshot'];
  const snapshot = rawSnapshot === null ? null : parseSnapshot(rawSnapshot);
  const overrides = data['overrides'];
  if (overrides !== undefined && !isStringArray(overrides)) malformed('overrides must be a string array');
  return {
    version: PRESET_STATE_VERSION,
    snapshot,
    ...(overrides === undefined ? {} : { overrides: [...overrides] }),
  };
}

/** The latest preset-state entry on the branch, or null when none exists. */
export function readPresetState(branch: readonly unknown[] | null | undefined): PresetStateRecord | null {
  let latest: PresetStateRecord | null = null;
  for (const entry of branch ?? []) {
    if (!isRecord(entry)) continue;
    if (entry['type'] !== 'custom' || entry['customType'] !== PRESET_STATE_RECORD) continue;
    latest = parseRecord(entry['data']);
  }
  return latest;
}

/** The snapshot that should be active now, or null when cleared/never set. */
export function restorePresetSnapshot(branch: readonly unknown[] | null | undefined): PresetSnapshot | null {
  return readPresetState(branch)?.snapshot ?? null;
}

/** Whether a preset reduced its baseline since the preceding compaction. */
export function hasPresetBaseToolRemoval(branch: readonly unknown[], checkpointId: string): boolean {
  let previousTools = readPresetBase(branch);
  let removed = false;
  for (const entry of branch) {
    if (!isRecord(entry)) continue;
    // session_compact runs after its checkpoint has already been appended.
    if (entry['id'] === checkpointId) break;
    if (entry['type'] === 'compaction') removed = false;
    if (entry['type'] !== 'custom' || entry['customType'] !== PRESET_STATE_RECORD) continue;
    const tools = parseRecord(entry['data']).snapshot?.tools;
    // Clear and instruction/model-only presets do not replace the live tools.
    if (tools === undefined) continue;
    if (previousTools?.some(name => !tools.includes(name))) removed = true;
    previousTools = tools;
  }
  return removed;
}

/** Append one preset-state entry to the branch. */
export function appendPresetState(writer: PresetStateWriter, record: PresetStateRecord): void {
  writer.appendEntry(PRESET_STATE_RECORD, record);
}

/** The captured base tool set on the branch, or undefined when not yet captured. */
export function readPresetBase(branch: readonly unknown[] | null | undefined): readonly string[] | undefined {
  let latest: readonly string[] | undefined;
  for (const entry of branch ?? []) {
    if (!isRecord(entry)) continue;
    if (entry['type'] !== 'custom' || entry['customType'] !== PRESET_BASE_RECORD) continue;
    const data = entry['data'];
    if (!isRecord(data) || data['version'] !== PRESET_BASE_VERSION) continue;
    if (isStringArray(data['tools'])) latest = [...data['tools']];
  }
  return latest;
}

/** Record the captured base tool set once per session branch. */
export function appendPresetBase(writer: PresetStateWriter, tools: readonly string[]): void {
  writer.appendEntry(PRESET_BASE_RECORD, { version: PRESET_BASE_VERSION, tools: [...tools] });
}
