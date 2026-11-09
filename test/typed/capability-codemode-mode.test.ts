/**
 * The preset-owned effective Codemode mode.
 *
 * Pi has no public runtime `codemode.mode` setter, so a preset records the mode
 * on the branch as a `codemode-mode` entry; the Capability Codemode adapter and
 * the lazy-schema projection read the latest entry as the effective mode. These
 * cases pin the record parsing, the Settings fallback and the lazy gate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendCodemodeMode, CODEMODE_MODE_RECORD, effectiveCodemodeMode, readCodemodeModeOverride,
  type CodemodeModeWriter,
} from '../../src/capability/codemode-mode.ts';
import { lazySchemasActive } from '../../src/capability/lazy-schemas.ts';

function branchOf(): { branch: unknown[]; writer: CodemodeModeWriter } {
  const branch: unknown[] = [];
  return { branch, writer: { appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }) } };
}

test('a preset mode record overrides Settings and a later record wins', () => {
  const { branch, writer } = branchOf();
  assert.equal(effectiveCodemodeMode(branch, 'on'), 'on', 'no record falls back to Settings');
  assert.equal(effectiveCodemodeMode(branch, 'only'), 'only');
  appendCodemodeMode(writer, 'only');
  assert.equal(readCodemodeModeOverride(branch), 'only');
  assert.equal(effectiveCodemodeMode(branch, 'on'), 'only', 'the record overrides Settings');
  appendCodemodeMode(writer, 'on');
  assert.equal(effectiveCodemodeMode(branch, 'only'), 'on', 'the latest record wins');
});

test('a cleared preset mode falls back to Settings', () => {
  const { branch, writer } = branchOf();
  appendCodemodeMode(writer, 'only');
  appendCodemodeMode(writer, null);
  assert.equal(readCodemodeModeOverride(branch), null);
  assert.equal(effectiveCodemodeMode(branch, 'on'), 'on');
  assert.equal(effectiveCodemodeMode(branch, 'only'), 'only');
});

test('malformed or foreign entries are ignored', () => {
  const branch: unknown[] = [
    { type: 'custom', customType: CODEMODE_MODE_RECORD, data: { version: 999, mode: 'only' } },
    { type: 'custom', customType: 'preset-state', data: { mode: 'only' } },
    null,
    'x',
  ];
  assert.equal(readCodemodeModeOverride(branch), undefined);
});

test('lazy schemas follow the effective mode from the branch', () => {
  const { branch, writer } = branchOf();
  const host = {
    getActiveTools: () => ['codemode'],
    getSettings: () => ({ codemode: { mode: 'on' } }),
  };
  assert.equal(lazySchemasActive(host, branch), false, 'Settings on is not lazy');
  appendCodemodeMode(writer, 'only');
  assert.equal(lazySchemasActive(host, branch), true, 'a preset only overrides Settings on');
  appendCodemodeMode(writer, null);
  assert.equal(lazySchemasActive(host, branch), false, 'a cleared preset returns to Settings on');
  assert.equal(lazySchemasActive(host, undefined), false, 'no branch means Settings only');
});
