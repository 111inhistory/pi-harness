/**
 * One operation's read view over the replayed tool-availability records.
 *
 * Membership is concrete tool names; loaded namespace/MCP containers are a
 * separate metadata dimension. This module is read-only: it combines the
 * durable replay with one registry snapshot, one scope view and the active set.
 */

import { effectiveCodemodeMode } from './codemode-mode.ts';
import { matchesLazySchemaRef, parseLazySchemaRefs, type LazySchemaRefs } from './lazy-schemas.ts';
import { createCapabilityScopeView, type CapabilityScopeView } from './scope.ts';
import { matchesToolTarget, type ToolTarget, type ToolTargetKind, type ToolTargetRecord } from './targets.ts';
import { classifyTool, isMcpTool, type ToolCategory } from './tool-classify.ts';
import { toolReachability } from './activation.ts';
import { replay, type AccessState, type Contribution } from './tool-access-replay.ts';

/** The host surface reads need. */
export interface ToolAccessHost {
  getAllTools(): readonly ToolTargetRecord[];
  /** Optional for a pure read host; a query then defaults to no active tools. */
  getActiveTools?(): readonly string[];
  /** Effective Codemode mode; absent means the settings value is unknown. */
  getSettings?(): { readonly codemode?: { readonly mode?: string } | undefined } | undefined;
}

/** One target resolved against the live registry. */
export interface ResolvedToolTarget {
  readonly target: ToolTarget;
  readonly affectedTools: readonly string[];
}

/** The independent facts of one tool or target. */
export interface ToolAccessFacts {
  readonly base: boolean;
  readonly dynamic: boolean;
  /** Raw stored blacklist fact; base does not delete it. */
  readonly blacklisted: boolean;
  readonly blacklistSources: readonly ('startup' | 'preset' | 'branch')[];
  /** Effective prohibition: outer fences always, local bans only without base. */
  readonly blocked: boolean;
  /** A local ban is stored but a base member overrides it now. */
  readonly banOverridden: boolean;
  readonly requested: boolean;
  /** Explicit per-tool mode requested by the latest record. */
  readonly schemaMode: 'no-schema' | 'schema' | null;
  /** The mode is noSchema and the live lazy projection actually withholds it now. */
  readonly schemaWithheld: boolean;
}

/** One loaded namespace/MCP container with its live metadata context. */
export interface ToolContainer {
  readonly target: string;
  readonly kind: 'namespace' | 'mcp';
  readonly name: string;
  readonly id: string;
  readonly sources: readonly ('baseline' | 'preset' | 'branch' | 'discovery' | 'activation')[];
  /** Registered, non-hidden tool names of the container in the current registry. */
  readonly members: readonly string[];
  /** Names currently in base or dynamic membership. */
  readonly selected: readonly string[];
  /** A container-level blacklist rule covers the whole container. */
  readonly blocked: boolean;
  readonly description?: string | undefined;
  readonly instructions?: string | undefined;
}

/** One base target (concrete name or loaded container) and its source. */
export interface ToolCollectionTarget {
  readonly target: ToolTarget;
  readonly sources: readonly ('baseline' | 'preset' | 'branch')[];
  readonly affectedTools: readonly string[];
}

/** One dynamic target (concrete name or loaded container) and its source. */
export interface ToolDynamicTarget {
  readonly target: ToolTarget;
  readonly sources: readonly ('discovery' | 'activation' | 'branch')[];
  readonly affectedTools: readonly string[];
}

/** One blacklist target with the sources that currently prohibit it. */
export interface ToolBlacklistTarget {
  readonly target: ToolTarget;
  readonly sources: readonly ('startup' | 'preset' | 'branch')[];
  readonly affectedTools: readonly string[];
}

