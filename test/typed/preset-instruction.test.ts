import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRESET_INSTRUCTION_RECORD,
  PRESET_INSTRUCTION_SECTION,
  projectPresetInstruction,
  type PresetInstructionJournal,
} from '../../src/preset/instruction.ts';
import type { TranscriptMessageLike } from '../../src/session-transcript.ts';

interface SectionMessage {
  role?: string;
  content?: unknown;
  sections?: Record<string, string | null>;
}

function findSection(messages: readonly (TranscriptMessageLike | SectionMessage)[]): string | null | undefined {
  let last: string | null | undefined;
  for (const message of messages) {
    const sections = (message as SectionMessage).sections;
    if (sections && PRESET_INSTRUCTION_SECTION in sections) last = sections[PRESET_INSTRUCTION_SECTION];
  }
  return last;
}

function harness(): { branch: unknown[]; journal: PresetInstructionJournal } {
  const branch: unknown[] = [];
  return {
    branch,
    journal: {
      branch,
      checkpointId: null,
      appendEntry: (customType, data) => { branch.push({ type: 'custom', customType, data }); },
    },
  };
}

function records(branch: unknown[]): { text: string | null }[] {
  return branch
    .filter((entry): entry is { type: string; customType: string; data: { text: string | null } } => {
      const value = entry as { type?: string; customType?: string };
      return value.type === 'custom' && value.customType === PRESET_INSTRUCTION_RECORD;
    })
    .map((entry) => ({ text: entry.data.text }));
}

test('emits the instruction section and records one placement', () => {
  const { branch, journal } = harness();
  const out = projectPresetInstruction([{ role: 'user', content: 'hi' }], 'Be terse.', journal);
  assert.equal(findSection(out), 'Be terse.');
  assert.deepEqual(records(branch), [{ text: 'Be terse.' }]);
});

test('re-projecting the same text does not append another record', () => {
  const { branch, journal } = harness();
  projectPresetInstruction([{ role: 'user', content: 'hi' }], 'Be terse.', journal);
  const before = records(branch).length;
  projectPresetInstruction([{ role: 'user', content: 'hi' }], 'Be terse.', journal);
  assert.equal(records(branch).length, before);
});

test('a null instruction withdraws the section with a null record', () => {
  const { branch, journal } = harness();
  projectPresetInstruction([{ role: 'user', content: 'hi' }], 'Be terse.', journal);
  projectPresetInstruction([{ role: 'user', content: 'hi' }], null, journal);
  const texts = records(branch).map((record) => record.text);
  assert.ok(texts.includes(null));
});

test('no instructions and no history is a no-op', () => {
  const { branch, journal } = harness();
  const input: TranscriptMessageLike[] = [{ role: 'user', content: 'hi' }];
  const out = projectPresetInstruction(input, null, journal);
  assert.equal(out.length, input.length);
  assert.equal(records(branch).length, 0);
});
