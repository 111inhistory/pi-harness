/**
 * Three-state tool permissions: explicitly enabled, explicitly disabled, or
 * unmanaged (the tool's own activation state decides active/inactive).
 *
 * This replaces the old separate manual-restriction and blacklist mechanisms
 * with one append-only branch memory:
 *
 * - `capability-tool-permission` custom entries carry `{ target, state }`
 *   assignments (and `unset` tombstones for reset). Replay is append-only; no
 *   history is rewritten.
 * - Old formats are converted only by the explicit offline migration
 *   (`scripts/migrate-tool-permissions.mjs`), which appends canonical `set`
 *   entries plus a marker. Runtime reads canonical entries and the config
 *   defaults; it never scans the retired records.
 * - Resolution precedence per tool: a canonical entry (tool > mcp > namespace
 *   > prefix, latest within a rank) outranks a config default; the config
 *   default is a `disabled` entry from `capability.manualTools`.
 *
 * The public query only exposes the four-state result. Provenance (which old
 * record, which rule, which seed) is internal: explicit and migrated `disabled`
 * both read as one `disabled` state, and no hit-rule/source explanation is
 * published.
 *
 * `explicitlyEnabled` names are root-only (not inherited); `explicitlyDisabled`
 * names are excluded everywhere and propagate to child scopes. Admission,
 * discovery, Codemode, the memory projection and tool guidance all read this one
 * resolver, so they cannot drift.
 */

import { independentDeclarations } from './declaration-visibility.ts';
import {
  matchesEntry,
  parseToolPermissionTarget,
  type ToolPermissionKind,
  type ToolPermissionTarget,
  type ToolPermissionTool,
} from './manual-tools.ts';
import { capabilityPermissionDefaults } from './scope.ts';

export { parseToolPermissionTarget };
export type { ToolPermissionKind, ToolPermissionTarget, ToolPermissionTool };
import { extractUsedToolsFromWindow, extractWindowEntries } from './pruning.ts';
import { activateToolNames } from './activation.ts';

/** customType of one append-only permission mutation. */
export const CAPABILITY_TOOL_PERMISSION_RECORD = 'capability-tool-permission';

/** Only this record version is read. */
export const CAPABILITY_TOOL_PERMISSION_VERSION = 1;

/** customType of one model-facing "now disabled" notice. */
export const CAPABILITY_TOOL_PERMISSION_NOTICE_RECORD = 'capability-tool-permission-notice';
const NOTICE_VERSION = 1;

/** An explicit managed state. */
export type ToolPermissionManagedState = 'enabled' | 'disabled';

/** The four mutually exclusive derived states. */
export type ToolPermissionState = ToolPermissionManagedState | 'active' | 'inactive';

/** The list category a tool falls into. */
export type ToolPermissionCategory = 'tool' | 'namespace';

/** Rules are branch-scoped. */
export type ToolPermissionScope = 'branch';

/** One effective managed entry (target plus state; no provenance). */
export interface ToolPermissionEntry extends ToolPermissionTarget {
  readonly state: ToolPermissionManagedState;
  readonly scope: ToolPermissionScope;
}

/** The host surface reads need; an ExtensionAPI satisfies it. */
export interface ToolPermissionHost {
  getAllTools(): readonly ToolPermissionTool[];
}

/** The append surface writes need; an ExtensionAPI satisfies it. */
export interface ToolPermissionWriter {
  appendEntry(customType: string, data?: unknown): void;
}

/** The active-set surface enable/disable effects need. */
export interface ToolPermissionApplyHost extends ToolPermissionHost {
  getActiveTools(): readonly string[];
  setActiveTools(names: string[]): void;
}

/** One tool's derived permission (no provenance). */
export interface ToolPermissionInfo {
  readonly name: string;
  readonly kind: ToolPermissionKind;
  readonly category: ToolPermissionCategory;
  readonly state: ToolPermissionState;
  readonly managed: boolean;
  readonly registered: boolean;
  readonly active: boolean;
}

