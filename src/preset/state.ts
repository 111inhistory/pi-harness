/**
 * Branch persistence for the applied preset.
 *
 * A preset application is written to the current branch as ONE append-only
 * `preset-state` v2 entry carrying a *resolved snapshot*: the exact provider/id,
 * thinking level, normalized tool selection, resolved tool-name projection,
 * blacklist contribution, codemode mode and instruction text resolved at apply
 * time, plus the content hash of that definition.
 *
 * The snapshot is a version pack, not a diff. `contentHash` is computed from the
 * semantic fields only (see `presetContentHash`), so a later edit to
 * `presets.toml` or a change to the session tool baseline can be detected with a
 * single comparison instead of field-by-field guessing.
 *
 * `toolSelection` is the normalized intent: `none` (the preset declared no
 * tools), `modifiers` (`+name`/`-name` folded to final add/remove sets) or
 * `replace` (plain names, including an explicitly empty list). The tool-access
 * domain re-derives membership from it at replay time.
 * `tools` is the same selection RESOLVED against the nominal candidate baseline
 * (`session baseline` + registered Harness default tools) with unknown names
 * dropped. It is the projection used for version diffs and as the compaction
 * protection baseline; it is never the membership authority.
 * `disabledTools` is the current preset's BLACKLIST contribution: the explicit
 * final minus tokens. It lives only as long as this snapshot is the latest one,
 * so a switch replaces it and a clear withdraws it.
 * `baselineAdditions` is a PERMANENT branch fact: the Harness default tools this
 * application brought into the session baseline. Clearing a preset never
 * withdraws it, because it is ordinary session baseline now.
 *
 * Model/thinking/tool recovery itself belongs to Pi rather than replaying this
 * snapshot. Re-running `/preset NAME` re-resolves against the current definition.
 * Recording the snapshot rather than the preset name is deliberate: a name alone
 * would silently follow later config edits and restore a different session than
 * the branch recorded.
 *
 * `snapshot === null` records a clear: the session stopped being managed by a
 * preset. It withdraws exactly the preset layer (selection, blacklist, codemode
 * intent) and never the model, the thinking level, the manual `/capability base`
 * layer or a permanent `baselineAdditions` increment; a `replace` selection stops
 * replacing the baseline layer, so the recorded membership is visible again.
 *
 * `preset-version-skipped` records the user's explicit "keep the recorded
 * version" decision for one (name, recorded hash, candidate hash) triple. It is
 * append-only and expires by construction: any newer `preset-state` entry
 * outdates it, so no cleanup or rewrite is needed.
 *
 * Entries are append-only and never rewritten, matching every other branch
 * memory in this harness. Restoration reads the last entry on the branch. Only
 * v2 records are accepted: v1 sessions must be converted by the offline script
 * in `scripts/`, there is no runtime fallback.
 */

import { createHash } from 'node:crypto';
import type { CodemodeMode, PresetModel, ThinkingLevelName } from './config.ts';

/** `customType` of one applied-preset snapshot. */
export const PRESET_STATE_RECORD = 'preset-state';
export const PRESET_STATE_VERSION = 2;
/** `customType` of one "keep the recorded preset version" decision. */
export const PRESET_VERSION_SKIPPED_RECORD = 'preset-version-skipped';
export const PRESET_VERSION_SKIPPED_VERSION = 1;

/** Normalized tool-selection intent recorded by a v2 snapshot. */
export type PresetToolSelection =
  | { readonly kind: 'none' }
  | { readonly kind: 'modifiers'; readonly add: readonly string[]; readonly remove: readonly string[] }
  | { readonly kind: 'replace'; readonly names: readonly string[] };

