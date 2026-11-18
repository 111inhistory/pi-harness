import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { foldEvents } from '../src/subagent/storage.ts';
import { createSubagentRuntime } from '../src/subagent/runtime.ts';

const SCRIPT = new URL('../scripts/migrate-subagent-storage-v3.mjs', import.meta.url).pathname;
const ROOT = 'root0001';
const ORIGIN = { message: 'synthetic' };

function start() {
  const agentDir = join(tmpdir(), `v3-migrate-${randomUUID()}`);
  const sessions = join(agentDir, 'sessions', 'p');
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  return { agentDir, sessions };
}

function rootFile(sessions) {
  const file = join(sessions, 'root.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: ROOT, timestamp: 'header', cwd: '/tmp/project' })}\n`);
  return file;
}

function append(file, value) { writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'a' }); }

function job(id, parentId, agentId, index, spec, extra = {}) {
  return {
    type: 'custom', customType: 'subagent-job', id, parentId, timestamp: `2026-01-01T00:00:0${id.slice(-1)}.000Z`,
    data: {
      v: 2, jobId: agentId, agentId, index, createdBy: 'Main', continuedFromJobId: extra.continuedFromJobId ?? null,
      actor: { name: null, parentAgentId: null, depth: 1 }, spec, origin: ORIGIN,
    },
  };
}

function continuation(id, parentId, oldJob, continuedFromJobId, name = null) {
  return {
    type: 'custom', customType: 'subagent-job', id, parentId, timestamp: `2026-01-01T00:00:0${id.slice(-1)}.000Z`,
    data: { v: 2, jobId: `${oldJob}#r2`, agentId: oldJob, index: null, createdBy: 'Main',
      continuedFromJobId, spec: { kind: 'continuation', name }, origin: ORIGIN },
  };
}

function fixture() {
  const { agentDir, sessions } = start();
  const file = rootFile(sessions);
  append(file, job('e1', null, 'sub_01', 0, { task: 'single goal', context: null, inheritContext: false, inheritedContext: null }));
  append(file, continuation('e2', 'e1', 'sub_01', 'sub_01'));
  append(file, job('e3', null, 'sub_02', 0, { task: 'multi one', context: null, inheritContext: false, inheritedContext: null }));
  append(file, job('e4', 'e3', 'sub_03', 1, { task: 'multi two', context: null, inheritContext: false, inheritedContext: null }));
  // Deliberately irregular whitespace and a non-harness branch: both must stay byte-identical.
  // Span several input chunks while keeping the opaque entry and CRLF exact.
  writeFileSync(file, ' '.repeat(192 * 1024) + '{"type":"custom","customType":"opaque","id":"opaque","parentId":null,  "data": {"raw" : true}}\r\n', { flag: 'a' });
  const childDir = join(agentDir, 'subagent-sessions', ROOT);
  mkdirSync(childDir, { recursive: true, mode: 0o700 });
  const child = join(childDir, 'sub_1.jsonl');
  writeFileSync(child, '{"type":"session","version":3,"id":"child"}\n{}\n');
  return { agentDir, sessions, file, child };
}

function run(args, env = {}) {
  const clean = { ...process.env };
  delete clean.PI_SESSION_FILE;
  delete clean.PI_AGENT_SOCKET;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...clean, ...env } });
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

function parseLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

