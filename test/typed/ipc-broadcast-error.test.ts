import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOwnedNdjsonServer, getBroadcastSocketPath, writeSocket } from '../../src/ipc/socket.ts';
import { AgentListeners } from '../../src/subagent/listeners.ts';
import { SubagentError } from '../../src/subagent/runtime.ts';

test('broadcast rejection keeps failed recipients in the external IPC response', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ipc-broadcast-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const listeners = new AgentListeners({ socketDir: root, baseSocketDir: root, sessionId: 'test-session', maxDepth: 2, actors: () => [],
    isAccepting: () => true, onError() {}, send: async () => ({ ok: false, to: 'all',
      sent: [{ to: 'sub_01', jobId: 'sub_01#r2' }],
      errors: [{ to: 'sub_02', code: 'agent_busy', message: 'finalizing' },
        { to: 'sub_03', code: 'unknown_agent', message: 'no retained session' }],
    }),
  });
  t.after(() => listeners.close());
  await listeners.sync();
  await assert.rejects(writeSocket(getBroadcastSocketPath('Main', root), { from: 'Main', content: 'hello' }), error => {
    assert.ok(error instanceof Error && 'code' in error);
    assert.equal(error.code, 'broadcast_partial_failure');
    assert.match(error.message, /sub_02: finalizing/);
    assert.match(error.message, /sub_03: no retained session/);
    assert.doesNotMatch(error.message, /INTERNAL_SECRET|sub_01#r2/);
    return true;
  });
});

test('ordinary IPC failures do not expose arbitrary error details', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ipc-private-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const address = path.join(root, 'sub_01.sock');
  const server = createOwnedNdjsonServer({ address, root, onMessage() {
    throw new SubagentError('delivery_failed', 'Recipient unavailable.', { internal: 'PRIVATE_STATE' });
  } });
  t.after(() => server.close());
  await server.ready;
  await assert.rejects(writeSocket(address, { from: 'Main', content: 'hello' }), {
    code: 'delivery_failed', message: 'Recipient unavailable.',
  });
});
