import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AsyncShellHost } from '../../src/async-shell/host.ts';
import { createTask, taskDirectory } from '../../src/async-shell/tmux.ts';
import { validateAsyncShellFrame } from '../../src/async-shell/protocol.ts';
import { createOwnedNdjsonServer } from '../../src/ipc/socket.ts';
import { pipePath } from '../../src/ipc/address.ts';

function rootFixture(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'async-shell-id-'));
  const previous = process.env.PI_ASYNC_SHELL_ROOT;
  process.env.PI_ASYNC_SHELL_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_ASYNC_SHELL_ROOT;
    else process.env.PI_ASYNC_SHELL_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('host task lookup and retirement retain the assigned root when ambient state changes', async t => {
  const root = rootFixture(t);
  const canceled: string[][] = [];
  const host = new AsyncShellHost({
    address: () => '/tmp/project/fake.sock', accepting: () => true,
    deliver: async () => {}, wake: () => {},
    cancel: async (directory, assignedRoot) => { canceled.push([directory, assignedRoot]); },
  });
  const env = host.environment('Main');
  process.env.PI_ASYNC_SHELL_ROOT = path.join(root, 'other');
  assert.equal(host.environment('Main').PI_ASYNC_SHELL_ROOT, root);
  const id = 'job_11111111';
  const directory = taskDirectory(id, env.PI_ASYNC_SHELL_ROOT);
  await host.receive('Main', {
    kind: 'async-shell', operation: 'register', id, directory, pid: process.pid,
    token: env.PI_ASYNC_SHELL_TOKEN,
  });
  await host.release('Main');
  assert.deepEqual(canceled, [[directory, root]]);
  await host.close();
});

const backendAvailable = spawnSync(process.platform === 'win32' ? 'psmux' : 'tmux', ['-V']).status === 0;

test('an ID collision preserves the existing task and explicit refusal sends no completion', {
  skip: !backendAvailable, timeout: 20_000,
}, async t => {
  const root = rootFixture(t);
  const existing = taskDirectory('job_11111111');
  fs.mkdirSync(existing, { mode: 0o700 });
  fs.writeFileSync(path.join(existing, 'task.json'), 'existing task\n');
  const frames: string[] = [];
  const socket = process.platform === 'win32' ? pipePath(root, 'host') : path.join(root, 'host.sock');
  const server = createOwnedNdjsonServer({
    address: socket, root,
    onMessage(input) {
      const frame = validateAsyncShellFrame(input);
      frames.push(frame.operation);
      throw Object.assign(new Error('Fixture refused registration.'), { code: 'registration_rejected' });
    },
    onError() {},
  });
  await server.ready;
  t.after(() => server.close());
  const ids = ['11111111', '22222222'];
  t.mock.method(crypto, 'randomBytes', (size: number) => {
    assert.equal(size, 4);
    const next = ids.shift();
    assert.ok(next, 'allocation must finish after the free ID');
    return Buffer.from(next, 'hex');
  });
  await assert.rejects(createTask({
    argv: [process.execPath, '-e', 'throw new Error("must not run")'],
    cwd: root, waitMs: 0, timeoutMs: null, callback: { socket, token: 'fixture-token' },
  }), /Fixture refused registration/);
  assert.equal(fs.readFileSync(path.join(existing, 'task.json'), 'utf8'), 'existing task\n');
  const allocated = taskDirectory('job_22222222');
  assert.equal(JSON.parse(fs.readFileSync(path.join(allocated, 'task.json'), 'utf8')).id, 'job_22222222');
  assert.equal(fs.existsSync(path.join(allocated, 'closed')), true);
  assert.deepEqual(frames, ['register'], 'a proven refusal has no task to unregister');
});
