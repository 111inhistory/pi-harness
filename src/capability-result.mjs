/**
 * Keep retrieval ranking and diagnostic warnings out of Main's tool content.
 * Discovery is local-only: remote candidates are dropped even if a caller
 * hands them in, and the
 * result's `coverage` says remote was not searched rather than implying the
 * marketplace had no matches.
 *
 * A failed discovery still needs one model-facing explanation. Its warnings are
 * diagnostic data, so Main gets only a compact `failureReason` taken from the
 * final failure warning: first line, bounded, no control characters and no
 * diagnostic arrays or resource catalog.
 */

/** Maximum length of the public failure reason, including the ellipsis. */
export const FAILURE_REASON_LIMIT = 240;

const FALLBACK_FAILURE_REASON = "capability discovery failed.";

function publicFailureReason(warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const value = list[index];
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

export function capabilityPublicResult(result) {
  const hit = (candidate) => {
    const { match, score, reason, warnings, ...visible } = candidate;
    if (Array.isArray(visible.bindsTo) && visible.bindsTo.length === 0) delete visible.bindsTo;
    if (Array.isArray(visible.caveats) && visible.caveats.length === 0) delete visible.caveats;
    return { ...visible, ...(Array.isArray(visible.tools) ? { tools: visible.tools.map(hit) } : {}) };
  };
  const { warnings, remote: _remote, ...visible } = result;
  return {
    ...visible,
    remote: [],
    ...(result.status === "failed" ? { failureReason: publicFailureReason(warnings) } : {}),
    ...Object.fromEntries(["tools", "mcp", "skills", "guidance"].filter((key) => Array.isArray(visible[key])).map((key) => [key, visible[key].map(hit)])),
  };
}
