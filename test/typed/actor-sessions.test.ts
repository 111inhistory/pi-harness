/**
 * Retained Actor native sessions, against a real SessionManager and the v2
 * storage engine. Nothing here reaches a provider: every conversation is a
 * local fixture and every decision under test is this module's own.
 *
 * The storage port is an explicit adapter over the existing engine, exactly the
 * shape the root service injects: the module never sees the legacy store object.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, AssistantMessage, Model, Usage, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { FileEntry } from "@earendil-works/pi-coding-agent";

import { ActorSessionStore } from "../../src/subagent/actor-sessions.ts";
import type {
  ActorIdentityPatch,
  ActorModelLookup,
  ActorSessionStorage,
  ActorToolScope,
  OpenedActorSession,
} from "../../src/subagent/actor-sessions.ts";
import type { NativeModelRef, NativeRetainedActor } from "../../src/subagent/native-types.ts";
import { createSubagentStore, SubagentStoreError } from "../../src/subagent/storage.ts";
import { SubagentError } from "../../src/subagent/runtime.ts";
import type { InheritedContext } from "../../src/subagent/runtime.ts";

const USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const CWD = "/work/actor-sessions";

function fakeModel(id = "model-1"): Model<Api> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "fake",
    baseUrl: "https://example.invalid",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 1_000,
    maxTokens: 100,
  };
}

function user(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "fake",
    model: "model-1",
    usage: USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function retained(overrides: Partial<NativeRetainedActor> = {}): NativeRetainedActor {
  return {
    sessionManager: null,
    sessionFile: null,
    anchor: null,
    cwd: CWD,
    trusted: true,
    allowInherited: true,
    systemPrompt: null,
    roleId: null,
    roleInstructions: null,
    modelRef: null,
    model: null,
    thinkingLevel: null,
    tools: null,
    excludedTools: [],
    assignment: null,
    routed: false,
    ...overrides,
  };
}

/**
 * The tree identity subset a SessionManager exposes. The port promises a
 * SessionManager, but the storage engine declares its opened manager as an
 * opaque object, so this adapter validates the handle it receives.
 */
function isSessionManager(value: unknown): value is SessionManager {
  if (typeof value !== "object" || value === null) return false;
  return (
    "getSessionFile" in value && typeof value.getSessionFile === "function" &&
    "getLeafId" in value && typeof value.getLeafId === "function" &&
    "getEntry" in value && typeof value.getEntry === "function" &&
    "getBranch" in value && typeof value.getBranch === "function" &&
    "branch" in value && typeof value.branch === "function"
  );
}

function expectSessionManager(value: unknown, where: string): SessionManager {
  if (!isSessionManager(value)) throw new Error(`${where}: the storage engine opened no native SessionManager.`);
  return value;
}

class Catalog implements ActorModelLookup {
  readonly models: Model<Api>[];
  throwOnFind = false;

  constructor(models: Model<Api>[]) {
    this.models = models;
  }

  find(ref: NativeModelRef): Model<Api> | null {
    if (this.throwOnFind) throw new Error("catalog is offline");
    return this.models.find((model) => model.provider === ref.provider && model.id === ref.id) ?? null;
  }
}

class Guard {
  allowed = true;

  mayPersist(): boolean {
    return this.allowed;
  }
}

/** Typed port over the retained v2 storage engine. */
class EngineStorage implements ActorSessionStorage {
  readonly #engine: ReturnType<typeof createSubagentStore>;

  constructor(engine: ReturnType<typeof createSubagentStore>) {
    this.#engine = engine;
  }

  get durable(): boolean {
    return this.#engine.durable;
  }

  openForAppend(agentId: string, file: string | null, anchor: string | null, cwd: string): OpenedActorSession {
    const opened = this.#engine.openForAppend(agentId, file, anchor, cwd);
    return {
      manager: expectSessionManager(opened.manager, `actor ${agentId}`),
      file: opened.file,
      relocated: opened.relocated,
    };
  }

