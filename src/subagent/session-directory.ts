/**
 * Cross-session directory and routing.
 *
 * Each Pi session (one root) owns a private socket directory under the shared
 * per-UID socket root. A session publishes one small record there while it is
 * live, so another session can find it and reach its Main without a central
 * service. This is the discovery source for cross-session orchestration: the
 * directory lists what is running, each session's name, and the managed socket
 * address of its Main.
 *
 * A session publishes the one managed endpoint it binds, its Main address, and
 * the directory maps a logical session hex to the live session that owns it.
 * Cross-session frames name both ends with logical addresses, the sender as
 * `<session-hex>:main`; the receiving main endpoint parses that identity and
 * hands Runtime a typed external descriptor. Only Main talks across sessions,
 * so another session's subagent address is never a valid cross-session target.
 *
 * Platform scope: the address space is the platform's managed endpoint space —
 * Unix socket files below the session's socket directory, or Windows Named
 * Pipes carrying that directory in their shared prefix. The directory format is
 * portable, and address classification lives in the IPC platform adapter, so the
 * same record serves both transports.
 *
 * The directory is a discovery aid, not an authority: a record only names a
 * session id, its socket directory and its pid. Liveness is re-checked on every
 * read, a dead pid is ignored, and a record is removed only by the session that
 * wrote it. Sender identity remains host-declared inside the same trust model as
 * external socket clients: same-user local processes can already write an
 * endpoint and name a sender.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { samePath } from '../fs-path.ts';
import { managedFrame } from '../ipc/message.ts';
import { deriveSessionUid, writeSocket } from '../ipc/socket.ts';
import { formatAddress, formatMainEndpointPath, MAIN_ACTOR, parseAddress } from './address.ts';
import { SubagentError } from './runtime.ts';

export const SESSION_DIRECTORY = 'sessions';

const RECORD_VERSION = 1;
/** Session uids are exactly the lowercase 8-hex fold `deriveSessionUid` writes. */
const UID_PATTERN = /^[0-9a-f]{8}$/;

/** One live session as published in the shared socket root. */
export interface LiveSession {
  readonly sessionId: string;
  readonly uid: string;
  readonly socketDir: string;
  readonly pid: number;
  readonly cwd: string;
  /** The native session name, when the user set one. Display only. */
  readonly name: string | null;
  readonly startedAt: number;
}

/** The managed Main endpoint of one live session: the cross-session address. */
export function sessionMainAddress(session: LiveSession): string {
  return formatMainEndpointPath(session.socketDir);
}

/** The logical wire identity of a session's Main: `<uid>:main`. */
export function sessionSenderId(uid: string): string {
  return formatAddress(uid, MAIN_ACTOR);
}

function directory(root: string): string {
  return path.join(root, SESSION_DIRECTORY);
}

function recordPath(root: string, uid: string): string {
  return path.join(directory(root), `${uid}.json`);
}

/** A record only counts when it describes exactly the session its file names. */
function readRecord(value: unknown, root: string, uid: string): LiveSession | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data['version'] !== RECORD_VERSION) return null;
  const { sessionId, socketDir, pid, cwd, name, startedAt } = data;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  if (data['uid'] !== uid) return null;
  if (typeof socketDir !== 'string' || !samePath(socketDir, path.join(root, uid))) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof cwd !== 'string') return null;
  if (name !== undefined && name !== null && typeof name !== 'string') return null;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  return { sessionId, uid, socketDir, pid, cwd, name: typeof name === 'string' && name !== '' ? name : null, startedAt };
}

async function writeRecord(root: string, session: LiveSession): Promise<void> {
  const target = recordPath(root, session.uid);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: RECORD_VERSION, ...session })}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user; treat that as
    // live and let the transport refuse the connection instead.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Publish this session. A failed write is the caller's to report: cross-session
 * addressing is auxiliary, so a root may keep running without being reachable.
 */
export async function registerSession(
  root: string,
  entry: { readonly sessionId: string; readonly cwd: string; readonly name?: string | null | undefined },
): Promise<LiveSession> {
  const uid = deriveSessionUid(entry.sessionId);
  const session: LiveSession = {
    sessionId: entry.sessionId,
    uid,
    socketDir: path.join(root, uid),
    pid: process.pid,
    cwd: entry.cwd,
    name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : null,
    startedAt: Date.now(),
  };
  await mkdir(directory(root), { recursive: true, mode: 0o700 });
  await writeRecord(root, session);
  return session;
}

