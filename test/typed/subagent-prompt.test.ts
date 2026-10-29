import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childContext, composeAssignment, continuationControlPrompt, formatPeerMessage } from '../../src/subagent/prompt.ts';
import { promptString } from '../../src/prompt-text.mjs';

test('routing and execution preserve assignment context bytes', () => {
  assert.equal(composeAssignment('TASK', ' \n\t'), 'TASK');
  assert.equal(composeAssignment('TASK', '  context\n'), '# Batch context\n\n  context\n\n\n# Task\n\nTASK');
});

test('peer attribution retains literal text without composing a batch prompt', () => {
  assert.equal(formatPeerMessage({ from: 'sub_01', content: 'hello\nworld' }), '[Message from sub_01]\nhello\nworld');
});

test('continuation control refers to independent entries above it and only restates an unrecorded assignment', () => {
  const control = 'The messages above were just added to this conversation; continue with the original task now.';
  assert.equal(continuationControlPrompt(null), control);
  assert.equal(continuationControlPrompt('original task'), '# Original assignment\n\nThis agent\'s first Job was stopped before its conversation recorded anything, so its assignment is restated here.\n\noriginal task\n\n' + control);
});

test('child identity/path substitutions insert dollar syntax literally', () => {
  assert.equal(childContext('sub_01', 'Main', '/tmp/$&/$`/$\'/Main.sock'), 'You are Subagent sub_01. Your direct parent is Main. To message that parent, use your enabled write or msg_write with parentSocket /tmp/$&/$`/$\'/Main.sock and plain text content; omit from and to. The host frames the transport and binds your sender identity. Your execution round also ends with an automatic host notification; do not send a separate completion message unless you have content the parent needs.');
});

test('missing prompt assets or invalid string fields fail instead of selecting fallback prose', () => {
  assert.throws(() => promptString('not-an-installed-prompt.json', 'text'), { code: 'ENOENT' });
  assert.throws(() => promptString('subagent-tools.json', 'missing'), {
    name: 'TypeError', message: 'subagent-tools.json must define string missing.',
  });
  assert.throws(() => promptString('subagent-tools.json', 'parameters'), {
    name: 'TypeError', message: 'subagent-tools.json must define string parameters.',
  });
});
