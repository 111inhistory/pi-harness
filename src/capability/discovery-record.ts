/**
 * Durable Capability discovery memory, stored on the native session branch.
 *
 * A successful discovery is written with `pi.appendEntry` as one custom entry.
 * That entry is the only persistent source of truth for discovered resources,
 * so a nested `ctx.executeTool("capability", ...)` call keeps its memory even
 * when the outer tool drops the inner result details. Pi custom entries are not
 * part of the model context; the request projection in `./prompt.ts`
 * turns these records into native `<capabilities>` system sections on every
 * request, after checking the *current* tool permissions.
 *
 * The record never grants execution authority and never stores remote
 * installation candidates: discovery is local-only, so `remote` is always empty
 * and the stored coverage says remote was not searched. Diagnostics (ranking,
 * warnings) are not persisted.
 */

/** `customType` of the branch entry holding one successful discovery. */
/** `customType` of the branch entry holding a compaction pruning boundary. */
export const CAPABILITY_PRUNE_RECORD = "capability-prune";

/** Only this prune record version is read. */
export const CAPABILITY_PRUNE_RECORD_VERSION = 1;

/** The stored payload of one `capability-prune` custom entry. */
export interface CapabilityPruneRecord {
  readonly version: typeof CAPABILITY_PRUNE_RECORD_VERSION;
  /** Compaction entry ID anchoring this pruning boundary. */
  readonly checkpointId: string;
  /** Tool names removed because they were unused in the compaction window. */
  readonly removedTools: readonly string[];
  /** Group refs (e.g. "mcp://github", "namespace://docker") whose members were all removed. */
  readonly removedGroups?: readonly string[];
}

export const CAPABILITY_DISCOVERY_RECORD = "capability-discovery";

/** Only this record version is read. */
export const CAPABILITY_DISCOVERY_RECORD_VERSION = 1;

export type DiscoveryStatus = "ok" | "partial";

/** Whether one source group was actually searched in this run. */
export type SearchCoverage = "searched" | "not_searched";

/** Model-facing statement of what this run covered. */
export interface CapabilitySearchCoverage {
  readonly local: SearchCoverage;
  /** Discovery searches local resources only. */
  readonly remote: "not_searched";
}

/** A tool member of a namespace group or MCP group. */
export interface CapabilityHit {
  readonly ref?: string;
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly filePath?: string;
  readonly exposure?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly server?: string;
  readonly tool?: string;
  readonly namespace?: string;
  readonly toolCount?: number;
  readonly tools?: readonly CapabilityHit[];
  readonly [field: string]: unknown;
}

/** One successful discovery as persisted on the branch. */
export interface DiscoveryMemory {
  readonly status: DiscoveryStatus;
  readonly tools: readonly CapabilityHit[];
  readonly mcp: readonly CapabilityHit[];
  readonly skills: readonly CapabilityHit[];
  readonly guidance?: readonly CapabilityHit[];
  readonly coverage: CapabilitySearchCoverage;
}

/** The stored payload of one `capability-discovery` custom entry. */
export interface CapabilityDiscoveryRecord {
  readonly version: typeof CAPABILITY_DISCOVERY_RECORD_VERSION;
  /** The calling tool call, so a visible result anchors its immediate update. */
  readonly toolCallId?: string;
  readonly result: DiscoveryMemory;
}

/** A parsed record with the tool call it belongs to, when known. */
export interface StoredDiscovery {
  readonly toolCallId?: string;
  readonly result: DiscoveryMemory;
}

/** The only Pi extension action this module needs. */
export interface DiscoveryRecordWriter {
  appendEntry<T = unknown>(customType: string, data?: T): void;
}

/**
 * Fields kept from each hit. Interfaces stay in native tool declarations, so
 * argument schemas and executable handles are never duplicated into memory.
 */
const HIT_FIELDS = [
  "ref",
  "name",
  "description",
  "instructions",
  "filePath",
  "exposure",
  "kind",
  "status",
  "server",
  "tool",
  "namespace",
  "toolCount",
] as const;

