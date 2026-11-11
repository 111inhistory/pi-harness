import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { SessionManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { RootService } from '../../src/subagent/root-service.ts';
import type { NativeJobOutcome } from '../../src/subagent/native-types.ts';
import { deferred } from '../../test-support/async.ts';

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-local-ready-'));
  const manager = SessionManager.inMemory(cwd);
  const context = { cwd, sessionManager: manager, modelRegistry: { find: () => undefined }, isIdle: () => true } as unknown as ExtensionContext;
  const api = { appendEntry() {}, getAllTools: () => [], getActiveTools: () => [], sendMessage() {} } as unknown as ExtensionAPI;
  let current = true;
  const service = new RootService({ api, context, agentDir: path.join(cwd, 'agent'), allocatedIds: new Set(), ownsContext: () => current });
  await service.initialize();
  t.after(async () => { await service.retire(); await rm(cwd, { recursive: true, force: true }); });
  const options = { parentAgentId: null, allowInherited: true,
    origin: { cwd, trusted: true, sessionId: manager.getSessionId(), agentId: null, mode: 'test' },
    captureInheritedContext: () => null };
  return { service, expire: () => { current = false; },
    create: () => service.create({ tasks: [{ task: 'READY_TASK' }] }, options, context) };
}

test('a root that lost its generation cannot inspect, observe or cancel', async t => {
  const { service, expire } = await fixture(t);
  expire();
  await assert.rejects(service.list({}, 'Main'), /not accepting new operations/);
  for (const operation of [
    () => service.stop('all'),
    () => service.liveSnapshot('sub_01'),
    () => service.liveEndEntryId('sub_01'),
    () => service.subscribeJobEvents('sub_01', () => {}),
  ]) assert.throws(operation, /not accepting new operations/);
});

test('IPC readiness gates native startup and create waits for session readiness', async t => {
  const { service, create } = await fixture(t);
  const listeners = deferred();
  const sessionReady = deferred();
  const done = deferred<NativeJobOutcome>();
  let started = 0;
  t.mock.method(service.listeners, 'sync', () => listeners.promise);
  service.runner.start = () => {
    started++;
    return { ready: sessionReady.promise, done: done.promise, cancel: () => done.resolve({ status: 'cancelled' }) };
  };
  let returned = false;
  const creation = create().then(result => { returned = true; return result; });
  await Promise.resolve();
  assert.equal(started, 0, 'no native run starts before its endpoints are ready');
  listeners.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(started, 1);
  assert.equal(returned, false, 'endpoints alone do not certify a prepared session');
  sessionReady.resolve();
  const result = await creation;
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.role, null);
  assert.equal(result.items[0]?.model, null);
  assert.equal(returned, true, 'create does not await task completion');
  done.resolve({ status: 'completed', result: 'DONE' });
  await service.runtime.jobDone(result.items[0]!.id);
});

test('listener startup failure rejects create without running a child', async t => {
  const { service, create } = await fixture(t);
  let started = 0;
  t.mock.method(service.listeners, 'sync', async () => { throw new Error('LISTENER_START_FAILURE'); });
  service.runner.start = () => { started++; throw new Error('must not run'); };
  await assert.rejects(create(), /LISTENER_START_FAILURE/);
  assert.equal(started, 0);
  const id = service.runtime.list().agents[0]!.agentId;
  assert.equal((await service.runtime.jobDone(id)).status, 'failed');
});

test('cancel before listener readiness prevents native startup and rejects create', async t => {
  const { service, create } = await fixture(t);
  const listeners = deferred();
  let started = 0;
  t.mock.method(service.listeners, 'sync', () => listeners.promise);
  service.runner.start = () => { started++; throw new Error('must not run'); };
  const creation = create();
  const id = service.runtime.list().agents[0]!.agentId;
  service.stop(id);
  listeners.resolve();
  await assert.rejects(creation, /startup was cancelled/);
  assert.equal(started, 0);
  assert.equal((await service.runtime.jobDone(id)).status, 'cancelled');
});
