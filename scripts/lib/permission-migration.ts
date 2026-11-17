/**
 * Offline conversion of retired capability permission records into the current
 * BASE/DYNAMIC/BLACKLIST branch records.
 *
 * The runtime never reads a retired record: this module is the only code that
 * understands the old shapes, and it runs as an explicit offline tool over a
 * closed session file. It converts in place, keeping every native entry ID,
 * parent link, timestamp, blank line and message byte so actor anchors and seed
 * checkpoints keep pointing at the same history.
 *
 * Supported inputs:
 * - `capability-discovery` records carrying the retired flat `manual` grants:
 *   each becomes one `capability-tool-base` add record (enabled -> base).
 * - `capability-tool-permission` canonical entries whose assignments are all
 *   `enabled` (-> base add) or all `disabled` (-> blacklist add). A reset
 *   tombstone or a mixed entry cannot be expressed in one current record and is
 *   refused instead of silently weakening a prohibition.
 *
 * Anything else that mixes retired and current records in one file is refused
 * before a byte is written. The caller owns the backup and concurrent-writer
 * exclusion.
 */

import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TOOL_BASE_RECORD,
  TOOL_BASE_VERSION,
  TOOL_BLACKLIST_RECORD,
  TOOL_BLACKLIST_VERSION,
  TOOL_DYNAMIC_RECORD,
  TOOL_BLACKLIST_NOTICE_RECORD,
} from '../../src/capability/tool-access.ts';
import { parseToolTarget } from '../../src/capability/targets.ts';

/** Retired canonical record this tool converts. */
const LEGACY_PERMISSION_RECORD = 'capability-tool-permission';
/** Retired canonical record version. */
const LEGACY_PERMISSION_VERSION = 1;
/** Retired pre-canonical blacklist record; never convertible. */
const RETIRED_BLACKLIST_RECORD = 'capability-blacklist';

