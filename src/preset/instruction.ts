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
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { restorePresetSnapshot } from './state.ts';

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

/** Install the same branch instruction projection in Main and child sessions. */
export function installPresetInstruction(pi: ExtensionAPI): void {
  pi.on('context_with_system', (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const checkpoint = branch.findLast(entry => entry.type === 'compaction' || entry.type === 'context_edit');
    return { messages: projectPresetInstruction(
      event.messages as readonly TranscriptMessageLike[],
      restorePresetSnapshot(branch)?.instructions ?? null,
      { branch, checkpointId: checkpoint?.id ?? null,
        appendEntry: (type, data) => pi.appendEntry(type, data) },
    ) as typeof event.messages };
  });
}

/**
 * Project the desired instruction section, or withdraw it when null.
 * Journal records preserve placements across requests and branch restoration.
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
