import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { EVENTS, createSubagentStore, foldEvents, withoutEntries, writeJsonlAtomic } from '../src/subagent-storage.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-storage-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = [];
  const make = (name = 'children', branch = root) => createSubagentStore({
    dir: join(dir, name), readBranch: () => branch, readEntries: () => root,
    appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data: structuredClone(data), id: `r${root.length}` }),
    openSession: (file, cwd) => SessionManager.open(file, undefined, cwd),
  });
  return { dir, root, make, store: make() };
}
const job = (jobId = 'sub_01') => ({ jobId, agentId: 'sub_01', actor: { name: 'test', parentAgentId: null, depth: 1 }, spec: { task: 'work' }, continuedFromJobId: null });
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text, textSignature: 'opaque-text' },
  { type: 'thinking', thinking: 'recorded', thinkingSignature: 'opaque-thinking' }], api: 'openai-codex-responses', provider: 'openai-codex', model: 'test',
  usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } }, stopReason: 'stop', timestamp: 1 });
function conversation(store) {
  const { manager, file } = store.openForAppend('sub_01', null, null);
  const start = manager.appendMessage({ role: 'user', content: 'initial', timestamp: 0 });
  const end = manager.appendMessage(assistant('answer'));
  return { manager, file, start, end };
}

test('durability requires all native callbacks; memory mode writes nothing', () => {
  const memory = createSubagentStore({ appendEntry: () => assert.fail('must not persist') });
  assert.equal(memory.durable, false);
  memory.append(EVENTS.job, job());
  assert.deepEqual(memory.load(), { actors: [], jobs: [] });
  assert.throws(() => memory.childFile('sub_01'), { code: 'storage_unavailable' });
});

test('root lifecycle is folded incrementally; identity patches preserve large unchanged fields', (t) => {
  const { store, root } = fixture(t);
  store.append(EVENTS.job, job());
  store.append(EVENTS.actor, { agentId: 'sub_01', sessionFile: '/a.jsonl', roleInstructions: 'large role', anchor: 'a' });
  store.append(EVENTS.actor, { agentId: 'sub_01', model: { provider: 'p', id: 'm' } });
  store.append(EVENTS.jobStart, { jobId: 'sub_01', startEntryId: 'a' });
  store.append(EVENTS.jobEnd, { jobId: 'sub_01', status: 'completed', result: 'result', history: { startEntryId: 'a', endEntryId: 'b' } });
  const state = store.load();
  assert.equal(state.actors[0].record.roleInstructions, 'large role');
  assert.equal(state.actors[0].record.model.id, 'm');
  assert.equal(state.actors[0].anchor, 'b');
  assert.equal(state.jobs[0].startEntryId, 'a');
  assert.equal(state.jobs[0].end.result, 'result');
  assert.equal(root.filter((entry) => JSON.stringify(entry).includes('large role')).length, 1);
});

test('rewind reads only its root branch while IDs remain reserved across all branches and files', (t) => {
  const { store, make, root } = fixture(t);
  store.append(EVENTS.job, job());
  store.append(EVENTS.jobEnd, { jobId: 'sub_01', status: 'completed' });
  const rewind = make('children', root.slice(0, 1));
  assert.equal(rewind.load().jobs[0].end, null);
  assert.ok(rewind.takenIds().has('sub_01'));
  conversation(store);
  assert.ok(rewind.takenIds().has('sub_01'));
});

test('malformed event versions, duplicate registration and unknown ownership fail closed', (t) => {
  const { root, store } = fixture(t);
  store.append(EVENTS.job, job());
  assert.throws(() => foldEvents([...root, ...root]), { code: 'storage_corrupt' });
  assert.throws(() => foldEvents([{ type: 'custom', customType: EVENTS.job, data: { v: 1 } }]), { code: 'storage_corrupt' });
  assert.deepEqual(foldEvents([{ type: 'custom', customType: 'subagent-state', data: { version: 1 } }]), { actors: [], jobs: [] });
  assert.throws(() => foldEvents([{ type: 'custom', customType: EVENTS.actor, data: { v: 2, agentId: 'missing' } }]), { code: 'storage_corrupt' });
});

test('inherited seed drops harness bookkeeping, relinks parents and preserves opaque native blocks', (t) => {
  const { store } = fixture(t);
  const entries = [
    { type: 'session', version: 3, id: 'parent', timestamp: new Date().toISOString(), cwd: '/parent' },
    { type: 'message', id: 'a', parentId: null, timestamp: new Date().toISOString(), message: assistant('signed') },
    { type: 'custom', id: 'host', parentId: 'a', customType: EVENTS.job, data: { huge: 'not inherited' } },
    { type: 'message', id: 'b', parentId: 'host', timestamp: new Date().toISOString(), message: { role: 'user', content: 'next', timestamp: 1 } },
  ];
  const { file, seedLeafId } = store.writeSeed('sub_01', entries, '/child');
  const manager = SessionManager.open(file);
  assert.equal(seedLeafId, 'b');
  assert.notEqual(manager.getSessionId(), 'parent');
  assert.equal(manager.getEntry('b').parentId, 'a');
  assert.equal(manager.getEntry('a').message.content[1].thinkingSignature, 'opaque-thinking');
  assert.equal(manager.getEntry('host'), undefined);
  assert.equal(entries[3].parentId, 'host', 'parent snapshot is untouched');
  assert.throws(() => store.writeSeed('sub_01', entries, '/child'), { code: 'storage_seed_conflict' });
});

