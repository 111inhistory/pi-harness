/**
 * Capability eligibility: ancestor negative fences (denials and startup
 * blacklist patterns) are inherited down the subagent chain, while positive
 * tool registration, declaration, and activation belong to each session.
 *
 * A child may discover and use tools that its parent does not have, as long as
 * no ancestor denies them (via root blacklist or ancestor role/preset
 * exclusions). `allows(name)` answers the negative fence check for any name,
 * including unregistered names.
 *
 * The parent source may be a resolver so a revived child looks up the current
 * parent API instead of the one captured at construction. A cyclic chain fails
 * closed instead of recursing forever.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** The only shape this module needs from a registered tool. */
export interface CapabilityScopedTool {
  readonly name: string;
  readonly exposure?: string | undefined;
  readonly namespace?: { readonly name: string } | undefined;
}

/** Minimal structural tool catalog; an ExtensionAPI satisfies it. */
export interface CapabilityToolCatalog {
  getAllTools(): readonly CapabilityScopedTool[];
  /** Native extensions in one resource loader share a bus, not an API object. */
  readonly events?: ExtensionAPI['events'];
}

/** Resolves the current parent API; revival replaces the value, not the link. */
export type CapabilityParentResolver = () => CapabilityToolCatalog | null | undefined;

export type CapabilityParentSource =
  | CapabilityToolCatalog
  | CapabilityParentResolver
  | null
  | undefined;

/** Optional dynamic denial predicate evaluated against an ancestor's live rules. */
export type CapabilityScopeDenialPredicate = (name: string, tool?: CapabilityScopedTool) => boolean;

/**
 * Qualification for one synchronous operation.
 */
export interface CapabilityScopeView {
  readonly allows: (name: string) => boolean;
  /** Whether this view's catalog is the chain root (it has no parent). */
  readonly root: boolean;
}

interface ScopeState {
  parent: CapabilityParentSource;
  denied: ReadonlySet<string>;
  deniedPredicate?: CapabilityScopeDenialPredicate | undefined;
  /** Configured blacklist patterns (startup source); only the chain root sets them. */
  startupBlacklist: readonly string[];
}

interface ScopeNode {
  readonly catalog: CapabilityToolCatalog;
  readonly state: ScopeState;
}

const scopes = new WeakMap<CapabilityToolCatalog, ScopeState>();
const SCOPE_CHANNEL = 'pi-harness:capability-scope';
interface ScopeExchange { state?: ScopeState }
const NO_DENIALS: ReadonlySet<string> = new Set<string>();

function stateFor(pi: CapabilityToolCatalog): ScopeState {
  let state = scopes.get(pi);
  if (state === undefined) {
    const exchange: ScopeExchange = {};
    pi.events?.emit(SCOPE_CHANNEL, exchange);
    state = exchange.state ?? { parent: null, denied: NO_DENIALS, startupBlacklist: [] };
    scopes.set(pi, state);
    if (exchange.state === undefined) {
      const shared = state;
      pi.events?.on(SCOPE_CHANNEL, data => { (data as ScopeExchange).state = shared; });
    }
  }
  return state;
}

function resolvedParent(state: ScopeState): CapabilityToolCatalog | null {
  const source = state.parent;
  const parent = typeof source === "function" ? source() : source;
  return parent ?? null;
}

/** Root-first ancestor chain, resolving every parent link once. */
function ancestorChain(pi: CapabilityToolCatalog): ScopeNode[] {
  const chain: ScopeNode[] = [];
  const seen = new Set<CapabilityToolCatalog>();
  let current: CapabilityToolCatalog | null = pi;
  while (current !== null) {
    if (seen.has(current)) {
      throw new Error("capability scope parent chain contains a cycle");
    }
    seen.add(current);
    const state = stateFor(current);
    chain.push({ catalog: current, state });
    current = resolvedParent(state);
  }
  chain.reverse();
  return chain;
}

/**
 * Resolve this scope's ancestor negative fences once and return a view for
 * one synchronous operation.
 */
export function createCapabilityScopeView(pi: CapabilityToolCatalog): CapabilityScopeView {
  const chain = ancestorChain(pi);
  const denied = new Set<string>();
  const predicates: CapabilityScopeDenialPredicate[] = [];
  for (const node of chain) {
    for (const name of node.state.denied) denied.add(name);
    if (node.state.deniedPredicate !== undefined) predicates.push(node.state.deniedPredicate);
  }
  let byName: Map<string, CapabilityScopedTool> | undefined;
  const toolFor = (name: string): CapabilityScopedTool | undefined => {
    if (predicates.length === 0) return undefined;
    byName ??= new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
    return byName.get(name);
  };

  return {
    allows: (name: string): boolean => {
      if (denied.has(name)) return false;
      if (predicates.length === 0) return true;
      const tool = toolFor(name);
      return !predicates.some((predicate) => predicate(name, tool));
    },
    root: chain.length === 1,
  };
}

/**
 * Declare the configured blacklist patterns for the chain.
 *
 * These are the `capability.blacklist` patterns (exact names, `foo*` prefixes,
 * or group schemes). They are not a matcher and grant nothing: the tool-access
 * domain reads them as the `startup` blacklist source, and an explicit branch
 * `blacklist remove` can override the matching target for this session.
 * Only the chain root applies them, so a child never gains availability the
 * root did not have.
 */
export function setCapabilityStartupBlacklist(
  pi: CapabilityToolCatalog,
  patterns: readonly string[],
): void {
  stateFor(pi).startupBlacklist = [...patterns];
}

/** The configured startup blacklist patterns that govern this catalog's chain. */
export function capabilityStartupBlacklist(pi: CapabilityToolCatalog): readonly string[] {
  return ancestorChain(pi)[0]?.state.startupBlacklist ?? [];
}

/**
 * Record a scope's parent, role denials, and optional dynamic denial predicate.
 * The denied collection is copied, so a caller cannot widen or narrow
 * authority by retaining the input array.
 */
export function setCapabilityParent(
  pi: CapabilityToolCatalog,
  parent: CapabilityParentSource = null,
  denied: readonly string[] = [],
  deniedPredicate?: CapabilityScopeDenialPredicate,
): void {
  const state = stateFor(pi);
  state.parent = parent;
  state.denied = new Set(denied);
  state.deniedPredicate = deniedPredicate;
}