  readSlice(
    file: string,
    startEntryId: string | null,
    endEntryId: string | null,
    manager?: SessionManager,
  ): readonly unknown[] {
    return this.#engine.readSlice(file, startEntryId, endEntryId, manager);
  }

  hasRecordedTurn(file: string, startEntryId: string | null, endEntryId: string | null): boolean {
    return this.#engine.hasRecordedTurn(file, startEntryId, endEntryId);
  }

  interruptedEnd(file: string, startEntryId: string | null): string | null {
    return this.#engine.interruptedEnd(file, startEntryId);
  }
}

interface IdentityAppend {
  readonly customType: "subagent-actor";
  readonly agentId: string;
  readonly patch: ActorIdentityPatch;
  readonly anchor: string | null;
}

interface AnchorAppend {
  readonly customType: "subagent-anchor";
  readonly agentId: string;
  readonly anchor: string;
}

type MetadataAppend = IdentityAppend | AnchorAppend;

interface Harness {
  readonly store: ActorSessionStore;
  readonly storage: ActorSessionStorage;
  readonly guard: Guard;
  readonly catalog: Catalog;
  readonly appends: MetadataAppend[];
  readonly root: string;
  readonly sessionDir: string;
  /** The durable session files under this root's actor directory. */
  actorFile(agentId: string): string;
  dispose(): void;
}

function createHarness(options: { durable?: boolean } = {}): Harness {
  const durable = options.durable !== false;
  const root = mkdtempSync(join(tmpdir(), "actor-sessions-"));
  const sessionDir = join(root, "agents");
  const branch: object[] = [];
  const appends: MetadataAppend[] = [];
  const engine = createSubagentStore(durable ? {
    dir: sessionDir,
    appendEntry: (customType: string, data: unknown) => {
      branch.push({ type: "custom", customType, data });
    },
    readBranch: () => branch,
    readEntries: () => branch,
    openSession: (file: string, cwd?: string) => SessionManager.open(file, undefined, cwd),
  } : {});
  const guard = new Guard();
  const catalog = new Catalog([fakeModel("model-1"), fakeModel("model-2")]);
  const store = new ActorSessionStore({
    storage: new EngineStorage(engine),
    guard,
    models: catalog,
    metadata: {
      appendIdentity: (input) => {
        appends.push({ customType: "subagent-actor", agentId: input.agentId, patch: input.patch, anchor: input.anchor });
      },
      appendAnchor: (input) => {
        appends.push({ customType: "subagent-anchor", agentId: input.agentId, anchor: input.anchor });
      },
    },
  });
  const harness: Harness = {
    store,
    storage: new EngineStorage(engine),
    guard,
    catalog,
    appends,
    root,
    sessionDir,
    actorFile: (agentId) => join(sessionDir, `${agentId}.jsonl`),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
  return harness;
}

/** A real file-backed conversation with the ids of every appended message. */
function conversation(dir: string, texts: readonly string[], cwd = CWD): { manager: SessionManager; file: string; ids: string[] } {
  const manager = SessionManager.create(cwd, dir);
  const ids = texts.map((text, index) => manager.appendMessage(index % 2 === 0 ? user(text) : assistant(text)));
  const file = manager.getSessionFile();
  assert.ok(file, "a persisted conversation has a session file");
  return { manager, file, ids };
}

/** The captured seed shape `captureInheritedContext` produces. */
function seedOf(manager: SessionManager, extra: Record<string, unknown> = {}): InheritedContext {
  const header = manager.getHeader();
  const entries: FileEntry[] = header === null ? [...manager.getBranch()] : [header, ...manager.getBranch()];
  return { cwd: manager.getCwd(), entries, ...extra };
}

function isCorrupt(error: unknown, includes: string): boolean {
  return error instanceof SubagentStoreError && error.code === "storage_corrupt" && error.message.includes(includes);
}

function isAnchorUnavailable(error: unknown): boolean {
  return error instanceof SubagentError && error.code === "session_anchor_unavailable";
}

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionFile: "/work/agents/s1.jsonl",
    cwd: CWD,
    trusted: true,
    allowInherited: false,
    roleId: "reviewer",
    roleInstructions: "Review carefully.",
    model: { provider: "fake", id: "model-1" },
    thinkingLevel: "high",
    tools: ["read", "grep"],
    excludedTools: ["bash"],
    assignment: "Review the change.",
    routed: true,
    ...overrides,
  };
}

