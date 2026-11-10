import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadPresets, type PresetFileReader } from '../../src/preset/config.ts';

function readerFrom(files: Record<string, string>): PresetFileReader {
  return (filePath) => files[filePath];
}

const agentDir = path.resolve('/agent');
const cwd = path.resolve('/project');
// The injected reader stands in for the file system, so it is keyed by the
// native absolute paths the loader asks for, not by POSIX spellings.
const globalPath = path.join(agentDir, 'presets.json');
const projectPath = path.join(cwd, '.pi', 'presets.json');

test('loads global presets', () => {
  const read = readerFrom({
    [globalPath]: JSON.stringify({ fast: { model: { provider: 'p', id: 'm' }, thinkingLevel: 'low' } }),
  });
  const { presets, warnings } = loadPresets({ cwd, agentDir, projectTrusted: true, read });
  assert.equal(warnings.length, 0);
  const fast = presets.get('fast');
  assert.ok(fast);
  assert.deepEqual(fast.model, { provider: 'p', id: 'm' });
  assert.equal(fast.thinkingLevel, 'low');
});

test('project preset replaces a same-named global preset wholesale', () => {
  const read = readerFrom({
    [globalPath]: JSON.stringify({ fast: { thinkingLevel: 'low', tools: ['+read'] } }),
    [projectPath]: JSON.stringify({ fast: { instructions: 'project' } }),
  });
  const { presets } = loadPresets({ cwd, agentDir, projectTrusted: true, read });
  const fast = presets.get('fast');
  assert.ok(fast);
  // Whole-entry replace: the global thinkingLevel/tools must not linger.
  assert.equal(fast.thinkingLevel, undefined);
  assert.equal(fast.tools, undefined);
  assert.equal(fast.instructions, 'project');
});

test('project preset is ignored when the project is not trusted', () => {
  const read = readerFrom({
    [globalPath]: JSON.stringify({ fast: { thinkingLevel: 'low' } }),
    [projectPath]: JSON.stringify({ fast: { thinkingLevel: 'high' } }),
  });
  const { presets } = loadPresets({ cwd, agentDir, projectTrusted: false, read });
  assert.equal(presets.get('fast')?.thinkingLevel, 'low');
});

test('invalid JSON in one file is a warning, not a crash', () => {
  const read = readerFrom({ [globalPath]: '{ not json' });
  const { presets, warnings } = loadPresets({ cwd, agentDir, projectTrusted: true, read });
  assert.equal(presets.size, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /invalid JSON/);
});

test('a preset with an unknown field is skipped with a warning', () => {
  const read = readerFrom({
    [globalPath]: JSON.stringify({ bad: { thinkingLevel: 'low', surprise: true }, good: { thinkingLevel: 'high' } }),
  });
  const { presets, warnings } = loadPresets({ cwd, agentDir, projectTrusted: true, read });
  assert.equal(presets.has('bad'), false);
  assert.equal(presets.get('good')?.thinkingLevel, 'high');
  assert.ok(warnings.some((warning) => warning.includes('"bad"') && warning.includes('unknown field')));
});

test('an invalid thinking level skips that preset only', () => {
  const read = readerFrom({
    [globalPath]: JSON.stringify({ bad: { thinkingLevel: 'turbo' }, good: {} }),
  });
  const { presets, warnings } = loadPresets({ cwd, agentDir, projectTrusted: true, read });
  assert.equal(presets.has('bad'), false);
  assert.equal(presets.has('good'), true);
  assert.ok(warnings.some((warning) => warning.includes('thinkingLevel')));
});

test('a malformed model field is rejected', () => {
  const read = readerFrom({ [globalPath]: JSON.stringify({ bad: { model: { provider: 'p' } } }) });
  const { presets, warnings } = loadPresets({ cwd, agentDir, projectTrusted: true, read });
  assert.equal(presets.has('bad'), false);
  assert.ok(warnings.some((warning) => warning.includes('model.provider')));
});

test('an invalid codemode mode is rejected', () => {
  const read = readerFrom({ [globalPath]: JSON.stringify({ bad: { codemode: { mode: 'both' } } }) });
  const { presets, warnings } = loadPresets({ cwd, agentDir, projectTrusted: true, read });
  assert.equal(presets.has('bad'), false);
  assert.ok(warnings.some((warning) => warning.includes('codemode.mode')));
});
