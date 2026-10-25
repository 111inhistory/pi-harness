#!/usr/bin/env node
/** Offline, disposable v1 -> v2 converter. Node built-ins only; never imported by production. */
import { createReadStream } from 'node:fs';
import { access, copyFile, constants, lstat, open, readdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const LEGACY = 'subagent-state';
const V2 = new Set(['subagent-job', 'subagent-job-start', 'subagent-job-end', 'subagent-actor', 'subagent-anchor']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const LIVE = new Set(['queued', 'running', 'stopping', 'finalizing']);
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const legacy = (x) => x.type === LEGACY || (x.type === 'custom' && x.customType === LEGACY);
const sameStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function requireValue(condition, message) { if (!condition) throw new Error(message); }
async function exists(file) { try { await access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function* records(file, hash) {
  const stream = createReadStream(file);
  if (hash) stream.on('data', (chunk) => hash.update(chunk));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const raw of lines) {
      line++;
      if (!raw.trim()) continue;
      let entry;
      try { entry = JSON.parse(raw); } catch (e) { throw new Error(`${file}:${line}: invalid JSON: ${e.message}`); }
      requireValue(object(entry), `${file}:${line}: expected a JSON object`);
      yield { entry, raw, line };
    }
  } finally { lines.close(); stream.destroy(); }
}

/** Retain tree metadata, not native dialogue or repeated checkpoint payloads. */
async function scan(file) {
  const before = await lstat(file);
  requireValue(before.isFile() && !before.isSymbolicLink(), `${file}: expected a regular, non-symlink file`);
  const hash = createHash('sha256');
  const nodes = new Map();
  let header, leaf = null, removed = 0, ordinal = 0;
  for await (const { entry: e, line } of records(file, hash)) {
    ordinal++;
    if (ordinal === 1) {
      requireValue(e.type === 'session' && typeof e.id === 'string', `${file}: missing native session header`);
      header = e;
      continue;
    }
    requireValue(e.type !== 'session' && typeof e.id === 'string' && e.id !== '' && !nodes.has(e.id), `${file}:${line}: invalid/duplicate native entry id`);
    const parent = e.parentId ?? null;
    requireValue(parent === null || nodes.has(parent), `${file}:${line}: missing or forward parent ${parent}`);
    const drop = legacy(e);
    const keptParent = parent === null ? null : nodes.get(parent).kept;
    nodes.set(e.id, { id: e.id, parent, kept: drop ? keptParent : e.id, drop, line, ordinal,
      v2: e.type === 'custom' && V2.has(e.customType), agentId: e.data?.agentId, jobId: e.data?.jobId });
    removed += Number(drop);
    leaf = e.id;
  }
  requireValue(header, `${file}: empty session`);
  requireValue(sameStat(before, await lstat(file)), `${file}: changed during scan; stop Pi and retry offline`);
  return { file, stat: before, digest: hash.digest('hex'), header, nodes, leaf, removed, ordinal };
}
async function readEntry(file, line) {
  for await (const record of records(file)) if (record.line === line) return record.entry;
  throw new Error(`${file}: entry disappeared during planning`);
}
async function walk(dir, skipViews = false) {
  if (!await exists(dir)) return [];
  const result = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (skipViews && e.name === 'views') continue;
    const file = join(dir, e.name);
    if (e.isDirectory()) result.push(...await walk(file, skipViews));
    else if (e.name.endsWith('.jsonl')) {
      requireValue(e.isFile(), `${file}: refusing a symlink or special file`);
      result.push(file);
    }
  }
  return result.sort();
}
function activeBranch(info) {
  const result = [];
  for (let id = info.leaf; id !== null; id = info.nodes.get(id).parent) result.push(info.nodes.get(id));
  return result;
}
function childPath(file, childDir) {
  requireValue(typeof file === 'string' && isAbsolute(file), `Expected an absolute child-session path, got ${JSON.stringify(file)}`);
  const rel = relative(childDir, resolve(file));
  requireValue(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `Child reference escapes ${childDir}: ${file}`);
  return resolve(file);
}
function nativeReferenceChanges(entry, info) {
  const changes = {};
  const key = entry.type === 'compaction' ? 'firstKeptEntryId' : entry.type === 'label' ? 'targetId' : entry.type === 'branch_summary' ? 'fromId' : null;
  const target = key && info.nodes.get(entry[key]);
  if (!target?.drop) return changes;
  if (key !== 'firstKeptEntryId') changes[key] = target.kept;
  else {
    // A compaction's kept range starts AFTER removed metadata, never before it.
    // Find the first retained descendant on this compaction's ancestor path.
    let id = entry.id, first = entry.id;
    while (id !== target.id) {
      requireValue(id !== null, `${info.file}: compaction cutoff is not an ancestor`);
      const node = info.nodes.get(id);
      if (!node.drop) first = id;
      id = node.parent;
    }
    changes[key] = first;
  }
  return changes;
}
function preserveLeaf(plan) {
  if (plan.appended.length || plan.info.leaf === null) return;
  let physicalLeaf = null;
  for (const node of plan.info.nodes.values()) if (!node.drop) physicalLeaf = node.id;
  const logicalLeaf = plan.info.nodes.get(plan.info.leaf).kept;
  if (physicalLeaf === logicalLeaf) return;
  let id; do { id = randomUUID().slice(0, 8); } while (plan.info.nodes.has(id));
  // Native custom metadata, not a new runtime protocol. Without this marker,
  // dropping the final checkpoint can select a different branch on reopening.
  plan.appended.push({ type: 'custom', customType: 'subagent-conversion', data: { v: 2 },
    id, parentId: logicalLeaf, timestamp: new Date().toISOString() });
}
function bounds(value, map) {
  if (value == null) return null;
  requireValue(object(value), 'Invalid Job history bounds');
  return { startEntryId: map(value.startEntryId ?? null), endEntryId: map(value.endEntryId ?? null) };
}

/** Preflight every input before any backup or rewrite. No writes, including dry-run. */
export async function planMigration({ agentDir, sessionFile = null }) {
  requireValue(typeof agentDir === 'string' && agentDir !== '', '--agent-dir is required');
  agentDir = resolve(agentDir);
  const childDir = join(agentDir, 'subagent-sessions');
  const roots = sessionFile ? [resolve(sessionFile)] : await walk(join(agentDir, 'sessions'));
  const scans = new Map();
  for (const file of roots) scans.set(file, await scan(file));
  const ownedDir = sessionFile ? join(childDir, scans.get(roots[0]).header.id) : childDir;
  const children = await walk(ownedDir, true);
  for (const file of children) scans.set(file, await scan(file));
  const originalScans = new Map();
  async function childInfo(file) {
    file = childPath(file, childDir);
    if (!scans.has(file) && await exists(file)) {
      const foreign = await scan(file);
      requireValue(!sessionFile || foreign.removed === 0,
        `${file}: shared child still contains v1 checkpoints; close dependent sessions and convert the owner in the full offline run first`);
      // A selected Fork can read an already-clean foreign file, but never rewrites it.
      scans.set(file, foreign);
    }
    requireValue(scans.has(file), `Missing referenced child session: ${file}`);
    const current = scans.get(file);
    if (!originalScans.has(file)) {
      let original = current;
      // Resume a child-first interrupted migration: old seed ordinals/removed anchors
      // still belong to the byte-exact backup, not the already-cleaned child.
      if (!current.removed && await exists(`${file}.v1.bak`)) {
        const backup = await scan(`${file}.v1.bak`);
        requireValue(backup.header.id === current.header.id, `${file}: backup belongs to another native session`);
        for (const node of backup.nodes.values()) if (!node.drop) {
          requireValue(current.nodes.has(node.id), `${file}: backup's retained entry ${node.id} is missing`);
        }
        original = backup;
      }
      originalScans.set(file, original);
    }
    const original = originalScans.get(file);
    return { current, original, map(id) {
      if (id === null) return null;
      requireValue(typeof id === 'string', `${file}: malformed anchor`);
      if (current.nodes.has(id)) return current.nodes.get(id).kept;
      requireValue(original.nodes.has(id), `${file}: unknown anchor ${id}`);
      return original.nodes.get(id).kept;
    } };
  }
  async function convertSpec(spec) {
    requireValue(object(spec), 'Legacy Job has no spec');
    if (spec.kind === 'continuation') return { kind: 'continuation', name: spec.name ?? null };
    requireValue(spec.kind === undefined && typeof spec.task === 'string' && spec.task.trim(), 'Legacy Job has an invalid task/spec');
    const copy = { ...spec };
    if (object(spec.inheritedContext)) {
      const { entries, ...context } = spec.inheritedContext;
      requireValue(object(entries) && typeof entries.seedFile === 'string' && Number.isInteger(entries.entryCount) && entries.entryCount >= 1,
        'Inherited context has no materialized seed reference; raw embedded seeds must be materialized separately before conversion');
      const info = await childInfo(entries.seedFile);
      requireValue(entries.entryCount <= info.original.ordinal, `${entries.seedFile}: seed prefix exceeds native file`);
      const prefixEnd = entries.entryCount === 1 ? null : [...info.original.nodes.values()].find((n) => n.ordinal === entries.entryCount)?.id;
      requireValue(prefixEnd !== undefined, `${entries.seedFile}: seed prefix has no end entry`);
      context.seedFile = resolve(entries.seedFile);
      context.seedLeafId = info.map(prefixEnd);
      if (object(context.model)) context.model = { provider: context.model.provider, id: context.model.id };
      copy.inheritedContext = context;
    }
    return copy;
  }
  const plans = [];
  for (const file of roots) {
    const info = scans.get(file);
    if (!info.removed) continue;
    const branch = activeBranch(info);
    const selected = branch.find((n) => n.drop);
    const additions = [];
    let actorCount = 0, jobCount = 0;
    if (selected) {
      const checkpoint = (await readEntry(file, selected.line)).data;
      requireValue(checkpoint?.version === 1 && checkpoint.registry?.version === 1 && object(checkpoint.actors), `${file}: unsupported legacy checkpoint shape`);
      const registry = checkpoint.registry;
      requireValue(Array.isArray(registry.actors) && Array.isArray(registry.jobs), `${file}: legacy registry has no actor/Job lists`);
      requireValue(!(registry.pending ?? []).some((p) => p.messages?.length), `${file}: checkpoint contains undelivered in-memory messages; refusing to silently discard them`);
      const actors = new Map();
      const jobs = new Map();
      const newActors = new Set(branch.filter((n) => n.v2 && n.agentId).map((n) => n.agentId));
      const newJobs = new Set(branch.filter((n) => n.v2 && n.jobId).map((n) => n.jobId));
      for (const a of registry.actors) {
        requireValue(typeof a.agentId === 'string' && /^sub_\d+(?:_\d+)?$/.test(a.agentId) && !actors.has(a.agentId) && !newActors.has(a.agentId), `${file}: duplicate/conflicting legacy actor ${a.agentId}`);
        requireValue(Number.isInteger(a.depth) && a.depth >= 1 && a.depth <= 2, `${file}: invalid actor depth`);
        actors.set(a.agentId, a);
      }
      for (const a of actors.values()) {
        const parent = a.parentAgentId == null ? null : actors.get(a.parentAgentId);
        requireValue(parent !== undefined && (parent?.depth ?? 0) + 1 === a.depth, `${file}: invalid actor topology ${a.agentId}`);
      }
      const registered = new Set();
      const ends = [];
      const recordsByActor = new Map();
      for (const a of actors.values()) {
        const r = checkpoint.actors[a.agentId];
        if (r == null) continue;
        requireValue(object(r) && typeof r.cwd === 'string' && r.cwd && typeof r.sessionFile === 'string', `${file}: incomplete identity of ${a.agentId}`);
        const nativeFile = childPath(r.sessionFile, childDir);
        // Missing never-flushed files are valid only at an empty anchor.
        const native = await exists(nativeFile) ? await childInfo(nativeFile) : null;
        requireValue(native || r.leafId === null, `${nativeFile}: native history is missing at a recorded anchor`);
        for (const key of ['trusted', 'allowInherited', 'routed']) requireValue(typeof r[key] === 'boolean', `${file}: invalid ${a.agentId}.${key}`);
        requireValue(r.tools == null || (Array.isArray(r.tools) && r.tools.every((x) => typeof x === 'string')), `${file}: invalid actor tools`);
        const { leafId, ...record } = r;
        if (record.model != null) {
          requireValue(typeof record.model.provider === 'string' && typeof record.model.id === 'string', `${file}: invalid actor model`);
          record.model = { provider: record.model.provider, id: record.model.id };
        }
        requireValue(!record.routed || record.model, `${file}: routed actor has no model`);
        recordsByActor.set(a.agentId, { record, native, anchor: native ? native.map(leafId) : null });
      }
      for (const j of registry.jobs) {
        const a = actors.get(j.agentId);
        requireValue(a && typeof j.jobId === 'string' && !jobs.has(j.jobId) && !newJobs.has(j.jobId), `${file}: duplicate/conflicting or ownerless Job ${j.jobId}`);
        const previous = j.continuedFromJobId == null ? null : jobs.get(j.continuedFromJobId);
        requireValue(j.continuedFromJobId == null || previous?.agentId === a.agentId, `${file}: continuation predecessor is missing or has another owner for ${j.jobId}`);
        requireValue(j.createdBy == null || j.createdBy === 'Main' || actors.has(j.createdBy), `${file}: unknown Job creator ${j.createdBy}`);
        jobs.set(j.jobId, j);
        const first = !registered.has(a.agentId);
        registered.add(a.agentId);
        const spec = await convertSpec(j.spec);
        additions.push({ type: 'subagent-job', data: { jobId: j.jobId, agentId: a.agentId,
          ...(first ? { actor: { name: a.name ?? null, parentAgentId: a.parentAgentId ?? null, depth: a.depth } } : {}),
          index: j.index ?? null, spec, origin: j.origin ?? null, createdBy: j.createdBy ?? 'Main', continuedFromJobId: j.continuedFromJobId ?? null } });
        const identity = recordsByActor.get(a.agentId);
        const map = identity?.native?.map ?? ((id) => { requireValue(id === null, `${file}: Job bounds refer to missing native history`); return null; });
        let history = bounds(j.history, map);
        const interrupted = LIVE.has(j.status);
        requireValue(interrupted || TERMINAL.has(j.status), `${file}: unknown Job status ${j.status}`);
        if (interrupted) {
          // Registration can precede recordHistory: a never-started continuation
          // must not claim its actor's earlier rounds as new work.
          const fallback = previous ? map(previous.history?.endEntryId ?? null) ?? identity?.anchor ?? null : spec.inheritedContext?.seedLeafId ?? null;
          history = { startEntryId: history ? history.startEntryId : fallback,
            endEntryId: identity?.anchor ?? history?.endEntryId ?? null };
        }
        ends.push({ type: 'subagent-job-end', data: { jobId: j.jobId, status: interrupted ? 'failed' : j.status,
          error: interrupted ? { code: 'job_interrupted', message: 'The process ended before this Job settled (offline v2 conversion).' } : j.error ?? null,
          result: interrupted ? null : j.result ?? null, history,
          budget: j.budget ? { ...j.budget, running: false } : null },
          order: a.jobIds?.at(-1) === j.jobId ? (a.stoppedOrder ?? 0) : -1 });
      }
      requireValue(registered.size === actors.size, `${file}: an actor has no Job; cannot represent it in v2 without inventing work`);
      additions.push(...ends.sort((a, b) => a.order - b.order).map(({ type, data }) => ({ type, data })));
      // Identity anchors come last: an idle notification may have moved beyond the last Job.
      for (const [agentId, { record, anchor }] of recordsByActor) additions.push({ type: 'subagent-actor', data: { agentId, ...record, anchor } });
      actorCount = actors.size;
      jobCount = jobs.size;
    }
    const ids = new Set(info.nodes.keys());
    let parent = info.leaf === null ? null : info.nodes.get(info.leaf).kept;
    const appended = additions.map(({ type, data }) => {
      let id; do { id = randomUUID().slice(0, 8); } while (ids.has(id)); ids.add(id);
      const entry = { type: 'custom', customType: type, data: { v: 2, ...data }, id, parentId: parent, timestamp: new Date().toISOString() };
      parent = id;
      return entry;
    });
    plans.push({ info, appended, actorCount, jobCount, kind: 'root' });
  }
  for (const file of children) {
    const info = scans.get(file);
    if (info.removed) plans.unshift({ info, appended: [], actorCount: 0, jobCount: 0, kind: 'child' });
  }
  // Compute exact output sizes without storing second copies of native dialogue.
  for (const plan of plans) {
    preserveLeaf(plan);
    let afterBytes = 0;
    for await (const line of outputLines(plan)) afterBytes += Buffer.byteLength(line);
    plan.afterBytes = afterBytes;
  }
  return { agentDir, sessionFile: sessionFile ? resolve(sessionFile) : null, ownedDir, files: plans };
}

// Replace ONLY top-level structural JSON values. Re-stringifying the whole
// record would normalize unknown opaque payloads (including int64 literals).
function patchFields(raw, changes) {
  const spans = new Map();
  const whitespace = () => { while (/\s/.test(raw[i] ?? '') && i < raw.length) i++; };
  const stringEnd = () => { i++; while (i < raw.length) { if (raw[i] === '\\') i += 2; else if (raw[i++] === '"') return; } };
  let i = raw.indexOf('{') + 1;
  while (i < raw.length) {
    whitespace();
    if (raw[i] === '}') break;
    const startKey = i;
    stringEnd();
    const key = JSON.parse(raw.slice(startKey, i));
    whitespace(); i++; whitespace(); // colon
    const start = i;
    let depth = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '"') { stringEnd(); continue; }
      if (depth === 0 && (c === ',' || c === '}')) break;
      if (c === '{' || c === '[') depth++;
      if (c === '}' || c === ']') depth--;
      i++;
    }
    let end = i;
    while (/\s/.test(raw[end - 1] ?? '') && end > start) end--;
    if (Object.hasOwn(changes, key)) spans.set(key, { start, end, value: JSON.stringify(changes[key]) });
    if (raw[i] === ',') i++; else break;
  }
  requireValue(spans.size === Object.keys(changes).length, 'Cannot patch missing native structural field');
  for (const { start, end, value } of [...spans.values()].sort((a, b) => b.start - a.start)) raw = raw.slice(0, start) + value + raw.slice(end);
  return raw;
}
async function* outputLines({ info, appended }) {
  const hash = createHash('sha256');
  for await (const { entry, raw } of records(info.file, hash)) {
    if (legacy(entry)) continue;
    const node = info.nodes.get(entry.id);
    const parent = node?.parent === null ? null : info.nodes.get(node?.parent)?.kept;
    const changes = nativeReferenceChanges(entry, info);
    if (entry.type !== 'session' && parent !== (entry.parentId ?? null)) changes.parentId = parent;
    yield `${Object.keys(changes).length ? patchFields(raw, changes) : raw}\n`;
  }
  requireValue(hash.digest('hex') === info.digest, `${info.file}: changed since preflight; stop Pi and retry offline`);
  for (const e of appended) yield `${JSON.stringify(e)}\n`;
}

