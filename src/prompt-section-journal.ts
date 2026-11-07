/**
 * Generic append-only journal for request-only prompt sections.
 *
 * Some request state never reaches the native transcript: tool guidance and
 * Capability memory are projected system sections, so the message that carries
 * them exists only for one request. This module keeps the durable placement of
 * such a section as one invisible native custom entry: the exact text that was
 * emitted plus the fixed native message ordinal it followed. A resumed request
 * replays that history verbatim, and a changed or removed source appends one new
 * placement after the current last native message instead of rewriting an old
 * anchor.
 *
 * The engine is section-agnostic: one journal domain is one record type plus a
 * section-name function, so two domains cannot remove or move each other's
 * state. Each domain owns its bootstrap; this module only replays records.
 *
 * Records are append-only snapshots scoped by the native context boundary
 * (`checkpointId`: the latest compaction or explicit context edit, null before
 * one exists) because such a boundary legitimately rebuilds the message prefix
 * and invalidates native message ordinals. Within one boundary an absent
 * ordinal is structural damage and fails explicitly.
 *
 * Only record data read back from the session branch is validated. Structural
 * damage in a harness-owned entry is a hard error: a silent fallback would
 * replay a section at the wrong position or with the wrong text.
 */
import type { SystemMessage } from '@earendil-works/pi-ai';

import type { TranscriptMessageLike } from './session-transcript.ts';

/** The only record version this module reads; there is no legacy schema. */
export const PROMPT_SECTION_RECORD_VERSION = 1;

/**
 * Where the emitted section sits in the native message list:
 * - `number`: a system message inserted after this fixed native message ordinal.
 *   The ordinal is captured once, so later appends never move the section.
 * - `head`: merged into the current native context boundary's leading system
 *   boundary. Only boundary rebasing writes this, because the boundary rebuilds
 *   the prefix.
 */
export type PromptSectionPosition = number | 'head';

/** The stored payload of one journal custom entry. */
export interface PromptSectionRecord {
  readonly version: typeof PROMPT_SECTION_RECORD_VERSION;
  /** Latest native context boundary id at write time; null before one exists. */
  readonly checkpointId: string | null;
  /** Section id this text was emitted for. */
  readonly id: string;
  /** Exact emitted text, or null for the incremental section removal update. */
  readonly text: string | null;
  readonly position: PromptSectionPosition;
}

/** Branch access plus the append action a journal needs. */
export interface PromptSectionJournal {
  readonly checkpointId: string | null;
  /** Custom entry type owned by this journal domain. */
  readonly recordType: string;
  appendEntry(customType: string, data: unknown): void;
  /** Native system section name for a source id. */
  sectionName(id: string): string;
}

/** One current request source; a null text removes the section. */
export interface PromptSectionSource {
  readonly id: string;
  readonly text: string | null;
  /** Whether a source without any record may append now (tool declared, etc.). */
  readonly eligible: boolean;
}

