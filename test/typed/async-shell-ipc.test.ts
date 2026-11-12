import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AgentListeners } from '../../src/subagent/listeners.ts';
import { getAgentSocketPath, getBroadcastSocketPath, writeSocket } from '../../src/ipc/socket.ts';
import { taskDirectory } from '../../src/async-shell/task-path.ts';
import { AsyncShellHost } from '../../src/async-shell/host.ts';

// The callback uses the owning endpoint without entering Agent message admission.
test('async shell callbacks share Agent endpoints and cannot target siblings or broadcasts', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-shell-ipc-'));
  const delivered: string[] = [];
  const host = new AsyncShellHost({
    address: owner => getAgentSocketPath(owner, root), accepting: () => true,
    deliver: async owner => { delivered.push(owner); }, wake() {}, cancel: async () => {},
  });
  let agentMessages = 0;
  const listeners = new AgentListeners({
    socketDir: root, baseSocketDir: root, sessionId: 'fake-session', maxDepth: 2,
    actors: () => [{ agentId: 'sub_01', parentAgentId: null, depth: 1 }],
    isAccepting: () => true,
    send: async command => { agentMessages++; return { ok: true, to: command.to, jobId: null }; },
    receiveShell: (owner, frame) => host.receive(owner, frame), onError() {},
  });
  t.after(async () => { await host.close(); await listeners.close(); await fsp.rm(root, { recursive: true, force: true }); });
  await listeners.sync();
  const environment = host.environment('sub_01');
  host.environment('Main');
  const frame = {
    kind: 'async-shell', operation: 'register', id: 'job_11111111',
    token: environment.PI_ASYNC_SHELL_TOKEN, directory: taskDirectory('job_11111111'), pid: process.pid,
  };
  await assert.rejects(writeSocket(getAgentSocketPath('Main', root), frame), /no longer owns/);
  await assert.rejects(writeSocket(getBroadcastSocketPath('sub_01', root), frame), /owning Agent endpoint/);
  await writeSocket(getAgentSocketPath('sub_01', root), frame);
  assert.equal(host.hasPending('sub_01'), true);
  await writeSocket(getAgentSocketPath('sub_01', root), {
    ...frame, operation: 'complete', notify: true,
    result: { id: frame.id, status: 'completed', exitCode: 0, output: 'done', cursor: 4, logPath: path.join(root, 'output.log'), truncated: false },
  });
  assert.equal(host.hasPending('sub_01'), false);
  assert.deepEqual(delivered, ['sub_01']);
  assert.equal(agentMessages, 0);
});
