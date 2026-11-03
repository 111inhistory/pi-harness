/**
 * Capability eligibility: qualification is separate from registration and
 * activation.
 *
 * A child's eligibility is the intersection of what its parent qualified and
 * what the child itself exposes, minus the child's role denials. Qualification
 * is append-only: once a tool has entered a scope's learned set, a later parent
 * catalog change does not revoke it. Role denials always win, including a
 * denial added after a descendant already learned the name.
 *
 * Manual tools are root-only. A tool that the user alone may enable never
 * enters a child's effective set, even when the root activated it: the root
 * policy is read from the first node of the ancestor chain and applied to every
 * node that has a parent. Enabling it in Main therefore cannot leak it into a
 * subagent session through inheritance or through a learned grant.
 *
 * A synchronous operation must resolve the ancestor chain once and then ask
 * {@link CapabilityScopeView.allows} for every tool. Eligibility can grow
 * mid-turn, so a view is deliberately fresh for one operation: it is never
 * reused across turns or tool calls. The learned sets below are the only
 * persistent authority state; they are monotonic and never used as a negative
 * cache. They also cannot add a name that an ancestor currently denies.
 *
 * `allows` is the exact qualification answer of `capabilityAllowsTool`,
 * including its root behavior: without a parent, every
 * non-denied name is qualified, even when it is not registered. That is why
 * `available` is not a replacement for `allows`: `available` is the registry
 * intersection snapshot for filtering, while `allows` also answers for names
 * the catalog does not contain (and callers still check `exposure === "hidden"`
 * themselves). Hidden tools never enter `available`.
 *
 * The parent source may be a resolver so a revived child looks up the current
 * parent API instead of the one captured at construction. A cyclic chain fails
 * closed instead of recursing forever.
 */

/** The only shape this module needs from a registered tool. */
export interface CapabilityScopedTool {
  readonly name: string;
  readonly exposure?: string | undefined;
}

/** Minimal structural tool catalog; an ExtensionAPI satisfies it. */
export interface CapabilityToolCatalog {
  getAllTools(): readonly CapabilityScopedTool[];
}

/** Resolves the current parent API; revival replaces the value, not the link. */
export type CapabilityParentResolver = () => CapabilityToolCatalog | null | undefined;

export type CapabilityParentSource =
  | CapabilityToolCatalog
  | CapabilityParentResolver
  | null
  | undefined;

/**
 * Qualification for one synchronous operation.
 *
 * `allows` is O(1): the ancestor chain and every catalog were resolved before
 * the view was returned. `available` is a detached, read-only snapshot; keeping
 * or mutating the returned object cannot change authority state.
 */
/** Name policy for tools that only the root session may hold. */
export type CapabilityRootOnlyPolicy = (name: string) => boolean;

export interface CapabilityScopeView {
  readonly allows: (name: string) => boolean;
  readonly available: ReadonlySet<string>;
}

interface ScopeState {
  parent: CapabilityParentSource;
  denied: ReadonlySet<string>;
  /** Append-only qualification learned by earlier operations. */
  learned: Set<string>;
  /** Root-only policy; only the chain's first node is consulted. */
  rootOnly: CapabilityRootOnlyPolicy | null;
}

interface ScopeNode {
  readonly catalog: CapabilityToolCatalog;
  readonly state: ScopeState;
}

const scopes = new WeakMap<CapabilityToolCatalog, ScopeState>();
const NO_DENIALS: ReadonlySet<string> = new Set<string>();

