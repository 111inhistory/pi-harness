/**
 * Native persistence for the subagent harness.
 *
 * Two native Pi storage surfaces, no harness-owned store:
 *
 * - The root session's active branch carries the registry checkpoints as
 *   ordinary `custom` entries (`customType: "subagent-state"`, written through
 *   `pi.appendEntry`). Each checkpoint is one complete, JSON-safe snapshot:
 *   `{ version: 1, registry: <runtime exportState()>, actors: { <agentId>: … } }`.
 *   Reload and process restarts rebuild the latest snapshot from the branch, so
 *   abandoned branches keep their own (older) state and a resumed session sees
 *   exactly the checkpoints its branch recorded.
 * - Every actor owns one native Pi session file under
 *   `<agentDir>/subagent-sessions/<rootSessionId>/<agentId>.jsonl`. Fresh
 *   children create it through the ordinary SessionManager; inherited children
 *   get a one-time standard-JSONL seed (the captured parent branch, verbatim),
 *   and from then on the native SessionManager owns every read and append.
 *
 * Reads are native: the adapter injects `openSession` (its `SessionManager.open`),
 * and the store only uses the documented read surface — `getHeader()` /
 * `getEntries()` for the seed prefix, `getBranch(endEntryId)` / `getLeafId()` for
 * a Job's sealed slice, the current leaf and whether a turn was recorded. File
 * order is never treated as branch order, and no JSONL is parsed here. The one
 * thing this module still writes by hand is the one-time seed: a standard
 * `{type:"session",…}` header plus entry lines, materialized atomically because
 * no public API creates a session file at an exact path.
 *
 * Inherited-context snapshots are captured branch copies, so a checkpoint that
 * embedded them verbatim would duplicate a parent transcript inside every
 * snapshot and grow without bound. `save()` therefore materializes the seed
 * file first and then substitutes the raw `inheritedContext.entries` array with
 * a reference (`{seedFile, entryCount}`) while the state is JSON-cloned into
 * the checkpoint, so the captured transcript is never walked or copied by a
 * checkpoint; `hydrate()` reads the file back into the original shape, so the
 * runtime always receives what it captured. The walk is structural (every
 * `inheritedContext` object reachable from the registry state) and needs no
 * knowledge of internal runtime record types.
 *
 * A missing or unreadable native session is an explicit coded failure, never an
 * empty answer: opening a path the native manager would silently create is only
 * ever done after an existence check, so a recorded conversation can never be
 * reset to a fresh session by a read.
 *
 * The module is deliberately free of Pi imports: the extension injects
 * `appendEntry`/`readBranch` (root session) and `openSession` (child sessions),
 * so this file stays testable under plain Node.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Custom entry type of a registry checkpoint on the root session branch. */
export const SUBAGENT_STATE_CUSTOM_TYPE = "subagent-state";

/** Checkpoint payload version. Unknown versions fail instead of being guessed. */
export const SUBAGENT_STATE_VERSION = 1;

/** Directory name under the agent directory that holds subagent session files. */
export const SUBAGENT_SESSIONS_DIR = "subagent-sessions";

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

