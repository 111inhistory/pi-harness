/**
 * Build the async-shell CLI into one runnable file.
 *
 * Usage: `node scripts/build-async-shell.mjs [outfile]`, default
 * `dist/pi-job.mjs`. Tests build their own copy into a temporary directory, so a
 * full run never has two processes writing or executing the same bundle.
 *
 * The result is an ESM bundle with a Node shebang, so the installation step only
 * has to put it on PATH. Node builtins stay external; the bundle carries the
 * task backend, the protocol and the IPC write path.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const outfile = path.resolve(root, process.argv[2] ?? path.join('dist', 'pi-job.mjs'));

mkdirSync(path.dirname(outfile), { recursive: true });
await build({
  entryPoints: [path.join(root, 'src', 'async-shell', 'cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  banner: { js: '#!/usr/bin/env node' },
});
chmodSync(outfile, 0o755);
process.stdout.write(`${outfile}\n`);
