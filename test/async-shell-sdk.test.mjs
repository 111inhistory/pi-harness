import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, describe } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const backend = process.platform === 'win32' ? 'psmux.exe' : 'tmux';
const available = spawnSync(backend, ['-V'], { stdio: 'ignore', timeout: 5000 }).status === 0;
const fixture = fileURLToPath(new URL('../test-support/subagent-sdk-scenario.mjs', import.meta.url));
const build = fileURLToPath(new URL('../scripts/build-async-shell.mjs', import.meta.url));

const shells = process.platform === 'win32' ? ['bash', 'powershell'] : ['bash'];
describe('Async shell SDK scenarios', { concurrency: 2 }, () => {
  for (const shell of shells) {
    const scenario = shell === 'powershell' ? 'async-shell-powershell' : 'async-shell';
    test(`native terminal completion resumes its owning SDK Subagent through ${shell}`, {
      skip: !available, timeout: 30000,
    }, async t => {
      const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-shell-sdk-'));
      t.after(() => fsp.rm(cwd, { recursive: true, force: true }));
      const cli = path.join(cwd, 'pi-job.mjs');
      await execute(process.execPath, [build, cli]);
      try {
        const { stdout, stderr } = await execute(process.execPath, [fixture, scenario], {
          cwd, timeout: 25000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
          env: {
            ...process.env, PI_OFFLINE: '1', PI_ASYNC_SHELL_CLI: cli,
            PI_CODING_AGENT_DIR: path.join(cwd, 'agent'), PI_SUBAGENT_SOCKET_DIR: path.join(cwd, 'uds'),
          },
        });
        assert.ok(stdout.includes(`SCENARIO_OK:${scenario}`), `${stdout}\n${stderr}`);
      } catch (error) {
        assert.fail(`Async shell SDK acceptance failed:\n${error.stdout ?? ''}\n${error.stderr ?? error.message}`);
      }
    });
  }
});
