/**
 * The one output shape: a metadata line, then the text this call carried.
 *
 * A caller reads the first line for identity, status, exit code, continuation
 * point and the complete filtered transcript, and the lines after the `output:`
 * marker as the command's own text. Only the frames a Harness host admits are
 * JSON; nothing on stdout is.
 */

import type { ShellResult } from "./protocol.ts";

/**
 * `job_x  completed  exit 0  cursor 12  log /tmp/job_x/output.log`, a blank line,
 * `output:`, then the text byte for byte. The log path is last because it may
 * contain spaces.
 */
export function formatResult(result: ShellResult): string {
  const head = [
    result.id,
    result.status,
    ...(result.exitCode === null ? [] : [`exit ${result.exitCode}`]),
    `cursor ${result.cursor}`,
    ...(result.truncated ? ["more output pending"] : []),
    `log ${result.logPath}`,
  ].join("  ");
  return `${head}\n\noutput:\n${result.output}`;
}

/** `pi-job: <what went wrong>`, with the command overview when the call was refused. */
export function formatError(message: string, usage: string | null): string {
  return usage === null ? `pi-job: ${message}\n` : `pi-job: ${message}\n\n${usage}\n`;
}
