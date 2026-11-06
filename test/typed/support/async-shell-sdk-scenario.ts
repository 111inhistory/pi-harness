import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { lastToolResult, waitForCondition, type ScenarioFixture } from './subagent-sdk-fixture.ts';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Real SDK + Harness + tmux: owned completion resumes the same Subagent Job. */
export async function runAsyncShellScenario(fixture: ScenarioFixture): Promise<void> {
  const executable = process.env.PI_ASYNC_SHELL_CLI;
  assert.ok(executable);
  const command = (args: string[]) => [process.execPath, executable, ...args].map(quote).join(' ');
  const started = path.join(fixture.cwd, 'async-started.json');
  const release = path.join(fixture.cwd, 'async-release');
  const marker = 'ASYNC_PTY_RESULT';
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},JSON.stringify({agentId:process.env.PI_AGENT_ID,socket:process.env.PI_AGENT_SOCKET,tty:process.stdout.isTTY,pid:process.pid}));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){console.log(${JSON.stringify(marker)});clearInterval(timer)}},10)`;
  let waiting = false;
  let shellFailure: string | null = null;
  let childTurns = 0;
  let mainCompleted = false;
  fixture.controls.chat = request => {
    if (request.options.sessionId === fixture.sessionManager.getSessionId()) {
      if (request.text.includes('MAIN_SHELL_RESULT')) mainCompleted = true;
      return fixture.textAnswer('Root received shell result.');
    }
    childTurns++;
    const shell = lastToolResult(request.context.messages, 'bash');
    if (shell === undefined) return fixture.toolAnswer('bash', {
      command: command(['create', '--wait', '0s', '--', process.execPath, '-e', script]),
    });
    if (shell.isError) {
      shellFailure = JSON.stringify(shell.content);
      waiting = true;
      return fixture.textAnswer('Shell failed.');
    }
    if (request.text.includes(marker)) return fixture.textAnswer('Verified asynchronous command result.');
    waiting = true;
    return fixture.textAnswer('Waiting for the command completion.');
  };
  const actor = await fixture.create('ASYNC_SHELL_CHILD execute and verify the asynchronous command');
  await waitForCondition(() => waiting, 'child model yielding after create');
  assert.equal(shellFailure, null, shellFailure ?? undefined);
  await new Promise<void>(resolve => setImmediate(resolve));
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
  await fixture.call('bash', { command: command(['create', '--wait', '0s', '--', process.execPath, '-e', "setTimeout(()=>console.log('MAIN_SHELL_RESULT'),100)"]) });
  await waitForCondition(() => mainCompleted, 'Main shell completion turn');

  // Cancellation of a held Subagent also stops its outstanding shell resources.
  waiting = false;
  await fsp.rm(release);
  const second = await fixture.create('ASYNC_SHELL_CHILD cancellation while awaiting a command');
  await waitForCondition(() => waiting, 'second child awaiting completion');
  await fixture.call('subagent_stop', { id: second.id });
  await fixture.stopped(second.id);
}
