/**
 * Native persistence for the subagent harness (storage version 2).
 *
 * Two storage surfaces, both native Pi sessions:
 *
 * - The root session branch carries small lifecycle events as `custom`
 *   entries (`subagent-*`). The registry of a branch position is the fold of
 *   the events on that path, so rewind (`/tree`) and fork/clone (which copy
 *   the path) restore exactly what happened before that position. Large
 *   values (a task, a result, a role prompt) are written once, in the event
 *   that introduces them; nothing is re-written per turn.
 * - Every actor owns one native session file. A root session only ever writes
 *   files under its own directory; a file recorded by another root session (a
 *   fork's parent) is read-only, and the first write copies the recorded path
 *   into the own directory (copy-on-write).
 *
 * The module is free of Pi imports: the adapter injects `appendEntry`,
 * `readBranch`, `readEntries` and `openSession`, so this file stays testable
 * under plain Node.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { sameParentDirectory, samePath } from '../fs-path.ts';
import type { FileEntry, SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';

export interface TreeEntry { readonly id?: string; readonly parentId?: string | null; readonly type?: string }
interface HarnessEntry extends TreeEntry { readonly type: 'custom'; readonly customType: string; readonly data?: unknown }
export interface StoredActor {
  agentId: string; name: unknown; parentAgentId: unknown; depth: unknown;
  record: Record<string, unknown> | null; anchor: unknown; stoppedOrder: number;
}
export interface StoredJob {
  jobId: string; agentId: string; startEntryId: string | null; started: boolean;
  end: Record<string, unknown> | null;
  [field: string]: unknown;
}
export interface StoredRegistry { actors: StoredActor[]; jobs: StoredJob[] }
export type StoreSession = Pick<SessionManager, 'getHeader' | 'getBranch' | 'getEntries' | 'getEntry' | 'getLeafId' | 'branch'>;
export interface SubagentStoreOptions<T extends StoreSession = StoreSession> {
  readonly dir?: string;
  readonly appendEntry?: (type: string, data: unknown) => void;
  readonly readBranch?: () => readonly unknown[];
  readonly readEntries?: () => readonly unknown[];
  readonly openSession?: (file: string, cwd?: string) => T;
}

export const STORAGE_VERSION = 2;

/** Every harness-owned root entry starts with this prefix. */
export const EVENT_PREFIX = "subagent-";

export const EVENTS = {
  /** Full identity record of one actor; written when it changes. */
  actor: "subagent-actor",
  /** Native leaf an idle actor's conversation moved to. */
  anchor: "subagent-anchor",
  /** One Job registered: topology, spec and origin. */
  job: "subagent-job",
  /** The native entry a Job's transcript starts after. */
  jobStart: "subagent-job-start",
  /** One Job's terminal outcome: status, result, history bounds, Budget. */
  jobEnd: "subagent-job-end",
} as const;

const EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(EVENTS));

/** Directory name under the agent directory that holds subagent session files. */
export const SUBAGENT_SESSIONS_DIR = "subagent-sessions";

/** Harness-owned storage error with a stable machine-readable code. */
export class SubagentStoreError extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "SubagentStoreError";
    this.code = code;
    this.detail = detail;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for a root entry this module owns. */
export function isHarnessEntry(entry: unknown): entry is HarnessEntry {
  return isPlainObject(entry) && entry.type === "custom" && typeof entry.customType === "string" && entry.customType.startsWith(EVENT_PREFIX);
}

/**
 * Drop entries and re-link every follower to its nearest kept ancestor, in one
 * pass. Entries are copied only when their parent changes.
 */
export function withoutEntries<T extends TreeEntry>(entries: readonly T[], drop: (entry: T) => boolean): T[] {
  const replacement = new Map<string, string | null>();
  const kept: T[] = [];
  for (const entry of entries) {
    const parentId = entry?.parentId;
    const parent = typeof parentId === "string" && replacement.has(parentId) ? replacement.get(parentId) : parentId;
    if (drop(entry)) {
      if (typeof entry?.id === "string") replacement.set(entry.id, parent ?? null);
      continue;
    }
    kept.push(parent === parentId ? entry : { ...entry, parentId: parent ?? null });
  }
  return kept;
}