/** Query output shared by the TUI command and the RPC adapter. */
export interface ToolPermissionQueryResult {
  readonly scope: ToolPermissionScope;
  readonly expression: string;
  readonly entries: readonly ToolPermissionInfo[];
  /** The user's own management data (target plus state). */
  readonly managed: readonly ToolPermissionEntry[];
}

/** One target a write applied to, with the registered tools it currently hits. */
export interface ToolPermissionChange extends ToolPermissionTarget {
  readonly affectedTools: readonly string[];
}

/** One target a write refused, with the reason. */
export interface ToolPermissionSkip {
  readonly target: string;
  readonly reason: string;
}

/** Enable/disable output. */
export interface ToolPermissionSetResult {
  readonly state: ToolPermissionManagedState;
  readonly changed: readonly ToolPermissionChange[];
  readonly alreadySet: readonly string[];
  readonly unresolved: readonly string[];
  readonly skipped: readonly ToolPermissionSkip[];
  readonly affectedTools: readonly string[];
  /** Tools activated by an enable. */
  readonly activated: readonly string[];
  /** Active Codemode-only tools removed immediately by a disable. */
  readonly removedActive: readonly string[];
  /** Active declared tools blocked until the next successful compaction. */
  readonly pendingCompaction: readonly string[];
  /** Enabled-and-used tools for which a model-facing notice was recorded. */
  readonly noticed: readonly string[];
  readonly scope: ToolPermissionScope;
  readonly recordError: string | null;
}

/** Reset output. */
export interface ToolPermissionResetResult {
  readonly reset: readonly ToolPermissionChange[];
  readonly notManaged: readonly string[];
  /** Tools still managed by another entry or the manual seed after the reset. */
  readonly stillManaged: readonly { readonly name: string; readonly state: ToolPermissionManagedState }[];
  readonly scope: ToolPermissionScope;
  readonly recordError: string | null;
}

/** The query terms accepted by {@link parsePermissionQuery}. */
export type ToolPermissionTerm = 'tool' | 'namespace' | 'enabled' | 'disabled' | 'active' | 'inactive';

const TERMS: readonly ToolPermissionTerm[] = ['tool', 'namespace', 'enabled', 'disabled', 'active', 'inactive'];
const STATE_TERMS: ReadonlySet<ToolPermissionTerm> = new Set(['enabled', 'disabled', 'active', 'inactive']);
const CATEGORY_TERMS: ReadonlySet<ToolPermissionTerm> = new Set(['tool', 'namespace']);

/** A parsed `term (('+'|'-')term)*` expression. */
export interface PermissionQuery {
  readonly text: string;
  readonly include: readonly ToolPermissionTerm[];
  readonly exclude: readonly ToolPermissionTerm[];
}

/** A structured refusal of an invalid query expression. */
export class ToolPermissionQueryError extends Error {
  readonly code = 'invalid_permission_query';

  constructor(message: string) {
    super(message);
    this.name = 'ToolPermissionQueryError';
  }
}

/** The default expression: explicitly enabled plus unmanaged active tools. */
const DEFAULT_QUERY = 'enabled+active';

/**
 * Parse a permission query. Terms are separated by `+` (union) or `-`
 * (exclusion), with no spaces; the first term is an implicit union. The empty
 * expression uses `enabled+active`. At most one category term is allowed, and a
 * repeated term is refused instead of silently merged.
 */
