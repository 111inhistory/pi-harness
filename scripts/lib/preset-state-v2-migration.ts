/**
 * Offline v1 -> v2 `preset-state` conversion for one closed session file.
 *
 * The runtime accepts only v2 records, so sessions written before the preset
 * version upgrade must be converted before they are opened again. This module is
 * the only code that understands the v1 shape: it never runs from a session
 * start or a request, and it never reads `presets.json`, because the branch
 * record already froze the resolved snapshot. A preset that has since been
 * renamed or deleted therefore converts losslessly.
 *
 * Two v1 forms need distinct treatment:
 * - A v1 snapshot is copied field for field, and its flattened `tools` become an
 *   explicit `toolSelection: { kind: 'replace' }`. The original `+`/`-` intent
 *   cannot be recovered from a flattened projection; re-applying the preset from
 *   `presets.json` restores modifier semantics through the normal upgrade path.
 *   The `contentHash` is derived by the shared `buildPresetSnapshot`.
 * - A v1 clear (`snapshot: null`) only relabelled the preset's base membership as
 *   ordinary branch membership, so the set itself did not change.
 *
 * v2 membership is layered rather than positional, so a converted record's
 * projection can drift: a `replace` selection no longer wipes earlier manual base
 * adds, and the recorded baseline layer returns after a clear. The runtime schema
 * is therefore left untouched and the migration inserts one ordinary
 * `capability-tool-base` record holding the exact membership delta. It is a
 * standard manual base layer change, so replay, `/capability base` and the
 * display layer need no new field. A late baseline capture can likewise need a
 * repair when an earlier preset replacement masks it in v2. The synthetic node
 * becomes a child of its anchor, and the anchor's original direct children move
 * beneath it. Descendant branches inherit the delta and existing IDs stay stable.
 *
 * Exactness is defined per leaf: for every leaf of the original file, the
 * migrated branch must replay to the same base membership as the v1 replay did.
 * The delta is derived from that comparison (v1 sequential fold versus the
 * authoritative v2 `replay`), and the whole conversion is verified again over
 * every leaf and every synthetic node before a byte is written.
 *
 * Files that mix v1 and v2 records are refused rather than half-converted: no
 * runtime can legitimately produce that mix, and guessing would leave a branch
 * whose projection depends on which half the reader understands.
 *
 * The file is read and rewritten as whole text, so peak memory is about twice
 * the session size. That is deliberate: this is an explicit offline tool over one
 * closed session, and materializing the text keeps the byte-identity checks
 * simple. Untouched lines are copied verbatim; only converted preset records,
 * re-parented children and the inserted nodes are rewritten.
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  buildPresetSnapshot,
  PRESET_STATE_RECORD,
  readPresetState,
  type PresetSnapshot,
  type PresetStateRecord,
} from '../../src/preset/state.ts';
import { CODEMODE_MODES, THINKING_LEVELS, type CodemodeMode, type ThinkingLevelName } from '../../src/preset/config.ts';
import { replay, TOOL_BASE_RECORD, TOOL_BASE_VERSION } from '../../src/capability/tool-access-replay.ts';
import { deriveSessionUid } from '../../src/ipc/socket.ts';

/** The retired wire version this tool converts. */
const LEGACY_PRESET_STATE_VERSION = 1;
/**
 * The version this tool writes. It is pinned rather than read from
 * `PRESET_STATE_VERSION`: this module knows the v2 shape exactly, so a later
 * version needs its own conversion step instead of inheriting this one.
 */
