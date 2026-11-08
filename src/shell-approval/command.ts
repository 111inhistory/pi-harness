import { spawn } from 'node:child_process';
import type { ShellApprovalAction, ShellPolicyDecision } from './types.ts';

const MAX_OUTPUT_BYTES = 256 * 1024;

/** Policy programs receive JSON over stdin and never interpret the input as shell text. */
export async function runShellPolicy(
  program: readonly string[],
  action: ShellApprovalAction,
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<ShellPolicyDecision> {
  if (program.length === 0) return { decision: 'review', reason: 'No static command policy is configured.' };
  if (signal?.aborted) return { decision: 'review', reason: 'The command policy check was cancelled.' };
  return new Promise(resolve => {
    const env = { ...process.env };
    for (const key of ['PI_AGENT_ID', 'PI_AGENT_SOCKET', 'PI_ASYNC_SHELL_TOKEN', 'PI_ASYNC_SHELL_ROOT']) delete env[key];
    const child = spawn(program[0]!, program.slice(1), {
      cwd: action.cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let size = 0;
    let settled = false;
    const finish = (result: ShellPolicyDecision): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(result);
    };
    const stop = (reason: string): void => {
      child.kill('SIGKILL');
      finish({ decision: 'review', reason });
    };
    const cancel = (): void => stop('The command policy check was cancelled.');
    const timer = setTimeout(() => stop('The command policy check timed out; further approval is required.'), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_OUTPUT_BYTES) stop('The command policy output exceeded the size limit; further approval is required.');
      else stdout += chunk;
    });
    // Drain diagnostics without exposing policy environment or arbitrary control sequences.
    child.stderr.resume();
    child.on('error', () => finish({ decision: 'review', reason: 'The command policy program could not be started.' }));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return finish({ decision: 'review', reason: 'The command policy program failed; further approval is required.' });
      try {
        const result: unknown = JSON.parse(stdout);
        if (result === null || typeof result !== 'object' || !('decision' in result) || !('reason' in result)
          || !['allow', 'deny', 'review'].includes(String(result.decision)) || typeof result.reason !== 'string') {
          throw new Error('invalid policy decision');
        }
        const decision = result.decision;
        if (decision !== 'allow' && decision !== 'deny' && decision !== 'review') throw new Error('invalid decision');
        finish({ decision, reason: result.reason });
      } catch {
        finish({ decision: 'review', reason: 'The command policy returned an invalid result; further approval is required.' });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(action));
  });
}