export function parsePermissionQuery(expression: string): PermissionQuery {
  const text = expression.trim();
  if (text === '') {
    return { text: DEFAULT_QUERY, include: ['enabled', 'active'], exclude: [] };
  }
  if (/\s/.test(text)) throw new ToolPermissionQueryError('A permission query must not contain spaces.');
  const include: ToolPermissionTerm[] = [];
  const exclude: ToolPermissionTerm[] = [];
  const seen = new Set<string>();
  let category: 'tool' | 'namespace' | null = null;
  let sign: '+' | '-' = '+';
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const char = index === text.length ? null : text[index];
    if (char !== '+' && char !== '-' && char !== null) continue;
    const term = text.slice(start, index);
    if (term === '') throw new ToolPermissionQueryError(`A permission query has an empty term at ${start}.`);
    if (!(TERMS as readonly string[]).includes(term)) {
      throw new ToolPermissionQueryError(`Unknown permission query term "${term}". Expected one of: ${TERMS.join(', ')}.`);
    }
    if (seen.has(term)) throw new ToolPermissionQueryError(`The permission query term "${term}" is repeated.`);
    seen.add(term);
    const typed = term as ToolPermissionTerm;
    if (CATEGORY_TERMS.has(typed)) {
      if (category !== null) {
        throw new ToolPermissionQueryError('A permission query may contain at most one category term (tool or namespace).');
      }
      category = typed as 'tool' | 'namespace';
    }
    (sign === '-' ? exclude : include).push(typed);
    sign = char === '-' ? '-' : '+';
    start = index + 1;
  }
  return { text, include: [...new Set(withDefaultStates(include, exclude))], exclude: [...new Set(exclude)] };
}

/**
 * A category-only expression (`tool` / `namespace`) means that category's
 * default set, i.e. the states the empty expression would list.
 */
function withDefaultStates(include: readonly ToolPermissionTerm[], exclude: readonly ToolPermissionTerm[]): ToolPermissionTerm[] {
  if (include.some((term) => STATE_TERMS.has(term))) return [...include];
  const states: ToolPermissionTerm[] = ['enabled', 'active'];
  return [...include, ...states.filter((state) => !include.includes(state) && !exclude.includes(state))];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Config permission patterns from the chain root, in declaration order. */
function permissionDefaults(host: ToolPermissionHost): readonly string[] {
  return capabilityPermissionDefaults(host);
}

interface ManagedEntry {
  readonly entry: ToolPermissionEntry;
  /** Insertion order; a later entry of the same kind wins. */
  readonly order: number;
  /** True only for an untouched config default; used to prune its declaration immediately. */
  readonly defaulted: boolean;
}

interface RecordMutation {
  readonly set: readonly { target: string; state: ToolPermissionManagedState }[];
  readonly unset: readonly string[];
}

function parseRecord(data: unknown): RecordMutation | null {
  if (!isRecord(data) || data['version'] !== CAPABILITY_TOOL_PERMISSION_VERSION) return null;
  const set: { target: string; state: ToolPermissionManagedState }[] = [];
  if (Array.isArray(data['set'])) {
    for (const raw of data['set']) {
      if (!isRecord(raw)) continue;
      const target = typeof raw['target'] === 'string' ? raw['target'].trim() : '';
      const state = raw['state'];
      if (target === '' || (state !== 'enabled' && state !== 'disabled')) continue;
      set.push({ target, state });
    }
  }
  const unset = Array.isArray(data['unset'])
    ? data['unset'].filter((target): target is string => typeof target === 'string' && target.trim() !== '')
    : [];
  return { set, unset };
}

interface ExplicitState {
  /** The live explicit assignments after replaying set/unset in branch order. */
  readonly sets: Map<string, ManagedEntry>;
  /** Ids whose latest explicit mutation is an unset tombstone. */
  readonly unsets: Set<string>;
}

function explicitState(branch: readonly unknown[] | null | undefined): ExplicitState {
  const sets = new Map<string, ManagedEntry>();
  const unsets = new Set<string>();
  let order = 0;
  for (const entry of branch ?? []) {
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== CAPABILITY_TOOL_PERMISSION_RECORD) continue;
    const mutation = parseRecord(entry['data']);
    if (mutation === null) continue;
    for (const target of mutation.unset) {
      const parsed = parseToolPermissionTarget(target);
      if (parsed === null) continue;
      sets.delete(parsed.id);
      unsets.add(parsed.id);
    }
    for (const item of mutation.set) {
      const parsed = parseToolPermissionTarget(item.target);
      if (parsed === null) continue;
      order += 1;
      sets.set(parsed.id, {
        entry: { ...parsed, state: item.state, scope: 'branch' },
        order,
        defaulted: false,
      });
      unsets.delete(parsed.id);
    }
  }
  return { sets, unsets };
}

