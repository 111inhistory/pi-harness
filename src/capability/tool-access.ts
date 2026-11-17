/**
 * Persistence-first mutations for BASE and DYNAMIC membership.
 *
 * Membership is stored as concrete tool names; loaded namespace/MCP containers
 * are remembered in the same record (`load`). A container target expands to a
 * snapshot of the current eligible members at write time; it is never a
 * persistent member-matching rule. Blacklist stays an independent target union.
 *
 * Every write validates the whole batch first, then appends one record, then
 * applies effects. A rejection writes nothing and changes nothing.
 */

import { activateToolNames, type ActivationSkip } from './activation.ts';
import { planNoSchema } from './lazy-schemas.ts';
import { independentDeclarations } from './declaration-visibility.ts';
import { extractUsedToolsFromWindow, extractWindowEntries } from './pruning.ts';
import { createCapabilityScopeView } from './scope.ts';
import {
  isRecord,
  parseBlacklistRecord,
  parseBaseRecord,
  parseDynamicRecord,
  replay,
  strings,
  TOOL_BASE_RECORD,
  TOOL_BASE_VERSION,
  TOOL_BLACKLIST_RECORD,
  TOOL_BLACKLIST_VERSION,
  TOOL_BLACKLIST_NOTICE_RECORD,
  TOOL_BLACKLIST_NOTICE_VERSION,
  TOOL_DYNAMIC_RECORD,
  TOOL_DYNAMIC_VERSION,
  type AccessState,
  type ToolBaseSource,
  type ToolBlacklistSource,
  type ToolDynamicSource,
} from './tool-access-replay.ts';
import {
  canonicalContainerTarget,
  containerTargetForTool,
  createToolAccessView,
  memberNames,
  type ToolAccessHost,
  type ToolContainer,
} from './tool-access-view.ts';
import { createEligibleToolCatalog } from './tool-catalog.ts';
import { matchesToolTarget, parseToolTarget, type ToolTarget, type ToolTargetRecord } from './targets.ts';

export {
  TOOL_BASE_RECORD,
  TOOL_BASE_VERSION,
  TOOL_BLACKLIST_RECORD,
  TOOL_BLACKLIST_VERSION,
  TOOL_BLACKLIST_NOTICE_RECORD,
  TOOL_DYNAMIC_RECORD,
  TOOL_DYNAMIC_VERSION,
  type ToolBaseSource,
  type ToolBlacklistSource,
  type ToolDynamicSource,
};
export { sessionBaseLoads, sessionBaseNames } from './tool-access-replay.ts';

/** The append surface writes need. */
export interface ToolAccessWriter {
  appendEntry(customType: string, data?: unknown): void;
}

/** The active-set surface mutations need. */
export interface ToolAccessApplyHost extends ToolAccessHost {
  getActiveTools(): readonly string[];
  setActiveTools(names: string[]): void;
}

/** One container selected by a write. */
export interface ToolWriteContainer {
  readonly target: string;
  readonly kind: 'namespace' | 'mcp';
  readonly name: string;
  readonly id: string;
  /** `[ns]` marker: the container is loaded without default expansion. */
  readonly explicit: boolean;
  /** Concrete members this write selected under the container. */
  readonly members: readonly string[];
}

/** Why a whole batch was refused before any append/effect. */
export type ToolBatchRejectionCode =
  | 'selection_not_supported'
  | 'no_schema_unsupported'
  | 'invalid_selection'
  | 'conflicting_schema_modes'
  | 'container_without_members'
  | 'foreign_member'
  | 'blocked_selection'
  | 'empty_selection';

export interface ToolBatchRejection {
  readonly code: ToolBatchRejectionCode;
  readonly targets: readonly string[];
  readonly members: readonly string[];
  /** Concise reason for `no_schema_unsupported`; no separate error channel. */
  readonly reason?: 'codemode_unavailable' | 'mode_not_only' | 'tool_not_codemode_callable';
}

/** Optional per-operation selection inputs. */
export interface ToolWriteOptions {
  /** Exact names or targets excluded from THIS selection only. */
  readonly exclude?: readonly string[];
}

/** Why a name or target could not be applied. */
export type ToolSkipReason =
  | 'blacklisted'
  | 'not_registered'
  | 'hidden'
  | 'not_permitted'
  | 'unreachable'
  | 'not_activated'
  | 'record_error';

export interface ToolWriteSkip {
  readonly target: string;
  readonly reason: ToolSkipReason;
}

export type ToolWriteAction =
  | 'base-add'
  | 'base-remove'
  | 'activate'
  | 'deactivate'
  | 'blacklist-add'
  | 'blacklist-remove';

export interface ToolWriteChange extends ToolTarget {
  readonly affectedTools: readonly string[];
}

