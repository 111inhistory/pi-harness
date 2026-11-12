import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AsyncShellHost } from '../../src/async-shell/host.ts';
import { taskDirectory } from '../../src/async-shell/task-path.ts';

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
