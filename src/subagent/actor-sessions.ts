/**
 * Retained Actor native sessions.
 *
 * One Actor is one native Pi conversation plus the identity that decides how a
 * later Job continues it: cwd, trust, role, model reference, thinking level,
 * tool loadout and the assignment the conversation may still owe. This module
 * is the single owner of those retained descriptors. The root service reads
 * them through {@link ActorSessionStore.get} and replaces them through
 * {@link NativeActorStore.retain}; nothing else holds a mutable reference to
 * the map.
 *
 * Three boundaries are deliberate:
 *
 * - Identity is persisted as field patches of a folded `subagent-actor` event.
 *   A checkpoint never re-writes the whole identity and never writes another
 *   Actor's record. Root-branch writes go through an explicit sink and the
 *   ownership guard, so a quiescing root keeps the writes it still owns and a
 *   detached one cannot append at all.
 * - The durable anchor is a recorded leaf, not the live manager's leaf.
 *   {@link ActorSessionStore.recordedAnchor} answers a leaf only once the
 *   manager's entries reached its session file; an unflushed conversation (a
 *   fresh actor's first append, for example) must never become a durable
 *   anchor.
 * - This module answers native facts only. It never decides a Job's status,
 *   never assigns `stoppedOrder` and never emits `job-end`: the Subagent
 *   Runtime owns every terminal verdict. {@link ActorSessionStore.recoveryBoundEnd}
 *   reports where an unfinished Job's conversation stopped in file order; the
 *   caller seals that bound into the restored registry and the Runtime decides
 *   that the Job was interrupted.
 *
 * A pure-memory root keeps each Actor's manager as its only conversation, so
 * {@link ActorSessionStore.seal} releases a manager only when a durable file
 * already owns the history.
 */

import { existsSync } from "node:fs";

