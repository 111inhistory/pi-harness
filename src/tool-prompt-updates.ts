/**
 * Request-side projection of description-only tool-declaration updates.
 *
 * A live tool whose model-facing description changes is re-declared under the
 * same name (Pi's runtime expresses a changed definition as a removal plus an
 * addition; the schema-bearing contract is identical). Such a re-declaration is
 * not an interface change, yet an additions-only transport has to rebase its
 * whole leading prompt/tool prefix to replay it, and a same-name redeclaration
 * is what triggers that fold. This module removes exactly that redundant
 * declaration and publishes the new description as one tool-specific guidance
 * section at the tail instead.
 *
 * The historical first declaration is always kept: it stays the model-visible
 * tool contract for the cached prefix, and the guidance section states the
 * current description. Only declarations whose complete remaining contract is
 * deep-equal (`parameters`, output schema, constrained sampling and any other
 * field) are treated as description-only; every real interface change keeps its
 * declaration so the native SDK replays it and the model never executes against
 * a frozen stale schema. This module never enables execution, removes a tool or
 * grants authority to a name outside the current active scope.
 *
 * The returned guidance entries are ordinary `ToolGuidance` records: Main feeds
 * them into `projectRecordedToolGuidance`, so updated and reverted descriptions
 * are retained by the existing `harness-tool-guidance` journal across repeated
 * requests, appended turns, resume, branch rewind and compaction.
 *
 * Historical sanitation follows that journal: once a description revision was
 * published, its description-only declarations stay stripped from the request
 * even after the tool becomes inactive, so an old same-name re-declaration can
 * never reappear and rebase an additions-only prefix. Withdrawing or sanitizing
 * history never emits new prose and never grants authority: only a currently
 * active tool may publish a description, and a later retained schema-bearing
 * declaration supersedes an older revision section instead of restating a
 * stale description.
 *
 * A tool that only reaches the model through Codemode has no declaration to
 * replace, and its current metadata cannot distinguish a revision from the
 * baseline. For those names the projection records one branch-only baseline the
 * first time it observes them and compares later metadata against it. The
 * baseline entry is never model-visible and carries no schema; when the caller
 * provides no writer, no revision is possible without other evidence and
 * nothing is emitted. Message count and order are always preserved: the
 * guidance and Capability journals place sections at native message ordinals,
 * so an emptied system message keeps its slot (all transports serialize it
 * inertly) rather than shifting another journal domain.
 */
import { isDeepStrictEqual } from 'node:util';

import type { TranscriptMessageLike } from './session-transcript.ts';
import { promptSectionRecords } from './prompt-section-journal.ts';
import { TOOL_GUIDANCE_RECORD, type ToolGuidance } from './tool-guidance.ts';

/** Section id prefix of one tool's description revision. */
const TOOL_DESCRIPTION_GUIDANCE_PREFIX = 'tool-description:';

/** `customType` of the branch-only first-observed description baseline. */
export const TOOL_DESCRIPTION_BASELINE_RECORD = 'harness-tool-description-baseline';

/** The only baseline record version this module reads; there is no legacy schema. */
const TOOL_DESCRIPTION_BASELINE_VERSION = 1;

/** Stable per-tool guidance id; the section name is `harness-guidance:<id>`. */
export function toolDescriptionGuidanceId(name: string): string {
  return `${TOOL_DESCRIPTION_GUIDANCE_PREFIX}${name}`;
}

/** Current registered metadata the projection may fall back to. */
export interface ToolPromptMetadata {
  readonly name: string;
  readonly description?: string | undefined;
}

export interface ToolPromptUpdateInput<M extends TranscriptMessageLike> {
  /** Native transcript before any Capability projection; ordinals stay native. */
  readonly messages: readonly M[];
  /** Current registered tools (`pi.getAllTools()` satisfies this structurally). */
  readonly tools: readonly ToolPromptMetadata[];
  /**
   * Names with current authority: the actual active tools plus enabled indirect
   * Codemode/deferred-callable tools. A name outside it is never stripped and
   * never receives guidance prose, so an excluded or inactive tool cannot gain
   * authority through this projection.
   */
  readonly active: ReadonlySet<string>;
  /** Session branch, read for the baseline and guidance journals. */
  readonly branch?: readonly unknown[] | undefined;
  /** Persists a first-observed baseline; without it no baseline is invented. */
  readonly appendEntry?: ((customType: string, data: unknown) => void) | undefined;
}

