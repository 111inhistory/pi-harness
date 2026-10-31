import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directories = new Set<string>();
let cleanupRegistered = false;

/** Keep delivered paths readable across root replacement; release on process exit. */
export function temporaryResultDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-subagent-results-'));
  directories.add(directory);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once('exit', () => {
      for (const directory of directories) {
        try { rmSync(directory, { recursive: true, force: true }); }
        catch { /* Exit cleanup is best effort. */ }
      }
    });
  }
  return directory;
}
