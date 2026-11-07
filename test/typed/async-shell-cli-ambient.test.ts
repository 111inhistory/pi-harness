/**
 * Regression: an ambient Harness callback must never turn an ordinary CLI task
 * into a frame source for the user's live session. The test helper sanitizes the
 * inherited environment; explicit per-test callback settings are overlaid after.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cancelTask, stateRoot } from '../../src/async-shell/tmux.ts';
import type { ShellResult } from '../../src/async-shell/protocol.ts';
import { pipePath } from '../../src/ipc/address.ts';
import { runCli } from '../../test-support/test-environment.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const posix = process.platform !== 'win32';
const backendAvailable = spawnSync(posix ? 'tmux' : 'psmux', ['-V']).status === 0;
const options = { skip: !backendAvailable, timeout: posix ? 40_000 : 90_000 };

let bundle = '';
let bundleDir = '';

test.before(async () => {
  if (!backendAvailable) return;
  bundleDir = await mkdtemp(path.join(tmpdir(), 'async-shell-ambient-bundle-'));
  bundle = path.join(bundleDir, 'pi-job.mjs');
  const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-async-shell.mjs'), bundle], { encoding: 'utf8' });
  assert.equal(build.status, 0, `the async-shell bundle must build: ${build.stderr}`);
});

test.after(async () => {
  if (bundleDir !== '') await rm(bundleDir, { recursive: true, force: true });
});

interface AmbientHost {
  readonly socket: string;
  readonly frames: string[];
  readonly connections: () => number;
}

/** A live local host endpoint that records every frame it is sent. */
async function ambientHost(t: test.TestContext): Promise<AmbientHost> {
  const dir = await mkdtemp(path.join(tmpdir(), 'async-shell-ambient-'));
  const socket = posix ? path.join(dir, 'host.sock') : pipePath(dir, 'host');
  const frames: string[] = [];
  let connections = 0;
  const server = net.createServer((connection) => {
    connections += 1;
    connection.setEncoding('utf8');
    let buffer = '';
    connection.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== '') frames.push(line);
        connection.write('\n');
      }
    });
  });
  await new Promise<void>((resolve) => { server.listen(socket, resolve); });
  t.after(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    await rm(dir, { recursive: true, force: true });
  });
  return { socket, frames, connections: () => connections };
}

test('an ambient callback endpoint receives no frames from a standalone CLI task', options, async (t) => {
  const host = await ambientHost(t);
  const ambientRoot = await mkdtemp(path.join(tmpdir(), 'async-shell-ambient-root-'));
  t.after(() => rm(ambientRoot, { recursive: true, force: true }));

  const previous = {
    PI_AGENT_ID: process.env.PI_AGENT_ID,
    PI_AGENT_SOCKET: process.env.PI_AGENT_SOCKET,
    PI_ASYNC_SHELL_TOKEN: process.env.PI_ASYNC_SHELL_TOKEN,
    PI_ASYNC_SHELL_ROOT: process.env.PI_ASYNC_SHELL_ROOT,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // The child runs without ambient wiring, so its root is the default one.
  delete process.env.PI_ASYNC_SHELL_ROOT;
  const taskRoot = stateRoot();

  process.env.PI_AGENT_ID = 'AmbientActor';
  process.env.PI_AGENT_SOCKET = host.socket;
  process.env.PI_ASYNC_SHELL_TOKEN = 'ambient-token';
  process.env.PI_ASYNC_SHELL_ROOT = ambientRoot;
  assert.equal(process.env.PI_AGENT_SOCKET, host.socket, 'the ambient callback is live for this test');

  const script = 'const e=process.env; process.stdout.write([e.PI_AGENT_ID,e.PI_AGENT_SOCKET,e.PI_ASYNC_SHELL_TOKEN,e.PI_ASYNC_SHELL_ROOT].some(Boolean)?"leaked\\n":"standalone\\n")';
  const result = await runCli(bundle, ['create', '--wait', '10s', '--', process.execPath, '-e', script]);
  assert.equal(result.code, 0, `pi-job create failed: ${result.stdout}${result.stderr}`);
  const task = JSON.parse(result.stdout) as ShellResult;
  const dir = path.dirname(task.logPath);
  t.after(async () => {
    await cancelTask(dir, taskRoot).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  assert.equal(task.status, 'completed');
  assert.equal(task.output, 'standalone\n', 'the task itself sees none of the ambient callback keys');
  await cancelTask(dir, taskRoot);
  assert.equal(host.connections(), 0, 'the standalone CLI never opens the ambient callback endpoint');
  assert.deepEqual(host.frames, [], 'no register or complete frame reaches the ambient endpoint');
});
