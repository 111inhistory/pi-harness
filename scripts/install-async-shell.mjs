import { chmod, copyFile, lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { samePath } from '../src/fs-path.ts';

const marker = 'pi-harness: pi-job';
const agentDir = getAgentDir();
const binaryName = process.platform === 'win32' ? 'pi-job.exe' : 'pi-job';
const source = fileURLToPath(new URL(`../dist/${binaryName}`, import.meta.url));
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

async function installBinary(destination) {
  try {
    const current = await lstat(destination);
    if (!current.isFile()) throw new Error(`Refusing to replace another resource: ${destination}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await copyFile(source, destination);
  await chmod(destination, 0o755);
  console.log(`Installed pi-job resource: ${destination}`);
}

async function installText(destination, content) {
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
  // The binary sits beside them so paths with Unicode need no cmd.exe literals.
  await installBinary(path.join(bin, 'pi-job.exe'));
  await installText(path.join(bin, 'pi-job.ps1'), [
    `# ${marker} PowerShell launcher`,
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$piJobExe = Join-Path $PSScriptRoot \'pi-job.exe\'',
    '$piJobOutputEncoding = [Console]::OutputEncoding',
    'try {',
    '  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '  if ($MyInvocation.ExpectingInput) {',
    '    $input | & $piJobExe @args',
    '  } else {',
    '    & $piJobExe @args',
    '  }',
    '  $piJobExitCode = $LASTEXITCODE',
    '} finally {',
    '  [Console]::OutputEncoding = $piJobOutputEncoding',
    '}',
    'exit $piJobExitCode', '',
  ].join('\r\n'));
  await installText(path.join(bin, 'pi-job.cmd'), [
    '@echo off', `rem ${marker} cmd launcher`,
    '"%~dp0pi-job.exe" %*', 'exit /b %errorlevel%', '',
  ].join('\r\n'));
  await installText(path.join(bin, 'pi-job'), [
    '#!/bin/sh', `# ${marker} Bash launcher`,
    'basedir=$(dirname "$0")', 'exec "$basedir/pi-job.exe" "$@"', '',
  ].join('\n'));
  // Directory junctions require no symlink privilege on Windows.
  await linkResource(skill, path.join(agentDir, 'skills', 'pi-job'), 'junction');
} else {
  await linkResource(source, path.join(bin, 'pi-job'), 'file');
  await linkResource(skill, path.join(agentDir, 'skills', 'pi-job'), 'dir');
}
