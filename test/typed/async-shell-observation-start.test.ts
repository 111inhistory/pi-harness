/**
 * Deterministic host.start observation regressions.
 *
 * A stub `pi-job __host create|cancel` process speaks the real frame contract
 * over the root's NDJSON endpoint. The test controls the ordering points the
 * native CLI cannot make deterministic: when the completion frame arrives
 * relative to the create result, when the caller aborts relative to
 * registration, and when a stop is proven by the native cancel result alone.
 *
 * The stub is launched as `node __host create ...`: PI_ASYNC_SHELL_CLI points at
 * process.execPath and the entry file is named `__host`, so no shebang,
 * executable bit or platform-specific launcher is involved.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatMainEndpointPath } from '../../src/subagent/address.ts';
import { RootListener } from '../../src/subagent/listeners.ts';
import { AsyncShellHost, type ShellJobObservation } from '../../src/async-shell/host.ts';
import type { ShellResult } from '../../src/async-shell/protocol.ts';
import { deferred, waitFor } from '../../test-support/async.ts';

const ID = 'job_abcdef12';
const TEST_TIMEOUT = 15_000;

const STUB = `
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const ID = 'job_abcdef12';
const root = process.env.PI_ASYNC_SHELL_ROOT;
const control = process.env.PI_OBSERVATION_CONTROL;
const notify = process.env.PI_OBSERVATION_NOTIFY === '1';
const directory = path.join(root, ID);
const logPath = path.join(directory, 'output.log');
const window = { firstLine: 1, headLines: 0, headBytes: 0, tailFirstLine: 1, totalLines: 0 };
const base = { id: ID, output: '', cursor: 0, window: window, logPath: logPath, truncated: false };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

setTimeout(() => { process.stderr.write('stub timeout\\n'); process.exit(1); }, 8000);

async function waitForFile(name) {
  const file = path.join(control, name);
  while (!fs.existsSync(file)) await sleep(5);
}

function send(frame) {
  return new Promise((resolve, reject) => {
    const client = net.connect(process.env.PI_AGENT_SOCKET);
    let buffer = '';
    client.on('connect', () => client.write(JSON.stringify(frame) + '\\n'));
    client.on('data', chunk => {
      buffer += chunk;
      const index = buffer.indexOf('\\n');
      if (index < 0) return;
      const line = buffer.slice(0, index).trim();
      client.end();
      if (line === '') { resolve(); return; }
      try {
        const error = JSON.parse(line);
        reject(new Error('refused ' + error.code + ': ' + error.message));
      } catch {
        reject(new Error('invalid acknowledgement: ' + line));
      }
    });
    client.on('error', reject);
  });
}

(async () => {
  try {
    const verb = process.argv[2];
    if (verb === 'create') {
      const callId = process.env.PI_ASYNC_SHELL_CALL_ID;
      if (!callId) throw new Error('missing PI_ASYNC_SHELL_CALL_ID');
      // The task directory is the active-registration marker the cancel verb checks.
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      await send({ kind: 'async-shell', agentId: process.env.PI_AGENT_ID, token: process.env.PI_ASYNC_SHELL_TOKEN,
        operation: 'register', id: ID, directory: directory, pid: process.pid, pty: true, callId: callId });
      if (process.env.PI_OBSERVATION_COMPLETE !== '0') {
        await waitForFile('complete');
        const completed = Object.assign({}, base, { status: notify ? 'completed' : 'cancelled', exitCode: notify ? 0 : null });
        await send({ kind: 'async-shell', agentId: process.env.PI_AGENT_ID, token: process.env.PI_ASYNC_SHELL_TOKEN,
          operation: 'complete', id: ID, notify: notify, result: completed });
        fs.writeFileSync(path.join(control, 'completed'), '');
      }
      await waitForFile('result');
      process.stdout.write(JSON.stringify(Object.assign({}, base, { status: 'running', exitCode: null })) + '\\n');
      process.exit(0);
    }
    if (verb === 'cancel') {
      const id = process.argv[3];
      if (id !== ID || !fs.existsSync(directory)) throw new Error('cancel does not match the active registered Job');
      // A real native cancel prints only after releaseTaskBackend proved the
      // backend stopped and wrote the cancelled state plus closed marker.
      process.stdout.write(JSON.stringify(Object.assign({}, base, { id: id, status: 'cancelled', exitCode: null })) + '\\n');
      process.exit(0);
    }
    throw new Error('unsupported verb: ' + verb);
  } catch (error) {
    process.stderr.write((error && error.message ? error.message : String(error)) + '\\n');
    process.exit(1);
  }
})();
`;

let base = '';
let socketRoot = '';
let work = '';
let shellRoot = '';
let previous: { cli: string | undefined; root: string | undefined } = { cli: undefined, root: undefined };

test.before(async () => {
  previous = { cli: process.env.PI_ASYNC_SHELL_CLI, root: process.env.PI_ASYNC_SHELL_ROOT };
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-shell-observe-start-'));
  socketRoot = path.join(base, 'sockets');
  work = path.join(base, 'work');
  shellRoot = path.join(base, 'shell');
  await fsp.mkdir(work, { recursive: true, mode: 0o700 });
  await fsp.mkdir(shellRoot, { recursive: true, mode: 0o700 });
  await fsp.writeFile(path.join(work, '__host'), STUB);
  process.env.PI_ASYNC_SHELL_CLI = process.execPath;
  process.env.PI_ASYNC_SHELL_ROOT = shellRoot;
});

test.after(async () => {
  if (previous.cli === undefined) delete process.env.PI_ASYNC_SHELL_CLI;
  else process.env.PI_ASYNC_SHELL_CLI = previous.cli;
  if (previous.root === undefined) delete process.env.PI_ASYNC_SHELL_ROOT;
  else process.env.PI_ASYNC_SHELL_ROOT = previous.root;
  await fsp.rm(base, { recursive: true, force: true });
});

async function fixture(t: test.TestContext, name: string, notify: boolean, completion = true) {
  const control = path.join(base, 'control', name);
  await fsp.mkdir(control, { recursive: true });
  const sessionDir = path.join(socketRoot, name);
  const main = formatMainEndpointPath(sessionDir);
  const events: ShellJobObservation[] = [];
  const cancelCalls: Array<{ directory: string; root: string }> = [];
  const cancelGate = deferred<void>();
  const host = new AsyncShellHost({
    mainAddress: () => main,
    accepting: () => true,
    deliver: async () => {},
    wake: () => {},
    cancel: async (directory, root) => {
      cancelCalls.push({ directory, root });
      await cancelGate.promise;
    },
  });
  const listener = new RootListener({
    mainAddress: main,
    socketRoot,
    mainDirectory: process.platform === 'win32' ? null : sessionDir,
    isAccepting: () => true,
    deliver: async input => ({ ok: true, to: input.to, jobId: null }),
    receiveShell: (actorId, frame) => host.receive(actorId, frame),
    onError: () => {},
  });
  await listener.sync();
  const env = { ...process.env, ...host.environment('Main'), PI_OBSERVATION_CONTROL: control,
    PI_OBSERVATION_NOTIFY: notify ? '1' : '0', PI_OBSERVATION_COMPLETE: completion ? '1' : '0' };
  const observation = host.observe(undefined, event => events.push(event));
  t.after(async () => {
    cancelGate.resolve();
    // Release a stub still waiting for a test trigger so no child outlives the test.
    await fsp.writeFile(path.join(control, 'complete'), '').catch(() => {});
    await fsp.writeFile(path.join(control, 'result'), '').catch(() => {});
    await host.close().catch(() => {});
    await listener.close().catch(() => {});
    await fsp.rm(control, { recursive: true, force: true });
    await fsp.rm(path.join(shellRoot, ID), { recursive: true, force: true }).catch(() => {});
  });
  const trigger = (name: string) => fsp.writeFile(path.join(control, name), '');
  return {
    host, control, env, events, observation, cancelCalls, cancelGate, trigger,
    completed: path.join(control, 'completed'),
    directory: path.join(shellRoot, ID),
  };
}

test('an early completion is observed as backgrounded then finished after start returns running', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, 'early', true);
  const filtered: ShellJobObservation[] = [];
  const other = f.host.observe('Other', event => filtered.push(event));
  const registered = deferred<string>();
  const started = f.host.start('Main', false, ['--pipe', '--wait', '0', '--', 'ignored'], work, f.env, undefined,
    directory => registered.resolve(directory), { shell: '/bin/bash', command: 'printf hello' });
  void started.catch(() => {});
  const directory = await registered.promise;
  assert.equal(directory, f.directory);
  assert.deepEqual(f.observation.jobs, []);

  await f.trigger('complete');
  await waitFor(() => existsSync(f.completed), { label: 'complete acknowledgement', timeoutMs: 10_000 });
  // The backend already finished and released its lease, but the create result
  // has not returned yet: nothing may be announced as backgrounded retroactively.
  assert.equal(f.host.hasPending('Main'), false);
  assert.equal(f.events.length, 0, 'a completion alone cannot announce an unobserved Job');

  await f.trigger('result');
  const result = await started;
  assert.equal(result.status, 'running');
  assert.equal(result.id, ID);

  assert.deepEqual(f.events.map(event => event.phase), ['backgrounded', 'finished']);
  const [background, finished] = f.events;
  assert.equal(background?.phase, 'backgrounded');
  assert.equal(finished?.phase, 'finished');
  if (background?.phase !== 'backgrounded' || finished?.phase !== 'finished') assert.fail('expected backgrounded then finished');
  assert.equal(background.jobId, ID);
  assert.equal(background.agentId, 'Main');
  assert.equal(background.pty, false, 'the admitted launch owns pty, not the register frame');
  assert.equal(background.shell, '/bin/bash');
  assert.equal(background.cwd, work);
  assert.equal(background.command, 'printf hello');
  assert.equal(background.commandTruncated, false);
  assert.equal(background.logPath, path.join(f.directory, 'output.log'));
  assert.ok(background.pid > 0);
  assert.equal(typeof background.startedAt, 'number');
  assert.equal(finished.jobId, ID);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.exitCode, 0);
  assert.equal(finished.truncated, false);
  assert.ok(finished.finishedAt >= background.startedAt);

  other.unsubscribe();
  assert.deepEqual(filtered, []);
  assert.deepEqual(f.host.observe(undefined, () => {}).jobs, []);
  assert.deepEqual(f.observation.jobs, []);
});

test('aborting after registration keeps an early completion out of the observation stream', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, 'abort-after', true);
  const controller = new AbortController();
  const registered = deferred<string>();
  const started = f.host.start('Main', false, ['--pipe', '--wait', '0', '--', 'ignored'], work, f.env, controller.signal,
    directory => registered.resolve(directory), { shell: '/bin/bash', command: 'sleep 30' });
  void started.catch(() => {});
  const directory = await registered.promise;

  controller.abort();
  await waitFor(() => f.cancelCalls.length === 1, { label: 'cancellation request', timeoutMs: 10_000 });
  // The completion races the aborted start; it releases the lease but must not
  // turn an aborted tool call into a backgrounded Job.
  await f.trigger('complete');
  await waitFor(() => existsSync(f.completed), { label: 'complete acknowledgement', timeoutMs: 10_000 });
  assert.equal(f.host.hasPending('Main'), false);
  assert.equal(f.events.length, 0);

  f.cancelGate.resolve();
  await f.trigger('result');
  await assert.rejects(started, error => (error as Error).name === 'AbortError');
  assert.equal(f.events.length, 0);
  assert.deepEqual(f.cancelCalls, [{ directory, root: shellRoot }]);
});

test('a native cancelled stop result finishes the observation without a callback frame', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, 'stop-native', false, false);
  const registered = deferred<string>();
  const started = f.host.start('Main', false, ['--pipe', '--wait', '0', '--', 'ignored'], work, f.env, undefined,
    directory => registered.resolve(directory), { shell: '/bin/bash', command: 'sleep 30' });
  void started.catch(() => {});
  const directory = await registered.promise;
  assert.equal(directory, f.directory);

  // The create result becomes a backgrounded Job; no completion frame is ever sent.
  await f.trigger('result');
  const background = await started;
  assert.equal(background.status, 'running');
  assert.equal(existsSync(f.completed), false, 'no callback completion was sent');
  assert.equal(f.host.hasPending('Main'), true);
  assert.deepEqual(f.events.map(event => event.phase), ['backgrounded']);
  assert.equal(f.host.observe(undefined, () => {}).jobs.length, 1);

  // host.stop invokes the stub `__host cancel <id>`, which only answers for the
  // active registered task directory and reports the native cancelled result.
  const stopped = await f.host.stop('Main', ID, work);
  assert.equal(stopped.id, ID);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.exitCode, null);
  assert.deepEqual(f.events.map(event => event.phase), ['backgrounded', 'finished']);
  assert.equal(f.events.filter(event => event.phase === 'finished').length, 1);
  const finished = f.events[1];
  assert.equal(finished?.phase, 'finished');
  if (finished?.phase !== 'finished') assert.fail('expected one finished event');
  assert.equal(finished.jobId, ID);
  assert.equal(finished.status, 'cancelled');
  assert.equal(finished.exitCode, null);
  assert.equal(f.host.observe(undefined, () => {}).jobs.length, 0, 'no active snapshot remains');
  // The native cancelled result is the full cleanup proof: releaseTaskBackend
  // succeeded and the cancelled state plus closed marker exist, so stop releases
  // the task entry and wake gate without any callback frame.
  assert.equal(f.host.hasPending('Main'), false, 'native cancel releases the task lease');
});

test('aborting before registration still cancels through the launch correlation without observation', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t, 'abort-before', false);
  const controller = new AbortController();
  const started = f.host.start('Main', true, ['--wait', '0', '--', 'ignored'], work, f.env, controller.signal,
    undefined, { shell: '/bin/bash', command: 'sleep 30' });
  void started.catch(() => {});
  // Abort while the child is still starting: onRegister is skipped for an
  // already-aborted signal, so cancellation must be issued from the deferred
  // launch correlation once the register frame arrives.
  controller.abort();
  await waitFor(() => f.cancelCalls.length === 1, { label: 'deferred cancellation request', timeoutMs: 10_000 });
  const directory = f.directory;
  assert.equal(f.cancelCalls[0]?.directory, directory);

  await f.trigger('complete');
  await waitFor(() => existsSync(f.completed), { label: 'complete acknowledgement', timeoutMs: 10_000 });
  assert.equal(f.host.hasPending('Main'), false);
  assert.equal(f.events.length, 0);

  f.cancelGate.resolve();
  await f.trigger('result');
  await assert.rejects(started, error => (error as Error).name === 'AbortError');
  assert.equal(f.events.length, 0);
  assert.deepEqual(f.cancelCalls, [{ directory, root: shellRoot }]);
});