import type { Api, Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";

import { SubagentStoreError } from "../subagent-storage.mjs";
import { SubagentError } from "./runtime.ts";
import type { InheritedContext } from "./runtime.ts";
import type { NativeActorStore, NativeModelRef, NativeRetainedActor } from "./native-types.ts";

/** A native session the store opened for appending. */
export interface OpenedActorSession {
  readonly manager: SessionManager;
  /** The file the manager appends to (the actor's own copy after a relocation). */
  readonly file: string;
  /** True when a recorded foreign file was copied into this root's directory. */
  readonly relocated: boolean;
}

/**
 * Native storage operations this module needs. The root owns the storage engine;
 * every call here is the engine's existing operation, forwarded unchanged.
 */
export interface ActorSessionStorage {
  /** Whether this root session persists its actors in native session files. */
  readonly durable: boolean;
  /**
   * The manager an Actor appends to, positioned at `anchor`. Positional
   * signature because it forwards the storage engine's own operation; `file`
   * may be null for a fresh Actor and `anchor` may be null for a never-recorded
   * conversation.
   */
  openForAppend(agentId: string, file: string | null, anchor: string | null, cwd: string): OpenedActorSession;
  /**
   * Entries strictly after `startEntryId` up to `endEntryId`. The result is
   * opaque SDK data: this module validates the tree identity of every entry and
   * passes the entries themselves through unchanged.
   */
  readSlice(
    file: string,
    startEntryId: string | null,
    endEntryId: string | null,
    manager?: SessionManager,
  ): readonly unknown[];
  /** Whether the recorded interval holds a user or assistant message. */
  hasRecordedTurn(file: string, startEntryId: string | null, endEntryId: string | null): boolean;
  /**
   * The last entry, in file order, that descends from `startEntryId`. The name
   * mirrors the storage engine; the value is a native bound, never a verdict.
   */
  interruptedEnd(file: string, startEntryId: string | null): string | null;
}

/**
 * Live ownership of the root branch. Read at every append instead of captured
 * at construction: a root that begins quiescing still owns its writes until its
 * ownership actually detaches, but a detached root must append nothing.
 */
export interface ActorStoreGuard {
  mayPersist(): boolean;
}

/** Model catalog lookup for a recorded provider/id pair. */
export interface ActorModelLookup {
  find(model: NativeModelRef): Model<Api> | null;
}

/**
 * The identity fields a folded `subagent-actor` record can carry, in the exact
 * shapes this module writes. `systemPrompt` is intentionally absent: an
 * inherited prompt is already recorded once in the initial Job's seed metadata.
 */
export interface ActorIdentityRecord {
  readonly sessionFile: string;
  readonly cwd: string;
  readonly trusted: boolean;
  readonly allowInherited: boolean;
  readonly roleId: string | null;
  readonly roleInstructions: string | null;
  readonly model: NativeModelRef | null;
  readonly thinkingLevel: string | null;
  readonly tools: readonly string[] | null;
  readonly excludedTools: readonly string[];
  readonly assignment: string | null;
  readonly routed: boolean;
}

/** The changed subset of one identity record. */
export type ActorIdentityPatch = { readonly [K in keyof ActorIdentityRecord]?: ActorIdentityRecord[K] };

/**
 * Typed root-branch metadata sink. `appendIdentity` must append one
 * `subagent-actor` event carrying `{ agentId, ...patch, anchor }`;
 * `appendAnchor` must append one `subagent-anchor` event. The root's storage
 * engine owns the event version prefix and the fence on write failures.
 */
export interface ActorMetadataSink {
  appendIdentity(input: {
    readonly agentId: string;
    readonly patch: ActorIdentityPatch;
    readonly anchor: string | null;
  }): void;
  appendAnchor(input: { readonly agentId: string; readonly anchor: string }): void;
}

/** One Actor's first Job, as the recorded registry describes it. */
export interface ActorFirstJob {
  readonly agentId: string;
  /** The native leaf the Job started after; null when it never started. */
  readonly startEntryId: string | null;
}

/** The readonly loadout a per-actor capability scope is rebuilt from. */
export interface ActorToolScope {
  readonly tools: readonly string[] | null;
  readonly excludedTools: readonly string[];
}

/** Explicit constructor dependencies; never a mutable service object. */
export interface ActorSessionStoreDeps {
  readonly storage: ActorSessionStorage;
  readonly guard: ActorStoreGuard;
  readonly models: ActorModelLookup;
  readonly metadata: ActorMetadataSink;
}

const NO_TOOLS: readonly string[] = Object.freeze([]);

/**
 * The retained Actor descriptors of one root session.
 *
 * `NativeActorStore` is the surface the Job runner depends on; the remaining
 * public methods are the root lifecycle's restore, checkpoint, seal and probe
 * operations. Every stored descriptor is frozen and every array in it is a
 * frozen copy, so a caller cannot change the store's state by keeping or
 * mutating a snapshot.
 */
export class ActorSessionStore implements NativeActorStore {
  readonly #storage: ActorSessionStorage;
  readonly #guard: ActorStoreGuard;
  readonly #models: ActorModelLookup;
  readonly #metadata: ActorMetadataSink;
  /** Retained descriptors by actor id; the only authoritative copy. */
  readonly #retained = new Map<string, NativeRetainedActor>();
  /** Last identity actually written for an actor, so patches stay minimal. */
  readonly #persisted = new Map<string, ActorIdentityRecord>();

  constructor(deps: ActorSessionStoreDeps) {
    this.#storage = deps.storage;
    this.#guard = deps.guard;
    this.#models = deps.models;
    this.#metadata = deps.metadata;
  }

  get durable(): boolean {
    return this.#storage.durable;
  }

  get(agentId: string): NativeRetainedActor | null {
    return this.#retained.get(agentId) ?? null;
  }

  /**
   * Replace an Actor's retained descriptor and checkpoint its identity.
   *
   * The descriptor's `anchor` is the already-checked recorded leaf; it is
   * persisted as given and never recomputed here. Only the identity fields that
   * actually changed become a patch.
   */
  retain(agentId: string, descriptor: NativeRetainedActor): void {
    const next = freezeDescriptor(descriptor);
    this.#retained.set(agentId, next);
    this.#persistIdentity(agentId, next);
  }

  /**
   * Rebuild one Actor's retained identity from an unknown folded record.
   *
   * A present record with a missing or malformed field throws instead of being
   * normalized: a dropped field would silently change who the Actor is — a
   * routed identity would become a fresh one, a revival would land on a default
   * model, or a conversation would continue from an unknown position. A Fresh
   * Actor whose routing never settled legitimately records no model reference;
   * its first Job routes again.
   *
   * `anchor` is the folded durable leaf of the Actor's conversation: a native
   * entry id, or null for a conversation that never recorded an entry. A
   * present-but-malformed leaf is refused instead of guessed at. When the record
   * carries no system prompt, the original seed's captured prompt is used,
   * matching an inherited Actor whose prompt was recorded with its seed.
   */
  restoreIdentity(input: {
    readonly agentId: string;
    readonly record: unknown;
    readonly anchor: unknown;
    readonly seed: InheritedContext | null;
  }): NativeRetainedActor {
    const { agentId } = input;
    const record = requireRecord(agentId, input.record);
    const sessionFile = requireText(agentId, record, "sessionFile");
    const anchor = restoreAnchor(agentId, input.anchor);
    const routed = requireBoolean(agentId, record, "routed");
    const modelRef = identityModelRef(agentId, record, routed);
    const descriptor = freezeDescriptor({
      sessionManager: null,
      sessionFile,
      anchor,
      cwd: requireText(agentId, record, "cwd"),
      trusted: requireBoolean(agentId, record, "trusted"),
      allowInherited: requireBoolean(agentId, record, "allowInherited"),
      systemPrompt: nullableText(agentId, record, "systemPrompt") ?? seedSystemPrompt(input.seed),
      roleId: nullableText(agentId, record, "roleId"),
      roleInstructions: nullableText(agentId, record, "roleInstructions"),
      modelRef,
      model: this.#model(modelRef),
      thinkingLevel: nullableText(agentId, record, "thinkingLevel"),
      tools: actorLoadout(agentId, record, "tools"),
      excludedTools: actorLoadout(agentId, record, "excludedTools"),
      assignment: nullableText(agentId, record, "assignment"),
      routed,
    });
    this.#retained.set(agentId, descriptor);
    // The baseline is the identity exactly as it would be written, so a first
    // checkpoint after a restore does not re-write unchanged fields.
    this.#persisted.set(agentId, identityRecordOf(descriptor, sessionFile));
    return descriptor;
  }

  /**
   * The native session this Actor appends to: its live manager when it has one,
   * otherwise a manager opened at its recorded checkpoint (or seeded from the
   * captured inherited conversation on a memory-only root).
   */
  open(input: {
    readonly agentId: string;
    readonly retained: NativeRetainedActor | null;
    readonly seed: InheritedContext | null;
    readonly cwd: string;
  }): SessionManager {
    const { agentId, retained, seed, cwd } = input;
    if (retained !== null && retained.sessionManager !== null) return retained.sessionManager;
    if (!this.#storage.durable) {
      if (seed === null) return SessionManager.inMemory(cwd);
      const entries = this.#seedEntries(agentId, seed);
      const seedCwd = this.#seedText(agentId, seed, "cwd") ?? cwd;
      return SessionManager.inMemory(seedCwd, {}, entries);
    }
    const file = retained?.sessionFile ?? (seed === null ? null : this.#seedText(agentId, seed, "seedFile"));
    const anchor = retained?.anchor ?? (seed === null ? null : this.#seedLeafId(agentId, seed));
    return this.#storage.openForAppend(agentId, file, anchor, cwd).manager;
  }

  /**
   * The leaf a checkpoint may persist for an Actor: the native manager's leaf,
   * but only once its entries reached the session file. A manager without a
   * durable file (and a memory-only root) falls back to the last recorded leaf.
   */
  recordedAnchor(manager: SessionManager | null, fallback: string | null): string | null {
    if (manager === null) return fallback ?? null;
    if (this.#storage.durable) {
      const file = manager.getSessionFile() ?? null;
      if (file === null || !existsSync(file)) return fallback ?? null;
    }
    return manager.getLeafId() ?? null;
  }

  /**
   * Point a rebuilt conversation at the leaf its checkpoint recorded.
   *
   * Only a conversation that was rebuilt from persisted state is moved: a live
   * descriptor's manager already holds the authoritative leaf. A never-started
   * Actor anchors on the last entry of the conversation it was seeded from, and
   * native tree navigation does the move (`branch`), which leaves any recorded
   * turns after that leaf in place as an abandoned child branch instead of
   * deleting or rewriting them. An anchor the manager does not hold is refused,
   * because continuing from a later position may read another root branch's
   * turns.
   */
  restoreLeaf(input: {
    readonly manager: SessionManager;
    readonly agentId: string;
    readonly retained: NativeRetainedActor | null;
    readonly seed: InheritedContext | null;
  }): void {
    if (input.retained !== null && input.retained.sessionManager !== null) return;
    const anchor = input.retained !== null ? input.retained.anchor : this.#seedAnchor(input.agentId, input.seed);
    if (anchor === null) return;
    const { manager, agentId } = input;
    if (manager.getLeafId() === anchor) return;
    if (manager.getEntry(anchor) === undefined) {
      throw new SubagentError(
        "session_anchor_unavailable",
        `The recorded conversation leaf ${anchor} of ${agentId} is not in its native session; refusing to continue it from a ` +
          "position that may belong to another branch.",
        { agentId, anchor },
      );
    }
    manager.branch(anchor);
  }

  /**
   * Checkpoint the leaf an append just moved an Actor to.
   *
   * Both an idle Actor's re-opened file and a live manager's own append land
   * here. Only an append that already reached the Actor's session file becomes a
   * durable anchor: an entry native storage has not flushed is not adopted. The
   * file the manager appends to is recorded with the anchor, so a copy-on-write
   * relocation is persisted by the next checkpoint instead of surviving only in
   * memory.
   */
  checkpointAppendedAnchor(input: {
    readonly agentId: string;
    readonly manager: SessionManager;
    readonly anchor: string;
  }): void {
    const descriptor = this.#retained.get(input.agentId);
    if (descriptor === undefined) return;
    if (!this.#storage.durable || input.anchor === "") return;
    const file = input.manager.getSessionFile() ?? null;
    if (file === null || !existsSync(file)) return;
    // The anchor must be where the append actually left the manager: a dangling
    // or stale id would fail the next revival, or silently move the checkpoint
    // behind turns that are already in the file.
    if (input.manager.getLeafId() !== input.anchor) return;
    const next = freezeDescriptor({ ...descriptor, sessionFile: file, anchor: input.anchor });
    this.#retained.set(input.agentId, next);
    this.#persistIdentity(input.agentId, next);
    if (!this.#mayPersist()) return;
    this.#metadata.appendAnchor({ agentId: input.agentId, anchor: input.anchor });
  }

  /**
   * Seal an Actor's conversation at a recorded end.
   *
   * A durable session file now owns the history, so the live manager is
   * released and the sealed end becomes the next checkpoint's anchor. A
   * memory-only Actor keeps its manager: it is that Actor's only conversation.
   * Nothing is appended here — the Job's own terminal event records the same
   * bound, and the Runtime owns that verdict.
   */
  seal(agentId: string, endEntryId: string | null): void {
    const descriptor = this.#retained.get(agentId);
    if (descriptor === undefined || !this.#storage.durable) return;
    const anchor = endEntryId ?? descriptor.anchor;
    const file = descriptor.sessionFile;
    // A live conversation whose entries never reached a file is still the only
    // copy: release nothing, but keep the sealed anchor for the next revival.
    const release = file !== null && existsSync(file);
    this.#retained.set(agentId, freezeDescriptor({
      ...descriptor,
      anchor,
      sessionManager: release ? null : descriptor.sessionManager,
    }));
  }

  /**
   * Drop the assignment of every Actor whose own conversation already recorded
   * a user or assistant turn between its first Job's start and the checkpoint
   * anchor.
   *
   * An interrupted Job may have recorded its prompt without the adapter
   * observing the turn boundary, so the native entries are authoritative. The
   * probe reads the conversation as of the checkpoint anchor, never a turn
   * appended afterwards. The cleared assignment is not appended here: the next
   * identity checkpoint persists it. `initialJobs` carries each Actor's first
   * Job (the one with no continuation predecessor).
   */
  restateAssignments(initialJobs: readonly ActorFirstJob[]): void {
    if (!this.#storage.durable) return;
    const starts = new Map<string, string | null>();
    for (const job of initialJobs) starts.set(job.agentId, job.startEntryId);
    for (const [agentId, descriptor] of this.#retained) {
      if (descriptor.assignment === null || descriptor.sessionFile === null) continue;
      const startEntryId = starts.get(agentId) ?? null;
      if (!this.#storage.hasRecordedTurn(descriptor.sessionFile, startEntryId, descriptor.anchor)) continue;
      this.#retained.set(agentId, freezeDescriptor({ ...descriptor, assignment: null }));
    }
  }

  /**
   * The native entries of one recorded Job interval, as the transcript reader
   * sees them. Null when this root is memory-only or no conversation is
   * recorded for the Actor.
   */
  readInterval(input: {
    readonly agentId: string;
    readonly startEntryId: string | null;
    readonly endEntryId: string | null;
  }): readonly SessionEntry[] | null {
    const descriptor = this.#retained.get(input.agentId);
    if (!this.#storage.durable || descriptor === undefined || descriptor.sessionFile === null) return null;
    const slice = this.#storage.readSlice(
      descriptor.sessionFile,
      input.startEntryId,
      input.endEntryId,
      descriptor.sessionManager ?? undefined,
    );
    return sessionEntries(slice, `Actor ${input.agentId}'s recorded Job interval`);
  }

  /**
   * Where an unfinished Job's conversation stops, in file order, after its
   * start. Null when the Actor has no recorded conversation after it.
   *
   * This is a native bound, not a status: the Runtime decides that a Job without
   * a recorded end was interrupted, and the root seals this end into the
   * restored registry so the repaired Job's transcript and next revival agree.
   */
  recoveryBoundEnd(input: { readonly agentId: string; readonly startEntryId: string | null }): string | null {
    const descriptor = this.#retained.get(input.agentId);
    if (!this.#storage.durable || descriptor === undefined || descriptor.sessionFile === null) return null;
    return this.#storage.interruptedEnd(descriptor.sessionFile, input.startEntryId);
  }

  /**
   * The readonly loadout a capability scope is rebuilt from when the Actor has
   * no live child Pi. Null for an unknown Actor; the caller decides how to
   * report a missing scope.
   */
  toolScope(agentId: string): ActorToolScope | null {
    const descriptor = this.#retained.get(agentId);
    if (descriptor === undefined) return null;
    return Object.freeze({
      tools: descriptor.tools,
      excludedTools: descriptor.excludedTools ?? NO_TOOLS,
    });
  }

  #model(modelRef: NativeModelRef | null): Model<Api> | null {
    if (modelRef === null) return null;
    try {
      return this.#models.find(modelRef);
    } catch {
      // A catalog that cannot answer loses the model, never the identity: a
      // routed Actor then fails its revival explicitly with model_unavailable.
      return null;
    }
  }

  #mayPersist(): boolean {
    return this.#storage.durable && this.#guard.mayPersist();
  }

  #persistIdentity(agentId: string, descriptor: NativeRetainedActor): void {
    if (!this.#mayPersist()) return;
    const file = descriptor.sessionFile;
    if (file === null) return;
    const record = identityRecordOf(descriptor, file);
    const patch = changedIdentity(record, this.#persisted.get(agentId));
    if (Object.keys(patch).length === 0) return;
    this.#metadata.appendIdentity({ agentId, patch, anchor: descriptor.anchor });
    this.#persisted.set(agentId, record);
  }

  #seedEntries(agentId: string, seed: InheritedContext): FileEntry[] {
    const raw = seed["entries"];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw invalidSeed(agentId, "entries", "an array of native session entries");
    const values: readonly unknown[] = raw;
    const entries: FileEntry[] = [];
    for (const entry of values) {
      if (!isFileEntry(entry)) throw invalidSeed(agentId, "entries", "an array of native session entries");
      entries.push(entry);
    }
    return entries;
  }

  #seedText(agentId: string, seed: InheritedContext, field: string): string | null {
    const value = seed[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value === "") throw invalidSeed(agentId, field, "a non-empty path");
    return value;
  }

  #seedLeafId(agentId: string, seed: InheritedContext): string | null {
    const value = seed["seedLeafId"];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value === "") throw invalidSeed(agentId, "seedLeafId", "a native entry id");
    return value;
  }

  /** The last conversation entry of the seed, or its recorded seed leaf. */
  #seedAnchor(agentId: string, seed: InheritedContext | null): string | null {
    if (seed === null) return null;
    const entries = this.#seedEntries(agentId, seed);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      // The captured array starts with the session header, which is not a leaf.
      if (entry !== undefined && entry.type !== "session") return entry.id;
    }
    return this.#seedLeafId(agentId, seed);
  }
}

