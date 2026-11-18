#!/usr/bin/env node
/**
 * Offline v2 -> v3 Subagent root migration.
 *
 * Default is a read-only plan. --apply regenerates a fresh plan through the
 * standalone planner, backs up the selected root in place, transforms only the
 * planned harness-event `data` fields, verifies the source/backup/target shape,
 * and atomically renames a staged file. It never touches child session bodies,
 * Capability records, other roots, or configuration. Node built-ins only.
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chmod, lstat, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const PLANNER = new URL('./plan-subagent-storage-v3.mjs', import.meta.url);
const OFFLINE_ENV = 'PI_SESSION_FILE';
const SOCKET_ENV = 'PI_AGENT_SOCKET';
const CAPABILITY_WARNINGS = [
  'Capability tool references are not reconciled by this migration; persisted Capability collections may still name subagent_stop.',
  'After loading the migrated root, explicitly reactivate the subagent tool namespace; inherited child Capability state needs later assessment.',
];

function usage() {
  return 'Usage: node scripts/migrate-subagent-storage-v3.mjs --session FILE --agent-dir DIR [--apply --offline] [--socket-root DIR]\n' +
    '       Default: read-only plan. Apply requires explicit --offline and never migrates other roots.\n' +
    '       --socket-root enables the known-live managed-session record check.';
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function restoreCommand(backup, target) {
  return `cp -- ${quote(backup)} ${quote(target)}`;
}

function sameStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deriveSessionUid(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
}

/** Read only the one managed record that names this root; never alter it. */
async function knownLive({ socketRoot, headerId }) {
  if (socketRoot === undefined || typeof headerId !== 'string' || headerId === '') return null;
  const uid = deriveSessionUid(headerId);
  const file = join(resolve(socketRoot), 'sessions', `${uid}.json`);
  let record;
  try { record = JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
  if (!plain(record) || record.sessionId !== headerId) return null;
  if (!Number.isInteger(record.pid) || record.pid <= 0) return null;
  try {
    process.kill(record.pid, 0);
    return { pid: record.pid, record: file };
  } catch (error) {
    if (error?.code === 'EPERM') return { pid: record.pid, record: file };
    return null;
  }
}

function freshPlan({ session, agentDir }) {
  const child = spawnSync(process.execPath, [PLANNER.pathname, '--session', session, '--agent-dir', agentDir], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr || 'planner failed');
  const plan = JSON.parse(child.stdout);
  if (!plain(plan) || plan.mode !== 'plan' || !Array.isArray(plan.roots)) throw new Error('planner returned an invalid plan');
  return plan;
}

/** Patch only the top-level `data` JSON value, preserving every other byte. */
function patchDataField(raw, value) {
  let i = raw.indexOf('{');
  if (i === -1) throw new Error('entry is not a JSON object');
  i += 1;
  const whitespace = () => { while (/\s/.test(raw[i] ?? '')) i += 1; };
  const stringEnd = () => {
    i += 1;
    while (i < raw.length) {
      if (raw[i] === '\\') i += 2;
      else if (raw[i++] === '"') return;
    }
  };
  let replacement;
  while (i < raw.length) {
    whitespace();
    if (raw[i] === '}') break;
    const keyStart = i;
    if (raw[i] !== '"') throw new Error('entry has a non-string key');
    stringEnd();
    const key = JSON.parse(raw.slice(keyStart, i));
    whitespace();
    if (raw[i] !== ':') throw new Error('entry has a malformed key/value separator');
    i += 1;
    whitespace();
    const valueStart = i;
    let depth = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '"') { stringEnd(); continue; }
      if (depth === 0 && (c === ',' || c === '}')) break;
      if (c === '{' || c === '[') depth += 1;
      else if (c === '}' || c === ']') depth -= 1;
      i += 1;
    }
    let valueEnd = i;
    while (valueEnd > valueStart && /\s/.test(raw[valueEnd - 1] ?? '')) valueEnd -= 1;
    if (key === 'data') {
      if (replacement !== undefined) throw new Error('entry has more than one data field');
      replacement = { start: valueStart, end: valueEnd, text: JSON.stringify(value) };
    }
    if (raw[i] === ',') i += 1;
  }
  if (replacement === undefined) throw new Error('entry has no data field');
  return raw.slice(0, replacement.start) + replacement.text + raw.slice(replacement.end);
}

/** Preserve raw bytes and line terminators; only target lines are parsed. */
async function* rawLines(file, hash) {
  let parts = [];
  let length = 0;
  for await (const chunk of createReadStream(file)) {
    hash?.update(chunk);
    let start = 0;
    while (true) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) break;
      const piece = chunk.subarray(start, newline + 1);
      if (parts.length === 0) yield piece;
      else {
        parts.push(piece);
        length += piece.length;
        yield Buffer.concat(parts, length);
        parts = [];
        length = 0;
      }
      start = newline + 1;
    }
    if (start < chunk.length) {
      const tail = chunk.subarray(start);
      parts.push(tail);
      length += tail.length;
    }
  }
  if (length > 0) yield parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) throw new Error('file write made no progress');
    offset += bytesWritten;
  }
}