test("restoreIdentity validates a routed record and resolves its model", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  const descriptor = h.store.restoreIdentity({
    agentId: "s1",
    record: validRecord(),
    anchor: "leaf-7",
    seed: { systemPrompt: "captured parent prompt" },
  });

  assert.equal(descriptor.sessionManager, null);
  assert.equal(descriptor.sessionFile, "/work/agents/s1.jsonl");
  assert.equal(descriptor.anchor, "leaf-7");
  assert.equal(descriptor.cwd, CWD);
  assert.equal(descriptor.trusted, true);
  assert.equal(descriptor.allowInherited, false);
  assert.equal(descriptor.routed, true);
  assert.equal(descriptor.roleId, "reviewer");
  assert.equal(descriptor.roleInstructions, "Review carefully.");
  assert.deepEqual(descriptor.modelRef, { provider: "fake", id: "model-1" });
  assert.equal(descriptor.model?.id, "model-1");
  assert.equal(descriptor.thinkingLevel, "high");
  assert.deepEqual(descriptor.tools, ["read", "grep"]);
  assert.deepEqual(descriptor.excludedTools, ["bash"]);
  assert.equal(descriptor.assignment, "Review the change.");
  // An inherited Actor's prompt is recorded once with its seed; the record may
  // carry none, and the seed's captured prompt is the fallback.
  assert.equal(descriptor.systemPrompt, "captured parent prompt");

  assert.equal(h.store.get("s1"), descriptor);
  assert.equal(h.store.durable, true);
});

test("restoreIdentity keeps a recorded system prompt over the seed's", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  const descriptor = h.store.restoreIdentity({
    agentId: "s1",
    record: validRecord({ systemPrompt: "recorded prompt" }),
    anchor: "leaf-1",
    seed: { systemPrompt: "captured parent prompt" },
  });

  assert.equal(descriptor.systemPrompt, "recorded prompt");
});

