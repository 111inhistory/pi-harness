import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { foldEvents } from '../src/subagent/storage.ts';
import { createSubagentRuntime } from '../src/subagent/runtime.ts';

const SCRIPT = fileURLToPath(new URL('../scripts/plan-subagent-storage-v3.mjs', import.meta.url));
const ROOT = 'root0001';
const ORIGIN = { cwd: '/synthetic/work' };

function start() {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-v3-plan-'));
  const sessions = join(agentDir, 'sessions', 'project');
  mkdirSync(sessions, { recursive: true });
  return { agentDir, sessions };
}

function rootFile(sessions, name) {
  const file = join(sessions, name);
  writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: ROOT, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/synthetic/work' })}\n`);
  return file;
}

function append(file, entry) {
  writeFileSync(file, `${JSON.stringify(entry)}\n`, { flag: 'a' });
}

function job(id, parent, actor, index, spec, extra = {}) {
  return {
    type: 'custom', customType: 'subagent-job', id, parentId: parent, data: {
      v: 2, jobId: actor.agentId, agentId: actor.agentId, actor: {
        name: actor.name ?? null, parentAgentId: actor.parentAgentId ?? null, depth: actor.depth,
      },
      index, createdBy: 'Main', continuedFromJobId: null, spec, origin: ORIGIN, ...extra,
    },
  };
}

function execute(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 15000 });
}

