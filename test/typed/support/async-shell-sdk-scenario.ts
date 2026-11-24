import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { formatMainEndpointPath } from '../../../src/subagent/address.ts';
import { lastToolResult, waitForCondition, type ScenarioFixture } from './subagent-sdk-fixture.ts';

const posixQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const powerShellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * One model turn the scripted provider has actually produced. Resolving it from
 * the callback that carries the shell result makes readiness the observed turn
 * itself, not a timeout budget: a slow child start, shell spawn or CLI cannot
 * make it expire, while a turn that never arrives still fails through the
 * unchanged outer test and subprocess deadlines.
 */
function observedTurn(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

const textOf = (content: readonly { readonly type: string; readonly text?: string }[]): string =>
  content.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');

const JOB_ID = /^Job (job_[0-9a-f]{8})\b/m;

function jobIdOf(text: string): string {
  const match = JOB_ID.exec(text);
  assert.ok(match, `the model text must name its Job:\n${text}`);
  return match[1]!;
}

function logPathOf(text: string): string {
  const read = /Use read on (.+?) from line /.exec(text);
  const footer = /\[Showing lines [^\]]*Full output: (.+)\]/.exec(text)
    ?? /\[Output truncated[^\]]*Full output: (.+)\]/.exec(text);
  const output = /^Output log: (.+)$/m.exec(text);
  const found = read?.[1] ?? footer?.[1] ?? output?.[1];
  assert.ok(found, `the model text must name its output log:\n${text}`);
  return found!;
}

/** Model text is prose over real state, never a serialized ShellResult. */
function assertProseResult(text: string): void {
  assert.doesNotMatch(text, /^\s*\{/);
  assert.doesNotMatch(text, /"(?:id|status|logPath|cursor|exitCode)"\s*:/);
  assert.doesNotMatch(text, /\bcursor\b/);
}

const RUNNING_TRUNCATION = /\[Output truncated: showing lines (\d+)-(\d+) and (\d+)-(\d+) of (\d+)\. Use read on (.+?) from line (\d+) \(omitted output\) or line (\d+) \(further output\)\.\]/;
const TERMINAL_TRUNCATION = /\[Output truncated: showing lines (\d+)-(\d+) and (\d+)-(\d+) of (\d+)\. Use read on (.+?) from line (\d+) \(omitted output\)\.\]/;
const FOREGROUND_TAIL = /\[Showing lines (\d+)-(\d+) of (\d+)(?: \([^)]*limit\))?\. Full output: (.+)\]/;

/**
 * One trailing newline is not another line: line counts in the footer, the file
 * on disk and the `read` tool must agree on the same 1-based numbering.
 */
function fileLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

type RawToolResult = {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
};

type ProgrammaticShellResult = {
  readonly output?: unknown;
  readonly truncated?: unknown;
  readonly full_output_path?: unknown;
  readonly exit_code?: unknown;
  readonly wall_time_seconds?: unknown;
  readonly status?: unknown;
  readonly job_id?: unknown;
};

/**
 * Programmatic caller contract used by Codemode. This executes the same
 * registered definition the model and Codemode invoke; the fixture's `call`
 * helper only keeps model-facing content.
 */
function rawInvoker(fixture: ScenarioFixture): (
  name: string,
  params: Record<string, unknown>,
  onUpdate?: (update: { readonly content: readonly unknown[]; readonly details?: unknown }) => void,
) => Promise<RawToolResult> {
  let sequence = 0;
  return async (name, params, onUpdate) => {
    const tool = fixture.session.getToolDefinition(name);
    assert.ok(tool, `missing registered tool ${name}`);
    const toolCallId = `scenario-tool-${++sequence}`;
    return await tool.execute(toolCallId, params as never, undefined, onUpdate as never,
      fixture.session.extensionRunner.createToolContext(toolCallId, undefined)) as RawToolResult;
  };
}

/**
 * The fixture shell tests exercise the real Bash/PowerShell entry for wait
 * windows, clipping, structured output and terminal copy. Each command is a
 * real process so the CLI's own cursor and log remain the source of truth.
 */
