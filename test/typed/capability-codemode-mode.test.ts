/**
 * The effective Codemode mode: the preset declaration and the manual override.
 *
 * Pi has no public runtime `codemode.mode` setter, so the harness records the
 * mode on the branch: a preset's mode lives inside the authoritative
 * `preset-state` v2 snapshot, and a manual toggle uses its own `codemode-mode`
 * entry. The later declaration wins. These cases pin the shared order, the
 * Settings fallback, the clear/withdraw rules and the lazy gate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendCodemodeMode, CODEMODE_MODE_RECORD, effectiveCodemodeMode,
  readCodemodeModeOverride, type CodemodeModeWriter,
} from '../../src/capability/codemode-mode.ts';
import { lazySchemasActive } from '../../src/capability/lazy-schemas.ts';
import { buildPresetSnapshot, PRESET_STATE_RECORD, type PresetSnapshotInput } from '../../src/preset/state.ts';

interface BranchRecorder {
  readonly branch: unknown[];
  readonly writer: CodemodeModeWriter;
}

function branchOf(): BranchRecorder {
  const branch: unknown[] = [];
  return { branch, writer: { appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }) } };
}

function appendPreset(branch: unknown[], snapshot: PresetSnapshotInput | null): void {
  branch.push({
    type: 'custom',
    customType: PRESET_STATE_RECORD,
    data: { version: 2, snapshot: snapshot === null ? null : buildPresetSnapshot(snapshot) },
  });
}

test('a manual mode record overrides Settings and a later record wins', () => {
  const { branch, writer } = branchOf();
  assert.equal(effectiveCodemodeMode(branch, 'on'), 'on', 'no record falls back to Settings');
  assert.equal(effectiveCodemodeMode(branch, 'only'), 'only');
  appendCodemodeMode(writer, 'only');
  assert.equal(readCodemodeModeOverride(branch), 'only');
  assert.equal(effectiveCodemodeMode(branch, 'on'), 'only', 'the record overrides Settings');
  appendCodemodeMode(writer, 'on');
  assert.equal(effectiveCodemodeMode(branch, 'only'), 'on', 'the latest record wins');
});

test('a cleared manual mode falls back to Settings', () => {
  const { branch, writer } = branchOf();
  appendCodemodeMode(writer, 'only');
  appendCodemodeMode(writer, null);
  assert.equal(readCodemodeModeOverride(branch), null);
  assert.equal(effectiveCodemodeMode(branch, 'on'), 'on');
  assert.equal(effectiveCodemodeMode(branch, 'only'), 'only');
});

test('a preset mode lives in its snapshot and shares branch order with the manual record', () => {
  const { branch, writer } = branchOf();
  appendPreset(branch, { name: 'p', instructions: null, codemode: { mode: 'only' } });
  assert.equal(effectiveCodemodeMode(branch, 'on'), 'only', 'the preset declaration overrides Settings');

  appendCodemodeMode(writer, 'on');
  assert.equal(effectiveCodemodeMode(branch, 'only'), 'on', 'a later manual record wins');

  appendPreset(branch, { name: 'q', instructions: null, codemode: { mode: 'only' } });
  assert.equal(effectiveCodemodeMode(branch, 'on'), 'only', 'a later preset switch wins again');

  // A preset that declares no mode is sparse: it does not clobber the manual one.
  appendPreset(branch, { name: 'r', instructions: null });
  assert.equal(effectiveCodemodeMode(branch, 'on'), 'on');
});

test('clearing the preset withdraws only its own mode declaration', () => {
  const { branch, writer } = branchOf();
  appendCodemodeMode(writer, 'on');
  appendPreset(branch, { name: 'p', instructions: null, codemode: { mode: 'only' } });
  assert.equal(effectiveCodemodeMode(branch, 'on'), 'only');

  appendPreset(branch, null);
  assert.equal(effectiveCodemodeMode(branch, 'on'), 'on', 'the earlier manual mode is in force again');

  // A clear without any manual record returns to Settings.
  const { branch: plain } = branchOf();
  appendPreset(plain, { name: 'p', instructions: null, codemode: { mode: 'only' } });
  appendPreset(plain, null);
  assert.equal(effectiveCodemodeMode(plain, 'only'), 'only');
  assert.equal(effectiveCodemodeMode(plain, 'on'), 'on');
});

test('foreign or malformed entries are ignored; a malformed preset-state throws', () => {
  const branch: unknown[] = [
    { type: 'custom', customType: CODEMODE_MODE_RECORD, data: { version: 999, mode: 'only' } },
    { type: 'custom', customType: 'other-record', data: { mode: 'only' } },
    null,
    'x',
  ];
  assert.equal(readCodemodeModeOverride(branch), undefined);
  assert.equal(effectiveCodemodeMode(branch, 'only'), 'only');
  // `preset-state` is the authoritative record: an unconverted v1 entry fails
  // loudly instead of silently restoring Settings.
  assert.throws(
    () => effectiveCodemodeMode([{ type: 'custom', customType: PRESET_STATE_RECORD, data: { version: 1, snapshot: null } }], 'on'),
    /preset-state/,
  );
});

test('lazy schemas follow the effective mode from the branch', () => {
  const { branch, writer } = branchOf();
  const host = {
    getActiveTools: () => ['codemode'],
    getSettings: () => ({ codemode: { mode: 'on' } }),
  };
  assert.equal(lazySchemasActive(host, branch), false, 'Settings on is not lazy');
  appendPreset(branch, { name: 'p', instructions: null, codemode: { mode: 'only' } });
  assert.equal(lazySchemasActive(host, branch), true, 'a preset only overrides Settings on');
  appendCodemodeMode(writer, 'on');
  assert.equal(lazySchemasActive(host, branch), false, 'a later manual on wins');
  appendPreset(branch, null);
  assert.equal(lazySchemasActive(host, branch), false, 'clear falls back to the manual record');
  assert.equal(lazySchemasActive(host, undefined), false, 'no branch means Settings only');
});
