import os from "node:os";
import path from "node:path";
import { unixIpc } from "./subagent-ipc-unix.mjs";
import { windowsIpc, isWindowsPipe } from "./subagent-ipc-windows.mjs";

export { isWindowsPipe };
export const ipc = process.platform === "win32" ? windowsIpc : unixIpc;
export const DEFAULT_SOCKET_DIR = process.env.PI_SUBAGENT_SOCKET_DIR ||
  (process.platform === "win32" ? path.join(os.tmpdir(), "pi-subagents") : "/tmp/pi-subagents");
export const endpointKey = (address) => ipc.key(address);
export const isIpcPath = (address) => ipc.isEndpoint(address);
