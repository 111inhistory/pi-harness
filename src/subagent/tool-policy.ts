/**
 * Pure tool-loadout policy shared by the Subagent surface and the native Job
 * runner.
 *
 * Two callers need the same three answers and must never drift apart:
 *
 * - the surface, when it captures an inherited context and records why some
 *   parent tools cannot travel with it;
 * - the runner, when it starts an Inherited Job on that snapshot.
 *
 * Everything here is a pure function of the parent's tool list and the child
 * depth. It owns no SDK object, session, host or runtime map, so the runner can
 * import it without pulling in the surface's registrations, and the surface can
 * import it without pulling in the runner.
 *
 * Ordering is part of the contract:
 *
 * - a depth's harness tools are always appended in their declared order;
 * - an inherited captured loadout keeps the capture's order, collapsed to its
 *   first occurrence, and only then get the harness tools it does not name yet;
 * - a dropped-tool list keeps the capture's order and never repeats a name.
 */

import { MAX_AGENT_DEPTH } from "./runtime.ts";

/** The only shape the transplantability filter needs from a registered tool. */
export interface ToolPolicyTool {
  readonly name: string;
  readonly sourceInfo?: { readonly source?: string | undefined; readonly path?: string | undefined } | undefined;
}

/** Harness tools a child keeps below the leaf depth, in registration order. */
const HARNESS_TOOLS = ["subagent_create", "subagent_list", "subagent_stop", "capability", "msg_write"] as const;
/** At the leaf depth a child may only list; it cannot create or stop. */
const LEAF_HARNESS_TOOLS = ["subagent_list", "msg_write"] as const;

/** The harness tool names a child at `depth` may hold. */
export function harnessToolsForDepth(depth: number): readonly string[] {
  return depth < MAX_AGENT_DEPTH ? HARNESS_TOOLS : LEAF_HARNESS_TOOLS;
}

/**
 * Names eligible for independent registration in the child's configured loaders.
 * Built-ins and file-backed extensions can be recreated. Inline-only extensions
 * expose no loader or execute handle to another session and remain unavailable.
 * The session factory verifies actual registration before accepting a loadout.
 */
export function transplantableToolNames(
  tools: readonly ToolPolicyTool[],
  childDepth: number,
): ReadonlySet<string> {
  const names = new Set<string>([...harnessToolsForDepth(childDepth), "read", "write", "msg_write"]);
  for (const tool of tools) {
    const source = tool.sourceInfo;
    if (source?.source === "builtin" || (source?.path !== undefined && !source.path.startsWith('<'))) names.add(tool.name);
  }
  return names;
}

/**
 * Tools the parent had active that Pi's public API cannot transplant into a
 * child session. The list is what both the recorded warning and the child
 * allowlist use.
 */
export function droppedInheritedTools(
  tools: readonly ToolPolicyTool[],
  inheritedTools: unknown,
  childDepth: number,
): string[] {
  const transplantable = transplantableToolNames(tools, childDepth);
  const dropped: string[] = [];
  for (const name of toolNamesOf(inheritedTools)) {
    if (!transplantable.has(name) && !dropped.includes(name)) dropped.push(name);
  }
  return dropped;
}

/**
 * The operator-facing form of a dropped-tool list. Inherited Subagents cannot
 * silently lose the parent's extension tools: the warning travels with the
 * captured snapshot, so it survives persistence and reaches the entry metadata
 * of the initial `task` response and of `hub jobs`.
 */
export function inheritedToolsWarning(dropped: readonly string[]): string {
  return `Not transplantable through Pi's public API, so the inherited child does not have them: ${dropped.join(", ")}.`;
}

/**
 * The tool allowlist an Inherited Job starts with: the captured parent loadout
 * filtered to what Pi's public API can transplant, plus this depth's harness
 * tools.
 */
export function inheritedToolNames(
  tools: readonly ToolPolicyTool[],
  inheritedTools: unknown,
  childDepth: number,
): string[] {
  const dropped = new Set(droppedInheritedTools(tools, inheritedTools, childDepth));
  const names: string[] = [];
  for (const name of toolNamesOf(inheritedTools)) {
    if (!dropped.has(name) && !names.includes(name)) names.push(name);
  }
  for (const name of harnessToolsForDepth(childDepth)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** A captured loadout is untrusted data: only non-empty strings are tool names. */
function toolNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const name of value) {
    if (typeof name === "string" && name !== "") names.push(name);
  }
  return names;
}
