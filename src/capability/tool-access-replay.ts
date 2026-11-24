/**
 * Durable replay of the tool-availability branch records.
 *
 * Membership is CONCRETE tool names; containers (namespace/MCP metadata) are
 * remembered separately in the same record so one user operation is one durable
 * entry. Blacklist remains an independent target-rule union.
 *
 * The effective base membership is layered, highest wins last:
 *
 * 1. the effective baseline (the captured `capability-tool-base` baseline plus
 *    every permanent `baselineAdditions` increment a preset recorded),
 * 2. the latest preset snapshot's normalized selection (`replace` replaces the
 *    baseline layer, `modifiers` fold over it),
 * 3. the user's manual `/capability base add|remove` records, which always win
 *    over the preset layer regardless of branch order and are never cleared by a
 *    preset switch, upgrade or clear.
 *
 * A preset's `disabledTools` is a preset-lifetime blacklist contribution, not a
 * durable ban; the hard fences (startup/ancestor and manual blacklist) stay in
 * the blacklist union and are never bypassed by a preset.
 *
 * No registry, scope view or SDK effect is read here: the write side and the
 * read view both build on this replay.
 */

import { CAPABILITY_DISCOVERY_RECORD, CAPABILITY_DISCOVERY_RECORD_VERSION, CAPABILITY_PRUNE_RECORD, CAPABILITY_PRUNE_RECORD_VERSION } from './discovery-record.ts';
import { capabilityStartupBlacklist } from './scope.ts';
import { parseToolTarget, type ToolTarget, type ToolTargetRecord } from './targets.ts';
import { presetBaselineAdditions, readPresetState, type PresetToolSelection } from '../preset/state.ts';

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

/** The current preset's tool contribution as replayed against the baseline. */
export interface PresetToolLayer {
  readonly name: string | null;
  /** Normalized intent, or null when no preset is active. */
  readonly selection: PresetToolSelection | null;
  /** Effective-baseline names the current preset excludes. */
  readonly excluded: readonly string[];
  /** Preset-excluded names the manual base layer keeps instead. */
  readonly retained: readonly string[];
}