test("restoreIdentity refuses a malformed persisted identity", async (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  await t.test("no record object", () => {
    assert.throws(
      () => h.store.restoreIdentity({ agentId: "s1", record: null, anchor: "leaf-1", seed: null }),
      (error) => isCorrupt(error, "identity record object"),
    );
  });

  await t.test("missing cwd", () => {
    assert.throws(
      () => h.store.restoreIdentity({ agentId: "s1", record: validRecord({ cwd: "" }), anchor: "leaf-1", seed: null }),
      (error) => isCorrupt(error, "cwd"),
    );
  });

  await t.test("missing session file", () => {
    assert.throws(
      () => h.store.restoreIdentity({ agentId: "s1", record: validRecord({ sessionFile: null }), anchor: "leaf-1", seed: null }),
      (error) => isCorrupt(error, "sessionFile"),
    );
  });

  await t.test("malformed leaf anchor", () => {
    assert.throws(
      () => h.store.restoreIdentity({ agentId: "s1", record: validRecord(), anchor: "", seed: null }),
      (error) => isCorrupt(error, "leaf anchor"),
    );
  });

  await t.test("a never-started conversation has no leaf yet", () => {
    const descriptor = h.store.restoreIdentity({ agentId: "s3", record: validRecord(), anchor: null, seed: null });
    assert.equal(descriptor.anchor, null);
    assert.equal(h.store.get("s3")?.anchor, null);
    // Opening it records no anchor and refuses nothing: the file owns the
    // conversation and there is no recorded position to move to.
    const manager = h.store.open({ agentId: "s3", retained: descriptor, seed: null, cwd: CWD });
    h.store.restoreLeaf({ manager, agentId: "s3", retained: descriptor, seed: null });
    assert.deepEqual(manager.getBranch(), []);
    assert.equal(manager.getLeafId(), null);
  });

  await t.test("malformed trust", () => {
    assert.throws(
      () => h.store.restoreIdentity({ agentId: "s1", record: validRecord({ trusted: "yes" }), anchor: "leaf-1", seed: null }),
      (error) => isCorrupt(error, "trusted"),
    );
  });

  await t.test("routed without a model reference", () => {
    assert.throws(
      () => h.store.restoreIdentity({ agentId: "s1", record: validRecord({ model: null }), anchor: "leaf-1", seed: null }),
      (error) => isCorrupt(error, "no model reference"),
    );
  });

  await t.test("malformed model reference", () => {
    assert.throws(
      () => h.store.restoreIdentity({ agentId: "s1", record: validRecord({ model: { provider: "", id: "model-1" } }), anchor: "leaf-1", seed: null }),
      (error) => isCorrupt(error, "malformed model reference"),
    );
  });

  await t.test("malformed tool loadout", () => {
    assert.throws(
      () => h.store.restoreIdentity({ agentId: "s1", record: validRecord({ tools: ["read", 7] }), anchor: "leaf-1", seed: null }),
      (error) => isCorrupt(error, "tools"),
    );
  });

  await t.test("malformed exclusion list", () => {
    assert.throws(
      () => h.store.restoreIdentity({ agentId: "s1", record: validRecord({ excludedTools: "bash" }), anchor: "leaf-1", seed: null }),
      (error) => isCorrupt(error, "excludedTools"),
    );
  });
});

test("restoreIdentity accepts a Fresh actor whose routing never settled", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  const descriptor = h.store.restoreIdentity({
    agentId: "s2",
    record: { sessionFile: "/work/agents/s2.jsonl", cwd: CWD, trusted: false, allowInherited: true, routed: false },
    anchor: "leaf-2",
    seed: null,
  });

  assert.equal(descriptor.routed, false);
  assert.equal(descriptor.modelRef, null);
  assert.equal(descriptor.model, null);
  assert.equal(descriptor.tools, null);
  assert.equal(descriptor.excludedTools, null);
});

test("restoreIdentity loses a model the catalog cannot answer for", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  const descriptor = h.store.restoreIdentity({
    agentId: "s1",
    record: validRecord({ model: { provider: "fake", id: "gone" } }),
    anchor: "leaf-1",
    seed: null,
  });

  assert.deepEqual(descriptor.modelRef, { provider: "fake", id: "gone" });
  assert.equal(descriptor.model, null);

  h.catalog.throwOnFind = true;
  const offline = h.store.restoreIdentity({ agentId: "s9", record: validRecord(), anchor: "leaf-1", seed: null });
  assert.equal(offline.model, null);
  assert.deepEqual(offline.modelRef, { provider: "fake", id: "model-1" });
});

test("retain checkpoints only the identity fields that changed", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  const first = retained({
    sessionFile: h.actorFile("s1"),
    anchor: "leaf-1",
    roleId: "reviewer",
    roleInstructions: "Review carefully.",
    modelRef: { provider: "fake", id: "model-1" },
    model: fakeModel(),
    tools: ["read"],
    excludedTools: ["bash"],
    assignment: "Do the review.",
    routed: true,
  });
  h.store.retain("s1", first);
  assert.equal(h.appends.length, 1);
  const created = h.appends[0];
  assert.ok(created !== undefined && created.customType === "subagent-actor");
  assert.equal(Object.keys(created.patch).length, 12);
  assert.equal(created.anchor, "leaf-1");

  // The same identity with only a moved anchor is not a new identity record.
  h.store.retain("s1", { ...first, anchor: "leaf-2" });
  assert.equal(h.appends.length, 1);
  assert.equal(h.store.get("s1")?.anchor, "leaf-2");

  // A changed assignment is one field, not a re-written registry.
  h.store.retain("s1", { ...first, anchor: "leaf-3", assignment: null });
  assert.equal(h.appends.length, 2);
  const patched = h.appends[1];
  assert.ok(patched !== undefined && patched.customType === "subagent-actor");
  assert.deepEqual(patched.patch, { assignment: null });
  assert.equal(patched.anchor, "leaf-3");
});