/** One operation's read-only availability view. */
export interface ToolAccessView {
  readonly base: (name: string) => boolean;
  readonly dynamic: (name: string) => boolean;
  /** Raw stored blacklist, for display; never deleted by a base add. */
  readonly blacklisted: (name: string) => boolean;
  readonly blacklistSources: (name: string) => readonly ('startup' | 'preset' | 'branch')[];
  /** Effective prohibition after the base exception; use this for authority. */
  readonly blocked: (name: string) => boolean;
  readonly banOverridden: (name: string) => boolean;
  readonly requested: (name: string) => boolean;
  readonly schemaMode: (name: string) => 'no-schema' | 'schema' | null;
  /** True only while Codemode is active and the effective mode is `only`. */
  readonly projectionActive: boolean;
  readonly facts: (name: string) => ToolAccessFacts;
  readonly factsFor: (tool: ToolTargetRecord) => ToolAccessFacts;
  readonly baseTargets: readonly ToolCollectionTarget[];
  readonly dynamicTargets: readonly ToolDynamicTarget[];
  readonly blacklistTargets: readonly ToolBlacklistTarget[];
  readonly loadedContainers: readonly ToolContainer[];
  readonly removalPending: (name: string) => boolean;
  /** True only before any base record exists (native pre-record startup window). */
  readonly preRecord: boolean;
}

/** Options for one availability query. */
export interface ToolAccessQueryOptions {
  /** Expand the requested population with tools that could be activated now. */
  readonly includeActivatable?: boolean;
  /** Replace the population with tools that are currently callable. */
  readonly includeUsable?: boolean;
  readonly filter?: string;
  readonly category?: ToolCategory;
  /** Configured lazy refs, used only to expose the config default per tool. */
  readonly schemaRefs?: readonly string[];
}

/** One listed tool with its independent facts. */
export interface ToolAccessListing {
  readonly name: string;
  readonly category: ToolCategory;
  readonly display: string;
  readonly description: string;
  readonly group: string;
  readonly registered: boolean;
  readonly eligible: boolean;
  readonly active: boolean;
  readonly base: boolean;
  readonly dynamic: boolean;
  readonly blacklisted: boolean;
  readonly blacklistSources: readonly ('startup' | 'preset' | 'branch')[];
  readonly blocked: boolean;
  readonly banOverridden: boolean;
  /** Registered, eligible, not blacklisted, reachable and not active now. */
  readonly activatable: boolean;
  /** Currently effective: requested, eligible, registered, active and not blacklisted. */
  readonly usable: boolean;
  /** Latest explicit branch override for this tool (null = none). */
  readonly schemaMode: 'no-schema' | 'schema' | null;
  /** The configured lazy default explicitly marks this tool/group (not an override). */
  readonly configLazy: boolean;
  /** The schema is actually withheld right now (noSchema + live only-mode projection). */
  readonly schemaWithheld: boolean;
}

/** Query output shared by the command and the RPC adapter. */
export interface ToolAccessQueryResult {
  readonly entries: readonly ToolAccessListing[];
  readonly base: readonly ToolCollectionTarget[];
  readonly dynamic: readonly ToolDynamicTarget[];
  readonly blacklist: readonly ToolBlacklistTarget[];
  readonly containers: readonly ToolContainer[];
}

interface Compiled<TSource extends string> {
  readonly exact: Map<string, ReadonlySet<TSource>>;
  readonly groups: readonly { readonly target: ToolTarget; readonly sources: ReadonlySet<TSource> }[];
}

function compile<TSource extends string>(entries: Map<string, Contribution<TSource>>): Compiled<TSource> {
  const exact = new Map<string, ReadonlySet<TSource>>();
  const groups: { target: ToolTarget; sources: ReadonlySet<TSource> }[] = [];
  for (const { target, sources } of entries.values()) {
    if (target.kind === 'tool') exact.set(target.name, sources);
    else groups.push({ target, sources });
  }
  return { exact, groups };
}

function lookup<TSource extends string>(
  compiled: Compiled<TSource>,
  name: string,
  tool: ToolTargetRecord | undefined,
): ReadonlySet<TSource> | null {
  const exact = compiled.exact.get(name);
  if (exact !== undefined) return exact;
  const sources = new Set<TSource>();
  for (const group of compiled.groups) {
    if (!matchesToolTarget(group.target, tool, name)) continue;
    for (const source of group.sources) sources.add(source);
  }
  return sources.size === 0 ? null : sources;
}