const TARGET_PRESET_STATE_VERSION = 2;
/** A standard base record inserted to carry one record's membership delta. */
export interface PresetMigrationNode {
  readonly id: string;
  /** Original entry the node was inserted after and hangs under. */
  readonly afterEntryId: string;
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

/** One converted `preset-state` entry. */
export interface PresetMigrationConversion {
  readonly entryId: string;
  readonly kind: 'snapshot' | 'clear';
  /** Preset name the v1 snapshot recorded; absent on a clear. */
  readonly presetName?: string;
  /** Normalized selection the v2 record now carries. */
  readonly toolSelection: 'none' | 'replace';
  /** Derived version identity; absent on a clear. */
  readonly contentHash?: string;
  /** Synthetic node carrying the membership delta; null when none was needed. */
  readonly node: PresetMigrationNode | null;
  /** Direct original children re-parented from the converted entry onto the node. */
  readonly reparented: readonly string[];
}

/** Read-only description of what converting one file would do. */
export interface PresetMigrationPlan {
  readonly mode: 'plan';
  readonly file: string;
  readonly sessionId: string | null;
  readonly sourceBytes: number;
  readonly sourceHash: string;
  readonly entries: {
    readonly total: number;
    readonly v1: number;
    readonly v2: number;
    readonly inserted: number;
  };
  readonly conversions: readonly PresetMigrationConversion[];
  readonly changed: boolean;
  readonly warnings: readonly string[];
  readonly runtimeValidated: false;
}

/** Outcome of an applied (or already current) conversion. */
export interface PresetMigrationReport {
  readonly mode: 'report';
  readonly status: 'applied' | 'unchanged';
  readonly file: string;
  readonly sessionId: string | null;
  readonly backup: string | null;
  readonly restoreCommand: string | null;
  readonly sourceBytes: number;
  readonly sourceHash: string;
  readonly targetHash: string;
  readonly backupHash: string | null;
  readonly entries: PresetMigrationPlan['entries'];
  readonly conversions: readonly PresetMigrationConversion[];
  readonly warnings: readonly string[];
  readonly runtimeValidated: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '') return null;
    names.push(item);
  }
  return names;
}

