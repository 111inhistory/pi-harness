import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { ConfigStaleError, createAsyncSlotToken, createConfigLifecycle, createSyncSlotToken } from '../../src/config-lifecycle.ts';
import { deferred } from '../../test-support/async.ts';
import { checkProperty } from '../../test-support/pbt.ts';

const trusted = { cwd: '/project', isProjectTrusted: () => true };
const untrusted = { cwd: '/project', isProjectTrusted: () => false };

test('binding is cold; equality and failures retain only a same-scope snapshot', async () => {
  const lifecycle = createConfigLifecycle();
  let source = 'first';
  let reads = 0;
  const token = createSyncSlotToken({ name: 'leaf', refreshable: true, equals: Object.is,
    load() {
      reads += 1;
      if (source === '') throw new Error('broken');
      return source;
    },
  });
  const slot = lifecycle.bindSyncSlot(token);
  const second = lifecycle.bindSyncSlot(token);
  assert.equal(reads, 0);
  const first = slot.read(trusted);
  assert.equal(second.read(trusted), first);
  assert.deepEqual(await lifecycle.refreshLeaves(trusted), [{ name: 'leaf', status: 'unchanged' }]);
  source = '';
  const [failure] = await lifecycle.refreshLeaves(trusted);
  assert.equal(failure?.status === 'failed' && failure.keptPrevious, true);
  assert.equal(slot.read(trusted), first);
  assert.throws(() => slot.read(untrusted), /broken/);
  assert.equal(slot.peek(untrusted), undefined);
  source = 'second';
  assert.deepEqual(await lifecycle.refreshLeaves(untrusted), [{ name: 'leaf', status: 'updated' }]);
  assert.equal(slot.read(untrusted).value, 'second');
});

test('a late async read and its cleanup cannot affect the next session', async () => {
  const lifecycle = createConfigLifecycle();
  const old = deferred<string>();
  const next = deferred<string>();
  let reads = 0;
  const token = createAsyncSlotToken<string>({ name: 'leaf' });
  const slot = lifecycle.bindAsyncSlot(token, () => (++reads === 1 ? old.promise : next.promise));
  const first = slot.read(trusted);
  const coalesced = slot.read(trusted);
  await Promise.resolve();
  assert.equal(reads, 1);
  lifecycle.reset(true);
  lifecycle.reset(false);
  const current = slot.read(trusted);
  await Promise.resolve();
  assert.equal(reads, 2);
  old.resolve('old');
  await assert.rejects(first, ConfigStaleError);
  await assert.rejects(coalesced, ConfigStaleError);
  const joined = slot.read(trusted);
  next.resolve('next');
  assert.equal((await current).value, 'next');
  assert.equal(await joined, await current);
  assert.equal(reads, 2);
});

test('refresh waits for a pending read; a scope change fences a rejected refresh', async () => {
  const lifecycle = createConfigLifecycle();
  const initial = deferred<string>();
  const refresh = deferred<string>();
  const refreshStarted = deferred();
  let reads = 0;
  const token = createAsyncSlotToken<string>({ name: 'leaf', refreshable: true });
  const slot = lifecycle.bindAsyncSlot(token, () => {
    if (++reads === 1) return initial.promise;
    refreshStarted.resolve();
    return refresh.promise;
  });
  const first = slot.read(trusted);
  const reloading = lifecycle.refreshLeaves(trusted);
  await Promise.resolve();
  assert.equal(reads, 1);
  initial.resolve('first');
  assert.equal((await first).value, 'first');
  await refreshStarted.promise;
  assert.equal(slot.peek(untrusted), undefined);
  refresh.reject(new Error('late failure'));
  await assert.rejects(reloading, ConfigStaleError);
  assert.equal(slot.peek(untrusted), undefined);
});

test('slot refresh and read match the scoped snapshot model', async () => {
  await checkProperty(fc.asyncProperty(fc.array(fc.constantFrom('read', 'refresh', 'switch', 'reset', 'edit', 'break'), { minLength: 24, maxLength: 32 }), async operations => {
    let source: number | undefined = 0;
    let value: number | undefined;
    let broken = false;
    let context = trusted;
    const lifecycle = createConfigLifecycle();
    const token = createSyncSlotToken({ name: 'leaf', refreshable: true, equals: Object.is,
      load() { if (source === undefined) throw new Error('broken'); return source; },
    });
    const slot = lifecycle.bindSyncSlot(token);
    for (const [index, operation] of operations.entries()) {
      switch (operation) {
        case 'reset': lifecycle.reset(false); value = undefined; broken = false; break;
        case 'switch':
          context = context === trusted ? untrusted : trusted;
          assert.equal(slot.peek(context), undefined);
          value = undefined;
          broken = false;
          break;
        case 'edit': source = index + 1; break;
        case 'break': source = undefined; break;
        case 'read':
          if (value === undefined && !broken) { value = source; broken = source === undefined; }
          if (broken) assert.throws(() => slot.read(context), /broken/);
          else assert.equal(slot.read(context).value, value);
          break;
        case 'refresh': {
          const [result] = await lifecycle.refreshLeaves(context);
          if (source === undefined) {
            assert.equal(result?.status, 'failed');
            if (result?.status === 'failed') assert.equal(result.keptPrevious, value !== undefined);
            broken = value === undefined;
          } else {
            assert.equal(result?.status, source === value ? 'unchanged' : 'updated');
            value = source;
            broken = false;
          }
          break;
        }
      }
    }
  }));
});
