import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePresetCommand } from '../../src/preset/command.ts';

test('bare command opens the selector', () => {
  assert.deepEqual(parsePresetCommand(''), { kind: 'show' });
  assert.deepEqual(parsePresetCommand('   '), { kind: 'show' });
});

test('clear words clear the preset', () => {
  for (const word of ['clear', 'CLEAR', '(none)', 'none', 'off']) {
    assert.deepEqual(parsePresetCommand(word), { kind: 'clear' });
  }
});

test('a name applies that preset', () => {
  assert.deepEqual(parsePresetCommand('fast'), { kind: 'apply', name: 'fast' });
  assert.deepEqual(parsePresetCommand('  fast  '), { kind: 'apply', name: 'fast' });
});