test("retain checkpoints nothing without ownership or durable storage", (t) => {
  const durable = createHarness();
  t.after(() => durable.dispose());

  durable.store.retain("s1", retained({ sessionFile: durable.actorFile("s1"), anchor: "leaf-1" }));
  assert.equal(durable.appends.length, 1);

  durable.guard.allowed = false;
  durable.store.retain("s1", retained({ sessionFile: durable.actorFile("s1"), anchor: "leaf-1", assignment: "restated" }));
  assert.equal(durable.appends.length, 1, "a detached root appends nothing");
  assert.equal(durable.store.get("s1")?.assignment, "restated", "the retained descriptor still moved");

  const memory = createHarness({ durable: false });
  t.after(() => memory.dispose());
  assert.equal(memory.store.durable, false);
  memory.store.retain("s2", retained({ anchor: "leaf-1", assignment: "restated" }));
  assert.equal(memory.appends.length, 0);
  assert.equal(memory.store.get("s2")?.assignment, "restated");
});

test("recordedAnchor never adopts a leaf the session file does not hold yet", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  const manager = h.store.open({ agentId: "s1", retained: null, seed: null, cwd: CWD });
  assert.equal(manager.getLeafId(), null);
  assert.equal(h.store.recordedAnchor(manager, "leaf-0"), "leaf-0", "an unflushed conversation keeps the fallback");
  assert.equal(existsSync(h.actorFile("s1")), false);

  manager.appendMessage(user("first"));
  assert.equal(h.store.recordedAnchor(manager, "leaf-0"), manager.getLeafId());
  assert.notEqual(manager.getLeafId(), "leaf-0");
  assert.equal(existsSync(h.actorFile("s1")), true);

  assert.equal(h.store.recordedAnchor(null, "leaf-0"), "leaf-0");
  assert.equal(h.store.recordedAnchor(null, null), null);

  const memory = createHarness({ durable: false });
  t.after(() => memory.dispose());
  const inMemory = memory.store.open({ agentId: "s9", retained: null, seed: null, cwd: CWD });
  inMemory.appendMessage(user("first"));
  assert.equal(memory.store.recordedAnchor(inMemory, "leaf-0"), inMemory.getLeafId());
});

test("open reuses a live manager and restores a seeded memory conversation", (t) => {
  const h = createHarness({ durable: false });
  t.after(() => h.dispose());

  const source = SessionManager.inMemory(CWD);
  source.appendMessage(user("parent question"));
  source.appendMessage(assistant("parent answer"));
  const parentLeaf = source.getLeafId();
  assert.ok(parentLeaf);

  const seed = seedOf(source, { systemPrompt: "captured prompt" });
  const opened = h.store.open({ agentId: "s1", retained: null, seed, cwd: CWD });
  assert.equal(opened.getLeafId(), parentLeaf);
  assert.deepEqual(
    opened.getBranch().map((entry) => entry.id),
    source.getBranch().map((entry) => entry.id),
    "the child keeps the native conversation verbatim",
  );

  // A restored anchor moves a rebuilt conversation back; a live manager is
  // authoritative and is never re-positioned.
  opened.branch(source.getBranch()[0]?.id ?? parentLeaf);
  h.store.restoreLeaf({ manager: opened, agentId: "s1", retained: null, seed });
  assert.equal(opened.getLeafId(), parentLeaf);

  const live = SessionManager.inMemory(CWD);
  live.appendMessage(user("live turn"));
  const descriptor = retained({ sessionManager: live, anchor: "recorded-leaf" });
  assert.equal(h.store.open({ agentId: "s2", retained: descriptor, seed, cwd: CWD }), live);
  const liveLeaf = live.getLeafId();
  assert.notEqual(liveLeaf, parentLeaf);
  h.store.restoreLeaf({ manager: live, agentId: "s2", retained: descriptor, seed });
  assert.equal(live.getLeafId(), liveLeaf, "a live manager keeps its own authoritative leaf");
});