function explicitEntries(branch: readonly unknown[] | null | undefined): ManagedEntry[] {
  return [...explicitState(branch).sets.values()];
}

/**
 * Every effective managed entry: config defaults and canonical explicit sets.
 * Legacy records are migrated once into canonical entries before runtime reads;
 * all entries obey this branch's `unset` tombstones, and an explicit set
 * replaces a config default with the same id.
 */
function storedEntries(
  host: ToolPermissionHost,
  branch: readonly unknown[] | null | undefined,
): ManagedEntry[] {
  const { sets, unsets } = explicitState(branch);
  const byId = new Map<string, ManagedEntry>();
  let defaultOrder = 0;
  for (const raw of permissionDefaults(host)) {
    const target = parseToolPermissionTarget(raw);
    if (target === null || unsets.has(target.id)) continue;
    defaultOrder += 1;
    byId.set(target.id, {
      entry: { ...target, state: 'disabled', scope: 'branch' },
      order: defaultOrder,
      defaulted: true,
    });
  }
  // Canonical entries keep the order of their latest mutation. Iterating the
  // Map must not replace it with the key's original insertion order: aliases
  // (`mcp__git` / `git`) share a target, and the latest same-rank rule wins.
  for (const stored of sets.values()) {
    if (unsets.has(stored.entry.id)) continue;
    byId.set(stored.entry.id, stored);
  }
  return [...byId.values()];
}

/** The effective stored entries (no manual seed) for one branch. */
export function effectiveToolPermissionEntries(
  host: ToolPermissionHost,
  branch: readonly unknown[] | null | undefined,
): readonly ToolPermissionEntry[] {
  return storedEntries(host, branch).map((stored) => stored.entry);
}

function toolFor(host: ToolPermissionHost, name: string): ToolPermissionTool | undefined {
  return host.getAllTools().find((tool) => tool.name === name);
}

const KIND_RANK: Readonly<Record<ToolPermissionKind, number>> = { tool: 0, mcp: 1, namespace: 2, prefix: 3 };

interface Decision {
  readonly state: ToolPermissionManagedState;
  readonly entry: ToolPermissionEntry;
  readonly defaulted: boolean;
}

function isBetterEntry(candidate: ManagedEntry, currentBest: ManagedEntry): boolean {
  if (candidate.defaulted !== currentBest.defaulted) {
    return !candidate.defaulted;
  }
  if (KIND_RANK[candidate.entry.kind] !== KIND_RANK[currentBest.entry.kind]) {
    return KIND_RANK[candidate.entry.kind] < KIND_RANK[currentBest.entry.kind];
  }
  return candidate.order > currentBest.order;
}

function findWinningEntry(
  stored: readonly ManagedEntry[],
  tool: ToolPermissionTool | undefined,
  name: string,
): ManagedEntry | null {
  let winner: ManagedEntry | null = null;
  for (const item of stored) {
    if (matchesEntry(item.entry, tool, name)) {
      if (winner === null || isBetterEntry(item, winner)) {
        winner = item;
      }
    }
  }
  return winner;
}