/** Registered names one target currently covers; exact targets keep hidden ones. */
export function memberNames(target: ToolTarget, tools: readonly ToolTargetRecord[]): string[] {
  return tools
    .filter((tool) => matchesToolTarget(target, tool, tool.name) && (target.kind === 'tool' || tool.exposure !== 'hidden'))
    .map((tool) => tool.name);
}

/**
 * The canonical container identity of one registered tool: a plain namespace
 * maps to `namespace://<name>`, an MCP namespace to `mcp://<server alias>`.
 */
export function containerTargetForTool(tool: {
  readonly name: string;
  readonly namespace?: { readonly name: string; readonly aliases?: readonly string[] } | undefined;
}): ToolTarget | null {
  const namespace = tool.namespace;
  if (namespace === undefined) return null;
  if (namespace.name.startsWith('mcp__')) {
    const server = namespace.aliases?.[0] ?? namespace.name.slice('mcp__'.length);
    return { target: `mcp://${server}`, kind: 'mcp', name: server, id: `mcp:${server}` };
  }
  return { target: `namespace://${namespace.name}`, kind: 'namespace', name: namespace.name, id: `namespace:${namespace.name}` };
}

/** Canonicalize a parsed container target against the live registry aliases. */
export function canonicalContainerTarget(
  target: ToolTarget,
  tools: readonly ToolTargetRecord[],
): ToolTarget {
  if (target.kind !== 'namespace' && target.kind !== 'mcp') return target;
  const wanted = target.name;
  for (const tool of tools) {
    const namespace = tool.namespace;
    if (namespace === undefined) continue;
    const names = [namespace.name, ...(namespace.aliases ?? [])];
    if (!names.includes(wanted)) continue;
    const canonical = containerTargetForTool(tool);
    if (canonical !== null) return canonical;
  }
  return target;
}