/**
 * The descriptor stored by the map: a frozen copy whose tool arrays cannot be
 * mutated by whoever retained it.
 */
function freezeDescriptor(descriptor: NativeRetainedActor): NativeRetainedActor {
  const modelRef = descriptor.modelRef;
  return Object.freeze({
    ...descriptor,
    modelRef: modelRef === null ? null : Object.freeze({ provider: modelRef.provider, id: modelRef.id }),
    tools: descriptor.tools === null ? null : Object.freeze([...descriptor.tools]),
    excludedTools: descriptor.excludedTools === null ? null : Object.freeze([...descriptor.excludedTools]),
  });
}

/** The JSON-safe identity record this module writes. */
function identityRecordOf(descriptor: NativeRetainedActor, sessionFile: string): ActorIdentityRecord {
  const modelRef = descriptor.modelRef;
  return {
    sessionFile,
    cwd: descriptor.cwd,
    trusted: descriptor.trusted,
    allowInherited: descriptor.allowInherited,
    roleId: descriptor.roleId,
    roleInstructions: descriptor.roleInstructions,
    model: modelRef === null ? null : { provider: modelRef.provider, id: modelRef.id },
    thinkingLevel: descriptor.thinkingLevel,
    tools: descriptor.tools === null ? null : [...descriptor.tools],
    excludedTools: [...(descriptor.excludedTools ?? [])],
    assignment: descriptor.assignment,
    routed: descriptor.routed,
  };
}

