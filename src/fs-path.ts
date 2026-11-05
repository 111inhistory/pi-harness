/**
 * Lexical filesystem path equivalence under the platform's default path rules.
 *
 * Two recorded paths denote the same entry when the platform's default rules say
 * so: Windows resolves separators and compares case-insensitively, POSIX keeps
 * byte-exact, case-sensitive names. This compares resolved strings only — no
 * filesystem query, no realpath canonicalization, no symlink or hard-link
 * identity. Callers pass absolute paths. The platform argument selects the path
 * dialect, so Windows behaviour is testable without a Windows host.
 *
 * This is deliberately not the IPC endpoint identity. A Named Pipe address is a
 * kernel object name, not a filesystem path, and must never be normalized here;
 * endpoint comparison stays in the platform adapter (`ipc.key`).
 */

import path from "node:path";

const dialect = (platform: NodeJS.Platform): path.PlatformPath => platform === "win32" ? path.win32 : path.posix;

/** Whether two paths name the same entry under the platform's default rules. */
export function samePath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  const api = dialect(platform);
  const normalize = (value: string): string => {
    const resolved = api.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/** Whether a file sits directly in a directory under the platform's default rules. */
export function sameParentDirectory(file: string, directory: string, platform: NodeJS.Platform = process.platform): boolean {
  const api = dialect(platform);
  return samePath(api.dirname(api.resolve(file)), directory, platform);
}
