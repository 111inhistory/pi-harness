import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { createMessageWriteTool, type ManagedWriteHost } from '../../src/subagent/message-write.ts';

const context = (cwd: string): ExtensionToolContext => ({ cwd }) as ExtensionToolContext;
async function fixture(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'managed-write-'));
  try { await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}
function host(overrides: Partial<ManagedWriteHost> = {}): ManagedWriteHost {
  return {
    resolveEndpoint: async () => ({ isManaged: true, targetId: 'sub_01' }),
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
    const result = await tool.execute('message', { path: 'sub_01.sock', content }, undefined, undefined, context(cwd));
    assert.equal(result.details, undefined);
    assert.match(JSON.stringify(result.content), /Successfully sent message/);
    assert.deepEqual(calls, [{ from: 'Main', to: 'sub_01', content }]);
  });
});

test('invalid or unmanaged paths never send and broadcast ownership remains enforced', async () => {
  await fixture(async cwd => {
    let sends = 0;
    const cases = [
      { endpoint: { isManaged: false }, path: 'sub_01.sock', code: 'unmanaged_endpoint' },
      { endpoint: { isManaged: true, isBroadcast: true, parentId: 'sub_02' }, path: 'children.sock', code: 'invalid_target' },
      { endpoint: { isManaged: true }, path: 'sub_01.sock', code: 'unknown_endpoint' },
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

test('relative endpoint resolution preserves the working directory and pre-abort prevents admission', async () => {
  await fixture(async cwd => {
    const resolved: string[] = [];
    const tool = createMessageWriteTool({ cwd, senderId: 'sub_01', host: host({
      resolveEndpoint: async address => { resolved.push(address); return { isManaged: true, targetId: 'Main' }; },
    }) });
    await tool.execute('relative', { path: 'Main.sock', content: 'hello' }, undefined, undefined, context(cwd));
    assert.deepEqual(resolved, [path.join(cwd, 'Main.sock')]);
    await assert.rejects(tool.execute('cancelled', { path: 'Main.sock', content: 'hello' }, AbortSignal.abort(), undefined, context(cwd)), { code: 'cancelled' });
    assert.equal(resolved.length, 1);
  });
});

test('partial broadcast fails instead of returning file-write success', async () => {
  await fixture(async (cwd) => {
    const tool = createMessageWriteTool({ cwd, senderId: 'Main', host: host({
      resolveEndpoint: async () => ({ isManaged: true, isBroadcast: true, parentId: 'main' }),
      sendMessage: async () => ({ ok: false, to: 'all', sent: [{ to: 'sub_01', jobId: 'sub_01' }],
        errors: [{ to: 'sub_02', code: 'agent_busy', message: 'finalizing' }] }),
    }) });
    await assert.rejects(tool.execute('broadcast', { path: 'children.sock', content: 'hello' }, undefined, undefined, context(cwd)),
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
      await assert.rejects(tool.execute('failed', { path: 'sub_01.sock', content: 'hello' }, undefined, undefined, context(cwd)),
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
    const success = tool.execute('pending', { path: 'sub_01.sock', content: 'wait' }, undefined, undefined, context(cwd))
      .then((result) => { completed = true; return result; });
    await assert.rejects(tool.execute('failed', { path: 'sub_02.sock', content: 'fail' }, undefined, undefined, context(cwd)), /rejected/);
    assert.equal(completed, false);
    release();
    assert.equal((await success).details, undefined);
  });
});
