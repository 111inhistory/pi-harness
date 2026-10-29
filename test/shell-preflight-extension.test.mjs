import assert from 'node:assert/strict';
import { mkdtemp, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import shellPreflight from '../extensions/shell-preflight.mjs';

function handlers() {
  const registered = new Map();
  shellPreflight({ on: (name, handler) => registered.set(name, handler) });
  return registered;
}

test('Windows chat commands are checked and executed by native PowerShell operations', { skip: process.platform !== 'win32' }, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'shell-preflight-chat-'));
  try {
    const command = '$value = "中文"; [Console]::WriteLine($value); Set-Content -LiteralPath marker.txt -Value $value -Encoding utf8';
    const result = await handlers().get('user_bash')({ command }, { cwd });
    assert.ok(result.operations);
    await assert.rejects(access(path.join(cwd, 'marker.txt')), { code: 'ENOENT' });
    const chunks = [];
    const executed = await result.operations.exec(command, cwd, { onData: (chunk) => chunks.push(chunk) });
    assert.equal(executed.exitCode, 0);
    assert.match(Buffer.concat(chunks).toString('utf8'), /中文/);
    await access(path.join(cwd, 'marker.txt'));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('Windows chat rejects invalid PowerShell instead of falling through to Bash', { skip: process.platform !== 'win32' }, async () => {
  const result = await handlers().get('user_bash')({ command: 'if ($true) {' }, { cwd: os.tmpdir() });
  assert.equal(result.result.exitCode, 2);
  assert.match(result.result.output, /shell preflight failed/);
  assert.equal(result.operations, undefined);
});

test('non-Windows chat commands keep the SDK default shell execution', { skip: process.platform === 'win32' }, async () => {
  const result = await handlers().get('user_bash')({ command: 'printf hello' }, { cwd: os.tmpdir(), isProjectTrusted: () => false });
  assert.equal(result, undefined);
});
