import { defaultSocketRoot } from './address.ts';
import {
  ensurePrivateSocketRoot,
  type EndpointIdentity,
} from "./endpoint.ts";
import { unixIpc } from "./platform-unix.ts";
import { windowsIpc, isWindowsPipe } from "./platform-windows.ts";

export interface IpcPlatform {
  agentPath(id: string, root: string): string;
  broadcastPath(id: string, root: string): string;
  key(address: string): string;
  isEndpoint(address: unknown): boolean;
  isNamespace(address: unknown): boolean;
  prepare(address: string): unknown;
  remove(address: string, identity?: EndpointIdentity | null): unknown;
}

export { isWindowsPipe, ensurePrivateSocketRoot };

export const ipc: IpcPlatform = process.platform === "win32" ? windowsIpc : unixIpc;
/**
 * Unix roots are private to the effective system user; an explicit environment
 * override is still honoured and is checked for ownership/permissions by the
 * endpoint helpers before any path is bound or recovered.
 */
export const DEFAULT_SOCKET_DIR = defaultSocketRoot();
export const endpointKey = (address: string): string => ipc.key(address);
export const isIpcPath = (address: unknown): boolean => ipc.isEndpoint(address);