export interface ToolWriteResult {
  readonly action: ToolWriteAction;
  readonly changed: readonly ToolWriteChange[];
  readonly alreadySet: readonly string[];
  readonly unresolved: readonly string[];
  readonly skipped: readonly ToolWriteSkip[];
  readonly affectedTools: readonly string[];
  /** Concrete positive members resolved by this batch. */
  readonly selected: readonly string[];
  /** Selected names whose latest record requests no-schema. */
  readonly noSchema: readonly string[];
  /** Selected names whose latest record requests schema (no-lazy). */
  readonly schema: readonly string[];
  /** Selected names whose schema is actually withheld now. */
  readonly schemaWithheld: readonly string[];
  /** Containers loaded/selected by this batch. */
  readonly containers: readonly ToolWriteContainer[];
  /** Normalized `-name` exclusions applied to this selection. */
  readonly excluded: readonly string[];
  /** Whole-batch refusal; when set, nothing was written or applied. */
  readonly rejected: ToolBatchRejection | null;
  readonly activated: readonly string[];
  readonly alreadyActive: readonly string[];
  readonly removedActive: readonly string[];
  readonly pendingCompaction: readonly string[];
  readonly noticed: readonly string[];
  readonly notRequested: readonly string[];
  readonly stillBlacklisted: readonly string[];
  /** Raw bans currently retained but overridden by a base member. */
  readonly banOverridden: readonly string[];
  readonly remainingSources: readonly ToolBlacklistSource[];
  readonly recordError: string | null;
  readonly effectError: string | null;
}

export interface ToolSyncResult {
  readonly active: readonly string[];
  readonly activated: readonly string[];
  readonly removed: readonly string[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyEffect(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return errorText(error);
  }
}

function appendRecord(writer: ToolAccessWriter, customType: string, data: unknown): string | null {
  try {
    writer.appendEntry(customType, data);
    return null;
  } catch (error) {
    return errorText(error);
  }
}

interface ParsedModifiers {
  readonly ns: boolean;
  readonly lazy: 'lazy' | 'no-lazy' | null;
}

interface ParsedToken {
  readonly raw: string;
  readonly kind: 'container' | 'container-load' | 'member';
  readonly target: ToolTarget;
  readonly modifiers: ParsedModifiers;
}

interface ParsedSelection {
  readonly tokens: readonly ParsedToken[];
  readonly excluded: readonly string[];
  readonly invalid: readonly string[];
  readonly unresolved: readonly string[];
}

/** Split a trailing `[mod,...]` selector; null means malformed. */
function splitModifiers(text: string): { readonly base: string; readonly modifiers: ParsedModifiers } | null {
  if (!text.includes('[')) return { base: text, modifiers: { ns: false, lazy: null } };
  const open = text.lastIndexOf('[');
  if (open < 0 || !text.endsWith(']')) return null;
  const parts = text.slice(open + 1, -1).split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part === '')) return null;
  const seen = new Set<string>();
  let ns = false;
  let lazy: 'lazy' | 'no-lazy' | null = null;
  for (const part of parts) {
    if (seen.has(part)) return null;
    seen.add(part);
    if (part === 'ns') ns = true;
    else if (part === 'lazy' || part === 'no-lazy') {
      if (lazy !== null) return null;
      lazy = part;
    } else return null;
  }
  return { base: text.slice(0, open), modifiers: { ns, lazy } };
}

function sameModifiers(left: ParsedModifiers, right: ParsedModifiers): boolean {
  return left.ns === right.ns && left.lazy === right.lazy;
}

function parseSelection(host: ToolAccessHost, targets: readonly string[], options: ToolWriteOptions): ParsedSelection {
  const tools = host.getAllTools();
  const excluded: string[] = [...(options.exclude ?? [])];
  const tokens: ParsedToken[] = [];
  const invalid: string[] = [];
  const unresolved: string[] = [];
  const seen = new Map<string, ParsedToken>();
  for (const raw of targets) {
    const text = raw.trim();
    if (text === '') continue;
    if (text.startsWith('-')) {
      // Exclusions are exact targets only; any modifier is malformed.
      const split = splitModifiers(text.slice(1));
      if (split === null || split.modifiers.ns || split.modifiers.lazy !== null) { invalid.push(text); continue; }
      const target = parseToolTarget(split.base);
      if (target === null) { invalid.push(text); continue; }
      excluded.push(split.base);
      continue;
    }
    const split = splitModifiers(text);
    if (split === null) { invalid.push(text); continue; }
    const parsed = parseToolTarget(split.base);
    if (parsed === null || split.base === '') { invalid.push(text); continue; }
    const container = parsed.kind === 'namespace' || parsed.kind === 'mcp';
    if (split.modifiers.ns && !container) { invalid.push(text); continue; }
    const target = container ? canonicalContainerTarget(parsed, tools) : parsed;
    const kind: ParsedToken['kind'] = !container ? 'member' : split.modifiers.ns ? 'container-load' : 'container';
    const token: ParsedToken = { raw: text, kind, target, modifiers: split.modifiers };
    const existing = seen.get(target.id);
    if (existing !== undefined) {
      // The same canonical identity with different modifiers is a conflict, not
      // an order-dependent last-wins selection.
      if (!sameModifiers(existing.modifiers, token.modifiers)) invalid.push(text);
      continue;
    }
    seen.set(target.id, token);
    tokens.push(token);
  }
  return { tokens, excluded, invalid, unresolved };
}

function excludedNames(excluded: readonly string[], tools: readonly ToolTargetRecord[]): Set<string> {
  const names = new Set<string>();
  for (const raw of excluded) {
    const target = parseToolTarget(raw);
    if (target === null) { names.add(raw.trim()); continue; }
    if (target.kind === 'tool') { names.add(target.name); continue; }
    for (const name of memberNames(target, tools)) names.add(name);
  }
  return names;
}

