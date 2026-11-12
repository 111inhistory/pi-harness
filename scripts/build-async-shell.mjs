/**
 * Build the async-shell CLI as one native Go binary.
 *
 * Usage: `node scripts/build-async-shell.mjs [outfile]`, default
 * `dist/pi-job` (`dist/pi-job.exe` on Windows). Tests build their own copy into a
 * temporary directory, so a full run never executes the same artifact twice.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const defaultName = process.platform === 'win32' ? path.join('dist', 'pi-job.exe') : path.join('dist', 'pi-job');
const outfile = path.resolve(root, process.argv[2] ?? defaultName);

mkdirSync(path.dirname(outfile), { recursive: true });
const build = spawnSync('go', ['build', '-o', outfile, './cmd/pi-job'], { cwd: root, stdio: 'inherit' });
if (build.error) {
  console.error(build.error.message);
  process.exit(1);
}
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
if (process.platform !== 'win32') chmodSync(outfile, 0o755);
process.stdout.write(`${outfile}\n`);
