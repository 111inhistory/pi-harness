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
  const child = spawn(process.execPath, [bundle, ...args], {
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
