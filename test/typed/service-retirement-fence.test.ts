import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceLifecycle, ServiceRetirementTimeoutError } from '../../src/session/service-lifecycle.ts';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const drain = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

test('retirement deadline reports failure but does not release native resource fence', async () => {
  const nativeExit = deferred();
  const lifecycle = new ServiceLifecycle<{ active: boolean }>({
    retirementTimeoutMs: 5,
    retire: () => nativeExit.promise,
  });
  const first = await lifecycle.activate(async () => ({ active: true }));
  await assert.rejects(lifecycle.retire(), ServiceRetirementTimeoutError);
  assert.equal(lifecycle.retiring, true);
  let created = false;
  await assert.rejects(lifecycle.activate(async () => { created = true; return { active: true }; }), ServiceRetirementTimeoutError);
  assert.equal(created, false, 'replacement cannot reopen a still-owned child file');
  await assert.rejects(lifecycle.retire(), ServiceRetirementTimeoutError);
  nativeExit.resolve();
  await drain();
  assert.equal(lifecycle.retiring, false);
  const next = await lifecycle.activate(async () => ({ active: true }));
  assert.notEqual(next, first);
  await lifecycle.retire();
});

test('adapter failure is not evidence of native quiescence', async () => {
  const failure = new Error('cleanup failed before exit was known');
  const lifecycle = new ServiceLifecycle<{ active: boolean }>({ retire: async () => { throw failure; } });
  await lifecycle.activate(async () => ({ active: true }));
  await assert.rejects(lifecycle.retire(), (error: unknown) => error === failure);
  assert.equal(lifecycle.retiring, true);
  await assert.rejects(lifecycle.activate(async () => ({ active: true })), (error: unknown) => error === failure);
  assert.equal(lifecycle.service, null);
});

test('unpublished generation cleanup receives the same bounded retirement fence', async () => {
  const createGate = deferred();
  const nativeExit = deferred();
  let creationStarted = false;
  const lifecycle = new ServiceLifecycle<{ active: boolean }>({ retirementTimeoutMs: 5, retire: () => nativeExit.promise });
  const creating = lifecycle.activate(async () => { creationStarted = true; await createGate.promise; return { active: true }; });
  await drain();
  assert.equal(creationStarted, true);
  const retiring = lifecycle.retire();
  const creatingRejected = assert.rejects(creating, ServiceRetirementTimeoutError);
  const retiringRejected = assert.rejects(retiring, ServiceRetirementTimeoutError);
  createGate.resolve();
  await Promise.all([creatingRejected, retiringRejected]);
  assert.equal(lifecycle.retiring, true);
  nativeExit.resolve();
  await drain();
  assert.equal(lifecycle.retiring, false);
});
