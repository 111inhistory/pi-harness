import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getAgentSocketPath,
  getBroadcastSocketPath,
  writeSocket,
} from "../../src/ipc/socket.ts";
import { AgentListeners } from "../../src/subagent/listeners.ts";
import {
  createSubagentRuntime,
  SubagentError,
  type BroadcastReceipt,
} from "../../src/subagent/runtime.ts";

const posix = process.platform !== "win32";

async function socketRoot(t: test.TestContext): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-agent-listeners-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function canConnect(address: string): Promise<boolean> {
  const client = net.connect(address);
  try {
    await once(client, "connect");
    return true;
  } catch {
    return false;
  } finally {
    client.destroy();
  }
}

test('endpoint resolution accepts registered addresses and rejects unknown addresses uniformly', async () => {
  const root = path.join(os.tmpdir(), 'pi-listener-registry-fixture');
  const listeners = new AgentListeners({
    sessionId: 'test-session',
    socketDir: root, baseSocketDir: root, maxDepth: 2,
    actors: () => [{ agentId: 'sub_01', parentAgentId: null, depth: 1 }],
    isAccepting: () => true,
    send: async command => ({ ok: true, to: command.to, jobId: null }),
    onError: error => { throw error; },
  });
  assert.deepEqual(await listeners.resolve(getAgentSocketPath('sub_01', root)), {
    isManaged: true, isBroadcast: false, targetId: 'sub_01',
  });
  assert.deepEqual(await listeners.resolve(getBroadcastSocketPath('sub_01', root)), {
    isManaged: true, isBroadcast: true, parentId: 'sub_01',
  });
  for (const address of [getAgentSocketPath('ghost', root), getAgentSocketPath('ghost', path.dirname(root))]) {
    assert.deepEqual(await listeners.resolve(address), { isManaged: false });
  }
});

