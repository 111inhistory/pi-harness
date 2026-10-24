import assert from 'node:assert/strict';
import test from 'node:test';
import { SubagentExecution } from '../../src/subagent/execution.ts';
import type { ExecutionSession } from '../../src/subagent/execution.ts';

function fakeSession() {
  const events: string[] = [];
  let idle = true;
  const session: ExecutionSession = {
    get isIdle() { return idle; },
    async prompt(text) { events.push(`prompt:${text}`); },
    async steer(text) { events.push(`steer:${text}`); return 'queued'; },
    async abort() { events.push('abort'); idle = true; },
    async waitForIdle() { events.push('idle'); },
    dispose() { events.push('dispose'); },
  };
  return { session, events, busy() { idle = false; } };
}

test('shared execution owns prompt, steer and idempotent reverse cleanup', async () => {
  const fake = fakeSession();
  const execution = new SubagentExecution(fake.session);
  execution.addCleanup(() => { fake.events.push('first'); });
  execution.addCleanup(async () => { fake.events.push('second'); });
  await execution.prompt('task');
  assert.equal(await execution.steer('update'), 'queued');
  const closing = execution.dispose();
  assert.equal(execution.dispose(), closing);
  await closing;
  assert.deepEqual(fake.events, ['prompt:task', 'steer:update', 'idle', 'second', 'first', 'dispose']);
  await assert.rejects(execution.prompt('late'), /closed/);
  await assert.rejects(execution.steer('late'), /closed/);
  assert.throws(() => execution.addCleanup(() => {}), /closed/);
});

test('cleanup failure does not prevent remaining cleanup or SDK disposal', async () => {
  const fake = fakeSession();
  const execution = new SubagentExecution(fake.session);
  execution.addCleanup(() => { fake.events.push('remaining'); });
  execution.addCleanup(() => { throw new Error('failed cleanup'); });
  await assert.rejects(execution.dispose(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.match(String(error.errors[0]), /failed cleanup/);
    return true;
  });
  assert.deepEqual(fake.events, ['idle', 'remaining', 'dispose']);
});

test('disposing active execution aborts before waiting and releasing SDK', async () => {
  const fake = fakeSession();fake.busy();
  const execution = new SubagentExecution(fake.session);
  await execution.dispose();
  assert.deepEqual(fake.events, ['abort', 'idle', 'dispose']);
});

test('parent abort reaches the owned SDK session and rejects later prompts', async () => {
  const fake = fakeSession();fake.busy();
  const controller = new AbortController();
  const execution = new SubagentExecution(fake.session, controller.signal);
  controller.abort();
  await assert.rejects(execution.prompt('late'), { name: 'AbortError' });
  await execution.dispose();
  assert.equal(fake.events.filter(event => event === 'abort').length, 1);
  assert.equal(fake.events.at(-1), 'dispose');
});

test('already-aborted execution cannot prompt and still releases the acquired session', async () => {
  const fake = fakeSession();
  const controller = new AbortController();controller.abort();
  const execution = new SubagentExecution(fake.session, controller.signal);
  await assert.rejects(execution.prompt('task'), { name: 'AbortError' });
  await execution.dispose();
  assert.ok(fake.events.includes('dispose'));
  assert.ok(!fake.events.some(event => event.startsWith('prompt:')));
});
