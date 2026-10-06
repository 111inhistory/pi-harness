/**
 * Focused tests for src/subagent-storage.mjs.
 *
 * The module owns the two native storage surfaces of the subagent harness: the
 * `subagent-state` checkpoints on the root session's active branch and the
 * per-actor native session files. The tests drive it through the same injected
 * callbacks the extension passes (`appendEntry`, `readBranch`, `openSession`)
 * and through real files under a temporary directory, so a checkpoint written
 * once can be read back by a *new* store instance, exactly like a reload.
 *
 * `openTestSession` stands in for the injected `SessionManager.open`: it
 * exposes the documented read surface the store uses (`getHeader`,
 * `getEntries`, `getBranch(fromId)`, `getLeafId`) over the entries a test file
 * holds, including the native branch traversal and the native failure on an
 * unreadable session file. The real opener is Pi's SessionManager.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SUBAGENT_STATE_CUSTOM_TYPE,
  SUBAGENT_STATE_VERSION,
  SubagentStoreError,
  createSubagentStore,
} from "../src/subagent-storage.mjs";

/** A root session branch that records what the extension appends. */
function fakeRootSession() {
  const branch = [];
  return {
    branch,
    appendEntry(customType, data) {
      branch.push({
        type: "custom",
        id: `entry-${branch.length + 1}`,
        parentId: branch.length === 0 ? null : branch[branch.length - 1].id,
        timestamp: new Date().toISOString(),
        customType,
        data: JSON.parse(JSON.stringify(data)),
      });
    },
    readBranch() {
      return branch;
    },
    /** The branch as a resumed session sees it: only what this branch recorded. */
    fork() {
      const copy = JSON.parse(JSON.stringify(branch));
      return {
        appendEntry(customType, data) {
          copy.push({
            type: "custom",
            id: `entry-${copy.length + 1}-fork`,
            parentId: copy.length === 0 ? null : copy[copy.length - 1].id,
            timestamp: new Date().toISOString(),
            customType,
            data: JSON.parse(JSON.stringify(data)),
          });
        },
        readBranch() {
          return copy;
        },
      };
    },
  };
}

/** The native read surface over one session's entries, like SessionManager holds them. */
function nativeSession(entries) {
  const header = entries.find((entry) => entry.type === "session") ?? null;
  const list = entries.filter((entry) => entry.type !== "session");
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  const leafId = list.length === 0 ? null : list[list.length - 1].id;
  return {
    getHeader: () => header,
    getEntries: () => [...list],
    getLeafId: () => leafId,
    getBranch(fromId) {
      const path = [];
      let current = fromId === undefined || fromId === null ? byId.get(leafId) : byId.get(fromId);
      while (current !== undefined) {
        path.push(current);
        current = current.parentId === null || current.parentId === undefined ? undefined : byId.get(current.parentId);
      }
      return path.reverse();
    },
  };
}

