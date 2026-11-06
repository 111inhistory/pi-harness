/**
 * Async-shell CLI: real tmux, real PTY, real processes.
 *
 * Every case drives the shipped CLI as a separate process, so the assertions are
 * about what a caller (or the Harness host) actually observes: literal argv,
 * incremental filtered output, literal input and keys, finalization under exit,
 * timeout and cancel, host callback frames, and isolation from other tmux
 * servers. Nothing here fakes the transport or the terminal.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cancelTask, stateRoot } from '../../src/async-shell/tmux.ts';
import { validateAsyncShellFrame, type AsyncShellFrame, type ShellResult } from '../../src/async-shell/protocol.ts';
import { waitFor } from '../../test-support/async.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const posix = process.platform !== 'win32';
const tmuxAvailable = posix && spawnSync('tmux', ['-V']).status === 0;
const options = { skip: !tmuxAvailable, timeout: 40_000 };

/**
 * The tests drive the built artifact, not the sources: the pane, the monitor and
 * the CLI all come from one bundle, and the build lands in a private temporary
 * directory so a concurrent runner is never involved.
 */
let bundle = '';
let bundleDir = '';

test.before(async () => {
  if (!tmuxAvailable) return;
  bundleDir = await mkdtemp(path.join(tmpdir(), 'async-shell-bundle-'));
  bundle = path.join(bundleDir, 'pi-job.mjs');
  const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-async-shell.mjs'), bundle], { encoding: 'utf8' });
  assert.equal(build.status, 0, `the async-shell bundle must build: ${build.stderr}`);
});

