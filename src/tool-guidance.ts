/**
 * Deterministic tool-guidance projection.
 *
 * Tool declarations are historical anchors: guidance is inserted once, directly
 * after the first `toolsAdded` declaration of a tool that the guidance entry
 * names. Re-declaring a tool never duplicates its guidance, and inherited or
 * compaction-produced guidance is recognized by its explicit section marker.
 * A marker whose latest text differs from the asset receives one incremental
 * update instead of an in-place rewrite. This module only projects request
 * context; it never enables execution, removes tools or rewrites an earlier
 * declaration.
 *
 * With a guidance journal the projection becomes append-only across asset edits:
 * the journal records the text that was actually emitted and the fixed native
 * message ordinal it followed. A resumed request replays the recorded text at
 * that same ordinal, so appends after the record never move it and the provider
 * prefix stays identical. A changed asset text is a new record after the current
 * last native message, not a replacement. A removed asset appends a native
 * `sections[id]: null` update at the same fixed placement; already-emitted
 * history is never dropped from the request.
 *
 * The placement format and replay engine are shared with other request-only
 * prompt sections (`src/prompt-section-journal.ts`); this module owns only the
 * tool-declaration bootstrap and the `harness-tool-guidance` record type.
 */
import type { SystemMessage } from '@earendil-works/pi-ai';

import type { TranscriptMessageLike } from './session-transcript.ts';
import {
  PROMPT_SECTION_RECORD_VERSION,
  appendPromptSectionRecord,
  promptSectionMarkers,
  promptSectionMessage,
  promptSectionRecords,
  promptSectionText,
  replayPromptSections,
  type PromptSectionRecordWriter,
  type PromptSectionSource,
} from './prompt-section-journal.ts';

/** Original asset text, paired with the tool declarations it explains. */
export interface ToolGuidance {
  readonly id: string;
  /** First declaration of any listed tool is the anchor for this entry. */
  readonly tools: readonly string[];
  readonly text: string;
  /** Source identity (for example a registered namespace) used for source dedup. */
  readonly namespace?: string;
  /**
   * Where an entry without a marker is first introduced. Static asset entries
   * default to `declaration`: the first matching tool declaration is their
   * historical anchor. Live registry sources use `tail` because current registry
   * metadata cannot reconstruct its historical text at that old declaration;
   * inventing one there would rewrite the historical prefix.
   */
  readonly initialPlacement?: 'declaration' | 'tail';
  /** Current callable scope can expose guidance through an indirect tool path. */
  readonly eligible?: boolean;
}

/** `customType` of the branch entry holding one emitted tool-guidance snapshot. */
export const TOOL_GUIDANCE_RECORD = 'harness-tool-guidance';

/** Stable section marker prefix; inherited/replayed guidance is recognized by it. */
export const TOOL_GUIDANCE_SECTION_PREFIX = 'harness-guidance:';

export function toolGuidanceSection(id: string): string {
  return `${TOOL_GUIDANCE_SECTION_PREFIX}${id}`;
}

