import crypto from "node:crypto";
import path from "node:path";

const PIPE_ROOT = "\\\\.\\pipe\\";
export function isWindowsPipe(address) {
  return typeof address === "string" && address.toLowerCase().startsWith(PIPE_ROOT.toLowerCase());
}

function pipePath(root, name) {
  const namespace = crypto.createHash("sha256").update(path.win32.resolve(root).toLowerCase()).digest("hex").slice(0, 12);
  return `${PIPE_ROOT}pi-harness-${namespace}-${name}.sock`;
}

export const windowsIpc = {
  agentPath: (id, root) => pipePath(root, id),
  broadcastPath: (id, root) => pipePath(root, `${id}-children`),
  key: (address) => isWindowsPipe(address) ? address.toLowerCase() : path.win32.resolve(address),
  isEndpoint: isWindowsPipe,
  isNamespace: isWindowsPipe,
  // Named Pipes belong to the kernel namespace, not to the filesystem.
  prepare() {},
  remove() {},
};
