import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { createManagedWriteTools, type ManagedWriteHost } from '../../src/subagent/message-write.ts';

// The SDK write definition only reads ctx.cwd. This fixture is intentionally
// limited to that SDK boundary; production admission uses the typed host port.
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

test('managed write exposes runtime receipt rather than SDK filesystem success', async () => {
  await fixture(async (cwd) => {
    const calls: unknown[] = [];
    const tools = createManagedWriteTools({ cwd, senderId: 'main', host: host({
      sendMessage: async (command) => { calls.push(command); return { ok: true, to: command.to, jobId: 'sub_01#r2' }; },
    }) });
    const result = await tools.write.execute('m1', { path: 'sub_01.sock', content: '{"from":"fake"}' }, undefined, undefined, context(cwd));
    assert.deepEqual(calls, [{ from: 'Main', to: 'sub_01', content: '{"from":"fake"}' }]);
    assert.deepEqual(result.details, { ok: true, to: 'sub_01', jobId: 'sub_01#r2' });
    assert.doesNotMatch(JSON.stringify(result.content), /Successfully wrote/);
  });
});

test('message tool returns partial broadcast failures without hiding successful recipients', async () => {
  await fixture(async (cwd) => {
    const receipt = { ok: false, to: 'all' as const, sent: [{ to: 'sub_01', jobId: 'sub_01' }], errors: [{ to: 'sub_02', code: 'agent_busy', message: 'finalizing' }] };
    const tools = createManagedWriteTools({ cwd, senderId: 'Main', host: host({
      resolveEndpoint: async () => ({ isManaged: true, isBroadcast: true, parentId: 'main' }),
      sendMessage: async (command) => { assert.equal(command.to, 'all'); return receipt; },
    }) });
    const result = await tools.message.execute('b1', { path: 'children.sock', content: 'hello' }, undefined, undefined, context(cwd));
    assert.deepEqual(result.details, receipt);
  });
});

test('runtime admission rejection reaches the calling tool', async () => {
  await fixture(async (cwd) => {
    const tools = createManagedWriteTools({ cwd, senderId: 'Main', host: host({ sendMessage: async () => { throw new Error('invalid_message'); } }) });
    await assert.rejects(tools.message.execute('bad', { path: 'sub_01.sock', content: '' }, undefined, undefined, context(cwd)), /invalid_message/);
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

test('concurrent tool invocations cannot share captured receipts', async () => {
  await fixture(async (cwd) => {
    const tools = createManagedWriteTools({ cwd, senderId: 'Main', host: host({
      sendMessage: async ({ content, to }) => { await new Promise((resolve) => setTimeout(resolve, content === 'first' ? 20 : 0)); return { ok: true, to, jobId: content }; },
    }) });
    const [first, second] = await Promise.all(['first', 'second'].map((content, index) => tools.message.execute(content, { path: `sub_0${index + 1}.sock`, content }, undefined, undefined, context(cwd))));
    assert.equal(first?.details && 'jobId' in first.details ? first.details.jobId : null, 'first');
    assert.equal(second?.details && 'jobId' in second.details ? second.details.jobId : null, 'second');
  });
});