/** The fully resolved state a preset apply froze onto the branch. */
export interface PresetSnapshot {
  readonly name: string;
  readonly model?: PresetModel;
  readonly thinkingLevel?: ThinkingLevelName;
  /** Resolved name projection of `toolSelection`; excludes dynamic Capability tools. */
  readonly tools?: readonly string[];
  /** Current-preset blacklist contribution (explicit final minus tokens). */
  readonly disabledTools?: readonly string[];
  readonly codemode?: { readonly mode: CodemodeMode };
  /** Resolved instruction text; null means the preset carried no instructions. */
  readonly instructions: string | null;
  /** Deterministic version of every semantic field above (see `presetContentHash`). */
  readonly contentHash: string;
  readonly toolSelection: PresetToolSelection;
}

/** One branch entry: a resolved snapshot, or a null clear. */
export interface PresetStateRecord {
  readonly version: typeof PRESET_STATE_VERSION;
  readonly snapshot: PresetSnapshot | null;
  /** Harness default tools this application added to the permanent session baseline. */
  readonly baselineAdditions?: readonly string[];
  /** Fields the user overrode after applying (informational). */
  readonly overrides?: readonly string[];
}

/** One "keep the recorded version" decision on the branch. */
export interface PresetVersionSkippedRecord {
  readonly version: typeof PRESET_VERSION_SKIPPED_VERSION;
  readonly name: string;
  readonly fromHash: string;
  readonly candidateHash: string;
}

/** The minimal writer this module needs; an ExtensionAPI satisfies it. */
export interface PresetStateWriter {
  appendEntry(customType: string, data: unknown): void;
}

