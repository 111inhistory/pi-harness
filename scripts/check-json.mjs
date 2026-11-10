import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Self-check script for repository JSON assets:
 * - validates JSON syntax and object root semantics
 * - verifies critical prompts/ and config/ files
 */

const explicitFiles = [
  'package.json',
  'tsconfig.json',
];

const targetDirs = [
  'prompts',
  'config',
  'schemas',
];

async function collectJsonFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Fixtures intentionally include invalid JSON shapes (arrays, bad
        // frames); they are validated by the RPC schema check, not this one.
        if (entry.name !== 'fixtures') files.push(...await collectJsonFiles(full));
      } else if (entry.name.endsWith('.json')) {
        files.push(full);
      }
    }
    return files;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const args = process.argv.slice(2);
let filesToCheck = [];

if (args.length > 0) {
  filesToCheck = args;
} else {
  const dirFiles = (await Promise.all(targetDirs.map(collectJsonFiles))).flat();
  filesToCheck = [...explicitFiles, ...dirFiles].sort();
}

let passed = 0;
let failed = 0;
const errors = [];

for (const file of filesToCheck) {
  try {
    const content = await readFile(file, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Root value must be a non-null JSON object');
    }
    passed++;
  } catch (error) {
    failed++;
    errors.push({ file, message: error.message });
  }
}

if (failed > 0) {
  console.error(`JSON self-check failed: ${failed} error(s) found across ${filesToCheck.length} files:\n`);
  for (const err of errors) {
    console.error(`  - ${err.file}: ${err.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(`JSON self-check passed: verified ${passed} JSON file(s) successfully.`);
}