interface SelectionResolution {
  readonly selected: readonly string[];
  readonly modes: ReadonlyMap<string, 'no-schema' | 'schema'>;
  readonly loads: readonly ToolTarget[];
  readonly containers: readonly ToolWriteContainer[];
  readonly changed: readonly ToolWriteChange[];
  readonly skipped: readonly ToolWriteSkip[];
  readonly unresolved: readonly string[];
  readonly alreadySet: readonly string[];
  readonly excluded: readonly string[];
  readonly rejected: ToolBatchRejection | null;
}

interface ResolutionContext {
  readonly host: ToolAccessHost;
  readonly preBranch: readonly unknown[];
  readonly state: AccessState;
  readonly action: 'add' | 'activate';
}

function resolveAddition(
  context: ResolutionContext,
  parsed: ParsedSelection,
): SelectionResolution {
  const { host, state } = context;
  const tools = host.getAllTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const scope = createCapabilityScopeView(host);
  const pre = createToolAccessView(host, context.preBranch, tools);
  const excluded = excludedNames(parsed.excluded, tools);
  const excludedList = [...excluded].sort();
  const hasContainer = parsed.tokens.some((token) => token.kind !== 'member');
  const skipped: ToolWriteSkip[] = [];
  const loads = new Map<string, ToolTarget>();
  const selected = new Set<string>();
  const containerMembers = new Map<string, string[]>();
  const containerExplicit = new Map<string, boolean>();
  const unresolved: string[] = [...parsed.unresolved];
  const changed: ToolWriteChange[] = [];
  const explicitModes = new Map<string, 'no-schema' | 'schema'>();
  const containerClaims = new Map<string, Set<'no-schema' | 'schema'>>();
  const modeOf = (modifier: 'lazy' | 'no-lazy'): 'no-schema' | 'schema' =>
    modifier === 'lazy' ? 'no-schema' : 'schema';
  const claim = (name: string, mode: 'no-schema' | 'schema'): void => {
    const claims = containerClaims.get(name) ?? new Set();
    claims.add(mode);
    containerClaims.set(name, claims);
  };

  const ownedBy = (name: string): string | null => {
    const tool = byName.get(name);
    if (tool === undefined) return null;
    return containerTargetForTool(tool)?.id ?? null;
  };
  const eligibleMember = (name: string): boolean => {
    const tool = byName.get(name);
    return tool !== undefined && tool.exposure !== 'hidden' && scope.allows(name) && !excluded.has(name);
  };
  const loadContainer = (target: ToolTarget): void => {
    if (target.kind !== 'namespace' && target.kind !== 'mcp') return;
    loads.set(target.id, target);
  };

  if (parsed.invalid.length > 0) {
    return {
      selected: [], modes: new Map(), loads: [], containers: [], changed: [], skipped: [], unresolved: [],
      alreadySet: [], excluded: excludedList,
      rejected: { code: 'invalid_selection', targets: parsed.invalid, members: [] },
    };
  }

  if (hasContainer) {
    for (const token of parsed.tokens) {
      if (token.kind === 'member') continue;
      const members = memberNames(token.target, tools);
      const owned = members.filter((name) => ownedBy(name) === token.target.id);
      const excludedOwned = owned.filter((name) => !excluded.has(name));
      const scopeOwned = excludedOwned.filter((name) => scope.allows(name) && byName.get(name)?.exposure !== 'hidden');
      if (scopeOwned.length === 0) {
        const code: ToolBatchRejectionCode = owned.length > 0 && excludedOwned.length > 0
          ? 'blocked_selection'
          : owned.length > 0 ? 'empty_selection' : 'container_without_members';
        return {
          selected: [], modes: new Map(), loads: [], containers: [], changed: [], skipped: [], unresolved: [],
          alreadySet: [], excluded: excludedList,
          rejected: { code, targets: [token.raw], members: owned },
        };
      }
    }
  }

  for (const token of parsed.tokens) {
    if (token.kind === 'member') {
      const tool = byName.get(token.target.name);
      if (tool === undefined) { unresolved.push(token.raw); continue; }
      if (excluded.has(token.target.name)) continue;
      selected.add(token.target.name);
      if (token.modifiers.lazy !== null) {
        const mode = modeOf(token.modifiers.lazy);
        const existing = explicitModes.get(token.target.name);
        if (existing !== undefined && existing !== mode) {
          return {
            selected: [], modes: new Map(), loads: [], containers: [], changed: [], skipped: [], unresolved: [],
            alreadySet: [], excluded: excludedList,
            rejected: { code: 'conflicting_schema_modes', targets: [token.raw], members: [token.target.name] },
          };
        }
        explicitModes.set(token.target.name, mode);
      }
      const container = containerTargetForTool(tool);
      if (container !== null) loadContainer(container);
      changed.push({ ...token.target, affectedTools: [token.target.name] });
      continue;
    }
    loadContainer(token.target);
    containerExplicit.set(token.target.id, token.kind === 'container-load');
    const members = memberNames(token.target, tools);
    const chosen: string[] = [];
    if (token.kind === 'container') {
      for (const name of members) {
        if (!eligibleMember(name)) continue;
        // A base-add namespace snapshot deliberately includes locally banned
        // members: exact base membership is the override. Activate/discovery
        // cannot lift the local ban.
        if (context.action === 'activate' && pre.blocked(name)) continue;
        chosen.push(name);
      }
    } else {
      for (const tokenMember of parsed.tokens) {
        if (tokenMember.kind !== 'member') continue;
        const name = tokenMember.target.name;
        if (byName.get(name) === undefined || ownedBy(name) !== token.target.id) continue;
        if (!scope.allows(name) || byName.get(name)?.exposure === 'hidden') continue;
        if (excluded.has(name) || (context.action === 'activate' && pre.blocked(name))) continue;
        chosen.push(name);
      }
    }
    for (const name of chosen) {
      selected.add(name);
      if (token.modifiers.lazy !== null) claim(name, modeOf(token.modifiers.lazy));
      const container = containerTargetForTool(byName.get(name)!);
      if (container !== null) loadContainer(container);
    }
    containerMembers.set(token.target.id, [...new Set(chosen)]);
    changed.push({ ...token.target, affectedTools: [...new Set(chosen)] });
  }

  if (hasContainer) {
    for (const token of parsed.tokens) {
      if (token.kind !== 'container-load') continue;
      const chosen = containerMembers.get(token.target.id) ?? [];
      if (chosen.length === 0) {
        return {
          selected: [], modes: new Map(), loads: [], containers: [], changed: [], skipped: [], unresolved: [],
          alreadySet: [], excluded: excludedList,
          rejected: { code: 'container_without_members', targets: [token.raw], members: [] },
        };
      }
    }
    if (selected.size === 0) {
      return {
        selected: [], modes: new Map(), loads: [], containers: [], changed: [], skipped: [], unresolved: [],
        alreadySet: [], excluded: excludedList,
        rejected: { code: 'empty_selection', targets: parsed.tokens.map((token) => token.raw), members: [] },
      };
    }
  }

  const selectedNames = [...selected];
  const modes = new Map<string, 'no-schema' | 'schema'>();
  for (const name of selectedNames) {
    const explicit = explicitModes.get(name);
    if (explicit !== undefined) { modes.set(name, explicit); continue; }
    const claims = containerClaims.get(name);
    if (claims === undefined || claims.size === 0) continue;
    if (claims.size > 1) {
      return {
        selected: [], modes: new Map(), loads: [], containers: [], changed: [], skipped: [], unresolved: [],
        alreadySet: [], excluded: excludedList,
        rejected: { code: 'conflicting_schema_modes', targets: parsed.tokens.map((token) => token.raw), members: [name] },
      };
    }
    modes.set(name, [...claims][0]!);
  }

  const containers: ToolWriteContainer[] = [...loads.values()].map((target) => ({
    target: target.target,
    kind: target.kind === 'mcp' ? 'mcp' : 'namespace',
    name: target.name,
    id: target.id,
    explicit: containerExplicit.get(target.id) === true,
    members: containerMembers.get(target.id) ?? selectedNames.filter((name) => ownedBy(name) === target.id),
  }));
  const actions = context.action === 'add' ? state.baseActions : state.dynamicActions;
  const alreadySet = selectedNames.filter((name) => actions.get(`tool:${name}`) === context.action);
  const existingLoads = context.action === 'add' ? state.baseLoads : state.dynamicLoads;
  const newLoads = [...loads.values()].filter((target) => !existingLoads.has(target.id));
  const modeAlready = [...modes].every(([name, mode]) => state.schemaModes.get(name) === mode);
  const noChange = selectedNames.length > 0 && alreadySet.length === selectedNames.length
    && newLoads.length === 0 && modeAlready;
  const filteredChanged: ToolWriteChange[] = [];
  if (!noChange) {
    for (const change of changed) {
      if (change.affectedTools.length > 0) filteredChanged.push(change);
    }
  }
  return {
    selected: selectedNames,
    modes,
    loads: [...loads.values()],
    containers,
    changed: filteredChanged,
    skipped,
    unresolved,
    alreadySet,
    excluded: excludedList,
    rejected: null,
  };
}