/** The fields `contentHash` covers; everything else is deliberately excluded. */
export interface PresetVersionInput {
  readonly model?: PresetModel;
  readonly thinkingLevel?: ThinkingLevelName;
  readonly toolSelection: PresetToolSelection;
  readonly tools?: readonly string[];
  readonly disabledTools?: readonly string[];
  readonly codemode?: { readonly mode: CodemodeMode };
  readonly instructions: string | null;
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

/** Sorted copy; the version identity is a set identity for every name list. */
function sorted(names: readonly string[]): string[] {
  return [...names].sort();
}

function selectionPayload(selection: PresetToolSelection): Record<string, unknown> {
  if (selection.kind === 'modifiers') {
    return { kind: 'modifiers', add: sorted(selection.add), remove: sorted(selection.remove) };
  }
  if (selection.kind === 'replace') return { kind: 'replace', names: sorted(selection.names) };
  return { kind: 'none' };
}

/**
 * The preset's content version: a deterministic hash of its semantic fields.
 *
 * Inputs are model (provider/id), thinking level, the normalized tool-selection
 * intent, the resolved tool-name set, the disabled-name set, the codemode mode
 * and the instruction text. Excluded on purpose: tool schema/guideline/snippet
 * and description text (owned by the SDK, the Capability domain and the provider
 * transport), the preset name, and the user's manual `branch` layer — a manual
 * tool edit must never look like a stale preset.
 *
 * The hash is a pure function of the snapshot fields, never of the session tool
 * baseline, so the offline v1 converter reproduces it byte for byte.
 */
export function presetContentHash(input: PresetVersionInput): string {
  const payload = {
    model: input.model === undefined ? null : [input.model.provider, input.model.id],
    thinkingLevel: input.thinkingLevel ?? null,
    toolSelection: selectionPayload(input.toolSelection),
    tools: input.tools === undefined ? null : sorted(input.tools),
    disabledTools: input.disabledTools === undefined ? null : sorted(input.disabledTools),
    codemode: input.codemode === undefined ? null : input.codemode.mode,
    instructions: input.instructions,
  };
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

/** Snapshot fields a caller supplies; the hash and selection default are derived. */
export interface PresetSnapshotInput extends Omit<PresetSnapshot, 'contentHash' | 'toolSelection'> {
  /** Defaults to `none`: the preset declared no tools. */
  readonly toolSelection?: PresetToolSelection;
}

/** Build a consistent snapshot (hash included). The write path and tests share it. */
export function buildPresetSnapshot(input: PresetSnapshotInput): PresetSnapshot {
  const toolSelection = input.toolSelection ?? { kind: 'none' };
  return {
    name: input.name,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    ...(input.disabledTools === undefined ? {} : { disabledTools: [...input.disabledTools] }),
    ...(input.codemode === undefined ? {} : { codemode: { mode: input.codemode.mode } }),
    instructions: input.instructions,
    toolSelection,
    contentHash: presetContentHash({
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
      toolSelection,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.disabledTools === undefined ? {} : { disabledTools: input.disabledTools }),
      ...(input.codemode === undefined ? {} : { codemode: input.codemode }),
      instructions: input.instructions,
    }),
  };
}

function parseSelection(raw: unknown): PresetToolSelection {
  if (!isRecord(raw)) malformed('snapshot.toolSelection must be an object');
  const kind = raw['kind'];
  if (kind === 'none') return { kind: 'none' };
  if (kind === 'modifiers') {
    const add = raw['add'];
    const remove = raw['remove'];
    if (!isStringArray(add) || !isStringArray(remove)) {
      malformed('snapshot.toolSelection must carry add/remove string arrays');
    }
    return { kind: 'modifiers', add: [...add], remove: [...remove] };
  }
  if (kind === 'replace') {
    const names = raw['names'];
    if (!isStringArray(names)) malformed('snapshot.toolSelection.names must be a string array');
    return { kind: 'replace', names: [...names] };
  }
  return malformed('snapshot.toolSelection.kind must be "none", "modifiers" or "replace"');
}

function parseSnapshot(raw: unknown, verifyHash: boolean): PresetSnapshot {
  if (!isRecord(raw)) malformed('snapshot must be an object');
  const name = raw['name'];
  if (typeof name !== 'string' || name === '') malformed('snapshot.name must be a non-empty string');
  const instructions = raw['instructions'];
  if (instructions !== null && typeof instructions !== 'string') {
    malformed('snapshot.instructions must be a string or null');
  }
  const contentHash = raw['contentHash'];
  if (typeof contentHash !== 'string' || contentHash === '') {
    malformed('snapshot.contentHash must be a non-empty string');
  }
  let model: PresetModel | undefined;
  const rawModel = raw['model'];
  if (rawModel !== undefined) {
    if (!isRecord(rawModel) || typeof rawModel['provider'] !== 'string' || typeof rawModel['id'] !== 'string') {
      malformed('snapshot.model must be { provider, id }');
    }
    model = { provider: rawModel['provider'], id: rawModel['id'] };
  }
  let thinkingLevel: ThinkingLevelName | undefined;
  const rawThinking = raw['thinkingLevel'];
  if (rawThinking !== undefined) {
    if (typeof rawThinking !== 'string') malformed('snapshot.thinkingLevel must be a string');
    thinkingLevel = rawThinking as ThinkingLevelName;
  }
  let tools: readonly string[] | undefined;
  const rawTools = raw['tools'];
  if (rawTools !== undefined) {
    if (!isStringArray(rawTools)) malformed('snapshot.tools must be a string array');
    tools = [...rawTools];
  }
  let disabledTools: readonly string[] | undefined;
  const rawDisabled = raw['disabledTools'];
  if (rawDisabled !== undefined) {
    if (!isStringArray(rawDisabled)) malformed('snapshot.disabledTools must be a string array');
    disabledTools = [...rawDisabled];
  }
  let codemode: { readonly mode: CodemodeMode } | undefined;
  const rawCodemode = raw['codemode'];
  if (rawCodemode !== undefined) {
    if (!isRecord(rawCodemode) || (rawCodemode['mode'] !== 'on' && rawCodemode['mode'] !== 'only')) {
      malformed('snapshot.codemode.mode must be "on" or "only"');
    }
    codemode = { mode: rawCodemode['mode'] };
  }
  const toolSelection = parseSelection(raw['toolSelection']);
  const snapshot: PresetSnapshot = {
    name,
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(tools === undefined ? {} : { tools }),
    ...(disabledTools === undefined ? {} : { disabledTools }),
    ...(codemode === undefined ? {} : { codemode }),
    instructions,
    toolSelection,
    contentHash,
  };
  // The hash is the record's identity; a hand-edited or wrongly converted entry
  // must fail loudly instead of reporting a bogus version comparison forever.
  // Readers that never compare versions skip the recomputation.
  if (verifyHash) {
    const computed = presetContentHash({
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      toolSelection,
      ...(tools === undefined ? {} : { tools }),
      ...(disabledTools === undefined ? {} : { disabledTools }),
      ...(codemode === undefined ? {} : { codemode }),
      instructions,
    });
    if (computed !== contentHash) {
      malformed(`snapshot.contentHash ${contentHash} does not match its contents (${computed})`);
    }
  }
  return snapshot;
}

/** Strict format gate shared by every reader; v1 is rejected, never guessed. */
function statePayload(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) malformed('expected an object payload');
  if (data['version'] !== PRESET_STATE_VERSION) {
    malformed(`expected version ${PRESET_STATE_VERSION}, got ${String(data['version'])}`);
  }
  return data;
}

