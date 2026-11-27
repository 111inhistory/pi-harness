import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { stringify } from 'smol-toml';

import { parsePresetCommand } from '../../src/preset/command.ts';
import { loadPresets, type PresetConfig, type PresetFileReader } from '../../src/preset/config.ts';
import { parseToolModifiers } from '../../src/preset/modifiers.ts';
import { resolvePreset, type PresetCatalogView } from '../../src/preset/resolve.ts';

// The three modules tested here form one definition pipeline: TOML config is
// loaded and validated, tool modifiers are parsed, and resolution derives the
// plan applied to a session. The stable base the modifier and resolve cases use
// is the catalog's default active set.
const baseTools = ['read', 'bash', 'edit'];

test('plain selection replaces the base and cannot mix with modifiers', () => {
  const view: PresetCatalogView = { hasModel: () => true, allToolNames: () => [...baseTools, 'apply_patch'], baseToolSet: () => baseTools };
  assert.deepEqual(resolvePreset('plain', { tools: ['read', 'apply_patch'] }, view).plan?.tools, ['read', 'apply_patch']);
  for (const tools of [['read', '+apply_patch'], ['read', '-edit']]) {
    const result = resolvePreset('mixed', { tools }, view);
    assert.equal(result.plan, null);
    assert.ok(result.issues.some(issue => issue.severity === 'error' && issue.kind === 'invalid_tool_modifier'));
  }
  assert.deepEqual(resolvePreset('minus', { tools: ['-edit'] }, view).plan?.disabledTools, ['edit']);
});

// ---- configuration loading ----

function readerFrom(files: Record<string, string>): PresetFileReader {
  return (filePath) => files[filePath];
}

const agentDir = path.resolve('/agent');
const cwd = path.resolve('/project');
// The injected reader stands in for the file system, so it is keyed by the
// native absolute paths the loader asks for, not by POSIX spellings.
const globalPath = path.join(agentDir, 'presets.toml');
const projectPath = path.join(cwd, '.pi', 'presets.toml');

function load(files: Record<string, string>, projectTrusted = true) {
  return loadPresets({ cwd, agentDir, projectTrusted, read: readerFrom(files) });
}

test('loads global presets', () => {
  const { presets, warnings } = load({
    [globalPath]: stringify({ fast: { model: { provider: 'p', id: 'm' }, thinkingLevel: 'low' } }),
  });
  assert.equal(warnings.length, 0);
  const fast = presets.get('fast');
  assert.ok(fast);
  assert.deepEqual(fast.model, { provider: 'p', id: 'm' });
  assert.equal(fast.thinkingLevel, 'low');
});

test('project preset replaces a same-named global preset wholesale', () => {
  const { presets } = load({
    [globalPath]: stringify({ fast: { thinkingLevel: 'low', tools: ['+read'] } }),
    [projectPath]: stringify({ fast: { instructions: 'project' } }),
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
    [globalPath]: stringify({ fast: { thinkingLevel: 'low' } }),
    [projectPath]: stringify({ fast: { thinkingLevel: 'high' } }),
  }, false);
  assert.equal(presets.get('fast')?.thinkingLevel, 'low');
});

test('invalid TOML in one file is a warning, not a crash', () => {
  const { presets, warnings, invalidDocument } = load({ [globalPath]: '[fast' });
  assert.equal(invalidDocument, true);
  assert.equal(presets.size, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /invalid TOML/);
});

test('the shipped preset example loads through the production validator', () => {
  const example = readFileSync(new URL('../../config/presets.toml', import.meta.url), 'utf8');
  const { presets, warnings, invalidDocument } = load({ [globalPath]: example });
  assert.equal(invalidDocument, false);
  assert.equal(warnings.length, 0);
  assert.deepEqual(presets.get('fast'), {
    description: '日常模型配置（示例，使用合成占位数据）',
    model: { provider: 'fake-provider', id: 'fast-model' },
    thinkingLevel: 'medium',
    tools: ['+codemode', '-bash'],
    codemode: { mode: 'only' },
    instructions: '该模型的专属调用指引（示例）。',
  });
  assert.deepEqual(presets.get('deep')?.model, { provider: 'fake-provider', id: 'deep-model' });
});

test('a presets.json document is not a runtime fallback', () => {
  const legacyPath = path.join(agentDir, 'presets.json');
  const { presets, invalidDocument } = load({ [legacyPath]: JSON.stringify({ fast: {} }) });
  assert.equal(invalidDocument, false);
  assert.equal(presets.size, 0, 'the loader only requests presets.toml');
});

test('invalid trusted project entries shadow the same global name without hiding valid neighbors', () => {
  const { presets, invalidNames, invalidDocument } = load({
    [globalPath]: stringify({ fast: {}, light: {} }),
    [projectPath]: stringify({ fast: { tools: false } }),
  });
  assert.equal(invalidDocument, false);
  assert.deepEqual([...invalidNames], ['fast']);
  assert.deepEqual([...presets.keys()], ['light']);
});