/**
 * Update this session's own published name after the SDK reports a rename.
 *
 * The name comes from the native session metadata; this only mirrors it into the
 * directory. Only the session that owns the record may rewrite it; a record that
 * no longer matches is left untouched.
 */
export async function updateSessionName(
  root: string,
  entry: { readonly sessionId: string; readonly name: string | null },
): Promise<LiveSession | null> {
  const uid = deriveSessionUid(entry.sessionId);
  const target = recordPath(root, uid);
  let current: LiveSession | null;
  try {
    current = readRecord(JSON.parse(await readFile(target, 'utf8')) as unknown, root, uid);
  } catch {
    return null;
  }
  if (current === null || current.sessionId !== entry.sessionId) return null;
  const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : null;
  if (current.name === name) return current;
  const next: LiveSession = { ...current, name };
  await writeRecord(root, next);
  return next;
}

/**
 * Remove this session's own record. A record written by another session, or one
 * that no longer matches, is left untouched; the return value says whether this
 * call removed its own record.
 */
export async function unregisterSession(root: string, sessionId: string): Promise<boolean> {
  const uid = deriveSessionUid(sessionId);
  const target = recordPath(root, uid);
  try {
    const record = readRecord(JSON.parse(await readFile(target, 'utf8')) as unknown, root, uid);
    if (record === null || record.sessionId !== sessionId) return false;
    await unlink(target);
    return true;
  } catch {
    return false;
  }
}

/** Every live session under one socket root, oldest first. Dead pids are skipped. */
export async function liveSessions(root: string): Promise<LiveSession[]> {
  let names: string[];
  try {
    names = await readdir(directory(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  const sessions: LiveSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const uid = name.slice(0, -'.json'.length);
    if (!UID_PATTERN.test(uid)) continue;
    try {
      const record = readRecord(JSON.parse(await readFile(path.join(directory(root), name), 'utf8')) as unknown, root, uid);
      if (record !== null && running(record.pid)) sessions.push(record);
    } catch {
      // A half-written or foreign record is not a live session.
    }
  }
  return sessions.sort((left, right) => left.startedAt - right.startedAt || left.uid.localeCompare(right.uid));
}

export async function sessionByUid(root: string, uid: string): Promise<LiveSession | null> {
  if (!UID_PATTERN.test(uid)) return null;
  return (await liveSessions(root)).find((session) => session.uid === uid) ?? null;
}

/** A remote refusal keeps its code; a transport failure is a delivery error. */
function deliveryError(error: unknown): SubagentError {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code?: unknown }).code)
    : 'delivery_failed';
  return new SubagentError(code, error instanceof Error ? error.message : String(error));
}

/**
 * Deliver one message to another live session's Main.
 *
 * The sender is this root's session; the target is a record resolved from the
 * managed address the caller passed. The frame carries the composite sender
 * identity `<uid>:Main` in the one `from` field, and the receiving root still
 * owns admission: a refusal keeps its code. A timeout or disconnect does not
 * prove the message was not handed over, so nothing is retried here.
 */
export async function sendToSessionEndpoint(
  command: {
    readonly sender: { readonly sessionId: string; readonly uid: string };
    readonly target: LiveSession;
    /** The target's logical address on the receiving root. */
    readonly to: string;
    readonly content: string;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<void> {
  // The directory also lists the sender's own session. Addressing it would frame
  // a composite identity that the receiver would admit as a remote Main, so the
  // self-send rule is enforced here, where the session identity is known.
  if (command.target.sessionId === command.sender.sessionId) {
    throw new SubagentError('invalid_target', 'A session cannot send a cross-session message to itself.');
  }
  if (command.signal?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
  const { frame } = managedFrame({ senderId: sessionSenderId(command.sender.uid), targetId: command.to, content: command.content });
  try {
    await writeSocket(sessionMainAddress(command.target), frame);
  } catch (error) {
    throw deliveryError(error);
  }
}
