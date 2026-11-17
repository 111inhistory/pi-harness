/**
 * Cancel one registered task through the native CLI. The host owns retirement;
 * the CLI owns the on-disk cancel protocol and server shutdown.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { piJobExecutable } from "./executable.ts";

/**
 * One upper bound for the whole native cancel finalization.
 *
 * Go owns the cleanup contract in `go/internal/asyncshell/release.go` and
 * `tmux.go`: a single `releaseTaskBackend` verifies persisted ownership,
 * probes the backend tri-state, kills only after verification, and confirms
 * stop with a bounded post-kill probe. Its cancel budget is
 * `CancelBudgetMs = 40_000` (conservative static worst case ~35.7s when a final
 * dial overlaps the post-kill deadline, with cancel-scoped controls at 5s);
 * there is no retry or supervisor, and an unknown outcome
 * returns nonzero and never writes `closed`.
 *
 * This TS timeout adds a fixed 5s process/exit margin over that native budget.
 * It is a timeout, never a retry, watchdog or second authority. The host
 * retains its owner/task fence when this rejects.
 */
export const NATIVE_CANCEL_TIMEOUT_MS = 45_000;

export function cancelTask(directory: string, root: string): Promise<void> {
  if (!existsSync(directory)) return Promise.resolve();
  const id = path.basename(directory);
  return new Promise((resolve, reject) => {
    execFile(piJobExecutable(), ["cancel", id], {
      env: { ...process.env, PI_ASYNC_SHELL_ROOT: root },
      encoding: "utf8",
      timeout: NATIVE_CANCEL_TIMEOUT_MS,
      windowsHide: true,
    }, (error, _stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim() || error.message;
        // A timeout is an unknown native cleanup outcome, never a successful
        // cancellation. The host retains the execution lease on this rejection.
        const timedOut = (error as { readonly killed?: unknown }).killed === true;
        const outcome = timedOut ? ' (cleanup outcome unknown; the owner/task fence is retained)' : '';
        reject(new Error(`pi-job cancel ${id} failed: ${detail}${outcome}`, { cause: error }));
        return;
      }
      resolve();
    });
  });
}