/** Build one operation's availability view; never cached across operations. */
export function createToolAccessView(
  host: ToolAccessHost,
  branch: readonly unknown[] | null | undefined,
  /** An already-read catalog snapshot, so an operation does not read it twice. */
  snapshot?: readonly ToolTargetRecord[],
  /** An already-resolved scope view from the same operation. */
  scopeView?: CapabilityScopeView,
): ToolAccessView {
  const state: AccessState = replay(host, branch);
  const tools = snapshot ?? host.getAllTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const scope = scopeView ?? createCapabilityScopeView(host);
  // At a chain root the configured startup blacklist is a LOCAL policy and a
  // base member overrides it. In a child it comes from the ancestor chain and
  // is an external fence no child base can lift. Preset/branch bans are always
  // local to this session.
  const localEntries = new Map<string, Contribution<'startup' | 'preset' | 'branch'>>();
  const ancestorEntries = new Map<string, Contribution<'startup' | 'preset' | 'branch'>>();
  for (const { target, sources } of state.blacklist.values()) {
    const local: ('startup' | 'preset' | 'branch')[] = [];
    for (const source of sources) {
      if (!scope.root && source === 'startup') {
        // Ancestor config remains an external fence; a child base cannot lift
        // it. This is deliberately the raw ancestor ban for now (no inherited
        // base-override authorization).
        const existing = ancestorEntries.get(target.id);
        if (existing === undefined) ancestorEntries.set(target.id, { target, sources: new Set(['startup']) });
        else existing.sources.add('startup');
      } else local.push(source);
    }
    if (local.length === 0) continue;
    const existing = localEntries.get(target.id);
    if (existing === undefined) localEntries.set(target.id, { target, sources: new Set(local) });
    else for (const source of local) existing.sources.add(source);
  }
  const blacklist = compile(state.blacklist);
  const localBlacklist = compile(localEntries);
  const ancestorBlacklist = compile(ancestorEntries);
  const cache = new Map<string, ToolAccessFacts>();
  const preRecord = !state.baselineRecorded && state.base.size === 0;
  let settingsMode: string | undefined;
  try {
    settingsMode = host.getSettings?.()?.codemode?.mode;
  } catch {
    settingsMode = undefined;
  }
  const projectionActive = (host.getActiveTools?.() ?? []).includes('codemode')
    && effectiveCodemodeMode(branch, settingsMode) === 'only';
  const removed = (name: string, tool: ToolTargetRecord | undefined): boolean =>
    state.removalIntents.some((target) => matchesToolTarget(target, tool, name));

  const factsOf = (name: string, tool: ToolTargetRecord | undefined): ToolAccessFacts => {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const blacklistSources = lookup(blacklist, name, tool);
    const explicitBase = state.base.has(name);
    const baseMember = explicitBase
      || (preRecord && tool !== undefined && tool.exposure !== 'hidden' && !isMcpTool(name) && !removed(name, tool));
    const ancestorBlocked = lookup(ancestorBlacklist, name, tool) !== null;
    const locallyBanned = lookup(localBlacklist, name, tool) !== null;
    // Only an explicit base record overrides a local ban; the implicit
    // pre-record startup window is availability, not a user whitelist.
    const blocked = ancestorBlocked || (locallyBanned && !explicitBase);
    const banOverridden = explicitBase && locallyBanned && !ancestorBlocked;
    const mode = state.schemaModes.get(name) ?? null;
    const requested = (baseMember || state.dynamic.has(name)) && !blocked;
    const facts: ToolAccessFacts = {
      base: baseMember,
      dynamic: state.dynamic.has(name),
      blacklisted: blacklistSources !== null,
      blacklistSources: blacklistSources === null ? [] : [...blacklistSources] as ('startup' | 'preset' | 'branch')[],
      blocked,
      banOverridden,
      requested,
      schemaMode: mode,
      schemaWithheld: mode === 'no-schema' && projectionActive && requested
        && tool !== undefined && tool.exposure !== 'model-only',
    };
    cache.set(name, facts);
    return facts;
  };
  const facts = (name: string): ToolAccessFacts => factsOf(name, byName.get(name));
  const factsFor = (tool: ToolTargetRecord): ToolAccessFacts => factsOf(tool.name, tool);

  const nameTargets = <TSource extends string>(entries: Map<string, ReadonlySet<TSource>>): { target: ToolTarget; sources: readonly TSource[]; affectedTools: readonly string[] }[] =>
    [...entries].map(([name, sources]) => ({
      target: { target: name, kind: 'tool' as ToolTargetKind, name, id: `tool:${name}` },
      sources: [...sources].sort() as TSource[],
      affectedTools: [name],
    }));
  const loadTargets = <TSource extends string>(
    loads: Map<string, Contribution<TSource>>,
    extra: readonly string[],
  ): { target: ToolTarget; sources: readonly TSource[]; affectedTools: readonly string[] }[] => {
    const seen = new Map<string, { target: ToolTarget; sources: Set<string> }>();
    for (const { target, sources } of loads.values()) {
      const entry = seen.get(target.id) ?? { target, sources: new Set<string>() };
      for (const source of sources) entry.sources.add(source);
      seen.set(target.id, entry);
    }
    for (const name of extra) {
      const tool = byName.get(name);
      const target = tool === undefined ? null : containerTargetForTool(tool);
      if (target === null) continue;
      const entry = seen.get(target.id) ?? { target, sources: new Set<string>() };
      entry.sources.add('branch');
      seen.set(target.id, entry);
    }
    return [...seen.values()].map(({ target, sources }) => ({
      target,
      sources: [...sources].sort() as TSource[],
      affectedTools: memberNames(target, tools),
    }));
  };

  const loadedContainers = (): ToolContainer[] => {
    const merged = new Map<string, { target: ToolTarget; sources: Set<string> }>();
    const add = (target: ToolTarget, sources: Iterable<string>): void => {
      const entry = merged.get(target.id) ?? { target, sources: new Set<string>() };
      for (const source of sources) entry.sources.add(source);
      merged.set(target.id, entry);
    };
    for (const { target, sources } of [...state.baseLoads.values(), ...state.dynamicLoads.values()]) add(target, sources);
    for (const [name, sources] of [...state.base, ...state.dynamic]) {
      const tool = byName.get(name);
      const target = tool === undefined ? null : containerTargetForTool(tool);
      if (target !== null) add(target, sources);
    }
    // No loaded or member-implied container means no scope read at all; the
    // common empty-branch path must not add a second catalog scan.
    if (merged.size === 0) return [];
    const containers: ToolContainer[] = [];
    for (const { target, sources } of merged.values()) {
      const members = memberNames(target, tools);
      if (members.length > 0 && !members.some((name) => scope.allows(name))) continue;
      const namespaceName = target.kind === 'mcp' && members.length > 0
        ? byName.get(members[0]!)?.namespace?.name
        : target.name;
      const sample = members.length > 0 ? byName.get(members[0]!) : undefined;
      const ruleKind = target.kind === 'mcp' ? 'mcp' : 'namespace';
      const containerRule = [...state.blacklist.values()]
        .some(({ target: rule }) => rule.kind === ruleKind && rule.name === target.name);
      // A container ban is effective only when it still blocks every current
      // member; an explicit base member overrides the local ban and keeps the
      // namespace guide alive.
      const blocked = containerRule && (members.length === 0
        ? true
        : members.every((name) => facts(name).blocked));
      containers.push({
        target: target.target,
        kind: target.kind === 'mcp' ? 'mcp' : 'namespace',
        name: namespaceName ?? target.name,
        id: target.id,
        sources: [...sources].sort() as ToolContainer['sources'],
        members,
        selected: members.filter((name) => state.base.has(name) || state.dynamic.has(name)),
        blocked,
        description: sample?.namespace?.description,
        instructions: sample?.namespace?.instructions,
      });
    }
    return containers;
  };

  const containerList = loadedContainers();
  return {
    base: (name) => facts(name).base,
    dynamic: (name) => facts(name).dynamic,
    blacklisted: (name) => facts(name).blacklisted,
    blacklistSources: (name) => facts(name).blacklistSources,
    blocked: (name) => facts(name).blocked,
    banOverridden: (name) => facts(name).banOverridden,
    requested: (name) => facts(name).requested,
    schemaMode: (name) => facts(name).schemaMode,
    projectionActive,
    facts,
    factsFor,
    baseTargets: [...nameTargets(state.base), ...loadTargets(state.baseLoads, [])],
    dynamicTargets: [...nameTargets(state.dynamic), ...loadTargets(state.dynamicLoads, [])],
    blacklistTargets: [...state.blacklist.values()].map(({ target, sources }) => ({
      target, sources: [...sources], affectedTools: memberNames(target, tools),
    })),
    loadedContainers: containerList,
    removalPending: (name) => removed(name, byName.get(name)),
    preRecord,
  };
}