interface MutableIdentityPatch {
  sessionFile?: string;
  cwd?: string;
  trusted?: boolean;
  allowInherited?: boolean;
  roleId?: string | null;
  roleInstructions?: string | null;
  model?: NativeModelRef | null;
  thinkingLevel?: string | null;
  tools?: readonly string[] | null;
  excludedTools?: readonly string[];
  assignment?: string | null;
  routed?: boolean;
}

/** Only fields whose recorded value changed, never the whole registry. */
function changedIdentity(next: ActorIdentityRecord, previous: ActorIdentityRecord | undefined): ActorIdentityPatch {
  const patch: MutableIdentityPatch = {};
  if (previous === undefined) {
    return { ...next };
  }
  if (next.sessionFile !== previous.sessionFile) patch.sessionFile = next.sessionFile;
  if (next.cwd !== previous.cwd) patch.cwd = next.cwd;
  if (next.trusted !== previous.trusted) patch.trusted = next.trusted;
  if (next.allowInherited !== previous.allowInherited) patch.allowInherited = next.allowInherited;
  if (next.roleId !== previous.roleId) patch.roleId = next.roleId;
  if (next.roleInstructions !== previous.roleInstructions) patch.roleInstructions = next.roleInstructions;
  if (!sameModelRef(next.model, previous.model)) patch.model = next.model;
  if (next.thinkingLevel !== previous.thinkingLevel) patch.thinkingLevel = next.thinkingLevel;
  if (!sameLoadout(next.tools, previous.tools)) patch.tools = next.tools;
  if (!sameLoadout(next.excludedTools, previous.excludedTools)) patch.excludedTools = next.excludedTools;
  if (next.assignment !== previous.assignment) patch.assignment = next.assignment;
  if (next.routed !== previous.routed) patch.routed = next.routed;
  return patch;
}

