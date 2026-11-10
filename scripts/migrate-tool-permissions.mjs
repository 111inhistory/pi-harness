#!/usr/bin/env node
/**
 * Convert closed v3 sessions containing flat manual-only discovery records.
 * Back up files first; no live session may own a writer. Native checkpoint IDs
 * and unrelated bytes are preserved. Mixed discovery, group hits, blacklist
 * records and files combining legacy with canonical rules are refused.
 *
 * Usage: npm run migrate:tool-permissions -- <session.jsonl> [<session.jsonl> ...]
 */
import { resolve } from 'node:path';
import { migrateSessionFile } from './lib/permission-migration.ts';

const files = process.argv.slice(2).filter(argument => argument !== '--');
if (files.length === 0) {
  console.error('Usage: npm run migrate:tool-permissions -- <session.jsonl> [<session.jsonl> ...]');
  process.exit(2);
}
let failed = false;
for (const raw of files) {
  const file = resolve(raw);
  try {
    console.log(`${migrateSessionFile(file) ? 'migrated' : 'unchanged'} ${file}`);
  } catch (error) {
    failed = true;
    console.error(`failed: ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed) process.exitCode = 1;