/** Stands in for the injected SessionManager.open over a test session file. */
function openTestSession(file) {
  if (!existsSync(file)) return nativeSession([]);
  const text = readFileSync(file, "utf8");
  const entries = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line);
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Session file is not a valid pi session: ${file}`);
    }
    entries.push(entry);
  }
  if (entries.length === 0 && text.length > 0) throw new Error(`Session file is not a valid pi session: ${file}`);
  return nativeSession(entries);
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-storage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function storeFor(session, dir, overrides = {}) {
  return createSubagentStore({
    sessionFile: join(dir, "root.jsonl"),
    cwd: "/work",
    dir: join(dir, "subagent-sessions", "root-session"),
    appendEntry: session.appendEntry,
    readBranch: session.readBranch,
    openSession: openTestSession,
    ...overrides,
  });
}

function durableStore(t, session, overrides) {
  const dir = tempDir(t);
  return { store: storeFor(session, dir, overrides), dir };
}

/** Write one actor session file, creating its directory if needed. */
function writeActorFile(store, agentId, entries) {
  const file = store.childSessionFile(agentId);
  store.writeSeedIfMissing(agentId, entries);
  writeFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return file;
}

/** A captured inherited snapshot in the shape `captureInheritedContext` returns. */
function snapshot(headerId, messageCount) {
  const entries = [
    { type: "session", version: 3, id: headerId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work" },
  ];
  for (let index = 0; index < messageCount; index += 1) {
    entries.push({
      type: "message",
      id: `parent-${index}`,
      parentId: index === 0 ? null : `parent-${index - 1}`,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: `captured ${index}`, timestamp: 1 },
    });
  }
  return { capturedAt: 1, cwd: "/work", systemPrompt: "parent prompt", model: null, thinkingLevel: "low", tools: ["read"], entries };
}

function registryWithInheritedJob(agentId, snap) {
  const spec = {
    name: "inherited",
    task: "do the thing",
    context: null,
    inheritContext: true,
    inheritedContext: snap,
  };
  return {
    version: 1,
    actors: [{ agentId, name: "inherited", parentAgentId: null, status: "failed", depth: 1 }],
    jobs: [
      {
        jobId: "job-1",
        agentId,
        status: "failed",
        spec,
        history: { startEntryId: "parent-3", endEntryId: "parent-5" },
      },
    ],
  };
}

test("checkpoint round-trip: the latest branch entry is the restored state", (t) => {
  const session = fakeRootSession();
  const { store, dir } = durableStore(t, session);
  const first = { version: 1, actors: [], jobs: [{ jobId: "job-1", agentId: "agent_a-1", status: "completed", spec: { name: "one" } }] };
  const second = { version: 1, actors: [], jobs: [{ jobId: "job-2", agentId: "agent_a-1", status: "running", spec: { name: "two" } }] };

  assert.equal(store.save({ registry: first, actors: {} }), true);
  store.save({ registry: second, actors: { "agent_a-1": { cwd: "/work", assignment: "keep" } } });

  // A fresh store over the same branch is what a reload does.
  const checkpoint = storeFor(session, dir).load();
  assert.equal(checkpoint.version, SUBAGENT_STATE_VERSION);
  assert.equal(checkpoint.registry.jobs[0].jobId, "job-2");
  assert.equal(checkpoint.actors["agent_a-1"].assignment, "keep");
  assert.equal(session.branch.length, 2);
  assert.equal(session.branch[0].customType, SUBAGENT_STATE_CUSTOM_TYPE);
});

test("an abandoned branch keeps its own checkpoints", (t) => {
  const session = fakeRootSession();
  const { store } = durableStore(t, session);
  store.save({ registry: { version: 1, actors: [], jobs: [{ jobId: "job-1" }] }, actors: {} });
  const forked = session.fork();
  assert.equal(forked.readBranch().length, 1, "the fork starts from the same checkpoint");
  assert.equal(forked.readBranch()[0].data.registry.jobs[0].jobId, "job-1");
});

test("inherited snapshots are stored once as a seed file and referenced afterwards", (t) => {
  const session = fakeRootSession();
  const { store, dir } = durableStore(t, session);
  const snap = snapshot("seed-header", 6);
  const registry = registryWithInheritedJob("agent_seed-1", snap);
  const capturedBefore = structuredClone(snap.entries);

  store.save({ registry, actors: {} });
  const payload = session.branch[0].data;
  const stored = payload.registry.jobs[0].spec.inheritedContext;

  // No transcript lands in the checkpoint: the persisted snapshot keeps the
  // captured environment a revival needs, and its entries become a reference.
  assert.equal(Array.isArray(stored.entries), false);
  const seedFile = stored.entries.seedFile;
  assert.equal(typeof seedFile, "string");
  assert.equal(stored.entries.entryCount, snap.entries.length);
  assert.equal(existsSync(seedFile), true);
  assert.equal(stored.systemPrompt, snap.systemPrompt);
  assert.equal(stored.thinkingLevel, snap.thinkingLevel);
  assert.deepEqual(stored.tools, snap.tools);
  assert.equal(stored.cwd, snap.cwd);
  assert.equal(seedFile.startsWith(join(dir, "subagent-sessions", "root-session")), true);

  // The seed file is a standard Pi session file: header first, one JSON entry per line.
  const lines = readFileSync(seedFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines, snap.entries);

  // The capture the live registry still holds is neither replaced nor modified.
  assert.deepEqual(registry.jobs[0].spec.inheritedContext.entries, capturedBefore);
  assert.equal(registry.jobs[0].spec.inheritedContext.entries, snap.entries);

  // A reopened store — the reload path — reconstructs the whole captured
  // context, not just the messages.
  const hydrated = storeFor(session, dir).hydrate(payload);
  assert.deepEqual(hydrated.registry.jobs[0].spec.inheritedContext, snap);

  // A second checkpoint reuses the file instead of rewriting it.
  const before = statSync(seedFile).mtimeMs;
  store.save({ registry, actors: {} });
  const again = session.branch[1].data.registry.jobs[0].spec.inheritedContext;
  assert.equal(again.entries.seedFile, seedFile);
  assert.equal(statSync(seedFile).mtimeMs, before);
});

test("a later checkpoint reuses the materialized seed without re-serializing the transcript", (t) => {
  const session = fakeRootSession();
  const { store, dir } = durableStore(t, session);
  const captured = snapshot("seed-header", 4);
  const clean = structuredClone(captured.entries);
  // Workload detector: `toJSON` runs only when an entry is JSON-serialized.
  // Writing the seed file serializes the capture once; no checkpoint may
  // serialize it a second time.
  let serializations = 0;
  captured.entries = captured.entries.map((entry) => ({
    ...entry,
    toJSON() {
      serializations += 1;
      return entry;
    },
  }));
  const registry = registryWithInheritedJob("agent_seed-1", captured);

  store.save({ registry, actors: {} });
  const seedFile = session.branch[0].data.registry.jobs[0].spec.inheritedContext.entries.seedFile;
  const afterFirst = serializations;
  assert.equal(afterFirst >= captured.entries.length, true, "the seed write serializes the captured entries");

  // A second checkpoint — the repeated continuation path — must substitute the
  // materialized seed reference before its JSON clone, so the raw transcript is
  // neither copied again nor even walked by the clone.
  store.save({ registry, actors: {} });
  assert.equal(serializations, afterFirst, "a later checkpoint serializes no captured entry");

  // The checkpoint still carries the reference, the live capture keeps its
  // identity, and a reload restores the exact captured entries.
  const again = session.branch[1].data.registry.jobs[0].spec.inheritedContext;
  assert.equal(again.entries.seedFile, seedFile);
  assert.equal(again.entries.entryCount, captured.entries.length);
  assert.equal(registry.jobs[0].spec.inheritedContext, captured);
  assert.equal(registry.jobs[0].spec.inheritedContext.entries, captured.entries);
  const reloaded = storeFor(session, dir).hydrate(session.branch[1].data);
  assert.deepEqual(reloaded.registry.jobs[0].spec.inheritedContext, { ...captured, entries: clean });
});

test("a reopened store reconstructs native blocks with their signatures", (t) => {
  const session = fakeRootSession();
  const { store, dir } = durableStore(t, session);
  const entries = [
    { type: "session", version: 3, id: "seed-header", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work" },
    {
      type: "message",
      id: "parent-0",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        stopReason: "toolUse",
        usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [
          { type: "thinking", thinking: "weighing options", signature: "c2lnbmF0dXJl" },
          { type: "text", text: "checking the file" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.mjs" } },
        ],
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "parent-1",
      parentId: "parent-0",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "content" }], isError: false, timestamp: 2 },
    },
  ];
  const snap = { capturedAt: 1, cwd: "/work", systemPrompt: "parent prompt", model: null, thinkingLevel: "low", tools: ["read"], entries };
  store.save({ registry: registryWithInheritedJob("agent_sig-1", snap), actors: {} });

  const hydrated = storeFor(session, dir).hydrate(session.branch[0].data);
  assert.deepEqual(hydrated.registry.jobs[0].spec.inheritedContext, snap);
});

test("a continuation spec that embeds the initial seed keeps the same reference", (t) => {
  const session = fakeRootSession();
  const { store, dir } = durableStore(t, session);
  const snap = snapshot("seed-header", 3);
  const initial = registryWithInheritedJob("agent_seed-1", snap).jobs[0].spec;
  const registry = {
    version: 1,
    actors: [],
    jobs: [
      { jobId: "job-1", agentId: "agent_seed-1", status: "failed", spec: initial, history: null },
      { jobId: "job-2", agentId: "agent_seed-1", status: "running", spec: { kind: "continuation", name: "x", seed: initial }, history: null },
    ],
  };
  store.save({ registry, actors: {} });
  const payload = session.branch[0].data.registry;
  const first = payload.jobs[0].spec.inheritedContext.entries;
  const second = payload.jobs[1].spec.seed.inheritedContext.entries;
  assert.equal(second.seedFile, first.seedFile);
  const hydrated = storeFor(session, dir).hydrate(session.branch[0].data);
  assert.deepEqual(hydrated.registry.jobs[1].spec.seed.inheritedContext.entries, snap.entries);
});

test("hydrate fails explicitly when a referenced seed file is gone", (t) => {
  const session = fakeRootSession();
  const { store, dir } = durableStore(t, session);
  const snap = snapshot("seed-header", 2);
  store.save({ registry: registryWithInheritedJob("agent_seed-1", snap), actors: {} });
  const payload = session.branch[0].data;
  const seedFile = payload.registry.jobs[0].spec.inheritedContext.entries.seedFile;
  rmSync(seedFile, { force: true });

  assert.throws(
    () => storeFor(session, dir).hydrate(payload),
    (error) => error instanceof SubagentStoreError && error.code === "storage_seed_missing" && error.detail.file === seedFile,
  );
});

test("hydrate fails explicitly when a seeded session file is unreadable", (t) => {
  const session = fakeRootSession();
  const { store, dir } = durableStore(t, session);
  store.save({ registry: registryWithInheritedJob("agent_seed-1", snapshot("seed-header", 2)), actors: {} });
  const payload = session.branch[0].data;
  const seedFile = payload.registry.jobs[0].spec.inheritedContext.entries.seedFile;
  writeFileSync(seedFile, "{ this is not json }\n");

  assert.throws(
    () => storeFor(session, dir).hydrate(payload),
    (error) => error instanceof SubagentStoreError && error.code === "storage_corrupt" && error.detail.file === seedFile,
  );
});

test("a seed file that does not start with the captured seed is refused", (t) => {
  const session = fakeRootSession();
  const { store, dir } = durableStore(t, session);
  const snap = snapshot("seed-header", 1);
  store.writeSeedIfMissing("agent_seed-1", snap.entries);
  const file = store.childSessionFile("agent_seed-1");

  // The same actor file already holds a conversation that started on another
  // header (and the same number of entries), so re-seeding must refuse instead
  // of appending a second identity into one session file.
  const foreign = [
    { type: "session", version: 3, id: "other-header", timestamp: "x", cwd: "/work" },
    { type: "message", id: "f1", parentId: null, timestamp: "x", message: { role: "user", content: "other", timestamp: 1 } },
  ];
  writeFileSync(file, foreign.map((entry) => `${JSON.stringify(entry)}\n`).join(""));

  assert.throws(
    () => storeFor(session, dir).writeSeedIfMissing("agent_seed-1", snap.entries),
    (error) => error instanceof SubagentStoreError && error.code === "storage_seed_conflict" && error.detail.file === file,
  );
});

test("a corrupted or unknown-version checkpoint fails instead of starting empty", (t) => {
  const session = fakeRootSession();
  const { store } = durableStore(t, session);
  session.branch.push({ type: "custom", id: "e1", parentId: null, timestamp: "x", customType: SUBAGENT_STATE_CUSTOM_TYPE, data: { version: 99, registry: {}, actors: {} } });
  assert.throws(() => store.load(), (error) => error instanceof SubagentStoreError && error.code === "storage_corrupt");

  session.branch.push({ type: "custom", id: "e2", parentId: "e1", timestamp: "x", customType: SUBAGENT_STATE_CUSTOM_TYPE, data: null });
  assert.throws(() => store.load(), (error) => error instanceof SubagentStoreError && error.code === "storage_corrupt");
});

test("history follows the native branch, not the file's order", (t) => {
  const session = fakeRootSession();
  const { store } = durableStore(t, session);
  const header = { type: "session", version: 3, id: "child", timestamp: "x", cwd: "/work" };
  const message = (id, parentId, text, timestamp) => ({
    type: "message",
    id,
    parentId,
    timestamp: "x",
    message: { role: "user", content: text, timestamp },
  });
  // File order is a, b, c — but c continues from a, so the branch to the leaf
  // is a -> c and b is a dead end.
  writeActorFile(store, "agent_branch-1", [header, message("a", null, "assignment", 1), message("b", "a", "abandoned", 2), message("c", "a", "retry", 3)]);

  assert.deepEqual(store.readHistory({ agentId: "agent_branch-1", startEntryId: "a", endEntryId: "c" }).map((entry) => entry.id), ["c"]);
  assert.deepEqual(store.readHistory({ agentId: "agent_branch-1", startEntryId: "a" }).map((entry) => entry.id), ["c"]);
  assert.deepEqual(store.readHistory({ agentId: "agent_branch-1", endEntryId: "b" }).map((entry) => entry.id), ["a", "b"]);
  assert.equal(store.hasSessionFile("agent_branch-1"), true);
  assert.equal(store.hasRecordedTurn("agent_branch-1", "a"), true);
});

test("a sealed history end keeps later entries out of the slice", (t) => {
  const session = fakeRootSession();
  const { store } = durableStore(t, session);
  const header = { type: "session", version: 3, id: "child", timestamp: "x", cwd: "/work" };
  const message = (id, parentId, text, timestamp) => ({
    type: "message",
    id,
    parentId,
    timestamp: "x",
    message: { role: "user", content: text, timestamp },
  });
  writeActorFile(store, "agent_sealed-1", [header, message("a", null, "assignment", 1), message("b", "a", "answer", 2), message("c", "b", "continuation", 3)]);

  // The Job recorded a -> b; the continuation entry appended afterwards is on
  // the same path but outside the recorded end.
  assert.deepEqual(store.readHistory({ agentId: "agent_sealed-1", startEntryId: "a", endEntryId: "b" }).map((entry) => entry.id), ["b"]);
  assert.deepEqual(store.readHistory({ agentId: "agent_sealed-1", startEntryId: "b", endEntryId: "c" }).map((entry) => entry.id), ["c"]);
  assert.deepEqual(store.readHistory({ agentId: "agent_sealed-1", startEntryId: "a" }).map((entry) => entry.id), ["b", "c"]);
  assert.deepEqual(store.readHistory({ agentId: "agent_sealed-1" }), [], "a Job without bounds has no slice");
});

test("history bounds that are not on the native branch fail explicitly", (t) => {
  const session = fakeRootSession();
  const { store } = durableStore(t, session);
  const header = { type: "session", version: 3, id: "child", timestamp: "x", cwd: "/work" };
  const message = (id, parentId) => ({
    type: "message",
    id,
    parentId,
    timestamp: "x",
    message: { role: "user", content: id, timestamp: 1 },
  });
  writeActorFile(store, "agent_h-2", [header, message("a", null), message("b", "a")]);

  for (const bounds of [
    { startEntryId: "nope", endEntryId: "b" },
    { startEntryId: "a", endEntryId: "also-nope" },
  ]) {
    assert.throws(
      () => store.readHistory({ agentId: "agent_h-2", ...bounds }),
      (error) => error instanceof SubagentStoreError && error.code === "storage_history_unavailable",
    );
  }
  assert.throws(
    () => store.readHistory({ agentId: "agent_missing", startEntryId: "a", endEntryId: "b" }),
    (error) => error instanceof SubagentStoreError && error.code === "storage_history_unavailable",
  );
});

test("the recorded-turn probe answers for the checkpoint leaf, not later turns", (t) => {
  const session = fakeRootSession();
  const { store } = durableStore(t, session);
  const header = { type: "session", version: 3, id: "child", timestamp: "x", cwd: "/work" };
  const message = (id, parentId, text, timestamp) => ({
    type: "message",
    id,
    parentId,
    timestamp: "x",
    message: { role: "user", content: text, timestamp },
  });
  // The checkpoint recorded leaf "a" (an inherited seed); a later abandoned
  // branch appended the actor's own turn "j1" afterwards.
  writeActorFile(store, "agent_anchor-1", [header, message("a", null, "inherited", 1), message("j1", "a", "assignment", 2)]);

  assert.equal(store.hasRecordedTurn("agent_anchor-1", "a", "a"), false, "the checkpoint leaf holds no own turn");
  assert.equal(store.hasRecordedTurn("agent_anchor-1", "a", null), true, "the current leaf does");
  assert.equal(store.hasRecordedTurn("agent_anchor-1", "nope", "j1"), false, "an off-branch start is not a recorded turn");
  assert.equal(store.hasRecordedTurn("agent_anchor-1", "a", "nope"), false, "an off-branch anchor is not a recorded turn");
});

test("hasRecordedTurn detects the actor's own recorded turn after a boundary", (t) => {
  const session = fakeRootSession();
  const { store } = durableStore(t, session);
  const seed = [
    { type: "session", version: 3, id: "child", timestamp: "x", cwd: "/work" },
    { type: "message", id: "p1", parentId: null, timestamp: "x", message: { role: "user", content: "inherited", timestamp: 1 } },
  ];
  writeActorFile(store, "agent_t-1", seed);

  // The inherited seed's own messages never count for the child's first Job.
  assert.equal(store.hasRecordedTurn("agent_t-1", "p1"), false);
  assert.equal(store.hasRecordedTurn("agent_t-1"), true, "without a boundary the whole branch counts");
  assert.equal(store.hasRecordedTurn("agent_never-1", null), false, "a missing file has no recorded turn");

  // A user message the Job itself appended is what makes the assignment delivered.
  writeActorFile(store, "agent_t-1", [
    ...seed,
    { type: "message", id: "j1", parentId: "p1", timestamp: "x", message: { role: "user", content: "assignment", timestamp: 2 } },
  ]);
  assert.equal(store.hasRecordedTurn("agent_t-1", "p1"), true);
});

test("a memory-only root writes nothing and restores nothing", () => {
  const appends = [];
  const store = createSubagentStore({
    sessionFile: undefined,
    dir: undefined,
    appendEntry: (customType, data) => appends.push({ customType, data }),
    readBranch: () => [],
  });
  assert.equal(store.durable, false);
  assert.equal(store.load(), null);
  assert.equal(store.save({ registry: { version: 1, actors: [], jobs: [] }, actors: {} }), false);
  assert.equal(appends.length, 0);
  assert.equal(store.writeSeedIfMissing("agent_x-1", snapshot("child", 1).entries), null);
  assert.deepEqual(store.readHistory({ agentId: "agent_x-1", startEntryId: "a", endEntryId: "b" }), []);
  assert.equal(store.hasSessionFile("agent_x-1"), false);
});

test("a fresh actor without a native session reports an empty, unscoped history", (t) => {
  const session = fakeRootSession();
  const { store } = durableStore(t, session);
  assert.deepEqual(store.readHistory({ agentId: "agent_new-1" }), []);
  assert.equal(store.hasSessionFile("agent_new-1"), false);
  assert.equal(store.hasRecordedTurn("agent_new-1", null), false);
});

test("a failed checkpoint write is reported as a storage error", (t) => {
  const session = fakeRootSession();
  const { store } = durableStore(t, session, {
    appendEntry: () => {
      throw new Error("disk full");
    },
  });
  assert.throws(
    () => store.save({ registry: { version: 1, actors: [], jobs: [] }, actors: {} }),
    (error) => error instanceof SubagentStoreError && error.code === "storage_write_failed" && /disk full/.test(error.message),
  );
});

test("non-JSON-safe registry state is refused instead of persisted as empty", (t) => {
  const session = fakeRootSession();
  const { store } = durableStore(t, session);
  const cyclic = { version: 1, actors: [], jobs: [] };
  cyclic.self = cyclic;
  assert.throws(
    () => store.save({ registry: cyclic, actors: {} }),
    (error) => error instanceof SubagentStoreError && error.code === "storage_invalid_state",
  );
});