/** The lenient name filter worded like the tool-access replay's `strings()`. */
function recordedNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sameStat(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function fail(file: string, where: string, detail: string): never {
  throw new Error(`Session ${file}${where}: ${detail}; file left unchanged.`);
}

/** Split into lines while preserving every terminator for byte-exact output. */
function splitLines(source: string): readonly string[] {
  return source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function endingOf(raw: string): string {
  return raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
}

function withEnding(raw: string, entry: unknown): string {
  return JSON.stringify(entry) + endingOf(raw);
}

interface Line {
  /** 1-based line number, used in refusals. */
  readonly number: number;
  readonly raw: string;
  readonly entry: Record<string, unknown> | null;
}

interface V1Snapshot {
  readonly name: string;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly thinkingLevel?: ThinkingLevelName;
  readonly tools?: readonly string[];
  readonly disabledTools?: readonly string[];
  readonly codemode?: { readonly mode: CodemodeMode };
  readonly instructions: string | null;
}

function v1Snapshot(file: string, line: Line, raw: unknown): V1Snapshot {
  const where = `:${line.number}`;
  if (!isRecord(raw)) fail(file, where, 'preset-state snapshot must be an object');
  const name = raw['name'];
  if (typeof name !== 'string' || name === '') fail(file, where, 'preset-state snapshot.name must be a non-empty string');
  const instructions = raw['instructions'];
  if (instructions !== null && typeof instructions !== 'string') {
    fail(file, where, 'preset-state snapshot.instructions must be a string or null');
  }
  let model: V1Snapshot['model'];
  const rawModel = raw['model'];
  if (rawModel !== undefined) {
    if (!isRecord(rawModel) || typeof rawModel['provider'] !== 'string' || typeof rawModel['id'] !== 'string') {
      fail(file, where, 'preset-state snapshot.model must be { provider, id }');
    }
    model = { provider: rawModel['provider'], id: rawModel['id'] };
  }
  let thinkingLevel: ThinkingLevelName | undefined;
  const rawThinking = raw['thinkingLevel'];
  if (rawThinking !== undefined) {
    if (typeof rawThinking !== 'string' || !(THINKING_LEVELS as readonly string[]).includes(rawThinking)) {
      fail(file, where, 'preset-state snapshot.thinkingLevel is not a known thinking level');
    }
    thinkingLevel = rawThinking as ThinkingLevelName;
  }
  let tools: readonly string[] | undefined;
  const rawTools = raw['tools'];
  if (rawTools !== undefined) {
    const parsed = stringArray(rawTools);
    if (parsed === null) fail(file, where, 'preset-state snapshot.tools must be a string array');
    tools = parsed;
  }
  let disabledTools: readonly string[] | undefined;
  const rawDisabled = raw['disabledTools'];
  if (rawDisabled !== undefined) {
    const parsed = stringArray(rawDisabled);
    if (parsed === null) fail(file, where, 'preset-state snapshot.disabledTools must be a string array');
    disabledTools = parsed;
  }
  let codemode: V1Snapshot['codemode'];
  const rawCodemode = raw['codemode'];
  if (rawCodemode !== undefined) {
    const mode = isRecord(rawCodemode) ? rawCodemode['mode'] : undefined;
    if (typeof mode !== 'string' || !(CODEMODE_MODES as readonly string[]).includes(mode)) {
      fail(file, where, 'preset-state snapshot.codemode.mode must be "on" or "only"');
    }
    codemode = { mode: mode as CodemodeMode };
  }
  return {
    name,
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(tools === undefined ? {} : { tools }),
    ...(disabledTools === undefined ? {} : { disabledTools }),
    ...(codemode === undefined ? {} : { codemode }),
    instructions,
  };
}

function overridesOf(raw: unknown, file: string, line: Line): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const overrides = stringArray(raw);
  if (overrides === null) fail(file, `:${line.number}`, 'preset-state overrides must be a string array');
  return overrides;
}

/**
 * The recorded v1 base membership after one branch prefix.
 *
 * Reproduces v1 replay literally: base records add their `baseline`/`add` names
 * and delete their `remove` names, a snapshot that declares `tools` replaces the
 * whole membership with that preset-sourced set, and a snapshot without `tools`
 * or a clear leaves the set alone (a v1 clear only relabelled sources).
 */
function v1BaseMembership(
  path: readonly Record<string, unknown>[],
  file: string,
  where: string,
): ReadonlySet<string> {
  const base = new Set<string>();
  for (const entry of path) {
    if (entry['type'] !== 'custom') continue;
    const customType = entry['customType'];
    if (customType === TOOL_BASE_RECORD) {
      const data = entry['data'];
      if (!isRecord(data) || data['version'] !== TOOL_BASE_VERSION) continue;
      for (const name of recordedNames(data['baseline'])) base.add(name);
      for (const name of recordedNames(data['add'])) base.add(name);
      for (const name of recordedNames(data['remove'])) base.delete(name);
      continue;
    }
    if (customType !== PRESET_STATE_RECORD) continue;
    const data = entry['data'];
    if (!isRecord(data) || data['version'] !== LEGACY_PRESET_STATE_VERSION) continue;
    const snapshot = data['snapshot'];
    if (snapshot === null) continue;
    if (!isRecord(snapshot)) fail(file, where, 'encountered a malformed preset-state record');
    const tools = snapshot['tools'];
    if (tools === undefined) continue;
    const declared = stringArray(tools);
    if (declared === null) fail(file, where, 'encountered a malformed preset-state record');
    base.clear();
    for (const name of declared) base.add(name);
  }
  return base;
}

/**
 * Every entry from the root to `id`, inclusive.
 *
 * A broken or cyclic parent chain is refused rather than truncated: the retained
 * membership of a record is only meaningful for the branch prefix that exists.
 */
function pathTo(
  byId: ReadonlyMap<string, Record<string, unknown>>,
  id: string,
  file: string,
  where: string,
): readonly Record<string, unknown>[] {
  const path: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current !== null) {
    if (seen.has(current)) fail(file, where, `parent chain is cyclic at ${current}`);
    seen.add(current);
    const entry = byId.get(current);
    if (entry === undefined) fail(file, where, `entry ${current} is missing from the branch chain`);
    path.push(entry);
    const parentId = entry['parentId'];
    current = typeof parentId === 'string' && parentId !== '' ? parentId : null;
  }
  return path.reverse();
}

function sameNames(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const name of left) if (!right.has(name)) return false;
  return true;
}

function describeDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string {
  const missing = [...left].filter((name) => !right.has(name)).sort();
  const extra = [...right].filter((name) => !left.has(name)).sort();
  return `missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`;
}

/** Preset membership the authoritative v2 replay computes for one branch. */
function v2BaseMembership(branch: readonly unknown[]): ReadonlySet<string> {
  return new Set(replay({ getAllTools: () => [] }, branch).base.keys());
}

function isBaselineEntry(entry: Record<string, unknown>): boolean {
  const data = entry['data'];
  return entry['type'] === 'custom' && entry['customType'] === TOOL_BASE_RECORD
    && isRecord(data) && data['version'] === TOOL_BASE_VERSION && Array.isArray(data['baseline']);
}

interface PreparedConversion {
  readonly converted: PresetStateRecord;
  readonly migratedEntry: Record<string, unknown>;
  readonly conversion: PresetMigrationConversion;
}

/**
 * Patch only the top-level `parentId` string literal, preserving every other
 * byte of a re-parented native entry (messages, checkpoints, custom records).
 */
