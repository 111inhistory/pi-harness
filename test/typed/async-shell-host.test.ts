import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { SessionManager, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { installAsyncShellSurface } from '../../src/async-shell/surface.ts';
import { AsyncShellHost, type ShellJobObservation } from '../../src/async-shell/host.ts';
import type { ShellResult } from '../../src/async-shell/protocol.ts';

const id = 'job_11111111';
const directory = path.join(os.tmpdir(), `pi-async-shell-${process.getuid?.() ?? 0}`, id);
const result: ShellResult = {
  id, status: 'completed', exitCode: 0, output: 'done\n', cursor: 5,
  window: { firstLine: 1, headLines: 1, headBytes: 5, tailFirstLine: 1, totalLines: 1 },
  logPath: path.join(directory, 'output.log'), truncated: false,
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function fixture(options: { deliver?: () => Promise<void>; cancel?: () => Promise<void> } = {}) {
  const events: string[] = [];
  const host = new AsyncShellHost({
    accepting: () => true,
    mainAddress: () => '/tmp/project/main.sock',
    deliver: async owner => { events.push(`deliver:${owner}`); await options.deliver?.(); },
    wake: owner => { events.push(`wake:${owner}`); },
    cancel: async () => { events.push('cancel'); await options.cancel?.(); },
  });
  const frame = (owner: string) => ({
    kind: 'async-shell', agentId: owner, token: host.environment(owner).PI_ASYNC_SHELL_TOKEN,
    operation: 'register', id, directory, pid: process.pid, pty: true,
  });
  return { host, events, frame };
}

test('completion stays owned until its result is queued, then releases the same Agent', async () => {
  const gate = deferred();
  const { host, events, frame } = fixture({ deliver: () => gate.promise });
  const register = frame('sub_1');
  await host.receive('sub_1', register);
  assert.equal(host.hasPending('sub_1'), true);
  assert.equal(host.hasPending('Main'), false);
  const delivery = host.receive('sub_1', { ...register, operation: 'complete', notify: true, result });
  assert.equal(host.hasPending('sub_1'), true);
  assert.deepEqual(events, ['deliver:sub_1']);
  gate.resolve();
  await delivery;
  assert.equal(host.hasPending('sub_1'), false);
  assert.deepEqual(events, ['deliver:sub_1', 'wake:sub_1']);
  await host.close();
});

test('an internal error stops waiting, delivers its reminder, and retains the existing cleanup lease', async () => {
  const gate = deferred();
  const { host, events, frame } = fixture({ cancel: () => gate.promise });
  const observations: ShellJobObservation[] = [];
  host.observe(undefined, () => { throw new Error('broken observer'); });
  host.observe('sub_1', event => observations.push(event));
  const register = frame('sub_1');
  await host.receive('sub_1', register);
  const failure = { ...result, status: 'internal_error', exitCode: null,
    message: 'Cleanup is best effort; do not assume the command has stopped or cleanup is complete.' };
  await host.receive('sub_1', { ...register, operation: 'complete', notify: true, result: failure });
  assert.deepEqual(observations.map(event => event.phase === 'finished' ? event.status : event.phase), ['backgrounded', 'internal_error']);
  const snapshot = host.observe('sub_1', () => {});
  assert.deepEqual(snapshot.jobs, []);
  snapshot.unsubscribe();
  assert.equal(host.hasPending('sub_1'), false, 'the model can act on the error without waiting for another result');
  assert.deepEqual(events, ['deliver:sub_1', 'wake:sub_1'], 'reporting the error does not start automatic recovery');
  const release = host.release('sub_1');
  assert.deepEqual(events, ['deliver:sub_1', 'wake:sub_1', 'cancel']);
  assert.throws(() => host.environment('sub_1'), /still retiring/);
  gate.resolve();
  await release;
  assert.equal(observations.length, 2, 'cleanup does not repeat an internal-error observation');
  await host.close();
});

test('a synchronous result releases its task without another completion message', async () => {
  const { host, events, frame } = fixture();
  const register = frame('Main');
  const observed: ShellJobObservation[] = [];
  const watcher = host.observe('Main', event => observed.push(event));
  await host.receive('Main', { ...register, pty: false });
  assert.equal(observed[0]?.phase, 'backgrounded');
  assert.equal(observed[0]?.command, null);
  assert.equal(observed[0]?.pty, false, 'direct managed registration supplies the actual backend type');
  await host.receive('Main', { ...register, operation: 'complete', notify: false, result });
  assert.equal(host.hasPending('Main'), false);
  assert.deepEqual(events, ['wake:Main']);
  assert.deepEqual(observed.map(event => event.phase), ['backgrounded', 'finished']);
  watcher.unsubscribe();
  await host.close();
});

test('execution tokens isolate recipients and fence revoked execution callbacks', async () => {
  const { host, frame } = fixture();
  const old = frame('sub_1');
  frame('sub_2');
  await assert.rejects(host.receive('sub_2', old), /names another Agent/);
  await assert.rejects(host.receive('sub_1', { ...old, agentId: 'sub_2' }), /names another Agent/);
  await assert.rejects(host.receive('sub_2', { ...old, agentId: 'sub_2' }), /no longer owns/);
  await assert.rejects(host.receive('sub_1', { ...old, directory: '/tmp/project/foreign-task' }), /does not match/);
  assert.equal(host.hasPending('sub_1'), false);
  await host.receive('sub_1', old);
  await host.release('sub_1');
  const next = frame('sub_1');
  assert.notEqual(next.token, old.token);
  await assert.rejects(host.receive('sub_1', old), /no longer owns/);
  await assert.rejects(host.receive('sub_1', { ...next, operation: 'complete', notify: true, result }), /Unknown async shell/);
  await host.close();
});

test('Job input checks ownership before approval and does not carry approval across leases', async () => {
  const { host, frame } = fixture();
  await host.receive('sub_1', frame('sub_1'));
  const input = { text: 'synthetic input', enter: true };
  await assert.rejects(host.input('sub_2', id, input, os.tmpdir(), undefined,
    async () => assert.fail('another Actor must not be asked to approve this input')), /does not own/);
  const approval = deferred();
  const pending = host.input('sub_1', id, input, os.tmpdir(), undefined, () => approval.promise);
  await host.release('sub_1');
  await host.receive('sub_1', frame('sub_1'));
  approval.resolve();
  await assert.rejects(pending, /not accepting terminal input/);
  await host.close();
});

test('retiring execution retains its resource fence until task cancellation finishes', async () => {
  const gate = deferred();
  const { host, events, frame } = fixture({ cancel: () => gate.promise });
  const register = frame('sub_1');
  await host.receive('sub_1', register);
  const retiring = host.release('sub_1');
  assert.throws(() => host.environment('sub_1'), /still retiring/);
  await host.receive('sub_1', { ...register, operation: 'complete', notify: true, result });
  assert.deepEqual(events, ['cancel'], 'retirement accepts cleanup without another model turn');
  assert.equal(host.hasPending('sub_1'), true);
  gate.resolve();
  await retiring;
  assert.equal(host.hasPending('sub_1'), false);
  await host.close();
});

test('failed result handoff is never replayed and does not retain a phantom task', async () => {
  const { host, events, frame } = fixture({ deliver: async () => { throw new Error('uncertain handoff'); } });
  const register = frame('sub_1');
  await host.receive('sub_1', register);
  await assert.rejects(host.receive('sub_1', { ...register, operation: 'complete', notify: true, result }), /uncertain handoff/);
  assert.equal(host.hasPending('sub_1'), false);
  assert.deepEqual(events, ['deliver:sub_1', 'wake:sub_1']);
  await host.close();
});

test('cleanup failure keeps the execution fenced instead of authorizing a replacement', async () => {
  const { host, frame } = fixture({ cancel: async () => { throw new Error('monitor still alive'); } });
  const observed: ShellJobObservation[] = [];
  host.observe(undefined, event => observed.push(event));
  await host.receive('sub_1', frame('sub_1'));
  await assert.rejects(host.release('sub_1'), /did not all stop/);
  assert.throws(() => host.environment('sub_1'), /still retiring/);
  assert.equal(host.hasPending('sub_1'), true);
  await assert.rejects(host.close(), /did not retire all tasks/);
  assert.deepEqual(observed.map(event => event.phase === 'finished' ? event.status : event.phase), ['backgrounded', 'internal_error']);
});

test('native shell still executes when callback IPC is unavailable and clears inherited leases', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-without-ipc-'));
  const keys = ['PI_CODING_AGENT_DIR', 'PI_AGENT_ID', 'PI_AGENT_SOCKET', 'PI_ASYNC_SHELL_TOKEN', 'PI_ASYNC_SHELL_ROOT', 'PI_ASYNC_SHELL_HOST_ERROR'] as const;
  const previous = keys.map(key => process.env[key]);
  t.after(async () => {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await fs.rm(cwd, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = cwd;
  for (const key of keys.slice(1)) process.env[key] = 'old-context';
  const probe = path.join(cwd, 'probe.cjs');
  await fs.writeFile(probe, `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys.slice(1))}.map(key => [key, process.env[key] ?? null]))));`);
  const tools: ToolDefinition[] = [];
  const api = { events: { emit: () => {}, on: () => {} }, registerTool: (tool: ToolDefinition) => { tools.push(tool); }, on: () => {} } as unknown as ExtensionAPI;
  installAsyncShellSurface(api, async () => { throw new Error('fixture IPC endpoint unavailable'); }, 'Main');
  const context = { cwd, isProjectTrusted: () => true, sessionManager: SessionManager.inMemory(cwd) } as unknown as ExtensionToolContext;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  assert.deepEqual(tools.filter(tool => tool.name.startsWith('job_')).map(tool => tool.name).sort(),
    ['job_key', 'job_send', 'job_stop']);
  for (const tool of tools.filter(tool => tool.name === 'bash' || tool.name === 'powershell')) {
    const command = tool.name === 'powershell'
      ? `& '${process.execPath.replaceAll("'", "''")}' '${probe.replaceAll("'", "''")}'`
      : `${quote(process.execPath)} ${quote(probe)}`;
    const answer = await tool.execute('fixture-call', { command }, new AbortController().signal, undefined, context);
    assert.notEqual(answer.isError, true);
    const text = answer.content.filter(item => item.type === 'text').map(item => item.text).join('');
    assert.deepEqual(JSON.parse(text), {
      PI_AGENT_ID: null, PI_AGENT_SOCKET: null, PI_ASYNC_SHELL_TOKEN: null, PI_ASYNC_SHELL_ROOT: null,
      PI_ASYNC_SHELL_HOST_ERROR: 'fixture IPC endpoint unavailable',
    });
    // Native fallback keeps Pi's own result fields but adds the same status
    // discriminator as the managed paths, so Codemode never branches on shape.
    const structured = answer.structuredContent as {
      status?: unknown; exit_code?: unknown; truncated?: unknown; wall_time_seconds?: unknown;
    } | undefined;
    assert.equal(structured?.status, 'completed');
    assert.equal(structured?.exit_code, 0);
    assert.equal(structured?.truncated, false);
    assert.equal(typeof structured?.wall_time_seconds, 'number');
  }
});