/** A per-operation resolver that reads stored entries once. */
export interface ToolPermissionResolver {
  readonly enabled: (name: string) => boolean;
  readonly disabled: (name: string) => boolean;
  /** A `manualTools` seed (never an explicit/migrated rule) disabled the name. */
  readonly seedDisabled: (name: string) => boolean;
  /** Resolve using an already-read tool record, without a second registry read. */
  readonly disabledFor: (tool: ToolPermissionTool) => boolean;
  /** Resolve the managed decision for a name, or null when unmanaged. */
  readonly decide: (name: string) => Decision | null;
  /** Resolve one tool by name and active status to its derived info. */
  readonly resolve: (name: string, active: boolean) => ToolPermissionInfo;
  /** Resolve an already-read tool and active status to its derived info. */
  readonly resolveFor: (tool: ToolPermissionTool, active: boolean) => ToolPermissionInfo;
}

function createToolPermissionResolverWithStored(
  host: ToolPermissionHost | null,
  tools: readonly ToolPermissionTool[] | null,
  stored: readonly ManagedEntry[],
): ToolPermissionResolver {
  const byName = tools === null ? null : new Map(tools.map((tool) => [tool.name, tool]));
  const cache = new Map<string, { readonly decision: Decision | null; readonly tool: ToolPermissionTool | undefined }>();

  const resolveTool = (tool: ToolPermissionTool | undefined, name: string): { readonly decision: Decision | null; readonly tool: ToolPermissionTool | undefined } => {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const resolvedTool = tool ?? (byName !== null ? byName.get(name) : (host ? toolFor(host, name) : undefined));
    const winner = findWinningEntry(stored, resolvedTool, name);
    const decision: Decision | null = winner === null ? null : {
      state: winner.entry.state,
      entry: winner.entry,
      defaulted: winner.defaulted,
    };
    const result = { decision, tool: resolvedTool };
    cache.set(name, result);
    return result;
  };

  const resolveInfo = (tool: ToolPermissionTool | undefined, name: string, active: boolean): ToolPermissionInfo => {
    const { decision, tool: resolvedTool } = resolveTool(tool, name);
    return {
      name,
      kind: decision?.entry.kind ?? 'tool',
      category: resolvedTool?.namespace === undefined ? 'tool' : 'namespace',
      state: decision?.state ?? (active ? 'active' : 'inactive'),
      managed: decision !== null,
      registered: resolvedTool !== undefined,
      active,
    };
  };

  return {
    enabled: (name) => resolveTool(undefined, name).decision?.state === 'enabled',
    disabled: (name) => resolveTool(undefined, name).decision?.state === 'disabled',
    seedDisabled: (name) => resolveTool(undefined, name).decision?.defaulted === true,
    disabledFor: (tool) => resolveTool(tool, tool.name).decision?.state === 'disabled',
    decide: (name) => resolveTool(undefined, name).decision,
    resolve: (name, active) => resolveInfo(undefined, name, active),
    resolveFor: (tool, active) => resolveInfo(tool, tool.name, active),
  };
}

/**
 * Build one permission resolver for an operation.
 *
 * Passing the already-read catalog (`tools`) avoids a second `getAllTools()`
 * call for name-based admission. A caller that filters a catalog while reading
 * it can pass `null` and use {@link ToolPermissionResolver.disabledFor} with the
 * record it already holds. Every name is resolved once and cached.
 */
export function createToolPermissionResolver(
  host: ToolPermissionHost,
  tools: readonly ToolPermissionTool[] | null,
  branch: readonly unknown[] | null | undefined,
): ToolPermissionResolver {
  const stored = storedEntries(host, branch);
  return createToolPermissionResolverWithStored(host, tools, stored);
}

/** Resolve the managed state of one tool, or null when unmanaged. */
function decide(
  host: ToolPermissionHost,
  branch: readonly unknown[] | null | undefined,
  name: string,
): Decision | null {
  return createToolPermissionResolver(host, null, branch).decide(name);
}

/** Resolve one tool to its four-state permission. */
export function resolveToolPermission(
  host: ToolPermissionHost,
  branch: readonly unknown[] | null | undefined,
  name: string,
  activeSet: readonly string[],
): ToolPermissionInfo {
  const active = activeSet.includes(name);
  return createToolPermissionResolver(host, null, branch).resolve(name, active);
}

