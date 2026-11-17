/**
 * Durable replay of the tool-availability branch records.
 *
 * Membership is CONCRETE tool names; containers (namespace/MCP metadata) are
 * remembered separately in the same record so one user operation is one durable
 * entry. Blacklist remains an independent target-rule union.
 *
 * No registry, scope view or SDK effect is read here: the write side and the
 * read view both build on this replay.
 */

import { CAPABILITY_DISCOVERY_RECORD, CAPABILITY_DISCOVERY_RECORD_VERSION, CAPABILITY_PRUNE_RECORD, CAPABILITY_PRUNE_RECORD_VERSION } from './discovery-record.ts';
import { capabilityStartupBlacklist } from './scope.ts';
import { parseToolTarget, type ToolTarget, type ToolTargetRecord } from './targets.ts';
import { PRESET_STATE_RECORD, restorePresetSnapshot } from '../preset/state.ts';

/** `customType` of the base membership record. */
export const TOOL_BASE_RECORD = 'capability-tool-base';
export const TOOL_BASE_VERSION = 1;
/** `customType` of the dynamic activation record. */
export const TOOL_DYNAMIC_RECORD = 'capability-tool-dynamic';
export const TOOL_DYNAMIC_VERSION = 1;
/** `customType` of the blacklist record. */
export const TOOL_BLACKLIST_RECORD = 'capability-tool-blacklist';
export const TOOL_BLACKLIST_VERSION = 1;
/** `customType` of one model-facing "now blacklisted" notice. */
export const TOOL_BLACKLIST_NOTICE_RECORD = 'capability-tool-blacklist-notice';
export const TOOL_BLACKLIST_NOTICE_VERSION = 1;

/** Where a base membership/load currently comes from. */
export type ToolBaseSource = 'baseline' | 'preset' | 'branch';
/** Where dynamic membership/load currently comes from. */
export type ToolDynamicSource = 'discovery' | 'activation' | 'branch';
/** Which lifetime currently prohibits a name. */
export type ToolBlacklistSource = 'startup' | 'preset' | 'branch';
/** Explicit per-tool schema mode; the latest record for a name wins. */
export type ToolSchemaMode = 'no-schema' | 'schema';

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export interface Contribution<TSource extends string> {
  readonly target: ToolTarget;
  readonly sources: Set<TSource>;
}

type ActionMap = Map<string, 'add' | 'remove' | 'activate' | 'deactivate'>;

export interface AccessState {
  /** Concrete base/dynamic membership by tool name. */
  readonly base: Map<string, Set<ToolBaseSource>>;
  readonly dynamic: Map<string, Set<ToolDynamicSource>>;
  /** Loaded container metadata, keyed by canonical container id. */
  readonly baseLoads: Map<string, Contribution<ToolBaseSource>>;
  readonly dynamicLoads: Map<string, Contribution<ToolDynamicSource>>;
  readonly baseActions: ActionMap;
  readonly dynamicActions: ActionMap;
  readonly blacklist: Map<string, Contribution<ToolBlacklistSource>>;
  readonly blacklistActions: ActionMap;
  baselineRecorded: boolean;
  /** Latest explicit schema mode per concrete tool name. */
  readonly schemaModes: Map<string, ToolSchemaMode>;
  /** Targets named by a removal intent (base remove / deactivate / blacklist add). */
  readonly removalIntents: ToolTarget[];
}

function addName<T>(entries: Map<string, Set<T>>, name: string, source: T): void {
  const sources = entries.get(name);
  if (sources === undefined) entries.set(name, new Set([source]));
  else sources.add(source);
}

function addSource<TSource extends string>(entries: Map<string, Contribution<TSource>>, target: ToolTarget, source: TSource): void {
  const existing = entries.get(target.id);
  if (existing === undefined) entries.set(target.id, { target, sources: new Set([source]) });
  else existing.sources.add(source);
}

function dropSource<TSource extends string>(entries: Map<string, Contribution<TSource>>, id: string, source: TSource): void {
  const existing = entries.get(id);
  if (existing === undefined) return;
  existing.sources.delete(source);
  if (existing.sources.size === 0) entries.delete(id);
}

