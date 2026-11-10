#!/usr/bin/env node
/**
 * Explicit, offline migration of retired permission records.
 *
 * The runtime consumes only canonical `capability-tool-permission` records and
 * the normalized config defaults; it never scans legacy formats at session
 * start or on a turn. This tool is the one explicit conversion step: run it on
 * a session file while the session is closed, and it appends canonical `set`
 * entries plus the migration marker before the runtime opens the file.
 *
 * Usage:
 *   npm run migrate:tool-permissions -- <session.jsonl> [<session.jsonl> ...]
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { SessionManager } from '@earendil-works/pi-coding-agent';

import { migrateLegacyPermissions } from './lib/permission-migration.ts';

const files = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
if (files.length === 0) {
  console.error('Usage: npm run migrate:tool-permissions -- <session.jsonl> [<session.jsonl> ...]');
  process.exit(2);
}

let failed = false;
for (const raw of files) {
  const file = resolve(raw);
  if (!existsSync(file)) {
    console.error(`missing: ${file}`);
    failed = true;
    continue;
  }
  const manager = SessionManager.open(file);
  const changed = migrateLegacyPermissions(
    { appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); } },
    manager.getBranch(),
  );
  console.log(`${changed ? 'migrated' : 'skipped (already migrated)'} ${file}`);
}

if (failed) process.exit(1);
