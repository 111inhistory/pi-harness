import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadHarnessConfig } from '../../src/harness-config.ts';
import { loadPresets } from '../../src/preset/config.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pi-config-v1-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'project');
  mkdirSync(agentDir);
  mkdirSync(path.join(cwd, '.pi'), { recursive: true });
  const global = path.join(agentDir, 'harness.json');
  const project = path.join(cwd, '.pi', 'harness.json');
  const run = (...args: string[]) => spawnSync(process.execPath, [
    '--import', 'tsx', 'scripts/migrate-config-v1.mjs', '--agent-dir', agentDir, '--project-dir', cwd, ...args,
  ], { encoding: 'utf8' });
  return { agentDir, cwd, global, project, run };
}

const originalGlobal = '{"capability":{"blacklist":["global-tool"]}}\n';
const originalProject = '{"capability":{"blacklist":["project-tool"]}}\n';
const read = (file: string) => readFileSync(file, 'utf8');

test('config v1 CLI previews files and produces Harness and Preset documents accepted by their loaders', t => {
  const { agentDir, cwd, global, project, run } = fixture(t);
  const preset = path.join(agentDir, 'presets.toml');
  const oldPreset = '[version]\ninstructions = "The name is version."\n["fast.v2"]\nthinkingLevel = "low"\n';
  writeFileSync(global, originalGlobal);
  writeFileSync(project, originalProject);
  writeFileSync(preset, oldPreset);
  const dry = run();
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Dry run/);
  assert.equal(read(global), originalGlobal);
  assert.equal(read(project), originalProject);
  assert.equal(read(preset), oldPreset);
  assert.equal(existsSync(`${global}.pre-config-v1`), false);
  assert.equal(existsSync(`${project}.pre-config-v1`), false);

  const applied = run('--apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(read(`${global}.pre-config-v1`), originalGlobal);
  assert.equal(read(`${project}.pre-config-v1`), originalProject);
  assert.equal(read(`${preset}.pre-config-v1`), oldPreset);
  assert.deepEqual(loadHarnessConfig({ agentDir, cwd, projectTrusted: true }).capability.blacklist, ['global-tool', 'project-tool']);
  assert.deepEqual([...loadPresets({ agentDir, cwd, projectTrusted: true }).presets], [
    ['version', { instructions: 'The name is version.' }], ['fast.v2', { thinkingLevel: 'low' }],
  ]);
  const rerun = run('--apply');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /No changes needed/);
});

test('Harness v1 CLI refuses project-only violations and existing backups before writing either layer', t => {
  const { global, project, run } = fixture(t);
  const prohibited = '{"shell":{"approval":{}}}\n';
  writeFileSync(global, originalGlobal);
  writeFileSync(project, prohibited);
  const rejected = run('--apply');
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /shell\.approval is only allowed in global configuration/);
  assert.equal(read(global), originalGlobal);
  assert.equal(read(project), prohibited);
  assert.equal(existsSync(`${global}.pre-config-v1`), false);
  assert.equal(existsSync(`${project}.pre-config-v1`), false);

  writeFileSync(project, originalProject);
  writeFileSync(`${project}.pre-config-v1`, 'old backup');
  const blocked = run('--apply');
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /backup already exists/);
  assert.equal(read(`${project}.pre-config-v1`), 'old backup');
  assert.equal(read(global), originalGlobal);
  assert.equal(read(project), originalProject);
  assert.equal(existsSync(`${global}.pre-config-v1`), false);
});