function matchesFilter(needle: string, listing: ToolAccessListing): boolean {
  if (needle === '') return true;
  return listing.name.toLowerCase().includes(needle)
    || listing.display.toLowerCase().includes(needle)
    || listing.description.toLowerCase().includes(needle)
    || listing.group.toLowerCase().includes(needle);
}

/** Query availability. */
export function queryToolAccess(
  host: ToolAccessHost,
  branch: readonly unknown[] | null | undefined,
  activeSet?: readonly string[],
  options: ToolAccessQueryOptions = {},
): ToolAccessQueryResult {
  const view = createToolAccessView(host, branch);
  const tools = host.getAllTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const active = new Set(activeSet ?? host.getActiveTools?.() ?? []);
  const scope = createCapabilityScopeView(host);
  const lazyRefs: LazySchemaRefs = parseLazySchemaRefs(options.schemaRefs);
  const codemodeFacts = view.facts('codemode');
  const codemodeAvailable = active.has('codemode') && codemodeFacts.requested && scope.allows('codemode');
  const eligible = (name: string): boolean => {
    const tool = byName.get(name);
    return tool !== undefined && tool.exposure !== 'hidden' && scope.allows(name);
  };
  const reachable = (name: string): boolean => {
    const tool = byName.get(name);
    return tool !== undefined && toolReachability(tool.exposure, { codemodeAvailable }) === null;
  };

  const names = new Set<string>();
  for (const name of view.baseTargets.flatMap((entry) => entry.target.kind === 'tool' ? [entry.target.name] : entry.affectedTools)) {
    if (view.facts(name).requested) names.add(name);
  }
  for (const name of view.dynamicTargets.flatMap((entry) => entry.target.kind === 'tool' ? [entry.target.name] : entry.affectedTools)) {
    if (view.facts(name).requested) names.add(name);
  }
  if (view.preRecord) {
    for (const tool of tools) if (view.factsFor(tool).requested) names.add(tool.name);
  }
  if (options.includeUsable === true) names.clear();
  if (options.includeActivatable === true) {
    for (const tool of tools) {
      if (tool.exposure === 'hidden') continue;
      const facts = view.factsFor(tool);
      if (!facts.blocked && !active.has(tool.name) && scope.allows(tool.name) && reachable(tool.name)) names.add(tool.name);
    }
  }
  if (options.includeUsable === true) {
    for (const tool of tools) {
      if (tool.exposure === 'hidden' || !active.has(tool.name)) continue;
      const facts = view.factsFor(tool);
      if (facts.requested && !facts.blocked && scope.allows(tool.name) && reachable(tool.name)) names.add(tool.name);
    }
  }

  const needle = (options.filter ?? '').trim().toLowerCase();
  const entries: ToolAccessListing[] = [];
  for (const name of names) {
    const tool = byName.get(name);
    const facts = view.factsFor(tool ?? { name });
    const classification = tool === undefined ? { category: 'tool' as ToolCategory, display: name, group: 'Tools' } : classifyTool(tool);
    const isActive = active.has(name);
    const isEligible = eligible(name);
    const description = tool === undefined ? undefined : (tool as { readonly description?: unknown }).description;
    const listing: ToolAccessListing = {
      name,
      category: classification.category,
      display: classification.display,
      description: typeof description === 'string' ? description : '',
      group: classification.group,
      registered: tool !== undefined,
      eligible: isEligible,
      active: isActive,
      base: facts.base,
      dynamic: facts.dynamic,
      blacklisted: facts.blacklisted,
      blacklistSources: facts.blacklistSources,
      blocked: facts.blocked,
      banOverridden: facts.banOverridden,
      activatable: tool !== undefined && isEligible && !facts.blocked && !isActive && reachable(name),
      usable: tool !== undefined && isEligible && isActive && facts.requested && reachable(name),
      schemaMode: facts.schemaMode,
      configLazy: matchesLazySchemaRef(lazyRefs, name, tool?.namespace),
      schemaWithheld: facts.schemaWithheld && isActive,
    };
    if (options.category !== undefined && listing.category !== options.category) continue;
    if (!matchesFilter(needle, listing)) continue;
    entries.push(listing);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return {
    entries,
    base: view.baseTargets,
    dynamic: view.dynamicTargets,
    blacklist: view.blacklistTargets,
    containers: view.loadedContainers,
  };
}

/** Concrete base/dynamic membership targets plus loaded container entries. */
export function listBaseTools(host: ToolAccessHost, branch: readonly unknown[] | null | undefined): readonly ToolCollectionTarget[] {
  return createToolAccessView(host, branch).baseTargets;
}

/** Effective blacklist target rules with their sources. */
export function listBlacklist(host: ToolAccessHost, branch: readonly unknown[] | null | undefined): readonly ToolBlacklistTarget[] {
  return createToolAccessView(host, branch).blacklistTargets;
}

/** Loaded namespace/MCP containers filtered to current scope and container bans. */
export function listLoadedContainers(host: ToolAccessHost, branch: readonly unknown[] | null | undefined): readonly ToolContainer[] {
  return createToolAccessView(host, branch).loadedContainers;
}
