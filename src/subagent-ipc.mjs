import { windowsIpc, isWindowsPipe } from "./subagent-ipc-windows.mjs";
import { unixIpc } from "./subagent-ipc-unix.mjs";
import { defaultSocketRoot, ensurePrivateSocketRoot } from "./ipc/endpoint.ts";

export { isWindowsPipe, ensurePrivateSocketRoot };
export const ipc = process.platform === "win32" ? windowsIpc : unixIpc;
/**
 * Unix roots are private to the effective system user; an explicit environment
 * override is still honoured and is checked for ownership/permissions by the
 * endpoint helpers before any path is bound or recovered.
 */
export const DEFAULT_SOCKET_DIR = defaultSocketRoot();
export const endpointKey = (address) => ipc.key(address);
export const isIpcPath = (address) => ipc.isEndpoint(address);