test("a seed header is never a conversation anchor", (t) => {
  const h = createHarness({ durable: false });
  t.after(() => h.dispose());

  const empty = SessionManager.inMemory(CWD);
  // A captured memory seed carries the header plus an empty branch; the header
  // is session identity, never a leaf a conversation can branch to.
  const seed = seedOf(empty);
  const opened = h.store.open({ agentId: "s1", retained: null, seed, cwd: CWD });
  assert.equal(opened.getLeafId(), null);
  h.store.restoreLeaf({ manager: opened, agentId: "s1", retained: null, seed });
  assert.equal(opened.getLeafId(), null);

  const malformed: InheritedContext = { entries: [{ type: "message" }], cwd: CWD };
  assert.throws(
    () => h.store.open({ agentId: "s2", retained: null, seed: malformed, cwd: CWD }),
    (error) => error instanceof SubagentError && error.code === "inherited_seed_invalid",
  );
});

test("restoreLeaf refuses an anchor the rebuilt conversation does not hold", (t) => {
  const h = createHarness({ durable: false });
  t.after(() => h.dispose());

  const conversationManager = SessionManager.inMemory(CWD);
  conversationManager.appendMessage(user("one"));
  conversationManager.appendMessage(assistant("two"));

  assert.throws(
    () => h.store.restoreLeaf({
      manager: conversationManager,
      agentId: "s1",
      retained: retained({ anchor: "not-in-this-tree" }),
      seed: null,
    }),
    (error) => isAnchorUnavailable(error) && String(error).includes("not-in-this-tree"),
  );
});

test("durable open materializes an inherited seed and branches to its leaf", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  const foreign = conversation(join(h.root, "foreign"), ["one", "two", "three"]);
  const seedLeaf = foreign.ids[0];
  assert.ok(seedLeaf);

  const opened = h.store.open({
    agentId: "s1",
    retained: null,
    seed: { cwd: CWD, seedFile: foreign.file, seedLeafId: seedLeaf },
    cwd: CWD,
  });

  const own = h.actorFile("s1");
  assert.equal(opened.getSessionFile(), own);
  assert.equal(opened.getHeader()?.parentSession, foreign.file);
  assert.deepEqual(opened.getBranch().map((entry) => entry.id), [seedLeaf], "the recorded leaf bounds the copied path");
  assert.equal(opened.getLeafId(), seedLeaf);
  assert.equal(existsSync(own), true);
});

test("a retained foreign session file is copied before it is appended to", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  const foreign = conversation(join(h.root, "foreign"), ["one", "two"]);
  const recorded = h.store.restoreIdentity({
    agentId: "s1",
    record: { sessionFile: foreign.file, cwd: CWD, trusted: true, allowInherited: false, routed: false },
    anchor: foreign.ids[1] ?? null,
    seed: null,
  });

  const opened = h.store.open({ agentId: "s1", retained: recorded, seed: null, cwd: CWD });
  assert.equal(opened.getSessionFile(), h.actorFile("s1"));
  assert.deepEqual(
    opened.getBranch().map((entry) => entry.id),
    foreign.ids,
    "the whole recorded conversation is copied",
  );
  assert.equal(existsSync(foreign.file), true, "the foreign file is read, never written");
});

