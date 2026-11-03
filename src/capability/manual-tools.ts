/**
 * Manual tool classification.
 *
 * A manual tool is enabled only by the user through `/capability enable`. The
 * classification is a name policy, resolved against the live registry on every
 * use: an exact tool name, or a trailing `*` that matches a name prefix.
 *
 * The policy is intentionally not a capability record: it grants nothing. It
 * only removes a tool from model discovery and from inherited child loadouts,
 * which is why it must be re-read on every request instead of being cached into
 * branch memory.
 */

export type ManualToolMatcher = (name: string) => boolean;

/** No tool is manual; the default when the setting is empty. */
export const NO_MANUAL_TOOLS: ManualToolMatcher = () => false;

/**
 * Compile configured name patterns into one predicate.
 *
 * A pattern is trimmed; empty patterns are ignored. A pattern ending in `*`
 * matches every tool name with that prefix, so `mcp__prod__*` covers a whole
 * server without listing its tools.
 */
export function manualToolMatcher(patterns: readonly string[]): ManualToolMatcher {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed === '') continue;
    if (trimmed.endsWith('*')) prefixes.push(trimmed.slice(0, -1));
    else exact.add(trimmed);
  }
  if (exact.size === 0 && prefixes.length === 0) return NO_MANUAL_TOOLS;
  return (name) => exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
}
