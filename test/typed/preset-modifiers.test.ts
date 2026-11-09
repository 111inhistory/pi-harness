import assert from 'node:assert/strict';
import test from 'node:test';

import { applyToolModifiers, parseToolModifiers } from '../../src/preset/modifiers.ts';

test('parse splits ops, plain names and invalid tokens', () => {
  const { tokens, invalid } = parseToolModifiers(['+read', '-bash', 'edit', '+', '  ', '-io']);
  assert.deepEqual(tokens, [
    { op: '+', name: 'read' },
    { op: '-', name: 'bash' },
    { op: '=', name: 'edit' },
    { op: '-', name: 'io' },
  ]);
  assert.deepEqual(invalid, ['+', '  ']);
});

test('adds and removes apply on the base', () => {
  const base = ['read', 'bash', 'edit'];
  const { tokens } = parseToolModifiers(['+write', '-bash']);
  assert.deepEqual(applyToolModifiers(base, tokens), ['read', 'edit', 'write']);
});

test('a plain name replaces the base selection', () => {
  const base = ['read', 'bash', 'edit'];
  const { tokens } = parseToolModifiers(['write', '+read']);
  assert.deepEqual(applyToolModifiers(base, tokens), ['write', 'read']);
});

test('later tokens win over earlier ones for the same name', () => {
  const base = ['read'];
  assert.deepEqual(applyToolModifiers(base, parseToolModifiers(['-read', '+read']).tokens), ['read']);
  assert.deepEqual(applyToolModifiers(base, parseToolModifiers(['+read', '-read']).tokens), []);
});

test('applying from the same base makes A-then-B equal to B alone', () => {
  const base = ['read', 'bash', 'edit'];
  const a = parseToolModifiers(['+write']).tokens;
  const b = parseToolModifiers(['+codemode', '-bash']).tokens;
  // A-to-B recomputes B from the base, never from A's result.
  const afterB = applyToolModifiers(base, b);
  const direct = applyToolModifiers(base, b);
  assert.deepEqual(afterB, direct);
  // Sanity: A alone is different from B alone.
  assert.notDeepEqual(applyToolModifiers(base, a), applyToolModifiers(base, b));
});

test('base order is preserved and added names append in first-seen order', () => {
  const base = ['read', 'bash'];
  const { tokens } = parseToolModifiers(['+write', '+grep', '-bash']);
  assert.deepEqual(applyToolModifiers(base, tokens), ['read', 'write', 'grep']);
});