function sameModelRef(next: NativeModelRef | null, previous: NativeModelRef | null): boolean {
  if (next === null || previous === null) return next === previous;
  return next.provider === previous.provider && next.id === previous.id;
}

function sameLoadout(next: readonly string[] | null, previous: readonly string[] | null): boolean {
  if (next === null || previous === null) return next === previous;
  return next.length === previous.length && next.every((value, index) => value === previous[index]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(agentId: string, value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new SubagentStoreError("storage_corrupt", `Actor ${agentId} has no identity record object.`, { agentId });
  }
  return value;
}

/**
 * The folded durable leaf: a native entry id, or null when the conversation
 * never recorded an entry. A dangling or malformed value is corruption.
 */
function restoreAnchor(agentId: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value !== "") return value;
  throw new SubagentStoreError(
    "storage_corrupt",
    `Actor ${agentId} records a native session file but no leaf anchor; refusing to continue it from an unknown position.`,
    { agentId },
  );
}

/** A required non-empty text field of a folded actor identity. */
function requireText(agentId: string, record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value === "string" && value !== "") return value;
  throw new SubagentStoreError(
    "storage_corrupt",
    `Actor ${agentId} records no valid ${field}; refusing to rebuild a partial identity.`,
    { agentId, field },
  );
}

/** A required boolean field of a folded actor identity. */
function requireBoolean(agentId: string, record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value === "boolean") return value;
  throw new SubagentStoreError("storage_corrupt", `Actor ${agentId} records a malformed ${field}.`, { agentId, field });
}

