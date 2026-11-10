/**
 * One-time, explicit offline migration of retired permission formats.
 *
 * `capability-blacklist` and the old `capability-discovery` manual list are
 * read while the session is closed, converted into canonical
 * `capability-tool-permission` entries, and then never consulted at runtime.
 * A marker makes the migration idempotent; a child that inherits the marker
 * does not migrate again. A canonical entry that already exists wins over the
 * legacy value for the same target id.
 */

import {
  CAPABILITY_TOOL_PERMISSION_RECORD,
  CAPABILITY_TOOL_PERMISSION_VERSION,
  type ToolPermissionManagedState,
} from '../../src/capability/tool-permission.ts';
import { parseToolPermissionTarget } from '../../src/capability/manual-tools.ts';

export const CAPABILITY_PERMISSION_MIGRATION_RECORD = 'capability-tool-permission-migration';
export const CAPABILITY_PERMISSION_MIGRATION_VERSION = 1;

const BLACKLIST_RECORD = 'capability-blacklist';
const DISCOVERY_RECORD = 'capability-discovery';

export interface MigrationWriter {
  appendEntry(customType: string, data?: unknown): void;
}

interface MigrationEntry {
  readonly target: string;
  readonly state: ToolPermissionManagedState;
  readonly id: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function targetText(value: UnknownRecord): string | null {
  if (typeof value['target'] === 'string' && value['target'].trim() !== '') return value['target'].trim();
  const kind = value['kind'];
  const name = value['name'];
  if (typeof name !== 'string' || name === '') return null;
  if (kind === 'mcp') return `mcp://${name}`;
  if (kind === 'namespace') return `namespace://${name}`;
  if (kind === 'tool') return name;
  return null;
}

function hasMigrationMarker(branch: readonly unknown[] | null | undefined): boolean {
  for (const entry of branch ?? []) {
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== CAPABILITY_PERMISSION_MIGRATION_RECORD) {
      continue;
    }
    const data = entry['data'];
    if (isRecord(data) && data['version'] === CAPABILITY_PERMISSION_MIGRATION_VERSION) return true;
  }
  return false;
}

/** Canonical ids this branch already sets or unsets; migration must not touch them. */
function canonicalPermissionIds(branch: readonly unknown[] | null | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of branch ?? []) {
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== CAPABILITY_TOOL_PERMISSION_RECORD) continue;
    const data = entry['data'];
    if (!isRecord(data) || data['version'] !== CAPABILITY_TOOL_PERMISSION_VERSION) continue;
    if (Array.isArray(data['unset'])) {
      for (const target of data['unset']) {
        if (typeof target === 'string' && target.trim() !== '') {
          const parsed = parseToolPermissionTarget(target);
          if (parsed !== null) ids.add(parsed.id);
        }
      }
    }
    if (Array.isArray(data['set'])) {
      for (const item of data['set']) {
        if (!isRecord(item)) continue;
        const state = item['state'];
        if (state !== 'enabled' && state !== 'disabled') continue;
        const rawTarget = typeof item['target'] === 'string' ? item['target'].trim() : '';
        if (rawTarget === '') continue;
        const parsed = parseToolPermissionTarget(rawTarget);
        if (parsed !== null) ids.add(parsed.id);
      }
    }
  }
  return ids;
}

function legacyBlacklist(branch: readonly unknown[] | null | undefined): Map<string, MigrationEntry> {
  const rules = new Map<string, { target: string; id: string }>();
  for (const entry of branch ?? []) {
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== BLACKLIST_RECORD) continue;
    const data = entry['data'];
    if (!isRecord(data) || data['version'] !== 1) continue;
    if (Array.isArray(data['removed'])) {
      for (const id of data['removed']) if (typeof id === 'string') rules.delete(id);
    }
    if (Array.isArray(data['added'])) {
      for (const raw of data['added']) {
        if (!isRecord(raw)) continue;
        const target = targetText(raw);
        if (target === null) continue;
        const parsed = parseToolPermissionTarget(target);
        if (parsed === null) continue;
        rules.set(parsed.id, { target: parsed.target, id: parsed.id });
      }
    }
  }
  return new Map([...rules.values()].map(({ target, id }) => [id, { target, id, state: 'disabled' }]));
}

function legacyManual(branch: readonly unknown[] | null | undefined): Map<string, MigrationEntry> {
  const names = new Set<string>();
  for (const entry of branch ?? []) {
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== DISCOVERY_RECORD) continue;
    const data = entry['data'];
    if (!isRecord(data)) continue;
    const result = data['result'];
    if (!isRecord(result) || !Array.isArray(result['manual'])) continue;
    for (const hit of result['manual']) {
      if (!isRecord(hit)) continue;
      const members = Array.isArray(hit['tools']) ? hit['tools'] : [hit];
      for (const member of members) {
        if (isRecord(member) && typeof member['name'] === 'string' && member['name'] !== '') {
          names.add(member['name']);
        }
      }
    }
  }
  const entries = new Map<string, MigrationEntry>();
  for (const name of names) {
    const parsed = parseToolPermissionTarget(name);
    if (parsed !== null) entries.set(parsed.id, { target: parsed.target, id: parsed.id, state: 'enabled' });
  }
  return entries;
}

/**
 * Append canonical permission entries for any legacy records on this branch.
 *
 * Returns true when this call wrote the marker (the branch had no marker yet).
 * An empty legacy set still writes the marker, so inherited branches never
 * retry the scan.
 */
export function migrateLegacyPermissions(
  writer: MigrationWriter,
  branch: readonly unknown[] | null | undefined,
): boolean {
  if (hasMigrationMarker(branch)) return false;
  const canonical = canonicalPermissionIds(branch);
  const merged = new Map<string, MigrationEntry>();
  for (const [id, entry] of legacyManual(branch)) {
    if (!canonical.has(id)) merged.set(id, entry);
  }
  // A legacy disabled rule wins over a legacy manual grant for the same id.
  for (const [id, entry] of legacyBlacklist(branch)) {
    if (!canonical.has(id)) merged.set(id, entry);
  }
  if (merged.size > 0) {
    writer.appendEntry(CAPABILITY_TOOL_PERMISSION_RECORD, {
      version: CAPABILITY_TOOL_PERMISSION_VERSION,
      set: [...merged.values()].map((entry) => ({ target: entry.target, state: entry.state })),
    });
  }
  writer.appendEntry(CAPABILITY_PERMISSION_MIGRATION_RECORD, {
    version: CAPABILITY_PERMISSION_MIGRATION_VERSION,
  });
  return true;
}
