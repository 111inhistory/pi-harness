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
  /**
   * Whether one managed endpoint address belongs to the endpoint namespace a
   * session's socket directory maps to.
   *
   * This is address classification only: it says which session's address space
   * an address is in, and grants no authority over the endpoint. Unix nests
   * endpoints below the directory; Windows folds the directory into one pipe
   * prefix, so the rule cannot be expressed as a filesystem path test.
   */
  belongsToNamespace(address: string, socketDir: string): boolean;
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
