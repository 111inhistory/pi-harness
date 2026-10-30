import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWriteToolDefinition, type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { createManagedWriteTools, type ManagedWriteHost } from '../../src/subagent/message-write.ts';

const context = (cwd: string): ExtensionToolContext => ({ cwd }) as ExtensionToolContext;
async function fixture(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'managed-write-'));
  try { await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}
function host(overrides: Partial<ManagedWriteHost> = {}): ManagedWriteHost {
  return {
    resolveEndpoint: async () => ({ isManaged: true, targetId: 'sub_01' }),
    isReservedPath: async () => false,
    sendMessage: async ({ to }) => ({ ok: true, to, jobId: to }),
    ...overrides,
  };
}

test('write and msg_write return the SDK file-write result without delivery metadata', async () => {
  await fixture(async (cwd) => {
    const calls: unknown[] = [];
    const tools = createManagedWriteTools({ cwd, senderId: 'main', host: host({
      sendMessage: async (command) => { calls.push(command); return { ok: true, to: command.to, jobId: 'sub_01#r2' }; },
    }) });
    const args = { path: 'sub_01.sock', content: '{"from":"fake"}' };
    const native = createWriteToolDefinition(cwd, { operations: { mkdir: async () => {}, writeFile: async () => {} } });
    const expected = await native.execute('native', args, undefined, undefined, context(cwd));
    for (const tool of [tools.write, tools.msg_write]) {
      const result = await tool.execute('message', args, undefined, undefined, context(cwd));
      assert.deepEqual(result, expected);
      assert.equal(result.details, undefined);
      assert.equal(tool.renderResult, native.renderResult);
    }
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ from: 'Main', to: 'sub_01', content: args.content })));
  });
});

test('partial broadcast fails instead of returning file-write success', async () => {
  await fixture(async (cwd) => {
    const tools = createManagedWriteTools({ cwd, senderId: 'Main', host: host({
      resolveEndpoint: async () => ({ isManaged: true, isBroadcast: true, parentId: 'main' }),
      sendMessage: async () => ({ ok: false, to: 'all', sent: [{ to: 'sub_01', jobId: 'sub_01' }],
        errors: [{ to: 'sub_02', code: 'agent_busy', message: 'finalizing' }] }),
    }) });
    await assert.rejects(tools.msg_write.execute('broadcast', { path: 'children.sock', content: 'hello' }, undefined, undefined, context(cwd)),
      { code: 'delivery_failed', message: 'sub_02: finalizing' });
  });
});

test('delivery rejection or timeout propagates as a failed write without retry', async () => {
  await fixture(async (cwd) => {
    for (const failure of [new Error('recipient unavailable'), Object.assign(new Error('delivery timed out'), { code: 'timeout' })]) {
      let calls = 0;
      const tools = createManagedWriteTools({ cwd, senderId: 'Main', host: host({
        sendMessage: async () => { calls += 1; throw failure; },
      }) });
      await assert.rejects(tools.msg_write.execute('failed', { path: 'sub_01.sock', content: 'hello' }, undefined, undefined, context(cwd)),
        (error: unknown) => error === failure);
      assert.equal(calls, 1);
    }
  });
});

test('ordinary files retain SDK write behavior and never invoke runtime', async () => {
  await fixture(async (cwd) => {
    const tools = createManagedWriteTools({ cwd, senderId: 'Main', host: host({ sendMessage: async () => { throw new Error('must not route files'); } }) });
    const result = await tools.write.execute('file', { path: 'nested/file.txt', content: 'file body' }, undefined, undefined, context(cwd));
    assert.equal(await readFile(path.join(cwd, 'nested/file.txt'), 'utf8'), 'file body');
    assert.equal(result.details, undefined);
    assert.match(JSON.stringify(result.content), /Successfully wrote/);
  });
});

test('a pending write cannot report success before delivery and concurrent failures stay isolated', async () => {
  await fixture(async (cwd) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let completed = false;
    const tools = createManagedWriteTools({ cwd, senderId: 'Main', host: host({
      sendMessage: async ({ content, to }) => {
        if (content === 'fail') throw new Error('rejected');
        await gate;
        return { ok: true, to, jobId: 'internal-job' };
      },
    }) });
    const success = tools.msg_write.execute('pending', { path: 'sub_01.sock', content: 'wait' }, undefined, undefined, context(cwd))
      .then((result) => { completed = true; return result; });
    await assert.rejects(tools.msg_write.execute('failed', { path: 'sub_02.sock', content: 'fail' }, undefined, undefined, context(cwd)), /rejected/);
    assert.equal(completed, false);
    release();
    assert.equal((await success).details, undefined);
  });
});