interface RemovalResolution {
  readonly selected: readonly string[];
  readonly changed: readonly ToolWriteChange[];
  readonly unresolved: readonly string[];
  readonly alreadySet: readonly string[];
  readonly excluded: readonly string[];
}

function resolveRemoval(
  context: { readonly host: ToolAccessHost; readonly state: AccessState; readonly action: 'remove' | 'deactivate' },
  parsed: ParsedSelection,
): RemovalResolution {
  const tools = context.host.getAllTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const membership = context.action === 'remove' ? context.state.base : context.state.dynamic;
  const excluded = excludedNames(parsed.excluded, tools);
  const unresolved: string[] = [...parsed.unresolved];
  const selected = new Set<string>();
  const changed: ToolWriteChange[] = [];
  for (const token of parsed.tokens) {
    if (token.kind === 'member') {
      if (byName.get(token.target.name) === undefined) { unresolved.push(token.raw); continue; }
      if (excluded.has(token.target.name)) continue;
      if (!membership.has(token.target.name)) continue;
      selected.add(token.target.name);
      changed.push({ ...token.target, affectedTools: [token.target.name] });
      continue;
    }
    const members = [...membership.keys()].filter((name) => {
      const tool = byName.get(name);
      return tool !== undefined && containerTargetForTool(tool)?.id === token.target.id && !excluded.has(name);
    });
    if (members.length === 0) continue;
    for (const name of members) selected.add(name);
    changed.push({ ...token.target, affectedTools: members });
  }
  const actions = context.action === 'remove' ? context.state.baseActions : context.state.dynamicActions;
  const alreadySet = [...selected].filter((name) => actions.get(`tool:${name}`) === context.action);
  return { selected: [...selected], changed, unresolved, alreadySet, excluded: [...excluded].sort() };
}

