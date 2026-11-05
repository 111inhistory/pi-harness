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
  /**
   * Resources with explicit user authorization, never
   * through retrieval. The category is what distinguishes a user decision from
   * a model discovery in the projected section; both share the branch record.
   */
  readonly manual?: readonly CapabilityHit[];
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
  const manual = normalizeHits(source["manual"]);
  return {
    status,
    tools: normalizeHits(source["tools"]),
    mcp: normalizeHits(source["mcp"]),
    skills: normalizeHits(source["skills"]),
    ...(guidance.length > 0 ? { guidance } : {}),
    ...(manual.length > 0 ? { manual } : {}),
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
export function discoveryRecords(branch: readonly unknown[] | null | undefined): StoredDiscovery[] {
  const records: StoredDiscovery[] = [];
  for (const entry of branch ?? []) {
    if (!isRecord(entry)) continue;
    if (entry["type"] !== "custom" || entry["customType"] !== CAPABILITY_DISCOVERY_RECORD) continue;
    const record = parseRecord(entry["data"]);
    if (record !== null) records.push(record);
  }
  return records;
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

/**
 * Tool names with explicit user authorization on this branch.
 *
 * This is the only authority that makes a manual tool usable. The command writes
 * the record after activation, so a tool that is active only because it is
 * `defaultActive`, restored from the transcript or enabled by another extension
 * stays unauthorized until the user enables it here.
 */
export function manualEnabledTools(branch: readonly unknown[] | null | undefined): Set<string> {
  const names = new Set<string>();
  for (const record of discoveryRecords(branch)) {
    for (const hit of record.result.manual ?? []) {
      for (const member of hit.tools ?? [hit]) {
        if (typeof member.name === "string" && member.name !== "") names.add(member.name);
      }
    }
  }
  return names;
}

/**
 * Persist resources the user enabled directly. No retrieval ran, so the record
 * carries no tool call anchor: the projection folds it into the leading
 * checkpoint instead of anchoring it to a tool result.
 *
 * The caller supplies the hits already verified as active in this session, so a
 * record can never advertise a tool that the session did not activate.
 */
export function appendManualRecord(
  pi: DiscoveryRecordWriter,
  hits: readonly CapabilityHit[],
): DiscoveryMemory {
  const manual = normalizeHits(hits);
  if (manual.length === 0) throw new TypeError("A manual capability record requires at least one resource with a ref.");
  const memory: DiscoveryMemory = {
    status: "ok",
    tools: [],
    mcp: [],
    skills: [],
    manual,
    coverage: { local: "not_searched", remote: "not_searched" },
  };
  const record: CapabilityDiscoveryRecord = { version: CAPABILITY_DISCOVERY_RECORD_VERSION, result: memory };
  pi.appendEntry(CAPABILITY_DISCOVERY_RECORD, record);
  return memory;
}
