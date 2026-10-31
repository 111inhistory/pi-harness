import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childContext, childPromptBlocks, composeAssignment, continuationControlPrompt, formatPeerMessage } from '../../src/subagent/prompt.ts';
import { promptString } from '../../src/prompt-text.ts';

test('routing and execution preserve assignment context bytes', () => {
  assert.equal(composeAssignment('TASK', ' \n\t'), 'TASK');
  const composed = composeAssignment('TASK', '  context\n');
  assert.ok(composed.includes('  context\n'), 'context whitespace reaches routing and execution unchanged');
  assert.ok(composed.endsWith('TASK'));
  assert.ok(composed.indexOf('  context\n') < composed.lastIndexOf('TASK'));
});

test('peer attribution retains literal text without composing a batch prompt', () => {
  const formatted = formatPeerMessage({ from: 'sub_01', content: 'hello\nworld' });
  assert.ok(formatted.includes('sub_01'));
  assert.ok(formatted.endsWith('\nhello\nworld'));
});

test('continuation control refers to independent entries above it and only restates an unrecorded assignment', () => {
  const control = promptString('subagent-turns.json', 'control');
  assert.equal(continuationControlPrompt(null), control);
  const assignment = 'UNRECORDED_ASSIGNMENT_PAYLOAD\n  $&\t';
  const resumed = continuationControlPrompt(assignment);
  assert.ok(resumed.includes(assignment));
  assert.ok(resumed.endsWith(control));
  assert.ok(resumed.indexOf(assignment) < resumed.length - control.length);
});

test('child identity/path substitutions insert dollar syntax literally', () => {
  const endpoint = '/tmp/$&/$`/$\'/Main.sock';
  const result = childContext('sub_01', 'Main', endpoint);
  assert.ok(result.includes('sub_01'));
  assert.ok(result.includes('Main'));
  assert.ok(result.includes(endpoint), 'replacement-pattern syntax is inserted literally');
  assert.doesNotMatch(result, /\{agentId\}|\{parentId\}|\{parentSocket\}/);
});

test('child prompt blocks select orientation without rewriting their text', () => {
  const common = 'CHILD_IDENTITY_AND_PARENT_ENDPOINT';
  const role = 'ROUTED_ROLE_INSTRUCTIONS';
  const inheritedContext = '\n INHERITED_BACKGROUND_ORIENTATION $& \n';
  assert.deepEqual(childPromptBlocks({
    context: common, roleInstructions: role, inherited: false, inheritedContext,
  }), [role, common]);
  assert.deepEqual(childPromptBlocks({
    context: common, roleInstructions: null, inherited: true, inheritedContext,
  }), [common, inheritedContext]);
  for (const blank of ['', ' \n\t']) {
    assert.deepEqual(childPromptBlocks({
      context: common, roleInstructions: null, inherited: true, inheritedContext: blank,
    }), [common]);
  }
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
