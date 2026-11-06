import { lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { samePath } from '../src/fs-path.ts';

const marker = 'pi-harness: pi-job';
const agentDir = getAgentDir();
const source = fileURLToPath(new URL('../dist/pi-job.mjs', import.meta.url));
const skill = fileURLToPath(new URL('../skills/pi-job', import.meta.url));
const bin = path.join(agentDir, 'bin');
await mkdir(bin, { recursive: true });
await lstat(source);
await lstat(skill);

async function linkResource(source, destination, kind) {
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  try {
    const current = await lstat(destination);
    if (!current.isSymbolicLink() || !samePath(path.toNamespacedPath(path.resolve(directory, await readlink(destination))), path.toNamespacedPath(source))) {
      throw new Error(`Refusing to replace another resource: ${destination}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await symlink(source, destination, kind);
  }
  console.log(`Installed pi-job resource: ${destination}`);
}

async function installFile(destination, content) {
  try {
    const current = await lstat(destination);
    if (!current.isFile() || !(await readFile(destination, 'utf8')).slice(0, 256).includes(marker)) {
      throw new Error(`Refusing to replace another resource: ${destination}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeFile(destination, content, { mode: 0o755 });
  console.log(`Installed pi-job resource: ${destination}`);
}

if (process.platform === 'win32') {
  // Native PowerShell uses its launcher; Git Bash uses the extensionless one.
  // Keep the bundle beside them so paths with Unicode need no cmd.exe literals.
  await installFile(path.join(bin, 'pi-job.mjs'), await readFile(source, 'utf8'));
  const node = process.execPath.replaceAll("'", "''");
  await installFile(path.join(bin, 'pi-job.ps1'), [
    `# ${marker} PowerShell launcher`,
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$piJobBundle = Join-Path $PSScriptRoot \'pi-job.mjs\'',
    'if ($MyInvocation.ExpectingInput) {',
    `  $input | & '${node}' $piJobBundle @args`,
    '} else {',
    `  & '${node}' $piJobBundle @args`,
    '}',
    'exit $LASTEXITCODE', '',
  ].join('\r\n'));
  await installFile(path.join(bin, 'pi-job.cmd'), [
    '@echo off', `rem ${marker} cmd launcher`,
    'node "%~dp0pi-job.mjs" %*', 'exit /b %errorlevel%', '',
  ].join('\r\n'));
  await installFile(path.join(bin, 'pi-job'), [
    '#!/bin/sh', `# ${marker} Bash launcher`,
    'basedir=$(dirname "$0")', 'exec node "$basedir/pi-job.mjs" "$@"', '',
  ].join('\n'));
  // Directory junctions require no symlink privilege on Windows.
  await linkResource(skill, path.join(agentDir, 'skills', 'pi-job'), 'junction');
} else {
  await linkResource(source, path.join(bin, 'pi-job'), 'file');
  await linkResource(skill, path.join(agentDir, 'skills', 'pi-job'), 'dir');
}
