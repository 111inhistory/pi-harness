/**
 * Branch persistence for the applied preset.
 *
 * A preset application is written to the current branch as one append-only
 * `preset-state` entry carrying a *resolved snapshot*: the exact provider/id,
 * thinking level, final tool set, codemode mode and instruction text that were
 * applied. Resume, tree navigation, fork and reload read that snapshot back, so
 * they restore what was actually active even after the source presets.json is
 * edited. Re-running `/preset NAME` re-resolves against the current definition.
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

/** The fully resolved state a preset apply froze onto the branch. */
export interface PresetSnapshot {
  readonly name: string;
  readonly model?: PresetModel;
  readonly thinkingLevel?: ThinkingLevelName;
  readonly tools?: readonly string[];
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

/** Append one preset-state entry to the branch. */
export function appendPresetState(writer: PresetStateWriter, record: PresetStateRecord): void {
  writer.appendEntry(PRESET_STATE_RECORD, record);
}