/** Atomic write: a partial file never becomes a session or a view. */
function atomicWrite(file: string, write: (fd: number) => void): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${randomUUID().slice(0, 8)}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    write(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeFileAtomic(file: string, text: string): void {
  atomicWrite(file, (fd) => writeFileSync(fd, text));
}

/** Serialize one record at a time instead of building a second full transcript. */
export function writeJsonlAtomic(file: string, entries: Iterable<unknown>): void {
  atomicWrite(file, (fd) => {
    for (const entry of entries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
  });
}

function writeSessionFile(file: string, header: unknown, entries: Iterable<unknown>): void {
  writeJsonlAtomic(file, (function* () { yield header; yield* entries; })());
}

/**
 * Fold the harness events of one root branch into a registry description.
 *
 * Jobs keep event order (the global creation chronology). Only known v2 event
 * types are interpreted; unrelated/legacy entries remain untouched. Malformed
 * v2 events are reported, never guessed at.
 */
export function foldEvents(branch: readonly unknown[]): StoredRegistry {
  const actors = new Map<string, StoredActor>();
  const jobs = new Map<string, StoredJob>();
  let endSequence = 0;
  for (const entry of branch) {
    if (!isHarnessEntry(entry)) continue;
    if (!EVENT_TYPES.has(entry.customType)) continue;
    const data = entry.data;
    if (!isPlainObject(data) || data.v !== STORAGE_VERSION) {
      throw new SubagentStoreError("storage_corrupt", `Subagent event ${entry.id ?? "?"} has no version-${STORAGE_VERSION} payload.`, {
        entryId: entry.id ?? null,
      });
    }
    switch (entry.customType) {
      case EVENTS.job: {
        if (jobs.has(eventText(data, "jobId", entry))) throw corrupt(entry, `Job ${data.jobId} is registered twice.`);
        if (isPlainObject(data.actor)) {
          if (actors.has(eventText(data, "agentId", entry))) throw corrupt(entry, `Actor ${data.agentId} is registered twice.`);
          actors.set(eventText(data, "agentId", entry), {
            agentId: eventText(data, "agentId", entry),
            name: data.actor.name ?? null,
            parentAgentId: data.actor.parentAgentId ?? null,
            depth: data.actor.depth,
            record: null,
            anchor: null,
            stoppedOrder: 0,
          });
        } else if (!actors.has(eventText(data, "agentId", entry))) {
          throw corrupt(entry, `Job ${data.jobId} belongs to unknown actor ${data.agentId}.`);
        }
        const { v: _v, actor: _actor, ...job } = data;
        jobs.set(eventText(data, "jobId", entry), { ...job, jobId: eventText(data, "jobId", entry), agentId: eventText(data, "agentId", entry), startEntryId: null, started: false, end: null });
        break;
      }
      case EVENTS.jobStart: {
        const job = jobs.get(eventText(data, "jobId", entry));
        if (job === undefined) throw corrupt(entry, `Start of unknown Job ${data.jobId}.`);
        job.started = true;
        if (data.startEntryId !== undefined && data.startEntryId !== null && typeof data.startEntryId !== 'string') throw corrupt(entry, 'A Job start entry must be a string or null.');
        job.startEntryId = data.startEntryId ?? null;
        break;
      }
      case EVENTS.jobEnd: {
        const job = jobs.get(eventText(data, "jobId", entry));
        if (job === undefined) throw corrupt(entry, `End of unknown Job ${data.jobId}.`);
        const { v: _v, jobId: _jobId, ...end } = data;
        job.end = end;
        const actor = actors.get(job.agentId);
        if (actor === undefined) throw corrupt(entry, `End of Job for unknown actor ${job.agentId}.`);
        actor.stoppedOrder = ++endSequence;
        if (isPlainObject(end.history) && typeof end.history.endEntryId === "string") actor.anchor = end.history.endEntryId;
        break;
      }
      case EVENTS.actor: {
        const actor = actors.get(eventText(data, "agentId", entry));
        if (actor === undefined) throw corrupt(entry, `Identity of unknown actor ${data.agentId}.`);
        const { v: _v, agentId: _agentId, anchor, ...record } = data;
        actor.record = { ...actor.record, ...record };
        if (Object.hasOwn(data, "anchor")) actor.anchor = anchor ?? null;
        break;
      }
      case EVENTS.anchor: {
        const actor = actors.get(eventText(data, "agentId", entry));
        if (actor === undefined) throw corrupt(entry, `Anchor of unknown actor ${data.agentId}.`);
        actor.anchor = data.anchor ?? null;
        break;
      }
    }
  }
  return { actors: [...actors.values()], jobs: [...jobs.values()] };
}

function eventText(data: Record<string, unknown>, field: string, entry: HarnessEntry): string {
  const value = data[field];
  if (typeof value !== 'string') throw corrupt(entry, `Event requires string ${field}.`);
  return value;
}

function corrupt(entry: HarnessEntry, message: string): SubagentStoreError {
  return new SubagentStoreError("storage_corrupt", message, { entryId: entry.id ?? null });
}

/**
 * @param {{
 *   dir?: string,
 *   appendEntry?: (customType: string, data: unknown) => void,
 *   readBranch?: () => object[],
 *   readEntries?: () => object[],
 *   openSession?: (file: string, cwd?: string) => object,
 * }} options
 */
export function createSubagentStore<T extends StoreSession = StoreSession>(options: SubagentStoreOptions<T> = {}) {
  const { appendEntry, readBranch, readEntries, openSession } = options;
  const dir = typeof options.dir === "string" && options.dir !== "" ? resolve(options.dir) : null;
  const durable =
    dir !== null &&
    typeof appendEntry === "function" &&
    typeof readBranch === "function" &&
    typeof readEntries === "function" &&
    typeof openSession === "function";

  function requireDurable(): void {
    if (!durable) {
      throw new SubagentStoreError("storage_unavailable", "This root session is memory-only, so its actors have no session files.");
    }
  }

  function childFile(agentId: string): string {
    requireDurable();
    if (typeof agentId !== "string" || agentId === "") {
      throw new SubagentStoreError("storage_invalid_state", "An actor id is required.");
    }
    return join(dir!, `${agentId}.jsonl`);
  }

  function ownsFile(file: string): boolean {
    return durable && typeof file === "string" && sameParentDirectory(file, dir!);
  }

  function append(type: string, data: object): void {
    if (!durable) return;
    try {
      appendEntry!(type, { v: STORAGE_VERSION, ...data });
    } catch (error) {
      throw new SubagentStoreError("storage_write_failed", `Could not append ${type}: ${messageOf(error)}`);
    }
  }

  function load(): StoredRegistry {
    if (!durable) return { actors: [], jobs: [] };
    let branch;
    try {
      branch = readBranch!();
    } catch (error) {
      throw new SubagentStoreError("storage_read_failed", `Could not read the root session branch: ${messageOf(error)}`);
    }
    return foldEvents(branch);
  }

  /**
   * Every actor and Job id this root session ever used, on any branch, plus
   * the actor files in its directory. A rewound branch never reuses an id an
   * abandoned branch (or an earlier storage version) already owns.
   */
  function takenIds(): Set<string> {
    const ids = new Set<string>();
    if (!durable) return ids;
    for (const entry of readEntries!()) {
      if (!isHarnessEntry(entry) || !isPlainObject(entry.data)) continue;
      if (typeof entry.data.agentId === "string") ids.add(entry.data.agentId);
      if (typeof entry.data.jobId === "string") ids.add(entry.data.jobId);
    }
    if (existsSync(dir!)) {
      for (const name of readdirSync(dir!)) if (name.endsWith(".jsonl")) ids.add(name.slice(0, -".jsonl".length));
    }
    return ids;
  }

  /** Open a recorded conversation for reading; null when the file is missing. */
  function read(file: string): T | null {
    requireDurable();
    if (!existsSync(file)) return null;
    let manager;
    try {
      manager = openSession!(file);
    } catch (error) {
      throw new SubagentStoreError("storage_corrupt", `${file} is not a readable Pi session: ${messageOf(error)}`, { file });
    }
    return manager;
  }

  /**
   * Materialize an inherited actor's conversation: the captured branch, minus
   * harness events, under a fresh session header. Returns the file and the
   * leaf the actor starts from.
   */
  function writeSeed(agentId: string, entries: readonly FileEntry[], cwd: string): { file: string; seedLeafId: string | null } {
    const file = childFile(agentId);
    if (existsSync(file)) {
      throw new SubagentStoreError("storage_seed_conflict", `Actor ${agentId} already has a session file; refusing to overwrite ${file}.`, {
        agentId,
        file,
      });
    }
    const body = withoutEntries(
      entries.filter((entry) => entry?.type !== "session"),
      isHarnessEntry,
    );
    const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd };
    writeSessionFile(file, header, body);
    return { file, seedLeafId: body.at(-1)?.id ?? null };
  }

  /**
   * The native session an actor appends to, positioned at `anchor`.
   *
   * An own file is opened in place and branched to the anchor. A file owned by
   * another root session (a fork's parent) is never written: the recorded path
   * is copied into this session's directory first, and the caller records the
   * new file. A missing file starts a fresh own session.
   *
   * @returns {{ manager: object, file: string, relocated: boolean }}
   */
  function openForAppend(agentId: string, file: string | null, anchor: string | null, cwd: string): { manager: T; file: string; relocated: boolean } {
    const own = childFile(agentId);
    let target = typeof file === "string" && file !== "" ? resolve(file) : own;
    let relocated = false;
    if (!samePath(target, own)) {
      if (existsSync(own)) {
        // A rewound root may again record the foreign path after an earlier
        // branch already materialized our copy. Reuse that tree, not overwrite it.
        const existing = read(own);
        const parent = existing === null ? undefined : existing.getHeader()?.parentSession;
        const sameParent = existing !== null && typeof parent === "string" && samePath(parent, target);
        if (existing === null || !sameParent || (anchor !== null && existing.getEntry(anchor) === undefined)) {
          throw new SubagentStoreError("storage_seed_conflict", `Actor ${agentId} already has a different session file; refusing to overwrite ${own}.`, {
            agentId, file: own,
          });
        }
      } else {
        const source = read(target);
        if (source !== null) {
          const path = anchor === null ? source.getBranch() : branchTo(source, anchor, agentId);
          const header = { ...source.getHeader(), id: randomUUID(), timestamp: new Date().toISOString(), parentSession: target };
          writeSessionFile(own, header, path);
        }
      }
      target = own;
      relocated = true;
    }
    let manager;
    try {
      manager = openSession!(target, cwd);
    } catch (error) {
      throw new SubagentStoreError("storage_corrupt", `${target} is not a readable Pi session: ${messageOf(error)}`, { file: target });
    }
    if (anchor !== null && manager.getLeafId() !== anchor) {
      if (manager.getEntry(anchor) === undefined) throw anchorMissing(agentId, anchor);
      manager.branch(anchor);
    }
    return { manager, file: target, relocated };
  }

  function branchTo(manager: T, anchor: string, agentId: string): SessionEntry[] {
    if (manager.getEntry(anchor) === undefined) throw anchorMissing(agentId, anchor);
    return manager.getBranch(anchor);
  }

  /**
   * Entries of one Job: the path ending at `endEntryId` (the leaf when null),
   * strictly after `startEntryId`.
   */
  function readSlice(file: string, startEntryId: string | null, endEntryId: string | null, manager: StoreSession | null = read(file)): SessionEntry[] {
    if (manager === null) {
      throw new SubagentStoreError("storage_history_unavailable", `The session file ${file} is missing.`, { file });
    }
    if (endEntryId !== null && manager.getEntry(endEntryId) === undefined) {
      throw new SubagentStoreError("storage_history_unavailable", `Entry ${endEntryId} is not in ${file}.`, { file });
    }
    const branch = endEntryId === null ? manager.getBranch() : manager.getBranch(endEntryId);
    if (startEntryId === null) return branch;
    const at = branch.findIndex((entry) => entry.id === startEntryId);
    if (at === -1) {
      throw new SubagentStoreError("storage_history_unavailable", `Entry ${startEntryId} is not on the recorded branch of ${file}.`, { file });
    }
    return branch.slice(at + 1);
  }

  /**
   * Where an interrupted Job's transcript ends: the last entry, in file order,
   * that descends from its start. Null when the file holds nothing after it.
   */
  function interruptedEnd(file: string, startEntryId: string | null): string | null {
    const manager = read(file);
    if (manager === null) return null;
    const entries = manager.getEntries();
    if (startEntryId === null) return entries.at(-1)?.id ?? null;
    const descends = new Set([startEntryId]);
    let end: string | null = null;
    for (const entry of entries) {
      if (typeof entry.parentId === "string" && descends.has(entry.parentId)) {
        descends.add(entry.id);
        end = entry.id;
      }
    }
    return end;
  }

  /** Whether the conversation recorded a user or assistant message after `start`, up to `end`. */
  function hasRecordedTurn(file: string, startEntryId: string | null, endEntryId: string | null): boolean {
    let entries;
    try {
      entries = readSlice(file, startEntryId, endEntryId);
    } catch {
      return false;
    }
    return entries.some((entry) => entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant"));
  }

  return {
    get durable() {
      return durable;
    },
    get dir() {
      return dir;
    },
    childFile,
    ownsFile,
    append,
    load,
    takenIds,
    read,
    writeSeed,
    openForAppend,
    readSlice,
    interruptedEnd,
    hasRecordedTurn,
  };
}

function anchorMissing(agentId: string, anchor: string): SubagentStoreError {
  return new SubagentStoreError(
    "session_anchor_unavailable",
    `The recorded conversation leaf ${anchor} of ${agentId} is not in its native session; refusing to continue it from a ` +
      "position that may belong to another branch.",
    { agentId, anchor },
  );
}