function patchParentId(raw: string, parentId: string): string {
  const skipWhitespace = (from: number): number => {
    let at = from;
    while (at < raw.length && /\s/.test(raw[at]!)) at += 1;
    return at;
  };
  /** `start` is the opening quote; returns the index just past the closing quote. */
  const skipString = (start: number): number => {
    let at = start + 1;
    while (at < raw.length) {
      if (raw[at] === '\\') { at += 2; continue; }
      if (raw[at] === '"') return at + 1;
      at += 1;
    }
    throw new Error('unterminated JSON string in the entry');
  };
  let depth = 0;
  let index = 0;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === '"') {
      const after = skipString(index);
      const literal = raw.slice(index, after);
      index = after;
      if (depth !== 1 || literal !== '"parentId"') continue;
      // A depth-1 string *value* can also read "parentId"; only a key is followed
      // by a colon, and anything else is skipped instead of failing the scan.
      const colon = skipWhitespace(index);
      if (raw[colon] !== ':') continue;
      const valueStart = skipWhitespace(colon + 1);
      if (raw[valueStart] !== '"') throw new Error('entry parentId is not a string value');
      const valueEnd = skipString(valueStart);
      return raw.slice(0, valueStart) + JSON.stringify(parentId) + raw.slice(valueEnd);
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
    index += 1;
  }
  throw new Error('entry has no parentId field');
}

interface Prepared {
  readonly file: string;
  readonly stat: Stats;
  readonly source: string;
  readonly sourceHash: string;
  readonly lines: readonly Line[];
  readonly output: readonly string[];
  readonly sessionId: string | null;
  readonly entries: PresetMigrationPlan['entries'];
  readonly conversions: readonly PresetMigrationConversion[];
  readonly warnings: readonly string[];
}