test("checkpointAppendedAnchor records the appended leaf and its file", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  const foreign = conversation(join(h.root, "foreign"), ["one", "two"]);
  const recorded = h.store.restoreIdentity({
    agentId: "s1",
    record: { sessionFile: foreign.file, cwd: CWD, trusted: true, allowInherited: false, routed: false },
    anchor: foreign.ids[1] ?? null,
    seed: null,
  });
  h.appends.length = 0;

  // Opening a foreign file copies it into this root's directory; the checkpoint
  // is where that relocation becomes the Actor's recorded file.
  const manager = h.store.open({ agentId: "s1", retained: recorded, seed: null, cwd: CWD });
  const own = h.actorFile("s1");
  assert.equal(manager.getSessionFile(), own);
  const appended = manager.appendCustomMessageEntry("subagent-completion", "a peer finished", true);
  h.store.checkpointAppendedAnchor({ agentId: "s1", manager, anchor: appended });

  assert.equal(h.store.get("s1")?.anchor, appended);
  assert.equal(h.store.get("s1")?.sessionFile, own);
  assert.deepEqual(h.appends, [
    { customType: "subagent-actor", agentId: "s1", patch: { sessionFile: own }, anchor: appended },
    { customType: "subagent-anchor", agentId: "s1", anchor: appended },
  ]);

  // A stale anchor never moves the checkpoint behind the appended leaf.
  h.store.checkpointAppendedAnchor({ agentId: "s1", manager, anchor: foreign.ids[0] ?? "" });
  assert.equal(h.store.get("s1")?.anchor, appended);
  assert.equal(h.appends.length, 2);

  // An append that never reached a durable file is not adopted.
  const inMemory = SessionManager.inMemory(CWD);
  const memoryAnchor = inMemory.appendCustomMessageEntry("subagent-completion", "unsaved", true);
  const before = h.store.get("s1");
  h.store.checkpointAppendedAnchor({ agentId: "s1", manager: inMemory, anchor: memoryAnchor });
  assert.equal(h.store.get("s1"), before);
});

test("seal adopts a sealed end and releases only a durable manager", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  const recordedConversation = conversation(h.sessionDir, ["one", "two"]);
  const live = h.store.open({
    agentId: "s1",
    retained: null,
    seed: { cwd: CWD, seedFile: recordedConversation.file, seedLeafId: null },
    cwd: CWD,
  });
  h.store.retain("s1", retained({ sessionManager: live, sessionFile: recordedConversation.file, anchor: "anchor-1" }));
  h.store.seal("s1", "end-1");
  assert.equal(h.store.get("s1")?.anchor, "end-1");
  assert.equal(h.store.get("s1")?.sessionManager, null);

  // A live conversation whose entries never reached a file is still the only
  // copy: the seal keeps it, and a null end keeps the recorded anchor.
  const unsaved = SessionManager.inMemory(CWD);
  h.store.retain("s2", retained({ sessionManager: unsaved, sessionFile: join(h.sessionDir, "missing.jsonl"), anchor: "anchor-2" }));
  h.store.seal("s2", null);
  assert.equal(h.store.get("s2")?.sessionManager, unsaved);
  assert.equal(h.store.get("s2")?.anchor, "anchor-2");

  const memory = createHarness({ durable: false });
  t.after(() => memory.dispose());
  const sole = SessionManager.inMemory(CWD);
  memory.store.retain("s3", retained({ sessionManager: sole, anchor: "anchor-3" }));
  memory.store.seal("s3", "end-3");
  assert.equal(memory.store.get("s3")?.sessionManager, sole, "a pure-memory actor keeps its only conversation");
  assert.equal(memory.store.get("s3")?.anchor, "anchor-3");
});

