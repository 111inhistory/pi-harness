import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  batchContextText,
  childContext,
  childPromptBlocks,
  composeAssignment,
  interruptionNotice,
  msgWriteReminder,
} from '../../src/subagent/prompt.ts';

const turns = JSON.parse(readFileSync(new URL('../../prompts/subagent-turns.json', import.meta.url), 'utf8'));

test('routing and execution preserve assignment context bytes', () => {
  assert.equal(composeAssignment('GOAL', ' \n\t'), 'GOAL');
  const composed = composeAssignment('GOAL', '  context\n');
  assert.ok(composed.includes('  context\n'), 'context whitespace reaches routing and execution unchanged');
  assert.ok(composed.endsWith('GOAL'));
  assert.ok(composed.indexOf('  context\n') < composed.lastIndexOf('GOAL'));
});

test('the batch roster renders the shared context once and cooperates only with peers', () => {
  const context = '  shared context $& \n';
  const roster = [
    { name: 'parser', address: '01a1deac:sub_3-a', goal: 'Fix the parser' },
    { name: null, address: '01a1deac:sub_3-b', goal: ' Review it ' },
  ];
  const multi = batchContextText({ context, roster });
  assert.ok(multi.startsWith(`  shared context $& \n`), 'shared context is inserted literally');
  assert.ok(multi.includes(`${turns.roster}\n- parser (01a1deac:sub_3-a): Fix the parser`));
  assert.ok(multi.includes(`- ${turns.unnamedMember} (01a1deac:sub_3-b): Review it`),
    'an undeclared label is named as the roster placeholder without inventing an identity');
  assert.ok(multi.endsWith(turns.collaborate), 'peers get the positive cooperation line');
  assert.ok(!multi.includes('{"'), 'no protocol envelope leaks into the prompt');

  const single = [roster[0]!];
  assert.equal(batchContextText({ context: '  only context\n', roster: single }), '  only context\n',
    'a singleton receives the shared context and no one-member roster');
  assert.equal(batchContextText({ context: '', roster: single }), '',
    'a singleton without shared context adds no batch block at all');
});

test('child identity/address substitutions insert dollar syntax literally', () => {
  const address = '/tmp/$&/$`/$\'/:sub_1';
  const result = childContext(address, '01a1deac:main');
  assert.ok(result.includes(address), 'replacement-pattern syntax is inserted literally');
  assert.ok(result.includes('01a1deac:main'));
  assert.ok(result.includes('msg_write'));
  assert.doesNotMatch(result, /\{agentAddress\}|\{creatorAddress\}/);
  assert.doesNotMatch(result, /host delivers|final response|Do not send a separate completion/i,
    'final assistant output is no longer described as an automatic result');
});

test('the interruption notice names the sender literally and states what continues', () => {
  const from = "/tmp/$&/$`/:sub_1";
  const text = interruptionNotice(from);
  assert.equal(text, turns.interruptionNotice.replace('{from}', () => from));
  assert.ok(text.includes(from), 'a full sender address is inserted literally');
  assert.doesNotMatch(text, /\{from\}|tool-only|implementation/i);
  assert.match(text, /not retried automatically/);
});

test('the msg_write reminder is the asset text and never forces a send', () => {
  assert.equal(msgWriteReminder, turns.msgWriteReminder);
  assert.ok(msgWriteReminder.includes('msg_write'));
  assert.ok(msgWriteReminder.includes('otherwise finish'));
  assert.doesNotMatch(msgWriteReminder, /subagent_create|function|details/i, 'no implementation noise');
});

test('child prompt blocks keep host identity before common and inherited guidance', () => {
  const host = 'CHILD_IDENTITY_AND_CREATOR_ADDRESS';
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
