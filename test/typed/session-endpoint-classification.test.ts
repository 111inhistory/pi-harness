/**
 * `RootService.resolveTarget`: the one logical classification `msg_write` uses.
 *
 * An address belongs to this session (Runtime owns actor/batch/children
 * routing), to another live session's Main, to another session outside its
 * Main, or to no live session. There is no filesystem namespace check: the
 * logical address is the only identity, so a path-shaped string is never local.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const SOCKET_ROOT = path.join(tmpdir(), `pi-resolve-target-${process.pid}-${Math.random().toString(16).slice(2, 10)}`);
process.env["PI_SUBAGENT_SOCKET_DIR"] = SOCKET_ROOT;

async function loadHarness() {
  const [root, directory, address] = await Promise.all([
    import("../../src/subagent/root-service.ts"),
    import("../../src/subagent/session-directory.ts"),
    import("../../src/subagent/address.ts"),
  ]);
  return { ...root, ...directory, ...address };
}

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-resolve-target-cwd-"));
  const harness = await loadHarness();
  const api = {
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools() {},
    appendEntry() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const context = {
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    modelRegistry: { find: () => undefined },
    isIdle: () => true,
  } as unknown as ExtensionContext;
  const service = new harness.RootService({
    api, context, agentDir: path.join(cwd, "agent"), allocatedIds: new Set(), ownsContext: () => true,
  });
  await service.initialize();
  t.after(async () => {
    await service.retire();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, harness, service };
}

test("resolveTarget separates this session, a peer Main, a peer non-Main and an unknown session", async t => {
  const { cwd, harness, service } = await fixture(t);
  const peer = await harness.registerSession(SOCKET_ROOT, { sessionId: "peer-session", cwd, name: "peer work" });
  t.after(() => harness.unregisterSession(SOCKET_ROOT, peer.sessionId));
  t.after(() => rm(SOCKET_ROOT, { recursive: true, force: true }));

  const own = (await service.listSessions()).find(session => session.sessionId === service.sessionId);
  assert.ok(own, "this root publishes itself");

  for (const address of [
    harness.formatAddress(own.uid, harness.MAIN_ACTOR),
    harness.formatAddress(own.uid, "sub_2"),
    harness.formatAddress(own.uid, "sub_2-1"),
    harness.formatAddress(own.uid, "sub_2-1/children"),
    harness.formatChildrenAddress(own.uid, harness.MAIN_ACTOR),
    harness.formatGroupAddress(own.uid, 2),
  ]) {
    assert.deepEqual(await service.resolveTarget(address), { kind: "local" }, `this session owns ${address}`);
  }

  assert.deepEqual(await service.resolveTarget(harness.formatAddress(peer.uid, harness.MAIN_ACTOR)),
    { kind: "session", session: peer });
  for (const address of [
    harness.formatAddress(peer.uid, "sub_1"),
    harness.formatGroupAddress(peer.uid, 3),
    harness.formatChildrenAddress(peer.uid, "sub_1"),
  ]) {
    assert.deepEqual(await service.resolveTarget(address), { kind: "foreign" },
      `another session is reachable only at its Main: ${address}`);
  }

  assert.deepEqual(await service.resolveTarget("ffffffff:main"), { kind: "unknown" });
  for (const address of ["main", "sub_2", "/tmp/project/main.sock", "not-an-address", ""]) {
    assert.deepEqual(await service.resolveTarget(address), { kind: "foreign" },
      `a non-address is never local traffic: ${address}`);
  }
});