test.after(async () => {
  if (bundleDir !== '') await rm(bundleDir, { recursive: true, force: true });
});

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function cli(args: readonly string[], settings: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CliResult> {
  const child: ChildProcess = spawn(process.execPath, [bundle, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...settings.env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.stdin?.on('error', () => { /* a refused input closes the pipe early */ });
  child.stdin?.end(settings.input ?? '');
  return once(child, 'exit').then(([code]) => ({ code: code as number | null, stdout, stderr }));
}

async function job(args: readonly string[], settings: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ShellResult> {
  const result = await cli(args, settings);
  assert.equal(result.code, 0, `pi-job ${args[0] ?? ''} failed: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout) as ShellResult;
}

function taskDirOf(result: ShellResult): string {
  return path.dirname(result.logPath);
}

/** Remove one test task after it is stopped, so no state outlives the run. */
async function cleanup(dir: string): Promise<void> {
  await cancelTask(dir).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}

function nodeScript(script: string): readonly string[] {
  return [process.execPath, '-e', script];
}

test('create runs the command with literal argv and reports the exit status', options, async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'async-shell-argv-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const literal = ['a;b', '$(echo hi)', "it's", '#{session_name}', '"double"', '--', '--flag', ' spaced '];
  const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\\n"); process.exit(3)';
  const result = await job(['create', '--wait', '10s', '--cwd', cwd, '--', process.execPath, '-e', script, ...literal]);
  t.after(() => cleanup(taskDirOf(result)));

  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 3);
  assert.deepEqual(JSON.parse(result.output.trim()), literal, 'argv reaches the command byte for byte');
});

test('poll returns only new output and read replays the transcript from a cursor', options, async (t) => {
  const started = await job(['create', '--', ...nodeScript(
    'const w=(s)=>process.stdout.write(s);'
    + 'w("one\\n"); setTimeout(()=>{ w("two\\n"); setTimeout(()=>{ w("three\\n"); }, 300); }, 300);',
  )]);
  t.after(() => cleanup(taskDirOf(started)));
  assert.equal(started.status, 'running');
  const dir = taskDirOf(started);

  // The create reply already owns whatever it showed; polls continue after it.
  let transcript = started.output;
  let chunks = 0;
  const done = await waitFor(async () => {
    const poll = await job(['poll', started.id]);
    if (poll.output !== '') chunks += 1;
    transcript += poll.output;
    return poll.status === 'running' ? null : poll;
  }, { label: 'incremental consumption' });
  assert.equal(done.status, 'completed');
  assert.equal(done.exitCode, 0);
  assert.equal(transcript, 'one\ntwo\nthree\n',
    'create and every poll contribute their own text once: no repeated prefix');
  assert.ok(chunks >= 2, 'the transcript arrived incrementally');

  const after = await job(['poll', started.id]);
  assert.equal(after.output, '', 'everything was already consumed');

  const replay = await job(['read', started.id, '--cursor', '0']);
  assert.equal(replay.output, 'one\ntwo\nthree\n', 'read replays the filtered transcript');
  assert.equal(replay.truncated, false);
  assert.equal(path.basename(replay.logPath), 'output.log');
  assert.equal((await job(['poll', started.id])).output, '', 'an explicit read never consumes');
  await cancelTask(dir);
});

test('send preserves literal bytes, and Enter is a separate key', options, async (t) => {
  const script = [
    'const out=(s)=>process.stdout.write(s);',
    'process.stdin.setRawMode(true);',
    'out("ready\\n");',
    'let acc="";',
    'process.stdin.on("data",(chunk)=>{ acc += chunk.toString();',
    '  if (acc.includes("\\n") || acc.includes("\\r")) { out("got:"+JSON.stringify(acc)+"\\n"); acc=""; } });',
  ].join('\n');
  const started = await job(['create', '--', process.execPath, '-e', script]);
  t.after(() => cleanup(taskDirOf(started)));
  await sendWhenReady(started.id, 'ready\n');

  // A heredoc keeps its own final newline: the payload arrives byte for byte.
  const sent = await job(['send', started.id], { input: 'abc\n' });
  assert.equal(sent.output.includes('ready'), false, 'send returns only new text, never a replay');
  const pasted = await waitFor(async () => {
    const seen = await job(['poll', started.id, '--cursor', '0']);
    return seen.output.includes('got:"abc\\n"') ? seen.output : null;
  }, { label: 'pasted bytes' });

  // Without a newline the payload is typed but not submitted; the explicit Enter
  // key submits it and arrives as CR, which is the target terminal's decision.
  await job(['send', started.id], { input: 'xyz' });
  const keyed = await job(['key', started.id, 'Enter']);
  assert.equal(keyed.output.includes('ready'), false, 'key returns only new text, never a replay');
  const submitted = await waitFor(async () => {
    const seen = await job(['poll', started.id, '--cursor', '0']);
    return seen.output.includes('got:"xyz\\r"') ? seen.output : null;
  }, { label: 'explicit Enter' });
  assert.ok(submitted.includes('got:"abc\\n"'), pasted);
  assert.equal(submitted.includes('got:"xyz\\n"'), false, 'the newline came from the key, not from the payload');
  await cancelTask(taskDirOf(started));
});

test('an oversized send is refused while reading stdin, before anything is typed', options, async (t) => {
  const started = await job(['create', '--', ...nodeScript('process.stdin.resume(); setInterval(()=>{}, 1000);')]);
  t.after(() => cleanup(taskDirOf(started)));

  const result = await cli(['send', started.id], { input: 'x'.repeat(70_000) });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'input_too_large');
  assert.equal((await job(['poll', started.id, '--cursor', '0'])).output, '', 'no byte reached the pane');
});

test('terminal escapes are filtered, carriage returns collapse, and split UTF-8 survives', options, async (t) => {
  const script = [
    'const w=(s)=>process.stdout.write(s);',
    'w("\\u001b[31mred\\u001b[0m\\n");',
    'w("\\u001b]0;window title\\u0007");',
    'w("progress 10%\\rprogress 99%\\rdone\\n");',
    'w(Buffer.from([0xe4,0xbd]));',
    'setTimeout(()=>{ w(Buffer.from([0xa0])); w("!\\n"); }, 250);',
  ].join('');
  const result = await job(['create', '--wait', '10s', '--', ...nodeScript(script)]);
  t.after(() => cleanup(taskDirOf(result)));
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'red\ndone\n你!\n',
    'ANSI and OSC are removed, the carriage-return overwrite keeps one line, and a split character is one character');
});

test('a nonzero exit, a timeout and a cancel each finalize the task and leave no server', options, async (t) => {
  const failed = await job(['create', '--wait', '10s', '--', ...nodeScript('process.stderr.write("boom\\n"); process.exit(7)')]);
  t.after(() => cleanup(taskDirOf(failed)));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 7);
  assert.ok(failed.output.includes('boom'), failed.output);

  const timedOut = await job(['create', '--wait', '10s', '--timeout', '400ms', '--', ...nodeScript(
    'process.stdout.write("begin\\n"); setTimeout(()=>process.exit(0), 30000);',
  )]);
  t.after(() => cleanup(taskDirOf(timedOut)));
  assert.equal(timedOut.status, 'timed_out');
  assert.equal(timedOut.exitCode, null);
  assert.ok(timedOut.output.includes('begin'), timedOut.output);
  assert.equal(serverStopped(taskDirOf(timedOut)), true, 'the timed-out server is gone');

  const running = await job(['create', '--', ...nodeScript('process.stdout.write("begin\\n"); setTimeout(()=>process.exit(0), 30000);')]);
  const dir = taskDirOf(running);
  t.after(() => cleanup(dir));
  await waitFor(async () => (await job(['poll', running.id])).output.includes('begin') || null, { label: 'started output' });
  const cancelled = await job(['cancel', running.id]);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.output.includes('begin'), false, 'cancel returns only new text, never a replay');
  assert.equal(serverStopped(dir), true, 'the cancelled server is gone');
  await stat(path.join(dir, 'closed'));
  await cancelTask(dir);
});

test('the host receives one register and one complete frame, quiet inside the wait window', options, async (t) => {
  const host = await callbackHost(t);
  const result = await job(['create', '--wait', '10s', '--', ...nodeScript('process.stdout.write("quick\\n")')], {
    env: { PI_AGENT_SOCKET: host.socket, PI_ASYNC_SHELL_TOKEN: 'token-fast', PI_AGENT_ID: 'AsyncActor' },
  });
  t.after(() => cleanup(taskDirOf(result)));
  assert.equal(result.status, 'completed');
  await waitFor(() => host.frames.length >= 2, { label: 'register and complete frames' });

  const [register, complete] = host.frames;
  assert.equal(register?.operation, 'register');
  assert.equal(register?.token, 'token-fast');
  assert.equal(register?.id, result.id);
  assert.equal(register?.directory, taskDirOf(result));
  assert.ok((register?.pid ?? 0) > 0);
  assert.equal(complete?.operation, 'complete');
  assert.equal(complete?.id, result.id);
  assert.equal(complete?.notify, false, 'a result returned inside the wait window is not notified again');
  assert.equal(complete?.result.status, 'completed');
  // The create reply already owned the text; the unregistering completion is a
  // status-only result at the same cursor.
  assert.equal(complete?.result.output, '');
  assert.equal(complete?.result.cursor, result.cursor);
  assert.equal(result.output + complete?.result.output, 'quick\n', 'the line is delivered exactly once');
  assert.equal(host.frames.length, 2, 'exactly one register and one complete frame');
});

test('a task that outlives the wait window is notified once when it completes', options, async (t) => {
  const host = await callbackHost(t);
  const started = await job(['create', '--wait', '300ms', '--', ...nodeScript(
    'process.stdout.write("slow\\n"); setTimeout(()=>process.exit(0), 1800);',
  )], { env: { PI_AGENT_SOCKET: host.socket, PI_ASYNC_SHELL_TOKEN: 'token-slow' } });
  t.after(() => cleanup(taskDirOf(started)));

  await waitFor(() => host.frames.some((frame) => frame.operation === 'complete'), { label: 'complete frame' });
  const complete = host.frames.find((frame) => frame.operation === 'complete');
  assert.equal(complete?.notify, true, 'a task finalized after the window is notified');
  assert.equal(complete?.result.status, 'completed');
  assert.equal(started.output + (complete?.result.output ?? ''), 'slow\n',
    'the notification carries only text the create reply did not already return');
  assert.ok((complete?.result.cursor ?? 0) >= started.cursor);
  await waitFor(async () => (await job(['poll', started.id])).status === 'completed', { label: 'final state' });
});

test('a running --wait 0 reply is completed by a notification, never dropped', options, async (t) => {
  const host = await callbackHost(t);
  const started = await job(['create', '--', ...nodeScript(
    'process.stdout.write("short\\n"); setTimeout(()=>process.exit(0), 1500);',
  )], { env: { PI_AGENT_SOCKET: host.socket, PI_ASYNC_SHELL_TOKEN: 'token-short' } });
  t.after(() => cleanup(taskDirOf(started)));

  assert.equal(started.status, 'running', 'the create reply precedes completion');
  assert.equal(host.frames.filter((frame) => frame.operation === 'complete').length, 0,
    'the task had not completed when the reply was made');

  // The caller polls the first line; the later completion must not replay it.
  const polled = await waitFor(async () => {
    const poll = await job(['poll', started.id]);
    return poll.output.includes('short') ? poll : null;
  }, { label: 'first line' });
  await waitFor(() => host.frames.some((frame) => frame.operation === 'complete'), { label: 'completion notification' });
  const complete = host.frames.find((frame) => frame.operation === 'complete');
  assert.equal(complete?.notify, true, 'a task returned as running is notified when it completes');
  assert.equal(complete?.result.status, 'completed');
  assert.equal(complete?.result.output.includes('short'), false,
    'the notified completion only carries text that was not already returned');
  assert.equal(complete?.result.output, '');
  assert.equal(complete?.result.cursor, polled.cursor);
  assert.equal(complete?.result.truncated, false);
});

test('an ambiguous registration keeps the task directory and never replays it', options, async (t) => {
  const missing = path.join(await mkdtemp(path.join(tmpdir(), 'async-shell-absent-')), 'absent.sock');
  const result = await cli(['create', '--', ...nodeScript('process.stdout.write("never")')], {
    env: { PI_AGENT_SOCKET: missing, PI_ASYNC_SHELL_TOKEN: 'token-absent' },
  });
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stdout).error as { code: string; message: string };
  assert.equal(error.code, 'register_failed');
  // The error names the task whose directory was kept for the host to release.
  const id = /task ([0-9a-f-]{36})/.exec(error.message)?.[1];
  assert.ok(id, error.message);
  const dir = path.join(stateRoot(), id!);
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).status, 'failed');
  assert.ok(existsSync(path.join(dir, 'closed')), 'the directory is already released');
  assert.equal(existsSync(path.join(dir, 'tmux.sock')), false, 'no server was started');
  await cancelTask(dir);
});

test('a completion frame cannot report a running task', () => {
  const result = { id: 'task-1', status: 'running', exitCode: null, output: '', cursor: 0, logPath: '/tmp/task-1/output.log', truncated: false };
  const frame = { kind: 'async-shell', token: 'token', operation: 'complete', id: 'task-1', notify: true, result };
  assert.throws(() => validateAsyncShellFrame(frame), /running/);
  assert.deepEqual(
    validateAsyncShellFrame({ ...frame, result: { ...result, status: 'completed' } }).operation,
    'complete',
  );
});

test('a task never touches another tmux server on the same host', options, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'async-shell-foreign-'));
  const socket = path.join(dir, 'foreign.sock');
  const launch = spawnSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 'foreign', 'sleep 60']);
  assert.equal(launch.status, 0, launch.stderr?.toString());
  t.after(() => {
    spawnSync('tmux', ['-S', socket, 'kill-server']);
    void rm(dir, { recursive: true, force: true });
  });

  const started = await job(['create', '--', ...nodeScript('setTimeout(()=>process.exit(0), 30000)')]);
  t.after(() => cleanup(taskDirOf(started)));
  await job(['cancel', started.id]);

  const alive = spawnSync('tmux', ['-S', socket, 'has-session', '-t', 'foreign']);
  assert.equal(alive.status, 0, 'the unrelated tmux server and its session are untouched');
});

test('output larger than one response is truncated per chunk and continues on the next poll', options, async (t) => {
  const size = 40_000;
  const result = await job(['create', '--wait', '10s', '--', ...nodeScript(
    `process.stdout.write("y".repeat(${String(size)}) + "\\n")`,
  )]);
  t.after(() => cleanup(taskDirOf(result)));
  assert.equal(result.status, 'completed');
  assert.equal(result.truncated, true, 'one response does not carry the whole transcript');
  assert.ok(Buffer.byteLength(result.output) <= 32 * 1024);
  assert.match(result.output, /^y+$/);

  let seen = result.cursor;
  let text = result.output;
  while (true) {
    const next = await job(['poll', result.id, '--cursor', String(seen)]);
    if (next.output === '') break;
    text += next.output;
    seen = next.cursor;
    if (!next.truncated) break;
  }
  assert.equal(Buffer.byteLength(text), size + 1, 'every byte of the transcript is still reachable');
  assert.equal(text, `${'y'.repeat(size)}\n`);
});

/** A task's own server answers only while it is running. */
function serverStopped(dir: string): boolean {
  return spawnSync('tmux', ['-S', path.join(dir, 'tmux.sock'), 'list-sessions']).status !== 0;
}

/** Wait until the pane's first output is visible before typing into it. */
async function sendWhenReady(id: string, marker: string): Promise<void> {
  await waitFor(async () => {
    const poll = await job(['poll', id, '--cursor', '0']);
    return poll.output.includes(marker) ? poll : null;
  }, { label: 'ready output' });
}

interface CallbackHost {
  readonly socket: string;
  readonly frames: AsyncShellFrame[];
}

/** A minimal host endpoint: NDJSON in, one empty line back, frames validated. */
async function callbackHost(t: test.TestContext): Promise<CallbackHost> {
  const dir = await mkdtemp(path.join(tmpdir(), 'async-shell-host-'));
  const socket = path.join(dir, 'host.sock');
  const frames: AsyncShellFrame[] = [];
  const server = net.createServer((connection) => {
    connection.setEncoding('utf8');
    let buffer = '';
    connection.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() === '') continue;
        frames.push(validateAsyncShellFrame(JSON.parse(line)));
        connection.write('\n');
      }
    });
  });
  await new Promise<void>((resolve) => { server.listen(socket, resolve); });
  t.after(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    await rm(dir, { recursive: true, force: true });
  });
  return { socket, frames };
}

test('the task transcript keeps the raw PTY log independently', options, async (t) => {
  const result = await job(['create', '--wait', '10s', '--', ...nodeScript('process.stdout.write("\\u001b[31mred\\u001b[0m\\n")')]);
  t.after(() => cleanup(taskDirOf(result)));
  const dir = taskDirOf(result);
  const raw = await readFile(path.join(dir, 'raw.log'), 'utf8');
  assert.ok(raw.includes('\u001b[31m'), 'the raw log keeps the escape the filtered transcript removed');
  assert.equal(await readFile(result.logPath, 'utf8'), 'red\n');
});
