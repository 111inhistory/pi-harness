import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createSurfaceTools } from '../../src/subagent/surface.ts';
import { childContext, composeAssignment, continuationControlPrompt, formatPeerMessage } from '../../src/subagent/prompt.ts';
import { promptText } from '../../src/prompt-text.mjs';
import { BUDGET_WARNING_MESSAGE } from '../../src/job-budget.mjs';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

test('Subagent tool text and schema preserve pre-extraction declarations independent of object key order', () => {
  const tools = createSurfaceTools({
    api: { getAllTools: () => [], getActiveTools: () => [] },
    resolveHost: async () => { throw new Error('Metadata capture must not resolve a host.'); },
    scope: { callerId: 'Main', depth: 0, allowInherited: true, cwd: process.cwd() },
  });
  const declarations = Object.values(tools).filter((tool) => tool !== null && tool.name !== 'write').map((tool) => {
    assert.ok(tool);
    const { name, description, promptSnippet, promptGuidelines, parameters, namespace } = tool;
    return { name, description, promptSnippet, promptGuidelines, parameters, namespace };
  });
  // TypeBox changes key insertion order, not text or schema. This canonical
  // digest was computed from the ORIGINAL captured declarations, not new code.
  const json: unknown = JSON.parse(JSON.stringify(declarations));
  assert.equal(createHash('sha256').update(JSON.stringify(canonical(json))).digest('hex'),
    'cc06bd6b7020362c97fee33c20f2c0124932795b80152c521de32d9752eeb80d');
});

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

test('shared Budget warning omits private limits', () => {
  assert.equal(BUDGET_WARNING_MESSAGE, 'Execution resources are becoming limited. Finish the current line of work,\navoid opening unrelated branches, verify the result, and return a final answer.');
});

test('missing prompt asset fails instead of selecting fallback prose', () => {
  assert.throws(() => promptText('not-an-installed-prompt.md'), { code: 'ENOENT' });
});
