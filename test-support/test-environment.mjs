import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * Callback wiring a live Harness injects into its own process environment. A
 * test worker that inherits it would make an ordinary CLI task register with
 * the user's real session, so these keys are removed unless a test sets them
 * explicitly. Windows environment keys are case-insensitive.
 */
export const CALLBACK_ENV_KEYS = [
  'PI_AGENT_ID',
  'PI_AGENT_SOCKET',
  'PI_ASYNC_SHELL_TOKEN',
  'PI_ASYNC_SHELL_ROOT',
  'PI_ASYNC_SHELL_HOST_ERROR',
];
const callbackKeys = new Set(CALLBACK_ENV_KEYS);

/** Copy an environment without ambient callback wiring. */
export function stripCallbackEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (!callbackKeys.has(key.toUpperCase())) clean[key] = value;
  }
  return clean;
}

/** The environment for one test child: ambient wiring removed, explicit settings overlaid. */
export function testEnvironment(env = process.env, explicit = {}) {
  return { ...stripCallbackEnv(env), ...explicit };
}

/** Run the standalone CLI with the sanitized environment every CLI test uses. */
export function runCli(bundle, args, settings = {}) {
  const child = spawn(bundle, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: testEnvironment(process.env, settings.env),
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin?.on('error', () => { /* a refused input closes the pipe early */ });
  child.stdin?.end(settings.input ?? '');
  return once(child, 'exit').then(([code]) => ({ code, stdout, stderr }));
}

/**
 * The CLI prints one metadata line, a blank line, `output:`, then the text this
 * call carried. The log path is the last field and may contain spaces, so the
 * line is matched as a whole instead of split on its separators.
 */
export function parseJobOutput(stdout) {
  const split = stdout.indexOf('\n\n');
  const head = (split === -1 ? stdout : stdout.slice(0, split)).replace(/\n$/, '');
  const rest = split === -1 ? '' : stdout.slice(split + 2);
  const body = rest.startsWith('output:\n') ? rest.slice('output:\n'.length) : rest;
  const fields = /^(job_[0-9a-f]{8}) {2}(\w+)(?: {2}exit (-?\d+))? {2}cursor (\d+)( {2}more output pending)? {2}log (.+)$/.exec(head);
  if (fields === null) throw new Error(`not a pi-job result:\n${stdout}`);
  return {
    id: fields[1],
    status: fields[2],
    exitCode: fields[3] === undefined ? null : Number(fields[3]),
    cursor: Number(fields[4]),
    truncated: fields[5] !== undefined,
    output: body,
    logPath: fields[6],
  };
}
