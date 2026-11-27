import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'smol-toml';
import {
  applyRoutingV4Migration,
  assertRoutingCandidateOrder,
  BACKUP_SUFFIX,
  MigrationApplyError,
  planRoutingV4Migration,
  rollbackCommandsFor,
  shellQuote,
  validateLegacyRoutingConfig,
} from '../../scripts/lib/routing-v4-migration.ts';
import { loadHarnessConfig } from '../../src/harness-config.ts';
import { loadSubagentRoutingConfig } from '../../src/subagent/routing.ts';

const cliScript = fileURLToPath(new URL('../../scripts/migrate-routing-v4.mjs', import.meta.url));

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliScript, ...args], { encoding: 'utf8' });
}

const SAMPLE_V3_TOML = `version = 3

[classifier]
provider = "fake-provider"
id = "fake-classifier"

[instructions]
role = "Pick the role"
model = "Pick the model"

[[roles]]
id = "z-researcher"
instructions = """
第一行
第二行
"""

[roles.candidates]
named = "fast.v2 中文"

[roles.candidates."inline.v2"]
thinkingLevel = "high"

[[roles]]
id = "a-executor"
instructions = "Implement the change"

[roles.candidates]
named = "fast.v2 中文"
`;

test('validateLegacyRoutingConfig delegates v3 schema to production v4 validator', () => {
  const parsed = parse(SAMPLE_V3_TOML);
  const legacy = validateLegacyRoutingConfig(parsed);
  assert.equal(legacy.version, 3);
  assert.deepEqual(legacy.classifier, { provider: 'fake-provider', id: 'fake-classifier' });
  assert.deepEqual(legacy.roles.map((r) => r.id), ['z-researcher', 'a-executor']);
  assert.deepEqual(Object.keys(legacy.roles[0]!.candidates), ['named', 'inline.v2']);

  const reparsed = validateLegacyRoutingConfig(parse(stringify(legacy)));
  assert.deepEqual(reparsed, legacy);
  assertRoutingCandidateOrder(legacy, reparsed);

  assert.throws(() => validateLegacyRoutingConfig({ ...parsed, version: 4 }), /version 3/);
  assert.throws(() => validateLegacyRoutingConfig({ ...parsed, classifier: { provider: 'p', id: 'i', extra: true } }), /classifier/);
  assert.throws(() => validateLegacyRoutingConfig({ ...parsed, classifier: new Date() }), /classifier/);
  assert.throws(() => validateLegacyRoutingConfig({ ...parsed, unknownTop: true }), /unknown routing field/);
});

test('CLI migrates sparse harness.json + v3 routing, preserves unrelated fields, and rollback restores exact bytes', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'routing-v4-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent 'dir' 1");
  mkdirSync(agentDir, { recursive: true });

  const routingPath = path.join(agentDir, 'subagent-routing.toml');
  const harnessPath = path.join(agentDir, 'harness.json');
  const routingBackup = `${routingPath}${BACKUP_SUFFIX}`;
  const harnessBackup = `${harnessPath}${BACKUP_SUFFIX}`;
  const originalHarness = JSON.stringify({ subagent: { maxDepth: 1 }, shell: { preflight: false } }, null, 2) + '\n';
  writeFileSync(routingPath, SAMPLE_V3_TOML, { mode: 0o600 });
  writeFileSync(harnessPath, originalHarness, { mode: 0o600 });

  // Dry-run touches nothing.
  const dry = runCli('--agent-dir', agentDir);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Planned/);
  assert.equal(existsSync(routingBackup), false);
  assert.equal(existsSync(harnessBackup), false);
  assert.equal(readFileSync(routingPath, 'utf8'), SAMPLE_V3_TOML);
  assert.equal(readFileSync(harnessPath, 'utf8'), originalHarness);

  // Apply writes backups and updates both files.
  const applied = runCli('--agent-dir', agentDir, '--apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Migrated/);
  assert.equal(readFileSync(routingBackup, 'utf8'), SAMPLE_V3_TOML);
  assert.equal(readFileSync(harnessBackup, 'utf8'), originalHarness);

  // harness.json remains sparse and passes production loader.
  const rawNextHarness = JSON.parse(readFileSync(harnessPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(rawNextHarness).sort(), ['classifier', 'shell', 'subagent', 'version']);
  assert.equal(rawNextHarness.version, 1);
  assert.deepEqual(rawNextHarness.subagent, { maxDepth: 1 });
  assert.deepEqual(rawNextHarness.shell, { preflight: false });
  assert.deepEqual(
    loadHarnessConfig({ agentDir, cwd: agentDir, projectTrusted: false }).classifier.models,
    [{ provider: 'fake-provider', id: 'fake-classifier' }],
  );

  // subagent-routing.toml is v4 with role order, Unicode, dotted keys, and candidate order preserved.
  const liveRouting = loadSubagentRoutingConfig(routingPath);
  assert.equal(liveRouting.version, 4);
  assert.deepEqual(liveRouting.roles.map((r) => r.id), ['z-researcher', 'a-executor']);
  assert.equal(liveRouting.roles[0]!.instructions, '第一行\n第二行\n');
  assert.deepEqual(Object.keys(liveRouting.roles[0]!.candidates), ['named', 'inline.v2']);
  assert.deepEqual(liveRouting.roles[0]!.candidates['inline.v2'], { thinkingLevel: 'high' });

  // Re-running on v4 + non-empty classifier.models is an idempotent no-op.
  const rerun = runCli('--agent-dir', agentDir, '--apply');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /Unchanged/);

  // Rollback commands are shell-quoted and restore exact original bytes without deleting backups.
  const rollbackLines = applied.stdout.split('\n').filter((line) => line.trimStart().startsWith('cp -p -- '));
  assert.equal(rollbackLines.length, 2);
  assert.ok(rollbackLines.some((line) => line.includes(shellQuote(routingPath))));
  assert.ok(rollbackLines.some((line) => line.includes(shellQuote(harnessPath))));
  for (const cmd of rollbackLines) {
    const restored = spawnSync('sh', ['-c', cmd.trim()], { encoding: 'utf8' });
    assert.equal(restored.status, 0, restored.stderr);
  }
  assert.equal(readFileSync(routingPath, 'utf8'), SAMPLE_V3_TOML);
  assert.equal(readFileSync(harnessPath, 'utf8'), originalHarness);
  assert.equal(existsSync(routingBackup), true);
  assert.equal(existsSync(harnessBackup), true);
});