const MEMBER_FIELDS = ["ref", "name", "description", "exposure"] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(source: UnknownRecord, fields: readonly string[]): UnknownRecord {
  const kept: UnknownRecord = {};
  for (const field of fields) {
    const value = source[field];
    if (value !== undefined) kept[field] = value;
  }
  return kept;
}

function normalizeHit(value: unknown, fields: readonly string[]): CapabilityHit | null {
  if (!isRecord(value)) return null;
  const ref = value["ref"];
  if (typeof ref !== "string" || ref === "") return null;
  const hit: UnknownRecord = pick(value, fields);
  const members = value["tools"];
  if (Array.isArray(members)) {
    const kept = members.map((member) => normalizeHit(member, MEMBER_FIELDS)).filter((member): member is CapabilityHit => member !== null);
    if (kept.length > 0) hit["tools"] = kept;
  }
  return hit as CapabilityHit;
}

function normalizeHits(value: unknown, fields: readonly string[] = HIT_FIELDS): CapabilityHit[] {
  if (!Array.isArray(value)) return [];
  return value.map((hit) => normalizeHit(hit, fields)).filter((hit): hit is CapabilityHit => hit !== null);
}

function normalizeCoverage(value: unknown): CapabilitySearchCoverage {
  const local = isRecord(value) && value["local"] === "searched" ? "searched" : "not_searched";
  return { local, remote: "not_searched" };
}

/**
 * Reduce one successful broker/discovery result to the persisted memory shape.
 * Remote candidates are discarded without inspecting them, warnings and ranking
 * diagnostics are dropped, and permission filtering is deliberately *not* done
 * here: the projection filters against the current registry every request.
 */
export function normalizeDiscoveryMemory(result: unknown, coverage: unknown): DiscoveryMemory {
  const source = isRecord(result) ? result : {};
  const status: DiscoveryStatus = source["status"] === "partial" ? "partial" : "ok";
  const guidance = normalizeHits(source["guidance"]);
  return {
    status,
    tools: normalizeHits(source["tools"]),
    mcp: normalizeHits(source["mcp"]),
    skills: normalizeHits(source["skills"]),
    ...(guidance.length > 0 ? { guidance } : {}),
    coverage: normalizeCoverage(coverage),
  };
}

function parseRecord(data: unknown): StoredDiscovery | null {
  if (!isRecord(data) || data["version"] !== CAPABILITY_DISCOVERY_RECORD_VERSION) return null;
  const result = data["result"];
  if (!isRecord(result)) return null;
  if (result["status"] !== "ok" && result["status"] !== "partial") return null;
  const toolCallId = data["toolCallId"];
  return {
    ...(typeof toolCallId === "string" && toolCallId !== "" ? { toolCallId } : {}),
    result: normalizeDiscoveryMemory(result, result["coverage"]),
  };
}

/**
 * Every persisted discovery on the current branch, in branch order.
 *
 * The branch is read, never a separately mutable capability list, so branch
 * switches and session reloads cannot leak discoveries between contexts.
 * Entry timestamps are deliberately not read: a record's position in the branch
 * is its order, and no consumer anchors on wall-clock time.
 */

function parsePruneRecord(data: unknown): CapabilityPruneRecord | null {
  if (!isRecord(data) || data["version"] !== CAPABILITY_PRUNE_RECORD_VERSION) return null;
  const checkpointId = data["checkpointId"];
  if (typeof checkpointId !== "string" || checkpointId === "") return null;
  const rawTools = data["removedTools"];
  if (!Array.isArray(rawTools)) return null;
  const removedTools = rawTools.filter((t): t is string => typeof t === "string" && t !== "");
  const rawGroups = data["removedGroups"];
  const removedGroups = Array.isArray(rawGroups)
    ? rawGroups.filter((g): g is string => typeof g === "string" && g !== "")
    : undefined;
  return {
    version: CAPABILITY_PRUNE_RECORD_VERSION,
    checkpointId,
    removedTools,
    ...(removedGroups !== undefined && removedGroups.length > 0 ? { removedGroups } : {}),
  };
}

