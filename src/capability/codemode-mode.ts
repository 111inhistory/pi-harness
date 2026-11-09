/**
 * Session-scoped Codemode mode override owned by a preset.
 *
 * Pi exposes no public runtime writer for the `codemode.mode` setting, so the
 * harness cannot flip the setting mid-session. Instead a preset that declares a
 * mode records it on the current branch as one append-only `codemode-mode`
 * entry. The Capability Codemode adapter and the lazy-schema projection read the
 * latest entry and treat it as the effective mode for this branch, falling back
 * to the Settings value when the preset recorded none (or cleared it).
 *
 * The record lives on the branch on purpose: resume, tree, fork and reload replay
 * it, so the effective mode restores exactly what the branch applied. Writing it
 * only changes the declaration projection — never the enabled set, tool exposure
 * or authorization.
 */

export type EffectiveCodemodeMode = 'on' | 'only';

/** `customType` of one recorded mode override. */
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

/** Append the preset's effective mode, or `null` to clear back to Settings. */
export function appendCodemodeMode(writer: CodemodeModeWriter, mode: EffectiveCodemodeMode | null): void {
  writer.appendEntry(CODEMODE_MODE_RECORD, { version: CODEMODE_MODE_VERSION, mode });
}

/**
 * The latest recorded override on the branch: a mode, `null` for an explicit
 * clear, or `undefined` when no preset has recorded one.
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
    latest = value.data.mode === 'only' || value.data.mode === 'on' ? value.data.mode : null;
  }
  return latest;
}

/**
 * The effective mode: a preset override when recorded, otherwise the Settings
 * mode. A recorded `null` (cleared preset) falls back to Settings too.
 */
export function effectiveCodemodeMode(
  branch: readonly unknown[] | null | undefined,
  settingsMode: string | undefined,
): EffectiveCodemodeMode {
  const override = readCodemodeModeOverride(branch);
  if (override === 'on' || override === 'only') return override;
  return settingsMode === 'only' ? 'only' : 'on';
}