test('v1 checkpoints coexist with v2 events without mutation or runtime migration', (t) => {
  const { root, store } = fixture(t);
  const legacy = { type: 'custom', customType: 'subagent-state', data: { version: 1, actors: { old: { untouched: true } } } };
  root.push(legacy);
  const before = structuredClone(legacy);
  store.append(EVENTS.job, job());
  store.append(EVENTS.jobEnd, { jobId: 'sub_01', status: 'completed', result: 'v2 result' });
  assert.equal(store.load().jobs[0].end.result, 'v2 result');
  assert.equal(store.load().actors.length, 1);
  assert.deepEqual(legacy, before);
});

test('filter rewrites only affected entry links and does not duplicate native payloads', () => {
  const a = { id: 'a', parentId: null }, drop = { id: 'x', parentId: 'a' }, b = { id: 'b', parentId: 'x', message: assistant('body') };
  const result = withoutEntries([a, drop, b], (entry) => entry === drop);
  assert.equal(result[0], a);
  assert.equal(result[1].parentId, 'a');
  assert.equal(result[1].message, b.message);
});

test('native history uses sealed branch bounds rather than file order or latest leaf', (t) => {
  const { store } = fixture(t);
  const { manager, file, start, end } = conversation(store);
  manager.branch(start);
  const alternate = manager.appendMessage(assistant('alternate'));
  assert.deepEqual(store.readSlice(file, start, end).map((entry) => entry.id), [end]);
  assert.deepEqual(store.readSlice(file, start, alternate).map((entry) => entry.id), [alternate]);
  assert.throws(() => store.readSlice(file, end, alternate), { code: 'storage_history_unavailable' });
  assert.throws(() => store.readSlice(file, null, 'missing'), { code: 'storage_history_unavailable' });
});

test('interrupted tail follows descendants; recorded-turn probe excludes inherited and later turns', (t) => {
  const { store } = fixture(t);
  const { manager, file, start, end } = conversation(store);
  assert.equal(store.interruptedEnd(file, start), end);
  assert.equal(store.hasRecordedTurn(file, end, end), false);
  manager.appendMessage({ role: 'user', content: 'new job', timestamp: 2 });
  assert.equal(store.hasRecordedTurn(file, end, end), false);
  assert.equal(store.hasRecordedTurn(file, end, null), true);
});

test('fork is copy-on-write; rewind reuses its own copy and never changes the parent file', (t) => {
  const { store, make } = fixture(t);
  const { file, start } = conversation(store);
  const original = readFileSync(file, 'utf8');
  const fork = make('fork');
  const copied = fork.openForAppend('sub_01', file, start);
  assert.notEqual(copied.file, file);
  assert.equal(copied.manager.getLeafId(), start);
  const future = copied.manager.appendMessage(assistant('fork answer'));
  const rewound = fork.openForAppend('sub_01', file, start);
  assert.equal(rewound.manager.getLeafId(), start);
  assert.ok(rewound.manager.getEntry(future));
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.throws(() => fork.openForAppend('sub_01', file, 'missing'), { code: 'storage_seed_conflict' });
});

test('native reads do not leave managers cached; live readers can reuse their manager', (t) => {
  const { store } = fixture(t);
  const { file, manager, start, end } = conversation(store);
  assert.notEqual(store.read(file), store.read(file));
  assert.deepEqual(store.readSlice(file, start, end, manager).map((entry) => entry.id), [end]);
});

test('JSONL writer is incremental and cleans up a failed temporary file', (t) => {
  const { dir } = fixture(t);
  const file = join(dir, 'records.jsonl');
  let count = 0;
  writeJsonlAtomic(file, (function* () { for (let i = 0; i < 100; i++) { count++; yield { i }; } })());
  assert.equal(count, 100);
  const previous = readFileSync(file, 'utf8');
  assert.equal(previous.trim().split('\n').length, 100);
  assert.throws(() => writeJsonlAtomic(file, (function* () { yield { ok: true }; throw new Error('write failed'); })()), /write failed/);
  assert.equal(readFileSync(file, 'utf8'), previous);
  assert.deepEqual(readdirSync(dir), ['records.jsonl']);
  assert.equal(existsSync(file), true);
});

test('fresh native files record the actor cwd rather than the harness process cwd', (t) => {
  const { store, dir } = fixture(t);
  const cwd = join(dir, 'actor-workspace');
  const { manager } = store.openForAppend('sub_01', null, null, cwd);
  assert.equal(manager.getCwd(), cwd);
  assert.equal(manager.getHeader().cwd, cwd);
});

test('root append failures are explicit storage errors', (t) => {
  const { dir } = fixture(t);
  const store = createSubagentStore({ dir, readBranch: () => [], readEntries: () => [], openSession: SessionManager.open,
    appendEntry: () => { throw new Error('disk full'); } });
  assert.throws(() => store.append(EVENTS.job, job()), { code: 'storage_write_failed' });
});