function emptyResult(
  action: ToolWriteAction,
  recordError: string | null,
  overrides: Partial<ToolWriteResult> = {},
): ToolWriteResult {
  return {
    action,
    changed: [],
    alreadySet: [],
    unresolved: [],
    skipped: recordError === null ? [] : [],
    affectedTools: [],
    selected: [],
    noSchema: [],
    schema: [],
    schemaWithheld: [],
    containers: [],
    excluded: [],
    rejected: null,
    activated: [],
    alreadyActive: [],
    removedActive: [],
    pendingCompaction: [],
    noticed: [],
    notRequested: [],
    stillBlacklisted: [],
    banOverridden: [],
    remainingSources: [],
    recordError,
    effectError: null,
    ...overrides,
  };
}

function postBranch(preBranch: readonly unknown[], durable: boolean, customType: string, payload: Record<string, unknown>): readonly unknown[] {
  return !durable ? preBranch : [...preBranch, { type: 'custom', customType, data: payload }];
}

function payloadOf(base: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (Array.isArray(value)) {
      if (value.length > 0) payload[key] = value;
      continue;
    }
    if (value !== undefined) payload[key] = value;
  }
  return payload;
}

function blacklistCoverage(view: ReturnType<typeof createToolAccessView>, names: readonly string[]): {
  readonly still: readonly string[];
  readonly sources: readonly ToolBlacklistSource[];
} {
  const still: string[] = [];
  const sources = new Set<ToolBlacklistSource>();
  for (const name of names) {
    const covering = view.blacklistSources(name);
    if (covering.length === 0) continue;
    still.push(name);
    for (const source of covering) sources.add(source);
  }
  return { still, sources: [...sources] };
}

function splitActiveRemoval(host: ToolAccessApplyHost, names: readonly string[], active: ReadonlySet<string>): {
  readonly now: readonly string[];
  readonly pending: readonly string[];
} {
  const declared = independentDeclarations(host);
  const tools = new Map(host.getAllTools().map((tool) => [tool.name, tool]));
  const now: string[] = [];
  const pending: string[] = [];
  for (const name of names) {
    if (!active.has(name)) continue;
    const independent = declared === null ? tools.get(name)?.exposure !== 'codemode' : declared.has(name);
    if (independent) pending.push(name);
    else now.push(name);
  }
  return { now, pending };
}

function applyActiveRemoval(host: ToolAccessApplyHost, names: readonly string[]): void {
  if (names.length === 0) return;
  const drop = new Set(names);
  host.setActiveTools(host.getActiveTools().filter((name) => !drop.has(name)));
}

function usedToolNames(branch: readonly unknown[]): ReadonlySet<string> {
  return extractUsedToolsFromWindow(extractWindowEntries(branch, null));
}

function appendBlacklistNotice(writer: ToolAccessWriter, names: readonly string[]): readonly string[] {
  const unique = [...new Set(names)];
  if (unique.length === 0) return [];
  try {
    writer.appendEntry(TOOL_BLACKLIST_NOTICE_RECORD, { version: TOOL_BLACKLIST_NOTICE_VERSION, names: unique });
    return unique;
  } catch { return []; }
}

/** Every tool name a blacklist notice has announced on this branch. */
export function blacklistedNoticeNames(branch: readonly unknown[] | null | undefined): Set<string> {
  const names = new Set<string>();
  for (const entry of branch ?? []) {
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== TOOL_BLACKLIST_NOTICE_RECORD) continue;
    const data = entry['data'];
    if (!isRecord(data) || data['version'] !== TOOL_BLACKLIST_NOTICE_VERSION) continue;
    for (const name of strings(data['names'])) names.add(name);
  }
  return names;
}

function activateSelected(host: ToolAccessApplyHost, names: readonly string[], view: ReturnType<typeof createToolAccessView>): {
  readonly activated: readonly string[];
  readonly alreadyActive: readonly string[];
  readonly skipped: readonly ToolWriteSkip[];
} {
  if (names.length === 0) return { activated: [], alreadyActive: [], skipped: [] };
  const outcome = activateToolNames(host, [...new Set(names)], { blocked: (name) => view.blocked(name) });
  return {
    activated: outcome.activated,
    alreadyActive: outcome.alreadyActive,
    skipped: outcome.skipped.map((skip: ActivationSkip) => ({ target: skip.name, reason: skip.reason })),
  };
}