test("all registered stopped actor endpoints stay reachable beyond the display window", { skip: !posix, timeout: 15000 }, async (t) => {
  const root = await socketRoot(t);
  const runtime = createSubagentRuntime({
    startJob: () => ({ done: Promise.resolve({ result: "done", messages: [] }), cancel() {} }),
  });
  const created: Array<{ id: string }> = [];
  for (const batchSize of [4, 2]) {
    const batch = runtime.create({
      tasks: Array.from({ length: batchSize }, (_, index) => ({ task: `stopped actor ${created.length + index}` })),
    }).items as Array<{ id: string }>;
    created.push(...batch);
    for (const item of batch) await runtime.jobDone(item.id);
  }
  assert.equal(created.length, 6);

  const actors = runtime.list().agents;
  assert.equal(actors.length, 6);
  assert.ok(actors.every((actor) => actor.status === "idle"), "all registered actors are stopped (idle with no live Job)");

  const sends: unknown[] = [];
  const errors: Error[] = [];
  const listeners = new AgentListeners({
    sessionId: 'test-session',
    socketDir: root,
    baseSocketDir: root,
    maxDepth: 2,
    actors: () => runtime.list().agents,
    isAccepting: () => true,
    send: async (command) => {
      sends.push(command);
      return { ok: true, to: command.to, jobId: null };
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  t.after(() => listeners.close());
  await listeners.sync();

  const addresses = [
    getAgentSocketPath("Main", root),
    ...actors.map((actor) => getAgentSocketPath(actor.agentId, root)),
    getBroadcastSocketPath("Main", root),
    ...actors.map((actor) => getBroadcastSocketPath(actor.agentId, root)),
  ];
  assert.equal(new Set(addresses).size, addresses.length);
  for (const address of addresses) {
    assert.equal(await canConnect(address), true, `listener must be reachable: ${address}`);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(sends, [], "reachability alone does not deliver a domain message");
});

test("missing or invalid senders are rejected with onError and never reach runtime send", { skip: !posix }, async (t) => {
  const root = await socketRoot(t);
  const sends: unknown[] = [];
  const errors: Error[] = [];
  const listeners = new AgentListeners({
    sessionId: 'test-session',
    socketDir: root,
    baseSocketDir: root,
    maxDepth: 2,
    actors: () => [{ agentId: "sub_01", parentAgentId: null, depth: 1 }],
    isAccepting: () => true,
    send: async (command) => {
      sends.push(command);
      return { ok: true, to: command.to, jobId: null };
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  t.after(() => listeners.close());
  await listeners.sync();

  const frames = [
    JSON.stringify({ content: "missing sender" }),
    JSON.stringify({ from: "   ", content: "blank sender" }),
    JSON.stringify({ from: "not-an-actor", content: "invalid sender" }),
  ].join("\n") + "\n";
  await assert.rejects(writeSocket(getAgentSocketPath("sub_01", root), frames), { code: 'invalid_message' });
  await waitFor(() => errors.length === 3, "invalid sender reports");

  assert.deepEqual(errors.map((error) => errorCode(error)), [
    "invalid_message",
    "invalid_message",
    "unknown_sender",
  ]);
  assert.equal(sends.length, 0, "no invalid frame may reach the runtime send port");
});

test("one broadcast frame invokes the domain broadcast once and reports partial errors", { skip: !posix }, async (t) => {
  const root = await socketRoot(t);
  const receipt: BroadcastReceipt = {
    ok: false,
    to: "all",
    sent: [{ to: "sub_01", jobId: "sub_01" }],
    errors: [{ to: "sub_02", code: "agent_busy", message: "Agent sub_02 is stopping." }],
  };
  const sends: Array<{ from: string; to: string; content: string }> = [];
  const errors: Error[] = [];
  const listeners = new AgentListeners({
    sessionId: 'test-session',
    socketDir: root,
    baseSocketDir: root,
    maxDepth: 2,
    actors: () => [],
    isAccepting: () => true,
    send: async (command) => {
      sends.push(command);
      return receipt;
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  t.after(() => listeners.close());
  await listeners.sync();

  await assert.rejects(writeSocket(
    getBroadcastSocketPath("Main", root),
    JSON.stringify({ from: "Main", content: "family status" }),
  ), { code: 'broadcast_partial_failure' });
  await waitFor(() => sends.length === 1 && errors.length === 1, "broadcast receipt");

  assert.deepEqual(sends, [{ from: "Main", to: "all", content: "family status" }]);
  const failure = errors[0];
  assert.ok(failure instanceof SubagentError, "partial failure is reported as a typed domain error");
  assert.equal(failure.code, "broadcast_partial_failure");
  assert.deepEqual(failure.detail.errors, receipt.errors);
});

test("close rejects new traffic and releases every registered socket", { skip: !posix }, async (t) => {
  const root = await socketRoot(t);
  const listeners = new AgentListeners({
    sessionId: 'test-session',
    socketDir: root,
    baseSocketDir: root,
    maxDepth: 2,
    actors: () => [],
    isAccepting: () => true,
    send: async (command) => ({ ok: true, to: command.to, jobId: null }),
    onError: () => {},
  });
  t.after(() => listeners.close());
  await listeners.sync();

  const agent = getAgentSocketPath("Main", root);
  const broadcast = getBroadcastSocketPath("Main", root);
  assert.equal((await fsp.stat(agent)).isSocket(), true);
  assert.equal((await fsp.stat(broadcast)).isSocket(), true);

  await listeners.close();
  for (const address of [agent, broadcast]) {
    await assert.rejects(fsp.stat(address), { code: "ENOENT" });
    await assert.rejects(
      writeSocket(address, { from: "Main", content: "after close" }),
      (error: unknown) => ["ENOENT", "ECONNREFUSED"].includes(errorCode(error) ?? ""),
    );
  }
  await assert.rejects(
    listeners.sync(),
    (error: unknown) => error instanceof SubagentError && error.code === "runtime_closed",
  );
});
