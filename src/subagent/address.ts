/**
 * Pure local-IPC address formatting.
 *
 * The lifecycle only needs the address string of an actor; it must not load
 * the Socket transport (or its filesystem ownership code) to print a path.
 * The transport remains the owner of binding, permission checks and cleanup.
 * `src/subagent/runtime.ts` therefore keeps the transport-free default, and a
 * host may inject its own formatter through `RuntimeOptions.agentSocketPath`.
 */

import path from 'node:path';
import { defaultSocketRoot, pipePath } from '../ipc/address.ts';

/** The address a single actor is bound to, without touching that address. */
export function formatAgentSocketPath(id: string, socketDir: string = defaultSocketRoot()): string {
  if (process.platform === "win32") return pipePath(socketDir, id);
  return path.join(socketDir, `${id}.sock`);
}
