/**
 * Cross-session directory: publication, liveness, ownership, and the managed
 * Main endpoint as the one cross-session address.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  liveSessions,
  parseSessionSenderId,
  registerSession,
  SESSION_DIRECTORY,
  sessionByUid,
  sessionMainAddress,
  sessionSenderId,
  unregisterSession,
  updateSessionName,
} from "../../src/subagent/session-directory.ts";
import { deriveSessionUid, getAgentSocketPath } from "../../src/ipc/socket.ts";

async function root(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-session-directory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a published session is readable by uid and publishes its Main endpoint", async (t) => {
  const socketRoot = await root(t);
  const session = await registerSession(socketRoot, {
    sessionId: "session-alpha", cwd: "/tmp/project", name: "parser work",
  });
  assert.equal(session.uid, deriveSessionUid("session-alpha"));
  assert.equal(session.socketDir, path.join(socketRoot, session.uid));
  assert.equal(session.pid, process.pid);
  assert.equal(session.name, "parser work");
  assert.equal(sessionMainAddress(session), getAgentSocketPath("Main", session.socketDir));

  const live = await liveSessions(socketRoot);
  assert.deepEqual(live.map((entry) => entry.sessionId), ["session-alpha"]);
  assert.equal((await sessionByUid(socketRoot, session.uid))?.sessionId, "session-alpha");
  assert.equal(await sessionByUid(socketRoot, "../escape"), null);
});

test("the wire identity is the stable session uid followed by Main", () => {
  const uid = deriveSessionUid("session-alpha");
  assert.match(uid, /^[0-9a-f]{8}$/, "one uid rule on every platform, not a per-platform fold");
  const sender = sessionSenderId(uid);
  assert.equal(sender, `${uid}:Main`);
  assert.deepEqual(parseSessionSenderId(sender), { uid });
  assert.deepEqual(parseSessionSenderId("deadbeef:Main"), { uid: "deadbeef" });
  assert.equal(parseSessionSenderId("DEADBEEF:Main"), null, "the uid is lowercase only");
  assert.equal(parseSessionSenderId("abc123:Main"), null, "no legacy short uid format");
  assert.equal(parseSessionSenderId("deadbee:Main"), null, "a uid is exactly eight hex digits");
  assert.equal(parseSessionSenderId("deadbeeg:Main"), null, "a uid contains hex digits only");
  assert.equal(parseSessionSenderId(`${uid}:sub_01`), null, "a subagent is not a cross-session identity");
  assert.equal(parseSessionSenderId("Main"), null, "a local actor id is not a session identity");
  assert.equal(parseSessionSenderId(`${uid}:`), null);
  assert.equal(parseSessionSenderId(`:Main`), null);
});

test("a record's socket directory is compared with native path identity", async (t) => {
  const socketRoot = await root(t);
  const session = await registerSession(socketRoot, { sessionId: "session-alpha", cwd: "/tmp/project" });
  const recordPath = path.join(socketRoot, SESSION_DIRECTORY, `${session.uid}.json`);
  const valid = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
  const recorded = String(valid['socketDir']);
  // A spelling that always differs, so the comparison is actually exercised.
  const respelled = recorded === recorded.toLowerCase() ? recorded.toUpperCase() : recorded.toLowerCase();
  assert.notEqual(respelled, recorded);

  await writeFile(recordPath, `${JSON.stringify({ ...valid, socketDir: respelled })}\n`);
  const windows = process.platform === "win32";
  assert.equal((await liveSessions(socketRoot)).length, windows ? 1 : 0,
    windows ? "Windows compares the recorded directory case-insensitively" : "POSIX keeps the recorded directory case-sensitive");
});

test("a session removes only its own record", async (t) => {
  const socketRoot = await root(t);
  const session = await registerSession(socketRoot, { sessionId: "session-alpha", cwd: "/tmp/project" });

  // A record that no longer names this session is left in place.
  const recordPath = path.join(socketRoot, SESSION_DIRECTORY, `${session.uid}.json`);
  const foreign = { ...JSON.parse(await readFile(recordPath, "utf8")), sessionId: "session-other" };
  await writeFile(recordPath, `${JSON.stringify(foreign)}\n`);
  assert.equal(await unregisterSession(socketRoot, "session-alpha"), false);
  assert.equal((await liveSessions(socketRoot)).length, 1);

  await registerSession(socketRoot, { sessionId: "session-alpha", cwd: "/tmp/project" });
  assert.equal(await unregisterSession(socketRoot, "session-alpha"), true);
  assert.deepEqual(await liveSessions(socketRoot), []);
  assert.equal(await unregisterSession(socketRoot, "session-alpha"), false);
});

test("dead and malformed records are never reported as live sessions", async (t) => {
  const socketRoot = await root(t);
  const session = await registerSession(socketRoot, { sessionId: "session-alpha", cwd: "/tmp/project" });
  const directory = path.join(socketRoot, SESSION_DIRECTORY);
  const recordPath = path.join(directory, `${session.uid}.json`);
  const valid = JSON.parse(await readFile(recordPath, "utf8"));

  // A dead pid keeps the record on disk but out of the live set.
  await writeFile(recordPath, `${JSON.stringify({ ...valid, pid: 2147483646 })}\n`);
  assert.deepEqual(await liveSessions(socketRoot), []);

  const malformed = [
    { ...valid, version: 99 },
    { ...valid, uid: "00000000" },
    { ...valid, socketDir: "/tmp/elsewhere" },
    { ...valid, sessionId: "" },
    { ...valid, name: 42 },
    { ...valid, startedAt: "yesterday" },
    "not an object",
  ];
  for (const entry of malformed) {
    await writeFile(recordPath, `${JSON.stringify(entry)}\n`);
    assert.deepEqual(await liveSessions(socketRoot), [], `record must be rejected: ${JSON.stringify(entry)}`);
  }
  await writeFile(path.join(directory, "broken.json"), "{not json");
  assert.deepEqual(await liveSessions(socketRoot), []);
  assert.equal((await readdir(directory)).includes("broken.json"), true);
});

test("a session can rename only its own published record", async (t) => {
  const socketRoot = await root(t);
  await registerSession(socketRoot, { sessionId: "session-alpha", cwd: "/tmp/project" });
  const renamed = await updateSessionName(socketRoot, { sessionId: "session-alpha", name: "renamed worker" });
  assert.equal(renamed?.name, "renamed worker");
  assert.equal((await liveSessions(socketRoot))[0]?.name, "renamed worker");

  assert.equal(await updateSessionName(socketRoot, { sessionId: "session-other", name: "hijack" }), null);
  assert.equal((await liveSessions(socketRoot))[0]?.name, "renamed worker", "a foreign session cannot rewrite the record");

  await updateSessionName(socketRoot, { sessionId: "session-alpha", name: null });
  assert.equal((await liveSessions(socketRoot))[0]?.name, null, "clearing the native name clears the record");
});

test("a session publishes its native name; no coordination state is stored", async (t) => {
  const socketRoot = await root(t);
  const unnamed = await registerSession(socketRoot, { sessionId: "session-alpha", cwd: "/tmp/project" });
  assert.equal(unnamed.name, null);
  const named = await registerSession(socketRoot, { sessionId: "session-beta", cwd: "/tmp/project", name: "migrating the parser" });
  assert.equal(named.name, "migrating the parser");
  const names = new Map((await liveSessions(socketRoot)).map((entry) => [entry.sessionId, entry.name]));
  assert.deepEqual([...names.entries()].sort(), [
    ["session-alpha", null],
    ["session-beta", "migrating the parser"],
  ]);
});

test("a missing sessions directory returns an empty list without error", async (t) => {
  const socketRoot = await root(t);
  assert.deepEqual(await liveSessions(socketRoot), []);
});

test("a non-directory sessions path propagates as a directory read error", async (t) => {
  const socketRoot = await root(t);
  await writeFile(path.join(socketRoot, SESSION_DIRECTORY), "obstruction");
  await assert.rejects(liveSessions(socketRoot), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR");
  await assert.rejects(sessionByUid(socketRoot, "00000000"), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR");
});