function filterHits(
  hits: readonly CapabilityHit[],
  removedTools: ReadonlySet<string>,
  removedGroups: ReadonlySet<string>,
): CapabilityHit[] {
  const kept: CapabilityHit[] = [];
  for (const hit of hits) {
    if (hit.ref && removedGroups.has(hit.ref)) continue;
    if (Array.isArray(hit.tools)) {
      const remainingTools = hit.tools.filter(
        (member) => typeof member.name !== "string" || !removedTools.has(member.name),
      );
      if (remainingTools.length === 0) continue;
      kept.push({
        ...hit,
        tools: remainingTools,
        ...(hit.toolCount !== undefined ? { toolCount: remainingTools.length } : {}),
      });
    } else {
      if (typeof hit.name === "string" && removedTools.has(hit.name)) continue;
      kept.push(hit);
    }
  }
  return kept;
}

function filterGuidance(
  hits: readonly CapabilityHit[] | undefined,
  removedTools: ReadonlySet<string>,
  removedGroups: ReadonlySet<string>,
): readonly CapabilityHit[] | undefined {
  if (!hits || hits.length === 0) return hits;
  const filtered = hits.filter((hit) => {
    if (hit.ref && removedGroups.has(hit.ref)) return false;
    if (hit.namespace && (removedGroups.has(hit.namespace) || removedGroups.has("namespace://" + hit.namespace))) return false;
    if (Array.isArray(hit.tools)) {
      return hit.tools.some((member) => typeof member.name !== "string" || !removedTools.has(member.name));
    }
    return true;
  });
  return filtered.length > 0 ? filtered : undefined;
}

function filterDiscoveryByPrune(
  record: StoredDiscovery,
  removedTools: ReadonlySet<string>,
  removedGroups: ReadonlySet<string>,
): StoredDiscovery {
  const { guidance: _oldGuidance, ...restResult } = record.result;
  const tools = filterHits(record.result.tools, removedTools, removedGroups);
  const mcp = filterHits(record.result.mcp, removedTools, removedGroups);
  const guidance = filterGuidance(record.result.guidance, removedTools, removedGroups);
  return {
    ...record,
    result: {
      ...restResult,
      tools,
      mcp,
      ...(guidance !== undefined ? { guidance } : {}),
      skills: record.result.skills,
    },
  };
}

export function discoveryRecords(branch: readonly unknown[] | null | undefined): StoredDiscovery[] {
  const entries = branch ?? [];
  const records: StoredDiscovery[] = [];
  const removedTools = new Set<string>();
  const removedGroups = new Set<string>();
  // Each discovery sees only later removals. Rediscovery does not resurrect
  // earlier records, and each record is projected once rather than per prune.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry["type"] !== "custom") continue;
    if (entry["customType"] === CAPABILITY_PRUNE_RECORD) {
      const prune = parsePruneRecord(entry["data"]);
      if (prune === null) continue;
      for (const name of prune.removedTools) removedTools.add(name);
      for (const group of prune.removedGroups ?? []) removedGroups.add(group);
    } else if (entry["customType"] === CAPABILITY_DISCOVERY_RECORD) {
      const record = parseRecord(entry["data"]);
      if (record !== null) {
        records.push(removedTools.size > 0 || removedGroups.size > 0
          ? filterDiscoveryByPrune(record, removedTools, removedGroups)
          : record);
      }
    }
  }
  return records.reverse();
}

/**
 * Append a `capability-prune` record for a compaction boundary.
 */
