import assert from 'node:assert/strict';
import test from 'node:test';
import { type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { createMessageWriteTool } from '../../src/subagent/message-write.ts';
import type { ManagedWriteHost, ResolvedTarget } from '../../src/subagent/managed-send.ts';

const context = {} as ExtensionToolContext;
const own = 'aaaaaaa1';
const local = `${own}:sub_2-1`;
const remote = 'bbbbbbb2:main';

function host(overrides: Partial<ManagedWriteHost> = {}): ManagedWriteHost {
  return {
    resolveTarget: async () => ({ kind: 'local' }),
    sendMessage: async ({ to }) => ({ ok: true, to, jobId: to }),
    sendCrossSession: async () => {},
    ...overrides,
  };
}

test('msg_write sends the exact caller text to one logical target with a bound sender', async () => {
  const calls: unknown[] = [];
  const tool = createMessageWriteTool({ senderId: local, host: host({
    sendMessage: async command => { calls.push(command); return { ok: true, to: command.to, jobId: command.to }; },
  }) });
  const content = '{"from":"fake"}\nsecond line';
  const result = await tool.execute('message', { to: local, content }, undefined, undefined, context);
  assert.equal(result.details, undefined);
  assert.match(JSON.stringify(result.content), /Successfully sent message/);
  assert.deepEqual(calls, [{ from: local, to: local, content }]);
});

test('non-logical targets and unowned sessions never reach the transport', async () => {
  let sends = 0;
  const cases: Array<[ResolvedTarget, string, string]> = [
    [{ kind: 'foreign' }, remote, 'invalid_target'],
    [{ kind: 'unknown' }, remote, 'unknown_session'],
    [{ kind: 'local' }, 'not-an-address', 'invalid_target'],
    [{ kind: 'local' }, 'main', 'invalid_target'],
    [{ kind: 'local' }, '/tmp/project/main.sock', 'invalid_target'],
  ];
  for (const [target, address, code] of cases) {
    const tool = createMessageWriteTool({ senderId: 'main', host: host({
      resolveTarget: async () => target,
      sendMessage: async ({ to }) => { sends++; return { ok: true, to, jobId: to }; },
    }) });
    await assert.rejects(tool.execute('refused', { to: address, content: 'hello' }, undefined, undefined, context), { code });
  }
  assert.equal(sends, 0);
});

test('only Main crosses sessions; a subagent sender is refused before the write', async () => {
  const calls: unknown[] = [];
  const target = { sessionId: 'peer-session', uid: 'bbbbbbb2' } as never;
  const cross = host({
    resolveTarget: async () => ({ kind: 'session', session: target }),
    sendCrossSession: async command => { calls.push(command); },
  });
  await assert.rejects(createMessageWriteTool({ senderId: `${own}:sub_1`, host: cross })
    .execute('cross', { to: remote, content: 'hello' }, undefined, undefined, context), { code: 'invalid_target' });
  await createMessageWriteTool({ senderId: 'main', host: cross })
    .execute('cross', { to: remote, content: 'hello' }, undefined, undefined, context);
  assert.deepEqual(calls, [{ target, to: remote, content: 'hello' }]);
});

test('a pre-aborted write is refused before any resolution', async () => {
  let resolved = 0;
  const tool = createMessageWriteTool({ senderId: local, host: host({
    resolveTarget: async () => { resolved++; return { kind: 'local' }; },
  }) });
  await assert.rejects(tool.execute('cancelled', { to: local, content: 'hello' }, AbortSignal.abort(), undefined, context),
    { code: 'cancelled' });
  assert.equal(resolved, 0);
});

test('partial broadcast fails instead of returning write success', async () => {
  const tool = createMessageWriteTool({ senderId: 'main', host: host({
    sendMessage: async () => ({ ok: false, to: `${own}:batch_2`, sent: [{ to: `${own}:sub_2-1`, jobId: 'sub_2-1' }],
      errors: [{ to: `${own}:sub_2-2`, code: 'agent_busy', message: 'finalizing' }] }),
  }) });
  await assert.rejects(tool.execute('broadcast', { to: `${own}:batch_2`, content: 'hello' }, undefined, undefined, context),
    { code: 'delivery_failed', message: 'aaaaaaa1:sub_2-2: finalizing' });
});

test('delivery rejection propagates once without retry, and a pending write cannot claim success early', async () => {
  let calls = 0;
  const failing = createMessageWriteTool({ senderId: local, host: host({
    sendMessage: async () => { calls += 1; throw Object.assign(new Error('delivery timed out'), { code: 'timeout' }); },
  }) });
  await assert.rejects(failing.execute('failed', { to: local, content: 'hello' }, undefined, undefined, context), { code: 'timeout' });
  assert.equal(calls, 1);

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let completed = false;
  const slow = createMessageWriteTool({ senderId: local, host: host({
    sendMessage: async ({ content, to }) => {
      if (content === 'fail') throw new Error('rejected');
      await gate;
      return { ok: true, to, jobId: to };
    },
  }) });
  const success = slow.execute('pending', { to: local, content: 'wait' }, undefined, undefined, context)
    .then(result => { completed = true; return result; });
  await assert.rejects(slow.execute('failed', { to: `${own}:sub_2-2`, content: 'fail' }, undefined, undefined, context), /rejected/);
  assert.equal(completed, false);
  release();
  assert.equal((await success).details, undefined);
});
