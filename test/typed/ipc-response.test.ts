import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOwnedNdjsonServer, getAgentSocketPath, writeSocket } from '../../src/ipc/socket.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: test.TestContext, onMessage: (value: unknown) => unknown) {
  const root = await mkdtemp(path.join(tmpdir(), 'ipc-response-'));
  const address = getAgentSocketPath('receiver', root);
  const server = createOwnedNdjsonServer({ address, root, onMessage });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  await server.ready;
  return address;
}

/**
 * One raw request, answered on the same connection. The client writes without
 * half-closing (a Windows Named Pipe has no half-close that flushes the request),
 * collects through the response newline, then drops the connection.
 */
function rawResponse(address: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = '';
    const client = net.connect(address, () => client.write('{"from":"Main","content":"hello"}\n'));
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      response += chunk;
      if (!response.includes('\n')) return;
      client.destroy();
      resolve(response);
    });
    client.on('error', reject);
  });
}

test('socket returns an asynchronous delivery error on the native platform transport', async (t) => {
  const address = await fixture(t, async () => { throw Object.assign(new Error('Agent is stopping.'), { code: 'agent_busy' }); });
  await assert.rejects(writeSocket(address, { from: 'Main', content: 'hello' }), { code: 'agent_busy', message: 'Agent is stopping.' });
});

test('socket success waits for asynchronous delivery and returns no value', async (t) => {
  const started = gate();
  const finish = gate();
  t.after(() => finish.resolve());
  const address = await fixture(t, async () => { started.resolve(); await finish.promise; });
  let returned = false;
  const result = writeSocket(address, { from: 'Main', content: 'hello' }).then((value) => { returned = true; return value; });
  await started.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  finish.resolve();
  assert.equal(await result, undefined);
});

test('wire success is empty and wire failure contains only the error', async (t) => {
  const success = await fixture(t, () => undefined);
  assert.equal(await rawResponse(success), '\n');
  const failure = await fixture(t, async () => { throw Object.assign(new Error('Agent is stopping.'), { code: 'agent_busy' }); });
  assert.deepEqual(JSON.parse(await rawResponse(failure)), { code: 'agent_busy', message: 'Agent is stopping.' });
  await assert.rejects(writeSocket(failure, { from: 'Main', content: 'hello' }), { code: 'agent_busy', message: 'Agent is stopping.' });
});

test('socket timeout does not retry a delivery that may already be accepted', async (t) => {
  const finish = gate();
  let calls = 0;
  t.after(() => finish.resolve());
  const address = await fixture(t, async () => { calls += 1; await finish.promise; });
  await assert.rejects(writeSocket(address, { from: 'Main', content: 'hello' }, { timeoutMs: 200 }), { code: 'timeout' });
  finish.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});
