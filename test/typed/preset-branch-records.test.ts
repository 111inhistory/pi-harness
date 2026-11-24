import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendPresetState,
  hasPresetBaseToolRemoval,
  presetBaselineAdditions,
  PRESET_STATE_RECORD,
  PRESET_STATE_VERSION,
  readPresetState,
  restorePresetSnapshot,
  buildPresetSnapshot,
  type PresetSnapshot,
  type PresetStateWriter,
} from '../../src/preset/state.ts';

/** Business snapshots remain append-only; request instructions have no journal. */
function branchLog(): { branch: unknown[]; writer: PresetStateWriter } {
  const branch: unknown[] = [];
  const appendEntry = (customType: string, data: unknown) => { branch.push({ type: 'custom', customType, data, id: `e${branch.length}` }); };
  return { branch, writer: { appendEntry } };
}

// ---- applied snapshot persistence ----

const snapshot: PresetSnapshot = buildPresetSnapshot({
  name: 'fast',
  model: { provider: 'p', id: 'm' },
  thinkingLevel: 'low',
  tools: ['read', 'bash'],
  disabledTools: [],
  codemode: { mode: 'only' },
  instructions: 'guide',
  toolSelection: { kind: 'replace', names: ['read', 'bash'] },
});

test('appended snapshot round-trips', () => {
  const { branch, writer } = branchLog();
  appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot });
  const state = readPresetState(branch);
  assert.ok(state);
  assert.equal(state.version, PRESET_STATE_VERSION);
  assert.deepEqual(state.snapshot, snapshot);
});

test('a snapshot whose hash does not match its contents is rejected', () => {
  const { branch, writer } = branchLog();
  appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot: { ...snapshot, instructions: 'edited' } });
  assert.throws(() => readPresetState(branch), /does not match its contents/);
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

test('a permanent baseline increment survives a clear and is never duplicated', () => {
  const { branch, writer } = branchLog();
  appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot, baselineAdditions: ['job_stop'] });
  appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot: null });
  appendPresetState(writer, {
    version: PRESET_STATE_VERSION,
    snapshot: { ...snapshot, name: 'later' },
    baselineAdditions: ['job_stop', 'job_send'],
  });
  assert.deepEqual(presetBaselineAdditions(branch), ['job_stop', 'job_send']);
  assert.equal(restorePresetSnapshot(branch)?.name, 'later');
});

test('preset base removals request pruning only until the next compaction', () => {
  // The session baseline is owned by the tool-access domain and passed in.
  const baseline = ['read', 'bash'];
  const { branch, writer } = branchLog();
  const log = (name: string, tools: readonly string[], additions: readonly string[] = []) => {
    appendPresetState(writer, {
      version: PRESET_STATE_VERSION,
      snapshot: buildPresetSnapshot({ name, tools, instructions: null, toolSelection: { kind: 'replace', names: [...tools] } }),
      ...(additions.length === 0 ? {} : { baselineAdditions: additions }),
    });
  };
  log('added', ['read', 'bash', 'grep']);
  assert.equal(hasPresetBaseToolRemoval(branch, 'next', baseline), false, 'adding tools does not request pruning');
  log('removed', ['read', 'grep']);
  assert.equal(hasPresetBaseToolRemoval(branch, 'next', baseline), true, 'the previous preset base selection lost bash');
  appendPresetState(writer, { version: PRESET_STATE_VERSION, snapshot: null });
  assert.equal(hasPresetBaseToolRemoval(branch, 'next', baseline), true, 'clear does not erase a pending removal');
  branch.push({ type: 'compaction', id: 'checkpoint' });
  assert.equal(hasPresetBaseToolRemoval(branch, 'checkpoint', baseline), true, 'the current checkpoint can perform the requested pruning');
  appendPresetState(writer, {
    version: PRESET_STATE_VERSION,
    snapshot: buildPresetSnapshot({ name: 'model-only', instructions: null }),
  });
  assert.equal(hasPresetBaseToolRemoval(branch, 'next', baseline), false, 'an earlier compaction consumes the request');
  log('same-tools', ['read', 'grep']);
  assert.equal(hasPresetBaseToolRemoval(branch, 'next', baseline), false, 'tool-less presets never replaced the preset base');

  const fresh = branchLog();
  appendPresetState(fresh.writer, {
    version: PRESET_STATE_VERSION,
    snapshot: buildPresetSnapshot({ name: 'first', tools: ['read'], instructions: null, toolSelection: { kind: 'replace', names: ['read'] } }),
  });
  assert.equal(hasPresetBaseToolRemoval(fresh.branch, 'next', baseline), true, 'the first preset can remove an initial base tool');
  assert.equal(hasPresetBaseToolRemoval(branch.slice(0, 1), 'next', baseline), false, 'a branch before the removal has no request');
});

test('a permanent increment joins the baseline for the compaction comparison', () => {
  const baseline = ['read', 'bash'];
  const { branch, writer } = branchLog();
  // The increment is baseline membership, so a selection that omits it is a
  // removal exactly like omitting a recorded baseline tool.
  appendPresetState(writer, {
    version: PRESET_STATE_VERSION,
    snapshot: buildPresetSnapshot({
      name: 'with-default', tools: ['read', 'bash', 'job_stop'], instructions: null,
      toolSelection: { kind: 'modifiers', add: ['job_stop'], remove: [] },
    }),
    baselineAdditions: ['job_stop'],
  });
  assert.equal(hasPresetBaseToolRemoval(branch, 'next', baseline), false);
  appendPresetState(writer, {
    version: PRESET_STATE_VERSION,
    snapshot: buildPresetSnapshot({
      name: 'without-default', tools: ['read'], instructions: null,
      toolSelection: { kind: 'replace', names: ['read'] },
    }),
  });
  assert.equal(hasPresetBaseToolRemoval(branch, 'next', baseline), true);
});

test('a malformed entry is a hard error, not a silent skip', () => {
  const branch = [{ type: 'custom', customType: PRESET_STATE_RECORD, data: { version: 99, snapshot } }];
  assert.throws(() => readPresetState(branch), /expected version 2/);
});

test('v1 records are rejected: there is no runtime fallback', () => {
  const v1 = {
    type: 'custom',
    customType: PRESET_STATE_RECORD,
    data: { version: 1, snapshot: { name: 'legacy', tools: ['read'], instructions: null } },
  };
  assert.throws(() => readPresetState([v1]), /expected version 2/);
  assert.throws(() => presetBaselineAdditions([v1]), /expected version 2/);
});
