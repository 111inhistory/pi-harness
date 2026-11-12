import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadPresets, type PresetConfig, type PresetFileReader } from '../../src/preset/config.ts';
import { applyToolModifiers, parseToolModifiers } from '../../src/preset/modifiers.ts';
import { resolvePreset, type PresetCatalogView } from '../../src/preset/resolve.ts';

// The three modules tested here form one definition pipeline: JSON config is
// loaded and validated, tool modifiers are parsed, and resolution derives the
// plan applied to a session. The stable base the modifier and resolve cases use
// is the catalog's default active set.
const baseTools = ['read', 'bash', 'edit'];

// ---- configuration loading ----

function readerFrom(files: Record<string, string>): PresetFileReader {
  return (filePath) => files[filePath];
}

const agentDir = path.resolve('/agent');
const cwd = path.resolve('/project');
// The injected reader stands in for the file system, so it is keyed by the
// native absolute paths the loader asks for, not by POSIX spellings.
const globalPath = path.join(agentDir, 'presets.json');
const projectPath = path.join(cwd, '.pi', 'presets.json');

function load(files: Record<string, string>, projectTrusted = true) {
  return loadPresets({ cwd, agentDir, projectTrusted, read: readerFrom(files) });
}

test('loads global presets', () => {
  const { presets, warnings } = load({
    [globalPath]: JSON.stringify({ fast: { model: { provider: 'p', id: 'm' }, thinkingLevel: 'low' } }),
  });
  assert.equal(warnings.length, 0);
  const fast = presets.get('fast');
  assert.ok(fast);
  assert.deepEqual(fast.model, { provider: 'p', id: 'm' });
  assert.equal(fast.thinkingLevel, 'low');
});

test('project preset replaces a same-named global preset wholesale', () => {
  const { presets } = load({
    [globalPath]: JSON.stringify({ fast: { thinkingLevel: 'low', tools: ['+read'] } }),
    [projectPath]: JSON.stringify({ fast: { instructions: 'project' } }),
  });
  const fast = presets.get('fast');
  assert.ok(fast);
  // Whole-entry replace: the global thinkingLevel/tools must not linger.
  assert.equal(fast.thinkingLevel, undefined);
  assert.equal(fast.tools, undefined);
  assert.equal(fast.instructions, 'project');
});

test('project preset is ignored when the project is not trusted', () => {
  const { presets } = load({
    [globalPath]: JSON.stringify({ fast: { thinkingLevel: 'low' } }),
    [projectPath]: JSON.stringify({ fast: { thinkingLevel: 'high' } }),
  }, false);
  assert.equal(presets.get('fast')?.thinkingLevel, 'low');
});

test('invalid JSON in one file is a warning, not a crash', () => {
  const { presets, warnings } = load({ [globalPath]: '{ not json' });
  assert.equal(presets.size, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /invalid JSON/);
});

test('a preset with an unknown field is skipped with a warning', () => {
  const { presets, warnings } = load({
    [globalPath]: JSON.stringify({ bad: { thinkingLevel: 'low', surprise: true }, good: { thinkingLevel: 'high' } }),
  });
  assert.equal(presets.has('bad'), false);
  assert.equal(presets.get('good')?.thinkingLevel, 'high');
  assert.ok(warnings.some((warning) => warning.includes('"bad"') && warning.includes('unknown field')));
});

test('a malformed model field is rejected', () => {
  const { presets, warnings } = load({ [globalPath]: JSON.stringify({ bad: { model: { provider: 'p' } } }) });
  assert.equal(presets.has('bad'), false);
  assert.ok(warnings.some((warning) => warning.includes('model.provider')));
});

test('an invalid codemode mode is rejected', () => {
  const { presets, warnings } = load({ [globalPath]: JSON.stringify({ bad: { codemode: { mode: 'both' } } }) });
  assert.equal(presets.has('bad'), false);
  assert.ok(warnings.some((warning) => warning.includes('codemode.mode')));
});

// ---- tool modifiers ----

test('parse splits ops, plain names and invalid tokens', () => {
  const { tokens, invalid } = parseToolModifiers(['+read', '-bash', 'edit', '+', '  ', '-io']);
  assert.deepEqual(tokens, [
    { op: '+', name: 'read' },
    { op: '-', name: 'bash' },
    { op: '=', name: 'edit' },
    { op: '-', name: 'io' },
  ]);
  assert.deepEqual(invalid, ['+', '  ']);
});

test('adds and removes apply on the base', () => {
  const { tokens } = parseToolModifiers(['+write', '-bash']);
  assert.deepEqual(applyToolModifiers(baseTools, tokens), ['read', 'edit', 'write']);
});

test('a plain name replaces the base selection', () => {
  const { tokens } = parseToolModifiers(['write', '+read']);
  assert.deepEqual(applyToolModifiers(baseTools, tokens), ['write', 'read']);
});

test('later tokens win over earlier ones for the same name', () => {
  const base = ['read'];
  assert.deepEqual(applyToolModifiers(base, parseToolModifiers(['-read', '+read']).tokens), ['read']);
  assert.deepEqual(applyToolModifiers(base, parseToolModifiers(['+read', '-read']).tokens), []);
});

test('base order is preserved and added names append in first-seen order', () => {
  const { tokens } = parseToolModifiers(['+write', '+grep', '-bash']);
  assert.deepEqual(applyToolModifiers(['read', 'bash'], tokens), ['read', 'write', 'grep']);
});

// ---- plan resolution ----

function view(overrides: Partial<PresetCatalogView> = {}): PresetCatalogView {
  return {
    hasModel: () => true,
    allToolNames: () => ['read', 'bash', 'edit', 'write', 'codemode'],
    baseToolSet: () => baseTools,
    ...overrides,
  };
}

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
  assert.ok(resolvePreset('a', a, view()).plan?.tools?.includes('write'));
  const planB = resolvePreset('b', b, view()).plan;
  assert.deepEqual(planB?.tools, ['read', 'edit', 'codemode']);
  assert.ok(!planB?.tools?.includes('write'), 'A\'s added tool does not leak into B');
});