export interface ToolPromptUpdate<M extends TranscriptMessageLike> {
  /** The same request messages with redundant description-only declarations removed. */
  readonly messages: readonly M[];
  /** Tail guidance for the current description of each revised tool. */
  readonly guidance: readonly ToolGuidance[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function declaredName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const name = value['name'];
  return typeof name === 'string' && name.length > 0 ? name : null;
}

function declaredDescription(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const description = value['description'];
  return typeof description === 'string' ? description : null;
}

/** Everything the model reads from a declaration except its description. */
function contractWithoutDescription(value: UnknownRecord): UnknownRecord {
  const { description: _description, ...contract } = value;
  return contract;
}

/**
 * Whether a repeated declaration of one name differs from the previous one only
 * in its model-facing description.
 */
function descriptionOnly(previous: unknown, candidate: unknown): boolean {
  if (!isRecord(previous) || !isRecord(candidate)) return false;
  const before = declaredDescription(previous);
  const after = declaredDescription(candidate);
  if (before === null || after === null || before === after) return false;
  return isDeepStrictEqual(contractWithoutDescription(previous), contractWithoutDescription(candidate));
}

/** One tool-specific tail section: a structural label plus the current description. */
function revisionText(name: string, description: string): string {
  return `Updated description for tool ${name}:\n\n${description}`;
}

function malformed(detail: string): never {
  throw new Error(`Malformed ${TOOL_DESCRIPTION_BASELINE_RECORD} entry on the session branch: ${detail}`);
}

/** First-observed descriptions per tool; the last record for a name wins. */
function baselineRecords(branch: readonly unknown[] | undefined): Map<string, string> {
  const baselines = new Map<string, string>();
  for (const entry of branch ?? []) {
    if (!isRecord(entry)) continue;
    if (entry['type'] !== 'custom' || entry['customType'] !== TOOL_DESCRIPTION_BASELINE_RECORD) continue;
    const data = entry['data'];
    if (!isRecord(data)) malformed('expected an object payload');
    if (data['version'] !== TOOL_DESCRIPTION_BASELINE_VERSION) {
      malformed(`expected version ${TOOL_DESCRIPTION_BASELINE_VERSION}, got ${String(data['version'])}`);
    }
    const name = data['name'];
    const description = data['description'];
    if (typeof name !== 'string' || name.length === 0) malformed('name must be a non-empty string');
    if (typeof description !== 'string') malformed('description must be a string');
    baselines.set(name, description);
  }
  return baselines;
}

/**
 * Journal evidence about description revisions: every name that ever received
 * one (including a later withdrawal) and those whose latest record still
 * carries revision text.
 */
interface RevisionEvidence {
  /** Names whose historical description-only declarations are already prose. */
  readonly ever: ReadonlySet<string>;
  /** Names whose latest record still carries revision text. */
  readonly inEffect: ReadonlySet<string>;
}

function revisionEvidence(branch: readonly unknown[] | undefined): RevisionEvidence {
  const latest = new Map<string, string | null>();
  for (const record of promptSectionRecords(branch, TOOL_GUIDANCE_RECORD)) {
    if (!record.id.startsWith(TOOL_DESCRIPTION_GUIDANCE_PREFIX)) continue;
    latest.set(record.id, record.text);
  }
  const ever = new Set<string>();
  const inEffect = new Set<string>();
  for (const [id, text] of latest) {
    const name = id.slice(TOOL_DESCRIPTION_GUIDANCE_PREFIX.length);
    ever.add(name);
    if (text !== null) inEffect.add(name);
  }
  return { ever, inEffect };
}

function revisionGuidance(name: string, description: string): ToolGuidance {
  return {
    id: toolDescriptionGuidanceId(name),
    tools: [name],
    text: revisionText(name, description),
    // Current text cannot be replayed at an old declaration, so the first
    // delivery belongs after the current tail.
    initialPlacement: 'tail',
    eligible: true,
  };
}

/**
 * Project description-only tool re-declarations into tail guidance.
 *
 * The first declaration of every name is preserved verbatim. A later same-name
 * declaration whose full remaining contract equals the previous one is omitted
 * from the request together with its paired `toolsRemoved` entry (Pi records a
 * redefinition as a removal plus an addition of the same name), and its current
 * description becomes one `ToolGuidance` entry. Every other declaration,
 * removal and message is returned unchanged.
 */
export function projectToolPromptUpdates<M extends TranscriptMessageLike>(
  input: ToolPromptUpdateInput<M>,
): ToolPromptUpdate<M> {
  const metadata = new Map<string, string>();
  for (const tool of input.tools) {
    if (tool.name.length === 0 || tool.description === undefined) continue;
    if (tool.description.trim().length === 0 || metadata.has(tool.name)) continue;
    metadata.set(tool.name, tool.description);
  }

  // Read the journals before walking: a description revision that was already
  // published keeps its historical declarations sanitized even after the tool
  // becomes inactive, so an old same-name re-declaration can never reappear and
  // rebase an additions-only prefix.
  const revisions = revisionEvidence(input.branch);
  const baselines = baselineRecords(input.branch);

  /** Latest effective declaration per name, including stripped revisions. */
  const live = new Map<string, unknown>();
  /** Description of each name's first (model-visible) declaration. */
  const baseline = new Map<string, string>();
  /** Whether a name's latest effective declaration was stripped or retained. */
  const retained = new Set<string>();
  /** Current description per revised tool, in first-revision order. */
  const revised = new Map<string, string>();
  const messages: M[] = [];

  for (const message of input.messages) {
    const added = message.role === 'system' ? message.toolsAdded ?? [] : [];
    const removed = message.role === 'system' ? message.toolsRemoved ?? [] : [];
    if (added.length === 0 && removed.length === 0) {
      messages.push(message);
      continue;
    }

    const retainedAdded: unknown[] = [];
    const retainedRemoved: unknown[] = [];
    const declared = new Set<string>();
    const stripped = new Set<string>();
    for (const entry of added) {
      const name = declaredName(entry);
      const previous = name === null ? undefined : live.get(name);
      if (name !== null && previous !== undefined) {
        // The first declaration is the historical anchor the model already
        // reads; a later description-only copy must not replace it.
        const first = declaredDescription(previous);
        if (!baseline.has(name) && first !== null) baseline.set(name, first);
        const active = input.active.has(name);
        if ((active || revisions.ever.has(name)) && descriptionOnly(previous, entry)) {
          // The runtime's current declaration still wins for the next
          // comparison, so a long description chain stays description-only.
          live.set(name, entry);
          retained.delete(name);
          stripped.add(name);
          const description = declaredDescription(entry);
          // Sanitizing recorded history grants no authority: only a currently
          // active tool may publish description prose.
          if (active && description !== null) revised.set(name, description);
          continue;
        }
      }
      if (name !== null) {
        live.set(name, entry);
        retained.add(name);
        declared.add(name);
      }
      retainedAdded.push(entry);
    }

    for (const reference of removed) {
      const name = declaredName(reference);
      // A same-name redefinition is recorded as removal plus addition; this
      // addition was replaced by prose, so its paired removal goes with it.
      if (name !== null && stripped.has(name)) continue;
      retainedRemoved.push(reference);
      // A retained replacement above already installed the new declaration.
      if (name !== null && !declared.has(name)) live.delete(name);
    }

    if (retainedAdded.length === added.length && retainedRemoved.length === removed.length) {
      messages.push(message);
      continue;
    }
    const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
    messages.push({
      ...rest,
      ...(retainedAdded.length === 0 ? {} : { toolsAdded: retainedAdded }),
      ...(retainedRemoved.length === 0 ? {} : { toolsRemoved: retainedRemoved }),
    } as unknown as M);
  }

  // A tool that never declared its interface to the model has no native
  // baseline, so record what this projection first observed. Only a real
  // description can be a baseline, and an existing record is never rewritten.
  if (input.appendEntry !== undefined) {
    for (const name of input.active) {
      if (live.has(name) || baselines.has(name)) continue;
      const description = metadata.get(name);
      if (description === undefined) continue;
      input.appendEntry(TOOL_DESCRIPTION_BASELINE_RECORD, {
        version: TOOL_DESCRIPTION_BASELINE_VERSION,
        name,
        description,
      });
    }
  }

  // A revision in effect stays supplied so the journal can replay it across
  // resume, appended turns and compaction. It is never resurrected for a name
  // outside the active scope, and metadata alone never duplicates prose.
  for (const name of revisions.inEffect) {
    if (!input.active.has(name)) continue;
    const current = live.get(name);
    // A declared tool's own text is authoritative; registered metadata is only
    // a baseline source for an indirect tool that never declared an interface.
    const description = current === undefined
      ? (baselines.has(name) ? metadata.get(name) : undefined)
      : declaredDescription(current) ?? undefined;
    if (description === undefined || description.trim().length === 0) continue;
    revised.set(name, description);
  }

  // A later retained (schema-bearing) declaration states the current
  // description to the model itself, so prose for an older revision would be
  // stale. Withdrawing it appends the native section removal instead.
  for (const name of [...revised.keys()]) {
    if (retained.has(name)) revised.delete(name);
  }

  // An indirect tool compares current metadata against its first observation;
  // a returned value is a revision from what the model was told before.
  for (const [name, observed] of baselines) {
    if (revised.has(name) || !input.active.has(name) || live.has(name)) continue;
    const description = metadata.get(name);
    if (description === undefined || description === observed) continue;
    revised.set(name, description);
  }

  // A net no-op chain (A -> B -> A inside one transcript) has nothing to tell a
  // model that still reads A. Once a revision was emitted, the journal decides
  // between replay and update, so it is kept in that case.
  for (const [name, description] of [...revised]) {
    if (!revisions.inEffect.has(name) && baseline.get(name) === description) revised.delete(name);
  }

  return {
    messages,
    guidance: [...revised].map(([name, description]) => revisionGuidance(name, description)),
  };
}
