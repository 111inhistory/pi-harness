import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { stripCallbackEnv } from '../test-support/test-environment.mjs';

const mode = process.argv[2] ?? 'all';
if (!['all', 'typed'].includes(mode)) throw new Error(`Unknown test group: ${mode}`);
async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collect(path);
    if (mode !== 'typed' && entry.name.endsWith('.test.mjs')) return [path];
    if (entry.name.endsWith('.test.ts')) return [path];
    return [];
  }));
  return files.flat();
}
const files = (await collect('test')).sort();
if (files.length === 0) throw new Error(`No tests found for ${mode}`);
// A dedicated group lets interruption stop this run's workers and SDK fixtures,
// never another harness session's processes. Windows has no POSIX groups.
const grouped = process.platform !== 'win32';
const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-timeout=60000', ...files], {
  stdio: 'inherit', detached: grouped, env: stripCallbackEnv(process.env),
});
let interrupted = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (interrupted !== null) return;
    interrupted = signal;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    if (child.pid === undefined) return;
    try {
      if (grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  });
}
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (interrupted !== null) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
  else if (signal) { console.error(`Test process terminated by ${signal}`); process.exitCode = 1; }
  else process.exitCode = code ?? 1;
});
