import assert from 'node:assert/strict';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { IpcOwnershipError } from '../../src/ipc/endpoint.ts';
import { writeSocket } from '../../src/ipc/socket.ts';
import { formatMainEndpointPath } from '../../src/subagent/address.ts';
import { RootListener } from '../../src/subagent/listeners.ts';
import { SubagentError, type BroadcastReceipt } from '../../src/subagent/runtime.ts';

async function socketRoot(t: test.TestContext): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-root-listener-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

/** One root session directory candidate; the listener creates it on bind. */
function sessionDirectory(root: string): string {
  return path.join(root, 'aaaaaaa1');
}

function listener(root: string, overrides: Partial<ConstructorParameters<typeof RootListener>[0]> = {}): RootListener {
  const sessionDir = sessionDirectory(root);
  return new RootListener({
    mainAddress: formatMainEndpointPath(sessionDir),
    socketRoot: root,
    mainDirectory: process.platform === 'win32' ? null : sessionDir,
    isAccepting: () => true,
    deliver: async input => ({ ok: true, to: input.to, jobId: null }),
    receiveShell: async () => {},
    onError: () => {},
    ...overrides,
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function canConnect(address: string): Promise<boolean> {
  const client = net.connect(address);
  try {
    await once(client, 'connect');
    return true;
  } catch {
    return false;
  } finally {
    client.destroy();
  }
}

test('the root binds exactly one endpoint and no per-Actor or broadcast address exists', async t => {
  const root = await socketRoot(t);
  const server = listener(root);
  t.after(() => server.close());
  await server.sync();

  const main = formatMainEndpointPath(sessionDirectory(root));
  assert.equal(await canConnect(main), true, 'the main endpoint is reachable');
  for (const stale of [
    path.join(sessionDirectory(root), 'sub_1.sock'),
    path.join(sessionDirectory(root), 'children.sock'),
    path.join(sessionDirectory(root), 'main', 'children.sock'),
  ]) {
    assert.equal(await canConnect(stale), false, `no per-Actor or broadcast endpoint is bound: ${stale}`);
  }
});

test('a message frame reaches the root delivery port once with its logical from/to', async t => {
  const root = await socketRoot(t);
  const delivered: Array<{ from: string; to: string; content: string }> = [];
  const server = listener(root, {
    deliver: async input => { delivered.push(input); return { ok: true, to: input.to, jobId: null }; },
  });
  t.after(() => server.close());
  await server.sync();

  const frame = { from: 'aaaaaaa1:sub_1', to: 'aaaaaaa1:main', content: 'line one\nline two' };
  await writeSocket(formatMainEndpointPath(sessionDirectory(root)), frame);
  assert.deepEqual(delivered, [frame], 'the frame is delivered as one message with a canonical sender and target');
});

test('malformed frames are refused at the boundary and never reach delivery', async t => {
  const root = await socketRoot(t);
  const delivered: unknown[] = [];
  const errors: Error[] = [];
  const server = listener(root, {
    deliver: async input => { delivered.push(input); return { ok: true, to: input.to, jobId: null }; },
    onError: error => { errors.push(error); },
  });
  t.after(() => server.close());
  await server.sync();

  const address = formatMainEndpointPath(sessionDirectory(root));
  for (const frame of [
    { to: 'aaaaaaa1:main', content: 'missing sender' },
    { from: '   ', to: 'aaaaaaa1:main', content: 'blank sender' },
    { from: 'aaaaaaa1:sub_1', content: 'missing target' },
    { from: 'aaaaaaa1:sub_1', to: '', content: 'blank target' },
    { from: 'aaaaaaa1:sub_1', to: 'aaaaaaa1:main', content: 7 },
  ]) {
    await assert.rejects(writeSocket(address, frame), { code: 'invalid_message' });
  }
  assert.deepEqual(delivered, []);
  assert.deepEqual(errors.map(errorCode), Array(5).fill('invalid_message'));
});

test('an async shell frame is routed by its named Actor and never enters message admission', async t => {
  const root = await socketRoot(t);
  const shell: Array<{ actorId: string; frame: unknown }> = [];
  const delivered: unknown[] = [];
  const server = listener(root, {
    deliver: async input => { delivered.push(input); return { ok: true, to: input.to, jobId: null }; },
    receiveShell: async (actorId, frame) => { shell.push({ actorId, frame }); },
  });
  t.after(() => server.close());
  await server.sync();

  const address = formatMainEndpointPath(sessionDirectory(root));
  const frame = { kind: 'async-shell', agentId: 'sub_1', token: 'token-a', operation: 'register',
    id: 'job_11111111', directory: path.join(root, 'job_11111111'), pid: process.pid };
  await writeSocket(address, frame);
  assert.deepEqual(shell, [{ actorId: 'sub_1', frame }]);
  assert.deepEqual(delivered, [], 'a shell callback never becomes an Agent message');

  const { agentId: _omitted, ...unnamed } = frame;
  await assert.rejects(writeSocket(address, unnamed), { code: 'invalid_message' });
  assert.equal(shell.length, 1, 'a shell frame must name its Actor');
});

test('broadcast receipts surface partial failures as one error with the failing recipients', async t => {
  const root = await socketRoot(t);
  const receipt: BroadcastReceipt = {
    ok: false,
    to: 'aaaaaaa1:batch_2',
    sent: [{ to: 'aaaaaaa1:sub_2-1', jobId: 'sub_2-1' }],
    errors: [{ to: 'aaaaaaa1:sub_2-2', code: 'agent_busy', message: 'Agent sub_2-2 is stopping.' }],
  };
  const errors: Error[] = [];
  const server = listener(root, {
    deliver: async () => receipt,
    onError: error => { errors.push(error); },
  });
  t.after(() => server.close());
  await server.sync();

  await assert.rejects(
    writeSocket(formatMainEndpointPath(sessionDirectory(root)),
      { from: 'aaaaaaa1:main', to: 'aaaaaaa1:batch_2', content: 'family status' }),
    { code: 'broadcast_partial_failure' },
  );
  assert.equal(errors.length, 1);
});

test('binding failure releases the partial endpoint and reports the refusal', async t => {
  const root = await socketRoot(t);
  const first = listener(root);
  t.after(() => first.close());
  await first.sync();

  const second = listener(root, { onError: () => {} });
  await assert.rejects(second.sync(), (error: unknown) => error instanceof IpcOwnershipError && error.code === 'ipc_endpoint_in_use');
  await second.close();
  assert.equal(await canConnect(formatMainEndpointPath(sessionDirectory(root))), true,
    'the refused instance did not remove the live endpoint it did not bind');
});

test('close releases only the endpoint it bound and then the empty owned session directory', async t => {
  const root = await socketRoot(t);
  const server = listener(root);
  await server.sync();
  const main = formatMainEndpointPath(sessionDirectory(root));
  const directory = sessionDirectory(root);
  const identity = (await fsp.stat(directory)).ino;

  await server.close();
  assert.equal(await canConnect(main), false, 'the bound endpoint is released');
  await assert.rejects(fsp.stat(directory), (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    'the now-empty directory this root created is removed');
  assert.ok(identity > 0);
  await server.close();
});

test('a replaced endpoint or a non-empty directory is preserved on close', async t => {
  const root = await socketRoot(t);
  const server = listener(root);
  await server.sync();
  const main = formatMainEndpointPath(sessionDirectory(root));
  // An unrelated file in the directory means it is no longer ours to remove.
  await fsp.writeFile(path.join(sessionDirectory(root), 'user-data'), 'keep');
  await server.close();
  assert.equal((await fsp.readFile(path.join(sessionDirectory(root), 'user-data'), 'utf8')), 'keep');
  assert.equal(await canConnect(main), false);
  await fsp.rm(sessionDirectory(root), { recursive: true, force: true });
});

test('a closed root refuses new frames and reports the refusal to the sender', async t => {
  const root = await socketRoot(t);
  const server = listener(root);
  await server.sync();
  const address = formatMainEndpointPath(sessionDirectory(root));
  // Keep a client connected across close so the endpoint is destroyed mid-flight.
  const client = net.connect(address);
  await once(client, 'connect');
  const closing = server.close();
  client.destroy();
  await closing;
  await assert.rejects(
    writeSocket(address, { from: 'aaaaaaa1:sub_1', to: 'aaaaaaa1:main', content: 'late' }),
    (error: unknown) => errorCode(error) === 'ENOENT' || errorCode(error) === 'missing_response',
  );
});

test('a delivery refusal keeps its code and is not retried', async t => {
  const root = await socketRoot(t);
  const errors: Error[] = [];
  const deliveries: unknown[] = [];
  const server = listener(root, {
    deliver: async input => {
      deliveries.push(input);
      throw new SubagentError('cross_session_target', 'An external frame may only address this session.');
    },
    onError: error => { errors.push(error); },
  });
  t.after(() => server.close());
  await server.sync();

  await assert.rejects(
    writeSocket(formatMainEndpointPath(sessionDirectory(root)),
      { from: 'bbbbbbb2:main', to: 'aaaaaaa1:main', content: 'hello' }),
    { code: 'cross_session_target' },
  );
  assert.equal(deliveries.length, 1);
  assert.deepEqual(errors.map(errorCode), ['cross_session_target']);
});
