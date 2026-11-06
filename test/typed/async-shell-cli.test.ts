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
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cancelTask, stateRoot } from '../../src/async-shell/tmux.ts';
import { pipePath } from '../../src/ipc/address.ts';
import { validateAsyncShellFrame, type AsyncShellFrame, type ShellResult } from '../../src/async-shell/protocol.ts';
import { waitFor } from '../../test-support/async.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const posix = process.platform !== 'win32';
/** POSIX drives `tmux -S`, Windows drives native `psmux -L`; same CLI either way. */
const BACKEND = posix ? 'tmux' : 'psmux';
const backendAvailable = spawnSync(BACKEND, ['-V']).status === 0;
/** `npm` is a shell script on POSIX and a `.cmd` launcher on Windows. */
const npmAvailable = posix
  ? spawnSync('npm', ['--version']).status === 0
  : spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm --version'], { windowsHide: true }).status === 0;
const options = { skip: !backendAvailable, timeout: posix ? 40_000 : 90_000 };

/**
 * The tests drive the built artifact, not the sources: the pane, the monitor and
 * the CLI all come from one bundle, and the build lands in a private temporary
 * directory so a concurrent runner is never involved.
 */
let bundle = '';
let bundleDir = '';

test.before(async () => {
  if (!backendAvailable) return;
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
  // The literal-paste transport carries the LF itself on both platforms (a CRLF
  // pair is collapsed to one LF by the Windows console, a lone LF is preserved).
  const sent = await job(['send', started.id], { input: 'abc\n' });
  assert.equal(sent.output.includes('ready'), false, 'send returns only new text, never a replay');
  const pasted = await waitFor(async () => {
    const seen = await job(['poll', started.id, '--cursor', '0']);
    return /got:"abc(?:\\r)?\\n"/.test(seen.output) ? seen.output : null;
  }, { label: 'pasted bytes' });

  // Without a newline the payload is typed but not submitted; the explicit Enter
  // key submits it and arrives as CR, which is the target terminal's decision.
  await job(['send', started.id], { input: 'xyz' });
  const keyed = await job(['key', started.id, 'Enter']);
  assert.equal(keyed.output.includes('ready'), false, 'key returns only new text, never a replay');
  const submitted = await waitFor(async () => {
    const seen = await job(['poll', started.id, '--cursor', '0']);
    return /got:"xyz\\r/.test(seen.output) ? seen.output : null;
  }, { label: 'explicit Enter' });
  assert.match(submitted, /got:"abc(?:\\r)?\\n"/, pasted);
  assert.doesNotMatch(submitted, /got:"xyz\\n"/, 'the line break came from the key, not from the payload');
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
  // POSIX forwards the pane's raw bytes, so our filter collapses the carriage
  // returns to the final line. ConPTY is a terminal: it re-emits only the cells
  // that changed, so overwriting a longer progress line leaves its tail behind.
  // Everything else — ANSI/OSC removal, one line per break, split UTF-8 — is the
  // same guarantee on both platforms.
  if (posix) {
    assert.equal(result.output, 'red\ndone\n你!\n',
      'ANSI and OSC are removed, the carriage-return overwrite keeps one line, and a split character is one character');
  } else {
    assert.match(result.output, /^red\ndone(?:ress 99%)?\n你!\n$/,
      'ANSI and OSC are removed, the progress line collapses to its final write, and a split character is one character');
  }
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
  assert.equal(serverStopped(dir), true, 'no server was started');
  if (posix) assert.equal(existsSync(path.join(dir, 'tmux.sock')), false, 'no socket file was created');
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

// A foreign server on a *socket path* only exists on POSIX; on Windows a task is
// addressed by its own label, and the isolation test below covers that namespace.
test('a task never touches another tmux server on the same host', { ...options, skip: !options.skip && posix ? false : 'POSIX socket server only' }, async (t) => {
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

test('a direct executable keeps every argv byte, including Windows metacharacters', options, async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'async-shell-meta-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const literal = ['a&b', 'c^d', 'e!f', 'g%PATH%', 'h"i', 'j|k', 'l<m>n', ' spaced ', 'semi;colon', 'back\\slash\\'];
  const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\\n")';
  const result = await job(['create', '--wait', '10s', '--cwd', cwd, '--', process.execPath, '-e', script, ...literal]);
  t.after(() => cleanup(taskDirOf(result)));
  assert.equal(result.status, 'completed');
  assert.deepEqual(JSON.parse(result.output.trim()), literal, 'an executable target is never re-parsed by a shell');
});

test('a large literal send reaches the pane byte for byte', options, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'async-shell-big-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sink = path.join(root, 'sink.mjs');
  const out = path.join(root, 'received.bin');
  // The readiness file is published only after raw mode and the data listener are
  // in place: `create` reporting a spawned pid does not mean the app is reading.
  await writeFile(sink, [
    'import { appendFileSync, writeFileSync } from "node:fs";',
    'const out = process.argv[2];',
    'writeFileSync(out, "");',
    'process.stdin.setRawMode(true);',
    'process.stdin.on("data", (chunk) => appendFileSync(out, chunk));',
    'process.stdin.resume();',
    'writeFileSync(out + ".ready", "");',
  ].join('\n'));
  const started = await job(['create', '--', process.execPath, sink, out]);
  t.after(() => cleanup(taskDirOf(started)));
  await waitFor(() => existsSync(`${out}.ready`), { label: 'the sink is reading', timeoutMs: 30_000 });

  // 58 KiB of mixed-width UTF-8 stays under the public 64 KiB limit while
  // crossing the 32767-character Windows command line by a wide margin, so the
  // payload must travel on the multiplexer's stdin, never on an argv.
  const unit = '中文😀ABC&^%!";';
  let payload = '';
  while (Buffer.byteLength(payload, 'utf8') < 58 * 1024) payload += unit;
  payload = payload.slice(0, payload.length - (payload.length % unit.length));
  const bytes = Buffer.from(payload, 'utf8');
  assert.ok(bytes.length > 24 * 1024);

  const sent = await cli(['send', started.id], { input: payload });
  assert.equal(sent.code, 0, `send failed: ${sent.stdout}${sent.stderr}`);

  // The sink receives nothing but this payload, so the whole file — not a prefix
  // of it — must equal the input: extra or duplicated bytes are a failure too.
  const received = await waitFor(async () => {
    const seen = await readFile(out);
    return seen.length >= bytes.length ? seen : null;
  }, { label: 'the whole payload', timeoutMs: 60_000 });
  assert.equal(received.length, bytes.length, 'no byte is dropped, duplicated or re-encoded');
  assert.equal(received.equals(bytes), true, 'the complete received payload is unchanged');
  assert.equal(createHash('sha256').update(received).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  await cancelTask(taskDirOf(started));
});

test('a .cmd target carries literal arguments, even from a spaced non-ASCII directory', { ...options, skip: posix ? 'cmd.exe transport is Windows only' : options.skip }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'async shell cmd 目录-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dump = path.join(root, 'dump.mjs');
  const out = path.join(root, 'argv.json');
  await writeFile(dump, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n');
  const script = path.join(root, 'probe.cmd');
  // Batch text is read in the OEM code page, so the fixture keeps it ASCII: the
  // script's own directory is expanded by cmd (`%~dp0`) and the interpreter path
  // arrives through the environment, which is Unicode all the way down.
  await writeFile(script, `@echo off\r\n"%PI_JOB_TEST_NODE%" "%~dp0dump.mjs" "%~dp0argv.json" %*\r\n`);

  const args = ['plain', 'a b', 'amp&and', 'caret^here', 'bang!x', 'percent%PATH%', 'quote"inside', 'semi;colon', 'pipe|bar', 'lt<gt>', 'trail\\'];
  const result = await job(['create', '--wait', '20s', '--cwd', root, '--', 'probe.cmd', ...args], { env: { PI_JOB_TEST_NODE: process.execPath } });
  t.after(() => cleanup(taskDirOf(result)));
  assert.equal(result.status, 'completed');
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), args,
    'a .cmd target is reached through cmd.exe without losing a metacharacter, a quote or a percent expression');
});

test('npm run reaches a script through the resolved npm launcher', { ...options, skip: !npmAvailable ? 'npm is not on PATH' : options.skip }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'async-shell-npm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { probe: 'node -e "process.stdout.write(\'npm-script-ran\\n\')"' } }));
  const result = await job(['create', '--wait', '60s', '--cwd', root, '--', 'npm', 'run', 'probe', '--silent']);
  t.after(() => cleanup(taskDirOf(result)));
  assert.equal(result.status, 'completed');
  assert.equal(result.output.trim(), 'npm-script-ran', 'the resolved launcher ran the script in the requested directory');
});

