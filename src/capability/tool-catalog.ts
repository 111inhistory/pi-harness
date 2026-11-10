/**
 * Typed catalog operations for capability eligibility.
 *
 * Each operation creates exactly one capability scope view, then derives every
 * filter, name set and name map from that view. The catalog is read once more
 * for the full tool records, so the whole operation is linear in the ancestor
 * depth plus the catalog size; it never re-resolves the scope once per tool and
 * never keeps a view beyond the synchronous call.
 *
 * Hidden tools never enter an eligible catalog. The broker also drops them at
 * its own boundary, so an unreachable registration cannot become a candidate.
 *
 * Tools are returned as their original generic records. Nothing is reduced to a
 * name-only shape, so description, parameters, output schema, guidelines and
 * SDK metadata survive at their full static type.
 */

import {
  createCapabilityScopeView,
  type CapabilityScopedTool,
  type CapabilityScopeView,
} from "./scope.ts";

/** A catalog whose tool records keep their concrete metadata type. */
export interface TypedToolCatalog<T extends CapabilityScopedTool> {
  getAllTools(): readonly T[];
}

/** One operation's qualified tools, names and lookup map. */
export interface EligibleToolCatalog<T extends CapabilityScopedTool> {
  readonly scope: CapabilityScopeView;
  readonly tools: readonly T[];
  readonly names: ReadonlySet<string>;
  readonly byName: ReadonlyMap<string, T>;
}

/** Discovery excludes manual tools; the user command and execution opt in. */
export interface EligibleCatalogOptions<T> {
  /**
   * Names prohibited by an effective permission for this operation. A disabled
   * tool never enters an eligible catalog, so it is not a discovery candidate,
   * an activation target or a listed capability.
   */
  readonly disabled?: (name: string) => boolean;
  /**
   * The same prohibition decided from the already-read record, so a catalog
   * filter adds no second `getAllTools()` call.
   */
  readonly blocked?: (tool: T) => boolean;
}

/**
 * Resolve the scope once and return the qualified catalog for this operation.
 *
 * The returned collections are fresh; none of them is an authority store or a
 * cross-call snapshot. A later operation must call this function again.
 */
export function createEligibleToolCatalog<T extends CapabilityScopedTool>(
  catalog: TypedToolCatalog<T>,
  options: EligibleCatalogOptions<T> = {},
): EligibleToolCatalog<T> {
  const view = createCapabilityScopeView(catalog);
  const disabled = options.disabled;
  const blocked = options.blocked;
  const tools = catalog.getAllTools().filter((tool) => tool.exposure !== "hidden" && view.allows(tool.name)
    && !(disabled?.(tool.name) ?? false)
    && !(blocked?.(tool) ?? false));
  const names = new Set<string>();
  const byName = new Map<string, T>();
  for (const tool of tools) {
    names.add(tool.name);
    byName.set(tool.name, tool);
  }
  return { scope: view, tools, names, byName };
}

/** The metadata supplied after selection; extra tool fields are preserved. */
export interface CapabilityInterfaceTool extends CapabilityScopedTool {
  readonly parameters?: unknown;
  readonly outputSchema?: unknown;
  readonly promptGuidelines?: readonly unknown[] | undefined;
}

/** A selected hit may be a tool, a group of members, or a non-tool identity. */
export interface SelectedToolHit {
  readonly name?: unknown;
  readonly ref?: unknown;
  readonly kind?: unknown;
  readonly tools?: readonly unknown[] | undefined;
}

/** One refreshed selection plus the members that lost current eligibility. */
export interface RetainedSelectedTools<TResult> {
  readonly result: TResult;
  /** Selected tool names dropped because they are no longer eligible. */
  readonly dropped: readonly string[];
  /** Selected tool members before the refresh; skills are not counted. */
  readonly selected: number;
  /** Selected tool members kept by the refresh. */
  readonly retained: number;
}

/**
 * The current eligible catalog, optionally narrowed to the tools that are
 * actually active after activation. Already-active selection semantics are
 * preserved: a tool that is active may stay published even when it was active
 * before this call.
 */
export interface RetainedSelectionOptions {
  readonly active?: ReadonlySet<string>;
}

function isSelectedToolHit(value: unknown): value is SelectedToolHit {
  return typeof value === "object" && value !== null;
}

function selectedName(hit: SelectedToolHit): string {
  if (typeof hit.name === "string" && hit.name !== "") return hit.name;
  return typeof hit.ref === "string" ? hit.ref : "unknown selected tool";
}

/**
 * Re-read current eligibility for a completed selection before it is persisted
 * or activated.
 *
 * The search result is a snapshot. A tool can be unregistered, hidden or denied
 * between the search and publication, so every selected tool member is checked
 * against one fresh eligible catalog. Group hits lose the members that no longer
 * qualify and keep a recomputed `toolCount`; a group without members is dropped.
 * Non-tool identities (for example a server-level ref) and skills are not tool
 * members and stay untouched.
 */
export function retainEligibleSelectedTools<
  TResult extends {
    readonly tools: readonly THit[];
    readonly mcp: readonly THit[];
  },
  THit extends SelectedToolHit,
  TTool extends CapabilityScopedTool,