export interface AccessState {
  /** Effective base membership (baseline → preset → manual) by tool name. */
  readonly base: Map<string, Set<ToolBaseSource>>;
  readonly dynamic: Map<string, Set<ToolDynamicSource>>;
  /** Loaded container metadata, keyed by canonical container id. */
  readonly baseLoads: Map<string, Contribution<ToolBaseSource>>;
  readonly dynamicLoads: Map<string, Contribution<ToolDynamicSource>>;
  /** Manual base actions only; a preset selection never writes this map. */
  readonly baseActions: ActionMap;
  readonly dynamicActions: ActionMap;
  readonly blacklist: Map<string, Contribution<ToolBlacklistSource>>;
  readonly blacklistActions: ActionMap;
  baselineRecorded: boolean;
  /** Latest explicit schema mode per concrete tool name. */
  readonly schemaModes: Map<string, ToolSchemaMode>;
  /** Targets named by a removal intent (base remove / deactivate / blacklist add). */
  readonly removalIntents: ToolTarget[];
  /** Effective baseline layer: captured baseline ∪ permanent preset additions. */
  readonly baseline: ReadonlySet<string>;
  /** Base members an explicit selection put there (manual add, preset add/replace). */
  readonly explicitBase: ReadonlySet<string>;
  readonly preset: PresetToolLayer;
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

/**
 * Fold the preset layer onto the effective baseline.
 *
 * `replace` replaces the baseline layer only and `modifiers` add or subtract on
 * it; the manual layer is folded afterwards, so neither form can erase a manual
 * member. Every name the preset tries to exclude is a candidate for the removal
 * intent; the manual layer can keep it (`retained`, reported to the apply
 * notice), and only a still-absent name becomes an effective exclusion that a
 * successful compaction may drop.
 *
 * `explicitBase` is the subset an explicit selection put there: a manual base
 * add or the current preset's add/replace. Baseline membership and permanent
 * increments are deliberately not explicit, so they never lift a local ban.
 */
function foldPresetLayer(
  baseline: ReadonlySet<string>,
  selection: PresetToolSelection | null,
  manual: ReadonlyMap<string, 'add' | 'remove'>,
): {
  readonly base: Map<string, Set<ToolBaseSource>>;
  readonly explicitBase: ReadonlySet<string>;
  readonly excluded: readonly string[];
  readonly retained: readonly string[];
} {
  const base = new Map<string, Set<ToolBaseSource>>();
  const explicitBase = new Set<string>();
  for (const name of baseline) addName(base, name, 'baseline');
  /** Every name the preset intends to exclude from the layer below it. */
  const intent: string[] = [];
  if (selection !== null && selection.kind === 'replace') {
    const selected = new Set(selection.names);
    for (const name of baseline) if (!selected.has(name)) intent.push(name);
    base.clear();
    for (const name of selection.names) {
      addName(base, name, 'preset');
      explicitBase.add(name);
    }
  } else if (selection !== null && selection.kind === 'modifiers') {
    for (const name of selection.add) {
      addName(base, name, 'preset');
      explicitBase.add(name);
    }
    for (const name of selection.remove) {
      intent.push(name);
      base.delete(name);
    }
  }
  for (const [name, action] of manual) {
    if (action === 'add') {
      addName(base, name, 'branch');
      explicitBase.add(name);
    } else {
      base.delete(name);
      explicitBase.delete(name);
    }
  }
  // A name the preset removes can be kept by the manual layer even when the
  // baseline never contained it (a manual member added earlier).
  const retained = intent.filter((name) => base.has(name));
  const kept = new Set(retained);
  return {
    base,
    explicitBase,
    excluded: intent.filter((name) => !kept.has(name)),
    retained,
  };
}

/** Replay the branch into the effective collections. */
export function replay(host: { getAllTools(): readonly ToolTargetRecord[] }, branch: readonly unknown[] | null | undefined): AccessState {
  const baseLoads = new Map<string, Contribution<ToolBaseSource>>();
  const dynamicLoads = new Map<string, Contribution<ToolDynamicSource>>();
  const baseActions: ActionMap = new Map();
  const dynamicActions: ActionMap = new Map();
  const blacklist = new Map<string, Contribution<ToolBlacklistSource>>();
  const blacklistActions: ActionMap = new Map();
  const schemaModes = new Map<string, ToolSchemaMode>();
  const removalIntents: ToolTarget[] = [];
  const baseline = new Set<string>();
  /** Latest manual base action per name; the layer itself is order independent. */
  const manualBase = new Map<string, 'add' | 'remove'>();
  const dynamic = new Map<string, Set<ToolDynamicSource>>();
  let baselineRecorded = false;

  for (const raw of capabilityStartupBlacklist(host)) {
    const target = parseToolTarget(raw);
    if (target !== null) addSource(blacklist, target, 'startup');
  }
  for (const entry of branch ?? []) {
    if (!isRecord(entry) || entry['type'] !== 'custom') continue;
    const customType = entry['customType'];
    const data = entry['data'];
    if (customType === TOOL_BASE_RECORD) {
      const record = parseBaseRecord(data);
      if (record === null) continue;
      const isBaseline = isRecord(data) && Array.isArray(data['baseline']);
      if (isBaseline) baselineRecorded = true;
      if (isBaseline) {
        for (const name of record.baseline) baseline.add(name);
      }
      applyLoads(baseLoads, record.load, isBaseline ? 'baseline' : 'branch');
      for (const name of record.add) {
        baseActions.set(`tool:${name}`, 'add');
        manualBase.set(name, 'add');
      }
      for (const name of record.noSchema) schemaModes.set(name, 'no-schema');
      for (const name of record.schema) schemaModes.set(name, 'schema');
      for (const name of record.remove) {
        baseActions.set(`tool:${name}`, 'remove');
        manualBase.set(name, 'remove');
        removalIntents.push({ target: name, kind: 'tool', name, id: `tool:${name}` });
      }
      continue;
    }
    if (customType === TOOL_DYNAMIC_RECORD) {
      const record = parseDynamicRecord(data);
      if (record === null) continue;
      applyLoads(dynamicLoads, record.load, 'branch');
      for (const name of record.activate) {
        dynamicActions.set(`tool:${name}`, 'activate');
        addName(dynamic, name, 'branch');
      }
      for (const name of record.noSchema) schemaModes.set(name, 'no-schema');
      for (const name of record.schema) schemaModes.set(name, 'schema');
      for (const name of record.deactivate) {
        dynamicActions.set(`tool:${name}`, 'deactivate');
        dynamic.delete(name);
        removalIntents.push({ target: name, kind: 'tool', name, id: `tool:${name}` });
      }
      continue;
    }
    if (customType === TOOL_BLACKLIST_RECORD) {
      const record = parseBlacklistRecord(data);
      if (record === null) continue;
      for (const raw of record.add) {
        const target = parseToolTarget(raw);
        if (target === null) continue;
        blacklistActions.set(target.id, 'add');
        addSource(blacklist, target, 'branch');
        removalIntents.push(target);
      }
      for (const raw of record.remove) {
        const target = parseToolTarget(raw);
        if (target === null) continue;
        blacklistActions.set(target.id, 'remove');
        // A remove clears the branch and matching startup target id only. The
        // current preset keeps its own lifetime and SDK bans are not ours.
        dropSource(blacklist, target.id, 'branch');
        dropSource(blacklist, target.id, 'startup');
      }
      continue;
    }
    if (customType === CAPABILITY_DISCOVERY_RECORD) {
      for (const name of discoverySelectedNames(data) ?? []) addName(dynamic, name, 'discovery');
      continue;
    }
    if (customType === CAPABILITY_PRUNE_RECORD) {
      for (const name of prunedNames(data) ?? []) dynamic.delete(name);
    }
  }

  // Fold the latest selection over the captured baseline and committed upgrades.
  // The stored name projection is only used for comparison and compaction.
  const snapshot = readPresetState(branch)?.snapshot ?? null;
  for (const name of presetBaselineAdditions(branch)) baseline.add(name);
  const selection = snapshot?.toolSelection ?? null;
  const folded = foldPresetLayer(baseline, selection, manualBase);
  for (const name of folded.excluded) removalIntents.push({ target: name, kind: 'tool', name, id: `tool:${name}` });
  if (snapshot !== null) {
    for (const raw of snapshot.disabledTools ?? []) {
      const target = parseToolTarget(raw);
      if (target !== null) addSource(blacklist, target, 'preset');
    }
  }

  return {
    base: folded.base,
    dynamic,
    baseLoads,
    dynamicLoads,
    baseActions,
    dynamicActions,
    blacklist,
    blacklistActions,
    baselineRecorded,
    schemaModes,
    removalIntents,
    baseline,
    explicitBase: folded.explicitBase,
    preset: {
      name: snapshot?.name ?? null,
      selection,
      excluded: folded.excluded,
      retained: folded.retained,
    },
  };
}

/**
 * The recorded `capability-tool-base` baseline, without capturing or writing.
 *
 * `recorded` stays true for an explicitly EMPTY baseline (`tools: []` /
 * `--no-tools`), so callers can distinguish "recorded empty" from "never
 * captured" instead of testing the name count.
 */
export function recordedBaseBaseline(branch: readonly unknown[] | null | undefined): {
  readonly recorded: boolean;
  readonly names: readonly string[];
} {
  const names = new Set<string>();
  let recorded = false;
  for (const entry of branch ?? []) {
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== TOOL_BASE_RECORD) continue;
    const record = parseBaseRecord(entry['data']);
    if (record === null || !isRecord(entry['data']) || !Array.isArray(entry['data']['baseline'])) continue;
    recorded = true;
    for (const name of record.baseline) names.add(name);
  }
  return { recorded, names: [...names] };
}

/** The recorded baseline names plus permanent preset increments, without writing. */
export function sessionBaseNames(branch: readonly unknown[] | null | undefined): readonly string[] {
  return [...new Set([...recordedBaseBaseline(branch).names, ...presetBaselineAdditions(branch)])];
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