test('a state root with spaces and non-ASCII characters works end to end', options, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'async shell 中文-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { TMPDIR: root, TEMP: root, TMP: root };

  const result = await job(['create', '--wait', '10s', '--', ...nodeScript('process.stdout.write("spaced root\\n")')], { env });
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'spaced root\n');
  assert.ok(result.logPath.startsWith(root), `the task lives under the caller's temp root: ${result.logPath}`);
  assert.ok(path.basename(result.logPath) === 'output.log');
  // The capture log is written by the backend's own sink, never through a shell
  // that could mangle a space or a non-ASCII path.
  const raw = await readFile(path.join(taskDirOf(result), 'raw.log'), 'utf8');
  assert.ok(raw.includes('spaced root'), 'the raw capture reached the spaced directory');
  assert.equal((await job(['poll', result.id], { env })).status, 'completed');
});

test('two tasks own separate servers, and cancelling one leaves the other running', options, async (t) => {
  const first = await job(['create', '--', ...nodeScript('process.stdout.write("first\\n"); setTimeout(()=>process.exit(0), 30000);')]);
  const second = await job(['create', '--', ...nodeScript('process.stdout.write("second\\n"); setTimeout(()=>process.exit(0), 30000);')]);
  t.after(() => cleanup(taskDirOf(first)));
  t.after(() => cleanup(taskDirOf(second)));

  await waitFor(async () => (await job(['poll', second.id, '--cursor', '0'])).output.includes('second'), { label: 'second task output', timeoutMs: 10_000 });
  await job(['cancel', first.id]);
  assert.equal(serverStopped(taskDirOf(first)), true, 'the cancelled task released its own server');
  assert.equal(serverStopped(taskDirOf(second)), false, 'the other task keeps its server');

  const alive = await job(['poll', second.id, '--cursor', '0']);
  assert.equal(alive.status, 'running');
  assert.ok(alive.output.includes('second'));
  const cancelledSecond = await job(['cancel', second.id]);
  assert.equal(cancelledSecond.status, 'cancelled');
});

