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
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const STORAGE_VERSION = 2;

/** Every harness-owned root entry starts with this prefix. */
export const EVENT_PREFIX = "subagent-";

export const EVENTS = Object.freeze({
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
});

const EVENT_TYPES = new Set(Object.values(EVENTS));

/** Directory name under the agent directory that holds subagent session files. */
export const SUBAGENT_SESSIONS_DIR = "subagent-sessions";

/** Read-only native sessions kept open between reads of the same file. */
const READ_CACHE_SIZE = 4;

/** Harness-owned storage error with a stable machine-readable code. */
export class SubagentStoreError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "SubagentStoreError";
    this.code = code;
    this.detail = detail;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** True for a root entry this module owns. */
export function isHarnessEntry(entry) {
  return entry?.type === "custom" && typeof entry.customType === "string" && entry.customType.startsWith(EVENT_PREFIX);
}

/**
 * Drop entries and re-link every follower to its nearest kept ancestor, in one
 * pass. Entries are copied only when their parent changes.
 */
export function withoutEntries(entries, drop) {
  const replacement = new Map();
  const kept = [];
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
export function writeFileAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

function writeSessionFile(file, header, entries) {
  writeFileAtomic(file, [header, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}

/**
 * Fold the harness events of one root branch into a registry description.
 *
 * Jobs keep event order (the global creation chronology). Unknown or malformed
 * events are reported, never guessed at.
 */
export function foldEvents(branch) {
  const actors = new Map();
  const jobs = new Map();
  let endSequence = 0;
  for (const entry of branch) {
    if (!isHarnessEntry(entry) || !EVENT_TYPES.has(entry.customType)) continue;
    const data = entry.data;
    if (!isPlainObject(data) || data.v !== STORAGE_VERSION) {
      throw new SubagentStoreError("storage_corrupt", `Subagent event ${entry.id ?? "?"} has no version-${STORAGE_VERSION} payload.`, {
        entryId: entry.id ?? null,
      });
    }
    switch (entry.customType) {
      case EVENTS.job: {
        if (jobs.has(data.jobId)) throw corrupt(entry, `Job ${data.jobId} is registered twice.`);
        if (isPlainObject(data.actor)) {
          if (actors.has(data.agentId)) throw corrupt(entry, `Actor ${data.agentId} is registered twice.`);
          actors.set(data.agentId, {
            agentId: data.agentId,
            name: data.actor.name ?? null,
            parentAgentId: data.actor.parentAgentId ?? null,
            depth: data.actor.depth,
            record: null,
            anchor: null,
            stoppedOrder: 0,
          });
        } else if (!actors.has(data.agentId)) {
          throw corrupt(entry, `Job ${data.jobId} belongs to unknown actor ${data.agentId}.`);
        }
        const { v: _v, actor: _actor, ...job } = data;
        jobs.set(data.jobId, { ...job, startEntryId: null, started: false, end: null });
        break;
      }
      case EVENTS.jobStart: {
        const job = jobs.get(data.jobId);
        if (job === undefined) throw corrupt(entry, `Start of unknown Job ${data.jobId}.`);
        job.started = true;
        job.startEntryId = data.startEntryId ?? null;
        break;
      }
      case EVENTS.jobEnd: {
        const job = jobs.get(data.jobId);
        if (job === undefined) throw corrupt(entry, `End of unknown Job ${data.jobId}.`);
        const { v: _v, jobId: _jobId, ...end } = data;
        job.end = end;
        actors.get(job.agentId).stoppedOrder = ++endSequence;
        break;
      }
      case EVENTS.actor: {
        const actor = actors.get(data.agentId);
        if (actor === undefined) throw corrupt(entry, `Identity of unknown actor ${data.agentId}.`);
        const { v: _v, agentId: _agentId, anchor, ...record } = data;
        actor.record = record;
        actor.anchor = anchor ?? null;
        break;
      }
      case EVENTS.anchor: {
        const actor = actors.get(data.agentId);
        if (actor === undefined) throw corrupt(entry, `Anchor of unknown actor ${data.agentId}.`);
        actor.anchor = data.anchor ?? null;
        break;
      }
    }
  }
  return { actors: [...actors.values()], jobs: [...jobs.values()] };
}

function corrupt(entry, message) {
  return new SubagentStoreError("storage_corrupt", message, { entryId: entry.id ?? null });
}

/**
 * @param {{
 *   dir?: string,
 *   appendEntry?: (customType: string, data: unknown) => void,
 *   readBranch?: () => object[],
 *   readEntries?: () => object[],
 *   openSession?: (file: string) => object,
 * }} options
 */
export function createSubagentStore(options = {}) {
  const { appendEntry, readBranch, readEntries, openSession } = options;
  const dir = typeof options.dir === "string" && options.dir !== "" ? resolve(options.dir) : null;
  const durable =
    dir !== null &&
    typeof appendEntry === "function" &&
    typeof readBranch === "function" &&
    typeof readEntries === "function" &&
    typeof openSession === "function";

  /** Small LRU of read-only native sessions, invalidated by size and mtime. */
  const readCache = new Map();

  function requireDurable() {
    if (!durable) {
      throw new SubagentStoreError("storage_unavailable", "This root session is memory-only, so its actors have no session files.");
    }
  }

  function childFile(agentId) {
    requireDurable();
    if (typeof agentId !== "string" || agentId === "") {
      throw new SubagentStoreError("storage_invalid_state", "An actor id is required.");
    }
    return join(dir, `${agentId}.jsonl`);
  }

  function ownsFile(file) {
    return durable && typeof file === "string" && dirname(resolve(file)) === dir;
  }

  function append(type, data) {
    if (!durable) return;
    try {
      appendEntry(type, { v: STORAGE_VERSION, ...data });
    } catch (error) {
      throw new SubagentStoreError("storage_write_failed", `Could not append ${type}: ${messageOf(error)}`);
    }
  }

  function load() {
    if (!durable) return { actors: [], jobs: [] };
    let branch;
    try {
      branch = readBranch();
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
  function takenIds() {
    const ids = new Set();
    if (!durable) return ids;
    for (const entry of readEntries()) {
      if (!isHarnessEntry(entry) || !isPlainObject(entry.data)) continue;
      if (typeof entry.data.agentId === "string") ids.add(entry.data.agentId);
      if (typeof entry.data.jobId === "string") ids.add(entry.data.jobId);
    }
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) if (name.endsWith(".jsonl")) ids.add(name.slice(0, -".jsonl".length));
    }
    return ids;
  }

  /** Open a recorded conversation for reading; null when the file is missing. */
  function read(file) {
    requireDurable();
    if (!existsSync(file)) return null;
    const stat = statSync(file);
    const cached = readCache.get(file);
    if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      readCache.delete(file);
      readCache.set(file, cached);
      return cached.manager;
    }
    let manager;
    try {
      manager = openSession(file);
    } catch (error) {
      throw new SubagentStoreError("storage_corrupt", `${file} is not a readable Pi session: ${messageOf(error)}`, { file });
    }
    readCache.set(file, { manager, size: stat.size, mtimeMs: stat.mtimeMs });
    while (readCache.size > READ_CACHE_SIZE) readCache.delete(readCache.keys().next().value);
    return manager;
  }

  /**
   * Materialize an inherited actor's conversation: the captured branch, minus
   * harness events, under a fresh session header. Returns the file and the
   * leaf the actor starts from.
   */
  function writeSeed(agentId, entries, cwd) {
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
  function openForAppend(agentId, file, anchor) {
    const own = childFile(agentId);
    let target = typeof file === "string" && file !== "" ? resolve(file) : own;
    let relocated = false;
    if (target !== own && !ownsFile(target)) {
      const source = read(target);
      if (source !== null) {
        if (existsSync(own)) {
          throw new SubagentStoreError("storage_seed_conflict", `Actor ${agentId} already has a session file; refusing to overwrite ${own}.`, {
            agentId,
            file: own,
          });
        }
        const path = anchor === null ? source.getBranch() : branchTo(source, anchor, agentId);
        const header = { ...source.getHeader(), id: randomUUID(), timestamp: new Date().toISOString(), parentSession: target };
        writeSessionFile(own, header, path);
      }
      target = own;
      relocated = true;
    }
    readCache.delete(target);
    let manager;
    try {
      manager = openSession(target);
    } catch (error) {
      throw new SubagentStoreError("storage_corrupt", `${target} is not a readable Pi session: ${messageOf(error)}`, { file: target });
    }
    if (anchor !== null && manager.getLeafId() !== anchor) {
      if (manager.getEntry(anchor) === undefined) throw anchorMissing(agentId, anchor);
      manager.branch(anchor);
    }
    return { manager, file: target, relocated };
  }

  function branchTo(manager, anchor, agentId) {
    if (manager.getEntry(anchor) === undefined) throw anchorMissing(agentId, anchor);
    return manager.getBranch(anchor);
  }

  /**
   * Entries of one Job: the path ending at `endEntryId` (the leaf when null),
   * strictly after `startEntryId`.
   */
  function readSlice(file, startEntryId, endEntryId) {
    const manager = read(file);
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
  function interruptedEnd(file, startEntryId) {
    const manager = read(file);
    if (manager === null) return null;
    const entries = manager.getEntries();
    if (startEntryId === null) return entries.at(-1)?.id ?? null;
    const descends = new Set([startEntryId]);
    let end = null;
    for (const entry of entries) {
      if (typeof entry.parentId === "string" && descends.has(entry.parentId)) {
        descends.add(entry.id);
        end = entry.id;
      }
    }
    return end;
  }

  /** Whether the conversation recorded a user or assistant message after `start`, up to `end`. */
  function hasRecordedTurn(file, startEntryId, endEntryId) {
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

function anchorMissing(agentId, anchor) {
  return new SubagentStoreError(
    "session_anchor_unavailable",
    `The recorded conversation leaf ${anchor} of ${agentId} is not in its native session; refusing to continue it from a ` +
      "position that may belong to another branch.",
    { agentId, anchor },
  );
}