export function migrationReport(plan) {
  return plan.files.map(({ info, kind, actorCount, jobCount, afterBytes }) => ({ file: info.file, kind,
    beforeBytes: info.stat.size, afterBytes, removedCheckpoints: info.removed, actors: actorCount, jobs: jobCount }));
}

/** Children first, roots last; byte-exact backups make partial commits recoverable. */
export async function applyMigration(plan, { offline = false } = {}) {
  requireValue(offline, 'Apply requires explicit --offline acknowledgement; exit Pi before converting');
  const activeFile = process.env.PI_SESSION_FILE && resolve(process.env.PI_SESSION_FILE);
  const activeAgentDir = process.env.PI_CODING_AGENT_DIR && resolve(process.env.PI_CODING_AGENT_DIR);
  const selectedInactive = plan.sessionFile && plan.sessionFile !== activeFile &&
    !plan.ownedDir.endsWith(`${sep}${process.env.PI_SESSION_ID ?? ''}`) &&
    plan.files.every((p) => p.kind === 'root' || dirname(p.info.file) === plan.ownedDir);
  requireValue(!activeFile || selectedInactive || (!activeFile.startsWith(`${plan.agentDir}${sep}`) && activeAgentDir !== plan.agentDir && !plan.files.some((p) => p.info.file === activeFile)),
    'Refusing to convert the active session/tree; select one inactive session or exit Pi before a full conversion');
  const staged = [];
  try {
    for (const p of plan.files) {
      requireValue(sameStat(p.info.stat, await lstat(p.info.file)), `${p.info.file}: changed since preflight`);
      const temp = `${p.info.file}.v2-tmp-${randomUUID()}`;
      const handle = await open(temp, 'wx', 0o600);
      staged.push({ ...p, temp });
      try { for await (const line of outputLines(p)) await handle.writeFile(line); await handle.sync(); }
      finally { await handle.close(); }
    }
    // Back up every original before committing any rewrite. Never overwrite a backup.
    for (const p of staged) {
      const backup = `${p.info.file}.v1.bak`;
      if (await exists(backup)) requireValue((await scan(backup)).digest === p.info.digest, `${backup}: existing backup differs; refusing to overwrite`);
      else await copyFile(p.info.file, backup, constants.COPYFILE_EXCL);
      requireValue((await scan(backup)).digest === p.info.digest, `${backup}: backup verification failed`);
    }
    for (const p of staged) {
      requireValue(sameStat(p.info.stat, await lstat(p.info.file)), `${p.info.file}: changed before commit; originals/backups retained`);
      await rename(p.temp, p.info.file);
    }
  } finally { for (const p of staged) await rm(p.temp, { force: true }); }
  return migrationReport(plan);
}

async function main() {
  const { values } = parseArgs({ options: { 'agent-dir': { type: 'string' }, session: { type: 'string' }, 'dry-run': { type: 'boolean' },
    apply: { type: 'boolean' }, offline: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log('Usage: node scripts/convert-subagent-storage-v2.mjs --agent-dir DIR [--session FILE] --dry-run\n       node scripts/convert-subagent-storage-v2.mjs --agent-dir DIR [--session FILE] --apply --offline\nClose target sessions before apply. --session limits writes to one inactive root and its owned children; foreign files must already be clean and remain read-only. Backups: <file>.v1.bak. No production imports or automatic migration.');
    return;
  }
  requireValue(values.apply !== values['dry-run'] && (values.apply || values['dry-run']), 'Choose exactly one of --dry-run or --apply');
  requireValue(!values.apply || values.offline, '--apply requires --offline; exit Pi first');
  const plan = await planMigration({ agentDir: values['agent-dir'], sessionFile: values.session });
  console.log(JSON.stringify({ mode: values.apply ? 'apply' : 'dry-run', files: migrationReport(plan) }, null, 2));
  if (values.apply) { await applyMigration(plan, { offline: true }); console.log('Conversion complete. Keep .v1.bak files until load/revival verification succeeds.'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
