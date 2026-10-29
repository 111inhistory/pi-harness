/**
 * Keep retrieval ranking and diagnostic warnings out of Main's tool content.
 * Discovery is local-only: remote candidates are dropped even if a caller
 * hands them in, and the result's `coverage` says remote was not searched
 * rather than implying the marketplace had no matches.
 *
 * A failed discovery still needs one model-facing explanation. Its warnings are
 * diagnostic data, so Main gets only a compact `failureReason` taken from the
 * final failure warning: first line, bounded, no control characters and no
 * diagnostic arrays or resource catalog.
 *
 * Broker/discovery results cross a dynamic provider boundary, so this module
 * normalizes records instead of trusting a concrete runtime shape.
 */

/** Maximum length of the public failure reason, including the ellipsis. */
export const FAILURE_REASON_LIMIT = 240;

const FALLBACK_FAILURE_REASON = "capability discovery failed.";

/** Fields that never reach Main, stripped from every hit at any depth. */
const DIAGNOSTIC_HIT_FIELDS = new Set(["match", "score", "reason", "warnings"]);

/** Result groups whose entries are hits rather than plain values. */
const HIT_GROUPS = new Set(["tools", "mcp", "skills", "guidance"]);

type UnknownRecord = Record<string, unknown>;

/** One model-facing hit: selected resource fields, no ranking diagnostics. */
export interface CapabilityPublicHit {
  readonly [field: string]: unknown;
  readonly tools?: readonly CapabilityPublicHit[];
}

/** The model-facing discovery result. */
export interface CapabilityPublicResult {
  readonly [field: string]: unknown;
  readonly status?: "ok" | "partial" | "failed";
  readonly tools?: readonly CapabilityPublicHit[];
  readonly mcp?: readonly CapabilityPublicHit[];
  readonly skills?: readonly CapabilityPublicHit[];
  readonly guidance?: readonly CapabilityPublicHit[];
  /** Discovery is local-only, so this is always empty. */
  readonly remote: readonly never[];
  readonly failureReason?: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicFailureReason(warnings: unknown): string {
  const list = Array.isArray(warnings) ? warnings : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const value: unknown = list[index];
    const text = typeof value === "string" ? value : String(value ?? "");
    // The first line is the human-readable reason; trailing output (debug
    // catalogs, stack excerpts, resource dumps) is never model-facing.
    const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? "";
    const clean = firstLine
      .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (clean === "") continue;
    return clean.length <= FAILURE_REASON_LIMIT ? clean : `${clean.slice(0, FAILURE_REASON_LIMIT - 1)}…`;
  }
  return FALLBACK_FAILURE_REASON;
}

function publicHit(candidate: unknown): CapabilityPublicHit {
  if (!isRecord(candidate)) return {};
  const visible: UnknownRecord = {};
  for (const [field, value] of Object.entries(candidate)) {
    if (DIAGNOSTIC_HIT_FIELDS.has(field)) continue;
    visible[field] = field === "tools" && Array.isArray(value) ? value.map(publicHit) : value;
  }
  return visible;
}

/**
 * Reduce one broker/discovery result to the model-facing content.
 *
 * Hit details and tool parameters are kept verbatim, but ranking diagnostics,
 * nested hit diagnostics and warnings never are. The input is never mutated.
 */
export function capabilityPublicResult(result: unknown): CapabilityPublicResult {
  const source = isRecord(result) ? result : {};
  const visible: UnknownRecord = {};
  for (const [field, value] of Object.entries(source)) {
    if (field === "warnings" || field === "remote") continue;
    visible[field] = HIT_GROUPS.has(field) && Array.isArray(value) ? value.map(publicHit) : value;
  }
  return {
    ...visible,
    remote: [],
    ...(source["status"] === "failed" ? { failureReason: publicFailureReason(source["warnings"]) } : {}),
  };
}
