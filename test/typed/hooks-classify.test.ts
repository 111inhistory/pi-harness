import assert from 'node:assert/strict';
import test from 'node:test';
import { classifiedActions } from '../../src/hooks/classify.ts';
import { normalizeHookRules } from '../../src/hooks/config.ts';

const hint = { type: 'injectHint', text: 'Read the existing result.' };
function rule(classify: object, additional: object = {}) {
  const rule = normalizeHookRules({ probe: { on: 'tool_result', classify, ...additional } }).probe;
  assert.ok(rule && !('enabled' in rule));
  return rule;
}

test('classify validates the opt-in event domain and static action mapping', () => {
  const choice = { kind: 'choice', question: 'Pick a category.', choices: ['docs', 'other'] };
  assert.throws(() => rule({ ...choice, include: ['prompt'] }), /unavailable field/);
  assert.throws(() => rule(choice, { on: 'before_agent_start', classify: { ...choice, include: ['result'] } }), /unavailable field/);
  assert.throws(() => rule(choice, { onChoice: { typo: [hint] } }), /onChoice.typo is unknown/);
  assert.throws(() => rule(choice, { actions: [hint] }), /use onChoice/);
  assert.throws(() => rule(choice, { onChoice: { docs: [{ type: 'injectSection', text: 'section' }] } }), /cannot injectSection/);
  assert.throws(() => rule({ kind: 'score', question: 'Estimate quality.', minScore: 2 }), /minScore/);
  const normalized = rule({ ...choice, include: ['recentTools', 'recentToolPreviews'] }, { onChoice: { docs: [hint] } });
  assert.deepEqual(normalized.classify?.include, ['recentToolPreviews', 'recentTools']);
  assert.deepEqual(normalized.onChoice?.docs, [hint]);
});

test('classify distinguishes malformed answers, negative answers and mapped actions', () => {
  const boolean = rule({ kind: 'bool', question: 'Does the condition hold?' }, { actions: [hint] });
  assert.deepEqual(classifiedActions(boolean, { hook: { type: 'bool', probability: 0.8 } }), [hint]);
  assert.deepEqual(classifiedActions(boolean, { hook: { type: 'bool', probability: 0.5 } }), []);
  assert.equal(classifiedActions(boolean, { hook: { type: 'bool', probability: 1.1 } }), undefined);
  const score = rule({ kind: 'score', question: 'Estimate quality.', minScore: 0.7 }, { actions: [hint] });
  assert.deepEqual(classifiedActions(score, { hook: { type: 'score', score: 0.7, confidence: 1 } }), [hint]);
  assert.equal(classifiedActions(score, { hook: { type: 'score', score: 0.7 } }), undefined);
  const choice = rule({ kind: 'choice', question: 'Pick a category.', choices: ['docs', 'other'] }, { onChoice: { docs: [hint] } });
  assert.deepEqual(classifiedActions(choice, { hook: { type: 'choice', choice: 'docs', confidence: 1, probabilities: { docs: 0.9, other: 0.1 } } }), [hint]);
  assert.deepEqual(classifiedActions(choice, { hook: { type: 'choice', choice: 'other', confidence: 1, probabilities: { docs: 0.1, other: 0.9 } } }), []);
  assert.equal(classifiedActions(choice, { hook: { type: 'choice', choice: 'docs', confidence: 1, probabilities: { docs: 0.1, other: 0.9 } } }), undefined);
});
