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

/** Real SDK + Harness + native terminal: completion resumes the same Subagent Job. */
export async function runAsyncShellScenario(fixture: ScenarioFixture, shellName: 'bash' | 'powershell' = 'bash'): Promise<void> {
  const executable = process.env.PI_ASYNC_SHELL_CLI;
  assert.ok(executable);
  const quote = shellName === 'powershell' ? powerShellQuote : posixQuote;
  const command = (args: string[]) => `${shellName === 'powershell' ? '& ' : ''}${args.map(quote).join(' ')}`;
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
  const childCommand = [process.execPath, probe, started, release].map(value => value.replaceAll('\\', '/'));
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

  const inputJob = await fixture.call(shellName, {
    command: command([process.execPath.replaceAll('\\', '/'), '-e',
      'require("node:readline").createInterface({input:process.stdin}).once("line", line => { console.log("INPUT:" + line); process.exit(0); });']),
    background: true, pty: true, timeout: 20,
  });
  const inputItem = inputJob.content[0];
  assert.ok(inputItem?.type === 'text' && typeof inputItem.text === 'string');
  const inputJobRef = JSON.parse(inputItem.text);
  assert.equal(inputJobRef.status, 'running');
  await fixture.call('job_send', { id: inputJobRef.id, text: 'literal job input' });
  assert.doesNotMatch(await fsp.readFile(inputJobRef.logPath, 'utf8'), /INPUT:literal job input/);
  await fixture.call('job_key', { id: inputJobRef.id, key: 'Enter' });
  await waitForCondition(async () => /INPUT:literal job input/.test(await fsp.readFile(inputJobRef.logPath, 'utf8')), 'PTY input reaches the process');

  {
    const quick = await fixture.call(shellName, {
      command: shellName === 'powershell' ? 'Write-Output $env:HARNESS_FIXTURE_PREFIX' : 'printf "%s\\n" "$HARNESS_FIXTURE_PREFIX"',
      background: true,
    });
    const quickItem = quick.content[0];
    assert.ok(quickItem?.type === 'text' && typeof quickItem.text === 'string');
    const quickJob = JSON.parse(quickItem.text);
    assert.match(quickJob.id, /^job_[0-9a-f]{8}$/);
    assert.ok(quickJob.status === 'running' || quickJob.status === 'completed', quickItem.text);
    await waitForCondition(async () => (await fsp.readFile(quickJob.logPath, 'utf8')).trim().length > 0, `quick Job output (${quickJob.id})`);
    const log = await fixture.call('read', { path: quickJob.logPath });
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
    const job = JSON.parse(item.text);
    assert.equal(job.status, 'running', 'without timeout, the wait window returns the original job');
    assert.match(job.id, /^job_[0-9a-f]{8}$/);
    await waitForCondition(async () => { try { await fsp.access(nonTty); return true; } catch { return false; } }, 'pipe startup');
    const pipeEnvironment = JSON.parse(await fsp.readFile(nonTty, 'utf8'));
    assert.equal(pipeEnvironment.tty, false);
    assert.equal(pipeEnvironment.sessionId, fixture.sessionManager.getSessionId());
    await assert.rejects(fixture.call('job_send', { id: job.id, text: 'not delivered', enter: true }), /not accepting terminal input/);
    const stopped = await fixture.call('job_stop', { id: job.id });
    const stopText = stopped.content[0];
    assert.ok(stopText?.type === 'text' && typeof stopText.text === 'string');
    assert.equal(JSON.parse(stopText.text).status, 'cancelled');
    assert.equal(fixture.sessionManager.getBranch().some(entry => entry.type === 'custom_message'
      && JSON.stringify(entry.content).includes(job.id)), false, 'stop reports cancellation instead of duplicating it in Main history');
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
