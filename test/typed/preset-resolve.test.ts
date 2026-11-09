import assert from 'node:assert/strict';
import test from 'node:test';

import type { PresetConfig } from '../../src/preset/config.ts';
import { resolvePreset, type PresetCatalogView } from '../../src/preset/resolve.ts';

function view(overrides: Partial<PresetCatalogView> = {}): PresetCatalogView {
  return {
    hasModel: () => true,
    allToolNames: () => ['read', 'bash', 'edit', 'write', 'codemode'],
    baseToolSet: () => ['read', 'bash', 'edit'],
    ...overrides,
  };
}

test('resolves every field into a plan', () => {
  const preset: PresetConfig = {
    model: { provider: 'p', id: 'm' },
    thinkingLevel: 'high',
    tools: ['+write', '-bash'],
    codemode: { mode: 'only' },
    instructions: 'do things',
  };
  const { plan, issues } = resolvePreset('fast', preset, view());
  assert.equal(issues.length, 0);
  assert.ok(plan);
  assert.deepEqual(plan.model, { provider: 'p', id: 'm' });
  assert.equal(plan.thinkingLevel, 'high');
  assert.deepEqual(plan.tools, ['read', 'edit', 'write']);
  assert.deepEqual(plan.codemode, { mode: 'only' });
  assert.equal(plan.instructions, 'do things');
});

test('unknown model is a hard error and produces no plan', () => {
  const preset: PresetConfig = { model: { provider: 'p', id: 'missing' } };
  const { plan, issues } = resolvePreset('bad', preset, view({ hasModel: () => false }));
  assert.equal(plan, null);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'error');
  assert.equal(issues[0]?.kind, 'unknown_model');
});

test('adding an unknown tool warns and is dropped; the rest still applies', () => {
  const preset: PresetConfig = { tools: ['+ghost', '+write'] };
  const { plan, issues } = resolvePreset('p', preset, view());
  assert.ok(plan);
  assert.deepEqual(plan.tools, ['read', 'bash', 'edit', 'write']);
  assert.ok(issues.some((issue) => issue.kind === 'unknown_tool' && issue.severity === 'warning'));
});

test('removing an absent tool is harmless and not reported', () => {
  const preset: PresetConfig = { tools: ['-ghost'] };
  const { plan, issues } = resolvePreset('p', preset, view());
  assert.ok(plan);
  assert.deepEqual(plan.tools, ['read', 'bash', 'edit']);
  assert.equal(issues.length, 0);
});

test('an invalid modifier token is a warning', () => {
  const preset: PresetConfig = { tools: ['+'] };
  const { plan, issues } = resolvePreset('p', preset, view());
  assert.ok(plan);
  assert.ok(issues.some((issue) => issue.kind === 'invalid_tool_modifier'));
});

test('a preset without tools leaves the selection unspecified', () => {
  const { plan } = resolvePreset('p', {}, view());
  assert.ok(plan);
  assert.equal(plan.tools, undefined);
  assert.equal(plan.instructions, null);
});

test('tool resolution is computed from the stable base, not a running set', () => {
  const a: PresetConfig = { tools: ['+write'] };
  const b: PresetConfig = { tools: ['+codemode', '-bash'] };
  const planBFromA = resolvePreset('b', b, view()).plan;
  const planBDirect = resolvePreset('b', b, view()).plan;
  assert.deepEqual(planBFromA?.tools, planBDirect?.tools);
  assert.deepEqual(planBDirect?.tools, ['read', 'edit', 'codemode']);
});
