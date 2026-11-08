import assert from 'node:assert/strict';
import test from 'node:test';
import { runShellPolicy } from '../../src/shell-approval/command.ts';
import { resolveHarnessConfig, HarnessConfigError } from '../../src/harness-config.ts';
import type { ShellApprovalAction } from '../../src/shell-approval/types.ts';

const action: ShellApprovalAction = {
  version: 1, shell: '/bin/bash', command: 'echo "$(touch /tmp/never-execute-this)"',
  cwd: process.cwd(), platform: 'posix', source: 'synthetic-agent',
};

test('policy command receives exact JSON without interpreting command text or retaining callback authority', async () => {
  const source = `let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>{
    const request=JSON.parse(input);
    const authority=['PI_AGENT_ID','PI_AGENT_SOCKET','PI_ASYNC_SHELL_TOKEN','PI_ASYNC_SHELL_ROOT'];
    process.stdout.write(JSON.stringify({decision:authority.some(k=>process.env[k])?'deny':'allow',reason:request.command}));
  });`;
  const result = await runShellPolicy([process.execPath, '-e', source], action);
  assert.deepEqual(result, { decision: 'allow', reason: action.command });
});

test('policy failures, invalid decisions, cancellation and timeouts require review', async () => {
  for (const source of ['process.exit(3)', 'console.log("not json")', 'console.log(JSON.stringify({decision:"approved",reason:"bad"}))']) {
    assert.equal((await runShellPolicy([process.execPath, '-e', source], action)).decision, 'review');
  }
  assert.equal((await runShellPolicy([], action)).decision, 'review');
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal((await runShellPolicy([process.execPath, '-e', 'process.exit(0)'], action, cancelled.signal)).decision, 'review');
  assert.match((await runShellPolicy([process.execPath, '-e', 'setInterval(()=>{},1000)'], action, undefined, 50)).reason, /timed out/);
});

test('Shell approval configuration has independent gates and strict mode, command and timeout validation', () => {
  const defaults = resolveHarnessConfig().shell;
  assert.equal(defaults.preflight, true);
  assert.equal(defaults.approval.enabled, false);
  assert.equal(defaults.approval.mode, 'auto');
  assert.equal(defaults.approval.manualTimeoutMs, 30_000);
  assert.equal(defaults.approval.notificationUrl, '');
  for (const notificationUrl of ['http://localhost:1234/notify', 'https://example.invalid/fake-device-key?group=Pi', '']) {
    const configured = resolveHarnessConfig([{ source: 'synthetic.json', value: { shell: { approval: { notificationUrl } } } }]);
    assert.equal(configured.shell.approval.notificationUrl, notificationUrl);
  }
  const config = resolveHarnessConfig([{ source: 'synthetic.json', value: { shell: {
    preflight: false, approval: { enabled: true, mode: 'ask', command: ['node', 'policy.js'], reviewer: { enabled: false } },
  } } }]);
  assert.equal(config.shell.preflight, false);
  assert.equal(config.shell.approval.enabled, true);
  assert.equal(config.shell.approval.reviewer.enabled, false);
  for (const approval of [{ mode: 'invalid' }, { command: 'sh policy.sh' }, { command: [''] }, { manualTimeoutMs: 0 }, { notificationUrl: 'file:///tmp/fake-key' }, { notificationUrl: 'fake-key' }, { notificationUrl: 42 }, { reviewer: { provider: '' } }]) {
    assert.throws(() => resolveHarnessConfig([{ source: 'synthetic.json', value: { shell: { approval } } }]), HarnessConfigError);
  }
});
