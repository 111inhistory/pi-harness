#!/usr/bin/env node
/**
 * Offline v1 -> v2 `preset-state` conversion for one closed session file.
 *
 * Default is a read-only plan. `--apply` additionally requires `--offline`: the
 * tool writes a byte-exact `.pre-preset-v2` backup next to the session, stages
 * the converted file, verifies both byte streams and then renames the staged
 * file over the session. Original entry IDs and timestamps stay identical.
 * Where v2 would change the old branch's base membership, the converter
 * inserts a standard capability-tool-base entry and reattaches direct children.
 *
 * The tool never reads `presets.json`, so a preset that was renamed or deleted
 * still converts losslessly. It refuses files that mix v1 and v2 records, and it
 * refuses to apply while a managed session record names a live process for the
 * same session. Close Pi for that session first, and keep the backup until the
 * migrated session loads correctly.
 *
 * Usage: node --import tsx scripts/migrate-preset-state-v2.mjs --session FILE
 *        node --import tsx scripts/migrate-preset-state-v2.mjs --session FILE --apply --offline [--socket-root DIR]
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { applyPresetMigration, knownLiveSession, planPresetMigration } from './lib/preset-state-v2-migration.ts';

const OFFLINE_ENV = 'PI_SESSION_FILE';
const SOCKET_ENV = 'PI_AGENT_SOCKET';

function usage() {
  return 'Usage: node --import tsx scripts/migrate-preset-state-v2.mjs --session FILE [--apply --offline] [--socket-root DIR]\n'
    + '       Default: read-only plan. Apply requires explicit --offline and writes a byte-exact .pre-preset-v2 backup.\n'
    + '       --socket-root enables the known-live managed-session record check.';
}

function main() {
  const { values } = parseArgs({ options: {
    session: { type: 'string' },
    'socket-root': { type: 'string' },
    apply: { type: 'boolean' },
    offline: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { process.stdout.write(`${usage()}\n`); return 0; }
  if (values.session === undefined) throw new Error(usage());
  const target = resolve(values.session);
  if (values.apply === true && values.offline !== true) {
    throw new Error('--apply requires explicit --offline; refusing to migrate');
  }
  if (values.apply === true && process.env[OFFLINE_ENV] !== undefined
    && process.env[SOCKET_ENV] !== undefined && resolve(process.env[OFFLINE_ENV]) === target) {
    throw new Error(`refusing --apply while ${OFFLINE_ENV} and ${SOCKET_ENV} name this live agent; close Pi, unset them, and run a normal offline terminal`);
  }
  const socketRoot = values['socket-root'] === undefined ? undefined : resolve(values['socket-root']);
  const plan = planPresetMigration(target);
  if (values.apply !== true) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }
  const live = knownLiveSession(plan.sessionId, socketRoot);
  if (live !== null) {
    process.stdout.write(`${JSON.stringify({
      mode: 'report',
      status: 'refused',
      reason: 'known-live-managed-session',
      file: target,
      pid: live.pid,
      record: live.record,
      detail: 'the managed session record names a live process; close it before migrating',
      changed: false,
      backup: null,
      restoreCommand: null,
      warnings: plan.warnings,
      runtimeValidated: false,
    }, null, 2)}\n`);
    return 1;
  }
  const report = applyPresetMigration(target, plan);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  const detail = { status: 'error', message: error instanceof Error ? error.message : String(error) };
  const backup = error?.backup;
  if (typeof backup === 'string') detail.backup = backup;
  console.error(JSON.stringify(detail));
  process.exitCode = 1;
}