export async function runAsyncShellScenario(fixture: ScenarioFixture, shellName: 'bash' | 'powershell' = 'bash'): Promise<void> {
  const executable = process.env.PI_ASYNC_SHELL_CLI;
  assert.ok(executable);
  const quote = shellName === 'powershell' ? powerShellQuote : posixQuote;
  // pwsh -Command otherwise maps a failing external process to exit 1.
  const command = (args: string[], preserveExitCode = false) => shellName === 'powershell'
    ? `& ${args.map(quote).join(' ')}${preserveExitCode ? '; exit $LASTEXITCODE' : ''}`
    : args.map(quote).join(' ');
  const invoke = rawInvoker(fixture);
  const started = path.join(fixture.cwd, 'async-started.json');
  const release = path.join(fixture.cwd, 'async-release');
  const marker = 'ASYNC_PTY_RESULT';
  const probe = path.join(fixture.cwd, 'async-command.mjs');
  await fsp.writeFile(probe, [
    "import fs from 'node:fs';",
    'const [started, release, marker] = process.argv.slice(2);',
    'fs.writeFileSync(started + ".tmp", JSON.stringify({agentId:process.env.PI_AGENT_ID,socket:process.env.PI_AGENT_SOCKET,sessionId:process.env.PI_SESSION_ID,tty:process.stdout.isTTY === true,pid:process.pid}));',
    'fs.renameSync(started + ".tmp", started);',
    'const timer = setInterval(() => { if (fs.existsSync(release)) { console.log(marker); clearInterval(timer); } }, 10);',
  ].join('\n'));
  const emitter = path.join(fixture.cwd, 'shell-emit.mjs');
  await fsp.writeFile(emitter, [
    "import fs from 'node:fs';",
    "const [countArg, tail, holdArg, exitArg, mode, counter, delayArg, prefix = 'line'] = process.argv.slice(2);",
    'if (counter) fs.appendFileSync(counter, `${process.pid}\\n`);',
    'await new Promise(resolve => setTimeout(resolve, Number(delayArg)));',
    'let text = "";',
    'for (let i = 1; i <= Number(countArg); i++) {',
    "  text += mode === 'wide'",
    "    ? `${prefix} ${i} ${'x'.repeat(900)}${i % 10 === 0 ? '多字节·行' : ''}\\n`",
    '    : `${prefix} ${i}\\n`;',
    '}',
    'if (tail) text += tail;',
    'process.stdout.write(text);',
    'if (Number(exitArg)) process.exitCode = Number(exitArg);',
    'if (Number(holdArg) > 0) setTimeout(() => {}, Number(holdArg));',
  ].join('\n'));
  const emit = (options: {
    lines: number; tail?: string; holdMs?: number; exitCode?: number; mode?: 'plain' | 'wide';
    counter?: string; delayMs?: number; prefix?: string;
  }): string => command([
    process.execPath, emitter,
    String(options.lines), options.tail ?? '', String(options.holdMs ?? 0), String(options.exitCode ?? 0),
    options.mode ?? 'plain', options.counter ?? '', String(options.delayMs ?? 0), options.prefix ?? 'line',
  ].map(value => value.replaceAll('\\', '/')), Boolean(options.exitCode));
  const childCommand = [process.execPath, probe, started, release].map(value => value.replaceAll('\\', '/'));
  // Host shell results arrive as a custom message, which the scripted fixture
  // classifies as an ordinary turn. Count notifications across both lists so a
  // missing or duplicate terminal message is still observable.
  const noticeChats = (jobId: string) => [...fixture.notificationChats, ...fixture.chats]
    .filter(chat => chat.text.includes(jobId));
  let shellResult = observedTurn();
  let shellFailure: string | null = null;
  let childTurns = 0;
  const mainCompletion = observedTurn();
  fixture.controls.chat = request => {
    if (request.context.tools?.some(tool => tool.name === shellName)) {
      assert.ok(request.text.includes('background: true'), 'Shell guidance describes direct background execution');
    }
    if (request.options.sessionId === fixture.sessionManager.getSessionId()) {
      if (request.text.includes('MAIN_SHELL_RESULT')) mainCompletion.resolve();
      return fixture.textAnswer('Root received shell result.');
    }
    childTurns++;
    const shell = lastToolResult(request.context.messages, shellName);
    if (shell === undefined) return fixture.toolAnswer(shellName, {
      command: command([...childCommand, marker]), background: true, pty: true, timeout: 20,
    });
    if (shell.isError) {
      shellFailure = JSON.stringify(shell.content);
      shellResult.resolve();
      return fixture.textAnswer('Shell failed.');
    }
    if (request.text.includes(marker)) return fixture.textAnswer('Verified asynchronous command result.');
    shellResult.resolve();
    return fixture.textAnswer('Waiting for the command completion.');
  };
  const actor = await fixture.create('ASYNC_SHELL_CHILD execute and verify the asynchronous command');
  await shellResult.promise;
  assert.equal(shellFailure, null, shellFailure ?? undefined);
  await new Promise<void>(resolve => setImmediate(resolve));
  await waitForCondition(async () => {
    try { await fsp.access(started); return true; } catch { return false; }
  }, 'command publishing its terminal environment');
  const environment = JSON.parse(await fsp.readFile(started, 'utf8')) as { agentId: string; socket: string; tty: boolean };
  assert.equal(environment.agentId, actor.id);
  assert.equal(environment.socket, formatMainEndpointPath(fixture.sessionSocketDir),
    'the shell callback reaches the one root endpoint');
  assert.equal(environment.tty, true);
  assert.equal(fixture.sessionManager.getBranch().some(entry => entry.type === 'custom'
    && entry.customType === 'subagent-job-end' && (entry.data as { jobId?: string }).jobId === actor.id), false,
    'the owning Job must not end while its shell runs');
  assert.equal(fixture.notificationChats.length, 0, 'yielding while a shell is running must not publish Subagent completion');
  await fsp.writeFile(release, 'release');
  const final = await fixture.settled(actor.id);
  assert.equal(final.id, actor.id);
  assert.ok(childTurns >= 3, 'completion resumes the same child after its waiting answer');
  // The marker stays in history, so a later finish-time msg_write reminder also
  // contains it. Count only the actual callback turn, not that reminder turn.
  const shellCallbackRequests = fixture.chats.filter(request =>
    request.options.sessionId !== fixture.sessionManager.getSessionId()
    && request.text.includes(marker)
    && !request.text.includes('finishing this Job without having sent a msg_write'));
  assert.equal(shellCallbackRequests.length, 1, 'the callback is delivered once to its owning child');

  // Main receives its own completion, using the same environment-based route.
  // Hold Main's command until create returns, so completion is necessarily async.
  const mainStarted = path.join(fixture.cwd, 'main-started.json').replaceAll('\\', '/');
  const mainRelease = path.join(fixture.cwd, 'main-release').replaceAll('\\', '/');
  const mainResult = await fixture.call(shellName, {
    command: command([...[process.execPath, probe].map(value => value.replaceAll('\\', '/')), mainStarted, mainRelease, 'MAIN_SHELL_RESULT']),
    background: true, pty: true, timeout: 20,
  });
  assert.notEqual(mainResult.isError, true, JSON.stringify(mainResult.content));
  await fsp.writeFile(mainRelease, 'release');
  await mainCompletion.promise;

  for (const pty of [false, true]) {
    const failed = await fixture.call(shellName, {
      command: shellName === 'powershell' ? "Write-Output 'foreground failure'; exit 7" : 'printf "foreground failure\\n"; exit 7',
      // Pin these formatting checks to foreground even when Windows shell
      // startup takes longer than the fixture's 1s automatic wait window.
      pty, timeout: 3,
    });
    assert.equal(failed.isError, true, textOf(failed.content));
    const item = failed.content[0];
    assert.ok(item?.type === 'text' && typeof item.text === 'string');
    assert.match(item.text.replaceAll('\r', ''), /^foreground failure\n+Command exited with code 7$/);
  }

  const inputJob = await fixture.call(shellName, {
    command: command([process.execPath.replaceAll('\\', '/'), '-e',
      'require("node:readline").createInterface({input:process.stdin}).once("line", line => { console.log("INPUT:" + line); process.exit(0); });']),
    background: true, pty: true, timeout: 20,
  });
  const inputItem = inputJob.content[0];
  assert.ok(inputItem?.type === 'text' && typeof inputItem.text === 'string');
  const inputJobId = jobIdOf(inputItem.text);
  const inputLogPath = logPathOf(inputItem.text);
  await fixture.call('job_send', { id: inputJobId, text: 'literal job input' });
  assert.doesNotMatch(await fsp.readFile(inputLogPath, 'utf8'), /INPUT:literal job input/);
  await fixture.call('job_key', { id: inputJobId, key: 'Enter' });
  await waitForCondition(async () => /INPUT:literal job input/.test(await fsp.readFile(inputLogPath, 'utf8')), 'PTY input reaches the process');

  // ---- Wait windows through the real bash/powershell entry ----
  // No timeout: the auto-background window is the reported wait, and the Job
  // keeps running after the tool call hands it back.
  const autoCounter = path.join(fixture.cwd, 'auto-runs.txt');
  const auto = await fixture.call(shellName, {
    command: emit({ lines: 3, tail: 'AUTO_MARKER', holdMs: 15000, counter: autoCounter, prefix: 'AUTO' }),
  });
  const autoText = textOf(auto.content);
  assertProseResult(autoText);
  assert.match(autoText, /^Job job_[0-9a-f]{8} backgrounded after 1s wait\.\nSet timeout to limit runtime, or use background: true to return immediately\./, autoText);
  const autoId = jobIdOf(autoText);
  const autoLogPath = logPathOf(autoText);
  assert.match(autoText, /^Output log: /m, autoText);
  assert.doesNotMatch(autoText, /exit code|Truncated/, 'a running Job neither reports an exit code nor a truncation flag');
  await waitForCondition(async () => /AUTO_MARKER/.test(await fsp.readFile(autoLogPath, 'utf8')), 'the backgrounded Job keeps running');
  assert.equal((await fsp.readFile(autoCounter, 'utf8')).trim().split('\n').length, 1);
  const autoStop = await fixture.call('job_stop', { id: autoId });
  const autoStopText = textOf(autoStop.content);
  assertProseResult(autoStopText);
  assert.match(autoStopText, new RegExp(`^Job ${autoId} cancelled(?: \\(exit code -?\\d+\\))?\\.`), autoStopText);
  assert.equal((await fsp.readFile(autoCounter, 'utf8')).trim().split('\n').length, 1, 'handoff never restarts the command');

  // Long timeout: the foreground wait cap hands the same Job back, and the
  // original timeout still bounds the command from its launch.
  const longCounter = path.join(fixture.cwd, 'long-runs.txt');
  const long = await fixture.call(shellName, {
    command: emit({ lines: 3, tail: 'LONG_MARKER', holdMs: 15000, counter: longCounter, prefix: 'LONG' }),
    timeout: 5,
  });
  const longText = textOf(long.content);
  assertProseResult(longText);
  assert.match(longText, /^Job job_[0-9a-f]{8} backgrounded after 3s wait\. The original 5s timeout still applies\.\nUse background: true to return immediately instead of waiting on a long timeout\./, longText);
  const longId = jobIdOf(longText);
  assert.match(longText, /^Output log: /m, longText);
  await waitForCondition(() => noticeChats(longId).length > 0,
    'the original timeout still stops the handed-off Job', 15000);
  const longNotice = noticeChats(longId);
  assert.equal(longNotice.length, 1, 'an asynchronous terminal state notifies once');
  assert.equal(longNotice[0]!.options.sessionId, fixture.sessionManager.getSessionId(), 'the owning Main receives the notification');
  assertProseResult(longNotice[0]!.text);
  assert.match(longNotice[0]!.text, new RegExp(`^Job ${longId} timed out(?: \\(exit code -?\\d+\\))?\\.`, 'm'), longNotice[0]!.text);
  assert.equal((await fsp.readFile(longCounter, 'utf8')).trim().split('\n').length, 1, 'the handed-off command runs once');

  // timeout <= maxForegroundWaitMs: no handoff, a terminal foreground result.
  // A synchronous terminal state must not also schedule a completion turn.
  const turnsBeforeForeground = fixture.chats.length + fixture.notificationChats.length;
  const foreground = await fixture.call(shellName, {
    command: emit({ lines: 2, tail: 'FOREGROUND_MARKER', prefix: 'FG' }), timeout: 2,
  });
  assert.notEqual(foreground.isError, true, JSON.stringify(foreground.content));
  const foregroundText = textOf(foreground.content);
  assertProseResult(foregroundText);
  assert.match(foregroundText, /FOREGROUND_MARKER/);
  assert.doesNotMatch(foregroundText, /^Job /m, 'a synchronous terminal result is not a Job reference');
  assert.doesNotMatch(foregroundText, /Output log:/, 'a complete foreground result keeps its output inline');
  assert.equal(fixture.chats.length + fixture.notificationChats.length, turnsBeforeForeground,
    'a synchronously returned terminal result schedules no completion notification');

  const foregroundTimeout = await fixture.call(shellName, {
    command: emit({ lines: 1, holdMs: 8000, prefix: 'TIMEOUT' }), timeout: 1,
  });
  assert.equal(foregroundTimeout.isError, true);
  assert.match(textOf(foregroundTimeout.content), /Command timed out\./);

  // ---- Managed foreground waiting pushes bounded TUI tail previews ----
  {
    const previewScript = path.join(fixture.cwd, 'shell-preview.mjs');
    await fsp.writeFile(previewScript, [
      "process.stdout.write('PREVIEW_EARLY\\n');",
      "setTimeout(() => process.stdout.write('PREVIEW_LATE\\n'), 1500);",
    ].join('\n'));
    const updates: { readonly content: readonly unknown[]; readonly details?: unknown }[] = [];
    const watched = await invoke(shellName, {
      command: command([process.execPath, previewScript].map(value => value.replaceAll('\\', '/'))), timeout: 3,
    }, update => { updates.push(update as { readonly content: readonly unknown[]; readonly details?: unknown }); });
    assert.notEqual(watched.isError, true, textOf(watched.content));
    assert.ok(updates.length > 0, 'the managed wait reports live previews through onUpdate');
    const previews = updates.map(update => update.details as { readonly shell?: { readonly output?: string; readonly terminal?: boolean } } | undefined);
    assert.ok(previews.some(preview => preview?.shell?.output?.includes('PREVIEW_EARLY')), 'a preview shows output written during the wait');
    assert.ok(previews.some(preview => preview?.shell?.terminal === true), 'previews stay display-only terminal snapshots');
    assert.ok(previews.some(preview => preview?.shell?.output !== undefined && !preview.shell.output.includes('PREVIEW_LATE')),
      'previews are bounded snapshots, not the final result');
    const finalText = textOf(watched.content);
    assert.match(finalText, /PREVIEW_EARLY[\s\S]*PREVIEW_LATE/, 'the terminal result keeps all output');
  }

  // ---- Foreground clipping keeps the tail diagnostics Pi's native tools keep ----
  {
    const lineTail = 'FOREGROUND_TAIL_MARKER';
    const tailed = await invoke(shellName, {
      command: emit({ lines: 2201, tail: lineTail, exitCode: 7, prefix: 'FG' }), timeout: 2,
    });
    assert.equal(tailed.isError, true);
    const body = textOf(tailed.content);
    const structured = tailed.structuredContent as ProgrammaticShellResult;
    assert.equal(structured.truncated, false, 'structured output is clipped by its own 1 MiB budget, not the model tail');
    assert.match(String(structured.output), /^FG 1\n[\s\S]*FOREGROUND_TAIL_MARKER$/, 'structured callers keep the full filtered snapshot');
    assert.equal(structured.exit_code, 7);
    assert.equal(structured.status, 'failed');
    assertProseResult(body);
    assert.ok(body.includes(lineTail), 'the tail diagnostic stays visible');
    assert.match(body, /Command exited with code 7$/, 'the exit status stays after the tail and its notice');
    const footer = FOREGROUND_TAIL.exec(body);
    assert.ok(footer, `foreground clipping must follow Pi's tail notice:\n${body}`);
    const startLine = footer[1]!;
    const endLine = footer[2]!;
    const totalLines = footer[3]!;
    const footerPath = footer[4]!;
    assert.equal(Number(endLine), Number(totalLines), 'the shown range ends at the last line');
    assert.ok(Number(startLine) < Number(endLine), 'the head of an over-limit result is not returned inline');
    assert.ok(Number(totalLines) - Number(startLine) + 1 <= 2000, 'the tail keeps at most 2000 lines');
    const lines = fileLines(await fsp.readFile(footerPath, 'utf8'));
    assert.equal(lines.length, Number(totalLines), 'the footer counts the full log in 1-based lines');
    assert.equal(lines[Number(endLine) - 1], lineTail, 'the last shown line is the real last line');
    assert.ok(!body.startsWith('FG 1\n') && !body.includes('\nFG 1\n'), 'early lines are not part of the tail');
  }
  {
    const wideTail = 'FOREGROUND_BYTE_MARKER';
    const tailed = await fixture.call(shellName, {
      command: emit({ lines: 80, tail: wideTail, mode: 'wide', prefix: 'BYTE' }), timeout: 2,
    });
    assert.notEqual(tailed.isError, true, JSON.stringify(tailed.content));
    const body = textOf(tailed.content);
    assert.ok(body.includes(wideTail), 'the multi-byte tail survives byte clipping');
    const footer = FOREGROUND_TAIL.exec(body);
    assert.ok(footer, `byte clipping must keep a continuation notice:\n${body}`);
    const startLine = footer[1]!;
    const endLine = footer[2]!;
    const totalLines = footer[3]!;
    assert.equal(Number(endLine), Number(totalLines));
    assert.ok(Number(startLine) > 1, 'the byte limit drops leading lines');
    assert.ok(Number(totalLines) - Number(startLine) + 1 < 80);
  }

  {
    const quick = await fixture.call(shellName, {
      command: shellName === 'powershell' ? 'Write-Output $env:HARNESS_FIXTURE_PREFIX' : 'printf "%s\\n" "$HARNESS_FIXTURE_PREFIX"',
      background: true,
    });
    const quickItem = quick.content[0];
    assert.ok(quickItem?.type === 'text' && typeof quickItem.text === 'string');
    const quickText = quickItem.text;
    assertProseResult(quickText);
    assert.match(quickText, /^Job job_[0-9a-f]{8} started in the background\./);
    assert.doesNotMatch(quickText, /Use background: true/, 'an explicit background call gets no auto-background advice');
    const quickJob = jobIdOf(quickText);
    const quickLog = logPathOf(quickText);
    await waitForCondition(async () => (await fsp.readFile(quickLog, 'utf8')).trim().length > 0, `quick Job output (${quickJob})`);
    const log = await fixture.call('read', { path: quickLog });
    assert.notEqual(log.isError, true);
    assert.ok(log.content.some(item => item.type === 'text' && item.text?.trim() === 'once'));
    const nonTty = path.join(fixture.cwd, 'pipe-started.json');
    const pipeRelease = path.join(fixture.cwd, 'pipe-release');
    const reply = await fixture.call(shellName, {
      command: command([process.execPath, probe, nonTty, pipeRelease, 'PIPE_RESULT'].map(value => value.replaceAll('\\', '/'))),
    });
    assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
    const item = reply.content[0];
    assert.ok(item?.type === 'text' && typeof item.text === 'string');
    assertProseResult(item.text);
    assert.match(item.text, /^Job job_[0-9a-f]{8} backgrounded after 1s wait\.\nSet timeout to limit runtime, or use background: true to return immediately\./, item.text);
    const job = jobIdOf(item.text);
    const pipeLog = logPathOf(item.text);
    await waitForCondition(async () => { try { await fsp.access(nonTty); return true; } catch { return false; } }, 'pipe startup');
    const pipeEnvironment = JSON.parse(await fsp.readFile(nonTty, 'utf8'));
    assert.equal(pipeEnvironment.tty, false);
    assert.equal(pipeEnvironment.sessionId, fixture.sessionManager.getSessionId());
    await assert.rejects(fixture.call('job_send', { id: job, text: 'not delivered', enter: true }), /not accepting terminal input/);
    const stopped = await fixture.call('job_stop', { id: job });
    const stopText = stopped.content[0];
    assert.ok(stopText?.type === 'text' && typeof stopText.text === 'string');
    assert.match(stopText.text, new RegExp(`^Job ${job} cancelled(?: \\(exit code -?\\d+\\))?\\.`), stopText.text);
    assertProseResult(stopText.text);
    assert.equal(fixture.sessionManager.getBranch().some(entry => entry.type === 'custom_message'
      && JSON.stringify(entry.content).includes(job)), false, 'stop reports cancellation instead of duplicating it in Main history');
    assert.ok(pipeLog.endsWith('output.log'));
  }

  // ---- A running auto-background reply clips the unread interval head + tail ----
  {
    const big = await invoke(shellName, {
      command: emit({ lines: 3000, tail: 'RUNNING_TAIL_MARKER', holdMs: 15000, prefix: 'RUN' }),
      timeout: 12,
    });
    const runningText = textOf(big.content);
    const structured = big.structuredContent as ProgrammaticShellResult;
    assertProseResult(runningText);
    assert.match(runningText, /^Job job_[0-9a-f]{8} backgrounded after 3s wait\. The original 12s timeout still applies\./, runningText);
    const runningId = jobIdOf(runningText);
    const runningLog = logPathOf(runningText);
    const footer = RUNNING_TRUNCATION.exec(runningText);
    assert.ok(footer, `a running clipped reply advises omitted and further output (truncated=${String(structured.truncated)}, structuredOutput=${String(structured.output).length} bytes):\n${runningText}`);
    const headStart = footer[1]!;
    const headEnd = footer[2]!;
    const tailStart = footer[3]!;
    const tailEnd = footer[4]!;
    const total = footer[5]!;
    const readFrom = footer[7]!;
    const readNext = footer[8]!;
    assert.equal(footer[6]!, runningLog);
    assert.equal(Number(headStart), 1);
    assert.equal(Number(headEnd), Number(readFrom), 'continuation starts at the last shown head line');
    assert.equal(Number(readNext), Number(total), 'the running reply points at the last shown tail line');
    assert.ok(Number(headEnd) < Number(tailStart));
    assert.equal(Number(tailEnd), Number(total));
    const snapshot = String(structured.output);
    const lines = fileLines(snapshot);
    assert.equal(lines.length, Number(total), 'the footer counts lines at handoff');
    assert.ok((await fsp.readFile(runningLog, 'utf8')).startsWith(snapshot), 'the running log can grow after handoff');
    assert.equal(runningText.slice(0, footer.index).trimEnd().split('\n').at(-1), lines[Number(tailEnd) - 1]);
    assert.ok(runningText.includes('... [omitted lines '));
    const continued = textOf((await fixture.call('read', { path: runningLog, offset: Number(readFrom), limit: 2 })).content);
    assert.ok(continued.startsWith(`${lines[Number(readFrom) - 1]!}\n`));
    await waitForCondition(async () => (await fsp.readFile(runningLog, 'utf8')).includes('RUNNING_TAIL_MARKER'), 'the running Job finishes writing its tail');
    await fixture.call('job_stop', { id: runningId });
  }

  // ---- Background output is clipped head + tail with global 1-based lines ----
  {
    const big = await fixture.call(shellName, {
      command: emit({ lines: 3000, tail: 'BIG_TAIL_MARKER', holdMs: 15000, delayMs: 700, prefix: 'BIG' }),
      background: true,
    });
    const bigText = textOf(big.content);
    assertProseResult(bigText);
    const bigId = jobIdOf(bigText);
    const bigLog = logPathOf(bigText);
    await waitForCondition(async () => {
      const content = await fsp.readFile(bigLog, 'utf8');
      return content.includes('BIG_TAIL_MARKER') && fileLines(content).length >= 3000;
    }, 'the background Job flushed its full log', 10000);
    const stopped = await fixture.call('job_stop', { id: bigId });
    const stoppedText = textOf(stopped.content);
    assertProseResult(stoppedText);
    assert.match(stoppedText, new RegExp(`^Job ${bigId} cancelled(?: \\(exit code -?\\d+\\))?\\.`), stoppedText);
    assert.doesNotMatch(stoppedText, /further output/, 'a terminal result has no further unread output to advise');
    const footer = TERMINAL_TRUNCATION.exec(stoppedText);
    assert.ok(footer, `background clipping must expose head, tail and read offsets:\n${stoppedText}`);
    const headStart = footer[1]!;
    const headEnd = footer[2]!;
    const tailStart = footer[3]!;
    const tailEnd = footer[4]!;
    const total = footer[5]!;
    const footerPath = footer[6]!;
    const readFrom = footer[7]!;
    assert.equal(footerPath, bigLog, 'the log path appears once and names the real output log');
    assert.equal(Number(headStart), 1, 'the head starts at the first unread line');
    assert.ok(Number(headEnd) < Number(tailStart), 'head and tail do not overlap the omitted middle');
    assert.ok(Number(headEnd) - Number(headStart) + 1 <= 2000);
    assert.ok(Number(tailEnd) - Number(tailStart) + 1 <= 2000);
    const lines = fileLines(await fsp.readFile(bigLog, 'utf8'));
    assert.equal(lines.length, Number(total), 'the footer counts the full log in global 1-based lines');
    assert.equal(Number(tailEnd), lines.length, 'the tail ends at the last log line');
    assert.ok(stoppedText.includes(`... [omitted lines ${Number(headEnd) + 1}-${Number(tailStart) - 1}] ...`),
      `the omitted range must cover every dropped line:\n${stoppedText}`);
    assert.ok(stoppedText.includes(lines[0]!), 'the head keeps the first unread line');
    assert.ok(stoppedText.includes('BIG_TAIL_MARKER'), 'the tail keeps the last diagnostics');
    assert.ok([Number(headEnd), Number(headEnd) + 1].includes(Number(readFrom)),
      'omitted-middle continuation overlaps the last shown head line by at most one');
    const continued = textOf((await fixture.call('read', { path: footerPath, offset: Number(readFrom), limit: 2 })).content);
    assert.ok(continued.startsWith(`${lines[Number(readFrom) - 1]!}\n`),
      `reading from the advised line must resume without a gap:\n${continued}`);
  }

  // ---- Completion notifications carry the same clipped prose, once ----
  {
    const big = await fixture.call(shellName, {
      command: emit({ lines: 3000, tail: 'NOTICE_TAIL_MARKER', delayMs: 700, prefix: 'NOTICE' }),
      background: true,
    });
    const bigText = textOf(big.content);
    const bigId = jobIdOf(bigText);
    await waitForCondition(() => noticeChats(bigId).length > 0,
      'the completed Job notifies its owner', 10000);
    await new Promise<void>(resolve => setTimeout(resolve, 300));
    const notices = noticeChats(bigId);
    assert.equal(notices.length, 1, 'a synchronous terminal state is not notified twice');
    const notice = notices[0]!;
    assert.equal(notice.options.sessionId, fixture.sessionManager.getSessionId());
    assertProseResult(notice.text);
    assert.match(notice.text, new RegExp(`^Job ${bigId} completed`, 'm'));
    const footer = TERMINAL_TRUNCATION.exec(notice.text);
    assert.ok(footer, `the completion notice must clip its unread interval:\n${notice.text}`);
    assert.equal(footer[1], '1');
    assert.equal(Number(footer[4]), Number(footer[5]), 'the completed notice ends at the final line');
    assert.ok(notice.text.includes('NOTICE_TAIL_MARKER'));
    assert.ok(notice.text.includes('... [omitted lines '));
    assert.doesNotMatch(notice.text, /further output/, 'a terminal notice has no further unread output to advise');
  }

  // ---- Codemode-style structured output across every execution path ----
  const schema = fixture.session.getToolDefinition(shellName)?.outputSchema as
    | { readonly required?: readonly string[]; readonly properties?: Record<string, unknown> }
    | undefined;
  assert.ok(schema?.properties, 'the shell tool keeps its programmatic output schema');
  for (const field of ['output', 'truncated', 'exit_code', 'wall_time_seconds', 'status']) {
    assert.ok(field in schema.properties, `outputSchema exposes ${field}`);
    assert.ok(schema.required?.includes(field), `outputSchema requires ${field}`);
  }
  assert.ok('job_id' in schema.properties, 'outputSchema can carry a Job reference');

  {
    // Native fallback: no managed CLI, so the SDK's own foreground result is
    // normalized with the same status field instead of a different shape.
    const cli = process.env.PI_ASYNC_SHELL_CLI;
    delete process.env.PI_ASYNC_SHELL_CLI;
    try {
      const native = await invoke(shellName, {
        command: command([process.execPath, '-e', 'process.stdout.write("native fallback"); process.exit(3)'], true), timeout: 2,
      });
      assert.equal(native.isError, true);
      assert.match(textOf(native.content), /native fallback[\s\S]*Command exited with code 3/);
      const structured = native.structuredContent as ProgrammaticShellResult;
      assert.equal(structured.status, 'failed');
      assert.equal(structured.exit_code, 3);
      assert.equal(structured.truncated, false);
      assert.equal(typeof structured.wall_time_seconds, 'number');
      assert.equal('job_id' in structured, false);
      const timedOut = await invoke(shellName, {
        command: command([process.execPath, '-e', 'setTimeout(() => {}, 8000)']), timeout: 1,
      });
      assert.equal(timedOut.isError, true);
      const timeoutShape = timedOut.structuredContent as ProgrammaticShellResult;
      assert.equal(timeoutShape.status, 'timed_out', 'the SDK timeout keeps the unified status');
      assert.equal(timeoutShape.exit_code, null, 'a timed-out command has no exit code');
    } finally {
      process.env.PI_ASYNC_SHELL_CLI = cli;
    }
  }
  {
    const failed = await invoke(shellName, { command: emit({ lines: 1, tail: 'MANAGED_FAILURE', exitCode: 7, prefix: 'MF' }), timeout: 2 });
    assert.equal(failed.isError, true);
    const structured = failed.structuredContent as ProgrammaticShellResult;
    assert.equal(structured.status, 'failed');
    assert.equal(structured.exit_code, 7);
    assert.equal(structured.truncated, false);
    assert.equal(structured.full_output_path, undefined, 'an untruncated synchronous result has no log reference');
    assert.match(String(structured.output), /MANAGED_FAILURE/);
  }
  {
    const job = await invoke(shellName, {
      command: emit({ lines: 2, tail: 'EXPLICIT_STRUCTURED', holdMs: 15000, prefix: 'ES' }), background: true,
    });
    const structured = job.structuredContent as ProgrammaticShellResult;
    assert.equal(structured.status, 'running');
    assert.equal(structured.exit_code, null);
    assert.match(String(structured.job_id), /^job_[0-9a-f]{8}$/);
    assert.equal(structured.full_output_path, logPathOf(textOf(job.content)));
    assert.equal(typeof structured.output, 'string');
    await fixture.call('job_stop', { id: String(structured.job_id) });
  }
  {
    const job = await invoke(shellName, {
      command: emit({ lines: 2, tail: 'AUTO_STRUCTURED', holdMs: 15000, prefix: 'AS' }),
    });
    const structured = job.structuredContent as ProgrammaticShellResult;
    assert.equal(structured.status, 'running');
    assert.equal(structured.exit_code, null);
    assert.match(String(structured.job_id), /^job_[0-9a-f]{8}$/);
    await fixture.call('job_stop', { id: String(structured.job_id) });
  }

  // Codemode resolves the structured value directly; this is the actual nested
  // tool entry a script sees, not a hand-built details object.
  {
    const active = fixture.session.getActiveToolNames();
    const missing = ['codemode', shellName].filter(name => !active.includes(name));
    if (missing.length > 0) fixture.session.setActiveToolsByName([...active, ...missing]);
    const code = `const result = await tools.${shellName}({ command: ${JSON.stringify(
      emit({ lines: 1, tail: 'CODEMODE_MARKER', prefix: 'CM' }))}, timeout: 2 }); return result;`;
    const answer = await fixture.call('codemode', { code });
    assert.notEqual(answer.isError, true, textOf(answer.content));
    const output = textOf(answer.content);
    const match = /Output:\n([\s\S]*)$/.exec(output);
    assert.ok(match, output);
    const value = JSON.parse(match[1]!) as ProgrammaticShellResult;
    assert.equal(value.status, 'completed');
    assert.equal(value.exit_code, 0);
    assert.equal(value.truncated, false);
    assert.match(String(value.output), /CODEMODE_MARKER/);
    assert.equal(typeof value.wall_time_seconds, 'number');
    assert.equal('job_id' in value, false);
  }

  // Cancellation of a held Subagent also stops its outstanding shell resources.
  shellResult = observedTurn();
  await fsp.rm(release);
  const second = await fixture.create('ASYNC_SHELL_CHILD cancellation while awaiting a command');
  await shellResult.promise;
  // Stop acknowledges cancellation and keeps the Actor; the Job ends only when
  // the native resource exits, so settle through the public idle state rather
  // than assuming a terminal completion broadcast exists.
  const stopped = await fixture.call('subagent_signal', { target: second.address, action: 'stop' });
  assert.notEqual(stopped.isError, true, JSON.stringify(stopped.content));
  await fixture.settled(second.id);
  assert.equal('activity' in (await fixture.item(second.id))!, false);
}