test('invalid entries are skipped with warnings', () => {
  const { presets, warnings } = load({
    // A TOML date parses to a TomlDate object, which is not a Preset record.
    [globalPath]: 'dated = 1979-05-27\n'
      + stringify({ bad: { thinkingLevel: 'low', surprise: true }, good: { thinkingLevel: 'high' } }),
  });
  assert.equal(presets.has('dated'), false);
  assert.equal(presets.has('bad'), false);
  assert.equal(presets.get('good')?.thinkingLevel, 'high');
  assert.ok(warnings.some((warning) => warning.includes('"dated"') && warning.includes('preset must be an object')));
  assert.ok(warnings.some((warning) => warning.includes('"bad"') && warning.includes('unknown field')));
});

test('a malformed model field is rejected', () => {
  const { presets, warnings } = load({ [globalPath]: stringify({ bad: { model: { provider: 'p' } } }) });
  assert.equal(presets.has('bad'), false);
  assert.ok(warnings.some((warning) => warning.includes('model.provider')));
});

test('an invalid codemode mode is rejected', () => {
  const { presets, warnings } = load({ [globalPath]: stringify({ bad: { codemode: { mode: 'both' } } }) });
  assert.equal(presets.has('bad'), false);
  assert.ok(warnings.some((warning) => warning.includes('codemode.mode')));
});

// ---- tool modifiers ----

test('command parsing maps bare/show, clear words and preset names', () => {
  for (const raw of ['', '   ', 'show']) assert.deepEqual(parsePresetCommand(raw), { kind: 'show' });
  for (const word of ['clear', 'CLEAR', '(none)', 'none', 'off']) {
    assert.deepEqual(parsePresetCommand(word), { kind: 'clear' });
  }
  assert.deepEqual(parsePresetCommand('  fast  '), { kind: 'apply', name: 'fast' });
});

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

// ---- v2 version identity ----

test('a registered Harness default joins the nominal candidate baseline', () => {
  const registered = [...baseTools, 'write', 'job_stop', 'job_send'];
  const { plan } = resolvePreset('upgraded', { tools: ['+write'] }, view({
    allToolNames: () => registered,
    baseToolSet: () => baseTools,
  }));
  assert.ok(plan);
  assert.deepEqual(plan.tools, ['read', 'bash', 'edit', 'job_stop', 'job_send', 'write'],
    'the old baseline predates the new default tools, so they join the selection');
  assert.deepEqual(plan.baselineAdditions, ['job_stop', 'job_send'],
    'the increments are recorded so replay and a clear keep them');
  assert.deepEqual(plan.toolSelection, { kind: 'modifiers', add: ['write'], remove: [] });
});

test('unregistered and non-Harness defaults never join the candidate baseline', () => {
  const { plan } = resolvePreset('p', { tools: ['+write'] }, view({
    allToolNames: () => [...baseTools, 'job_stop', 'mcp_late_tool'],
    baseToolSet: () => baseTools,
  }));
  assert.ok(plan);
  assert.ok(plan.tools?.includes('job_stop'));
  assert.ok(!plan.tools?.includes('mcp_late_tool'), 'a late-registered MCP tool is not a Harness default');
  assert.ok(!plan.tools?.includes('job_send'), 'a default that was never registered cannot be selected');
});

test('an existing baseline increment is not recorded twice', () => {
  const { plan } = resolvePreset('p', { tools: ['+write'] }, view({
    allToolNames: () => [...baseTools, 'write', 'job_stop'],
    baseToolSet: () => [...baseTools, 'job_stop'],
  }));
  assert.deepEqual(plan?.baselineAdditions, [], 'the increment is already baseline membership');
  assert.deepEqual(plan?.tools, ['read', 'bash', 'edit', 'job_stop', 'write']);
});

test('tool selection is recorded as normalized intent', () => {
  const selection = (tools: readonly string[]) => resolvePreset('p', { tools }, view()).plan?.toolSelection;
  assert.deepEqual(selection(['read', 'write']), { kind: 'replace', names: ['read', 'write'] });
  assert.deepEqual(selection([]), { kind: 'replace', names: [] }, 'an empty list is an explicit empty selection');
  assert.deepEqual(resolvePreset('empty', { tools: [] }, view()).plan?.tools, []);
  assert.deepEqual(selection(['+write', '-write']), { kind: 'modifiers', add: [], remove: ['write'] });
  assert.deepEqual(selection(['-write', '+write']), { kind: 'modifiers', add: ['write'], remove: [] });
  assert.deepEqual(selection(['-bash', '+codemode']), { kind: 'modifiers', add: ['codemode'], remove: ['bash'] });
  assert.deepEqual(selection(['+']), { kind: 'none' }, 'unusable tokens declare nothing');
  assert.deepEqual(selection(['write', '+grep']), undefined, 'mixing plain names and modifiers is an error');
});