/** A nullable text field of a folded actor identity. */
function nullableText(agentId: string, record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new SubagentStoreError("storage_corrupt", `Actor ${agentId} records a malformed ${field}.`, { agentId, field });
}

/**
 * The model reference of a folded actor identity. A routed Actor must carry a
 * usable provider/id pair; a Fresh Actor whose routing never settled records
 * none and routes again. A recorded-but-malformed reference always throws, so it
 * can never degrade into either case.
 */
function identityModelRef(
  agentId: string,
  record: Record<string, unknown>,
  routed: boolean,
): NativeModelRef | null {
  const value = record["model"];
  if (value === null || value === undefined) {
    if (!routed) return null;
    throw new SubagentStoreError(
      "storage_corrupt",
      `Routed actor ${agentId} records no model reference; refusing to continue it on a default model.`,
      { agentId },
    );
  }
  if (
    !isPlainObject(value) ||
    typeof value["provider"] !== "string" ||
    value["provider"] === "" ||
    typeof value["id"] !== "string" ||
    value["id"] === ""
  ) {
    throw new SubagentStoreError(
      "storage_corrupt",
      `Actor ${agentId} records a malformed model reference; refusing to continue its conversation on another model.`,
      { agentId },
    );
  }
  return { provider: value["provider"], id: value["id"] };
}

