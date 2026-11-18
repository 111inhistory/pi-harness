import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { SessionManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { RootService } from '../../src/subagent/root-service.ts';
import type { NativeJobOutcome } from '../../src/subagent/native-types.ts';
import { deferred } from '../../test-support/async.ts';

async function fixture(t: TestContext, initialize = true) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-local-ready-'));
  const manager = SessionManager.inMemory(cwd);
  const context = { cwd, sessionManager: manager, modelRegistry: { find: () => undefined }, isIdle: () => true } as unknown as ExtensionContext;
  const api = { appendEntry() {}, getAllTools: () => [], getActiveTools: () => [], sendMessage() {} } as unknown as ExtensionAPI;
  let current = true;
  const service = new RootService({ api, context, agentDir: path.join(cwd, 'agent'), allocatedIds: new Set(), ownsContext: () => current });
  if (initialize) await service.initialize();
  t.after(async () => { await service.retire(); await rm(cwd, { recursive: true, force: true }); });
  const options = { parentAgentId: null, allowInherited: true,
    origin: { cwd, trusted: true, sessionId: manager.getSessionId(), agentId: null, mode: 'test' },
    captureInheritedContext: () => null };
  return { service, expire: () => { current = false; },
    create: () => service.create({ context: 'READY_CONTEXT', agents: [{ goal: 'READY_TASK' }] }, options, context) };
}

test('the public list/signal caller is canonical main only', async t => {
  const { service } = await fixture(t);
  // `Main` is not a second key: a host caller must pass the canonical `main`.
  await assert.rejects(service.list({}, 'Main'), { code: 'unknown_agent' });
  assert.ok(await service.list({}, 'main'), 'the canonical caller reaches the root tree');
  assert.throws(() => service.signal('main', 'stop', 'Main'), { code: 'invalid_target' });
});

test('a root that lost its generation cannot inspect, observe or signal', async t => {
  const { service, expire } = await fixture(t);
  expire();
  await assert.rejects(service.list({}, 'main'), /not accepting new operations/);
  for (const operation of [
    () => service.signal('main', 'stop', 'main'),
    () => service.liveSnapshot('sub_1'),
    () => service.liveEndEntryId('sub_1'),
    () => service.subscribeJobEvents('sub_1', () => {}),
  ]) assert.throws(operation, /not accepting new operations/);
});

test('create returns after each started session reports local readiness', async t => {
  const { service, create } = await fixture(t);
  const sessionReady = deferred();
  const done = deferred<NativeJobOutcome>();
  let started = 0;
  service.runner.start = () => {
    started++;
    return { ready: sessionReady.promise, done: done.promise, cancel: () => done.resolve({ status: 'cancelled' }) };
  };
  let returned = false;
  const creation = create().then(result => { returned = true; return result; });
  await Promise.resolve();
  assert.equal(started, 1, 'the batch is registered and started synchronously');
  assert.equal(returned, false, 'a started Job does not certify a prepared session');
  sessionReady.resolve();
  const result = await creation;
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.role, null);
  assert.equal(result.items[0]?.model, null);
  assert.equal(returned, true, 'create does not await task completion');
  done.resolve({ status: 'completed', result: 'DONE' });
  await service.runtime.jobDone(result.items[0]!.id);
});

test('a failed main endpoint latches at initialize and every tool reports it', async t => {
  const { service } = await fixture(t, false);
  t.mock.method(service.listeners, 'sync', async () => { throw new Error('LISTENER_START_FAILURE'); });
  await service.initialize();
  await assert.rejects(service.list({}, 'main'), /LISTENER_START_FAILURE/);
  assert.throws(() => service.signal('main', 'stop', 'main'), /LISTENER_START_FAILURE/);
  assert.equal(service.active, false, 'a failed root never starts work');
});