const CURRENT_RECORDS: ReadonlySet<string> = new Set([
  TOOL_BASE_RECORD,
  TOOL_DYNAMIC_RECORD,
  TOOL_BLACKLIST_RECORD,
  TOOL_BLACKLIST_NOTICE_RECORD,
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface LegacyAssignment {
  readonly target: string;
  readonly state: 'enabled' | 'disabled';
}

interface LegacyMutation {
  readonly set: readonly LegacyAssignment[];
  readonly unset: readonly string[];
}

function legacyMutation(value: unknown): LegacyMutation | null {
  if (!record(value) || value['version'] !== LEGACY_PERMISSION_VERSION) return null;
  const set: LegacyAssignment[] = [];
  if (Array.isArray(value['set'])) {
    for (const raw of value['set']) {
      if (!record(raw)) continue;
      const target = typeof raw['target'] === 'string' ? raw['target'].trim() : '';
      const state = raw['state'];
      if (target === '' || (state !== 'enabled' && state !== 'disabled')) continue;
      set.push({ target, state });
    }
  }
  const unset = Array.isArray(value['unset'])
    ? value['unset'].filter((target): target is string => typeof target === 'string' && target.trim() !== '')
    : [];
  return { set, unset };
}

function currentPayload(customType: string, targets: readonly string[]): Record<string, unknown> {
  return customType === TOOL_BLACKLIST_RECORD
    ? { version: TOOL_BLACKLIST_VERSION, add: [...targets] }
    : { version: TOOL_BASE_VERSION, add: [...targets] };
}

function withEnding(raw: string, entry: unknown): string {
  const ending = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
  return JSON.stringify(entry) + ending;
}

/**
 * Convert one closed session file. Returns false when there is nothing to
 * convert; throws before writing when any record is unsupported.
 */
export function migrateSessionFile(file: string): boolean {
  const sourceStat = lstatSync(file);
  if (!sourceStat.isFile()) throw new Error('Migration requires a regular session file.');
  const source = readFileSync(file, 'utf8');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let headerSeen = false;
  let hasCurrent = false;
  let converted = 0;
  const output = lines.map((raw, index) => {
    if (raw.trim() === '') return raw;
    const fail = (message: string): never => {
      throw new Error(`Session ${file}:${index + 1}: ${message}; file left unchanged.`);
    };
    let entry: unknown;
    try { entry = JSON.parse(raw); }
    catch { return fail('invalid JSON'); }
    if (!record(entry)) return fail('expected a native session entry');
    if (!headerSeen) {
      if (entry['type'] !== 'session' || entry['version'] !== 3) return fail('expected a v3 session header');
      headerSeen = true;
      return raw;
    }
    if (entry['type'] !== 'custom') return raw;
    const customType = entry['customType'];
    if (typeof customType === 'string' && CURRENT_RECORDS.has(customType)) {
      hasCurrent = true;
      return raw;
    }
    if (customType === RETIRED_BLACKLIST_RECORD) return fail('unsupported capability-blacklist record');
    if (customType === LEGACY_PERMISSION_RECORD) {
      const mutation = legacyMutation(entry['data']);
      if (mutation === null) return raw;
      if (mutation.unset.length > 0) {
        return fail('unsupported reset tombstone in a retired permission record; convert it manually');
      }
      if (mutation.set.length === 0) return raw;
      const states = new Set(mutation.set.map((item) => item.state));
      if (states.size > 1) return fail('unsupported mixed enabled/disabled retired permission record');
      for (const item of mutation.set) {
        const parsed = parseToolTarget(item.target);
        if (parsed === null) return fail('unsupported permission target');
        if (item.state === 'enabled' && parsed.kind !== 'tool') {
          return fail('enabled group or prefix requires a live member catalog; convert it manually');
        }
      }
      const target = states.has('enabled') ? TOOL_BASE_RECORD : TOOL_BLACKLIST_RECORD;
      converted += 1;
      return withEnding(raw, {
        ...entry,
        customType: target,
        data: currentPayload(target, mutation.set.map((item) => item.target)),
      });
    }
    if (customType !== 'capability-discovery') return raw;
    const data = entry['data'];
    const result = record(data) ? data['result'] : undefined;
    if (!record(result) || !Object.hasOwn(result, 'manual')) return raw;
    if (!record(data) || data['version'] !== 1 || !Array.isArray(result['manual'])) return fail('unsupported manual record version or shape');
    if (result['manual'].length === 0) return raw;
    for (const category of ['tools', 'mcp', 'skills', 'guidance']) {
      const hits = result[category];
      if (hits !== undefined && (!Array.isArray(hits) || hits.length > 0)) return fail('unsupported mixed capability-discovery record');
    }
    const targets = new Set<string>();
    for (const hit of result['manual']) {
      if (!record(hit) || hit['tools'] !== undefined) return fail('unsupported group manual hit');
      const name = hit['name'];
      if (typeof name !== 'string' || name.trim() !== name) return fail('unsupported manual target');
      if (parseToolTarget(name)?.kind !== 'tool') return fail('unsupported manual target');
      if (hit['status'] !== undefined && hit['status'] !== 'available') return fail('unsupported manual hit status');
      targets.add(name);
    }
    converted += 1;
    return withEnding(raw, {
      ...entry,
      customType: TOOL_BASE_RECORD,
      data: currentPayload(TOOL_BASE_RECORD, [...targets]),
    });
  });
  if (converted === 0) return false;
  if (hasCurrent) {
    throw new Error(`Session ${file}: current capability records coexist with retired permission records; file left unchanged.`);
  }

  const temporary = join(dirname(file), `.${basename(file)}.migrating-${randomUUID()}`);
  const descriptor = openSync(temporary, 'wx', sourceStat.mode & 0o777);
  try {
    try {
      writeFileSync(descriptor, output.join(''), 'utf8');
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return true;
}