function describe(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * JSON round-trip the value: persistence must never carry a live object (a
 * Model, a Budget, a session manager) that silently serializes to `{}`. The
 * optional replacer is what lets `save` substitute a native seed reference for
 * a raw inherited snapshot while stringifying, so the captured entries behind
 * it are never traversed by the clone.
 */
function jsonClone(value, where, replacer = undefined) {
  try {
    return JSON.parse(JSON.stringify(value, replacer));
  } catch (error) {
    throw new SubagentStoreError("storage_invalid_state", `${where} is not JSON-safe: ${messageOf(error)}`, { where });
  }
}

/**
 * Write one atomic seed file; a partial write must never become a session file.
 * The content is the standard Pi JSONL: one session header, then one JSON
 * entry per line. The entries are serialized before anything is created, so a
 * capture that cannot be persisted fails as a storage error, not a raw
 * serialization error.
 */
function writeSeedFile(file, entries) {
  let text;
  try {
    text = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  } catch (error) {
    throw new SubagentStoreError(
      "storage_invalid_state",
      `The inherited snapshot for ${file} is not JSON-safe: ${messageOf(error)}`,
      { file },
    );
  }
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.seed-${randomUUID().slice(0, 8)}`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

/**
 * A seed is a standard session file: exactly one header first. Captures of a
 * headerless session get a fresh one so the file itself is a valid session.
 */
function withSessionHeader(entries, cwd) {
  if (entries.length > 0 && entries[0]?.type === "session") return entries;
  return [
    { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd },
    ...entries,
  ];
}

/**
 * Visit every inherited-context snapshot reachable from a registry state.
 *
 * The snapshot itself is the only object with this exact shape; the actor id
 * of the enclosing job names the session file the seed belongs to. Registry
 * states keep jobs as either a list or a map and continuation specs embed the
 * initial spec under `seed`, so the walk follows values instead of record
 * types. A snapshot is visited whether it still carries its raw `entries`
 * array (live or hydrated state) or the persisted seed reference that replaced
 * it, so the same walk serves both `save` and `hydrate`.
 *
 * `walking` holds the values on the current path, so a state that contains
 * itself terminates: `save` walks the live state and lets its JSON clone
 * refuse such a state, and a shared (acyclic) value is still visited once per
 * occurrence.
 */
function eachInheritedSnapshot(value, visit, context = { agentId: null }, walking = new Set()) {
  if (typeof value !== "object" || value === null) return;
  if (walking.has(value)) return;
  walking.add(value);
  if (Array.isArray(value)) {
    for (const item of value) eachInheritedSnapshot(item, visit, context, walking);
  } else {
    const agentId = typeof value.agentId === "string" && value.agentId !== "" ? value.agentId : context.agentId;
    for (const [key, child] of Object.entries(value)) {
      if (key === "inheritedContext" && isPlainObject(child)) {
        visit(child, agentId);
        continue;
      }
      eachInheritedSnapshot(child, visit, { agentId }, walking);
    }
  }
  walking.delete(value);
}

/**
 * @param {{
 *   sessionFile?: string,
 *   dir?: string,
 *   cwd?: string,
 *   appendEntry?: (customType: string, data: unknown) => void,
 *   readBranch?: () => unknown[],
 *   openSession?: (file: string) => {
 *     getHeader: () => object | null,
 *     getEntries: () => object[],
 *     getBranch: (fromId?: string | null) => object[],
 *     getLeafId: () => string | null,
 *   },
 * }} options
 */
export function createSubagentStore(options = {}) {
  const { sessionFile, dir, appendEntry, readBranch, openSession } = options;
  const durable =
    typeof sessionFile === "string" &&
    sessionFile !== "" &&
    typeof dir === "string" &&
    dir !== "" &&
    typeof appendEntry === "function" &&
    typeof readBranch === "function" &&
    typeof openSession === "function";

  // Seed files verified during this store's lifetime, so repeated checkpoints
  // do not re-open (and never rewrite) an already materialized seed.
  const seeded = new Map();

  function childSessionFile(agentId) {
    if (!durable) {
      throw new SubagentStoreError("storage_unavailable", "This root session is memory-only, so its actors have no session files.");
    }
    if (typeof agentId !== "string" || agentId === "") {
      throw new SubagentStoreError("storage_invalid_state", `An actor id is required, received ${describe(agentId)}.`);
    }
    return join(dir, `${agentId}.jsonl`);
  }

  /**
   * Open one native session. Missing files are handled by the callers, each
   * with its own coded error, so this never opens a path just to create a
   * fresh session; an unreadable file fails explicitly instead.
   */
  function openNative(file, where) {
    try {
      return openSession(file);
    } catch (error) {
      throw new SubagentStoreError("storage_corrupt", `${file} is not a readable Pi session (${where}): ${messageOf(error)}`, {
        file,
      });
    }
  }

  /** The file's entries as written: header first, then every entry in file order. */
  function fileEntries(manager) {
    const entries = manager.getEntries();
    const header = manager.getHeader();
    return header === null ? entries : [header, ...entries];
  }

  /**
   * Materialize the one-time seed of an inherited actor; never rewrite a file.
   * Returns the session file and the number of entries the seed occupies in it,
   * which is what hydration slices back out.
   */
  function writeSeedIfMissing(agentId, entries) {
    if (!durable) return null;
    if (!Array.isArray(entries)) {
      throw new SubagentStoreError("storage_invalid_state", `The inherited snapshot of ${agentId} carries no entry array.`);
    }
    const file = childSessionFile(agentId);
    const clean = withSessionHeader(entries, options.cwd ?? process.cwd());
    const headerId = clean[0].id;
    const known = seeded.get(agentId);
    if (known !== undefined) {
      if (known.headerId !== headerId) {
        throw new SubagentStoreError(
          "storage_seed_conflict",
          `Actor ${agentId} already has a different seed session; refusing to overwrite ${file}.`,
          { agentId, file },
        );
      }
      return { sessionFile: file, entryCount: known.entryCount };
    }
    if (existsSync(file)) {
      const stored = fileEntries(openNative(file, "seed"));
      if (stored[0]?.type !== "session" || stored[0].id !== headerId || stored.length < clean.length) {
        throw new SubagentStoreError(
          "storage_seed_conflict",
          `The session file of actor ${agentId} does not start with the captured seed; refusing to overwrite ${file}.`,
          { agentId, file },
        );
      }
    } else {
      writeSeedFile(file, clean);
    }
    seeded.set(agentId, { headerId, entryCount: clean.length });
    return { sessionFile: file, entryCount: clean.length };
  }

  function seedReference(snapshot, agentId) {
    const seed = writeSeedIfMissing(agentId, snapshot.entries);
    return { seedFile: seed.sessionFile, entryCount: seed.entryCount };
  }

  /** Replace seed references with the entries they stand for (a clone). */
  function hydrate(checkpoint) {
    const copy = jsonClone(checkpoint, "the subagent checkpoint");
    eachInheritedSnapshot(copy.registry, (snapshot) => {
      const reference = snapshot.entries;
      if (Array.isArray(reference)) return; // already raw entries
      if (!isPlainObject(reference) || typeof reference.seedFile !== "string" || !Number.isInteger(reference.entryCount)) {
        throw new SubagentStoreError(
          "storage_corrupt",
          "A persisted inherited snapshot carries neither native entries nor a seeded-session reference.",
        );
      }
      const file = reference.seedFile;
      if (!existsSync(file)) {
        throw new SubagentStoreError(
          "storage_seed_missing",
          `The seeded session file of an inherited subagent is missing: ${file}`,
          { file },
        );
      }
      const stored = fileEntries(openNative(file, "seed"));
      if (stored.length < reference.entryCount) {
        throw new SubagentStoreError(
          "storage_corrupt",
          `The seeded session file ${file} holds ${stored.length} entries, fewer than the recorded ${reference.entryCount}.`,
          { file, entryCount: reference.entryCount },
        );
      }
      snapshot.entries = stored.slice(0, reference.entryCount);
    });
    return copy;
  }

  /** The latest checkpoint on the active root branch, or null when none exists. */
  function load() {
    if (!durable) return null;
    let branch;
    try {
      branch = readBranch();
    } catch (error) {
      throw new SubagentStoreError("storage_read_failed", `Could not read the root session branch: ${messageOf(error)}`);
    }
    if (!Array.isArray(branch)) {
      throw new SubagentStoreError("storage_read_failed", "The root session branch is not an entry list.");
    }
    let latest = null;
    for (const entry of branch) {
      if (entry?.type === "custom" && entry.customType === SUBAGENT_STATE_CUSTOM_TYPE) latest = entry;
    }
    if (latest === null) return null;
    const data = latest.data;
    if (!isPlainObject(data)) {
      throw new SubagentStoreError("storage_corrupt", `Subagent checkpoint ${describe(latest.id)} carries no state object.`, {
        entryId: latest.id ?? null,
      });
    }
    if (data.version !== SUBAGENT_STATE_VERSION) {
      throw new SubagentStoreError(
        "storage_corrupt",
        `Subagent checkpoint ${describe(latest.id)} has unsupported version ${describe(data.version)}.`,
        { entryId: latest.id ?? null, version: data.version ?? null },
      );
    }
    if (!isPlainObject(data.registry) || !isPlainObject(data.actors)) {
      throw new SubagentStoreError("storage_corrupt", `Subagent checkpoint ${describe(latest.id)} is incomplete.`, {
        entryId: latest.id ?? null,
      });
    }
    return { version: data.version, registry: data.registry, actors: data.actors, entryId: latest.id ?? null };
  }

  /**
   * Append one checkpoint to the active root branch. Seed snapshots are
   * materialized once and referenced from then on, and the reference is
   * substituted while the state is JSON-cloned, so a checkpoint never walks,
   * copies, or rewrites the captured transcript behind an existing seed.
   */
  function save({ registry, actors }) {
    if (!durable) return false;
    if (!isPlainObject(registry) || !isPlainObject(actors)) {
      throw new SubagentStoreError("storage_invalid_state", "save() requires the runtime registry state and the actor records.");
    }
    // Materialize (or verify) the native seed of every raw inherited snapshot
    // and remember the substitute the clone uses for it, so JSON.stringify
    // replaces the raw `entries` array with its reference instead of
    // descending into it. The live registry state is never modified.
    const replaced = new Map();
    eachInheritedSnapshot(registry, (snapshot, agentId) => {
      // A snapshot already carrying a persisted reference (a state that was
      // hydrated but not yet restored) keeps it; raw entries are replaced.
      if (!Array.isArray(snapshot.entries)) return;
      if (typeof agentId !== "string" || agentId === "") {
        throw new SubagentStoreError(
          "storage_invalid_state",
          "An inherited-context snapshot in the registry state is not attached to an actor id, so its seed session cannot be stored.",
        );
      }
      replaced.set(snapshot, { ...snapshot, entries: seedReference(snapshot, agentId) });
    });
    const state = jsonClone(registry, "the runtime registry state", (_key, value) => replaced.get(value) ?? value);
    const payload = {
      version: SUBAGENT_STATE_VERSION,
      registry: state,
      actors: jsonClone(actors, "the actor records"),
    };
    try {
      appendEntry(SUBAGENT_STATE_CUSTOM_TYPE, payload);
    } catch (error) {
      throw new SubagentStoreError("storage_write_failed", `Could not append the subagent checkpoint: ${messageOf(error)}`);
    }
    return true;
  }

  /**
   * The native entries of one Job: the branch path ending at `endEntryId`
   * (or at the current leaf when none is recorded), strictly after
   * `startEntryId`. Native branch traversal is what keeps a sealed slice
   * sealed: entries appended after `endEntryId`, on this or any other branch,
   * are not on that path.
   *
   * `liveManager` is an actor's running native session. A live conversation is
   * read from it directly — a memory-only root keeps its whole transcript there
   * — and a restored one is read from its stored file.
   */
  function readHistory({ agentId, startEntryId = null, endEntryId = null }, liveManager = null) {
    // A Job that was never scoped by a native boundary has no recorded history.
    if (startEntryId === null && endEntryId === null) return [];
    let manager = liveManager;
    if (manager === null) {
      // A memory-only root never persisted a conversation to read.
      if (!durable) return [];
      const file = childSessionFile(agentId);
      if (!existsSync(file)) {
        throw new SubagentStoreError(
          "storage_history_unavailable",
          `The native session file of ${agentId} is missing, so its recorded history cannot be read: ${file}`,
          { agentId, file },
        );
      }
      manager = openNative(file, "history");
    }
    const branch = endEntryId === null ? manager.getBranch() : manager.getBranch(endEntryId);
    if (endEntryId !== null && !branch.some((entry) => entry.id === endEntryId)) {
      throw new SubagentStoreError(
        "storage_history_unavailable",
        `The recorded history end ${describe(endEntryId)} of ${agentId} is not in its native conversation.`,
        { agentId, endEntryId },
      );
    }
    let startAt = -1;
    if (startEntryId !== null) {
      startAt = branch.findIndex((entry) => entry.id === startEntryId);
      if (startAt === -1) {
        throw new SubagentStoreError(
          "storage_history_unavailable",
          `The recorded history start ${describe(startEntryId)} of ${agentId} is not on the branch in its native conversation.`,
          { agentId, startEntryId },
        );
      }
    }
    return branch.slice(startAt + 1);
  }

  /**
   * Whether the actor's native session file exists. Entries a native manager
   * still holds unflushed never reach a file, so this is what keeps an anchor
   * from becoming durable before the entries it names are.
   */
  function hasSessionFile(agentId) {
    return durable && existsSync(childSessionFile(agentId));
  }

  /**
   * Whether the actor's own conversation recorded a user or assistant message
   * after `startEntryId`, up to `endEntryId` (the current leaf when none is
   * given). The path walked is the native branch, so a recorded leaf anchor
   * answers for the conversation as it was at that checkpoint, independent of
   * entries appended afterwards.
   */
  function hasRecordedTurn(agentId, startEntryId = null, endEntryId = null) {
    if (!durable) return false;
    const file = childSessionFile(agentId);
    if (!existsSync(file)) return false;
    const manager = openNative(file, "recorded turn");
    const branch = endEntryId === null ? manager.getBranch() : manager.getBranch(endEntryId);
    if (endEntryId !== null && !branch.some((entry) => entry.id === endEntryId)) return false;
    let at = -1;
    if (startEntryId !== null) {
      at = branch.findIndex((entry) => entry.id === startEntryId);
      if (at === -1) return false;
    }
    for (const entry of branch.slice(at + 1)) {
      if (entry.type !== "message") continue;
      if (entry.message?.role === "user" || entry.message?.role === "assistant") return true;
    }
    return false;
  }

  return {
    get durable() {
      return durable;
    },
    childSessionFile,
    hasSessionFile,
    hasRecordedTurn,
    writeSeedIfMissing,
    load,
    save,
    hydrate,
    readHistory,
  };
}