/** Native branch access plus the append action the journal needs. */
export interface ToolGuidanceJournal extends PromptSectionRecordWriter {
  readonly branch: readonly unknown[];
  /** Latest native context boundary id (compaction or explicit edit), or null. */
  readonly checkpointId: string | null;
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

/** Guidance the current request anchors: non-blank text and at least one tool. */
function activeGuidance(guidance: readonly ToolGuidance[]): readonly ToolGuidance[] {
  return guidance.filter((entry) => entry.text.trim().length > 0 && entry.tools.length > 0);
}

function declaredNames(message: TranscriptMessageLike): Set<string> {
  const names = new Set<string>();
  for (const candidate of message.toolsAdded ?? []) {
    const name = toolName(candidate);
    if (name !== null) names.add(name);
  }
  return names;
}

function declares(messages: readonly TranscriptMessageLike[], tools: readonly string[]): boolean {
  return messages.some((message) => {
    if (message.role !== 'system') return false;
    const names = declaredNames(message);
    return tools.some((name) => names.has(name));
  });
}

function guidanceMessage(id: string, text: string | null, timestamp: number): SystemMessage {
  return promptSectionMessage(id, text, timestamp, toolGuidanceSection);
}

function tailTimestampOf(messages: readonly TranscriptMessageLike[]): number {
  const last = messages[messages.length - 1];
  return last === undefined ? 0 : timestampOf(last);
}

/**
 * Insert each guidance once after the first historical declaration of a tool it
 * names. Entries sharing an anchor keep table order, so common guidance precedes
 * tool-specific guidance. Existing section markers suppress reinsertion across
 * inheritance, replay and compaction; a marker whose latest text differs from
 * the asset gets one incremental update at the tail, so old context is never
 * rewritten. User content is never inspected.
 */
export function projectToolGuidance<M extends TranscriptMessageLike>(
  messages: readonly M[],
  guidance: readonly ToolGuidance[],
): readonly (M | SystemMessage)[] {
  const entries = activeGuidance(guidance);
  if (entries.length === 0) return messages;

  const last = promptSectionMarkers(messages, entries.map((entry) => entry.id), toolGuidanceSection);
  const anchored = new Set<string>();
  const projected: (M | SystemMessage)[] = [];
  for (const message of messages) {
    projected.push(message);
    if (message.role !== 'system') continue;
    const declarations = declaredNames(message);
    if (declarations.size === 0) continue;
    for (const entry of entries) {
      if (entry.initialPlacement === 'tail' || entry.eligible === false) continue;
      if (last.has(entry.id) || anchored.has(entry.id)) continue;
      if (!entry.tools.some((name) => declarations.has(name))) continue;
      anchored.add(entry.id);
      projected.push(guidanceMessage(entry.id, entry.text, timestampOf(message)));
    }
  }

  const timestamp = tailTimestampOf(messages);
  for (const entry of entries) {
    const previous = last.get(entry.id)?.text;
    if (previous === undefined) {
      // Live sources never fabricate historical text at an old declaration.
      if (!anchored.has(entry.id) && (entry.eligible ?? declares(messages, entry.tools)) &&
        (entry.initialPlacement === 'tail' || entry.eligible === true)) {
        projected.push(guidanceMessage(entry.id, entry.text, timestamp));
      }
      continue;
    }
    if (previous === entry.text) continue;
    projected.push(guidanceMessage(entry.id, entry.text, timestamp));
  }
  return projected;
}

/**
 * Project guidance with durable placement memory.
 *
 * The caller passes native messages (before any Capability projection), the
 * branch it read them from, the latest native context boundary id, and
 * `pi.appendEntry`. The first call bootstraps the journal from
 * `projectToolGuidance` placements, records markers that were already inherited,
 * and persists exactly what was emitted. Later calls replay the whole recorded
 * history through the shared section engine and append only what the current
 * asset adds or removes, so the old request prefix survives resume, branch
 * rewind, inheritance and asset removal.
 *
 * Positions are native message ordinals of the passed request, which must be the
 * native transcript before Capability adds messages. A native context boundary
 * (compaction or explicit context edit) is the supported prefix rebuild: records
 * from an older boundary are rebased into the new leading system boundary instead
 * of reusing their old ordinals. A raw record whose ordinal no longer exists
 * within the same boundary still fails explicitly instead of moving guidance.
 */
export function projectRecordedToolGuidance<M extends TranscriptMessageLike>(
  messages: readonly M[],
  guidance: readonly ToolGuidance[],
  journal: ToolGuidanceJournal,
): readonly (M | SystemMessage)[] {
  const entries = activeGuidance(guidance);
  const records = promptSectionRecords(journal.branch, TOOL_GUIDANCE_RECORD);
  if (records.length === 0) {
    return entries.length === 0 ? messages : bootstrapToolGuidance(messages, entries, journal);
  }
  const sources: PromptSectionSource[] = entries.map((entry) => ({
    id: entry.id,
    text: entry.text,
    eligible: entry.eligible ?? declares(messages, entry.tools),
  }));
  return replayPromptSections(messages, sources, records, {
    checkpointId: journal.checkpointId,
    recordType: TOOL_GUIDANCE_RECORD,
    appendEntry: (customType, data) => journal.appendEntry(customType, data),
    sectionName: toolGuidanceSection,
  });
}

/**
 * First journal write. Existing-anchor placements come from the pure projection.
 * A marker that is already inherited is recorded as a metadata-only snapshot so
 * the journal exists even when nothing was inserted; later guidance ids then
 * append instead of anchoring retroactively. Only non-blank, eligible entries
 * are bootstrapped.
 */
function bootstrapToolGuidance<M extends TranscriptMessageLike>(
  messages: readonly M[],
  entries: readonly ToolGuidance[],
  journal: ToolGuidanceJournal,
): readonly (M | SystemMessage)[] {
  const markers = promptSectionMarkers(messages, entries.map((entry) => entry.id), toolGuidanceSection);
  const appendPosition = Math.max(messages.length - 1, 0);

  for (const entry of entries) {
    const marker = markers.get(entry.id);
    if (marker === undefined) continue;
    appendPromptSectionRecord(journal, TOOL_GUIDANCE_RECORD, {
      version: PROMPT_SECTION_RECORD_VERSION,
      checkpointId: journal.checkpointId,
      id: entry.id,
      text: marker.text,
      position: marker.ordinal,
    });
  }

  const baseline = projectToolGuidance(messages, entries);
  let ordinal = -1;
  let next = 0;
  for (const message of baseline) {
    if (next < messages.length && message === messages[next]) {
      ordinal = next;
      next += 1;
      continue;
    }
    const id = guidanceIdOf(message, entries);
    if (id === null) continue;
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry === undefined) continue;
    const position = markers.has(id) ? appendPosition : ordinal >= 0 ? ordinal : appendPosition;
    appendPromptSectionRecord(journal, TOOL_GUIDANCE_RECORD, {
      version: PROMPT_SECTION_RECORD_VERSION,
      checkpointId: journal.checkpointId,
      id,
      text: entry.text,
      position,
    });
  }
  return baseline;
}

function guidanceIdOf(message: TranscriptMessageLike, entries: readonly ToolGuidance[]): string | null {
  for (const entry of entries) {
    if (typeof promptSectionText(message, toolGuidanceSection(entry.id)) === 'string') return entry.id;
  }
  return null;
}
