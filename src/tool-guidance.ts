/** Current tool and namespace instructions, independent of historical placement. */
export interface ToolGuidance {
  readonly id: string;
  readonly tools: readonly string[];
  readonly text: string;
  readonly namespace?: string;
  /** The current caller scope decides whether this guidance is applicable. */
  readonly eligible?: boolean;
}

export const TOOL_GUIDANCE_SECTION_PREFIX = 'harness-guidance-';

const VALID_GUIDANCE_SUFFIX = /^[a-z0-9_-]+$/;
const ENCODED_GUIDANCE_PREFIX = 'x_';

/**
 * Losslessly map an arbitrary guidance identifier (e.g. `namespace:browser` or
 * `tool-permission:disabled`) into a valid SDK `systemPromptOptions.sections`
 * key matching `/^[a-z][a-z0-9_-]*$/`.
 *
 * Valid SDK suffixes not starting with `x_` pass through verbatim; everything
 * else is encoded with `x_` plus full UTF-8 hex so valid and invalid IDs never
 * collide.
 */
export function toolGuidanceSection(id: string): string {
  if (VALID_GUIDANCE_SUFFIX.test(id) && !id.startsWith(ENCODED_GUIDANCE_PREFIX)) {
    return `${TOOL_GUIDANCE_SECTION_PREFIX}${id}`;
  }
  return `${TOOL_GUIDANCE_SECTION_PREFIX}${ENCODED_GUIDANCE_PREFIX}${Buffer.from(id, 'utf8').toString('hex')}`;
}

/** Render applicable current text once; absent entries need no removal tombstone. */
export function renderCurrentToolGuidance(guidance: readonly ToolGuidance[]): Record<string, string> {
  const sections: Record<string, string> = {};
  for (const entry of guidance) {
    if (entry.eligible === false || entry.tools.length === 0 || entry.text.trim().length === 0) continue;
    sections[toolGuidanceSection(entry.id)] = entry.text;
  }
  return sections;
}
