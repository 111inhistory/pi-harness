import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { createMessageWriteTool } from '../../src/subagent/message-write.ts';
import type { ManagedWriteHost } from '../../src/subagent/managed-send.ts';
import { getAgentSocketPath, getBroadcastSocketPath } from '../../src/ipc/socket.ts';

const context = (cwd: string): ExtensionToolContext => ({ cwd }) as ExtensionToolContext;
/** A real managed endpoint address for this platform: a socket file or a pipe. */
const agentPath = (cwd: string, name = 'sub_01'): string => getAgentSocketPath(name, cwd);
const broadcastPath = (cwd: string): string => getBroadcastSocketPath('main', cwd);
async function fixture(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'managed-write-'));
  try { await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}
function host(overrides: Partial<ManagedWriteHost> = {}): ManagedWriteHost {
  return {
    resolveEndpoint: async () => ({ isManaged: true, targetId: 'sub_01' }),
    sessionEndpoint: async () => ({ kind: 'local' }),
    sendMessage: async ({ to }) => ({ ok: true, to, jobId: to }),
    sendCrossSession: async () => {},
    ...overrides,
  };
}

test('msg_write sends exact caller text with a host-bound sender and no routing metadata', async () => {
  await fixture(async cwd => {
    const calls: unknown[] = [];
    const tool = createMessageWriteTool({ cwd, senderId: 'main', host: host({
      sendMessage: async command => { calls.push(command); return { ok: true, to: command.to, jobId: 'sub_01#r2' }; },
    }) });
    const content = '{"from":"fake"}\nsecond line';
    const result = await tool.execute('message', { path: agentPath(cwd), content }, undefined, undefined, context(cwd));
    assert.equal(result.details, undefined);
    assert.match(JSON.stringify(result.content), /Successfully sent message/);
    assert.deepEqual(calls, [{ from: 'Main', to: 'sub_01', content }]);
  });
});

test('invalid or unmanaged paths never send and broadcast ownership remains enforced', async () => {
  await fixture(async cwd => {
    let sends = 0;
    const cases = [
      { endpoint: { isManaged: false }, path: agentPath(cwd), code: 'unmanaged_endpoint' },
      { endpoint: { isManaged: true, isBroadcast: true, parentId: 'sub_02' }, path: broadcastPath(cwd), code: 'invalid_target' },
      { endpoint: { isManaged: true }, path: agentPath(cwd), code: 'unknown_endpoint' },
    ];
    for (const entry of cases) {
      const tool = createMessageWriteTool({ cwd, senderId: 'Main', host: host({
        resolveEndpoint: async () => entry.endpoint,
        sendMessage: async ({ to }) => { sends++; return { ok: true, to, jobId: to }; },
      }) });
      await assert.rejects(tool.execute('refused', { path: entry.path, content: 'hello' }, undefined, undefined, context(cwd)), { code: entry.code });
    }
    assert.equal(sends, 0);
  });
});

test('managed addresses pass through unchanged and pre-abort prevents admission', async () => {
  await fixture(async cwd => {
    const resolved: string[] = [];
    const tool = createMessageWriteTool({ cwd, senderId: 'sub_01', host: host({
      resolveEndpoint: async address => { resolved.push(address); return { isManaged: true, targetId: 'Main' }; },
    }) });
    const address = getAgentSocketPath('Main', cwd);
    await tool.execute('native', { path: address, content: 'hello' }, undefined, undefined, context(cwd));
    assert.deepEqual(resolved, [address], 'a managed endpoint address is written unchanged, never re-resolved');
    await assert.rejects(tool.execute('cancelled', { path: address, content: 'hello' }, AbortSignal.abort(), undefined, context(cwd)), { code: 'cancelled' });
    assert.equal(resolved.length, 1);
    // A relative Unix socket file is resolved against the caller's working
    // directory; a Windows pipe name is not a filesystem path.
    if (process.platform !== 'win32') {
      await tool.execute('relative', { path: 'Main.sock', content: 'hello' }, undefined, undefined, context(cwd));
      assert.deepEqual(resolved.at(-1), path.join(cwd, 'Main.sock'));
    }
  });
});

test('partial broadcast fails instead of returning file-write success', async () => {
  await fixture(async (cwd) => {
    const tool = createMessageWriteTool({ cwd, senderId: 'Main', host: host({
      resolveEndpoint: async () => ({ isManaged: true, isBroadcast: true, parentId: 'main' }),
      sendMessage: async () => ({ ok: false, to: 'all', sent: [{ to: 'sub_01', jobId: 'sub_01' }],
        errors: [{ to: 'sub_02', code: 'agent_busy', message: 'finalizing' }] }),
    }) });
    await assert.rejects(tool.execute('broadcast', { path: broadcastPath(cwd), content: 'hello' }, undefined, undefined, context(cwd)),
      { code: 'delivery_failed', message: 'sub_02: finalizing' });
  });
});

test('delivery rejection or timeout propagates as a failed write without retry', async () => {
  await fixture(async (cwd) => {
    for (const failure of [new Error('recipient unavailable'), Object.assign(new Error('delivery timed out'), { code: 'timeout' })]) {
      let calls = 0;
      const tool = createMessageWriteTool({ cwd, senderId: 'Main', host: host({
        sendMessage: async () => { calls += 1; throw failure; },
      }) });
      await assert.rejects(tool.execute('failed', { path: agentPath(cwd), content: 'hello' }, undefined, undefined, context(cwd)),
        (error: unknown) => error === failure);
      assert.equal(calls, 1);
    }
  });
});

test('a pending write cannot report success before delivery and concurrent failures stay isolated', async () => {
  await fixture(async (cwd) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let completed = false;
    const tool = createMessageWriteTool({ cwd, senderId: 'Main', host: host({
      sendMessage: async ({ content, to }) => {
        if (content === 'fail') throw new Error('rejected');
        await gate;
        return { ok: true, to, jobId: 'internal-job' };
      },
    }) });
    const success = tool.execute('pending', { path: agentPath(cwd), content: 'wait' }, undefined, undefined, context(cwd))
      .then((result) => { completed = true; return result; });
    await assert.rejects(tool.execute('failed', { path: agentPath(cwd, 'sub_02'), content: 'fail' }, undefined, undefined, context(cwd)), /rejected/);
    assert.equal(completed, false);
    release();
    assert.equal((await success).details, undefined);
  });
});
