import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { AsyncShellHost } from '../../src/async-shell/host.ts';
import type { ShellResult } from '../../src/async-shell/protocol.ts';

const id = 'job_11111111';
const directory = path.join(os.tmpdir(), `pi-async-shell-${process.getuid?.() ?? 0}`, id);
const result: ShellResult = {
  id, status: 'completed', exitCode: 0, output: 'done\n', cursor: 5,
  logPath: path.join(directory, 'output.log'), truncated: false,
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function fixture(options: { deliver?: () => Promise<void>; cancel?: () => Promise<void> } = {}) {
  const events: string[] = [];
  const host = new AsyncShellHost({
    accepting: () => true,
    address: owner => `/tmp/project/${owner}.sock`,
    deliver: async owner => { events.push(`deliver:${owner}`); await options.deliver?.(); },
    wake: owner => { events.push(`wake:${owner}`); },
    cancel: async () => { events.push('cancel'); await options.cancel?.(); },
  });
  const frame = (owner: string) => ({
    kind: 'async-shell', token: host.environment(owner).PI_ASYNC_SHELL_TOKEN,
    operation: 'register', id, directory, pid: process.pid,
  });
  return { host, events, frame };
}

test('completion stays owned until its result is queued, then releases the same Agent', async () => {
  const gate = deferred();
  const { host, events, frame } = fixture({ deliver: () => gate.promise });
  const register = frame('sub_1');
  await host.receive('sub_1', register);
  assert.equal(host.hasPending('sub_1'), true);
  assert.equal(host.hasPending('Main'), false);
  const delivery = host.receive('sub_1', { ...register, operation: 'complete', notify: true, result });
  assert.equal(host.hasPending('sub_1'), true);
  assert.deepEqual(events, ['deliver:sub_1']);
  gate.resolve();
  await delivery;
  assert.equal(host.hasPending('sub_1'), false);
  assert.deepEqual(events, ['deliver:sub_1', 'wake:sub_1']);
  await host.close();
});

test('a synchronous result releases its task without another completion message', async () => {
  const { host, events, frame } = fixture();
  const register = frame('Main');
  await host.receive('Main', register);
  await host.receive('Main', { ...register, operation: 'complete', notify: false, result });
  assert.equal(host.hasPending('Main'), false);
  assert.deepEqual(events, ['wake:Main']);
  await host.close();
});

test('execution tokens isolate recipients and fence revoked execution callbacks', async () => {
  const { host, frame } = fixture();
  const old = frame('sub_1');
  frame('sub_2');
  await assert.rejects(host.receive('sub_2', old), /no longer owns/);
  await assert.rejects(host.receive('sub_1', { ...old, directory: '/tmp/project/foreign-task' }), /does not match/);
  assert.equal(host.hasPending('sub_1'), false);
  await host.receive('sub_1', old);
  await host.release('sub_1');
  const next = frame('sub_1');
  assert.notEqual(next.token, old.token);
  await assert.rejects(host.receive('sub_1', old), /no longer owns/);
  await assert.rejects(host.receive('sub_1', { ...next, operation: 'complete', notify: true, result }), /Unknown async shell/);
  await host.close();
});

test('retiring execution retains its resource fence until task cancellation finishes', async () => {
  const gate = deferred();
  const { host, events, frame } = fixture({ cancel: () => gate.promise });
  const register = frame('sub_1');
  await host.receive('sub_1', register);
  const retiring = host.release('sub_1');
  assert.throws(() => host.environment('sub_1'), /still retiring/);
  await host.receive('sub_1', { ...register, operation: 'complete', notify: true, result });
  assert.deepEqual(events, ['cancel'], 'retirement accepts cleanup without another model turn');
  assert.equal(host.hasPending('sub_1'), true);
  gate.resolve();
  await retiring;
  assert.equal(host.hasPending('sub_1'), false);
  await host.close();
});

test('failed result handoff is never replayed and does not retain a phantom task', async () => {
  const { host, events, frame } = fixture({ deliver: async () => { throw new Error('uncertain handoff'); } });
  const register = frame('sub_1');
  await host.receive('sub_1', register);
  await assert.rejects(host.receive('sub_1', { ...register, operation: 'complete', notify: true, result }), /uncertain handoff/);
  assert.equal(host.hasPending('sub_1'), false);
  assert.deepEqual(events, ['deliver:sub_1', 'wake:sub_1']);
  await host.close();
});

test('cleanup failure keeps the execution fenced instead of authorizing a replacement', async () => {
  const { host, frame } = fixture({ cancel: async () => { throw new Error('monitor still alive'); } });
  await host.receive('sub_1', frame('sub_1'));
  await assert.rejects(host.release('sub_1'), /did not all stop/);
  assert.throws(() => host.environment('sub_1'), /still retiring/);
  assert.equal(host.hasPending('sub_1'), true);
  await assert.rejects(host.close(), /did not retire all tasks/);
});
