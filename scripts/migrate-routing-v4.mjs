#!/usr/bin/env node
/**
 * Offline migration for Phase 2 classifier config:
 * moves `[classifier]` out of `<agentDir>/subagent-routing.toml` (v3 -> v4)
 * into `<agentDir>/harness.json` (`classifier.models`).
 *
 * Usage: npm run migrate:routing-v4 -- --agent-dir <dir> [--apply]
 */
import { parseArgs } from 'node:util';
import {
  applyRoutingV4Migration,
  MigrationApplyError,
  planRoutingV4Migration,
  rollbackCommandsFor,
} from './lib/routing-v4-migration.ts';

const usage = 'Usage: npm run migrate:routing-v4 -- --agent-dir <dir> [--apply]\n'
  + 'Default: dry-run plan. Apply writes .pre-routing-v4 backups before replacing files.\n'
  + 'Run only while Pi sessions are closed; two-file replacement is not an atomic transaction.';

function printSummary(plan, applied, backups) {
  if (plan.changes.length === 0) {
    console.log(`Unchanged: ${plan.agentDir} (already version 4 with classifier.models)`);
    return;
  }
  console.log(`${applied ? 'Migrated' : 'Planned'} ${plan.agentDir}`);
  for (const change of plan.changes) {
    const verb = change.before === undefined ? 'create' : 'update';
    console.log(`  - ${verb} ${change.path}`);
  }
  if (backups.length > 0) {
    console.log(`${applied ? 'Backups created' : 'Backups to create'}:`);
    for (const backup of backups) console.log(`  - ${backup}`);
  }
  console.log('Notes:');
  console.log('  - Two-file replacement is not an atomic transaction; run only while Pi is closed.');
  console.log('  - Restart Pi after applying so harness.json reloads; keep backups until v4 loads cleanly.');
  console.log('Rollback commands (preserve original backups):');
  for (const cmd of rollbackCommandsFor(plan.changes)) console.log(`  ${cmd}`);
}

function main() {
  const { values } = parseArgs({
    options: {
      'agent-dir': { type: 'string' },
      apply: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const agentDir = values['agent-dir'];
  if (typeof agentDir !== 'string' || agentDir.trim() === '') throw new Error(usage);

  const plan = planRoutingV4Migration(agentDir);
  if (values.apply !== true) {
    const plannedBackups = plan.changes.flatMap((c) => (c.backupPath === undefined ? [] : [c.backupPath]));
    printSummary(plan, false, plannedBackups);
    return;
  }
  const backups = applyRoutingV4Migration(plan);
  printSummary(plan, true, backups);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof MigrationApplyError && error.recoveryCommands.length > 0) {
    console.error('Recovery commands (preserve original backups):');
    for (const cmd of error.recoveryCommands) console.error(`  ${cmd}`);
  }
  process.exitCode = 1;
}
