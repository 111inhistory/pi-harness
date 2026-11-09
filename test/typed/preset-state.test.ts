import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendPresetState,
  PRESET_STATE_RECORD,
  PRESET_STATE_VERSION,
  readPresetState,
  restorePresetSnapshot,
  type PresetSnapshot,
  type PresetStateWriter,
} from '../../src/preset/state.ts';

/** A tiny in-memory branch that records appended custom entries. */
function branchWriter(): { branch: unknown[]; writer: PresetStateWriter } {
  const branch: unknown[] = [];
  const writer: PresetStateWriter = {
    appendEntry: (customType, data) => { branch.push({ type: 'custom', customType, data }); },
  };
  return { branch, writer };
}

const snapshot: PresetSnapshot = {
  name: 'fast',
  model: { provider: 'p', id: 'm' },
  thinkingLevel: 'low',
  tools: ['read', 'bash'],
  codemode: { mode: 'only' },
  instructions: 'guide',
};

test('appended snapshot round-trips', () => {
  const { branch, writer } = branchWriter();
  appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot });
  const state = readPresetState(branch);
  assert.ok(state);
  assert.equal(state.version, PRESET_STATE_VERSION);
  assert.deepEqual(state.snapshot, snapshot);
});

test('restore reads the last entry on the branch', () => {
  const { branch, writer } = branchWriter();
  appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot });
  appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot: { ...snapshot, name: 'slow' } });
  assert.equal(restorePresetSnapshot(branch)?.name, 'slow');
});

test('a null snapshot records a clear', () => {
  const { branch, writer } = branchWriter();
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

test('a malformed entry is a hard error, not a silent skip', () => {
  const branch = [{ type: 'custom', customType: PRESET_STATE_RECORD, data: { version: 99, snapshot } }];
  assert.throws(() => readPresetState(branch), /expected version/);
});
