/**
 * Cancel one registered task through the native CLI. The host owns retirement;
 * the CLI owns the on-disk cancel protocol and server shutdown.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { piJobExecutable } from "./executable.ts";

export function cancelTask(directory: string, root: string): Promise<void> {
  if (!existsSync(directory)) return Promise.resolve();
  const id = path.basename(directory);
  return new Promise((resolve, reject) => {
    execFile(piJobExecutable(), ["cancel", id], {
      env: { ...process.env, PI_ASYNC_SHELL_ROOT: root },
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    }, (error, _stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim() || error.message;
        reject(new Error(`pi-job cancel ${id} failed: ${detail}`, { cause: error }));
        return;
      }
      resolve();
    });
  });
}
