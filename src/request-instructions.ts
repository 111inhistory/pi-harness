/**
 * Shared helpers for applying Harness dynamic prompt sections via the SDK's
 * native `systemPromptOptions.sections` and formatting persisted mid-run
 * boundary sync messages (`custom_message` encoded as `user`).
 */

export const HARNESS_CONTEXT_SYNC_CUSTOM_TYPE = 'harness-context-sync';

const VALID_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * Write non-empty owned sections onto `target` (`event.systemPromptOptions.sections`)
 * and remove any previously owned keys that are no longer active, so the SDK
 * natively diffs and persists section updates before the turn's user message.
 */
export function applySystemPromptSections(
  target: Record<string, string>,
  sections: Readonly<Record<string, string | null | undefined>>,
  ownedKeys?: Iterable<string>,
): void {
  const activeKeys = new Set<string>();
  for (const [key, value] of Object.entries(sections)) {
    if (!VALID_SECTION_NAME.test(key) || key === 'preamble') {
      throw new Error(`Invalid system prompt section name: ${key}`);
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      target[key] = value;
      activeKeys.add(key);
    } else {
      delete target[key];
    }
  }
  if (ownedKeys !== undefined) {
    for (const key of ownedKeys) {
      if (!activeKeys.has(key)) delete target[key];
    }
  }
}

/**
 * Format changed dynamic sections into a non-empty persisted `custom_message`
 * body for mid-run boundaries (same-run discovery, nested discovery, or
 * auto-compaction). Never returns an empty or whitespace-only string.
 */
export function renderCustomContextSync(
  sections: Readonly<Record<string, string | null | undefined>>,
  fallbackSummary?: string,
): string | null {
  const blocks: string[] = [];
  for (const [key, value] of Object.entries(sections)) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const openTag = `<${key}>`;
    const closeTag = `</${key}>`;
    const trimmed = value.trim();
    if (trimmed.startsWith(openTag) && trimmed.endsWith(closeTag)) {
      blocks.push(value);
    } else {
      blocks.push(`<${key}>\n${value}\n</${key}>`);
    }
  }
  if (blocks.length > 0) return blocks.join('\n\n');
  if (fallbackSummary !== undefined && fallbackSummary.trim().length > 0) {
    return fallbackSummary.trim();
  }
  return null;
}