export function appendPruneRecord(
  pi: DiscoveryRecordWriter,
  checkpointId: string,
  removedTools: readonly string[],
  removedGroups: readonly string[] = [],
): CapabilityPruneRecord | null {
  if (typeof checkpointId !== "string" || checkpointId === "") return null;
  const tools = [...new Set(removedTools.filter((t) => typeof t === "string" && t !== ""))];
  const groups = [...new Set(removedGroups.filter((g) => typeof g === "string" && g !== ""))];
  const record: CapabilityPruneRecord = {
    version: CAPABILITY_PRUNE_RECORD_VERSION,
    checkpointId,
    removedTools: tools,
    ...(groups.length > 0 ? { removedGroups: groups } : {}),
  };
  pi.appendEntry(CAPABILITY_PRUNE_RECORD, record);
  return record;
}

/**
 * Return the latest `capability-prune` record on the branch, if any.
 */
export function latestPruneRecord(branch: readonly unknown[] | null | undefined): CapabilityPruneRecord | null {
  for (let i = (branch?.length ?? 0) - 1; i >= 0; i--) {
    const entry = branch![i];
    if (!isRecord(entry)) continue;
    if (entry["type"] === "custom" && entry["customType"] === CAPABILITY_PRUNE_RECORD) {
      const record = parsePruneRecord(entry["data"]);
      if (record !== null) return record;
    }
  }
  return null;
}


/**
 * Return the set of currently pruned tool names derived from branch history.
 *
 * Removed names follow branch order. Later discovery or a native system
 * `toolsAdded` declaration reintroduces a name; a later prune retires it again.
 * A published post-prune declaration therefore survives the end of a temporary
 * `enabled` override. MCP selection and execution permissions remain separate
 * admission checks.
 */
export function prunedToolNames(branch: readonly unknown[] | null | undefined): ReadonlySet<string> {
  const pruned = new Set<string>();

  for (const entry of branch ?? []) {
    if (!isRecord(entry)) continue;
    const type = entry["type"];

    if (type === "custom") {
      if (entry["customType"] === CAPABILITY_PRUNE_RECORD) {
        const record = parsePruneRecord(entry["data"]);
        if (record !== null) {
          for (const name of record.removedTools) pruned.add(name);
        }
      } else if (entry["customType"] === CAPABILITY_DISCOVERY_RECORD) {
        const discovery = parseRecord(entry["data"]);
        if (discovery !== null) {
          for (const category of ["tools", "mcp"] as const) {
            for (const hit of discovery.result[category] ?? []) {
              if (hit.status && hit.status !== "available") continue;
              for (const member of hit.tools ?? [hit]) {
                if (member.status && member.status !== "available") continue;
                if (typeof member.name === "string" && member.name !== "") {
                  pruned.delete(member.name);
                }
              }
            }
          }
        }
      }
    } else if (type === "message") {
      const message = entry["message"];
      if (!isRecord(message) || message["role"] !== "system") continue;
      const added = message["toolsAdded"];
      if (!Array.isArray(added)) continue;
      for (const tool of added) {
        const name = isRecord(tool) ? tool["name"] : undefined;
        if (typeof name === "string" && name !== "") pruned.delete(name);
      }
    }
  }

  return pruned;
}

/**
 * Persist one successful discovery. Only `ok` and `partial` runs are memory:
 * a failed run must not be remembered as "nothing found". Returns the stored
 * memory, or null when the result is not a successful discovery.
 */
export function appendDiscoveryRecord(
  pi: DiscoveryRecordWriter,
  toolCallId: string | undefined,
  result: unknown,
  coverage: unknown,
): DiscoveryMemory | null {
  if (!isRecord(result) || (result["status"] !== "ok" && result["status"] !== "partial")) return null;
  const memory = normalizeDiscoveryMemory(result, coverage);
  const record: CapabilityDiscoveryRecord = {
    version: CAPABILITY_DISCOVERY_RECORD_VERSION,
    ...(typeof toolCallId === "string" && toolCallId !== "" ? { toolCallId } : {}),
    result: memory,
  };
  pi.appendEntry(CAPABILITY_DISCOVERY_RECORD, record);
  return memory;
}