function additionWrite(
  host: ToolAccessApplyHost,
  writer: ToolAccessWriter,
  branch: readonly unknown[] | null | undefined,
  targets: readonly string[],
  options: ToolWriteOptions,
  action: 'base-add' | 'activate',
): ToolWriteResult {
  const preBranch = [...(branch ?? [])];
  const state = replay(host, preBranch);
  const parsed = parseSelection(host, targets, options);
  const resolution = resolveAddition({
    host, preBranch, state, action: action === 'base-add' ? 'add' : 'activate',
  }, parsed);
  if (resolution.rejected !== null) {
    return emptyResult(action, null, { rejected: resolution.rejected, excluded: resolution.excluded });
  }
  const noSchemaModes = [...resolution.modes].filter(([, mode]) => mode === 'no-schema').map(([name]) => name);
  if (noSchemaModes.length > 0) {
    const pre = createToolAccessView(host, preBranch);
    const scope = createCapabilityScopeView(host);
    const active = new Set(host.getActiveTools());
    const codemodeUsable = active.has('codemode') && pre.facts('codemode').requested && scope.allows('codemode');
    const plan = planNoSchema({
      host: {
        getActiveTools: () => host.getActiveTools?.() ?? [],
        ...(host.getSettings === undefined ? {} : { getSettings: host.getSettings }),
      },
      branch: preBranch,
      // Explicit per-tool modes need no configured default refs.
      refs: [],
      selection: {
        mode: (name) => resolution.modes.get(name) ?? pre.schemaMode(name),
      },
      tools: host.getAllTools(),
      codemodeUsable,
    });
    if (!plan.active || !noSchemaModes.every((name) => plan.withheld.has(name))) {
      const reason = !plan.active
        ? (codemodeUsable ? 'mode_not_only' : 'codemode_unavailable')
        : 'tool_not_codemode_callable';
      return emptyResult(action, null, {
        selected: resolution.selected,
        noSchema: resolution.selected,
        excluded: resolution.excluded,
        rejected: {
          code: 'no_schema_unsupported',
          targets: ['--no-schema'],
          members: noSchemaModes.filter((name) => !plan.withheld.has(name)),
          reason,
        },
      });
    }
  }
  const recordType = action === 'base-add' ? TOOL_BASE_RECORD : TOOL_DYNAMIC_RECORD;
  const schemaModes = [...resolution.modes].filter(([, mode]) => mode === 'schema').map(([name]) => name);
  const modeFields = {
    ...(noSchemaModes.length === 0 ? {} : { noSchema: noSchemaModes }),
    ...(schemaModes.length === 0 ? {} : { schema: schemaModes }),
  };
  const payload = payloadOf(action === 'base-add'
    ? { version: TOOL_BASE_VERSION, load: resolution.loads.map((target) => target.target), add: resolution.selected, ...modeFields }
    : { version: TOOL_DYNAMIC_VERSION, load: resolution.loads.map((target) => target.target), activate: resolution.selected, ...modeFields });
  const recordError = resolution.changed.length === 0 ? null : appendRecord(writer, recordType, payload);
  if (recordError !== null) {
    return emptyResult(action, recordError, {
      unresolved: resolution.unresolved,
      excluded: resolution.excluded,
      alreadySet: resolution.alreadySet,
      skipped: resolution.changed.map((change) => ({ target: change.target, reason: 'record_error' as const })),
    });
  }
  const durable = resolution.changed.length > 0;
  const post = createToolAccessView(host, durable ? postBranch(preBranch, true, recordType, payload) : preBranch);
  let activation: { activated: readonly string[]; alreadyActive: readonly string[]; skipped: readonly ToolWriteSkip[] } =
    { activated: [], alreadyActive: [], skipped: [] };
  // The durable record already exists. An SDK effect failure is reported as
  // `effectError`; it must not escape and hide the recorded change.
  const effectError = applyEffect(() => {
    activation = activateSelected(host, resolution.selected.filter((name) => post.requested(name)), post);
  });
  const skipped: ToolWriteSkip[] = [...activation.skipped];
  for (const name of resolution.selected) {
    if (post.requested(name) || !post.blocked(name)) continue;
    if (!skipped.some((skip) => skip.target === name)) skipped.push({ target: name, reason: 'blacklisted' });
  }
  const coverage = blacklistCoverage(post, resolution.selected);
  return emptyResult(action, null, {
    changed: resolution.changed,
    alreadySet: resolution.alreadySet,
    unresolved: resolution.unresolved,
    skipped,
    affectedTools: resolution.selected,
    selected: resolution.selected,
    noSchema: noSchemaModes,
    schema: schemaModes,
    schemaWithheld: noSchemaModes.filter((name) => post.facts(name).schemaWithheld),
    containers: resolution.containers,
    excluded: resolution.excluded,
    activated: activation.activated,
    alreadyActive: activation.alreadyActive,
    stillBlacklisted: coverage.still,
    banOverridden: resolution.selected.filter((name) => post.banOverridden(name)),
    remainingSources: coverage.sources,
    effectError,
  });
}