/** Cheap read of the permanent increments: no snapshot parse, no hash. */
function additionsOf(data: Record<string, unknown>): readonly string[] {
  const raw = data['baselineAdditions'];
  if (raw === undefined) return [];
  if (!isStringArray(raw)) malformed('baselineAdditions must be a string array');
  return raw;
}

/**
 * Full record read. `verifyHash` is skipped by readers that only consume the
 * tool projection (compaction), because recomputing SHA-256 over instruction
 * text is wasted work there.
 */
function parseRecord(data: unknown, verifyHash = true): PresetStateRecord {
  const payload = statePayload(data);
  const rawSnapshot = payload['snapshot'];
  if (rawSnapshot === undefined) malformed('expected snapshot to be an object or null');
  const snapshot = rawSnapshot === null ? null : parseSnapshot(rawSnapshot, verifyHash);
  const overrides = payload['overrides'];
  if (overrides !== undefined && !isStringArray(overrides)) malformed('overrides must be a string array');
  const rawAdditions = payload['baselineAdditions'];
  return {
    version: PRESET_STATE_VERSION,
    snapshot,
    ...(rawAdditions === undefined ? {} : { baselineAdditions: [...additionsOf(payload)] }),
    ...(overrides === undefined ? {} : { overrides: [...overrides] }),
  };
}

function skippedMalformed(detail: string): never {
  throw new Error(`Malformed ${PRESET_VERSION_SKIPPED_RECORD} entry on the session branch: ${detail}`);
}

function parseSkipped(data: unknown): PresetVersionSkippedRecord {
  if (!isRecord(data)) skippedMalformed('expected an object payload');
  if (data['version'] !== PRESET_VERSION_SKIPPED_VERSION) skippedMalformed('expected version 1');
  const name = data['name'];
  const fromHash = data['fromHash'];
  const candidateHash = data['candidateHash'];
  if (typeof name !== 'string' || name === '') skippedMalformed('name must be a non-empty string');
  if (typeof fromHash !== 'string' || typeof candidateHash !== 'string') skippedMalformed('hashes must be strings');
  return { version: PRESET_VERSION_SKIPPED_VERSION, name, fromHash, candidateHash };
}

function isCustom(entry: unknown, customType: string): entry is Record<string, unknown> {
  return isRecord(entry) && entry['type'] === 'custom' && entry['customType'] === customType;
}

/** Index of the last `preset-state` entry, or -1 when the branch has none. */
function lastStateIndex(branch: readonly unknown[]): number {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (isCustom(branch[index], PRESET_STATE_RECORD)) return index;
  }
  return -1;
}

