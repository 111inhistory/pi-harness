/**
 * Session-scoped Codemode mode: the preset declaration and the manual override.
 *
 * Pi exposes no public runtime writer for the `codemode.mode` setting, so the
 * harness cannot flip the setting mid-session. Two append-only branch sources
 * share one order instead:
 *
 * - the applied preset's `session.codemode.mode`, carried by the authoritative
 *   `preset-state` v2 snapshot (not a separate record);
 * - a manual `codemode-mode` entry, independent of any preset.
 *
 * The later *declaration* wins. A preset clear (null snapshot) or a preset that
 * declares no mode withdraws only the preset's contribution, so the manual entry
 * stays in force; a manual clear (`mode: null`) falls back to Settings. When no
 * entry declares anything, the Settings value applies.
 *
 * The record lives on the branch on purpose: resume, tree, fork and reload replay
 * it, so the effective mode restores exactly what the branch applied. Writing it
 * only changes the declaration projection — never the enabled set, tool exposure
 * or authorization.
 */

import { PRESET_STATE_RECORD, readPresetState } from '../preset/state.ts';

export type EffectiveCodemodeMode = 'on' | 'only';

/** `customType` of one manually recorded mode override. */
export const CODEMODE_MODE_RECORD = 'codemode-mode';
export const CODEMODE_MODE_VERSION = 1;

/** The append surface this module needs; an ExtensionAPI satisfies it. */
export interface CodemodeModeWriter {
  appendEntry(customType: string, data: unknown): void;
}

interface ModeRecord {
  readonly version?: unknown;
  readonly mode?: unknown;
}

interface Declaration {
  readonly position: number;
  readonly mode: EffectiveCodemodeMode;
}

function modeOf(value: unknown): EffectiveCodemodeMode | null {
  return value === 'on' || value === 'only' ? value : null;
}

/** Append the manual effective mode, or `null` to clear back to Settings. */
export function appendCodemodeMode(writer: CodemodeModeWriter, mode: EffectiveCodemodeMode | null): void {
  writer.appendEntry(CODEMODE_MODE_RECORD, { version: CODEMODE_MODE_VERSION, mode });
}

/**
 * The latest manual override on the branch: a mode, `null` for an explicit
 * clear, or `undefined` when no manual record exists.
 */
export function readCodemodeModeOverride(
  branch: readonly unknown[] | null | undefined,
): EffectiveCodemodeMode | null | undefined {
  let latest: EffectiveCodemodeMode | null | undefined;
  for (const entry of branch ?? []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const value = entry as { type?: unknown; customType?: unknown; data?: ModeRecord };
    if (value.type !== 'custom' || value.customType !== CODEMODE_MODE_RECORD) continue;
    if (value.data?.version !== CODEMODE_MODE_VERSION) continue;
    latest = modeOf(value.data.mode);
  }
  return latest;
}

/**
 * The effective mode: the later of the preset declaration and the manual
 * declaration, otherwise the Settings mode.
 */
export function effectiveCodemodeMode(
  branch: readonly unknown[] | null | undefined,
  settingsMode: string | undefined,
): EffectiveCodemodeMode {
  const fallback: EffectiveCodemodeMode = settingsMode === 'only' ? 'only' : 'on';
  const entries = branch ?? [];
  let manual: { readonly position: number; readonly mode: EffectiveCodemodeMode | null } | null = null;
  let presetPosition = -1;
  let hasPresetState = false;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (typeof entry !== 'object' || entry === null) continue;
    const value = entry as { type?: unknown; customType?: unknown; data?: ModeRecord };
    if (value.type !== 'custom') continue;
    if (value.customType === CODEMODE_MODE_RECORD) {
      if (value.data?.version !== CODEMODE_MODE_VERSION) continue;
      manual = { position: index, mode: modeOf(value.data.mode) };
      continue;
    }
    if (value.customType === PRESET_STATE_RECORD) {
      presetPosition = index;
      hasPresetState = true;
    }
  }
  // Read the authoritative record at most once, and only when a branch has one;
  // the common no-preset branch pays no extra scan.
  const declared = hasPresetState
    ? modeOf(readPresetState(entries)?.snapshot?.codemode?.mode)
    : null;
  const preset: Declaration | null = declared === null ? null : { position: presetPosition, mode: declared };
  if (preset !== null && (manual === null || preset.position > manual.position)) return preset.mode;
  if (manual !== null) return manual.mode ?? fallback;
  return fallback;
}
