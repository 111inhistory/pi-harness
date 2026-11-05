import path from "node:path";

import type { IpcPlatform } from "./platform.ts";

import { PIPE_ROOT, pipeNamespace, pipePath } from './address.ts';

export function isWindowsPipe(address: unknown): address is string {
  return typeof address === "string" && address.toLowerCase().startsWith(PIPE_ROOT.toLowerCase());
}

export const windowsIpc: IpcPlatform = {
  agentPath: (id, root) => pipePath(root, id),
  broadcastPath: (id, root) => pipePath(root, `${id}-children`),
  key: (address) => isWindowsPipe(address) ? address.toLowerCase() : path.win32.resolve(address),
  isEndpoint: isWindowsPipe,
  isNamespace: isWindowsPipe,
  /**
   * A Named Pipe carries its socket root in the name, so membership is the
   * shared prefix, not a filesystem containment test. Pipe names are compared
   * case-insensitively because the kernel namespace is.
   */
  belongsToNamespace: (address, socketDir) =>
    isWindowsPipe(address) && address.toLowerCase().startsWith(pipeNamespace(socketDir).toLowerCase()),
  // Named Pipes belong to the kernel namespace, not to the filesystem.
  prepare() {},
  remove() {},
};
