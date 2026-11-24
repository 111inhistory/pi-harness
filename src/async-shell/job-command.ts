import { execFile } from 'node:child_process';
import { piJobExecutable } from './executable.ts';
import { MAX_FOREGROUND_RESULT_BYTES, validateShellResult, type ShellResult } from './protocol.ts';
import { NATIVE_CANCEL_TIMEOUT_MS } from './cancel.ts';

/** A single submission to the native backend; a missing reply is never replayed. */
export function runJobCommand(
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly input?: string },
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(piJobExecutable(), ['__host', ...args], {
      cwd: options.cwd, env: options.env, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024,
      ...(args[0] === 'create' ? {} : { timeout: NATIVE_CANCEL_TIMEOUT_MS }),
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim() || error.message;
        reject(new Error(error.killed ? `${detail} (operation outcome unknown)` : detail, { cause: error }));
        return;
      }
      try {
        const result = validateShellResult(JSON.parse(stdout), args[0] === 'create' ? MAX_FOREGROUND_RESULT_BYTES : undefined);
        if (args[0] !== 'create' && result.id !== args[1]) throw new Error('Job ID mismatch.');
        resolve(result);
      }
      catch (cause) { reject(new Error('Invalid job backend response; operation outcome is unknown.', { cause })); }
    });
    // A backend refusal can close stdin before the input is flushed. The exit
    // callback still owns the command outcome.
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input);
  });
}
