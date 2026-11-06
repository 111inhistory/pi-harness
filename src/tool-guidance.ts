/**
 * Deterministic tool-guidance projection.
 *
 * Tool declarations are historical anchors: guidance is inserted once, directly
 * after the first `toolsAdded` declaration of a tool that the guidance entry
 * names. Re-declaring a tool never duplicates its guidance, and inherited or
 * compaction-produced guidance is recognized by its explicit section marker.
 * This module only projects request context; it never enables execution,
 * removes tools or rewrites an earlier declaration.
 */
import type { SystemMessage } from '@earendil-works/pi-ai';

import type { TranscriptMessageLike } from './session-transcript.ts';

/** Original asset text, paired with the tool declarations it explains. */
export interface ToolGuidance {
  readonly id: string;
  /** First declaration of any listed tool is the anchor for this entry. */
  readonly tools: readonly string[];
  readonly text: string;
}

/** Stable section marker prefix; inherited/replayed guidance is recognized by it. */
export const TOOL_GUIDANCE_SECTION_PREFIX = 'harness-guidance:';

export function toolGuidanceSection(id: string): string {
  return `${TOOL_GUIDANCE_SECTION_PREFIX}${id}`;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value['name'] === 'string' ? value['name'] : null;
}

function timestampOf(message: TranscriptMessageLike): number {
  const timestamp = (message as { readonly timestamp?: unknown }).timestamp;
  return typeof timestamp === 'number' ? timestamp : 0;
}

function hasGuidance(message: TranscriptMessageLike, section: string): boolean {
  if (message.role !== 'system') return false;
  const sections = (message as { readonly sections?: unknown }).sections;
  if (!isRecord(sections)) return false;
  return typeof sections[section] === 'string';
}

/**
 * Insert each guidance once after the first historical declaration of a tool it
 * names. Entries sharing an anchor keep table order, so common guidance precedes
 * tool-specific guidance. Existing section markers suppress reinsertion across
 * inheritance, replay and compaction; user content is never inspected.
 */
export function projectToolGuidance<M extends TranscriptMessageLike>(
  messages: readonly M[],
  guidance: readonly ToolGuidance[],
): readonly (M | SystemMessage)[] {
  const entries = guidance.filter((entry) => entry.text.trim().length > 0 && entry.tools.length > 0);
  if (entries.length === 0) return messages;

  const present = new Set<string>();
  for (const message of messages) {
    for (const entry of entries) {
      if (hasGuidance(message, toolGuidanceSection(entry.id))) present.add(entry.id);
    }
  }

  const anchored = new Set<string>();
  const projected: (M | SystemMessage)[] = [];
  for (const message of messages) {
    projected.push(message);
    if (message.role !== 'system') continue;
    const declarations = new Set<string>();
    for (const candidate of message.toolsAdded ?? []) {
      const name = toolName(candidate);
      if (name !== null) declarations.add(name);
    }
    if (declarations.size === 0) continue;
    for (const entry of entries) {
      if (present.has(entry.id) || anchored.has(entry.id)) continue;
      if (!entry.tools.some((name) => declarations.has(name))) continue;
      anchored.add(entry.id);
      projected.push({
        role: 'system',
        content: '',
        sections: { [toolGuidanceSection(entry.id)]: entry.text },
        timestamp: timestampOf(message),
      });
      present.add(entry.id);
    }
  }
  return projected;
}