test('creates minimal harness.json when absent, accepts empty models, and skips exact match', (t) => {
  const mk = (tag: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), `routing-v4-${tag}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  // Absent harness.json -> create minimal file + backup only routing
  {
    const dir = mk('new');
    const routing = path.join(dir, 'subagent-routing.toml');
    const harness = path.join(dir, 'harness.json');
    writeFileSync(routing, SAMPLE_V3_TOML);
    const plan = planRoutingV4Migration(dir);
    assert.equal(plan.changes.length, 2);
    assert.equal(plan.changes[0]!.path, harness);
    assert.equal(plan.changes[0]!.before, undefined);
    assert.equal(plan.changes[1]!.path, routing);
    const backups = applyRoutingV4Migration(plan);
    assert.deepEqual(backups, [`${routing}${BACKUP_SUFFIX}`]);
    assert.equal(existsSync(`${harness}${BACKUP_SUFFIX}`), false);
    assert.deepEqual(JSON.parse(readFileSync(harness, 'utf8')), {
      version: 1,
      classifier: { models: [{ provider: 'fake-provider', id: 'fake-classifier' }] },
    });
    assert.ok(rollbackCommandsFor(plan.changes).some((cmd) => cmd === `rm -- ${shellQuote(harness)}`));
  }

  // Empty classifier.models -> update cleanly
  {
    const dir = mk('empty');
    writeFileSync(path.join(dir, 'subagent-routing.toml'), SAMPLE_V3_TOML);
    writeFileSync(path.join(dir, 'harness.json'), JSON.stringify({ classifier: { models: [] } }));
    applyRoutingV4Migration(planRoutingV4Migration(dir));
    assert.deepEqual(
      loadHarnessConfig({ agentDir: dir, cwd: dir, projectTrusted: false }).classifier.models,
      [{ provider: 'fake-provider', id: 'fake-classifier' }],
    );
  }

  // Exact single-entry match -> skip harness.json and leave any prior harness backup untouched
  {
    const dir = mk('match');
    const routing = path.join(dir, 'subagent-routing.toml');
    const harness = path.join(dir, 'harness.json');
    const harnessBackup = `${harness}${BACKUP_SUFFIX}`;
    const existing = JSON.stringify({ classifier: { models: [{ provider: 'fake-provider', id: 'fake-classifier' }] } });
    writeFileSync(routing, SAMPLE_V3_TOML);
    writeFileSync(harness, existing);
    writeFileSync(harnessBackup, '{"prior":true}');
    const plan = planRoutingV4Migration(dir);
    assert.deepEqual(plan.changes.map((c) => c.path), [routing]);
    const backups = applyRoutingV4Migration(plan);
    assert.deepEqual(backups, [`${routing}${BACKUP_SUFFIX}`]);
    assert.equal(readFileSync(harness, 'utf8'), existing);
    assert.equal(readFileSync(harnessBackup, 'utf8'), '{"prior":true}');
    assert.equal(loadSubagentRoutingConfig(routing).version, 4);
  }
});

test('conflicts, invalid configs, mixed candidate reorder, backups, symlinks, and drift refuse with zero writes', (t) => {
  const mk = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'routing-v4-refuse-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  // Different model conflict
  {
    const dir = mk();
    writeFileSync(path.join(dir, 'subagent-routing.toml'), SAMPLE_V3_TOML);
    writeFileSync(path.join(dir, 'harness.json'), JSON.stringify({
      classifier: { models: [{ provider: 'other-provider', id: 'other-model' }] },
    }));
    assert.throws(() => planRoutingV4Migration(dir), /conflict/);
  }

  // Multi-model list conflict even when first entry matches
  {
    const dir = mk();
    writeFileSync(path.join(dir, 'subagent-routing.toml'), SAMPLE_V3_TOML);
    writeFileSync(path.join(dir, 'harness.json'), JSON.stringify({
      classifier: {
        models: [
          { provider: 'fake-provider', id: 'fake-classifier' },
          { provider: 'backup-provider', id: 'backup-classifier' },
        ],
      },
    }));
    assert.throws(() => planRoutingV4Migration(dir), /conflict/);
  }

  // Already v4 routing with missing harness.json
  {
    const dir = mk();
    const v4Toml = SAMPLE_V3_TOML.replace('version = 3', 'version = 4').replace(/\[classifier\][\s\S]*?\n\n/, '');
    writeFileSync(path.join(dir, 'subagent-routing.toml'), v4Toml);
    assert.throws(() => planRoutingV4Migration(dir), /no classifier\.models/);
  }

  // Invalid harness.json schema
  {
    const dir = mk();
    writeFileSync(path.join(dir, 'subagent-routing.toml'), SAMPLE_V3_TOML);
    writeFileSync(path.join(dir, 'harness.json'), JSON.stringify({ unknownField: true }));
    assert.throws(() => planRoutingV4Migration(dir), /unknown/);
  }

  // Mixed inline-before-named candidates that smol-toml would silently reorder
  {
    const dir = mk();
    writeFileSync(path.join(dir, 'subagent-routing.toml'), `version = 3

[classifier]
provider = "fake-provider"
id = "fake-classifier"

[instructions]
role = "Pick role"
model = "Pick model"

[[roles]]
id = "reviewer"
instructions = "Review"

[roles.candidates]
inlineFirst = { thinkingLevel = "high" }
namedSecond = "fast"
`);
    assert.throws(() => planRoutingV4Migration(dir), /candidate order would change/);
  }

  // Prior backup is never overwritten
  {
    const dir = mk();
    const backup = path.join(dir, `subagent-routing.toml${BACKUP_SUFFIX}`);
    writeFileSync(path.join(dir, 'subagent-routing.toml'), SAMPLE_V3_TOML);
    writeFileSync(backup, 'keep-original-backup');
    assert.throws(() => planRoutingV4Migration(dir), /backup already exists/);
    assert.equal(readFileSync(backup, 'utf8'), 'keep-original-backup');
  }

  // Symlink refused
  {
    const dir = mk();
    const realFile = path.join(dir, 'real-routing.toml');
    writeFileSync(realFile, SAMPLE_V3_TOML);
    symlinkSync(realFile, path.join(dir, 'subagent-routing.toml'));
    assert.throws(() => planRoutingV4Migration(dir), /symbolic link/);
  }

  // Drift between plan and apply refused with zero backups created
  {
    const dir = mk();
    const routingPath = path.join(dir, 'subagent-routing.toml');
    writeFileSync(routingPath, SAMPLE_V3_TOML);
    const plan = planRoutingV4Migration(dir);
    writeFileSync(routingPath, SAMPLE_V3_TOML + '\n# drifted\n');
    assert.throws(() => applyRoutingV4Migration(plan), /modified after preflight/);
    assert.equal(existsSync(`${routingPath}${BACKUP_SUFFIX}`), false);
  }
});

test('partial failure after harness.json commit supports backup-preserving resume and rollback', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'routing-v4-partial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const routingPath = path.join(dir, 'subagent-routing.toml');
  const harnessPath = path.join(dir, 'harness.json');
  const routingBackup = `${routingPath}${BACKUP_SUFFIX}`;
  const harnessBackup = `${harnessPath}${BACKUP_SUFFIX}`;
  const originalHarness = JSON.stringify({ btw: { panelMinRows: 5 } }, null, 2) + '\n';
  writeFileSync(routingPath, SAMPLE_V3_TOML);
  writeFileSync(harnessPath, originalHarness);

  const plan = planRoutingV4Migration(dir);
  let caught: unknown;
  try {
    applyRoutingV4Migration(plan, {
      rename(oldPath, newPath) {
        if (newPath === routingPath) throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
        renameSync(oldPath, newPath);
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof MigrationApplyError);
  assert.deepEqual(caught.committed, [harnessPath]);
  assert.deepEqual(caught.backups, [harnessBackup, routingBackup]);
  assert.ok(caught.recoveryCommands.every((cmd) => !/rm\b.*pre-routing-v4/.test(cmd)));
  // Resume command refuses to overwrite an existing archive target.
  const resumeCmd = caught.recoveryCommands.find((cmd) => cmd.includes('mv -- '));
  assert.ok(resumeCmd !== undefined);
  const archiveMatch = resumeCmd.match(/test ! -e ('[^']*')/);
  assert.ok(archiveMatch !== null);
  const archivePath = archiveMatch[1]!.slice(1, -1);
  writeFileSync(archivePath, 'pre-existing-archive');
  const blocked = spawnSync('sh', ['-c', resumeCmd], { encoding: 'utf8' });
  assert.notEqual(blocked.status, 0);
  assert.equal(readFileSync(archivePath, 'utf8'), 'pre-existing-archive');
  assert.equal(readFileSync(routingBackup, 'utf8'), SAMPLE_V3_TOML);
  rmSync(archivePath);
  assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  assert.equal(readFileSync(routingPath, 'utf8'), SAMPLE_V3_TOML);
  assert.deepEqual(
    loadHarnessConfig({ agentDir: dir, cwd: dir, projectTrusted: false }).classifier.models,
    [{ provider: 'fake-provider', id: 'fake-classifier' }],
  );

  // Resume by moving byte-identical routing backup aside; harnessBackup stays untouched.
  const archived = `${routingBackup}.attempt-1`;
  renameSync(routingBackup, archived);
  const resumePlan = planRoutingV4Migration(dir);
  assert.deepEqual(resumePlan.changes.map((c) => c.path), [routingPath]);
  applyRoutingV4Migration(resumePlan);
  assert.equal(readFileSync(harnessBackup, 'utf8'), originalHarness);
  assert.equal(readFileSync(archived, 'utf8'), SAMPLE_V3_TOML);
  assert.equal(loadSubagentRoutingConfig(routingPath).version, 4);

  // Rollback from preserved original backups restores exact originals.
  writeFileSync(routingPath, readFileSync(archived));
  writeFileSync(harnessPath, readFileSync(harnessBackup));
  assert.equal(readFileSync(routingPath, 'utf8'), SAMPLE_V3_TOML);
  assert.equal(readFileSync(harnessPath, 'utf8'), originalHarness);
});

test('creating new harness.json preserves EEXIST competitor but removes our own partial write fragment', (t) => {
  // EEXIST competitor
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'routing-v4-eexist-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const routingPath = path.join(dir, 'subagent-routing.toml');
    const harnessPath = path.join(dir, 'harness.json');
    writeFileSync(routingPath, SAMPLE_V3_TOML);
    const plan = planRoutingV4Migration(dir);
    const competitor = '{"subagent":{"maxDepth":1}}';

    assert.throws(() => applyRoutingV4Migration(plan, {
      openCreate(filePath, flags, mode) {
        if (filePath === harnessPath) writeFileSync(harnessPath, competitor);
        return openSync(filePath, flags, mode);
      },
    }), (error) => {
      assert.ok(error instanceof MigrationApplyError);
      assert.deepEqual(error.committed, []);
      return true;
    });
    assert.equal(readFileSync(harnessPath, 'utf8'), competitor);
    assert.equal(readFileSync(routingPath, 'utf8'), SAMPLE_V3_TOML);
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  }

  // Partial fragment created by us
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'routing-v4-fragment-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const routingPath = path.join(dir, 'subagent-routing.toml');
    const harnessPath = path.join(dir, 'harness.json');
    writeFileSync(routingPath, SAMPLE_V3_TOML);
    const plan = planRoutingV4Migration(dir);

    assert.throws(() => applyRoutingV4Migration(plan, {
      writeCreate(fd, data) {
        writeFileSync(fd, data.subarray(0, 8));
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    }), (error) => {
      assert.ok(error instanceof MigrationApplyError);
      assert.deepEqual(error.committed, []);
      return true;
    });
    assert.equal(existsSync(harnessPath), false);
    assert.equal(readFileSync(routingPath, 'utf8'), SAMPLE_V3_TOML);
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  }
});
