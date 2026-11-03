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
} from "./scope.ts";

/** A catalog whose tool records keep their concrete metadata type. */
export interface TypedToolCatalog<T extends CapabilityScopedTool> {
  getAllTools(): readonly T[];
}

/** One operation's qualified tools, names and lookup map. */
export interface EligibleToolCatalog<T extends CapabilityScopedTool> {
  readonly tools: readonly T[];
  readonly names: ReadonlySet<string>;
  readonly byName: ReadonlyMap<string, T>;
}

/** Discovery excludes manual tools; the user command and execution opt in. */
export interface EligibleCatalogOptions {
  /**
   * Include tools that only the user may enable. Discovery never sets this, so
   * a manual tool cannot become a search candidate or an activation request;
   * `/capability` and the execution guard do, because by then the user has
   * already authorized it.
   */
  readonly includeManual?: boolean;
}

/**
 * Resolve the scope once and return the qualified catalog for this operation.
 *
 * The returned collections are fresh; none of them is an authority store or a
 * cross-call snapshot. A later operation must call this function again.
 */
export function createEligibleToolCatalog<T extends CapabilityScopedTool>(
  catalog: TypedToolCatalog<T>,
  options: EligibleCatalogOptions = {},
): EligibleToolCatalog<T> {
  const view = createCapabilityScopeView(catalog);
  // One scope resolution answers qualification and the root-only policy.
  const rootOnly = options.includeManual === true ? null : view.rootOnly;
  const tools = catalog.getAllTools().filter((tool) => tool.exposure !== "hidden" && view.allows(tool.name)
    && (rootOnly === null || !rootOnly(tool.name)));
  const names = new Set<string>();
  const byName = new Map<string, T>();
  for (const tool of tools) {
    names.add(tool.name);
    byName.set(tool.name, tool);
  }
  return { tools, names, byName };
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