/** A recorded tool list; a present value must be tool names. */
function actorLoadout(
  agentId: string,
  record: Record<string, unknown>,
  field: string,
): readonly string[] | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new SubagentStoreError("storage_corrupt", `Actor ${agentId} records a malformed ${field}.`, { agentId, field });
  }
  const values: readonly unknown[] = value;
  const names: string[] = [];
  for (const name of values) {
    if (typeof name !== "string") {
      throw new SubagentStoreError("storage_corrupt", `Actor ${agentId} records a malformed ${field}.`, { agentId, field });
    }
    names.push(name);
  }
  return names;
}

/** The captured system prompt an inherited Actor's identity falls back to. */
function seedSystemPrompt(seed: InheritedContext | null): string | null {
  if (seed === null) return null;
  const value = seed["systemPrompt"];
  return typeof value === "string" && value !== "" ? value : null;
}

function invalidSeed(agentId: string, field: string, expected: string): SubagentError {
  return new SubagentError(
    "inherited_seed_invalid",
    `The inherited seed of ${agentId} carries ${field} that is not ${expected}; refusing to seed a native session from it.`,
    { agentId, field },
  );
}

/**
 * The tree identity every native session entry carries. The entry itself is
 * opaque SDK data and is passed through unchanged: only `type`, `id` and
 * `parentId` are validated, because they are the fields a conversation tree,
 * its leaf and a recorded anchor are built from.
 */
function isFileEntry(value: unknown): value is FileEntry {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value) || typeof value.type !== "string") return false;
  if (!("id" in value) || typeof value.id !== "string" || value.id === "") return false;
  if (value.type === "session") return true;
  return "parentId" in value && (value.parentId === null || typeof value.parentId === "string");
}

function sessionEntries(value: readonly unknown[], where: string): readonly SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const entry of value) {
    if (!isFileEntry(entry) || entry.type === "session") {
      throw new SubagentStoreError(
        "storage_corrupt",
        `${where} holds an entry that is not a native session entry.`,
      );
    }
    entries.push(entry);
  }
  return entries;
}
