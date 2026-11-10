/**
 * Address derivation and machine-readable discovery for the Harness RPC endpoint.
 *
 * The endpoint reuses the same private per-session socket directory as the
 * Agent endpoints (`<socketRoot>/<session-uid>/`). Its own name is
 * `harness-rpc.sock` on Unix and a derived Named Pipe on Windows, so it never
 * shares an address with `Main.sock`, the Agent endpoints or the broadcast
 * endpoints.
 *
 * Discovery is a small JSON record in the same private directory, not a Slash
 * command and never a line on Pi's native stdout. It names the endpoint, the
 * protocol version, the owning session and pid, so a client can attach without
 * parsing human output. The record is removed on clean shutdown.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ensurePrivateDirectory } from '../ipc/endpoint.ts';
import { deriveSessionUid, getAgentSocketPath } from '../ipc/socket.ts';
import { HARNESS_RPC_PROTOCOL_VERSION } from './protocol.ts';

export const HARNESS_RPC_ENDPOINT_NAME = 'harness-rpc';
export const HARNESS_RPC_RECORD_FILE = 'harness-rpc.json';

export interface HarnessRpcTarget {
  /** The private per-session socket directory. */
  readonly socketDir: string;
  /** The bound endpoint address (Unix socket path or Named Pipe). */
  readonly address: string;
  /** The discovery record path. */
  readonly recordPath: string;
}

/** Derive this session's Harness RPC endpoint and discovery-record paths. */
export function harnessRpcTarget(socketRoot: string, sessionId: string): HarnessRpcTarget {
  const socketDir = path.join(socketRoot, deriveSessionUid(sessionId));
  return {
    socketDir,
    address: getAgentSocketPath(HARNESS_RPC_ENDPOINT_NAME, socketDir),
    recordPath: path.join(socketDir, HARNESS_RPC_RECORD_FILE),
  };
}

export interface HarnessRpcRecord {
  readonly protocolVersion: number;
  readonly address: string;
  readonly sessionId: string;
  readonly pid: number;
  readonly startedAt: string;
}

/** Publish (atomically replace) the discovery record inside the private dir. */
export function publishHarnessRpcRecord(target: HarnessRpcTarget, sessionId: string): void {
  ensurePrivateDirectory(target.socketDir);
  const record: HarnessRpcRecord = {
    protocolVersion: HARNESS_RPC_PROTOCOL_VERSION,
    address: target.address,
    sessionId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const temporary = `${target.recordPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target.recordPath);
}

/** Remove the discovery record this process published. Missing is success. */
export function removeHarnessRpcRecord(target: HarnessRpcTarget): void {
  try {
    fs.unlinkSync(target.recordPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
