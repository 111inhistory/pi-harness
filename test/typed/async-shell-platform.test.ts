/**
 * Ownership queries at the platform boundary.
 *
 * `cancelTask` only signals a pid when the platform can prove it belongs to this
 * task, and it must never mistake "I could not look" for "it is not ours": that
 * would record a cleanup which never happened. These cases pin the three answers
 * apart — ours, provably foreign/absent, and inspection unavailable — for the
 * backend this host actually runs.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { AsyncShellError } from '../../src/async-shell/errors.ts';
import { posixBackend } from '../../src/async-shell/platform-posix.ts';
import { windowsBackend } from '../../src/async-shell/platform-windows.ts';
import type { ShellBackend } from '../../src/async-shell/platform.ts';

const posix = process.platform !== 'win32';
const backend: ShellBackend = posix ? posixBackend : windowsBackend;
const marker = '__async_shell_ownership_probe';
const directory = posix ? '/tmp/async-shell-ownership' : 'C:\\async-shell-ownership';

/** A real process whose own command line carries this task's marker and directory. */
function taggedProcess(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', marker, directory], { stdio: 'ignore' });
}

test('a live process carrying the marker and directory is proven to be ours', async (t) => {
  const child = taggedProcess();
  t.after(() => child.kill('SIGKILL'));
  assert.ok(child.pid, 'the probe process has a pid');
  assert.equal(backend.ownsProcess(child.pid!, marker, directory), true);
  assert.equal(backend.ownsProcess(child.pid!, `${marker}-other`, directory), false,
    'a successful query that shows a different command line proves the process is not ours');
});

test('a pid that no longer exists is false, not an inspection failure', async () => {
  const child = taggedProcess();
  assert.ok(child.pid);
  const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
  child.kill('SIGKILL');
  await exited;
  assert.equal(backend.ownsProcess(child.pid!, marker, directory), false);
});

test('an unavailable control query throws instead of claiming the process is not ours', {
  skip: posix ? false : 'a bare command still resolves through the Windows system directories, so the query cannot be made unavailable without a production knob',
}, async () => {
  const saved = process.env.PATH;
  process.env.PATH = path.join(posix ? '/nonexistent' : 'C:\\nonexistent', 'bin');
  try {
    assert.throws(
      () => posixBackend.ownsProcess(process.pid, marker, directory),
      (error: unknown) => error instanceof AsyncShellError && error.code === 'process_inspection_failed',
    );
  } finally {
    process.env.PATH = saved;
  }
});