function prepare(file: string): Prepared {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Session ${file}: migration requires a regular, non-symlink file.`);
  }
  const source = readFileSync(file, 'utf8');
  const rawLines = splitLines(source);
  const lines: Line[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  const lineById = new Map<string, Line>();
  let headerSeen = false;
  let sessionId: string | null = null;
  for (const [index, raw] of rawLines.entries()) {
    if (raw.trim() === '') {
      lines.push({ number: index + 1, raw, entry: null });
      continue;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { fail(file, `:${index + 1}`, 'line is not valid JSON'); }
    if (!isRecord(parsed)) fail(file, `:${index + 1}`, 'expected a native session entry object');
    if (!headerSeen) {
      if (parsed['type'] !== 'session') fail(file, `:${index + 1}`, 'expected a session header as the first entry');
      headerSeen = true;
      sessionId = typeof parsed['id'] === 'string' && parsed['id'] !== '' ? parsed['id'] : null;
    }
    const id = parsed['id'];
    const line: Line = { number: index + 1, raw, entry: parsed };
    if (typeof id === 'string') {
      if (byId.has(id)) fail(file, `:${index + 1}`, `duplicate entry id ${id}`);
      byId.set(id, parsed);
      lineById.set(id, line);
    }
    lines.push(line);
  }
  if (!headerSeen) fail(file, '', 'no session header found');

  const allIds = new Set(byId.keys());
  let v1 = 0;
  let v2 = 0;
  for (const line of lines) {
    if (line.entry === null || line.entry['type'] !== 'custom') continue;
    if (line.entry['customType'] !== PRESET_STATE_RECORD) continue;
    const data = line.entry['data'];
    const version = isRecord(data) ? data['version'] : undefined;
    if (version === LEGACY_PRESET_STATE_VERSION) v1 += 1;
    else if (version === TARGET_PRESET_STATE_VERSION) v2 += 1;
    else fail(file, `:${line.number}`, `unsupported preset-state version ${String(version)}`);
  }
  if (v1 > 0 && v2 > 0) {
    fail(file, '', `${v1} v1 and ${v2} v2 preset-state records coexist; nothing was converted`);
  }

  /**
   * Deterministic, collision-safe ID in the native 8-hex idiom.
   *
   * The digest is salted with an attempt counter, so re-planning the same file
   * always yields the same ID and a collision with an existing ID just advances
   * the counter instead of producing a duplicate.
   */
  const allocateId = (entryId: string): string => {
    for (let attempt = 0; ; attempt += 1) {
      const candidate = createHash('sha256').update(`${entryId}#${attempt}`).digest('hex').slice(0, 8);
      if (allIds.has(candidate)) continue;
      allIds.add(candidate);
      return candidate;
    }
  };

  const prepared = new Map<string, PreparedConversion>();
  const converting = new Set<string>();
  const baselineChecked = new Set<string>();
  const nodeByEntryId = new Map<string, PresetMigrationNode>();
  const insertedEntries = new Map<string, Record<string, unknown>>();

  const insertNode = (entryId: string, entry: Record<string, unknown>, add: readonly string[], remove: readonly string[]) => {
    if (add.length === 0 && remove.length === 0) return null;
    const node = { id: allocateId(entryId), afterEntryId: entryId, add, remove };
    nodeByEntryId.set(entryId, node);
    insertedEntries.set(entryId, {
      type: 'custom', customType: TOOL_BASE_RECORD, id: node.id, parentId: entryId,
      ...(typeof entry['timestamp'] === 'string' ? { timestamp: entry['timestamp'] } : {}),
      data: { version: TOOL_BASE_VERSION, ...(add.length === 0 ? {} : { add }), ...(remove.length === 0 ? {} : { remove }) },
    });
    return node;
  };

  function migratedPrefix(path: readonly Record<string, unknown>[]): Record<string, unknown>[] {
    const migrated: Record<string, unknown>[] = [];
    let replacing = false;
    for (const [index, ancestor] of path.entries()) {
      const id = ancestor['id'] as string;
      if (ancestor['type'] === 'custom' && ancestor['customType'] === PRESET_STATE_RECORD) {
        const converted = convert(ancestor);
        replacing = converted.conversion.toolSelection === 'replace';
        migrated.push(converted.migratedEntry);
      } else {
        migrated.push(ancestor);
        if (isBaselineEntry(ancestor) && !baselineChecked.has(id)) {
          baselineChecked.add(id);
          if (replacing) {
            // v1 added a late capture to the active base. In v2 a replace masks
            // that capture, so preserve the missing members on the manual layer.
            const target = v1BaseMembership(path.slice(0, index + 1), file, '');
            const actual = v2BaseMembership(migrated);
            insertNode(id, ancestor, [...target].filter(name => !actual.has(name)).sort(), []);
          }
        }
      }
      const inserted = insertedEntries.get(id);
      if (inserted !== undefined) migrated.push(inserted);
    }
    return migrated;
  }

  function convert(entry: Record<string, unknown>): PreparedConversion {
    const entryId = entry['id'];
    if (typeof entryId !== 'string') fail(file, '', 'a preset-state entry has no id');
    const memo = prepared.get(entryId);
    if (memo !== undefined) return memo;
    if (converting.has(entryId)) fail(file, '', `preset-state branch chain is cyclic at ${entryId}`);
    converting.add(entryId);
    const line = lineById.get(entryId);
    if (line === undefined) fail(file, '', `preset-state entry ${entryId} is not addressable`);
    const data = entry['data'];
    if (!isRecord(data) || data['version'] !== LEGACY_PRESET_STATE_VERSION) {
      fail(file, `:${line.number}`, 'preset-state data must be a legacy v1 object');
    }
    const overrides = overridesOf(data['overrides'], file, line);
    const path = pathTo(byId, entryId, file, `:${line.number}`);
    const prefix = migratedPrefix(path.slice(0, -1));

    let convertedRecord: PresetStateRecord;
    let kind: PresetMigrationConversion['kind'];
    let presetName: string | undefined;
    let contentHash: string | undefined;
    let toolSelection: PresetMigrationConversion['toolSelection'] = 'none';
    if (data['snapshot'] === null) {
      kind = 'clear';
      convertedRecord = {
        version: TARGET_PRESET_STATE_VERSION,
        snapshot: null,
        ...(overrides === undefined ? {} : { overrides }),
      };
    } else {
      kind = 'snapshot';
      const snapshot = v1Snapshot(file, line, data['snapshot']);
      const built: PresetSnapshot = buildPresetSnapshot({
        name: snapshot.name,
        ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
        ...(snapshot.thinkingLevel === undefined ? {} : { thinkingLevel: snapshot.thinkingLevel }),
        ...(snapshot.tools === undefined ? {} : { tools: snapshot.tools }),
        ...(snapshot.disabledTools === undefined ? {} : { disabledTools: snapshot.disabledTools }),
        ...(snapshot.codemode === undefined ? {} : { codemode: snapshot.codemode }),
        instructions: snapshot.instructions,
        toolSelection: snapshot.tools === undefined ? { kind: 'none' } : { kind: 'replace', names: [...snapshot.tools] },
      });
      presetName = built.name;
      contentHash = built.contentHash;
      toolSelection = built.toolSelection.kind === 'replace' ? 'replace' : 'none';
      convertedRecord = {
        version: TARGET_PRESET_STATE_VERSION,
        snapshot: built,
        ...(overrides === undefined ? {} : { overrides }),
      };
    }
    const migratedEntry: Record<string, unknown> = { ...entry, data: convertedRecord };

    // The membership this record must leave behind, and what v2 computes without
    // the synthetic node. The difference is the exact manual-layer delta.
    const target = v1BaseMembership(path, file, `:${line.number}`);
    const withoutNode = v2BaseMembership([...prefix, migratedEntry]);
    const add = [...target].filter((name) => !withoutNode.has(name)).sort();
    const remove = [...withoutNode].filter((name) => !target.has(name)).sort();
    const node = insertNode(entryId, entry, add, remove);

    // Direct children move onto the node so every descendant branch keeps the
    // delta; the node itself is the only new entry in the file. Without a node
    // the children keep their edge.
    const reparented: string[] = [];
    if (node !== null) {
      for (const candidate of byId.values()) {
        if (candidate === entry) continue;
        if (candidate['parentId'] !== entryId) continue;
        reparented.push(candidate['id'] as string);
      }
    }

    const conversion: PresetMigrationConversion = {
      entryId,
      kind,
      ...(presetName === undefined ? {} : { presetName }),
      toolSelection,
      ...(contentHash === undefined ? {} : { contentHash }),
      node,
      reparented,
    };
    const result: PreparedConversion = { converted: convertedRecord, migratedEntry, conversion };
    prepared.set(entryId, result);
    converting.delete(entryId);
    return result;
  };

  for (const line of lines) {
    if (line.entry === null || line.entry['type'] !== 'custom') continue;
    if (line.entry['customType'] !== PRESET_STATE_RECORD) continue;
    const data = line.entry['data'];
    if (!isRecord(data) || data['version'] !== LEGACY_PRESET_STATE_VERSION) continue;
    convert(line.entry);
  }

  if (v1 > 0) {
    for (const [id, entry] of byId) {
      if (isBaselineEntry(entry) && !baselineChecked.has(id)) migratedPrefix(pathTo(byId, id, file, ''));
    }
  }

  // Emit each repair after its anchor and re-parent the anchor's direct children.
  const output: string[] = [];
  for (const line of lines) {
    const entry = line.entry;
    if (entry === null) {
      output.push(line.raw);
      continue;
    }
    const entryId = typeof entry['id'] === 'string' ? entry['id'] : null;
    const converted = entryId === null ? undefined : prepared.get(entryId);
    const parentId = entry['parentId'];
    const parentNode = typeof parentId === 'string' ? nodeByEntryId.get(parentId) : undefined;
    const inserted = entryId === null ? undefined : insertedEntries.get(entryId);
    let rewritten = line.raw;
    if (converted !== undefined) {
      rewritten = withEnding(line.raw, {
        ...converted.migratedEntry,
        parentId: parentNode === undefined ? parentId : parentNode.id,
      });
      const check = JSON.parse(rewritten) as Record<string, unknown>;
      if (check['id'] !== entry['id'] || check['timestamp'] !== entry['timestamp']) {
        fail(file, `:${line.number}`, 'converted entry changed its identity');
      }
      const reread = readPresetState([check]);
      const expected = converted.converted;
      if (reread === null
        || reread.snapshot?.contentHash !== expected.snapshot?.contentHash
        || (reread.overrides ?? []).join('\u0000') !== (expected.overrides ?? []).join('\u0000')) {
        fail(file, `:${line.number}`, 'converted preset-state record does not load as the same branch fact');
      }
    } else if (parentNode !== undefined) {
      try { rewritten = patchParentId(line.raw, parentNode.id); }
      catch (error) {
        fail(file, `:${line.number}`, `cannot re-parent this entry: ${error instanceof Error ? error.message : String(error)}`);
      }
      const check = JSON.parse(rewritten) as Record<string, unknown>;
      if (check['id'] !== entry['id'] || check['parentId'] !== parentNode.id) {
        fail(file, `:${line.number}`, 're-parented entry changed its identity');
      }
    }
    if (inserted === undefined) output.push(rewritten);
    else {
      output.push(endingOf(rewritten) === '' ? `${rewritten}\n` : rewritten);
      output.push(withEnding(line.raw, inserted));
    }
  }

  // Verify every original leaf and every synthetic node against the v1
  // projection of the original branch it replaces. An already-v2 file has no v1
  // projection to compare, and nothing was converted for it.
  if (prepared.size > 0) {
    const migratedById = new Map<string, Record<string, unknown>>();
    for (const raw of output) {
      if (raw.trim() === '') continue;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const id = parsed['id'];
      if (typeof id === 'string') migratedById.set(id, parsed);
    }
    const hasChild = new Set<string>();
    for (const entry of byId.values()) {
      const parentId = entry['parentId'];
      if (typeof parentId === 'string') hasChild.add(parentId);
    }
    for (const entry of byId.values()) {
      const id = typeof entry['id'] === 'string' ? entry['id'] : null;
      if (id === null || hasChild.has(id)) continue;
      const node = nodeByEntryId.get(id);
      const migratedLeaf = node === undefined ? id : node.id;
      const original = v1BaseMembership(pathTo(byId, id, file, ''), file, '');
      const migrated = v2BaseMembership(pathTo(migratedById, migratedLeaf, file, ''));
      if (!sameNames(original, migrated)) {
        fail(file, '', `leaf ${id} would replay as a different tool membership (${describeDifference(original, migrated)})`);
      }
    }
    for (const node of nodeByEntryId.values()) {
      const original = v1BaseMembership(pathTo(byId, node.afterEntryId, file, ''), file, '');
      const migrated = v2BaseMembership(pathTo(migratedById, node.id, file, ''));
      if (!sameNames(original, migrated)) {
        fail(file, '', `synthetic node ${node.id} would replay as a different tool membership (${describeDifference(original, migrated)})`);
      }
    }
  }

  const inserted = nodeByEntryId.size;
  const warnings: string[] = [
    'Close Pi for this session before migrating, and keep the byte-exact backup output until the migrated session loads correctly.',
    'Content hashes are derived from the recorded projection, not from the current presets.json: a migrated preset may report "outdated" until it is re-applied, and a preset that was deleted or renamed still converts losslessly.',
    'Existing capability-tool-base records, child sessions and presets.json are not modified; only the inserted nodes are new base records.',
    'Pass --socket-root <dir> to let the tool refuse --apply while a managed session record names a live process for this session.',
    'Each Preset conversion or late baseline that needs a membership repair gets one standard capability-tool-base record. The new ID is deterministic; existing IDs are preserved, and direct children move beneath the repair.',
    'The inserted record is an ordinary manual base layer change: it appears in /capability base, its add names lift a root-local startup or preset ban as any preset-selected name does, and each of its remove names leaves a permanent compaction removal intent on that branch. Unlike a user /capability base remove, it deletes no dynamic discovery membership, so dynamic tools are still governed by their own records.',
    'A repair after the last entry becomes the session leaf. Selecting a repair anchor itself in /tree starts before the repair; select the following node to include its tool membership.',
  ];
  for (const node of nodeByEntryId.values()) {
    if (!prepared.has(node.afterEntryId)) {
      warnings.push(`Late baseline ${node.afterEntryId}: inserted ${node.id} to retain ${node.add.join(', ')}.`);
    }
  }
  if (sessionId === null) {
    warnings.push(
      'The session header carries no id, so a live managed-session record cannot be matched; close Pi and rely on the environment check before --apply.',
    );
  }

  const conversions = [...prepared.values()].map((result) => result.conversion);
  return {
    file,
    stat,
    source,
    sourceHash: hashText(source),
    lines,
    output,
    sessionId,
    entries: { total: lines.length, v1, v2, inserted },
    conversions,
    warnings,
  };
}