function applied(args, env = {}) {
  const result = run(args, env);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('default plan and apply migrate a multi/continuation root with an exact backup and canonical fold', async () => {
  const { agentDir, file, child } = fixture();
  try {
    const original = readFileSync(file);
    const childHash = hash(readFileSync(child));
    const planned = run(['--session', file, '--agent-dir', agentDir]);
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout);
    assert.equal(plan.roots[0].class, 'plan-v2');
    assert.equal(readFileSync(file).equals(original), true);
    assert.equal(readdirSync(join(file, '..')).some((name) => name.endsWith('.pre-v3')), false);

    const missingOffline = run(['--session', file, '--agent-dir', agentDir, '--apply']);
    assert.equal(missingOffline.status, 1);
    assert.equal(readFileSync(file).equals(original), true);

    const report = applied(['--session', file, '--agent-dir', agentDir, '--apply', '--offline']);
    assert.equal(report.status, 'applied');
    assert.equal(report.childTouched, false);
    assert.equal(report.sourceHash, hash(original));
    assert.equal(report.backupHash, hash(original));
    assert.equal(report.targetHash, hash(readFileSync(file)));
    assert.match(report.backup, /\.pre-v3$/);
    assert.equal(readFileSync(report.backup).equals(original), true);
    assert.equal(hash(readFileSync(report.backup)), hash(original));
    assert.equal(statSync(report.backup).mode & 0o777, 0o400);
    assert.equal(report.capabilityReferencesReconciled, false);
    assert.equal(report.runtimeValidated, false);
    assert.ok(report.warnings.some((line) => line.includes('reactivate')));
    assert.equal(hash(readFileSync(child)), childHash);
    assert.ok(report.restoreCommand.includes(report.backup));

    const after = parseLines(file);
    const sourceById = new Map(parseLines(report.backup).map((entry) => [entry.id, entry]));
    for (const entry of after) {
      const before = sourceById.get(entry.id);
      assert.equal(entry.parentId, before.parentId);
      assert.equal(entry.timestamp, before.timestamp);
      if (entry.id === 'e1' || entry.id === 'e2' || entry.id === 'e3' || entry.id === 'e4') {
        assert.equal(entry.data.v, 3);
        assert.notDeepEqual(entry.data, before.data);
      } else {
        assert.deepEqual(entry, before);
      }
    }
    assert.equal(readFileSync(file, 'utf8').includes('"customType":"opaque","id":"opaque","parentId":null,  "data": {"raw" : true}}\r\n'), true);
    assert.equal(readFileSync(file, 'utf8').includes(' '.repeat(192 * 1024) + '{"type":"custom","customType":"opaque"'), true);

    const entries = after.filter((entry) => entry.type !== 'session');
    const children = new Map();
    for (const entry of entries) {
      if (entry.parentId === null) continue;
      const list = children.get(entry.parentId) ?? [];
      list.push(entry.id);
      children.set(entry.parentId, list);
    }
    const leaves = entries.filter((entry) => !(children.get(entry.id)?.length));
    const folded = new Map();
    for (const leaf of leaves) {
      const path = [];
      let cursor = leaf.id;
      while (cursor !== null && cursor !== undefined) {
        const entry = entries.find((item) => item.id === cursor);
        if (entry === undefined) break;
        path.unshift(entry);
        cursor = entry.parentId;
      }
      const state = foldEvents(path);
      folded.set(leaf.id, state);
    }
    assert.deepEqual([...folded.keys()].sort(), ['e2', 'e4', 'opaque']);
    assert.deepEqual(folded.get('e2').actors.map((actor) => actor.agentId), ['sub_1']);
    assert.deepEqual(folded.get('e2').jobs.map((job) => job.jobId), ['sub_1', 'sub_1#r2']);
    assert.deepEqual(folded.get('e4').actors.map((actor) => actor.agentId), ['sub_2-1', 'sub_2-2']);
    const runtime = createSubagentRuntime({
      session: 'bbbbbbbb', startJob: () => ({ done: new Promise(() => {}), cancel() {} }), deliverMessage: async () => ({ accepted: true }),
    });
    runtime.restoreState(folded.get('e4'));

    const migrated = readFileSync(file);
    const again = applied(['--session', file, '--agent-dir', agentDir, '--apply', '--offline']);
    assert.equal(again.status, 'already-v3');
    assert.equal(again.changed, false);
    assert.equal(readFileSync(file).equals(migrated), true);
    assert.equal(readdirSync(join(file, '..')).filter((name) => name.endsWith('.pre-v3')).length, 1);
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test('known-live managed record and live agent environment refuse apply without changes', () => {
  const { agentDir, file } = fixture();
  try {
    const original = readFileSync(file);
    const uid = createHash('sha256').update(ROOT).digest('hex').slice(0, 8);
    const records = join(agentDir, 'sockets', 'sessions');
    mkdirSync(records, { recursive: true });
    writeFileSync(join(records, `${uid}.json`), JSON.stringify({
      version: 1, sessionId: ROOT, uid, socketDir: join(agentDir, 'sockets', uid),
      pid: process.pid, cwd: '/tmp/project', name: null, startedAt: Date.now(),
    }));
    const refused = run(['--session', file, '--agent-dir', agentDir, '--socket-root', join(agentDir, 'sockets'), '--apply', '--offline']);
    assert.equal(refused.status, 1);
    const report = JSON.parse(refused.stdout);
    assert.equal(report.status, 'refused');
    assert.equal(report.reason, 'known-live-managed-session');
    assert.equal(readFileSync(file).equals(original), true);
    assert.equal(readdirSync(join(file, '..')).some((name) => name.endsWith('.pre-v3')), false);

    const liveEnv = run(['--session', file, '--agent-dir', agentDir, '--apply', '--offline'], {
      PI_SESSION_FILE: file, PI_AGENT_SOCKET: '/tmp/fake.sock',
    });
    assert.equal(liveEnv.status, 1);
    assert.equal(readFileSync(file).equals(original), true);
    assert.equal(readdirSync(join(file, '..')).some((name) => name.endsWith('.pre-v3')), false);
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test('excluded malformed roots are reported and never written', () => {
  const { agentDir, sessions } = start();
  try {
    const file = join(sessions, 'bad.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: 'badroot', timestamp: 'header', cwd: '/tmp/project' })}\n${JSON.stringify(job('b1', null, 'sub_01', 0, { task: 'bad', context: null, inheritContext: false, inheritedContext: null }))}\nnot json\n`);
    const original = readFileSync(file);
    const result = run(['--session', file, '--agent-dir', agentDir, '--apply', '--offline']);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'refused');
    assert.equal(report.reason, 'excluded-malformed');
    assert.equal(report.changed, false);
    assert.equal(readFileSync(file).equals(original), true);
    assert.equal(readdirSync(join(file, '..')).some((name) => name.endsWith('.pre-v3')), false);
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test('symlink target is refused before backup creation', () => {
  const { agentDir, sessions, file } = fixture();
  try {
    const link = join(sessions, 'link.jsonl');
    symlinkSync(file, link);
    const before = hash(readFileSync(file));
    const result = run(['--session', link, '--agent-dir', agentDir, '--apply', '--offline']);
    assert.equal(result.status, 1);
    assert.equal(hash(readFileSync(file)), before);
    assert.equal(readdirSync(join(file, '..')).some((name) => name.endsWith('.pre-v3')), false);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});
