import assert from 'node:assert/strict';
import test from 'node:test';
import { promptAsset, promptField, promptString, promptStrings, promptText } from '../../src/prompt-text.ts';

test('prompt assets share one parsed object and retain raw text', () => {
  const name = 'capability-tools.json';
  assert.equal(promptAsset(name), promptAsset(name));
  assert.deepEqual(promptAsset(name), JSON.parse(promptText(name)));
  assert.equal(promptString(name, 'step', 'description'), promptField(name, 'step', 'description'));
  assert.equal(promptStrings(name, 'capability', 'guidelines'), promptField(name, 'capability', 'guidelines'));
});

test('typed prompt getters reject missing or incompatible JSON fields', () => {
  assert.throws(() => promptString('capability-tools.json', 'missing'), TypeError);
  assert.throws(() => promptString('capability-tools.json', 'step'), TypeError);
  assert.throws(() => promptStrings('capability-tools.json', 'step', 'description'), TypeError);
  assert.throws(() => promptField('capability-tools.json', 'step', 'description', 'missing'), TypeError);
});
