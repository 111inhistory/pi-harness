/**
 * The model-specific instruction section of an active preset.
 *
 * Preset instructions are not appended as raw text onto the whole system prompt
 * (the reference plugin's approach). They are emitted as one structured system
 * section through the same append-only prompt-section journal the harness uses
 * for tool guidance and Capability memory. That buys three properties the harness
 * requires: an incremental change appends one new placement instead of rewriting
 * the prefix, a removal emits the native `sections: null` primitive, and resume,
 * tree navigation, fork and reload replay the exact placements recorded on the
 * branch.
 *
 * This module is section-agnostic glue: it names the journal domain and hands the
 * current instruction text to the journal engine. All placement, rebasing and
 * durability logic lives in `prompt-section-journal.ts`.
 */

import type { SystemMessage } from '@earendil-works/pi-ai';

import type { TranscriptMessageLike } from '../session-transcript.ts';
import {
  promptSectionRecords,
  replayPromptSections,
  type PromptSectionJournal,
} from '../prompt-section-journal.ts';

/** System-section name for the preset's instruction text. */
export const PRESET_INSTRUCTION_SECTION = 'preset-instructions';
/** `customType` of the preset instruction journal domain. */
export const PRESET_INSTRUCTION_RECORD = 'harness-preset-instruction';

/** Branch access plus the append action the journal domain needs. */
export interface PresetInstructionJournal {
  readonly branch: readonly unknown[];
  readonly checkpointId: string | null;
  appendEntry(customType: string, data: unknown): void;
}

/**
 * Project the current instruction text onto the request.
 *
 * `instructions` is the desired section body, or null to withdraw it (a clear).
 * The returned messages replace the input transcript for this request; journal
 * records are appended as needed through `journal.appendEntry`.
 */
export function projectPresetInstruction<M extends TranscriptMessageLike>(
  messages: readonly M[],
  instructions: string | null,
  journal: PresetInstructionJournal,
): readonly (M | SystemMessage)[] {
  const view: PromptSectionJournal = {
    checkpointId: journal.checkpointId,
    recordType: PRESET_INSTRUCTION_RECORD,
    appendEntry: journal.appendEntry,
    sectionName: () => PRESET_INSTRUCTION_SECTION,
  };
  const records = promptSectionRecords(journal.branch, PRESET_INSTRUCTION_RECORD);
  return replayPromptSections(
    messages,
    [{ id: PRESET_INSTRUCTION_SECTION, text: instructions, eligible: true }],
    records,
    view,
  );
}
