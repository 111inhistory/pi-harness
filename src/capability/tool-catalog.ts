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

/**
 * Resolve the scope once and return the qualified catalog for this operation.
 *
 * The returned collections are fresh; none of them is an authority store or a
 * cross-call snapshot. A later operation must call this function again.
 */
export function createEligibleToolCatalog<T extends CapabilityScopedTool>(
  catalog: TypedToolCatalog<T>,
): EligibleToolCatalog<T> {
  const view = createCapabilityScopeView(catalog);
  const tools = catalog.getAllTools().filter((tool) => tool.exposure !== "hidden" && view.allows(tool.name));
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

/** A selected hit may be a tool or a group of nested hits. */
export interface SelectedToolHit {
  readonly name?: unknown;
  readonly tools?: readonly unknown[] | undefined;
}

function isSelectedToolHit(value: unknown): value is SelectedToolHit {
  return typeof value === "object" && value !== null;
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
