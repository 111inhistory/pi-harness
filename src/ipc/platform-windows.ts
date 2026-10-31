import path from "node:path";

import type { IpcPlatform } from "./platform.ts";

import { PIPE_ROOT, pipePath } from './address.ts';

export function isWindowsPipe(address: unknown): address is string {
  return typeof address === "string" && address.toLowerCase().startsWith(PIPE_ROOT.toLowerCase());
}

export const windowsIpc: IpcPlatform = {
  agentPath: (id, root) => pipePath(root, id),
  broadcastPath: (id, root) => pipePath(root, `${id}-children`),
  key: (address) => isWindowsPipe(address) ? address.toLowerCase() : path.win32.resolve(address),
  isEndpoint: isWindowsPipe,
  isNamespace: isWindowsPipe,
  // Named Pipes belong to the kernel namespace, not to the filesystem.
  prepare() {},
  remove() {},
};