function lineParts(raw) {
  if (raw.length >= 2 && raw[raw.length - 2] === 0x0d && raw[raw.length - 1] === 0x0a) {
    return { body: raw.subarray(0, raw.length - 2), ending: Buffer.from('\r\n') };
  }
  if (raw.length >= 1 && raw[raw.length - 1] === 0x0a) {
    return { body: raw.subarray(0, raw.length - 1), ending: Buffer.from('\n') };
  }
  return { body: raw, ending: Buffer.alloc(0) };
}

async function applyPlan({ plan, target, socketRoot }) {
  const root = plan.roots[0];
  if (root === undefined || resolve(root.file) !== target) throw new Error('planner did not select exactly the requested root');
  const before = await lstat(target);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('target must be a regular, non-symlink file');
  if (Array.isArray(root.parseErrors) && root.parseErrors.length > 0) {
    return {
      status: 'refused', changed: false, source: target, backup: null, restoreCommand: null,
      reason: 'excluded-malformed', diagnostics: root.parseErrors,
      capabilityReferencesReconciled: false, runtimeValidated: false, warnings: CAPABILITY_WARNINGS,
    };
  }
  if (root.class === 'current-v3') {
    return { status: 'already-v3', changed: false, source: target, backup: null, restoreCommand: null, capabilityReferencesReconciled: false, runtimeValidated: false, warnings: CAPABILITY_WARNINGS };
  }
  if (root.class === 'unchanged') {
    return { status: 'unchanged', changed: false, source: target, backup: null, restoreCommand: null, capabilityReferencesReconciled: false, runtimeValidated: false, warnings: CAPABILITY_WARNINGS };
  }
  if (root.class !== 'plan-v2' || root.planReady !== true || plan.planReady !== true) {
    return {
      status: 'refused', changed: false, source: target, backup: null, restoreCommand: null,
      reason: root.class, diagnostics: root.diagnostics ?? [], capabilityReferencesReconciled: false, runtimeValidated: false, warnings: CAPABILITY_WARNINGS,
    };
  }
  const live = await knownLive({ socketRoot, headerId: root.branch?.headerId });
  if (live !== null) {
    return {
      status: 'refused', changed: false, source: target, backup: null, restoreCommand: null,
      reason: 'known-live-managed-session', pid: live.pid, record: live.record,
      diagnostics: ['the managed session record names a live process; close it or choose an offline root'],
      capabilityReferencesReconciled: false, runtimeValidated: false, warnings: CAPABILITY_WARNINGS,
    };
  }
  const converted = new Map(root.convertedEvents.map((event) => [event.entryId, event]));
  if (converted.size === 0 || converted.size !== root.convertedEvents.length) throw new Error('plan has no unique converted events');
  for (const event of root.convertedEvents) {
    if (!plain(event.data) || event.data.v !== 3 || typeof event.entryId !== 'string') throw new Error('plan contains a non-v3 converted event');
  }

  const planned = root.source.before;
  if (!sameStat(before, planned)) throw new Error('target changed since the fresh plan; refusing stale source');
  const sourceHash = root.source.hash;

  const backup = join(dirname(target), `${basename(target)}.${randomUUID()}.pre-v3`);
  let backupHandle;
  let tempDir;
  let tempHandle;
  let backupVerified = false;
  let committed = false;
  try {
    backupHandle = await open(backup, 'wx', 0o600);
    tempDir = await mkdtemp(join(dirname(target), `.v3-migrate-${basename(target)}-`));
    tempHandle = await open(join(tempDir, 'root.jsonl'), 'wx', 0o600);
    const readHash = createHash('sha256');
    const expectedStageHash = createHash('sha256');
    const replaced = new Set();
    let written = 0;
    for await (const raw of rawLines(target, readHash)) {
      const parts = lineParts(raw);
      const body = parts.body.toString('utf8');
      let output = raw;
      if (body.trim() !== '') {
        let parsed;
        try { parsed = JSON.parse(body); } catch (error) { throw new Error(`source line ${written + 1} is not valid JSON: ${error.message}`); }
        const event = plain(parsed) && typeof parsed.id === 'string' ? converted.get(parsed.id) : undefined;
        if (event !== undefined) {
          if (parsed.type !== 'custom' || parsed.customType !== event.customType) throw new Error(`entry ${parsed.id} does not match the planned harness event`);
          if (replaced.has(parsed.id)) throw new Error(`entry ${parsed.id} appears more than once`);
          const patched = patchDataField(body, event.data);
          let check;
          try { check = JSON.parse(patched); } catch (error) { throw new Error(`patched entry ${parsed.id} is invalid JSON: ${error.message}`); }
          if (check.id !== parsed.id || check.parentId !== parsed.parentId || check.timestamp !== parsed.timestamp) throw new Error(`entry ${parsed.id} identity changed while patching`);
          if (!plain(check.data) || check.data.v !== 3) throw new Error(`entry ${parsed.id} was not converted to v3`);
          output = Buffer.concat([Buffer.from(patched, 'utf8'), parts.ending]);
          replaced.add(parsed.id);
        }
      }
      await writeAll(backupHandle, raw);
      expectedStageHash.update(output);
      await writeAll(tempHandle, output);
      written += 1;
    }
    if (replaced.size !== converted.size || [...converted.keys()].some((id) => !replaced.has(id))) {
      throw new Error(`expected ${converted.size} planned entry replacements, found ${replaced.size}`);
    }
    const digest = readHash.digest('hex');
    if (digest !== sourceHash) throw new Error('source hash changed during migration');
    const expectedStage = expectedStageHash.digest('hex');
    const after = await lstat(target);
    if (!sameStat(before, after)) throw new Error('source identity changed during migration');
    await backupHandle.sync();
    await tempHandle.sync();
    await backupHandle.close();
    await tempHandle.close();
    backupHandle = undefined;
    tempHandle = undefined;
    const staged = join(tempDir, 'root.jsonl');
    const actualBackupHash = await hashFile(backup);
    const actualStageHash = await hashFile(staged);
    if (actualBackupHash !== sourceHash) throw new Error('persisted backup is not byte-exact with the source');
    if (actualStageHash !== expectedStage) throw new Error('staged output does not match the planned replacement bytes');
    backupVerified = true;
    await chmod(backup, 0o400);
    const sourceAgain = await lstat(target);
    if (!sameStat(before, sourceAgain)) throw new Error('source changed before commit');
    await chmod(staged, before.mode & 0o777);
    await rename(staged, target);
    committed = true;
    return {
      status: 'applied', changed: true, source: target, backup,
      restoreCommand: restoreCommand(backup, target),
      sourceHash, targetHash: actualStageHash, backupHash: actualBackupHash,
      replacedEvents: replaced.size, backupBytes: before.size,
      childTouched: false, capabilityReferencesReconciled: false,
      initialToolReactivationRequired: true, inheritedCapabilityAssessmentRequired: true,
      runtimeValidated: false,
      warnings: CAPABILITY_WARNINGS,
    };
  } catch (error) {
    if (backupHandle !== undefined) await backupHandle.close().catch(() => {});
    if (tempHandle !== undefined) await tempHandle.close().catch(() => {});
    if (!committed && backupVerified) {
      // Keep the verified byte-exact backup for explicit recovery; remove only
      // the staged output and never roll the source back automatically.
      error.backup = backup;
      error.restoreCommand = restoreCommand(backup, target);
    } else if (!committed) {
      await rm(backup, { force: true }).catch(() => {});
    }
    if (!committed && tempDir !== undefined) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    if (tempHandle !== undefined) await tempHandle.close().catch(() => {});
    if (backupHandle !== undefined) await backupHandle.close().catch(() => {});
    if (committed && tempDir !== undefined) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    session: { type: 'string' }, 'agent-dir': { type: 'string' }, 'socket-root': { type: 'string' },
    apply: { type: 'boolean' }, offline: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { process.stdout.write(`${usage()}\n`); return; }
  if (values.session === undefined || values['agent-dir'] === undefined) throw new Error(usage());
  const target = resolve(values.session);
  const agentDir = resolve(values['agent-dir']);
  if (values.apply === true && values.offline !== true) throw new Error('--apply requires explicit --offline; refusing to migrate');
  if (values.apply === true && process.env[OFFLINE_ENV] !== undefined
    && process.env[SOCKET_ENV] !== undefined && resolve(process.env[OFFLINE_ENV]) === target) {
    throw new Error(`refusing --apply while ${OFFLINE_ENV} and ${SOCKET_ENV} name this live agent; close Pi, unset them, and run a normal offline terminal`);
  }
  const socketRoot = values['socket-root'] === undefined ? undefined : resolve(values['socket-root']);
  const plan = freshPlan({ session: target, agentDir });
  if (values.apply !== true) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  const report = await applyPlan({ plan, target, socketRoot });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'refused') process.exitCode = 1;
}

main().catch((error) => {
  const detail = { status: 'error', message: error instanceof Error ? error.message : String(error) };
  if (error?.backup !== undefined) {
    detail.backup = error.backup;
    detail.restoreCommand = error.restoreCommand;
  }
  console.error(JSON.stringify(detail));
  process.exitCode = 1;
});
