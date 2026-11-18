#!/usr/bin/env node
/**
 * Offline, read-only planner for v2 -> v3 Subagent storage.
 *
 * This script parses root session JSONL files, proves the old create-batch
 * chain from native parentId edges, and emits the exact v3 event DATA that an
 * apply step would need. It never writes user data, never reads child session
 * bodies and has no apply mode. It is standalone: Node built-ins only.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const PLAN_VERSION = 1;
const V3 = 3;
const V2 = 2;
const TOOL_RENAMES = new Map([['subagent_stop', 'subagent_signal']]);
const HARNESS = new Set(['subagent-job', 'subagent-job-start', 'subagent-job-end', 'subagent-actor', 'subagent-anchor']);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value !== '';
const stableString = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

function usage() {
  return 'Usage: node scripts/plan-subagent-storage-v3.mjs --agent-dir DIR [--session FILE] [--output FILE]\n' +
    '       Plan only: never rewrites sessions and never reads child session bodies.';
}

async function walkJsonl(directory) {
  const files = [];
  const visit = async (path) => {
    let info;
    try { info = await lstat(path); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) return;
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      const childInfo = await lstat(child);
      if (childInfo.isSymbolicLink()) continue;
      if (childInfo.isDirectory()) await visit(child);
      else if (childInfo.isFile() && entry.name.endsWith('.jsonl')) files.push(resolve(child));
    }
  };
  await visit(directory);
  return files;
}

function sameStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function statRecord(info) {
  return {
    dev: info.dev, ino: info.ino, size: info.size,
    mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs,
  };
}

/** Stream one root once: hash bytes, retain graph/harness metadata only. */
async function scanRoot(file) {
  const before = await lstat(file);
  const hash = createHash('sha256');
  const input = createReadStream(file);
  input.on('data', (chunk) => hash.update(chunk));
  const lines = createInterface({ input, crlfDelay: Infinity });
  const nodes = new Map();
  const harness = [];
  const parseErrors = [];
  let ordinal = 0;
  let headerId = null;
  let headerCount = 0;
  for await (const raw of lines) {
    ordinal += 1;
    if (raw.trim() === '') continue;
    let entry;
    try { entry = JSON.parse(raw); }
    catch (error) {
      parseErrors.push({ line: ordinal, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!plain(entry) || typeof entry.id !== 'string' || entry.id === '') {
      parseErrors.push({ line: ordinal, reason: 'entry has no string id' });
      continue;
    }
    if (entry.type === 'session') {
      headerCount += 1;
      if (headerId === null) headerId = entry.id;
      continue;
    }
    const parentId = entry.parentId ?? null;
    if (parentId !== null && typeof parentId !== 'string') {
      parseErrors.push({ line: ordinal, reason: 'entry has an invalid parentId' });
      continue;
    }
    if (nodes.has(entry.id)) {
      parseErrors.push({ line: ordinal, reason: `duplicate entry id ${entry.id}` });
      continue;
    }
    const customType = typeof entry.customType === 'string' ? entry.customType : null;
    const legacy = entry.type === 'subagent-state' || customType === 'subagent-state';
    const node = { id: entry.id, parentId, ordinal, legacy, customType };
    nodes.set(entry.id, node);
    if (customType !== null && HARNESS.has(customType) && plain(entry.data)) {
      let data = entry.data;
      // Captured conversation entries are dialogue, not plan metadata. Keep
      // only the seed reference/metadata; never retain or emit the body.
      if (customType === 'subagent-job' && plain(data.spec) && plain(data.spec.inheritedContext)) {
        const { entries: _entries, ...metadata } = data.spec.inheritedContext;
        data = { ...data, spec: { ...data.spec, inheritedContext: metadata } };
      }
      harness.push({ entryId: entry.id, parentId, ordinal, customType, data });
    }
  }
  const after = await lstat(file);
  const missingParents = [];
  const cycles = [];
  const children = new Map();
  for (const node of nodes.values()) {
    if (node.parentId !== null && !nodes.has(node.parentId)) missingParents.push(node.id);
    if (node.parentId !== null) {
      const list = children.get(node.parentId) ?? [];
      list.push(node.id);
      children.set(node.parentId, list);
    }
  }
  // Linear tri-color cycle walk: each node is visited at most once. A path
  // memo avoids the O(N^2) ancestor scan a fresh Set per node would cause.
  const color = new Map();
  for (const node of nodes.values()) {
    if (color.has(node.id)) continue;
    const path = [];
    let id = node.id;
    let cycle = false;
    while (id !== null && nodes.has(id)) {
      const state = color.get(id);
      if (state === 1) { cycle = true; break; }
      if (state === 2) break;
      color.set(id, 1);
      path.push(id);
      id = nodes.get(id).parentId;
    }
    for (const visited of path) color.set(visited, 2);
    if (cycle) cycles.push(node.id);
  }
  const leaves = [...nodes.keys()].filter((id) => !(children.get(id)?.length)).length;
  const versions = new Set(harness.map((event) => event.data.v));
  const v1 = [...nodes.values()].filter((node) => node.legacy).length;
  const v2 = harness.filter((event) => event.data.v === V2).length;
  const v3 = harness.filter((event) => event.data.v === V3).length;
  const unknownVersion = harness.filter((event) => event.data.v !== V2 && event.data.v !== V3).length;
  return {
    file: resolve(file),
    source: { hash: hash.digest('hex'), before: statRecord(before), after: statRecord(after), stable: sameStat(before, after) },
    headerId,
    headerCount,
    nodes,
    harness,
    parseErrors,
    branch: {
      headerId, entries: nodes.size, leaves, topologyValid:
        headerCount === 1 && missingParents.length === 0 && cycles.length === 0 && parseErrors.length === 0,
      missingParents: missingParents.length, cycles: cycles.length,
      harness: { v1, v2, v3, unknownVersion },
    },
    counts: { v1, v2, v3, unknownVersion, harness: harness.length },
  };
}

function translateToken(token) {
  if (typeof token !== 'string') return token;
  const prefix = token.startsWith('+') || token.startsWith('-') ? token[0] : '';
  const name = prefix === '' ? token : token.slice(1);
  const renamed = TOOL_RENAMES.get(name);
  return renamed === undefined ? token : `${prefix}${renamed}`;
}

function translatePreset(preset) {
  if (!plain(preset) || !plain(preset.config) || !Array.isArray(preset.config.tools)) return preset;
  return { ...preset, config: { ...preset.config, tools: preset.config.tools.map(translateToken) } };
}

function translateIdentity(data) {
  const next = { ...data };
  if (Array.isArray(data.tools)) next.tools = data.tools.map(translateToken);
  if (Array.isArray(data.excludedTools)) next.excludedTools = data.excludedTools.map(translateToken);
  if (plain(data.preset)) next.preset = translatePreset(data.preset);
  return next;
}

function stripInherited(value) {
  if (!plain(value)) return null;
  const { entries: _entries, ...metadata } = value;
  return translateIdentity(metadata);
}

function initialSpec(data) {
  return plain(data.spec) && data.spec.kind !== 'continuation';
}

function batchAmbiguity(reason, detail = {}) {
  return { reason, detail };
}

/** Proven v2 batches: direct parentId chains 0..n-1, no adjacency/timestamp. */
function deriveBatches(scan) {
  const initial = scan.harness.filter((event) => event.customType === 'subagent-job' && initialSpec(event.data));
  const continuations = scan.harness.filter((event) => event.customType === 'subagent-job' && !initialSpec(event.data));
  const problems = [];
  const starts = initial.filter((event) => event.data.index === 0);
  const childByIndex = new Map();
  const initialEntryIds = new Set(initial.map((event) => event.entryId));
  for (const event of initial) {
    if (event.parentId === null || !initialEntryIds.has(event.parentId)) continue;
    if (!Number.isInteger(event.data.index)) continue;
    const byIndex = childByIndex.get(event.parentId) ?? new Map();
    const list = byIndex.get(event.data.index) ?? [];
    list.push(event);
    byIndex.set(event.data.index, list);
    childByIndex.set(event.parentId, byIndex);
  }
  const chains = [];
  const used = new Set();
  for (const start of starts) {
    if (!plain(start.data.actor) || !text(start.data.agentId) || !Number.isInteger(start.data.index)) {
      problems.push(batchAmbiguity('initial Job has no actor/index/agentId', { entryId: start.entryId }));
      continue;
    }
    const chain = [start];
    used.add(start.entryId);
    let current = start;
    while (true) {
      const options = childByIndex.get(current.entryId)?.get(current.data.index + 1) ?? [];
      if (options.length === 0) break;
      if (options.length > 1) {
        problems.push(batchAmbiguity('multiple direct child initial registrations', { entryId: current.entryId }));
        break;
      }
      current = options[0];
      chain.push(current);
      used.add(current.entryId);
      if (chain.length > 10000) {
        problems.push(batchAmbiguity('batch chain exceeds 10000 members', { entryId: start.entryId }));
        break;
      }
    }
    const first = chain[0];
    const parent = plain(first.data.actor) ? first.data.actor.parentAgentId ?? null : null;
    const context = plain(first.data.spec) ? first.data.spec.context ?? null : null;
    const createdBy = first.data.createdBy ?? null;
    const origin = first.data.origin ?? null;
    const actorIds = new Set();
    for (const [position, event] of chain.entries()) {
      const actor = event.data.actor;
      const spec = event.data.spec;
      if (!plain(actor) || !plain(spec) || !text(event.data.agentId) || event.data.jobId !== event.data.agentId) {
        problems.push(batchAmbiguity('initial Job is not a complete registration', { entryId: event.entryId }));
        break;
      }
      if (event.data.index !== position) {
        problems.push(batchAmbiguity('batch indices are not 0..n-1', { entryId: event.entryId }));
        break;
      }
      if (!text(spec.task) || (spec.context ?? null) !== context
        || (actor.parentAgentId ?? null) !== parent
        || (event.data.createdBy ?? null) !== createdBy
        || stableString(event.data.origin ?? null) !== stableString(origin)) {
        problems.push(batchAmbiguity('batch members disagree on parent/context/createdBy/origin', { entryId: event.entryId }));
        break;
      }
      if (spec.inheritContext === true ? !plain(spec.inheritedContext) : plain(spec.inheritedContext)) {
        problems.push(batchAmbiguity('initial inheritContext flag contradicts its captured seed', { entryId: event.entryId }));
        break;
      }
      if (actorIds.has(event.data.agentId)) {
        problems.push(batchAmbiguity('duplicate Actor in one batch', { entryId: event.entryId }));
        break;
      }
      actorIds.add(event.data.agentId);
    }
    chains.push({ start, chain, parent, context, createdBy, origin });
  }
  for (const event of initial) {
    if (!used.has(event.entryId)) problems.push(batchAmbiguity('initial Job is not on a 0..n-1 chain', { entryId: event.entryId }));
  }
  return { initial, continuations, chains, problems };
}

/** Terminal leaves must not expose only a prefix of a proven batch roster. */
function validateLeafBatches(scan, entries) {
  const children = new Map();
  const roots = [];
  const sizes = new Map();
  for (const info of entries.values()) sizes.set(info.batch, (sizes.get(info.batch) ?? 0) + 1);
  for (const node of scan.nodes.values()) {
    if (node.parentId === null) roots.push(node.id);
    else {
      const list = children.get(node.parentId) ?? [];
      list.push(node.id);
      children.set(node.parentId, list);
    }
  }
  const counts = new Map();
  let leaves = 0;
  let partialLeaves = 0;
  let partialBatches = 0;
  const stack = roots.map((id) => ({ id, exit: false }));
  while (stack.length > 0) {
    const frame = stack.pop();
    const info = entries.get(frame.id);
    if (frame.exit) {
      if (info !== undefined) counts.set(info.batch, (counts.get(info.batch) ?? 0) - 1);
      continue;
    }
    if (info !== undefined) counts.set(info.batch, (counts.get(info.batch) ?? 0) + 1);
    stack.push({ id: frame.id, exit: true });
    const next = children.get(frame.id) ?? [];
    if (next.length === 0) {
      leaves += 1;
      let partial = 0;
      for (const [batch, count] of counts) {
        const size = sizes.get(batch) ?? 0;
        if (count > 0 && count !== size) partial += 1;
      }
      if (partial > 0) { partialLeaves += 1; partialBatches += partial; }
      continue;
    }
    for (let index = next.length - 1; index >= 0; index -= 1) stack.push({ id: next[index], exit: false });
  }
  return { leaves, partialLeaves, partialBatches };
}

async function childReference(scan, agentDir, actorMap) {
  const ownDir = scan.headerId === null ? null : resolve(agentDir, 'subagent-sessions', scan.headerId);
  const refs = new Map();
  for (const event of scan.harness.filter((item) => item.customType === 'subagent-actor')) {
    const data = event.data;
    if (typeof data.agentId !== 'string' || typeof data.sessionFile !== 'string') continue;
    if (!refs.has(data.sessionFile)) refs.set(data.sessionFile, []);
    refs.get(data.sessionFile).push(translateIdentity(data).agentId);
  }
  let unique = 0;
  let missing = 0;
  let symlink = 0;
  let foreign = 0;
  let ownOtherName = 0;
  let laterCopyBytes = 0;
  let laterCopyRefs = 0;
  const files = [];
  for (const [file, actors] of [...refs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    unique += 1;
    let info;
    try { info = await lstat(file); }
    catch { missing += 1; files.push({ file, exists: false, actors }); continue; }
    if (info.isSymbolicLink()) { symlink += 1; files.push({ file, symlink: true, actors }); continue; }
    const isForeign = ownDir !== null && dirname(resolve(file)) !== ownDir;
    if (isForeign) foreign += 1;
    else if (!actors.some((oldId) => {
      const mapped = actorMap.get(oldId);
      return mapped !== undefined && resolve(ownDir, `${mapped.newActor}.jsonl`) === resolve(file);
    })) ownOtherName += 1;
    const copyActors = actors.map((oldId) => actorMap.get(oldId)).filter((item) => item !== undefined
      && resolve(agentDir, 'subagent-sessions', scan.headerId, `${item.newActor}.jsonl`) !== resolve(file));
    if (copyActors.length > 0) {
      laterCopyRefs += copyActors.length;
      laterCopyBytes += info.size;
    }
    files.push({ file, exists: true, size: info.size, foreign: isForeign, actors, laterCopyActors: copyActors.length });
  }
  return {
    ownDir, unique, missing, symlink, foreign, ownOtherName,
    laterCopyRefs, laterCopyBytes,
    metadataOnly: true,
    files,
  };
}

async function planV2(scan, agentDir) {
  if (!scan.source.stable) return { excluded: 'unstable', diagnostics: ['source changed during read'] };
  if (scan.branch.topologyValid !== true) return { excluded: 'ambiguous', diagnostics: ['root entry topology or JSON is invalid'], branch: scan.branch };
  const proof = deriveBatches(scan);
  if (proof.problems.length > 0) return { excluded: 'ambiguous', diagnostics: proof.problems, branch: scan.branch };
  const chains = proof.chains;
  const actorMap = new Map();
  const batchRows = [];
  const leafEntries = new Map();
  for (const [index, batch] of chains.entries()) {
    const batchNumber = index + 1;
    const multi = batch.chain.length > 1;
    const members = [];
    for (const [position, event] of batch.chain.entries()) {
      leafEntries.set(event.entryId, { batch: batchNumber, entryId: event.entryId });
      const oldActor = event.data.agentId;
      const newActor = multi ? `sub_${batchNumber}-${position + 1}` : `sub_${batchNumber}`;
      if (actorMap.has(oldActor)) return { excluded: 'ambiguous', diagnostics: [`Actor ${oldActor} belongs to more than one batch`], branch: scan.branch };
      const member = multi ? position + 1 : null;
      actorMap.set(oldActor, {
        oldActor, newActor, batch: batchNumber, member,
        name: event.data.actor.name ?? null,
        goal: event.data.spec.task,
        parentOld: batch.parent,
        parentNew: batch.parent === null || batch.parent === 'Main' ? null : batch.parent,
        depth: event.data.actor.depth,
        kind: event.data.spec.inheritContext === true ? 'inherited' : 'fresh',
        context: batch.context,
      });
      members.push({ oldActor, newActor, member });
    }
    batchRows.push({
      batch: batchNumber, startEntryId: batch.start.entryId, startOrdinal: batch.start.ordinal,
      parentOld: batch.parent, context: batch.context, createdBy: batch.createdBy,
      members, roster: members.map((member) => ({
        id: member.newActor,
        name: actorMap.get(member.oldActor).name,
        goal: actorMap.get(member.oldActor).goal,
      })),
    });
  }
  const mapActor = (old) => old === null || old === 'Main' ? null : actorMap.get(old)?.newActor ?? null;
  for (const row of batchRows) {
    row.parentNew = row.parentOld === null ? null : mapActor(row.parentOld);
    if (row.parentOld !== null && row.parentNew === null && row.parentOld !== 'Main') {
      return { excluded: 'ambiguous', diagnostics: [`Batch parent ${row.parentOld} is not a mapped Actor`], branch: scan.branch };
    }
  }
  for (const item of actorMap.values()) item.parentNew = item.parentOld === null ? null : mapActor(item.parentOld);

  const leafValidation = validateLeafBatches(scan, leafEntries);
  if (leafValidation.partialLeaves > 0) {
    return { excluded: 'ambiguous', diagnostics: [{
      code: 'partial_batch_leaf',
      message: 'A terminal root branch exposes only part of a proven batch roster.',
      leaves: leafValidation.leaves,
      partialLeaves: leafValidation.partialLeaves,
      partialBatches: leafValidation.partialBatches,
    }], branch: scan.branch, leafValidation };
  }

  const jobs = scan.harness.filter((event) => event.customType === 'subagent-job');
  const jobRows = [];
  const jobMap = new Map();
  const oldJobIds = new Set();
  const newJobIds = new Set();
  const initialByActor = new Map();
  for (const batch of chains) {
    for (const event of batch.chain) initialByActor.set(event.data.agentId, event);
  }
  for (const event of jobs) {
    const data = event.data;
    const oldJob = data.jobId;
    const oldActor = data.agentId;
    if (!text(oldJob) || !text(oldActor) || !actorMap.has(oldActor)) {
      return { excluded: 'ambiguous', diagnostics: [`Job ${String(oldJob)} has no mapped Actor`], branch: scan.branch };
    }
    // The old and new namespaces are independent. A mapped new id may equal a
    // different old source id; only actual duplicates inside either namespace
    // are collisions.
    if (oldJobIds.has(oldJob)) return { excluded: 'ambiguous', diagnostics: [`Job ${oldJob} is registered more than once`], branch: scan.branch };
    const mapped = actorMap.get(oldActor);
    let newJob;
    if (oldJob === oldActor) newJob = mapped.newActor;
    else if (oldJob.startsWith(`${oldActor}#r`)) newJob = `${mapped.newActor}${oldJob.slice(oldActor.length)}`;
    else return { excluded: 'ambiguous', diagnostics: [`Job ${oldJob} does not belong to ${oldActor}`], branch: scan.branch };
    if (newJobIds.has(newJob)) return { excluded: 'ambiguous', diagnostics: [`Mapped Job id ${newJob} is assigned more than once`], branch: scan.branch };
    oldJobIds.add(oldJob);
    newJobIds.add(newJob);
    jobMap.set(oldJob, newJob);
    jobRows.push({ oldJob, newJob, oldActor, event });
  }
  const jobByOld = new Map(jobRows.map((row) => [row.oldJob, row]));
  for (const row of jobRows) {
    const data = row.event.data;
    const continuation = !initialSpec(data);
    if (data.createdBy !== undefined && data.createdBy !== null && data.createdBy !== 'Main' && !actorMap.has(data.createdBy)) {
      return { excluded: 'ambiguous', diagnostics: [`Job ${row.oldJob} has unknown creator ${data.createdBy}`], branch: scan.branch };
    }
    if (data.continuedFromJobId != null) {
      const previous = jobByOld.get(data.continuedFromJobId);
      if (previous === undefined || previous.oldActor !== row.oldActor) {
        return { excluded: 'ambiguous', diagnostics: [`Job ${row.oldJob} has a missing/foreign continuation predecessor`], branch: scan.branch };
      }
    }
    if (continuation && data.continuedFromJobId == null) {
      return { excluded: 'ambiguous', diagnostics: [`Continuation Job ${row.oldJob} has no predecessor`], branch: scan.branch };
    }
  }

  const converted = [];
  const jobByEntry = new Map(jobRows.map((row) => [row.event.entryId, row]));
  const batchByNumber = new Map(batchRows.map((batch) => [batch.batch, batch]));
  const all = scan.harness;
  for (const event of all) {
    const data = event.data;
    if (event.customType === 'subagent-job') {
      const row = jobByEntry.get(event.entryId);
      if (row === undefined) return { excluded: 'ambiguous', diagnostics: [`Unmapped Job event ${event.entryId}`], branch: scan.branch };
      const mapped = actorMap.get(row.oldActor);
      const continuation = !initialSpec(data);
      if (continuation && !jobByOld.has(data.continuedFromJobId)) {
        return { excluded: 'ambiguous', diagnostics: [`Job ${row.oldJob} has no mapped predecessor`], branch: scan.branch };
      }
      const actor = {
        name: mapped.name, parentAgentId: mapped.parentNew, depth: mapped.depth,
        batch: mapped.batch, member: mapped.member, goal: mapped.goal,
        context: mapped.context, roster: batchByNumber.get(mapped.batch).roster,
        kind: mapped.kind,
      };
      const initial = initialByActor.get(row.oldActor);
      if (initial === undefined) return { excluded: 'ambiguous', diagnostics: [`Actor ${row.oldActor} has no initial Job`], branch: scan.branch };
      converted.push({
        entryId: event.entryId, customType: event.customType,
        data: {
          v: V3, jobId: row.newJob, agentId: mapped.newActor,
          ...(continuation ? {} : { actor }),
          index: continuation ? null : mapped.member === null ? 0 : mapped.member - 1,
          createdBy: data.createdBy === 'Main' ? 'main' : data.createdBy == null ? 'main' : actorMap.get(data.createdBy)?.newActor ?? 'main',
          continuedFromJobId: data.continuedFromJobId == null ? null : jobMap.get(data.continuedFromJobId),
          spec: continuation
            ? { kind: 'continuation', inheritedContext: stripInherited(initial.data.spec.inheritedContext) }
            : { kind: 'initial', inheritedContext: stripInherited(data.spec.inheritedContext) },
          origin: data.origin ?? null,
        },
      });
    } else if (event.customType === 'subagent-job-start' || event.customType === 'subagent-job-end') {
      const newJob = jobMap.get(data.jobId);
      if (newJob === undefined) return { excluded: 'ambiguous', diagnostics: [`${event.customType} references unknown Job ${data.jobId}`], branch: scan.branch };
      converted.push({ entryId: event.entryId, customType: event.customType, data: { ...data, v: V3, jobId: newJob } });
    } else if (event.customType === 'subagent-actor') {
      const mapped = actorMap.get(data.agentId);
      if (mapped === undefined) return { excluded: 'ambiguous', diagnostics: [`Actor event references unknown Actor ${data.agentId}`], branch: scan.branch };
      converted.push({ entryId: event.entryId, customType: event.customType, data: { ...translateIdentity(data), v: V3, agentId: mapped.newActor } });
    } else if (event.customType === 'subagent-anchor') {
      const mapped = actorMap.get(data.agentId);
      if (mapped === undefined) return { excluded: 'ambiguous', diagnostics: [`Anchor event references unknown Actor ${data.agentId}`], branch: scan.branch };
      converted.push({ entryId: event.entryId, customType: event.customType, data: { ...data, v: V3, agentId: mapped.newActor } });
    }
  }
  const refs = await childReference(scan, agentDir, actorMap);
  return {
    class: 'plan-v2',
    planReady: scan.source.stable && scan.branch.topologyValid && scan.parseErrors.length === 0,
    diagnostics: [],
    branch: scan.branch,
    mappings: {
      batches: batchRows,
      actors: [...actorMap.values()],
      jobs: jobRows.map((row) => {
        const mapped = actorMap.get(row.oldActor);
        const data = row.event.data;
        return {
          oldJob: row.oldJob, newJob: row.newJob,
          oldActor: row.oldActor, newActor: mapped.newActor,
          batch: mapped.batch, member: mapped.member,
          createdBy: data.createdBy === 'Main' || data.createdBy == null ? 'main' : actorMap.get(data.createdBy)?.newActor ?? 'main',
          parentAgentId: mapped.parentNew,
          continuedFromJobId: data.continuedFromJobId == null ? null : jobMap.get(data.continuedFromJobId),
        };
      }),
    },
    convertedEvents: converted,
    editStrategy: { kind: 'rewrite-harness-event-data-in-place', entryIdsPreserved: true, rootBranchesPreserved: true },
    childRefs: refs,
    leafValidation,
    counts: {
      v1: 0, v2: scan.counts.v2, v3: 0, unknownVersion: 0,
      initialJobs: proof.initial.length, continuationJobs: proof.continuations.length,
      batches: batchRows.length, actors: actorMap.size, convertedEvents: converted.length,
    },
  };
}

async function planRoot(scan, agentDir) {
  const base = {
    file: scan.file,
    source: scan.source,
    branch: scan.branch,
    counts: scan.counts,
    parseErrors: scan.parseErrors,
  };
  const hasHarness = scan.harness.length > 0;
  const legacy = scan.counts.v1 > 0;
  if (!hasHarness) {
    return legacy
      ? { ...base, class: 'excluded-v1', planReady: false, diagnostics: ['legacy v1 checkpoint has no v2 plan path'] }
      : { ...base, class: 'unchanged', planReady: false, diagnostics: [] };
  }
  if (scan.parseErrors.length > 0) return { ...base, class: 'excluded-malformed', planReady: false, diagnostics: scan.parseErrors };
  if (legacy) {
    const hasV2 = scan.counts.v2 > 0;
    return { ...base, class: hasV2 ? 'excluded-mixed' : 'excluded-v1', planReady: false,
      diagnostics: [hasV2 ? 'legacy v1 checkpoints are mixed with v2 events' : 'legacy v1 checkpoint has no v2 plan path'] };
  }
  if (scan.counts.unknownVersion > 0) return { ...base, class: 'excluded-ambiguous', planReady: false, diagnostics: ['harness events have an unknown version'] };
  if (scan.counts.v2 > 0 && scan.counts.v3 > 0) return { ...base, class: 'excluded-mixed', planReady: false, diagnostics: ['v2 and v3 events are mixed'] };
  if (scan.counts.v2 === 0 && scan.counts.v3 > 0) return { ...base, class: 'current-v3', planReady: false, diagnostics: [] };
  if (scan.counts.v2 === 0) return { ...base, class: 'excluded-ambiguous', planReady: false, diagnostics: ['unsupported harness version'] };
  const planned = await planV2(scan, agentDir);
  if (planned.excluded !== undefined) {
    return { ...base, class: `excluded-${planned.excluded}`, planReady: false,
      diagnostics: planned.diagnostics, branch: planned.branch ?? base.branch };
  }
  return { ...base, ...planned, class: 'plan-v2' };
}

async function main() {
  const { values } = parseArgs({ options: {
    'agent-dir': { type: 'string' }, session: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { process.stdout.write(`${usage()}\n`); return; }
  if (values['agent-dir'] === undefined && values.session === undefined) throw new Error(usage());
  let agentDir = values['agent-dir'] === undefined ? null : resolve(values['agent-dir']);
  let session = values.session === undefined ? null : resolve(values.session);
  if (agentDir === null && session !== null) {
    let cursor = dirname(session);
    while (dirname(cursor) !== cursor && cursor.split(/[\\/]/).at(-1) !== 'sessions') cursor = dirname(cursor);
    if (cursor.split(/[\\/]/).at(-1) !== 'sessions') throw new Error('Cannot derive --agent-dir from --session');
    agentDir = dirname(cursor);
  }
  if (agentDir === null) throw new Error('--agent-dir is required');
  let roots;
  if (session !== null) {
    const info = await lstat(session);
    if (info.isSymbolicLink() || !info.isFile() || !session.endsWith('.jsonl')) throw new Error('--session must be a regular .jsonl file');
    const sessionsDir = resolve(agentDir, 'sessions');
    if (!session.startsWith(`${sessionsDir}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('--session must live under <agent-dir>/sessions');
    roots = [session];
  } else {
    roots = await walkJsonl(resolve(agentDir, 'sessions'));
  }
  const rootsPlan = [];
  for (const file of roots) {
    try {
      const scan = await scanRoot(file);
      rootsPlan.push(await planRoot(scan, agentDir));
    } catch (error) {
      rootsPlan.push({ file, class: 'excluded-unreadable', planReady: false, diagnostics: [error instanceof Error ? error.message : String(error)] });
    }
  }
  const count = (name) => rootsPlan.filter((root) => root.class === name).length;
  const summary = {
    roots: rootsPlan.length,
    unchanged: count('unchanged'), currentV3: count('current-v3'), planned: count('plan-v2'),
    excludedV1: count('excluded-v1'), excludedMixed: count('excluded-mixed'),
    excludedMalformed: count('excluded-malformed'), excludedAmbiguous: count('excluded-ambiguous'),
    excludedUnreadable: count('excluded-unreadable'), excludedUnstable: count('excluded-unstable'), unstable: rootsPlan.filter((root) => root.class === 'excluded-unstable' || (root.class === 'plan-v2' && root.planReady !== true)).length,
    v2Events: rootsPlan.reduce((sum, root) => sum + (root.counts?.v2 ?? 0), 0),
    initialJobs: rootsPlan.reduce((sum, root) => sum + (root.counts?.initialJobs ?? 0), 0),
    continuationJobs: rootsPlan.reduce((sum, root) => sum + (root.counts?.continuationJobs ?? 0), 0),
    batches: rootsPlan.reduce((sum, root) => sum + (root.counts?.batches ?? 0), 0),
    actors: rootsPlan.reduce((sum, root) => sum + (root.counts?.actors ?? 0), 0),
  };
  const eligible = rootsPlan.every((root) => root.class === 'unchanged' || root.class === 'current-v3' || (root.class === 'plan-v2' && root.planReady === true));
  const plan = {
    version: PLAN_VERSION, mode: 'plan', planReady: eligible,
    requiresOfflineCheck: true, runtimeValidated: false,
    capabilityReferencesReconciled: false,
    initialToolReactivationRequired: true,
    inheritedCapabilityAssessmentRequired: true,
    limitations: [
      'Persisted Capability collection records in root or child native sessions may still name subagent_stop; this planner does not scan or rewrite them and they require separate Capability tool-reference reconciliation.',
      'Initial tool namespace activation may need to be repeated after migration.',
      'Inherited child Capability state requires later assessment.',
      'planReady is not apply permission: an offline check and runtime validation are still required.',
    ],
    agentDir, summary, roots: rootsPlan,
  };
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  if (values.output === undefined) process.stdout.write(json);
  else await writeFile(resolve(values.output), json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
