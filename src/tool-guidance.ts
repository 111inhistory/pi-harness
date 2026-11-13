/** Current tool and namespace instructions, independent of historical placement. */
export interface ToolGuidance {
  readonly id: string;
  readonly tools: readonly string[];
  readonly text: string;
  readonly namespace?: string;
  /** The current caller scope decides whether this guidance is applicable. */
  readonly eligible?: boolean;
}

export const TOOL_GUIDANCE_SECTION_PREFIX = 'harness-guidance:';

export function toolGuidanceSection(id: string): string {
  return `${TOOL_GUIDANCE_SECTION_PREFIX}${id}`;
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