function removalWrite(
  host: ToolAccessApplyHost,
  writer: ToolAccessWriter,
  branch: readonly unknown[] | null | undefined,
  targets: readonly string[],
  options: ToolWriteOptions,
  action: 'base-remove' | 'deactivate',
): ToolWriteResult {
  const preBranch = [...(branch ?? [])];
  const state = replay(host, preBranch);
  const parsed = parseSelection(host, targets, options);
  if (parsed.invalid.length > 0) {
    return emptyResult(action, null, {
      excluded: parsed.excluded,
      rejected: { code: 'invalid_selection', targets: parsed.invalid, members: [] },
    });
  }
  if (parsed.tokens.some((token) => token.modifiers.ns || token.modifiers.lazy !== null)) {
    return emptyResult(action, null, {
      excluded: parsed.excluded,
      rejected: { code: 'selection_not_supported', targets: parsed.tokens.map((token) => token.raw), members: [] },
    });
  }
  const resolution = resolveRemoval({ host, state, action: action === 'base-remove' ? 'remove' : 'deactivate' }, parsed);
  const recordType = action === 'base-remove' ? TOOL_BASE_RECORD : TOOL_DYNAMIC_RECORD;
  const payload = payloadOf(action === 'base-remove'
    ? { version: TOOL_BASE_VERSION, remove: resolution.selected }
    : { version: TOOL_DYNAMIC_VERSION, deactivate: resolution.selected });
  const recordError = resolution.changed.length === 0 ? null : appendRecord(writer, recordType, payload);
  if (recordError !== null) {
    return emptyResult(action, recordError, {
      unresolved: resolution.unresolved,
      excluded: resolution.excluded,
      skipped: resolution.changed.map((change) => ({ target: change.target, reason: 'record_error' as const })),
    });
  }
  const durable = resolution.changed.length > 0;
  const post = createToolAccessView(host, durable ? postBranch(preBranch, true, recordType, payload) : preBranch);
  const active = new Set(host.getActiveTools());
  const dropping = resolution.selected.filter((name) => !post.requested(name) && active.has(name));
  const split = splitActiveRemoval(host, dropping, active);
  const effectError = applyEffect(() => applyActiveRemoval(host, split.now));
  const coverage = blacklistCoverage(post, resolution.selected);
  return emptyResult(action, null, {
    changed: resolution.changed,
    alreadySet: resolution.alreadySet,
    unresolved: resolution.unresolved,
    affectedTools: resolution.selected,
    selected: resolution.selected,
    excluded: resolution.excluded,
    removedActive: effectError === null ? split.now : [],
    pendingCompaction: split.pending,
    stillBlacklisted: coverage.still,
    remainingSources: coverage.sources,
    effectError,
  });
}

export function addBaseTools(host: ToolAccessApplyHost, writer: ToolAccessWriter, branch: readonly unknown[] | null | undefined, targets: readonly string[], options: ToolWriteOptions = {}): ToolWriteResult {
  return additionWrite(host, writer, branch, targets, options, 'base-add');
}

export function removeBaseTools(host: ToolAccessApplyHost, writer: ToolAccessWriter, branch: readonly unknown[] | null | undefined, targets: readonly string[], options: ToolWriteOptions = {}): ToolWriteResult {
  return removalWrite(host, writer, branch, targets, options, 'base-remove');
}

export function activateToolTargets(host: ToolAccessApplyHost, writer: ToolAccessWriter, branch: readonly unknown[] | null | undefined, targets: readonly string[], options: ToolWriteOptions = {}): ToolWriteResult {
  return additionWrite(host, writer, branch, targets, options, 'activate');
}

export function deactivateToolTargets(host: ToolAccessApplyHost, writer: ToolAccessWriter, branch: readonly unknown[] | null | undefined, targets: readonly string[], options: ToolWriteOptions = {}): ToolWriteResult {
  return removalWrite(host, writer, branch, targets, options, 'deactivate');
}

function blacklistWrite(
  host: ToolAccessApplyHost,
  writer: ToolAccessWriter,
  branch: readonly unknown[] | null | undefined,
  targets: readonly string[],
  action: 'blacklist-add' | 'blacklist-remove',
): ToolWriteResult {
  const preBranch = [...(branch ?? [])];
  const state = replay(host, preBranch);
  const tools = host.getAllTools();
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const selectionSyntax = targets.filter((raw) => raw.includes('[') || raw.startsWith('-') || raw === '--schema' || raw === '--no-schema');
  if (selectionSyntax.length > 0) {
    return emptyResult(action, null, {
      rejected: { code: 'selection_not_supported', targets: selectionSyntax, members: [] },
    });
  }
  const resolved: { target: ToolTarget; affectedTools: readonly string[] }[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const target = parseToolTarget(raw);
    if (target === null) { unresolved.push(raw.trim()); continue; }
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    const affectedTools = memberNames(target, tools);
    if (affectedTools.length === 0) { unresolved.push(target.target); continue; }
    resolved.push({ target, affectedTools });
  }
  const expected = action === 'blacklist-add' ? 'add' : 'remove';
  const changed = resolved.filter((item) => state.blacklistActions.get(item.target.id) !== expected);
  const alreadySet = resolved.filter((item) => state.blacklistActions.get(item.target.id) === expected).map((item) => item.target.target);
  const payload = payloadOf({ version: TOOL_BLACKLIST_VERSION, [expected]: changed.map((item) => item.target.target) });
  const recordError = changed.length === 0 ? null : appendRecord(writer, TOOL_BLACKLIST_RECORD, payload);
  if (recordError !== null) {
    return emptyResult(action, recordError, {
      unresolved,
      skipped: changed.map((item) => ({ target: item.target.target, reason: 'record_error' as const })),
    });
  }
  const post = createToolAccessView(host, changed.length === 0 ? preBranch : postBranch(preBranch, true, TOOL_BLACKLIST_RECORD, payload));
  const affected = [...new Set(resolved.flatMap((item) => item.affectedTools))];
  const active = new Set(host.getActiveTools());
  const coverage = blacklistCoverage(post, affected);
  const changedTargets = changed.map((item) => ({ ...item.target, affectedTools: item.affectedTools }));
  if (action === 'blacklist-add') {
    const dropping = affected.filter((name) => !post.requested(name) && active.has(name));
    const split = splitActiveRemoval(host, dropping, active);
    const effectError = applyEffect(() => applyActiveRemoval(host, split.now));
    const used = usedToolNames(preBranch);
    const noticed = appendBlacklistNotice(writer, affected.filter((name) => active.has(name) && used.has(name) && post.blocked(name)));
    return emptyResult(action, null, {
      changed: changedTargets,
      alreadySet,
      unresolved,
      affectedTools: affected,
      selected: [],
      removedActive: effectError === null ? split.now : [],
      pendingCompaction: split.pending,
      noticed,
      stillBlacklisted: coverage.still,
      banOverridden: affected.filter((name) => post.banOverridden(name)),
      remainingSources: coverage.sources,
      effectError,
    });
  }
  const restored = affected.filter((name) => post.requested(name));
  let activation: { activated: readonly string[]; alreadyActive: readonly string[]; skipped: readonly ToolWriteSkip[] } =
    { activated: [], alreadyActive: [], skipped: [] };
  const effectError = applyEffect(() => { activation = activateSelected(host, restored, post); });
  const notRequested = affected.filter((name) => !post.requested(name));
  return emptyResult(action, null, {
    changed: changedTargets,
    alreadySet,
    unresolved,
    affectedTools: affected,
    selected: [],
    activated: activation.activated,
    alreadyActive: activation.alreadyActive,
    skipped: activation.skipped,
    notRequested,
    stillBlacklisted: coverage.still,
    banOverridden: affected.filter((name) => post.banOverridden(name)),
    remainingSources: coverage.sources,
    effectError,
  });
}

