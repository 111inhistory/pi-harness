import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatMainEndpointPath } from '../../src/subagent/address.ts';
import { RootListener } from '../../src/subagent/listeners.ts';
import { writeSocket } from '../../src/ipc/socket.ts';
import { taskDirectory } from '../../src/async-shell/task-path.ts';
import { AsyncShellHost } from '../../src/async-shell/host.ts';

// Callbacks reach the root's one endpoint and are routed by Actor + token.
test('async shell callbacks share the root main endpoint and cannot target siblings', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-shell-ipc-'));
  const socketRoot = path.join(root, 'sockets');
  const sessionDir = path.join(socketRoot, 'aaaaaaa1');
  const main = formatMainEndpointPath(sessionDir);
  const delivered: string[] = [];
  const host = new AsyncShellHost({
    mainAddress: () => main, accepting: () => true,
    deliver: async owner => { delivered.push(owner); }, wake() {}, cancel: async () => {},
  });
  let agentMessages = 0;
  const listener = new RootListener({
    mainAddress: main, socketRoot, mainDirectory: sessionDir,
    isAccepting: () => true,
    deliver: async input => { agentMessages++; return { ok: true, to: input.to, jobId: null }; },
    receiveShell: (owner, frame) => host.receive(owner, frame), onError() {},
  });
  t.after(async () => {
    await host.close();
    await listener.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  await listener.sync();
  const environment = host.environment('sub_1');
  host.environment('sub_2');
  const frame = {
    kind: 'async-shell', agentId: 'sub_1', operation: 'register', id: 'job_11111111',
    token: environment.PI_ASYNC_SHELL_TOKEN,
    directory: taskDirectory('job_11111111'), pid: process.pid, pty: true,
  };
  // The same token presented under another Actor's name cannot claim the lease.
  await assert.rejects(writeSocket(main, { ...frame, agentId: 'sub_2' }), /no longer owns/);
  await writeSocket(main, frame);
  assert.equal(host.hasPending('sub_1'), true);
  await writeSocket(main, {
    ...frame, operation: 'complete', notify: true,
    result: { id: frame.id, status: 'completed', exitCode: 0, output: 'done', cursor: 4,
      window: { firstLine: 1, headLines: 0, headBytes: 0, tailFirstLine: 1, totalLines: 1 },
      logPath: path.join(root, 'output.log'), truncated: false },
  });
  assert.equal(host.hasPending('sub_1'), false);
  assert.deepEqual(delivered, ['sub_1']);
  assert.equal(agentMessages, 0, 'a callback never enters Agent message admission');
});