/** The latest preset-state entry on the branch, or null when none exists. */
export function readPresetState(branch: readonly unknown[] | null | undefined): PresetStateRecord | null {
  const entries = branch ?? [];
  const index = lastStateIndex(entries);
  return index === -1 ? null : parseRecord((entries[index] as Record<string, unknown>)['data']);
}

/** The snapshot that should be active now, or null when cleared/never set. */
export function restorePresetSnapshot(branch: readonly unknown[] | null | undefined): PresetSnapshot | null {
  return readPresetState(branch)?.snapshot ?? null;
}

/**
 * Every permanent baseline increment this branch has committed, in branch order.
 *
 * Increments are additive and survive a clear, so this unions all v2 records
 * instead of reading only the latest one. The result is the extra baseline layer
 * the tool-access replay starts from.
 */
export function presetBaselineAdditions(branch: readonly unknown[] | null | undefined): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of branch ?? []) {
    if (!isCustom(entry, PRESET_STATE_RECORD)) continue;
    for (const name of additionsOf(statePayload(entry['data']))) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * The user's current "keep the recorded version" decision, if it still applies.
 *
 * Only a record appended AFTER the latest `preset-state` counts: any newer apply
 * or clear is a new decision, so an older skip expires without being rewritten.
 */
export function readSkippedVersion(
  branch: readonly unknown[] | null | undefined,
): PresetVersionSkippedRecord | null {
  const entries = branch ?? [];
  const stateIndex = lastStateIndex(entries);
  // Without an applied preset there is nothing to compare, so no decision applies.
  if (stateIndex === -1) return null;
  let latest: PresetVersionSkippedRecord | null = null;
  for (let index = stateIndex + 1; index < entries.length; index += 1) {
    if (!isCustom(entries[index], PRESET_VERSION_SKIPPED_RECORD)) continue;
    latest = parseSkipped((entries[index] as Record<string, unknown>)['data']);
  }
  return latest;
}

/**
 * Whether a preset reduced the session baseline since the preceding compaction.
 *
 * `baseline` is the recorded session tool baseline owned by the tool-access
 * domain; the caller already holds it, so this module does not capture or write
 * it. Each v2 record's permanent additions join the baseline layer before its
 * projection is compared, matching what replay produces. A compaction resets the
 * pending request but keeps the last preset selection as the comparison point,
 * matching the "since the preceding compaction" window.
 */
export function hasPresetBaseToolRemoval(
  branch: readonly unknown[],
  checkpointId: string,
  baseline: readonly string[],
): boolean {
  const previous = new Set(baseline);
  let removed = false;
  for (const entry of branch) {
    if (!isRecord(entry)) continue;
    // session_compact runs after its checkpoint has already been appended.
    if (entry['id'] === checkpointId) break;
    if (entry['type'] === 'compaction') removed = false;
    if (!isCustom(entry, PRESET_STATE_RECORD)) continue;
    // Compaction only consumes the projection, so the hash is not recomputed.
    const record = parseRecord(entry['data'], false);
    // A permanent increment is baseline membership from this point on.
    for (const name of record.baselineAdditions ?? []) previous.add(name);
    const tools = record.snapshot?.tools;
    // Clear and instruction/model-only presets do not replace the live tools.
    if (tools === undefined) continue;
    let lost = false;
    for (const name of previous) {
      if (!tools.includes(name)) { lost = true; break; }
    }
    if (lost) removed = true;
    previous.clear();
    for (const name of tools) previous.add(name);
  }
  return removed;
}

/** Append one preset-state entry to the branch. */
export function appendPresetState(writer: PresetStateWriter, record: PresetStateRecord): void {
  writer.appendEntry(PRESET_STATE_RECORD, record);
}

/** Append one "keep the recorded version" decision to the branch. */
export function appendSkippedVersion(writer: PresetStateWriter, record: PresetVersionSkippedRecord): void {
  writer.appendEntry(PRESET_VERSION_SKIPPED_RECORD, record);
}
