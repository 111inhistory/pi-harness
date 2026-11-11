import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stripCallbackEnv } from '../../test-support/test-environment.mjs';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('../../test-support/rpc-observation-model.ts', import.meta.url));

test('generated RPC histories preserve snapshots, subscriptions and Job ownership', { timeout: 150000 }, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-rpc-model-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const result = await execute(process.execPath, [runner], {
    cwd, timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env: stripCallbackEnv({ ...process.env, PI_OFFLINE: '1',
      PI_CODING_AGENT_DIR: path.join(cwd, 'agent'), PI_SUBAGENT_SOCKET_DIR: path.join(cwd, 'uds') }),
  });
  assert.ok(result.stdout.includes('RPC_OBSERVATION_MODEL_OK'), `${result.stdout}\n${result.stderr}`);
  console.log(result.stdout.trim());
});
