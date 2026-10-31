import { declarationsEqual } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";

const ADDITIVE_RESPONSES_APIS = new Set([
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);

export interface TranscriptMessageLike {
  readonly role?: string | undefined;
  readonly content?: unknown;
  readonly toolsAdded?: readonly unknown[] | undefined;
  readonly toolsRemoved?: readonly unknown[] | undefined;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolDeclaration(value: unknown): Tool | null {
  if (!isRecord(value)) return null;
  const name = value["name"];
  const description = value["description"];
  const parameters = value["parameters"];
  if (typeof name !== "string" || typeof description !== "string" || !isRecord(parameters)) return null;
  return value as unknown as Tool;
}

function toolName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const name = value["name"];
  return typeof name === "string" ? name : null;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!isRecord(part) || part["type"] !== "text" || typeof part["text"] !== "string") return [];
    return [part["text"]];
  }).join("\n");
}

/** Only opt in when this concrete model supports in-place tools and prompt updates. */
export function supportsAdditiveResponses(model: unknown): boolean {
  if (!isRecord(model)) return false;
  const compat = isRecord(model["compat"]) ? model["compat"] : null;
  return typeof model["api"] === "string" && ADDITIVE_RESPONSES_APIS.has(model["api"]) &&
    compat?.["supportsMidConvoSystemMessages"] === true &&
    (compat["supportsAdditionalTools"] === true || compat["supportsToolSearch"] === true);
}

/** First declarations, in transcript order. No executable handles or session state. */
export function firstToolDeclarations(messages: readonly TranscriptMessageLike[]): Tool[] {
  const tools = new Map<string, Tool>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const candidate of message.toolsAdded ?? []) {
      const tool = toolDeclaration(candidate);
      if (tool !== null && !tools.has(tool.name)) tools.set(tool.name, tool);
    }
  }
  return [...tools.values()];
}

/**
 * Request-only projection: declarations are append-only, execution is NOT enabled.
 * Pi's executable registry still enforces the live loadout. Replay permission changes
 * where they originally happened, rather than patching the leading tools or prompt.
 */
export function additiveToolTranscript<T extends TranscriptMessageLike>(messages: readonly T[]): T[] {
  const declared = new Map<string, Tool>();
  const enabled = new Set<string>();
  return messages.map((message) => {
    if (message.role !== "system") return message;
    const notes: string[] = [];
    for (const reference of message.toolsRemoved ?? []) {
      const name = toolName(reference);
      if (name === null) continue;
      enabled.delete(name);
      notes.push(`Tool ${name} is unavailable in this session. Do not call it; execution is blocked.`);
    }
    const additions: Tool[] = [];
    for (const candidate of message.toolsAdded ?? []) {
      const tool = toolDeclaration(candidate);
      if (tool === null) continue;
      const previous = declared.get(tool.name);
      if (!previous) {
        declared.set(tool.name, tool);
        additions.push(tool);
      } else if (!declarationsEqual(previous, tool)) {
        // A later declaration under the same name replaces the earlier one on
        // transports that support in-place tool changes. Dropping it would keep
        // sending the stale interface and schema, so replay the replacement
        // declaration instead of only noting it. Pi 1.4 expresses this as an
        // additional_tools item ("its latest definition replaces the earlier one").
        declared.set(tool.name, tool);
        additions.push(tool);
        notes.push(`Tool ${tool.name} has updated interface or usage guidance. Inspect its current interface before calling it; execution validates current arguments.`);
      } else if (!enabled.has(tool.name)) {
        notes.push(`Tool ${tool.name} is available again.`);
      }
      enabled.add(tool.name);
    }
    if (!message.toolsRemoved?.length && notes.length === 0 && additions.length === (message.toolsAdded?.length ?? 0)) return message;
    const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
    const content = messageText(message.content);
    return {
      ...rest,
      content: [content, ...notes.filter((note) => !content.includes(note))].filter(Boolean).join("\n\n"),
      ...(additions.length ? { toolsAdded: additions } : {}),
    } as unknown as T;
  });
}

export interface BlockedRetrievalTool extends Tool {
  readonly label: string;
  execute(): Promise<never>;
}

/** Inherited declarations remain visible, but carry no execution authority. */
export function retrievalToolLoadout<T extends { readonly name: string }>(
  messages: readonly TranscriptMessageLike[],
  retrievalTools: readonly T[],
): Array<BlockedRetrievalTool | T> {
  const names = new Set(retrievalTools.map((tool) => tool.name));
  const allowed = names.size === 0 ? "No retrieval tool may execute." : `Only ${[...names].join(", ")} may execute.`;
  const blocked = firstToolDeclarations(messages)
    .filter((tool) => !names.has(tool.name))
    .map((tool): BlockedRetrievalTool => ({
      ...tool,
      label: tool.name,
      async execute(): Promise<never> {
        throw new Error(`Tool ${tool.name} is unavailable in capability discovery. ${allowed}`);
      },
    }));
  return [...blocked, ...retrievalTools];
}

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
  const guidance: CapabilityProjectionHit[] = [...(result.guidance ?? [])];
  const filter = (hits: readonly CapabilityProjectionHit[]): CapabilityProjectionHit[] => hits.flatMap((hit) => {
    if (Array.isArray(hit.tools)) {
      const added = hit.tools.filter((tool) => tool.name === undefined || !previouslyActive.has(tool.name));
      if (added.length) return [{ ...hit, tools: added, toolCount: added.length }];
      if (hit.instructions !== undefined) {
        const entry: { ref?: string; name?: string; instructions: string } = { instructions: hit.instructions };
        if (hit.ref !== undefined) entry.ref = hit.ref;
        if (hit.name !== undefined) entry.name = hit.name;
        guidance.push(entry);
      }
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
    ...(guidance.length ? { guidance } : {}),
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
 * refs/names/count and the group's shared instructions stay; duplicate argument
 * schemas, output schemas, per-member descriptions and ranking/implementation
 * fields are omitted, because repeating them costs tokens without adding a
 * usable interface. Hits without such a source stay fully expanded.
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
    return {
      ...stable,
      interface: declared
        ? "Declared through the session's current tool loadout; use the tool declaration for arguments."
        : "Query the current interface with codemode describeTool; describeNamespace lists the group's members.",
    };
  };
  return { ...result, tools: result.tools.map(compact), mcp: result.mcp.map(compact) } as CapabilityModelResult<T>;
}