test('the task inherits the caller environment, including the callback contract', options, async (t) => {
  const host = await callbackHost(t);
  const script = 'const e=process.env; process.stdout.write([e.PI_AGENT_ID,e.PI_AGENT_SOCKET,e.PI_ASYNC_SHELL_TOKEN,e.PI_TEST_MARK].join("|")+"\\n")';
  const env = {
    PI_AGENT_ID: 'Child', PI_AGENT_SOCKET: host.socket, PI_ASYNC_SHELL_TOKEN: 'token-env', PI_TEST_MARK: 'inherited',
  };
  const result = await job(['create', '--wait', '10s', '--', ...nodeScript(script)], { env });
  t.after(() => cleanup(taskDirOf(result)));
  assert.equal(result.status, 'completed');
  assert.equal(result.output.trim(), `Child|${host.socket}|token-env|inherited`,
    'the command can report back over the same named endpoint it was started with');
});

test('a long transcript is complete while it is read concurrently', options, async (t) => {
  const lines = 200;
  const script = `let i=0; const t=setInterval(()=>{ process.stdout.write("line-"+(++i)+"\\n"); if(i===${String(lines)}){ clearInterval(t); process.exit(0); } }, 5);`;
  const started = await job(['create', '--', ...nodeScript(script)]);
  t.after(() => cleanup(taskDirOf(started)));

  let text = '';
  let round = 0;
  const done = await waitFor(async () => {
    const poll = await job(['poll', started.id]);
    text += poll.output;
    // Read the whole transcript from zero while capture is still being written:
    // the snapshot must be a prefix-consistent view, never a torn or reordered one.
    if (round % 5 === 0) {
      const full = await job(['read', started.id, '--cursor', '0']);
      assert.equal(full.output.slice(0, text.length), text, 'a concurrent full read agrees with what was already consumed');
    }
    round += 1;
    return poll.status === 'running' ? null : poll;
  }, { label: 'complete transcript', timeoutMs: 30_000 });

  const expected = Array.from({ length: lines }, (_, index) => `line-${String(index + 1)}`).join('\n') + '\n';
  assert.equal(done.status, 'completed');
  assert.equal(text, expected, 'every line appears exactly once');
  assert.equal(text.includes('\r'), false, 'the transcript is normalized to LF whatever the terminal emits');
  const replay = await job(['read', started.id, '--cursor', '0']);
  assert.equal(replay.output, expected);
});

