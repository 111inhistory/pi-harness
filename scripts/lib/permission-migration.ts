/** Offline conversion of flat manual-only records, preserving native checkpoints. */
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CAPABILITY_TOOL_PERMISSION_RECORD } from '../../src/capability/tool-permission.ts';
import { parseToolPermissionTarget } from '../../src/capability/manual-tools.ts';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Convert closed v3 session files containing only flat legacy manual grants.
 * Keep entry IDs, parents, timestamps and every unrelated byte unchanged, so
 * actor anchors and seed checkpoints see the converted rules without rebasing.
 * Refuse unsupported mixtures before writing; this is not a general legacy
 * rule translator. The caller owns backup and exclusion of concurrent writers.
 */
export function migrateSessionFile(file: string): boolean {
  const sourceStat = lstatSync(file);
  if (!sourceStat.isFile()) throw new Error('Migration requires a regular session file.');
  const source = readFileSync(file, 'utf8');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let headerSeen = false;
  let hasCanonical = false;
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
    if (entry['customType'] === 'capability-blacklist') return fail('unsupported capability-blacklist record');
    if (entry['customType'] === CAPABILITY_TOOL_PERMISSION_RECORD) {
      hasCanonical = true;
      return raw;
    }
    if (entry['customType'] !== 'capability-discovery') return raw;
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
      const target = parseToolPermissionTarget(name);
      if (target?.kind !== 'tool') return fail('unsupported manual target');
      if (hit['status'] !== undefined && hit['status'] !== 'available') return fail('unsupported manual hit status');
      targets.add(name);
    }
    converted += 1;
    const ending = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
    return JSON.stringify({ ...entry, customType: CAPABILITY_TOOL_PERMISSION_RECORD,
      data: { version: 1, set: [...targets].map(target => ({ target, state: 'enabled' })) } }) + ending;
  });
  if (converted === 0) return false;
  if (hasCanonical) throw new Error('Unsupported pre-existing canonical capability-tool-permission records alongside legacy manual grants; file left unchanged.');

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
