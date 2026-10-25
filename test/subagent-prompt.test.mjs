import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import subagentExtension from '../extensions/subagent.mjs';
import { childContext, composeAssignment, composePrompt, composeContinuationPrompt, formatPeerMessage } from '../src/subagent-prompt.mjs';
import { promptText } from '../src/prompt-text.mjs';
import { BUDGET_WARNING_MESSAGE } from '../src/job-budget.mjs';

test('external Subagent tool text preserves the pre-extraction declarations exactly', () => {
  const tools = [];
  subagentExtension({ on() {}, registerTool: (tool) => tools.push(tool), getAllTools: () => [] });
  const declarations = tools.filter((tool) => tool.name !== 'write').map(({ name, description, promptSnippet, promptGuidelines, parameters, namespace }) =>
    ({ name, description, promptSnippet, promptGuidelines, parameters, namespace }));
  assert.equal(createHash('sha256').update(JSON.stringify(declarations)).digest('hex'),
    '471b592b3dba5a25c2ed31de714c9148b252955c03d2a0c8bcf0d223ceb16309');
});

test('routing and execution preserve assignment context bytes', () => {
  assert.equal(composeAssignment('TASK', ' \n\t'), 'TASK');
  assert.equal(composeAssignment('TASK', '  context\n'), '# Batch context\n\n  context\n\n\n# Task\n\nTASK');
});

test('peer attribution and first-run messages keep their original format', () => {
  const messages = [{ text: formatPeerMessage({ from: 'sub_01', content: 'hello\nworld' }) }, { text: 'second' }];
  assert.equal(messages[0].text, '[Message from sub_01]\nhello\nworld');
  assert.equal(composePrompt('task', []), 'task');
  assert.equal(composePrompt('task', messages), 'task\n\n# Messages from other agents\n\n[Message from sub_01]\nhello\nworld\n\nsecond');
});

test('revivals preserve the distinction between an unrecorded assignment and an ended Job', () => {
  const messages = [{ text: 'new content' }];
  assert.equal(composeContinuationPrompt(messages, null), '# New message\n\nThe previous Job for this agent had already finished. The messages below arrived afterwards and start this new Job.\n\nnew content');
  assert.equal(composeContinuationPrompt(messages, 'original task'), '# Original assignment\n\nThis agent\'s first Job was stopped before its conversation recorded anything, so its assignment is restated here.\n\noriginal task\n\n# New message\n\nThe messages below arrived while this agent had no recorded conversation and start its first run.\n\nnew content');
});

test('child context inserts identifiers and socket paths literally, including dollar replacement syntax', () => {
  const body = childContext('sub_01', 'Main', '/tmp/$&/$`/$\'/Main.sock');
  assert.equal(body, 'You are Subagent sub_01. Your direct parent is Main. To message that parent, use your enabled write or msg_write with parentSocket /tmp/$&/$`/$\'/Main.sock and plain text content; omit from and to. The host frames the transport and binds your sender identity. Your execution round also ends with an automatic host notification; do not send a separate completion message unless you have content the parent needs.');
});

test('shared Budget warning stays identical and omits private limits', () => {
  assert.equal(BUDGET_WARNING_MESSAGE, 'Execution resources are becoming limited. Finish the current line of work,\navoid opening unrelated branches, verify the result, and return a final answer.');
});

test('a missing prompt asset fails instead of silently selecting fallback prose', () => {
  assert.throws(() => promptText('not-an-installed-prompt.md'), { code: 'ENOENT' });
});