>(
  result: TResult,
  catalog: TypedToolCatalog<TTool>,
  options: RetainedSelectionOptions = {},
): RetainedSelectedTools<TResult> {
  const eligible = createEligibleToolCatalog(catalog).byName;
  const active = options.active;
  const dropped: string[] = [];
  let selected = 0;
  let retainedCount = 0;
  const qualifies = (hit: SelectedToolHit): boolean => {
    if (typeof hit.name !== "string" || !eligible.has(hit.name)) return false;
    return active === undefined || active.has(hit.name);
  };
  const retainHit = (hit: THit): THit | null => {
    if (Array.isArray(hit.tools)) {
      const tools = hit.tools.filter((member) => {
        selected += 1;
        if (isSelectedToolHit(member) && qualifies(member)) {
          retainedCount += 1;
          return true;
        }
        dropped.push(isSelectedToolHit(member) ? selectedName(member) : "unknown selected tool");
        return false;
      });
      if (tools.length === 0) return null;
      return { ...hit, tools, toolCount: tools.length } as THit;
    }
    if (hit.kind !== "tool") return hit;
    selected += 1;
    if (qualifies(hit)) {
      retainedCount += 1;
      return hit;
    }
    dropped.push(selectedName(hit));
    return null;
  };
  return {
    result: {
      ...result,
      tools: result.tools.flatMap((hit) => {
        const kept = retainHit(hit);
        return kept === null ? [] : [kept];
      }),
      mcp: result.mcp.flatMap((hit) => {
        const kept = retainHit(hit);
        return kept === null ? [] : [kept];
      }),
    },
    dropped,
    selected,
    retained: retainedCount,
  };
}

/** One refreshed selection plus the members that lost reachability. */
export interface ReachableSelectedTools<TResult> {
  readonly result: TResult;
  /** Selected tool member names dropped because the session has no call path. */
  readonly dropped: readonly string[];
}

/**
 * Drop selected tool members the session cannot call.
 *
 * Eligibility (registered, permitted, not hidden) is handled by
 * {@link retainEligibleSelectedTools}; this keeps the orthogonal question of
 * reachability: whether an already-eligible member has any execution entry the
 * model can use. A member whose entry depends on a disabled capability is
 * dropped here, before the discovery record is written, while non-tool
 * identities and Skill hits stay untouched.
 */
export function retainReachableSelectedTools<
  TResult extends {
    readonly tools: readonly THit[];
    readonly mcp: readonly THit[];
  },
  THit extends SelectedToolHit,
  TTool extends CapabilityScopedTool,
>(
  result: TResult,
  catalog: TypedToolCatalog<TTool>,
  isReachable: (tool: TTool) => boolean,
): ReachableSelectedTools<TResult> {
  const eligible = createEligibleToolCatalog(catalog).byName;
  const dropped: string[] = [];
  const keep = (member: SelectedToolHit): boolean => {
    if (typeof member.name !== "string") return true;
    const tool = eligible.get(member.name);
    if (tool === undefined) return true;
    if (isReachable(tool)) return true;
    dropped.push(member.name);
    return false;
  };
  const filterHit = (hit: THit): THit | null => {
    if (Array.isArray(hit.tools)) {
      const tools = hit.tools.filter((member) => isSelectedToolHit(member) ? keep(member) : true);
      return tools.length === 0 ? null : { ...hit, tools, toolCount: tools.length } as THit;
    }
    if (hit.kind !== "tool") return hit;
    return keep(hit) ? hit : null;
  };
  return {
    result: {
      ...result,
      tools: result.tools.flatMap((hit) => { const kept = filterHit(hit); return kept === null ? [] : [kept]; }),
      mcp: result.mcp.flatMap((hit) => { const kept = filterHit(hit); return kept === null ? [] : [kept]; }),
    },
    dropped,
  };
}

function enrichSelectedHit<THit extends SelectedToolHit>(
  hit: THit,
  registered: ReadonlyMap<string, CapabilityInterfaceTool>,
): THit {
  if (Array.isArray(hit.tools)) {
    return {
      ...hit,
      tools: hit.tools.map((child) => isSelectedToolHit(child)
        ? enrichSelectedHit(child, registered)
        : child),
    } as THit;
  }
  if (typeof hit.name !== "string") return hit;
  const tool = registered.get(hit.name);
  if (tool === undefined) return hit;
  return {
    ...hit,
    parameters: tool.parameters,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.promptGuidelines?.length ? { promptGuidelines: tool.promptGuidelines } : {}),
  } as THit;
}

/**
 * Supply parameters/output schema/guidelines for selected, qualified tools.
 *
 * This is the `selectedInterfaces` step: it enriches the discovery result after
 * selection and before activation, using exactly one scope view. Hidden and
 * denied tools stay untouched, and recursive group hits are enriched without
 * flattening their structure or dropping extra fields.
 */
export function supplySelectedToolInterfaces<
  TResult extends {
    readonly tools: readonly THit[];
    readonly mcp: readonly THit[];
  },
  THit extends SelectedToolHit,
  TTool extends CapabilityInterfaceTool,
>(
  result: TResult,
  catalog: TypedToolCatalog<TTool>,
): TResult {
  const registered = createEligibleToolCatalog(catalog).byName;
  return {
    ...result,
    tools: result.tools.map((hit) => enrichSelectedHit(hit, registered)),
    mcp: result.mcp.map((hit) => enrichSelectedHit(hit, registered)),
  };
}