/** Whether the tool resolves to an explicit/migrated enabled state. */
export function explicitlyEnabled(
  host: ToolPermissionHost,
  branch: readonly unknown[] | null | undefined,
  name: string,
): boolean {
  return createToolPermissionResolver(host, null, branch).enabled(name);
}

/** Whether the tool resolves to a disabled state (including the manual seed). */
export function explicitlyDisabled(
  host: ToolPermissionHost,
  branch: readonly unknown[] | null | undefined,
  name: string,
): boolean {
  return createToolPermissionResolver(host, null, branch).disabled(name);
}

/** The active set with explicitly disabled names removed. */
export function activeToolsAfterDisabled(
  host: ToolPermissionHost,
  branch: readonly unknown[] | null | undefined,
  active: readonly string[],
): string[] {
  const tools = host.getAllTools();
  const resolver = createToolPermissionResolver(host, tools, branch);
  return active.filter((name) => !resolver.disabled(name));
}

function matchesQuery(info: ToolPermissionInfo, query: PermissionQuery): boolean {
  const includeStates = query.include.filter((term) => STATE_TERMS.has(term)) as readonly ToolPermissionState[];
  const includeCategories = query.include.filter((term) => CATEGORY_TERMS.has(term)) as readonly ToolPermissionCategory[];
  const excludeStates = query.exclude.filter((term) => STATE_TERMS.has(term)) as readonly ToolPermissionState[];
  const excludeCategories = query.exclude.filter((term) => CATEGORY_TERMS.has(term)) as readonly ToolPermissionCategory[];
  if (includeStates.length > 0 && !includeStates.includes(info.state)) return false;
  if (includeCategories.length > 0 && !includeCategories.includes(info.category)) return false;
  if (excludeStates.includes(info.state)) return false;
  if (excludeCategories.includes(info.category)) return false;
  return true;
}