function stateFor(pi: CapabilityToolCatalog): ScopeState {
  let state = scopes.get(pi);
  if (state === undefined) {
    state = { parent: null, denied: NO_DENIALS, learned: new Set<string>(), rootOnly: null };
    scopes.set(pi, state);
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
 * Resolve this scope's whole ancestor qualification now and return a view that
 * answers every subsequent name check in O(1).
 *
 * Building the view performs the same append-only learning as
 * `capabilityAvailableTools`: every ancestor's currently effective names are
 * folded into the child's learned set, and every registered, non-hidden child
 * tool is learned when its parent qualifies it. Current denials are applied
 * cumulatively at read time, so a denial added at any level is not hidden by an
 * earlier learned grant.
 */
export function createCapabilityScopeView(pi: CapabilityToolCatalog): CapabilityScopeView {
  const chain = ancestorChain(pi);
  const rootOnly = chain[0]?.state.rootOnly ?? null;

  let inheritedDenied: ReadonlySet<string> = NO_DENIALS;
  let parentEffective: ReadonlySet<string> | null = null;
  let targetDenied: ReadonlySet<string> = NO_DENIALS;
  let targetEffective: ReadonlySet<string> = NO_DENIALS;
  let targetParentEffective: ReadonlySet<string> | null = null;

  for (const node of chain) {
    const denied = new Set(inheritedDenied);
    for (const name of node.state.denied) denied.add(name);

    if (parentEffective !== null) {
      for (const name of parentEffective) {
        if (!denied.has(name)) node.state.learned.add(name);
      }
    }
    for (const tool of node.catalog.getAllTools()) {
      if (tool.exposure === "hidden" || denied.has(tool.name)) continue;
      if (parentEffective !== null && !parentEffective.has(tool.name)) continue;
      node.state.learned.add(tool.name);
    }

    const effective = new Set<string>();
    for (const name of node.state.learned) {
      if (!denied.has(name)) effective.add(name);
    }
    // Manual tools stay in the root's own set. A node with a parent drops them
    // here, so neither its own view nor any descendant can qualify them.
    if (rootOnly !== null && node !== chain[0]) {
      for (const name of effective) if (rootOnly(name)) effective.delete(name);
    }

    targetParentEffective = parentEffective;
    targetDenied = denied;
    targetEffective = effective;
    inheritedDenied = denied;
    parentEffective = effective;
  }

  const parent = targetParentEffective;
  const denied = targetDenied;
  const allows =
    parent === null
      ? (name: string): boolean => !denied.has(name)
      : (name: string): boolean =>
          !denied.has(name) && (rootOnly === null || !rootOnly(name)) && parent.has(name);

  return { allows, available: new Set(targetEffective) };
}

/**
 * Declare which tool names only the root session may hold.
 *
 * The policy is stored on the catalog it is set on and consulted from the first
 * node of every ancestor chain, so a root sets it once and every child view
 * enforces it. Passing a null policy removes the restriction.
 */
export function setCapabilityRootOnlyPolicy(
  pi: CapabilityToolCatalog,
  policy: CapabilityRootOnlyPolicy | null,
): void {
  stateFor(pi).rootOnly = policy;
}

/** The root-only policy that governs this catalog's chain, or null. */
export function capabilityRootOnlyPolicy(pi: CapabilityToolCatalog): CapabilityRootOnlyPolicy | null {
  return ancestorChain(pi)[0]?.state.rootOnly ?? null;
}

/**
 * Record a scope's parent and role denials. The denied collection is copied, so
 * a caller cannot widen or narrow authority by retaining the input array. The
 * learned set is intentionally preserved: qualification stays append-only, and
 * current denials are applied when a view is built.
 */
export function setCapabilityParent(
  pi: CapabilityToolCatalog,
  parent: CapabilityParentSource = null,
  denied: readonly string[] = [],
): void {
  const state = stateFor(pi);
  state.parent = parent;
  state.denied = new Set(denied);
}

/**
 * Read-only snapshot of the currently effective available tools for this scope.
 *
 * The result is detached: retaining the set never exposes mutable authority
 * state.
 */
export function capabilityAvailableTools(pi: CapabilityToolCatalog): ReadonlySet<string> {
  return createCapabilityScopeView(pi).available;
}

/**
 * Single-name qualification check. Filter loops should create one
 * {@link createCapabilityScopeView} per operation instead of repeating this.
 *
 * A root scope answers from its own denial set without enumerating the catalog,
 * and a child asks its parent's effective qualification. An ancestor denial
 * always wins.
 */
export function capabilityAllowsTool(pi: CapabilityToolCatalog, name: string): boolean {
  const state = stateFor(pi);
  if (state.denied.has(name)) return false;
  const parent = resolvedParent(state);
  // The root holds manual tools; no scope below it may qualify one.
  if (parent === null) return true;
  const rootOnly = capabilityRootOnlyPolicy(pi);
  if (rootOnly !== null && rootOnly(name)) return false;
  return createCapabilityScopeView(parent).available.has(name);
}
