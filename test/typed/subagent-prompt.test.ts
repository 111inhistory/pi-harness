import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childContext, childPromptBlocks, composeAssignment, continuationControlPrompt, formatPeerMessage } from '../../src/subagent/prompt.ts';
import { DEFAULT_HARNESS_CONFIG } from '../../src/harness-config.ts';
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

test('child prompt blocks keep host identity before common and inherited guidance', () => {
  const host = 'CHILD_IDENTITY_AND_PARENT_ENDPOINT';
  const role = 'ROUTED_ROLE_INSTRUCTIONS';
  const common = '\n COMMON_WORK_GUIDANCE $& \n';
  const inheritedPrompt = '\n INHERITED_BACKGROUND_ORIENTATION $& \n';
  // The default common section is empty, so Fresh keeps [role, host].
  assert.deepEqual(childPromptBlocks({
    roleInstructions: role, context: host, common: '', inherited: false, inheritedPrompt,
  }), [role, host]);
  // Inherited keeps its existing [host, inherited] tail when common is empty.
  assert.deepEqual(childPromptBlocks({
    roleInstructions: null, context: host, common: '', inherited: true, inheritedPrompt,
  }), [host, inheritedPrompt]);
  // Common is its own block between host identity and inherited guidance.
  assert.deepEqual(childPromptBlocks({
    roleInstructions: null, context: host, common, inherited: true, inheritedPrompt,
  }), [host, common, inheritedPrompt]);
  assert.deepEqual(childPromptBlocks({
    roleInstructions: role, context: host, common, inherited: false, inheritedPrompt,
  }), [role, host, common]);
  for (const blank of ['', ' \n\t']) {
    assert.deepEqual(childPromptBlocks({
      roleInstructions: null, context: host, common: blank, inherited: true, inheritedPrompt: blank,
    }), [host]);
  }
});

test('the default prompt sections stay one common empty and one inherited asset', () => {
  const prompts = DEFAULT_HARNESS_CONFIG.subagent.prompts;
  assert.equal(prompts.common, '');
  assert.equal(prompts.inherited, promptString('subagent-turns.json', 'inheritedContext'));
  assert.ok(prompts.inherited.trim() !== '');
});

test('missing prompt assets or invalid string fields fail instead of selecting fallback prose', () => {
  assert.throws(() => promptString('not-an-installed-prompt.json', 'text'), { code: 'ENOENT' });
  assert.throws(() => promptString('subagent-tools.json', 'missing'), {
    name: 'TypeError',
  });
  assert.throws(() => promptString('subagent-tools.json', 'parameters'), {
    name: 'TypeError',
  });
});
