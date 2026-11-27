import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { loadPresets } from '../../src/preset/config.ts';
import { validateLegacyRoutingConfig } from '../../scripts/lib/routing-v4-migration.ts';

const script = fileURLToPath(new URL('../../scripts/migrate-config-toml.mjs', import.meta.url));

function migrate(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8' });
}

test('offline TOML migration keeps Unicode, dotted names and routing order, and never overwrites its targets', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'config-toml-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'project');
  mkdirSync(cwd);
  const presetPath = path.join(directory, 'presets.json');
  const routingPath = path.join(directory, 'subagent-routing.json');
  const presetToml = path.join(directory, 'presets.toml');
  const routingToml = path.join(directory, 'subagent-routing.toml');
  const legacyPresets = JSON.stringify({ 'fast.v2 中文': { instructions: '第一行\n第二行\n', tools: [] } });
  const legacyRouting = JSON.stringify({
    version: 3,
    classifier: { provider: 'fake-provider', id: 'fake-classifier' },
    instructions: { role: 'Pick a role', model: 'Pick a preset' },
    roles: [
      { id: 'z-last', instructions: 'First', candidates: { named: 'fast.v2 中文', 'inline.v2': { thinkingLevel: 'high' } } },
      { id: 'a-first', instructions: 'Second', candidates: { named: 'fast.v2 中文' } },
    ],
  });
  writeFileSync(presetPath, legacyPresets);
  writeFileSync(routingPath, legacyRouting);

  const preview = migrate(presetPath, routingPath);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(existsSync(presetToml), false);
  assert.equal(existsSync(routingToml), false);
  assert.equal(loadPresets({ agentDir: directory, cwd, projectTrusted: true }).presets.size, 0);

  const applied = migrate('--apply', presetPath, routingPath);
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(loadPresets({ agentDir: directory, cwd, projectTrusted: true }).presets.get('fast.v2 中文'), {
    instructions: '第一行\n第二行\n', tools: [],
  });
  const routing = validateLegacyRoutingConfig(parse(readFileSync(routingToml, 'utf8')));
  assert.deepEqual(routing.roles.map(role => role.id), ['z-last', 'a-first']);
  assert.deepEqual(Object.keys(routing.roles[0]!.candidates), ['named', 'inline.v2']);
  assert.deepEqual(routing.roles[0]?.candidates['inline.v2'], { thinkingLevel: 'high' });
  assert.equal(routing.roles[0]?.candidates['named'], 'fast.v2 中文');
  assert.equal(readFileSync(presetPath, 'utf8'), legacyPresets);
  assert.equal(readFileSync(routingPath, 'utf8'), legacyRouting);

  const expected = readFileSync(presetToml, 'utf8');
  writeFileSync(presetPath, '{"replacement": {}}');
  const conflict = migrate('--apply', presetPath);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /already exists/);
  assert.equal(readFileSync(presetToml, 'utf8'), expected);
});