function plan(agentDir, extra = []) {
  const result = execute(['--agent-dir', agentDir, ...extra]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('plans local ID mappings, branches, continuations and structured tools without user writes', () => {
  const { agentDir, sessions } = start();
  try {
    const file = rootFile(sessions, 'v2.jsonl');
    const childDir = join(agentDir, 'subagent-sessions', ROOT);
    mkdirSync(childDir, { recursive: true });
    const child = join(childDir, 'sub_01.jsonl');
    writeFileSync(child, 'NOT_JSON_CHILD_BODY');

    append(file, job('e1', null, { agentId: 'sub_01', name: null, parentAgentId: null, depth: 1 }, 0,
      { name: null, task: 'single goal', context: 'shared', inheritContext: false, inheritedContext: null }));
    append(file, { type: 'custom', customType: 'opaque', id: 'opaque', parentId: null, content: 'OPAQUE_TEXT subagent_stop' });
    append(file, { type: 'custom', customType: 'branch', id: 'branch', parentId: null });
    const seed = { systemPrompt: 'parent', warnings: ['seed'], entries: [{ type: 'message', content: 'RAW_INHERITED_BODY' }] };
    append(file, job('e2', 'branch', { agentId: 'sub_02', name: 'Alpha', parentAgentId: null, depth: 1 }, 0,
      { name: 'Alpha', task: 'multi one', context: 'shared', inheritContext: true, inheritedContext: seed }));
    append(file, job('e3', 'e2', { agentId: 'sub_03', name: null, parentAgentId: null, depth: 1 }, 1,
      { name: null, task: 'multi two', context: 'shared', inheritContext: true, inheritedContext: seed }));
    append(file, {
      type: 'custom', customType: 'subagent-job', id: 'e7', parentId: 'e3', data: {
        v: 2, jobId: 'sub_02#r2', agentId: 'sub_02', index: null, createdBy: 'Main',
        continuedFromJobId: 'sub_02', spec: { kind: 'continuation', name: 'Alpha' }, origin: ORIGIN,
      },
    });
    append(file, {
      type: 'custom', customType: 'subagent-job', id: 'e10', parentId: 'e7', data: {
        v: 2, jobId: 'sub_02#r3', agentId: 'sub_02', index: null, createdBy: 'Main',
        continuedFromJobId: 'sub_02#r2', spec: { kind: 'continuation', name: 'Alpha' }, origin: ORIGIN,
      },
    });
    append(file, { type: 'custom', customType: 'subagent-job-start', id: 'e4', parentId: 'e7', data: { v: 2, jobId: 'sub_01', startEntryId: 'n1' } });
    append(file, {
      type: 'custom', customType: 'subagent-job-end', id: 'e5', parentId: 'e4', data: {
        v: 2, jobId: 'sub_01', status: 'completed', error: null, result: 'done',
        history: { startEntryId: 'n1', endEntryId: 'n2' }, budget: null,
      },
    });
    append(file, {
      type: 'custom', customType: 'subagent-actor', id: 'e6', parentId: 'e5', data: {
        v: 2, agentId: 'sub_01', sessionFile: child, cwd: '/synthetic/work', trusted: true,
        allowInherited: false, roleId: null, roleInstructions: null, model: null, thinkingLevel: null,
        tools: ['read', 'subagent_stop'], excludedTools: ['subagent_stop'],
        preset: { name: 'p', config: { tools: ['+subagent_stop', '-read', 'subagent_signal'] } },
        assignment: 'OPAQUE_ASSIGNMENT subagent_stop', routed: false, anchor: 'n1',
      },
    });
    append(file, { type: 'custom', customType: 'subagent-anchor', id: 'e8', parentId: 'e6', data: { v: 2, agentId: 'sub_01', anchor: 'n2' } });
    append(file, job('e9', 'e1', { agentId: 'sub_04', name: 'Other', parentAgentId: null, depth: 1 }, 0,
      { name: 'Other', task: 'other branch', context: 'shared', inheritContext: true,
        inheritedContext: { systemPrompt: 'parent', warnings: [], entries: [{ type: 'message', content: 'RAW_INHERITED_BODY' }] } }));

    const sessionOnlyResult = execute(['--session', file]);
    assert.equal(sessionOnlyResult.status, 0, sessionOnlyResult.stderr);
    assert.equal(JSON.parse(sessionOnlyResult.stdout).summary.roots, 1);
    const result = plan(agentDir, ['--session', file]);
    assert.equal(result.planReady, true);
    assert.equal(result.requiresOfflineCheck, true);
    assert.equal(result.runtimeValidated, false);
    assert.equal(result.capabilityReferencesReconciled, false);
    assert.equal(result.initialToolReactivationRequired, true);
    assert.equal(result.inheritedCapabilityAssessmentRequired, true);
    assert.ok(result.limitations.some((line) => line.includes('Capability') && line.includes('subagent_stop')));
    assert.equal(result.summary.roots, 1);
    assert.equal(result.summary.v2Events, 10);
    assert.equal(result.summary.batches, 3);
    assert.equal(result.summary.initialJobs, 4);
    assert.equal(result.summary.continuationJobs, 2);
    const root = result.roots[0];
    assert.equal(root.class, 'plan-v2');
    assert.equal(root.source.hash.length, 64);
    assert.equal(root.branch.topologyValid, true);
    assert.equal(root.branch.headerId, ROOT);
    assert.deepEqual(root.editStrategy, { kind: 'rewrite-harness-event-data-in-place', entryIdsPreserved: true, rootBranchesPreserved: true });
    assert.equal(root.childRefs.laterCopyRefs, 1);
    assert.equal(root.childRefs.laterCopyBytes, 19);

    const byEntry = new Map(root.convertedEvents.map((event) => [event.entryId, event]));
    assert.equal(byEntry.get('e1').data.jobId, 'sub_1');
    assert.equal(byEntry.get('e2').data.jobId, 'sub_2-1');
    assert.equal(byEntry.get('e3').data.jobId, 'sub_2-2');
    assert.equal(byEntry.get('e7').data.jobId, 'sub_2-1#r2');
    assert.equal(byEntry.get('e9').data.jobId, 'sub_3');
    assert.deepEqual(byEntry.get('e2').data.actor.roster, [
      { id: 'sub_2-1', name: 'Alpha', goal: 'multi one' },
      { id: 'sub_2-2', name: null, goal: 'multi two' },
    ]);
    assert.deepEqual(byEntry.get('e1').data.actor.roster, [{ id: 'sub_1', name: null, goal: 'single goal' }]);
    assert.equal(byEntry.get('e7').data.spec.kind, 'continuation');
    assert.deepEqual(byEntry.get('e7').data.spec.inheritedContext, { systemPrompt: 'parent', warnings: ['seed'] });
    assert.deepEqual(byEntry.get('e10').data.spec.inheritedContext, { systemPrompt: 'parent', warnings: ['seed'] });
    assert.equal('actor' in byEntry.get('e7').data, false);
    assert.equal('actor' in byEntry.get('e10').data, false);
    assert.equal(byEntry.get('e1').data.actor.context, 'shared');
    assert.deepEqual(byEntry.get('e6').data.tools, ['read', 'subagent_signal']);
    assert.deepEqual(byEntry.get('e6').data.excludedTools, ['subagent_signal']);
    assert.deepEqual(byEntry.get('e6').data.preset.config.tools, ['+subagent_signal', '-read', 'subagent_signal']);
    assert.equal(byEntry.get('e6').data.assignment, 'OPAQUE_ASSIGNMENT subagent_stop');
    assert.equal(byEntry.get('e4').data.jobId, 'sub_1');
    assert.equal(byEntry.get('e5').data.jobId, 'sub_1');
    assert.equal(byEntry.get('e8').data.agentId, 'sub_1');
    const continuationMapping = root.mappings.jobs.find((item) => item.oldJob === 'sub_02#r2');
    assert.equal(continuationMapping.newJob, 'sub_2-1#r2');
    assert.equal(continuationMapping.createdBy, 'main');
    assert.equal(continuationMapping.parentAgentId, null);
    assert.equal(continuationMapping.continuedFromJobId, 'sub_2-1');
    assert.deepEqual(root.mappings.actors.find((item) => item.oldActor === 'sub_02'), {
      oldActor: 'sub_02', newActor: 'sub_2-1', batch: 2, member: 1, name: 'Alpha', goal: 'multi one',
      parentOld: null, parentNew: null, depth: 1, kind: 'inherited', context: 'shared',
    });
    assert.equal(JSON.stringify(result).includes('OPAQUE_TEXT'), false);
    assert.equal(JSON.stringify(result).includes('RAW_INHERITED_BODY'), false);
    assert.equal('entries' in byEntry.get('e9').data.spec.inheritedContext, false);
    assert.equal(JSON.stringify(byEntry.get('e6').data.tools).includes('subagent_stop'), false);
    assert.equal(JSON.stringify(byEntry.get('e6').data.preset).includes('subagent_stop'), false);
    assert.equal(JSON.stringify(root.mappings).includes('aaaaaaaa:'), false);
    assert.deepEqual([...byEntry.keys()].sort(), ['e1', 'e10', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']);
    assert.equal(readFileSync(child, 'utf8'), 'NOT_JSON_CHILD_BODY');
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

function appliedEntries(file, rootPlan) {
  const replacements = new Map(rootPlan.convertedEvents.map((event) => [event.entryId, event]));
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type !== 'session')
    .map((entry) => replacements.has(entry.id) ? { ...entry, data: replacements.get(entry.id).data } : entry);
}

function terminalBranches(entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const children = new Map();
  for (const entry of entries) {
    if (entry.parentId === null) continue;
    const list = children.get(entry.parentId) ?? [];
    list.push(entry.id);
    children.set(entry.parentId, list);
  }
  return entries.filter((entry) => !(children.get(entry.id)?.length)).map((leaf) => {
    const path = [];
    let id = leaf.id;
    while (id !== null && byId.has(id)) { path.push(byId.get(id)); id = byId.get(id).parentId; }
    return { leaf: leaf.id, path: path.reverse() };
  });
}

test('converted DATA folds and restores every terminal branch with local roster projection', async () => {
  const { agentDir, sessions } = start();
  try {
    const file = rootFile(sessions, 'fold.jsonl');
    const seed = { systemPrompt: 'parent', warnings: ['seed'], entries: [{ type: 'message', content: 'RAW' }] };
    append(file, job('e1', null, { agentId: 'sub_01', name: null, parentAgentId: null, depth: 1 }, 0,
      { task: 'single goal', context: 'shared', inheritContext: false, inheritedContext: null }));
    append(file, job('e2', null, { agentId: 'sub_02', name: 'Alpha', parentAgentId: null, depth: 1 }, 0,
      { task: 'multi one', context: 'shared', inheritContext: true, inheritedContext: seed }));
    append(file, job('e3', 'e2', { agentId: 'sub_03', name: null, parentAgentId: null, depth: 1 }, 1,
      { task: 'multi two', context: 'shared', inheritContext: true, inheritedContext: seed }));
    append(file, { type: 'custom', customType: 'subagent-job', id: 'e7', parentId: 'e3', data: {
      v: 2, jobId: 'sub_02#r2', agentId: 'sub_02', index: null, createdBy: 'Main',
      continuedFromJobId: 'sub_02', spec: { kind: 'continuation', name: 'Alpha' }, origin: ORIGIN,
    } });
    append(file, { type: 'custom', customType: 'subagent-job', id: 'e10', parentId: 'e7', data: {
      v: 2, jobId: 'sub_02#r3', agentId: 'sub_02', index: null, createdBy: 'Main',
      continuedFromJobId: 'sub_02#r2', spec: { kind: 'continuation', name: 'Alpha' }, origin: ORIGIN,
    } });
    append(file, { type: 'custom', customType: 'anchor', id: 'tail', parentId: 'e1' });

    const result = plan(agentDir, ['--session', file]);
    assert.equal(result.planReady, true);
    const root = result.roots[0];
    assert.equal(root.class, 'plan-v2');
    const entries = appliedEntries(file, root);
    const branches = terminalBranches(entries);
    const expected = new Map([
      ['tail', { actors: ['sub_1'], goals: ['single goal'], jobs: 1, round3: false }],
      ['e10', { actors: ['sub_2-1', 'sub_2-2'], goals: ['multi one', 'multi two'], jobs: 4, round3: true }],
    ]);
    assert.deepEqual(branches.map((branch) => branch.leaf).sort(), [...expected.keys()].sort());
    assert.equal(branches.length, 2);
    let checkedContinuation = false;
    for (const branch of branches) {
      const state = foldEvents(branch.path);
      const ids = state.actors.map((actor) => actor.agentId).sort();
      const want = expected.get(branch.leaf);
      if (want === undefined) {
        assert.deepEqual(state.actors, []);
        continue;
      }
      assert.deepEqual(ids, [...want.actors].sort(), `actors on branch ${branch.leaf}`);
      assert.deepEqual(state.actors.map((actor) => actor.goal).sort(), [...want.goals].sort());
      assert.equal(state.jobs.length, want.jobs);
      for (const actor of state.actors) {
        assert.equal(Object.hasOwn(actor.roster[0], 'id'), true);
        assert.equal(Object.hasOwn(actor.roster[0], 'address'), false);
      }
      const round3 = state.jobs.find((job) => job.jobId === 'sub_2-1#r3');
      assert.equal(round3 !== undefined, want.round3, `round 3 presence on ${branch.leaf}`);
      if (round3 !== undefined) {
        checkedContinuation = true;
        assert.equal(round3.continuedFromJobId, 'sub_2-1#r2');
        assert.deepEqual(round3.spec.inheritedContext, { systemPrompt: 'parent', warnings: ['seed'] });
      }
      const adapter = { started: [] };
      const runtime = createSubagentRuntime({
        session: 'bbbbbbbb',
        startJob: (request) => {
          let resolve;
          const done = new Promise((yes) => { resolve = yes; });
          const handle = { request, done, cancel() {}, resolve(value) { resolve(value); } };
          adapter.started.push(handle);
          return handle;
        },
        deliverMessage: async () => ({ accepted: true }),
      });
      runtime.restoreState(state);
      assert.deepEqual(runtime.list().agents.map((actor) => actor.agentId).sort(), [...want.actors].sort());
      const probe = want.actors.includes('sub_2-1') ? 'sub_2-1' : want.actors[0];
      const receipt = await runtime.sendMessage({ from: 'main', to: `bbbbbbbb:${probe}`, content: 'probe roster' });
      const request = adapter.started.find((item) => item.request.jobId === receipt.jobId)?.request;
      assert.ok(request);
      assert.ok(request.roster.every((entry) => entry.address.startsWith('bbbbbbbb:')));
      assert.deepEqual(request.roster.map((entry) => entry.address), state.actors.find((actor) => actor.agentId === probe).roster.map((entry) => `bbbbbbbb:${entry.id}`));
      for (const started of adapter.started) started.resolve({ result: 'probe' });
      await runtime.jobDone(receipt.jobId);
    }
    assert.equal(checkedContinuation, true);
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test('old and new Job id namespaces are independent', () => {
  const { agentDir, sessions } = start();
  try {
    const file = rootFile(sessions, 'nonidentity.jsonl');
    const oldIds = ['sub_10', 'sub_20', 'sub_21', 'sub_22', 'sub_23', 'sub_24', 'sub_25', 'sub_26', 'sub_27', 'sub_28'];
    let parent = null;
    for (const [index, oldId] of oldIds.entries()) {
      const entryId = `n${index}`;
      append(file, job(entryId, parent, { agentId: oldId, name: null, parentAgentId: null, depth: 1 }, 0,
        { task: `goal ${index}`, context: null, inheritContext: false, inheritedContext: null }));
      parent = entryId;
    }
    const result = plan(agentDir, ['--session', file]);
    assert.equal(result.planReady, true);
    assert.equal(result.summary.batches, 10);
    const mappings = new Map(result.roots[0].mappings.jobs.map((item) => [item.oldJob, item.newJob]));
    assert.equal(mappings.get('sub_10'), 'sub_1');
    assert.equal(mappings.get('sub_28'), 'sub_10');
    assert.equal(new Set(mappings.values()).size, 10);
    assert.equal(result.roots[0].class, 'plan-v2');
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test('classifies exclusions, v3/no-subagent, malformed JSON, partial batches and symlinks', () => {
  const { agentDir, sessions } = start();
  try {
    const v3 = rootFile(sessions, 'v3.jsonl');
    append(v3, { type: 'custom', customType: 'subagent-job', id: 'v3e', parentId: null,
      data: { v: 3, jobId: 'sub_1', agentId: 'sub_1', actor: {
        name: null, parentAgentId: null, depth: 1, batch: 1, member: null, goal: 'g', context: null,
        roster: [{ id: 'sub_1', name: null, goal: 'g' }], kind: 'fresh',
      }, index: 0, createdBy: 'main', continuedFromJobId: null, spec: { kind: 'initial', inheritedContext: null }, origin: null } });

    const v1 = rootFile(sessions, 'v1.jsonl');
    append(v1, { type: 'custom', customType: 'subagent-state', id: 'v1e', parentId: null, data: { version: 1, registry: { version: 1, actors: [], jobs: [] } } });

    const mixed = rootFile(sessions, 'mixed.jsonl');
    append(mixed, { type: 'custom', customType: 'subagent-state', id: 'm1', parentId: null, data: { version: 1 } });
    append(mixed, job('m2', null, { agentId: 'sub_01', name: null, parentAgentId: null, depth: 1 }, 0,
      { task: 'goal', context: null, inheritContext: false, inheritedContext: null }));

    const malformed = rootFile(sessions, 'malformed.jsonl');
    append(malformed, { type: 'custom', customType: 'opaque', id: 'bad', parentId: null });
    writeFileSync(malformed, '{not json}\n', { flag: 'a' });
    append(malformed, job('bad-job', null, { agentId: 'sub_01', name: null, parentAgentId: null, depth: 1 }, 0,
      { task: 'goal', context: null, inheritContext: false, inheritedContext: null }));

    const partial = rootFile(sessions, 'partial.jsonl');
    append(partial, job('p1', null, { agentId: 'sub_01', name: null, parentAgentId: null, depth: 1 }, 1,
      { task: 'goal', context: null, inheritContext: false, inheritedContext: null }));

    const clean = rootFile(sessions, 'clean.jsonl');
    append(clean, { type: 'message', id: 'msg', parentId: null, message: { role: 'user', content: 'no subagents' } });

    const partialLeaf = rootFile(sessions, 'partial-leaf.jsonl');
    append(partialLeaf, job('a1', null, { agentId: 'sub_01', name: null, parentAgentId: null, depth: 1 }, 0,
      { task: 'a', context: null, inheritContext: false, inheritedContext: null }));
    append(partialLeaf, job('a2', 'a1', { agentId: 'sub_02', name: null, parentAgentId: null, depth: 1 }, 1,
      { task: 'b', context: null, inheritContext: false, inheritedContext: null }));
    append(partialLeaf, { type: 'custom', customType: 'side', id: 'a3', parentId: 'a1' });

    const contradictory = rootFile(sessions, 'contradictory.jsonl');
    append(contradictory, job('c1', null, { agentId: 'sub_01', name: null, parentAgentId: null, depth: 1 }, 0,
      { task: 'c', context: null, inheritContext: false,
        inheritedContext: { systemPrompt: 'parent', warnings: [] } }));

    if (process.platform !== 'win32') symlinkSync(v3, join(sessions, 'ignored.jsonl'));

    const result = plan(agentDir);
    assert.equal(result.planReady, false);
    assert.deepEqual(result.roots.map((root) => root.class).sort(), [
      'current-v3', 'excluded-ambiguous', 'excluded-ambiguous', 'excluded-ambiguous',
      'excluded-malformed', 'excluded-mixed', 'excluded-v1', 'unchanged',
    ]);
    const root = (name) => result.roots.find((item) => item.file.endsWith(name));
    assert.equal(root('v1.jsonl').class, 'excluded-v1');
    assert.equal(root('mixed.jsonl').class, 'excluded-mixed');
    assert.equal(root('malformed.jsonl').class, 'excluded-malformed');
    assert.equal(root('partial.jsonl').class, 'excluded-ambiguous');
    assert.equal(root('partial-leaf.jsonl').class, 'excluded-ambiguous');
    assert.equal(root('partial-leaf.jsonl').diagnostics[0].code, 'partial_batch_leaf');
    assert.equal(root('contradictory.jsonl').class, 'excluded-ambiguous');
    assert.equal(root('v3.jsonl').class, 'current-v3');
    assert.equal(root('clean.jsonl').class, 'unchanged');
    assert.equal(result.summary.roots, 8, 'symlink roots are ignored');
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});


test('refuses to overwrite an existing output file and creates a private plan', () => {
  const { agentDir, sessions } = start();
  try {
    rootFile(sessions, 'root.jsonl');
    const existing = join(agentDir, 'existing.json');
    writeFileSync(existing, 'keep');
    const refused = execute(['--agent-dir', agentDir, '--output', existing]);
    assert.notEqual(refused.status, 0);
    assert.equal(readFileSync(existing, 'utf8'), 'keep');

    const output = join(agentDir, 'plan.json');
    const result = execute(['--agent-dir', agentDir, '--output', output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    if (process.platform !== 'win32') assert.equal(lstatSync(output).mode & 0o777, 0o600);
    const parsed = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(parsed.mode, 'plan');
    assert.equal(parsed.planReady, true);
    assert.equal(parsed.runtimeValidated, false);
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});
