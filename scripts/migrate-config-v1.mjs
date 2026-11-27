#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { HARNESS_CONFIG_VERSION, harnessConfigBody, resolveHarnessConfig } from '../src/harness-config.ts';
import { HOOK_CONFIG_VERSION, validateHookDocument } from '../src/hooks/config.ts';
import { PRESET_CONFIG_VERSION, validatePresetDocument } from '../src/preset/config.ts';

const BACKUP = '.pre-config-v1';

function regularFile(file) {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile()) throw new Error(`${file}: expected a regular file`);
  return stat;
}

function planHarness(file, scope) {
  const stat = regularFile(file);
  if (stat === undefined) return undefined;
  const before = readFileSync(file);
  const value = JSON.parse(before.toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${file}: expected a JSON object`);
  const alreadyVersioned = Object.hasOwn(value, 'version');
  const document = alreadyVersioned ? value : { version: HARNESS_CONFIG_VERSION, ...value };
  const body = harnessConfigBody(document, file);
  return { file, scope, stat, before, body, after: alreadyVersioned ? undefined : `${JSON.stringify(document, null, 2)}\n` };
}

function presetCatalog(file, document) {
  const { catalog, warnings } = validatePresetDocument(file, document);
  if (warnings.length > 0) throw new Error(warnings.join('\n'));
  return [...catalog];
}

function planToml(file, container, version, validate) {
  const stat = regularFile(file);
  if (stat === undefined) return undefined;
  const before = readFileSync(file);
  const value = parse(before.toString('utf8'));
  // In a legacy document a rule or Preset named "version" must be a table.
  const alreadyVersioned = Object.hasOwn(value, 'version') && (typeof value.version !== 'object' || value.version === null);
  const document = alreadyVersioned ? value : { version, [container]: value };
  const expected = validate(file, document);
  if (alreadyVersioned) return undefined;
  const after = stringify(document);
  assert.deepStrictEqual(validate(file, parse(after)), expected, `${file}: TOML changed configuration semantics`);
  return { file, stat, before, after };
}

function verifyOriginal(change) {
  const current = regularFile(change.file);
  if (current === undefined || current.dev !== change.stat.dev || current.ino !== change.stat.ino
      || !readFileSync(change.file).equals(change.before)) throw new Error(`${change.file}: file changed after preflight`);
}

function apply(changes) {
  const staged = [];
  try {
    for (const change of changes) {
      const stage = `${change.file}.config-v1-${randomUUID()}`;
      const fd = openSync(stage, 'wx', 0o600);
      staged.push({ change, stage });
      try { writeFileSync(fd, change.after); }
      finally { closeSync(fd); }
    }
    for (const { change } of staged) verifyOriginal(change);
    for (const { change } of staged) writeFileSync(change.file + BACKUP, change.before, { flag: 'wx', mode: 0o600 });
    for (const { change, stage } of staged) {
      verifyOriginal(change);
      renameSync(stage, change.file);
      console.log(`Migrated ${change.file}; original: ${change.file + BACKUP}`);
    }
  } finally {
    for (const { stage } of staged) {
      try { unlinkSync(stage); }
      catch (error) { if (error.code !== 'ENOENT') console.error(`Remove unused staging file ${stage}: ${error.message}`); }
    }
  }
}

try {
  const { values } = parseArgs({ options: {
    'agent-dir': { type: 'string' }, 'project-dir': { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: npm run migrate:config-v1 -- --agent-dir DIR [--project-dir DIR] [--apply]');
  } else {
    if (!values['agent-dir']) throw new Error('--agent-dir is required');
    const roots = [{ dir: path.resolve(values['agent-dir']), scope: 'global' }];
    if (values['project-dir']) roots.push({ dir: path.resolve(values['project-dir'], '.pi'), scope: 'project' });
    const harness = roots.map(({ dir, scope }) => planHarness(path.join(dir, 'harness.json'), scope)).filter(Boolean);
    resolveHarnessConfig(harness.map(({ file, scope, body }) => ({ source: file, scope, value: body })));
    const leaves = roots.flatMap(({ dir }) => [
      planToml(path.join(dir, 'presets.toml'), 'presets', PRESET_CONFIG_VERSION, presetCatalog),
      planToml(path.join(dir, 'hooks.toml'), 'hooks', HOOK_CONFIG_VERSION, validateHookDocument),
    ]);
    const changes = [...harness, ...leaves].filter(plan => plan?.after !== undefined);
    for (const { file } of changes) {
      if (regularFile(file + BACKUP) !== undefined) throw new Error(`${file + BACKUP}: backup already exists; keep it and resolve the conflict before applying`);
      console.log(`${values.apply ? 'Will migrate' : 'Would migrate'} ${file}`);
    }
    if (changes.length === 0) console.log('No changes needed.');
    else if (values.apply) {
      console.log('Each file is replaced separately. If interrupted, inspect the originals and backups before resuming.');
      apply(changes);
    } else console.log('Dry run. Stop Pi before applying with --apply.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