test("restateAssignments drops only an assignment the conversation recorded", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  const recordedConversation = conversation(h.sessionDir, ["the prompt", "the answer"]);
  const promptId = recordedConversation.ids[0];
  const answerId = recordedConversation.ids[1];
  assert.ok(promptId !== undefined && answerId !== undefined);

  h.store.restoreIdentity({
    agentId: "s1",
    record: { sessionFile: recordedConversation.file, cwd: CWD, trusted: true, allowInherited: false, routed: false, assignment: "restate me" },
    anchor: answerId,
    seed: null,
  });
  h.store.restoreIdentity({
    agentId: "s2",
    record: { sessionFile: recordedConversation.file, cwd: CWD, trusted: true, allowInherited: false, routed: false, assignment: "keep me" },
    anchor: answerId,
    seed: null,
  });

  h.store.restateAssignments([
    // s1's Job already recorded a turn after its start.
    { agentId: "s1", startEntryId: promptId },
    // s2's Job never started, so its conversation as of the anchor has no turn.
    { agentId: "s2", startEntryId: answerId },
  ]);

  assert.equal(h.store.get("s1")?.assignment, null);
  assert.equal(h.store.get("s2")?.assignment, "keep me");

  // Never a status verdict and never a second registry write.
  assert.equal(h.appends.length, 0);
});

test("readInterval and recoveryBoundEnd report native facts only", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  const recordedConversation = conversation(h.sessionDir, ["one", "two", "three"]);
  const [first, second, third] = recordedConversation.ids;
  assert.ok(first !== undefined && second !== undefined && third !== undefined);

  h.store.restoreIdentity({
    agentId: "s1",
    record: { sessionFile: recordedConversation.file, cwd: CWD, trusted: true, allowInherited: false, routed: false },
    anchor: third,
    seed: null,
  });

  assert.deepEqual(
    h.store.readInterval({ agentId: "s1", startEntryId: first, endEntryId: third })?.map((entry) => entry.id),
    [second, third],
  );
  assert.deepEqual(
    h.store.readInterval({ agentId: "s1", startEntryId: first, endEntryId: null })?.map((entry) => entry.id),
    [second, third],
  );
  assert.equal(h.store.recoveryBoundEnd({ agentId: "s1", startEntryId: first }), third);
  assert.equal(h.store.recoveryBoundEnd({ agentId: "s1", startEntryId: third }), null);
  assert.equal(h.store.readInterval({ agentId: "unknown", startEntryId: first, endEntryId: null }), null);
  assert.equal(h.store.recoveryBoundEnd({ agentId: "unknown", startEntryId: first }), null);

  const memory = createHarness({ durable: false });
  t.after(() => memory.dispose());
  memory.store.retain("s9", retained());
  assert.equal(memory.store.readInterval({ agentId: "s9", startEntryId: null, endEntryId: null }), null);
  assert.equal(memory.store.recoveryBoundEnd({ agentId: "s9", startEntryId: null }), null);
});

test("toolScope rebuilds a readonly per-actor loadout snapshot", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  assert.equal(h.store.toolScope("unknown"), null);

  h.store.restoreIdentity({
    agentId: "s1",
    record: validRecord({ tools: ["read", "grep"], excludedTools: ["bash"] }),
    anchor: "leaf-1",
    seed: null,
  });

  const scope = h.store.toolScope("s1");
  assert.ok(scope !== null);
  assert.deepEqual(scope.tools, ["read", "grep"]);
  assert.deepEqual(scope.excludedTools, ["bash"]);

  const previous = h.store.get("s1");
  assert.ok(previous !== null);
  h.store.retain("s1", retained({ ...previous, tools: ["write"], excludedTools: null }));
  const next = h.store.toolScope("s1");
  assert.deepEqual(next?.tools, ["write"]);
  assert.deepEqual(next?.excludedTools, []);
  assert.deepEqual(scope.tools, ["read", "grep"], "an earlier snapshot is detached");
});

test("open and restoreLeaf leave the store's own record untouched", (t) => {
  const h = createHarness();
  t.after(() => h.dispose());

  const manager = h.store.open({ agentId: "s1", retained: null, seed: null, cwd: CWD });
  h.store.restoreLeaf({ manager, agentId: "s1", retained: null, seed: null });
  assert.equal(h.store.get("s1"), null, "opening a session retains nobody");
  assert.equal(h.store.readInterval({ agentId: "s1", startEntryId: null, endEntryId: null }), null);
  const scope: ActorToolScope | null = h.store.toolScope("s1");
  assert.equal(scope, null);
});