/** Describe one conversion without writing anything. */
export function planPresetMigration(file: string): PresetMigrationPlan {
  const prepared = prepare(file);
  return {
    mode: 'plan',
    file: prepared.file,
    sessionId: prepared.sessionId,
    sourceBytes: prepared.stat.size,
    sourceHash: prepared.sourceHash,
    entries: prepared.entries,
    conversions: prepared.conversions,
    changed: prepared.conversions.length > 0,
    warnings: prepared.warnings,
    runtimeValidated: false,
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function restoreCommand(backup: string, target: string): string {
  return `cp -- ${quote(backup)} ${quote(target)}`;
}

/**
 * Whether a managed session record names a live process for this session.
 *
 * Only the one record that names this session is read; nothing is claimed,
 * rewritten or removed. A missing, foreign or malformed record means "not
 * known to be live", which is why the caller must also close Pi.
 */
export function knownLiveSession(sessionId: string | null, socketRoot: string | undefined): { pid: number; record: string } | null {
  if (sessionId === null || socketRoot === undefined) return null;
  const recordFile = join(socketRoot, 'sessions', `${deriveSessionUid(sessionId)}.json`);
  let raw: string;
  try { raw = readFileSync(recordFile, 'utf8'); }
  catch { return null; }
  let record: unknown;
  try { record = JSON.parse(raw); }
  catch { return null; }
  if (!isRecord(record) || record['sessionId'] !== sessionId) return null;
  const pid = record['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return { pid, record: recordFile };
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM' ? { pid, record: recordFile } : null;
  }
}

/**
 * Convert one closed session file in place.
 *
 * The fresh plan is recomputed and compared with the caller's plan, so a session
 * that changed since the preview is refused instead of rewritten. The original
 * bytes are written to a new `wx` backup that is verified before the migrated
 * file is staged, verified and atomically renamed into place.
 */
export function applyPresetMigration(file: string, plan: PresetMigrationPlan): PresetMigrationReport {
  if (plan.file !== file) throw new Error('Migration plan does not describe this session file.');
  const prepared = prepare(file);
  if (prepared.sourceHash !== plan.sourceHash) {
    throw new Error(`Session ${file} changed since it was planned; file left unchanged.`);
  }
  if (prepared.conversions.length === 0) {
    return {
      mode: 'report',
      status: 'unchanged',
      file,
      sessionId: prepared.sessionId,
      backup: null,
      restoreCommand: null,
      sourceBytes: prepared.stat.size,
      sourceHash: prepared.sourceHash,
      targetHash: prepared.sourceHash,
      backupHash: null,
      entries: prepared.entries,
      conversions: [],
      warnings: prepared.warnings,
      runtimeValidated: false,
    };
  }
  const target = prepared.output.join('');
  const targetHash = hashText(target);

  const backup = join(dirname(file), `${basename(file)}.${randomUUID()}.pre-preset-v2`);
  const staged = join(dirname(file), `.${basename(file)}.preset-v2-${randomUUID()}`);
  const writeExclusive = (path: string, text: string): void => {
    const descriptor = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(descriptor, text, 'utf8');
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
  };
  let backupVerified = false;
  let backupHash: string | null = null;
  try {
    writeExclusive(backup, prepared.source);
    backupHash = hashText(readFileSync(backup, 'utf8'));
    if (backupHash !== prepared.sourceHash) throw new Error('backup is not byte-exact with the source');
    chmodSync(backup, 0o400);
    backupVerified = true;
    writeExclusive(staged, target);
    const stagedHash = hashText(readFileSync(staged, 'utf8'));
    if (stagedHash !== targetHash) throw new Error('staged output does not match the planned bytes');
    const before = lstatSync(file);
    if (!sameStat(before, prepared.stat)) throw new Error('source changed while migrating');
    chmodSync(staged, prepared.stat.mode & 0o777);
    renameSync(staged, file);
    if (hashText(readFileSync(file, 'utf8')) !== targetHash) {
      throw new Error(`migrated file does not match the staged output; restore ${file} from ${backup}`);
    }
  } catch (error) {
    rmSync(staged, { force: true });
    // A verified backup is the recovery point and stays; only an unverified one
    // is removed so a failed run never leaves a half-written file behind.
    if (!backupVerified) rmSync(backup, { force: true });
    else (error as { backup?: string }).backup = backup;
    throw error;
  }
  return {
    mode: 'report',
    status: 'applied',
    file,
    sessionId: prepared.sessionId,
    backup,
    restoreCommand: restoreCommand(backup, file),
    sourceBytes: prepared.stat.size,
    sourceHash: prepared.sourceHash,
    targetHash,
    backupHash,
    entries: prepared.entries,
    conversions: prepared.conversions,
    warnings: prepared.warnings,
    runtimeValidated: false,
  };
}