/** Query derived permissions. `entries` are registered and managed tool names. */
export function queryToolPermissions(
  host: ToolPermissionHost,
  branch: readonly unknown[] | null | undefined,
  activeSet: readonly string[],
  expression?: string,
): ToolPermissionQueryResult {
  const query = parsePermissionQuery(expression ?? '');
  const tools = host.getAllTools();
  const stored = storedEntries(host, branch);
  const resolver = createToolPermissionResolverWithStored(host, tools, stored);
  const names = new Set<string>(tools.filter((tool) => tool.exposure !== 'hidden').map((tool) => tool.name));
  for (const item of stored) {
    if (item.entry.kind === 'tool') names.add(item.entry.name);
  }
  const active = new Set(activeSet);
  const entries: ToolPermissionInfo[] = [];
  for (const name of names) {
    const info = resolver.resolve(name, active.has(name));
    if (matchesQuery(info, query)) entries.push(info);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const managed = stored.map((item) => item.entry);
  return { scope: 'branch', expression: query.text, entries, managed };
}

interface TargetResolution {
  readonly target: ToolPermissionTarget;
  readonly affectedTools: readonly string[];
}

function resolveTargets(host: ToolPermissionHost, targets: readonly string[]): {
  readonly resolved: readonly TargetResolution[];
  readonly unresolved: readonly string[];
} {
  const resolved: TargetResolution[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const tools = host.getAllTools();
  for (const raw of targets) {
    const target = parseToolPermissionTarget(raw);
    if (target === null) {
      unresolved.push(raw.trim() === '' ? raw : raw.trim());
      continue;
    }
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    const affectedTools = tools
      .filter((tool) => matchesEntry(target, tool, tool.name))
      .map((tool) => tool.name);
    resolved.push({ target, affectedTools });
  }
  return { resolved, unresolved };
}

function appendMutation(
  writer: ToolPermissionWriter,
  set: readonly { target: string; state: ToolPermissionManagedState }[],
  unset: readonly string[],
): void {
  writer.appendEntry(CAPABILITY_TOOL_PERMISSION_RECORD, {
    version: CAPABILITY_TOOL_PERMISSION_VERSION,
    ...(set.length === 0 ? {} : { set }),
    ...(unset.length === 0 ? {} : { unset }),
  });
}

/**
 * Set the state for targets (enable and disable share this operation).
 *
 * The record is the single durability point: a failed append applies no effect
 * and reports each change as skipped. An enable activates the concrete members.
 * A disable removes Codemode-only members from the active set now and leaves a
 * declared member to the next successful compaction, while the execution hook
 * blocks both from the moment the record is durable.
 */
export function setToolPermission(
  host: ToolPermissionApplyHost,
  writer: ToolPermissionWriter,
  branch: readonly unknown[] | null | undefined,
  targets: readonly string[],
  state: ToolPermissionManagedState,
): ToolPermissionSetResult {
  const { resolved, unresolved } = resolveTargets(host, targets);
  const explicitStateMap = new Map(explicitEntries(branch).map((stored) => [stored.entry.id, stored.entry.state]));
  const changedTargets: TargetResolution[] = [];
  const alreadySet: string[] = [];
  for (const item of resolved) {
    if (explicitStateMap.get(item.target.id) === state) {
      alreadySet.push(item.target.target);
      continue;
    }
    changedTargets.push(item);
  }
  const changedAffected = new Set<string>();
  for (const item of changedTargets) for (const name of item.affectedTools) changedAffected.add(name);
  const resolvedAffected = new Set<string>();
  for (const item of resolved) for (const name of item.affectedTools) resolvedAffected.add(name);

  let recordError: string | null = null;
  const skipped: ToolPermissionSkip[] = [];
  let durable = true;
  if (changedTargets.length > 0) {
    try {
      appendMutation(writer, changedTargets.map((item) => ({ target: item.target.target, state })), []);
    } catch (error) {
      recordError = errorText(error);
      durable = false;
      for (const item of changedTargets) {
        skipped.push({ target: item.target.target, reason: `the permission record could not be written: ${recordError}` });
      }
    }
  }

  const activated: string[] = [];
  const removedActive: string[] = [];
  const pendingCompaction: string[] = [];
  const noticed: string[] = [];
  if (durable && state === 'enabled' && resolvedAffected.size > 0) {
    const outcome = activateToolNames(host, [...resolvedAffected]);
    activated.push(...outcome.activated);
    for (const skip of outcome.skipped) skipped.push({ target: skip.name, reason: skip.reason });
  }
  if (durable && state === 'disabled' && changedAffected.size > 0) {
    const activeBefore = new Set(host.getActiveTools());
    const tools = new Map(host.getAllTools().map((tool) => [tool.name, tool]));
    const declared = independentDeclarations(host);
    for (const name of changedAffected) {
      if (!activeBefore.has(name)) continue;
      const independent = declared === null
        ? tools.get(name)?.exposure !== 'codemode'
        : declared.has(name);
      if (independent) pendingCompaction.push(name);
      else removedActive.push(name);
    }
    if (removedActive.length > 0) {
      const drop = new Set(removedActive);
      host.setActiveTools([...activeBefore].filter((name) => !drop.has(name)));
    }
    const used = extractUsedToolsFromWindow(extractWindowEntries(branch, null));
    const names = [...changedAffected].filter((name) => activeBefore.has(name) && used.has(name));
    if (names.length > 0) {
      appendToolPermissionNotice(writer, names);
      noticed.push(...names);
    }
  }

  return {
    state,
    changed: durable ? changedTargets.map((item) => ({ ...item.target, affectedTools: item.affectedTools })) : [],
    alreadySet,
    unresolved,
    skipped,
    affectedTools: [...resolvedAffected],
    activated,
    removedActive,
    pendingCompaction,
    noticed,
    scope: 'branch',
    recordError,
  };
}

/**
 * Reset targets back to unmanaged.
 *
 * An explicit or migrated rule is removed with an `unset` tombstone, so a later
 * reset cannot resurrect an old blacklist/manual disable. The `manualTools`
 * seed is current config policy, not history: a seed-only target writes no
 * tombstone and is reported as still managed. A target covered only by another
 * rule (for example a group) also remains managed without an exact tombstone.
 */
export function resetToolPermission(
  host: ToolPermissionHost,
  writer: ToolPermissionWriter,
  branch: readonly unknown[] | null | undefined,
  targets: readonly string[],
): ToolPermissionResetResult {
  const { resolved, unresolved } = resolveTargets(host, targets);
  const tools = host.getAllTools();
  const stored = storedEntries(host, branch);
  const resolver = createToolPermissionResolverWithStored(host, tools, stored);
  const explicit = explicitState(branch);
  const managedIds = new Set(stored.map((item) => item.entry.id));
  const changed: TargetResolution[] = [];
  const notManaged: string[] = [...unresolved];
  for (const item of resolved) {
    const id = item.target.id;
    if (explicit.sets.has(id)) {
      changed.push(item);
      continue;
    }
    if (managedIds.has(id)) {
      // A config default or migrated rule was never an explicit entry; report
      // the target as not explicitly managed while still writing the tombstone.
      changed.push(item);
      notManaged.push(item.target.target);
      continue;
    }
    const covered = item.affectedTools.some((name) => resolver.decide(name) !== null);
    if (!covered) notManaged.push(item.target.target);
  }
  let recordError: string | null = null;
  let durable = true;
  if (changed.length > 0) {
    try {
      appendMutation(writer, [], changed.map((item) => item.target.target));
    } catch (error) {
      recordError = errorText(error);
      durable = false;
    }
  }
  const stillManaged: { name: string; state: ToolPermissionManagedState }[] = [];
  if (durable) {
    // Evaluate against a virtual branch that already contains this unset, so an
    // old migrated rule cannot make a just-reset target look managed.
    const virtual = changed.length === 0
      ? branch
      : [...(branch ?? []), {
        type: 'custom',
        customType: CAPABILITY_TOOL_PERMISSION_RECORD,
        data: { version: CAPABILITY_TOOL_PERMISSION_VERSION, unset: changed.map((item) => item.target.target) },
      }];
    const virtualResolver = createToolPermissionResolver(host, tools, virtual);
    const affected = new Set<string>();
    for (const item of resolved) for (const name of item.affectedTools) affected.add(name);
    for (const name of affected) {
      const decision = virtualResolver.decide(name);
      if (decision !== null) stillManaged.push({ name, state: decision.state });
    }
  }
  return {
    reset: durable ? changed.map((item) => ({ ...item.target, affectedTools: item.affectedTools })) : [],
    notManaged,
    stillManaged,
    scope: 'branch',
    recordError,
  };
}

/** Append a model-facing notice for the named now-disabled tools. */
export function appendToolPermissionNotice(writer: ToolPermissionWriter, names: readonly string[]): void {
  const unique = [...new Set(names.filter((name) => typeof name === 'string' && name !== ''))];
  if (unique.length === 0) return;
  writer.appendEntry(CAPABILITY_TOOL_PERMISSION_NOTICE_RECORD, { version: NOTICE_VERSION, names: unique });
}

/** Every tool name a notice record has announced on this branch. */
export function noticedToolPermissionNames(branch: readonly unknown[] | null | undefined): Set<string> {
  const names = new Set<string>();
  for (const entry of branch ?? []) {
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== CAPABILITY_TOOL_PERMISSION_NOTICE_RECORD) continue;
    const data = entry['data'];
    if (!isRecord(data) || data['version'] !== NOTICE_VERSION) continue;
    if (!Array.isArray(data['names'])) continue;
    for (const name of data['names']) if (typeof name === 'string' && name !== '') names.add(name);
  }
  return names;
}