export function addBlacklistTargets(host: ToolAccessApplyHost, writer: ToolAccessWriter, branch: readonly unknown[] | null | undefined, targets: readonly string[]): ToolWriteResult {
  return blacklistWrite(host, writer, branch, targets, 'blacklist-add');
}

export function removeBlacklistTargets(host: ToolAccessApplyHost, writer: ToolAccessWriter, branch: readonly unknown[] | null | undefined, targets: readonly string[]): ToolWriteResult {
  return blacklistWrite(host, writer, branch, targets, 'blacklist-remove');
}

/** Capture the startup availability baseline once. */
export function ensureToolBase(host: ToolAccessApplyHost, writer: ToolAccessWriter, branch: readonly unknown[] | null | undefined): readonly string[] {
  const entries = branch ?? [];
  const recorded: string[] = [];
  let hasBaseline = false;
  for (const entry of entries) {
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== TOOL_BASE_RECORD) continue;
    const record = parseBaseRecord(entry['data']);
    if (record === null || !isRecord(entry['data']) || !Array.isArray(entry['data']['baseline'])) continue;
    hasBaseline = true;
    for (const name of record.baseline) if (!recorded.includes(name)) recorded.push(name);
  }
  if (hasBaseline) return recorded;
  const view = createToolAccessView(host, entries);
  const tools = new Map(host.getAllTools().map((tool) => [tool.name, tool]));
  const captured = host.getActiveTools().filter((name) => {
    const tool = tools.get(name);
    if (tool === undefined || tool.exposure === 'hidden') return false;
    // Startup baseline capture uses the RAW blacklist: an active default tool
    // must not become an explicit whitelist entry merely because it was live at
    // session start. Only a later explicit base record overrides a local ban.
    return !view.removalPending(name) && !view.blacklisted(name);
  });
  const loads = [...new Set(captured.flatMap((name) => {
    const tool = tools.get(name);
    const target = tool === undefined ? null : containerTargetForTool(tool);
    return target === null ? [] : [target.target];
  }))];
  writer.appendEntry(TOOL_BASE_RECORD, payloadOf({ version: TOOL_BASE_VERSION, baseline: captured, load: loads }));
  return captured;
}

/** Recompute the live active set from the collections, reporting SDK-accepted names. */
export function syncActiveToolsToCollections(host: ToolAccessApplyHost, branch: readonly unknown[] | null | undefined): ToolSyncResult {
  const view = createToolAccessView(host, branch);
  const catalog = createEligibleToolCatalog(host, { blocked: (tool) => !view.requested(tool.name) });
  const requested = catalog.tools.map((tool) => tool.name);
  const before = new Set(host.getActiveTools());
  host.setActiveTools(requested);
  const accepted = new Set(host.getActiveTools());
  const active = requested.filter((name) => accepted.has(name));
  const next = new Set(active);
  return { active, activated: active.filter((name) => !before.has(name)), removed: [...before].filter((name) => !next.has(name)) };
}

/** The active set after a successful compaction. */
export function activeToolsAfterCollections(host: ToolAccessApplyHost, branch: readonly unknown[] | null | undefined, active: readonly string[]): string[] {
  const view = createToolAccessView(host, branch);
  return active.filter((name) => {
    if (view.blocked(name)) return false;
    if (view.requested(name)) return true;
    return !view.removalPending(name);
  });
}

export type { ToolTargetRecord, ToolContainer, AccessState };
