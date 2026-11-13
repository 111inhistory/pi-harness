import { createHash } from 'node:crypto';

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

/**
 * Map an arbitrary guidance identifier (e.g. `namespace:browser` or
 * `tool-permission:disabled`) into a valid SDK `systemPromptOptions.sections`
 * key matching `/^[a-z][a-z0-9_-]*$/`, preserving collision freedom.
 */
export function toolGuidanceSection(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'entry';
  const base = `${TOOL_GUIDANCE_SECTION_PREFIX}${slug}`;
  if (id === slug && /^[a-z0-9_-]+$/.test(id)) return base;
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
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