/** The only Pi extension action the record helpers need. */
export interface PromptSectionRecordWriter {
  appendEntry(customType: string, data: unknown): void;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformed(recordType: string, detail: string): never {
  throw new Error(`Malformed ${recordType} entry on the session branch: ${detail}`);
}

function parseRecord(recordType: string, data: unknown): PromptSectionRecord {
  if (!isRecord(data)) malformed(recordType, 'expected an object payload');
  if (data['version'] !== PROMPT_SECTION_RECORD_VERSION) {
    malformed(recordType, `expected version ${PROMPT_SECTION_RECORD_VERSION}, got ${String(data['version'])}`);
  }
  const checkpointId = data['checkpointId'];
  if (checkpointId !== null && typeof checkpointId !== 'string') {
    malformed(recordType, 'checkpointId must be a string or null');
  }
  const id = data['id'];
  if (typeof id !== 'string' || id.length === 0) malformed(recordType, 'id must be a non-empty string');
  const text = data['text'];
  if (text !== null && typeof text !== 'string') malformed(recordType, 'text must be a string or null');
  const position = data['position'];
  if (position !== 'head' &&
    (typeof position !== 'number' || !Number.isInteger(position) || position < 0)) {
    malformed(recordType, 'position must be "head" or a non-negative integer ordinal');
  }
  return {
    version: PROMPT_SECTION_RECORD_VERSION,
    checkpointId: checkpointId as string | null,
    id,
    text: text as string | null,
    position,
  };
}

/**
 * Every journal snapshot of one domain on the current branch, in branch order.
 *
 * The branch is read, never a separately mutable journal, so reopen, inheritance
 * and branch rewind all reconstruct placement from the entries that survive.
 */
export function promptSectionRecords(
  branch: readonly unknown[] | null | undefined,
  recordType: string,
): PromptSectionRecord[] {
  const records: PromptSectionRecord[] = [];
  for (const entry of branch ?? []) {
    if (!isRecord(entry)) continue;
    if (entry['type'] !== 'custom' || entry['customType'] !== recordType) continue;
    records.push(parseRecord(recordType, entry['data']));
  }
  return records;
}

/** Persist one placement snapshot under the owning journal's record type. */
export function appendPromptSectionRecord(
  writer: PromptSectionRecordWriter,
  recordType: string,
  record: PromptSectionRecord,
): void {
  writer.appendEntry(recordType, record);
}

/** True for a system section map, so only `sections` count as markers. */
function promptSections(message: TranscriptMessageLike): UnknownRecord | null {
  if (message.role !== 'system') return null;
  const sections = (message as { readonly sections?: unknown }).sections;
  return isRecord(sections) ? sections : null;
}

/**
 * The section value on a message: `undefined` when the section is absent,
 * explicit `null` for a native removal marker, otherwise its text.
 */
export function promptSectionText(message: TranscriptMessageLike, section: string): string | null | undefined {
  const sections = promptSections(message);
  if (sections === null) return undefined;
  const text = sections[section];
  return typeof text === 'string' || text === null ? text : undefined;
}

interface SectionMarker {
  readonly text: string | null;
  readonly ordinal: number;
}

/**
 * Latest marker per source id; the comparison baseline. Only system `sections`
 * count, so equal user text never suppresses a projection; a later marker
 * supersedes an earlier one for the same id.
 */
export function promptSectionMarkers<M extends TranscriptMessageLike>(
  messages: readonly M[],
  ids: readonly string[],
  sectionName: (id: string) => string,
): Map<string, SectionMarker> {
  const last = new Map<string, SectionMarker>();
  for (const [ordinal, message] of messages.entries()) {
    if (message.role !== 'system') continue;
    for (const id of ids) {
      const text = promptSectionText(message, sectionName(id));
      if (text !== undefined) last.set(id, { text, ordinal });
    }
  }
  return last;
}

/** One update message; `null` text is the native incremental removal primitive. */
export function promptSectionMessage(
  id: string,
  text: string | null,
  timestamp: number,
  sectionName: (id: string) => string,
): SystemMessage {
  return {
    role: 'system',
    content: '',
    sections: { [sectionName(id)]: text },
    timestamp,
  };
}

function timestampOf(message: TranscriptMessageLike): number {
  const timestamp = (message as { readonly timestamp?: unknown }).timestamp;
  return typeof timestamp === 'number' ? timestamp : 0;
}

/**
 * Replay one journal domain's entire recorded history on the current branch,
 * then append what the current sources say differently.
 *
 * History is never filtered by the current sources: a source that disappears or
 * becomes null appends a fixed-ordinal `sections: null` update instead of
 * dropping earlier emissions. Existing records replay in journal append order,
 * so shared ordinals and source reordering cannot change an old prefix; only new
 * placements follow the current source order. Records from an older native
 * context boundary are not placed at their old ordinals; the last text per
 * source is rebased once into the rebuilt leading boundary and pinned to the
 * current boundary.
 */
export function replayPromptSections<M extends TranscriptMessageLike>(
  messages: readonly M[],
  sources: readonly PromptSectionSource[],
  records: readonly PromptSectionRecord[],
  journal: PromptSectionJournal,
): readonly (M | SystemMessage)[] {
  const histories = new Map<string, PromptSectionRecord[]>();
  for (const record of records) {
    const history = histories.get(record.id);
    if (history === undefined) histories.set(record.id, [record]);
    else history.push(record);
  }

  const active = new Map(sources.map((source) => [source.id, source] as const));
  const recordedOnly = [...histories.keys()].filter((id) => !active.has(id));
  const markers = promptSectionMarkers(messages, [...active.keys(), ...recordedOnly], journal.sectionName);
  const anchored = new Map<number, SystemMessage[]>();
  const head: Record<string, string | null> = {};
  const appendPosition = Math.max(messages.length - 1, 0);
  const replay = new Set<PromptSectionRecord>();
  const pending: PromptSectionSource[] = [];

  const insert = (position: number, id: string, text: string | null): void => {
    if (position >= messages.length) {
      throw new Error(
        `${journal.recordType} record for "${id}" follows native message ${position}, but the request has ` +
        `${messages.length} native messages. The recorded insertion point is absent from this context boundary.`,
      );
    }
    const message = promptSectionMessage(id, text, timestampOf(messages[position]!), journal.sectionName);
    const list = anchored.get(position);
    if (list === undefined) anchored.set(position, [message]);
    else list.push(message);
  };

  /** A changed or removed source becomes a new fixed ordinal after the current last message. */
  const appendUpdate = (source: PromptSectionSource): void => {
    insert(appendPosition, source.id, source.text);
    appendPromptSectionRecord(journal, journal.recordType, {
      version: PROMPT_SECTION_RECORD_VERSION,
      checkpointId: journal.checkpointId,
      id: source.id,
      text: source.text,
      position: appendPosition,
    });
  };

  /** Replay one recorded placement exactly where it was written. */
  const place = (record: PromptSectionRecord): void => {
    if (record.position === 'head') head[journal.sectionName(record.id)] = record.text;
    else insert(record.position, record.id, record.text);
  };

  const decide = (source: PromptSectionSource): void => {
    const section = journal.sectionName(source.id);
    const history = histories.get(source.id) ?? [];
    const current = history.filter((record) => record.checkpointId === journal.checkpointId);
    const marker = markers.get(source.id);

    if (marker !== undefined) {
      // An already inherited marker stays in place and is never re-emitted; a
      // record whose own native position already carries that value is that marker.
      const present = (record: PromptSectionRecord): boolean => record.position !== 'head' &&
        record.position < messages.length &&
        promptSectionText(messages[record.position]!, section) === record.text;
      for (const record of current) {
        if (!present(record)) replay.add(record);
      }
      const latest = current[current.length - 1];
      const baseline = latest !== undefined && !present(latest) ? latest.text : marker.text;
      if (baseline !== source.text) pending.push(source);
      return;
    }

    if (history.length === 0) {
      if (source.text !== null && source.eligible) pending.push(source);
      return;
    }

    if (current.length === 0) {
      // A rebuilt boundary need not carry a section that is now absent. Within
      // one boundary removals still append and preserve every earlier emission.
      const text = source.text === null ? null : history[history.length - 1]!.text;
      head[section] = text;
      appendPromptSectionRecord(journal, journal.recordType, {
        version: PROMPT_SECTION_RECORD_VERSION,
        checkpointId: journal.checkpointId,
        id: source.id,
        text,
        position: 'head',
      });
      if (text !== source.text) pending.push(source);
      return;
    }

    for (const record of current) replay.add(record);
    if (current[current.length - 1]!.text !== source.text) pending.push(source);
  };

  for (const source of sources) decide(source);
  for (const id of recordedOnly) decide({ id, text: null, eligible: false });

  // Existing placements replay in journal append order, so records sharing an
  // ordinal keep their historical order even when the current sources reorder.
  for (const record of records) {
    if (replay.has(record)) place(record);
  }

  // Only new placements follow the current source order of this request.
  for (const source of pending) appendUpdate(source);

  return assemble(messages, head, anchored);
}

function assemble<M extends TranscriptMessageLike>(
  messages: readonly M[],
  head: Readonly<Record<string, string | null>>,
  anchored: ReadonlyMap<number, readonly SystemMessage[]>,
): readonly (M | SystemMessage)[] {
  const output: (M | SystemMessage)[] = [];
  const first = messages[0];
  // An absent section's recorded null state is metadata, not a prompt change.
  const changes = Object.fromEntries(Object.entries(head).filter(([section, text]) =>
    text !== null || (first !== undefined && promptSectionText(first, section) !== undefined)));
  let start = 0;
  if (Object.keys(changes).length > 0) {
    if (first !== undefined && first.role === 'system') {
      output.push({ ...first, sections: { ...(promptSections(first) ?? {}), ...changes } } as unknown as M);
      start = 1;
    } else {
      output.push({ role: 'system', content: '', sections: { ...changes }, timestamp: 0 });
    }
  }
  // A merged leading boundary replaces native ordinal 0, so placements recorded
  // after that message still follow the merged head.
  if (start === 1) {
    for (const message of anchored.get(0) ?? []) output.push(message);
  }
  for (let ordinal = start; ordinal < messages.length; ordinal += 1) {
    output.push(messages[ordinal]!);
    for (const message of anchored.get(ordinal) ?? []) output.push(message);
  }
  return output;
}