export function parseBaseRecord(data: unknown): {
  baseline: readonly string[];
  load: readonly string[];
  add: readonly string[];
  remove: readonly string[];
  noSchema: readonly string[];
  schema: readonly string[];
} | null {
  if (!isRecord(data) || data['version'] !== TOOL_BASE_VERSION) return null;
  return {
    baseline: strings(data['baseline']), load: strings(data['load']), add: strings(data['add']), remove: strings(data['remove']),
    noSchema: strings(data['noSchema']), schema: strings(data['schema']),
  };
}

export function parseDynamicRecord(data: unknown): {
  load: readonly string[];
  activate: readonly string[];
  deactivate: readonly string[];
  noSchema: readonly string[];
  schema: readonly string[];
} | null {
  if (!isRecord(data) || data['version'] !== TOOL_DYNAMIC_VERSION) return null;
  return {
    load: strings(data['load']), activate: strings(data['activate']), deactivate: strings(data['deactivate']),
    noSchema: strings(data['noSchema']), schema: strings(data['schema']),
  };
}

export function parseBlacklistRecord(data: unknown): { add: readonly string[]; remove: readonly string[] } | null {
  if (!isRecord(data) || data['version'] !== TOOL_BLACKLIST_VERSION) return null;
  return { add: strings(data['add']), remove: strings(data['remove']) };
}

/** Selected tool names of one discovery record. */
function discoverySelectedNames(data: unknown): readonly string[] | null {
  if (!isRecord(data) || data['version'] !== CAPABILITY_DISCOVERY_RECORD_VERSION) return null;
  const result = data['result'];
  if (!isRecord(result)) return null;
  const names: string[] = [];
  for (const category of ['tools', 'mcp'] as const) {
    const hits = result[category];
    if (!Array.isArray(hits)) continue;
    for (const hit of hits) {
      if (!isRecord(hit)) continue;
      const status = hit['status'];
      if (typeof status === 'string' && status !== 'available') continue;
      const members = Array.isArray(hit['tools']) ? hit['tools'] : [hit];
      for (const member of members) {
        if (!isRecord(member)) continue;
        const memberStatus = member['status'];
        if (typeof memberStatus === 'string' && memberStatus !== 'available') continue;
        const name = stringValue(member['name']);
        if (name !== null) names.push(name);
      }
    }
  }
  return names;
}

function prunedNames(data: unknown): readonly string[] | null {
  if (!isRecord(data) || data['version'] !== CAPABILITY_PRUNE_RECORD_VERSION) return null;
  return strings(data['removedTools']);
}

function applyLoads<T extends string>(
  loads: Map<string, Contribution<T>>,
  raw: readonly string[],
  source: T,
): void {
  for (const item of raw) {
    const target = parseToolTarget(item);
    if (target === null || (target.kind !== 'namespace' && target.kind !== 'mcp')) continue;
    addSource(loads, target, source);
  }
}

function applyPresetEntry(state: AccessState, entry: UnknownRecord): void {
  const snapshot = restorePresetSnapshot([entry]);
  if (snapshot === null) {
    // Clearing ends the preset blacklist lifetime but keeps the applied
    // availability selection as session base.
    for (const sources of state.base.values()) {
      if (!sources.has('preset')) continue;
      sources.delete('preset');
      sources.add('branch');
    }
    for (const contribution of [...state.blacklist.values()]) {
      if (contribution.sources.has('preset')) dropSource(state.blacklist, contribution.target.id, 'preset');
    }
    return;
  }
  if (snapshot.tools !== undefined) {
    state.base.clear();
    state.baseActions.clear();
    for (const name of snapshot.tools) addName(state.base, name, 'preset');
  }
  for (const contribution of [...state.blacklist.values()]) {
    if (contribution.sources.has('preset')) dropSource(state.blacklist, contribution.target.id, 'preset');
  }
  for (const raw of snapshot.disabledTools ?? []) {
    const target = parseToolTarget(raw);
    if (target !== null) addSource(state.blacklist, target, 'preset');
  }
}

