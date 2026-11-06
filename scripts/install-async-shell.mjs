import { lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

if (process.platform === 'win32') throw new Error('The tmux async shell requires a POSIX host.');
const agentDir = getAgentDir();
const resources = [
  [fileURLToPath(new URL('../dist/pi-job.mjs', import.meta.url)), path.join(agentDir, 'bin', 'pi-job'), 'file'],
  [fileURLToPath(new URL('../skills/pi-job', import.meta.url)), path.join(agentDir, 'skills', 'pi-job'), 'dir'],
];
for (const [source, destination, kind] of resources) {
  await lstat(source);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  try {
    const current = await lstat(destination);
    if (!current.isSymbolicLink() || path.resolve(directory, await readlink(destination)) !== source) {
      throw new Error(`Refusing to replace another resource: ${destination}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await symlink(source, destination, kind);
  }
  console.log(`Installed pi-job resource: ${destination}`);
}
