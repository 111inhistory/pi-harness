import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOwnedNdjsonServer, getAgentSocketPath, writeSocket } from '../../src/ipc/socket.ts';
import { formatMainEndpointPath } from '../../src/subagent/address.ts';
import { RootListener } from '../../src/subagent/listeners.ts';
import { SubagentError } from '../../src/subagent/runtime.ts';

test('a broadcast rejection keeps the failed recipients in the external response', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ipc-broadcast-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'aaaaaaa1');
  const listener = new RootListener({
    mainAddress: formatMainEndpointPath(sessionDir), socketRoot: root,
    mainDirectory: process.platform === 'win32' ? null : sessionDir,
    isAccepting: () => true, onError() {},
    receiveShell: async () => {},
    deliver: async () => ({ ok: false, to: 'aaaaaaa1:batch_2',
      sent: [{ to: 'aaaaaaa1:sub_2-1', jobId: 'sub_2-1#r2' }],
      errors: [{ to: 'aaaaaaa1:sub_2-2', code: 'agent_busy', message: 'finalizing' },
        { to: 'aaaaaaa1:sub_2-3', code: 'unknown_agent', message: 'no retained session' }],
    }),
  });
  t.after(() => listener.close());
  await listener.sync();
  await assert.rejects(writeSocket(formatMainEndpointPath(sessionDir),
    { from: 'aaaaaaa1:main', to: 'aaaaaaa1:batch_2', content: 'hello' }), error => {
    assert.ok(error instanceof Error && 'code' in error);
    assert.equal(error.code, 'broadcast_partial_failure');
    assert.match(error.message, /sub_2-2: finalizing/);
    assert.match(error.message, /sub_2-3: no retained session/);
    assert.doesNotMatch(error.message, /INTERNAL_SECRET|sub_2-1#r2/);
    return true;
  });
});

test('ordinary IPC failures do not expose arbitrary error details', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ipc-private-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A generic managed endpoint of this platform: a socket file or a pipe.
  const address = getAgentSocketPath('fixture', root);
  const server = createOwnedNdjsonServer({ address, root, onMessage() {
    throw new SubagentError('delivery_failed', 'Recipient unavailable.', { internal: 'PRIVATE_STATE' });
  } });
  t.after(() => server.close());
  await server.ready;
  await assert.rejects(writeSocket(address, { from: 'aaaaaaa1:main', to: 'aaaaaaa1:main', content: 'hello' }), {
    code: 'delivery_failed', message: 'Recipient unavailable.',
  });
});
