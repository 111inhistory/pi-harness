import assert from 'node:assert/strict';
import test from 'node:test';

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

/** Business snapshots remain append-only; request instructions have no journal. */
function branchLog(): { branch: unknown[]; writer: PresetStateWriter } {
  const branch: unknown[] = [];
  const appendEntry = (customType: string, data: unknown) => { branch.push({ type: 'custom', customType, data }); };
  return { branch, writer: { appendEntry } };
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
