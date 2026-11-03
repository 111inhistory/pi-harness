/**
 * Cross-session directory and addressing.
 *
 * Each Pi session (one root) owns a private socket directory under the shared
 * per-UID socket root. A session publishes one small record there while it is
 * live, so another session can find it and reach its Main without a central
 * service. This is the discovery source for cross-session orchestration: the
 * directory lists what is running, and the record's `intent` says what each
 * session is working on.
 *
 * Only Main talks across sessions. A session address names the session, never an
 * actor inside it, so a subagent cannot be addressed from outside and a
 * subagent cannot send out.
 *
 * Platform scope: cross-session coordination is implemented for POSIX only. The
 * directory format is portable, but Windows named-pipe addressing and the
 * Windows endpoint ownership checks are not verified, so the feature refuses to
 * run there instead of advertising a path it cannot serve.
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

import { managedFrame } from '../ipc/message.ts';
import { deriveSessionUid, getAgentSocketPath, writeSocket } from '../ipc/socket.ts';
import { SubagentError } from './runtime.ts';

export const SESSION_DIRECTORY = 'sessions';

/**
 * Whether this build may publish and reach cross-session endpoints.
 *
 * Linux and other POSIX platforms are supported. Windows is explicitly not:
 * `session_list` reports the feature as unavailable, and intent publishing and
 * cross-session sends refuse with `unsupported_platform`.
 */
export function crossSessionSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

/** Fail closed where the feature is unavailable instead of degrading silently. */
export function assertCrossSessionSupported(platform: NodeJS.Platform = process.platform): void {
  if (crossSessionSupported(platform)) return;
  throw new SubagentError('unsupported_platform', 'Cross-session coordination is not available on Windows yet.');
}

const RECORD_VERSION = 1;
const UID_PATTERN = /^[0-9a-z]{1,32}$/i;
const SCHEME = 'session:';

/** One live session as published in the shared socket root. */
export interface LiveSession {
  readonly sessionId: string;
  readonly uid: string;
  readonly socketDir: string;
  readonly pid: number;
  readonly cwd: string;
  /** One-line statement of what this session is working on; empty when unset. */
  readonly intent: string;
  readonly startedAt: number;
}

/** One parsed cross-session address: a session, not an actor inside it. */
export interface CrossSessionTarget {
  readonly uid: string;
}

/**
 * The model-facing form of a cross-session target. It is not an IPC path, so the
 * transport never has to guess whether an address is a file or a pipe name.
 */
export function crossSessionAddress(uid: string): string {
  return `${SCHEME}${uid}`;
}

/** Whether a value claims to be a cross-session address at all. */
export function isCrossSessionAddress(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(SCHEME);
}

/**
 * Parse `session:<uid>`. Returns null for a malformed address; the caller reports
 * the expected shape instead of treating it as an IPC path.
 */
export function parseCrossSessionAddress(value: unknown): CrossSessionTarget | null {
  if (!isCrossSessionAddress(value)) return null;
  const uid = (value as string).slice(SCHEME.length);
  return UID_PATTERN.test(uid) ? { uid } : null;
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
  const { sessionId, socketDir, pid, cwd, intent, startedAt } = data;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  if (data['uid'] !== uid) return null;
  if (typeof socketDir !== 'string' || socketDir !== path.join(root, uid)) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof cwd !== 'string') return null;
  if (intent !== undefined && typeof intent !== 'string') return null;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  return { sessionId, uid, socketDir, pid, cwd, intent: typeof intent === 'string' ? intent : '', startedAt };
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
  entry: { readonly sessionId: string; readonly cwd: string },
): Promise<LiveSession> {
  const uid = deriveSessionUid(entry.sessionId);
  const session: LiveSession = {
    sessionId: entry.sessionId,
    uid,
    socketDir: path.join(root, uid),
    pid: process.pid,
    cwd: entry.cwd,
    intent: '',
    startedAt: Date.now(),
  };
  await mkdir(directory(root), { recursive: true, mode: 0o700 });
  await writeRecord(root, session);
  return session;
}

/**
 * Publish this session's current intent. Only the session that owns the record
 * may rewrite it; a record that no longer matches is left untouched.
 */
export async function updateSession(
  root: string,
  entry: { readonly sessionId: string; readonly intent: string },
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
  const next: LiveSession = { ...current, intent: entry.intent };
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
  } catch {
    return [];
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

/** The live session that a frame names, or null when it is not reachable. */
export async function sessionById(root: string, sessionId: unknown): Promise<LiveSession | null> {
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  return (await liveSessions(root)).find((session) => session.sessionId === sessionId) ?? null;
}

/** A remote refusal keeps its code; a transport failure is a delivery error. */
function deliveryError(error: unknown): SubagentError {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code?: unknown }).code)
    : 'delivery_failed';
  return new SubagentError(code, error instanceof Error ? error.message : String(error));
}

/**
 * Deliver one message to an actor of another live session.
 *
 * The sending session resolves the published record, frames its own identity and
 * writes one NDJSON request to the receiver's endpoint. The receiving root still
 * owns admission: a refusal keeps its code. A timeout or disconnect does not
 * prove the message was not handed over, so nothing is retried here.
 */
export async function sendToSession(
  root: string,
  command: {
    readonly senderSessionId: string;
    readonly target: CrossSessionTarget;
    readonly content: string;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<void> {
  const session = await sessionByUid(root, command.target.uid);
  if (session === null) {
    throw new SubagentError('unknown_session', `No live session is registered as ${command.target.uid}.`);
  }
  if (command.signal?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
  // Only Main talks across sessions; the address names the session, so the
  // receiving endpoint is always that session's Main.
  const address = getAgentSocketPath('Main', session.socketDir);
  const { frame } = managedFrame({ senderId: 'Main', content: command.content, session: command.senderSessionId });
  try {
    await writeSocket(address, frame);
  } catch (error) {
    throw deliveryError(error);
  }
}
