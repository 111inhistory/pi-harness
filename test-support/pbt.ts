import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import fc, { type IRawProperty } from 'fast-check';
import { stripCallbackEnv } from './test-environment.mjs';

const execute = promisify(execFile);

/** Keep SDK imports inside the child, after its private environment is installed. */
export async function runModelSubprocess(t: TestContext, runner: URL, success: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-pbt-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const result = await execute(process.execPath, [fileURLToPath(runner)], {
    cwd, timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env: stripCallbackEnv({ ...process.env, PI_OFFLINE: '1',
      PI_CODING_AGENT_DIR: path.join(cwd, 'agent'), PI_SUBAGENT_SOCKET_DIR: path.join(cwd, 'uds') }),
  });
  assert.ok(result.stdout.includes(success), `${result.stdout}\n${result.stderr}`);
  console.log(result.stdout.trim());
}

export function commandOptions(defaultMaxCommands: number) {
  return {
    maxCommands: Number(process.env.PI_PBT_MAX_COMMANDS ?? defaultMaxCommands),
    ...(process.env.PI_PBT_COMMAND_SIZE === 'max' ? { size: 'max' as const } : {}),
    ...(process.env.PI_PBT_COMMAND_PATH === undefined ? {} : { replayPath: process.env.PI_PBT_COMMAND_PATH }),
  };
}

/** Leave generation, shrinking and replay with fast-check; report its actual outcome. */
export async function checkProperty<T>(property: IRawProperty<T, true>) {
  const report = await fc.check(property, {
    numRuns: Number(process.env.PI_PBT_RUNS ?? 50),
    ...(process.env.PI_PBT_SEED === undefined ? {} : { seed: Number(process.env.PI_PBT_SEED) }),
    ...(process.env.PI_PBT_PATH === undefined ? {} : { path: process.env.PI_PBT_PATH }),
  });
  console.log(`PBT seed=${report.seed} runs=${report.numRuns} shrinks=${report.numShrinks}`);
  if (report.failed) throw new Error(await fc.asyncDefaultReportMessage(report), { cause: report.errorInstance });
}
