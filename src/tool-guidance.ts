/** Current tool and namespace instructions, independent of historical placement. */
export interface ToolGuidance {
  readonly id: string;
  readonly tools: readonly string[];
  readonly text: string;
  readonly namespace?: string;
  /** The current caller scope decides whether this guidance is applicable. */
  readonly eligible?: boolean;
}

/** Render applicable guidance entries into one combined text block, or null when empty. */
export function renderGuidanceText(guidance: readonly ToolGuidance[]): string | null {
  const blocks: string[] = [];
  for (const entry of guidance) {
    if (entry.eligible === false || entry.tools.length === 0 || entry.text.trim().length === 0) continue;
    blocks.push(entry.text);
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}
