/**
 * Model-facing Capability result projection.
 *
 * These helpers compact selected interfaces when the session already exposes
 * them through a native declaration or Codemode query path. They do not decide
 * authorization, activate tools or encode provider requests.
 */

export interface CapabilityProjectionHit {
  readonly name?: string;
  readonly ref?: string;
  readonly instructions?: string;
  readonly tools?: readonly CapabilityProjectionHit[] | undefined;
  readonly toolCount?: number;
  readonly description?: string;
  readonly exposure?: string;
  readonly status?: string;
  readonly server?: string;
  readonly tool?: string;
  readonly namespace?: string;
  readonly parameters?: unknown;
  readonly outputSchema?: unknown;
  readonly promptGuidelines?: readonly string[];
  readonly match?: unknown;
  readonly score?: unknown;
  readonly reason?: unknown;
  readonly source?: unknown;
  readonly path?: unknown;
}

export interface CapabilityProjectionResult {
  readonly tools: readonly CapabilityProjectionHit[];
  readonly mcp: readonly CapabilityProjectionHit[];
  readonly guidance?: readonly CapabilityProjectionHit[] | undefined;
}

export type CapabilityToolDeltaResult<T extends CapabilityProjectionResult> =
  Omit<T, "tools" | "mcp" | "guidance"> & {
    readonly tools: readonly CapabilityProjectionHit[];
    readonly mcp: readonly CapabilityProjectionHit[];
    readonly guidance?: readonly CapabilityProjectionHit[] | undefined;
  };

/** Model-facing interfaces are a load delta, not a repeat of the caller's active tools. */
export function capabilityToolDelta<T extends CapabilityProjectionResult>(
  result: T,
  previouslyActive: ReadonlySet<string>,
): CapabilityToolDeltaResult<T> {
  const filter = (hits: readonly CapabilityProjectionHit[]): CapabilityProjectionHit[] => hits.flatMap((hit) => {
    if (Array.isArray(hit.tools)) {
      const added = hit.tools.filter((tool) => tool.name === undefined || !previouslyActive.has(tool.name));
      if (added.length) return [{ ...hit, tools: added, toolCount: added.length }];
      // The group's shared instructions are already in canonical branch memory;
      // an extra guidance-only entry in the delta would duplicate them.
      return [];
    }
    return hit.name !== undefined && previouslyActive.has(hit.name) ? [] : [hit];
  });
  const tools = filter(result.tools);
  const mcp = filter(result.mcp);
  return {
    ...result,
    tools,
    mcp,
  } as CapabilityToolDeltaResult<T>;
}

export interface CapabilityModelHit extends CapabilityProjectionHit {
  readonly interface?: string;
}

/** Where the model can read the selected tools' current interfaces. */
export interface CapabilityInterfaceSources {
  /** Tools with a native declaration in this session's current loadout. */
  readonly declared: ReadonlySet<string>;
  /** Active tools that Codemode's describeTool/describeNamespace can inspect. */
  readonly queryable?: ReadonlySet<string> | undefined;
}

export type CapabilityModelResult<T extends CapabilityProjectionResult> =
  Omit<T, "tools" | "mcp"> & {
    readonly tools: readonly CapabilityModelHit[];
    readonly mcp: readonly CapabilityModelHit[];
  };

/**
 * Compact one hit when every selected member's interface is already available
 * through a native declaration or an active Codemode query path. Stable
 * refs/names/count stay; duplicate argument schemas, output schemas, per-member
 * descriptions, shared instructions and ranking/implementation fields are
 * omitted. Canonical branch memory injects the instructions once, and a hit
 * without an interface source stays fully expanded except for diagnostics.
 */
export function capabilityModelResult<T extends CapabilityProjectionResult>(
  result: T,
  sources: CapabilityInterfaceSources,
): CapabilityModelResult<T> {
  const compact = (hit: CapabilityProjectionHit): CapabilityModelHit => {
    const members = Array.isArray(hit.tools) ? hit.tools : [hit];
    if (!members.length) return hit;
    const names = members.flatMap((member) => typeof member.name === "string" ? [member.name] : []);
    if (names.length !== members.length) return hit;
    const declared = names.every((name) => sources.declared.has(name));
    const queryable = sources.queryable;
    const queried = !declared && queryable !== undefined && names.every((name) => queryable.has(name));
    if (!declared && !queried) return hit;
    const {
      tools: _tools,
      description: _description,
      exposure: _exposure,
      status: _status,
      instructions: _instructions,
      parameters: _parameters,
      outputSchema: _outputSchema,
      promptGuidelines: _promptGuidelines,
      match: _match,
      score: _score,
      reason: _reason,
      source: _source,
      path: _path,
      server: _server,
      tool: _tool,
      namespace: _namespace,
      ...stable
    } = hit;
    // When the interface is only reachable through Codemode's query path the
    // declaration no longer names the members, so keep a names-only list. A
    // group whose interface a native declaration already supplies keeps its
    // names in that declaration and stays compact.
    const memberNames = queried && Array.isArray(hit.tools)
      ? hit.tools.flatMap((member) => typeof member.name === "string"
        ? [{ name: member.name, ...(typeof member.ref === "string" ? { ref: member.ref } : {}) }]
        : [])
      : undefined;
    return {
      ...stable,
      ...(memberNames === undefined ? {} : { tools: memberNames, toolCount: memberNames.length }),
      interface: declared
        ? "Declared through the session's current tool loadout; use the tool declaration for arguments."
        : "Query the current interface with codemode describeTool; describeNamespace lists the group's members.",
    };
  };
  return { ...result, tools: result.tools.map(compact), mcp: result.mcp.map(compact) } as CapabilityModelResult<T>;
}