test('output larger than one response is truncated per chunk and continues on the next poll', options, async (t) => {
  // Short lines keep this about chunking: a line wider than the pane is the
  // terminal's own wrapping behaviour and is covered separately.
  const lines = 5000;
  const expected = Array.from({ length: lines }, (_, index) => `line-${String(index).padStart(4, '0')}`).join('\n') + '\n';
  const result = await job(['create', '--wait', '20s', '--', ...nodeScript(
    `for (let i = 0; i < ${String(lines)}; i += 1) process.stdout.write("line-" + String(i).padStart(4, "0") + "\\n")`,
  )]);
  t.after(() => cleanup(taskDirOf(result)));
  assert.equal(result.status, 'completed');
  assert.equal(result.truncated, true, 'one response does not carry the whole transcript');
  assert.ok(Buffer.byteLength(result.output) <= 32 * 1024);
  assert.ok(expected.startsWith(result.output), 'a response is a prefix of the transcript');

  let seen = result.cursor;
  let text = result.output;
  while (true) {
    const next = await job(['poll', result.id, '--cursor', String(seen)]);
    if (next.output === '') break;
    text += next.output;
    seen = next.cursor;
    if (!next.truncated) break;
  }
  assert.equal(text, expected, 'every byte of the transcript is still reachable, in order');
});

test('ConPTY wrapping and repainting remain readable across bounded incremental responses', { ...options, skip: posix ? 'ConPTY renders wrapping; a POSIX pty forwards the bytes it was given' : options.skip }, async (t) => {
  const size = 40_000;
  const result = await job(['create', '--wait', '20s', '--', ...nodeScript(
    `process.stdout.write("y".repeat(${String(size)}) + "\\n")`,
  )]);
  t.after(() => cleanup(taskDirOf(result)));
  assert.equal(result.status, 'completed');
  assert.ok(Buffer.byteLength(result.output) <= 32 * 1024, 'a response is still bounded');
  let text = result.output;
  let chunk = result;
  while (chunk.truncated) {
    chunk = await job(['poll', result.id]);
    assert.ok(Buffer.byteLength(chunk.output) <= 32 * 1024, 'every response is bounded');
    text += chunk.output;
  }
  const flat = text.replace(/\n/g, '');
  assert.match(flat, /^y+$/, 'the terminal transcript contains payload characters and rendered line breaks');
  assert.ok(flat.length >= size, 'the transcript includes the long line and possible cell repaints');
});

/** A task's own server answers only while it is running. */
function serverStopped(dir: string): boolean {
  const args = posix
    ? ['-S', path.join(dir, 'tmux.sock'), 'list-sessions']
    : ['-L', `pi-job-${path.basename(dir)}`, 'list-sessions'];
  return spawnSync(BACKEND, args).status !== 0;
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
  // A host endpoint is a Unix socket path on POSIX and a named pipe on Windows;
  // both sides must agree on that one address.
  const socket = posix ? path.join(dir, 'host.sock') : pipePath(dir, 'host');
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
