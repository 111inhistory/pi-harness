/**
 * Capability compaction pruning logic.
 *
 * Computes which Capability-discovered tools, MCP servers, and namespaces were
 * never used since the previous compaction and marks them for eviction at the
 * current compaction boundary.
 *
 * Usage source of truth is the session branch history:
 * - Direct tool execution: `toolResult` messages (excluding detectable admission failures).
 * - Nested tool execution: `toolResult.nestedCalls.calls` with a valid numeric `durationMs`.
 *
 * No in-memory usage ledgers or clock-based windows are kept. The eviction window
 * is strictly structural: entries between the previous compaction entry and the
 * current compaction boundary.
 */

import {
  discoveryRecords,
  appendPruneRecord,
  type CapabilityPruneRecord,
  type DiscoveryRecordWriter,
} from "./discovery-record.ts";

export interface PruneCalculationOptions {
  /** The session branch entries. */
  readonly branch: readonly unknown[];
  /** The current compaction checkpoint entry ID. */
  readonly checkpointId: string;
  /** Protected or baseline tool names that must not be pruned (e.g. builtins, depth harness tools). */
  readonly protectedTools?: readonly string[] | ReadonlySet<string>;
  /**
   * Discovered names that must stay out of the prune set even when unused.
   * Explicitly disabled tools (including migrated rules and manual seeds) keep
   * their prohibition; pruning them would re-advertise them as rediscoverable.
   */
  readonly excludedTools?: readonly string[] | ReadonlySet<string>;
}

export interface PruneCalculationResult {
  readonly checkpointId: string;
  readonly removedTools: readonly string[];
  readonly removedGroups: readonly string[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (isRecord(item) && typeof item["text"] === "string" ? item["text"] : ""))
    .join("\n");
}

function isAdmissionBlockText(text: string): boolean {
  return (
    text.includes("is unavailable in this session") ||
    text.includes("requires explicit user authorization")
  );
}

/**
 * Extract branch entries strictly after the previous compaction and before
 * the specified current compaction checkpoint.
 */
export function extractWindowEntries(
  branch: readonly unknown[] | null | undefined,
  currentCompactionId?: string | null,
): readonly unknown[] {
  if (!branch || branch.length === 0) return [];
  let currentIndex = branch.length;
  if (typeof currentCompactionId === "string" && currentCompactionId !== "") {
    const found = branch.findIndex((entry) => isRecord(entry) && entry["id"] === currentCompactionId);
    if (found >= 0) currentIndex = found;
  }
  const entriesBefore = branch.slice(0, currentIndex);
  const previousCompactionIndex = entriesBefore.findLastIndex(
    (entry) => isRecord(entry) && entry["type"] === "compaction",
  );
  return previousCompactionIndex >= 0
    ? entriesBefore.slice(previousCompactionIndex + 1)
    : entriesBefore;
}

/**
 * Extract tool names used in the given window entries.
 *
 * Counts:
 * - Completed direct `toolResult` executions (successful calls, or executions with
 *   numeric `durationMs`; error results without `durationMs` are checked against
 *   detectable admission blocks before conservatively counting).
 * - Completed nested tool executions recorded in `nestedCalls.calls` having a numeric `durationMs`.
 */
export function extractUsedToolsFromWindow(windowEntries: readonly unknown[]): Set<string> {
  const used = new Set<string>();
  for (const entry of windowEntries) {
    if (!isRecord(entry) || entry["type"] !== "message") continue;
    const msg = entry["message"];
    if (!isRecord(msg)) continue;

    // Direct toolResult
    if (msg["role"] === "toolResult" && typeof msg["toolName"] === "string" && msg["toolName"] !== "") {
      const isError = msg["isError"] === true;
      if (!isError) {
        used.add(msg["toolName"]);
      } else if (typeof msg["durationMs"] === "number" && msg["durationMs"] >= 0) {
        // Native execution finished with error
        used.add(msg["toolName"]);
      } else {
        // Check for clear admission block text before conservatively counting
        const text = extractText(msg["content"]);
        if (!isAdmissionBlockText(text)) {
          used.add(msg["toolName"]);
        }
      }
    }

    // Nested calls on toolResult.nestedCalls
    const nested = msg["nestedCalls"];
    if (isRecord(nested) && Array.isArray(nested["calls"])) {
      for (const call of nested["calls"]) {
        if (isRecord(call) && typeof call["name"] === "string" && call["name"] !== "") {
          if (typeof call["durationMs"] === "number" && call["durationMs"] >= 0) {
            used.add(call["name"]);
          }
        }
      }
    }
  }
  return used;
}

/**
 * Compute the tools and groups that should be removed at the current compaction.
 */
export function computePrunableCapabilities(options: PruneCalculationOptions): PruneCalculationResult {
  const { branch, checkpointId } = options;
  const windowEntries = extractWindowEntries(branch, checkpointId);
  const usedTools = extractUsedToolsFromWindow(windowEntries);

  let currentIndex = branch.length;
  if (typeof checkpointId === "string" && checkpointId !== "") {
    const found = branch.findIndex((entry) => isRecord(entry) && entry["id"] === checkpointId);
    if (found >= 0) currentIndex = found;
  }
  const priorBranch = branch.slice(0, currentIndex);
  const priorDiscoveries = discoveryRecords(priorBranch);

  const protectedSet = new Set<string>();
  if (options.protectedTools) {
    for (const name of options.protectedTools) protectedSet.add(name);
  }
  if (options.excludedTools) {
    for (const name of options.excludedTools) protectedSet.add(name);
  }

  const groupMembers = new Map<string, Set<string>>();
  const allDiscoveredTools = new Set<string>();

  for (const record of priorDiscoveries) {
    for (const category of ["tools", "mcp"] as const) {
      for (const hit of record.result[category] ?? []) {
        if (hit.status && hit.status !== "available") continue;
        const groupRef = typeof hit.ref === "string" && hit.ref !== "" ? hit.ref : null;
        if (Array.isArray(hit.tools)) {
          if (groupRef !== null && !groupMembers.has(groupRef)) {
            groupMembers.set(groupRef, new Set());
          }
          for (const member of hit.tools) {
            if (typeof member.name === "string" && member.name !== "") {
              allDiscoveredTools.add(member.name);
              if (groupRef !== null) {
                groupMembers.get(groupRef)!.add(member.name);
              }
            }
          }
        } else if (typeof hit.name === "string" && hit.name !== "") {
          allDiscoveredTools.add(hit.name);
        }
      }
    }
  }

  const removedTools: string[] = [];
  for (const name of allDiscoveredTools) {
    if (protectedSet.has(name)) continue;
    if (!usedTools.has(name)) {
      removedTools.push(name);
    }
  }

  const removedToolSet = new Set(removedTools);
  const removedGroups: string[] = [];
  for (const [groupRef, members] of groupMembers.entries()) {
    const remaining = [...members].filter((name) => !removedToolSet.has(name));
    if (remaining.length === 0) {
      removedGroups.push(groupRef);
    }
  }

  return {
    checkpointId,
    removedTools,
    removedGroups,
  };
}

/**
 * Compute prunable capabilities and append a `capability-prune` record if any
 * tools or groups are evicted.
 */
export function recordCompactionPruning(
  pi: DiscoveryRecordWriter,
  options: PruneCalculationOptions,
): CapabilityPruneRecord | null {
  const computed = computePrunableCapabilities(options);
  if (computed.removedTools.length === 0 && computed.removedGroups.length === 0) {
    return null;
  }
  return appendPruneRecord(
    pi,
    computed.checkpointId,
    computed.removedTools,
    computed.removedGroups,
  );
}