/** Replay the branch into the effective collections. */
export function replay(host: { getAllTools(): readonly ToolTargetRecord[] }, branch: readonly unknown[] | null | undefined): AccessState {
  const state: AccessState = {
    base: new Map(), dynamic: new Map(),
    baseLoads: new Map(), dynamicLoads: new Map(),
    baseActions: new Map(), dynamicActions: new Map(),
    blacklist: new Map(), blacklistActions: new Map(),
    baselineRecorded: false, schemaModes: new Map(), removalIntents: [],
  };
  for (const raw of capabilityStartupBlacklist(host)) {
    const target = parseToolTarget(raw);
    if (target !== null) addSource(state.blacklist, target, 'startup');
  }
  for (const entry of branch ?? []) {
    if (!isRecord(entry) || entry['type'] !== 'custom') continue;
    const customType = entry['customType'];
    const data = entry['data'];
    if (customType === TOOL_BASE_RECORD) {
      const record = parseBaseRecord(data);
      if (record === null) continue;
      if (isRecord(data) && Array.isArray(data['baseline'])) state.baselineRecorded = true;
      for (const name of record.baseline) addName(state.base, name, 'baseline');
      applyLoads(state.baseLoads, record.load, isRecord(data) && Array.isArray(data['baseline']) ? 'baseline' : 'branch');
      for (const name of record.add) {
        state.baseActions.set(`tool:${name}`, 'add');
        addName(state.base, name, 'branch');
      }
      for (const name of record.noSchema) state.schemaModes.set(name, 'no-schema');
      for (const name of record.schema) state.schemaModes.set(name, 'schema');
      for (const name of record.remove) {
        state.baseActions.set(`tool:${name}`, 'remove');
        state.base.delete(name);
        state.removalIntents.push({ target: name, kind: 'tool', name, id: `tool:${name}` });
      }
      continue;
    }
    if (customType === TOOL_DYNAMIC_RECORD) {
      const record = parseDynamicRecord(data);
      if (record === null) continue;
      applyLoads(state.dynamicLoads, record.load, 'branch');
      for (const name of record.activate) {
        state.dynamicActions.set(`tool:${name}`, 'activate');
        addName(state.dynamic, name, 'branch');
      }
      for (const name of record.noSchema) state.schemaModes.set(name, 'no-schema');
      for (const name of record.schema) state.schemaModes.set(name, 'schema');
      for (const name of record.deactivate) {
        state.dynamicActions.set(`tool:${name}`, 'deactivate');
        state.dynamic.delete(name);
        state.removalIntents.push({ target: name, kind: 'tool', name, id: `tool:${name}` });
      }
      continue;
    }
    if (customType === TOOL_BLACKLIST_RECORD) {
      const record = parseBlacklistRecord(data);
      if (record === null) continue;
      for (const raw of record.add) {
        const target = parseToolTarget(raw);
        if (target === null) continue;
        state.blacklistActions.set(target.id, 'add');
        addSource(state.blacklist, target, 'branch');
        state.removalIntents.push(target);
      }
      for (const raw of record.remove) {
        const target = parseToolTarget(raw);
        if (target === null) continue;
        state.blacklistActions.set(target.id, 'remove');
        // A remove clears the branch and matching startup target id only. The
        // current preset keeps its own lifetime and SDK bans are not ours.
        dropSource(state.blacklist, target.id, 'branch');
        dropSource(state.blacklist, target.id, 'startup');
      }
      continue;
    }
    if (customType === PRESET_STATE_RECORD) { applyPresetEntry(state, entry); continue; }
    if (customType === CAPABILITY_DISCOVERY_RECORD) {
      for (const name of discoverySelectedNames(data) ?? []) addName(state.dynamic, name, 'discovery');
      continue;
    }
    if (customType === CAPABILITY_PRUNE_RECORD) {
      for (const name of prunedNames(data) ?? []) state.dynamic.delete(name);
    }
  }
  return state;
}

/** The recorded availability baseline names, without capturing or writing. */
export function sessionBaseNames(branch: readonly unknown[] | null | undefined): readonly string[] {
  const names: string[] = [];
  for (const entry of branch ?? []) {
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== TOOL_BASE_RECORD) continue;
    const record = parseBaseRecord(entry['data']);
    if (record === null) continue;
    for (const name of record.baseline) if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Recorded baseline container loads, without capturing or writing. */
export function sessionBaseLoads(branch: readonly unknown[] | null | undefined): readonly string[] {
  const refs: string[] = [];
  for (const entry of branch ?? []) {
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== TOOL_BASE_RECORD) continue;
    const record = parseBaseRecord(entry['data']);
    if (record === null) continue;
    for (const ref of record.load) if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}
