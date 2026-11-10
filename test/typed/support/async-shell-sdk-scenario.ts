import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
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
  const command = (args: string[]) => `${shellName === 'powershell' ? '& ' : ''}${[process.execPath.replaceAll('\\', '/'), executable.replaceAll('\\', '/'), ...args].map(quote).join(' ')}`;
  const started = path.join(fixture.cwd, 'async-started.json');
  const release = path.join(fixture.cwd, 'async-release');
  const marker = 'ASYNC_PTY_RESULT';
  const probe = path.join(fixture.cwd, 'async-command.mjs');
  await fsp.writeFile(probe, [
    "import fs from 'node:fs';",
    'const [started, release, marker] = process.argv.slice(2);',
    'fs.writeFileSync(started + ".tmp", JSON.stringify({agentId:process.env.PI_AGENT_ID,socket:process.env.PI_AGENT_SOCKET,tty:process.stdout.isTTY,pid:process.pid}));',
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
      assert.ok(request.text.includes('PI_CODING_AGENT_DIR'), 'Shell guidance names the Skill root environment variable');
      assert.ok(request.text.includes('skills/pi-job/SKILL.md'), 'Shell guidance provides the relative Skill entry');
    }
    if (request.options.sessionId === fixture.sessionManager.getSessionId()) {
      if (request.text.includes('MAIN_SHELL_RESULT')) mainCompletion.resolve();
      return fixture.textAnswer('Root received shell result.');
    }
    childTurns++;
    const shell = lastToolResult(request.context.messages, shellName);
    if (shell === undefined) return fixture.toolAnswer(shellName, {
      command: command(['create', '--wait', '0s', '--timeout', '20s', '--', ...childCommand, marker]),
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
  assert.equal(environment.socket, actor.socket);
  assert.equal(environment.tty, true);
  assert.equal((await fixture.item(actor.id))?.status, 'running');
  assert.equal(fixture.notificationChats.length, 0, 'yielding while a shell is running must not publish Subagent completion');
  await fsp.writeFile(release, 'release');
  const final = await fixture.stopped(actor.id);
  assert.equal(final.id, actor.id);
  assert.ok(childTurns >= 3, 'completion resumes the same child after its waiting answer');
  const shellCallbackRequests = fixture.chats.filter(request => request.options.sessionId !== fixture.sessionManager.getSessionId() && request.text.includes(marker));
  assert.equal(shellCallbackRequests.length, 1, 'the callback is delivered once to its owning child');

  // Main receives its own completion, using the same environment-based route.
  // Hold Main's command until create returns, so completion is necessarily async.
  const mainStarted = path.join(fixture.cwd, 'main-started.json').replaceAll('\\', '/');
  const mainRelease = path.join(fixture.cwd, 'main-release').replaceAll('\\', '/');
  const mainResult = await fixture.call(shellName, {
    command: command(['create', '--wait', '0s', '--timeout', '20s', '--', ...[process.execPath, probe].map(value => value.replaceAll('\\', '/')), mainStarted, mainRelease, 'MAIN_SHELL_RESULT']),
  });
  assert.notEqual(mainResult.isError, true, JSON.stringify(mainResult.content));
  await fsp.writeFile(mainRelease, 'release');
  await mainCompletion.promise;

  // Cancellation of a held Subagent also stops its outstanding shell resources.
  shellResult = observedTurn();
  await fsp.rm(release);
  const second = await fixture.create('ASYNC_SHELL_CHILD cancellation while awaiting a command');
  await shellResult.promise;
  await fixture.call('subagent_stop', { id: second.id });
  await fixture.stopped(second.id);
}
