import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childContext, childPromptBlocks, composeAssignment } from '../../src/subagent/prompt.ts';

test('routing and execution preserve assignment context bytes', () => {
  assert.equal(composeAssignment('TASK', ' \n\t'), 'TASK');
  const composed = composeAssignment('TASK', '  context\n');
  assert.ok(composed.includes('  context\n'), 'context whitespace reaches routing and execution unchanged');
  assert.ok(composed.endsWith('TASK'));
  assert.ok(composed.indexOf('  context\n') < composed.lastIndexOf('TASK'));
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
