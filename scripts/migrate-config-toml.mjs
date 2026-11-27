#!/usr/bin/env node
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { PRESET_CONFIG_VERSION, validatePresetDocument } from '../src/preset/config.ts';
import { assertRoutingCandidateOrder, validateLegacyRoutingConfig } from './lib/routing-v4-migration.ts';

const usage = 'Usage: npm run migrate:config-toml -- [--apply] <presets.json|subagent-routing.json>...\n'
  + 'Default: validate the conversion without writing. Apply creates new TOML files and retains the JSON sources.';

function validatePresets(source, document) {
  const { catalog, warnings } = validatePresetDocument(source, document);
  if (warnings.length > 0) throw new Error(warnings.join('\n'));
  return Object.fromEntries(catalog);
}

function plan(file) {
  const source = resolve(file);
  if (!['presets.json', 'subagent-routing.json'].includes(basename(source))) {
    throw new Error(`${source}: expected presets.json or subagent-routing.json`);
  }
  try {
    const legacy = JSON.parse(readFileSync(source, 'utf8'));
    const routing = basename(source) === 'subagent-routing.json';
    const expected = routing ? validateLegacyRoutingConfig(legacy) : {
      version: PRESET_CONFIG_VERSION,
      presets: validatePresets(source, { version: PRESET_CONFIG_VERSION, presets: legacy }),
    };
    const output = stringify(expected);
    const reparsed = parse(output);
    if (routing) {
      const actual = validateLegacyRoutingConfig(reparsed);
      assert.deepStrictEqual(actual, expected, 'TOML changed the configuration semantics');
      assertRoutingCandidateOrder(expected, actual);
    } else {
      assert.deepStrictEqual(validatePresets(source, reparsed), expected.presets, 'TOML changed the configuration semantics');
    }
    return { source, target: source.replace(/\.json$/, '.toml'), output };
  } catch (error) {
    throw new Error(`${source}: conversion failed (${error.message})`, { cause: error });
  }
}

function checkTarget(target) {
  try {
    lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${target}: already exists`);
}

function main() {
  const { values, positionals } = parseArgs({ options: {
    apply: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  }, allowPositionals: true });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (positionals.length === 0) throw new Error(usage);

  // Validate the full batch before writing any target. Exclusive creation also
  // protects a file that appears after preflight.
  const plans = [...new Set(positionals.map(file => resolve(file)))].map(plan);
  if (values.apply) {
    for (const { target } of plans) checkTarget(target);
  }
  for (const { source, target, output } of plans) {
    if (values.apply) writeFileSync(target, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(`${values.apply ? 'Converted' : 'Validated'} ${source} -> ${target}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
