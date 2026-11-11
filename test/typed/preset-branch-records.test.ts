import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRESET_INSTRUCTION_RECORD,
  PRESET_INSTRUCTION_SECTION,
  projectPresetInstruction,
  type PresetInstructionJournal,
} from '../../src/preset/instruction.ts';
import {
  appendPresetBase,
  appendPresetState,
  hasPresetBaseToolRemoval,
  PRESET_STATE_RECORD,
  PRESET_STATE_VERSION,
  readPresetState,
  restorePresetSnapshot,
  type PresetSnapshot,
  type PresetStateWriter,
} from '../../src/preset/state.ts';
import type { TranscriptMessageLike } from '../../src/session-transcript.ts';

/**
 * One in-memory branch for both preset record domains: the resolved snapshot
 * (including its null clear and captured base) and the instruction section
 * placement are append-only custom entries read back from the same branch.
 */
function branchLog(): { branch: unknown[]; writer: PresetStateWriter; journal: PresetInstructionJournal } {
  const branch: unknown[] = [];
  const appendEntry = (customType: string, data: unknown) => { branch.push({ type: 'custom', customType, data }); };
  return { branch, writer: { appendEntry }, journal: { branch, checkpointId: null, appendEntry } };
}

// ---- applied snapshot persistence ----

const snapshot: PresetSnapshot = {
  name: 'fast',
  model: { provider: 'p', id: 'm' },
  thinkingLevel: 'low',
  tools: ['read', 'bash'],
  codemode: { mode: 'only' },
  instructions: 'guide',
};

test('appended snapshot round-trips', () => {
  const { branch, writer } = branchLog();
  appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot });
  const state = readPresetState(branch);
  assert.ok(state);
  assert.equal(state.version, PRESET_STATE_VERSION);
  assert.deepEqual(state.snapshot, snapshot);
});

test('restore reads the last entry on the branch', () => {
  const { branch, writer } = branchLog();
  appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot });
  appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot: { ...snapshot, name: 'slow' } });
  assert.equal(restorePresetSnapshot(branch)?.name, 'slow');
});

test('a null snapshot records a clear', () => {
  const { branch, writer } = branchLog();
  appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot });
  appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot: null });
  const state = readPresetState(branch);
  assert.ok(state);
  assert.equal(state.snapshot, null);
  assert.equal(restorePresetSnapshot(branch), null);
});

test('no entries yields null', () => {
  assert.equal(readPresetState([]), null);
  assert.equal(restorePresetSnapshot(null), null);
});

test('an entry with the wrong customType is ignored', () => {
  const branch = [{ type: 'custom', customType: 'something-else', data: { version: 1, snapshot: null } }];
  assert.equal(readPresetState(branch), null);
});

test('preset baseline removals request pruning only until the next compaction', () => {
  const { branch, writer } = branchLog();
  appendPresetBase(writer, ['read', 'bash']);
  appendPresetState(writer, { version: 1, snapshot: { name: 'added', tools: ['read', 'bash', 'grep'], instructions: null } });
  assert.equal(hasPresetBaseToolRemoval(branch, 'next'), false, 'adding tools does not request pruning');
  appendPresetState(writer, { version: 1, snapshot: { name: 'removed', tools: ['read', 'grep'], instructions: null } });
  assert.equal(hasPresetBaseToolRemoval(branch, 'next'), true, 'the previous preset baseline lost bash');
  appendPresetState(writer, { version: 1, snapshot: null });
  assert.equal(hasPresetBaseToolRemoval(branch, 'next'), true, 'clear does not erase a pending removal');
  branch.push({ type: 'compaction', id: 'checkpoint' });
  assert.equal(hasPresetBaseToolRemoval(branch, 'checkpoint'), true, 'the current checkpoint can perform the requested pruning');
  appendPresetState(writer, { version: 1, snapshot: { name: 'model-only', instructions: null } });
  assert.equal(hasPresetBaseToolRemoval(branch, 'next'), false, 'an earlier compaction consumes the request');
  appendPresetState(writer, { version: 1, snapshot: { name: 'same-tools', tools: ['read', 'grep'], instructions: null } });
  assert.equal(hasPresetBaseToolRemoval(branch, 'next'), false, 'tool-less presets never replaced the live baseline');

  const fresh = branchLog();
  appendPresetBase(fresh.writer, ['read', 'bash']);
  appendPresetState(fresh.writer, { version: 1, snapshot: { name: 'first', tools: ['read'], instructions: null } });
  assert.equal(hasPresetBaseToolRemoval(fresh.branch, 'next'), true, 'the first preset can remove an initial base tool');
  assert.equal(hasPresetBaseToolRemoval(branch.slice(0, 2), 'next'), false, 'a branch before the removal has no request');
});

test('a malformed entry is a hard error, not a silent skip', () => {
  const branch = [{ type: 'custom', customType: PRESET_STATE_RECORD, data: { version: 99, snapshot } }];
  assert.throws(() => readPresetState(branch), /expected version/);
});

// ---- instruction section placement ----

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

function records(branch: unknown[]): { text: string | null }[] {
  return branch
    .filter((entry): entry is { type: string; customType: string; data: { text: string | null } } => {
      const value = entry as { type?: string; customType?: string };
      return value.type === 'custom' && value.customType === PRESET_INSTRUCTION_RECORD;
    })
    .map((entry) => ({ text: entry.data.text }));
}

test('emits the instruction section and records one placement', () => {
  const { branch, journal } = branchLog();
  const out = projectPresetInstruction([{ role: 'user', content: 'hi' }], 'Be terse.', journal);
  assert.equal(findSection(out), 'Be terse.');
  assert.deepEqual(records(branch), [{ text: 'Be terse.' }]);
});

test('re-projecting the same text does not append another record', () => {
  const { branch, journal } = branchLog();
  projectPresetInstruction([{ role: 'user', content: 'hi' }], 'Be terse.', journal);
  const before = records(branch).length;
  projectPresetInstruction([{ role: 'user', content: 'hi' }], 'Be terse.', journal);
  assert.equal(records(branch).length, before);
});

test('a null instruction withdraws the section with a null record', () => {
  const { branch, journal } = branchLog();
  projectPresetInstruction([{ role: 'user', content: 'hi' }], 'Be terse.', journal);
  projectPresetInstruction([{ role: 'user', content: 'hi' }], null, journal);
  const texts = records(branch).map((record) => record.text);
  assert.ok(texts.includes(null));
});

test('no instructions and no history is a no-op', () => {
  const { branch, journal } = branchLog();
  const input: TranscriptMessageLike[] = [{ role: 'user', content: 'hi' }];
  const out = projectPresetInstruction(input, null, journal);
  assert.equal(out.length, input.length);
  assert.equal(records(branch).length, 0);
});
