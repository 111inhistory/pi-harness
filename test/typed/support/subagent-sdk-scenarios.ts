/**
 * Changed real-SDK Subagent scenarios.
 *
 * These bodies replace fixture logic that observed host-owned socket writes:
 * Runtime owns managed delivery. The public tool uses the native write result;
 * scenarios verify delivery in the peer's actual native transcript.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { getAgentSocketPath } from "../../../src/ipc/socket.ts";
import {
  abortableGate,
  assertEndpointReachable,
  deliverToActor,
  detailsOf,
  isSubagentError,
  lastToolResult,
  assertMessageSuccessFromMessage,
  occurrences,
  readTranscriptEvents,
  createdItems,
  createdItemsFromMessage,
  listedActors,
  waitForCondition,
} from "./subagent-sdk-fixture.ts";
import type { FixtureActor, ScenarioFixture } from "./subagent-sdk-fixture.ts";

/**
 * Every registered Actor keeps a live endpoint, independent of the visible
 * list window. Reachability is checked with real clients, never by counting
 * process handles or hardcoding a listener total.
 */
export async function runListenerCacheScenario(fixture: ScenarioFixture): Promise<void> {
  fixture.controls.chat = async (request) => {
    if (request.text.includes("CACHE_PARENT")) {
      const created = lastToolResult(request.context.messages, "subagent_create");
      if (created === undefined) {
        return fixture.toolAnswer("subagent_create", {
          tasks: [1, 2, 3, 4].map(() => ({ task: "CACHE_CHILD complete promptly" })),
        });
      }
      const children = createdItemsFromMessage(created);
      await Promise.all(children.map((child) => fixture.stopped(child.id)));
    }
    return fixture.textAnswer("Cache actor complete");
  };
  const parent = await fixture.create("CACHE_PARENT create four children and finish");
  await fixture.stopped(parent.id);
  for (let index = 0; index < 11; index += 1) {
    await fixture.stopped((await fixture.create("Cache history entry")).id);
  }
  const registered = (await listedActors(await fixture.call("subagent_list", { all: true }))).filter(
    (actor) => actor.id !== "Main",
  );
  assert.equal(registered.length, 16, "every created Actor stays registered");
  for (const actor of registered) await assertEndpointReachable(actor.socket);
  const before = fixture.chats.length;
  await deliverToActor(fixture, parent, "Resume historical parent");
  await waitForCondition(() => fixture.chats.length > before, "historical parent revival");
  await fixture.stopped(parent.id);
  if (process.platform !== "win32") {
    await assert.rejects(
      fixture.call("msg_write", { path: path.join(fixture.sessionSocketDir, "ghost.sock"), content: '{"content":"unknown"}' }),
      (error: unknown) => isSubagentError(error, "unmanaged_endpoint"),
    );
  }
  await fixture.session.reload();
  const restored = (await listedActors(await fixture.call("subagent_list", { all: true }))).filter(
    (actor) => actor.id !== "Main",
  );
  assert.equal(restored.length, 16, "a durable reload restores every registered Actor, not only the visible window");
  for (const actor of restored) await assertEndpointReachable(actor.socket);
  const child = restored.find((actor) => actor.id === `${parent.id}_01`);
  assert.ok(child, "the restored depth-2 child remains registered");
  const childBefore = fixture.chats.length;
  await deliverToActor(fixture, child, "Resume restored depth-2 child");
  await waitForCondition(() => fixture.chats.length > childBefore, "restored depth-2 child revival");
  await fixture.stopped(child.id);
}

/**
 * A managed write to an endpoint this runtime does not own is refused before
 * any connection is opened. The raw wire is exercised by a genuine external
 * client, explicitly distinct from the host write.
 */
export async function runExternalSocketScenario(fixture: ScenarioFixture): Promise<void> {
  const exit = fixture.gate();
  fixture.controls.chat = async (request) => {
    await exit.promise;
    if (request.options.signal?.aborted === true) throw new Error("cancelled local request");
    return fixture.textAnswer("native actor output");
  };
  const actor = await fixture.create("Actor with a same-named external socket");
  await waitForCondition(() => fixture.chats.length === 1, "native actor request");
  await fixture.call("subagent_stop", { id: actor.id });
  assert.equal((await fixture.item(actor.id))?.status, "stopping");
  const dir = path.join(fixture.cwd, "external");
  await fsp.mkdir(dir);
  // Same basename as a stopping Agent, but NOT one of the registered endpoints.
  const externalPath = getAgentSocketPath(actor.id, dir);
  const frames: string[] = [];
  const connections: net.Socket[] = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    let buffer = "";
    socket.on("error", () => {}); // A writer is allowed to close without reading our reply.
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.endsWith("\n")) {
        frames.push(buffer);
        socket.end('{"external_reply":"not an Agent result"}\n');
      }
    });
  });
  const listening = once(server, "listening");
  server.listen(externalPath);
  await listening;
  try {
    const payload = '{"from":"external-client","content":"Own protocol payload","sequence":7}';
    await assert.rejects(
      fixture.call("msg_write", { path: externalPath, content: payload }),
      (error: unknown) => isSubagentError(error, "unmanaged_endpoint"),
    );
    assert.equal(connections.length, 0, "the host must not connect to an unmanaged endpoint");
    assert.deepEqual(frames, [], "the host must not write a raw payload to an unmanaged endpoint");
    await writeExternalFrame(externalPath, payload);
    await waitForCondition(() => frames.length === 1, "external client frame");
    assert.deepEqual(frames, [payload + "\n"], "the external client owns its payload without Subagent framing");
    assert.equal(connections.length, 1, "only the genuine external client connects");
    assert.equal(
      (await listedActors(await fixture.call("subagent_list", { all: true }))).length,
      2,
      "only Main and the existing actor are listed",
    );
    assert.equal((await fixture.item(actor.id))?.status, "stopping", "an external socket must not revive a same-named actor");
    assert.equal(fixture.chats.length, 1);
    assert.equal(
      fixture.sessionManager.getBranch().filter((entry) => entry.type === "custom_message").length,
      0,
      "external responses must not become Agent messages",
    );
  } finally {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  exit.resolve();
  await fixture.stopped(actor.id);
}

async function writeExternalFrame(address: string, payload: string): Promise<void> {
  const socket = net.connect(address);
  socket.on("error", () => {});
  await once(socket, "connect");
  await new Promise<void>((resolve) => {
    socket.end(payload + "\n", "utf8", resolve);
  });
  socket.destroy();
}

/**
 * A child model's `msg_write` to a peer endpoint must produce a message
 * success result, and the peer's actual provider request must keep
 * the host-attributed child sender.
 */
export async function runPeerSenderScenario(fixture: ScenarioFixture): Promise<void> {
  const routing = fixture.gate();
  const receiverExit = fixture.gate();
  let sender: FixtureActor | undefined;
  let receiver: FixtureActor | undefined;
  let peerWriteCompleted = false;
  fixture.controls.classify = (_context, options) => abortableGate(routing, options?.signal);
  fixture.controls.chat = async (request) => {
    if (receiver === undefined) throw new Error("the peer receiver must exist before any model call");
    if (request.text.includes("SOCKET_SENDER_ACTOR")) {
      const writeResult = lastToolResult(request.context.messages, "msg_write");
      if (writeResult === undefined) {
        return fixture.toolAnswer("msg_write", { path: receiver.socket, content: "PEER_SOURCE_MARKER" }, "peer-write");
      }
      assertMessageSuccessFromMessage(writeResult);
      peerWriteCompleted = true;
      return fixture.textAnswer("actor done");
    }
    if (request.text.includes("SOCKET_RECEIVER_ACTOR")) await receiverExit.promise;
    return fixture.textAnswer("actor done");
  };
  const creation = fixture.call("subagent_create", {
      tasks: [
        { task: "SOCKET_SENDER_ACTOR send to peer" },
        { task: "SOCKET_RECEIVER_ACTOR receive from peer" },
      ],
    });
  await waitForCondition(() => fixture.classifications.length > 0, "creation waits for routing");
  const registered = listedActors(await fixture.call("subagent_list", { all: true })).filter((actor) => actor.id !== "Main");
  sender = registered[0];
  receiver = registered[1];
  assert.ok(sender, "the sender Actor must be created");
  assert.ok(receiver, "the receiver Actor must be created");
  routing.resolve();
  const created = createdItems(await creation);
  assert.deepEqual(created.map((actor) => actor.id), [sender.id, receiver.id]);
  await waitForCondition(() => peerWriteCompleted, "native peer write completion");
  receiverExit.resolve();
  await Promise.all([fixture.stopped(sender.id), fixture.stopped(receiver.id)]);
  const receiverRequests = fixture.chats.filter((request) => request.text.includes("SOCKET_RECEIVER_ACTOR"));
  const receiverRequest = receiverRequests.at(-1);
  assert.ok(receiverRequest, "the receiver must dispatch a native request");
  const text = receiverRequest.text;
  assert.match(text, /PEER_SOURCE_MARKER/);
  assert.equal(text.includes("[Message from Main]"), false, "the listener must not relabel a child sender as Main");
  assert.equal(
    occurrences(text, `[Message from ${sender.id}]`),
    1,
    "the host frames the actual native write owner exactly once",
  );
}

/**
 * A busy Subagent parent receives peer progress as a native steer and the
 * terminal notice as its own delivery. Progress and terminal stay independent,
 * each exactly once, and the provider plus native transcript observe both.
 */
export async function runUpstreamParentSteerScenario(fixture: ScenarioFixture): Promise<void> {
  const send = fixture.gate();
  const parentWaiting = fixture.gate();
  const parentExit = fixture.gate();
  let parent: FixtureActor | undefined;
  let progressWriteCompleted = false;
  let parentRequests = 0;
  let progressSeen = false;
  let terminalSeen = false;
  const parentOwner = (): FixtureActor => {
    if (parent === undefined) throw new Error("the parent Actor must exist before its model call");
    return parent;
  };
  fixture.controls.chat = async (request) => {
    if (request.text.includes("PARENT_MERGE_LEAF")) {
      const wrote = lastToolResult(request.context.messages, "msg_write");
      if (wrote === undefined) {
        await send.promise;
        return fixture.toolAnswer("msg_write", { path: parentOwner().socket, content: "PARENT_MERGE_PROGRESS" }, "parent-merge-write");
      }
      assertMessageSuccessFromMessage(wrote);
      progressWriteCompleted = true;
      return fixture.textAnswer("Leaf completed");
    }
    assert.ok(request.text.includes("PARENT_MERGE_OWNER"));
    parentRequests += 1;
    const created = request.context.messages.some(
      (message) => message.role === "toolResult" && message.toolName === "subagent_create",
    );
    if (!created) {
      return fixture.toolAnswer("subagent_create", {
        tasks: [{ task: "PARENT_MERGE_LEAF: send progress to your direct parent" }],
      }, "parent-merge-create");
    }
    if (!request.text.includes("PARENT_MERGE_PROGRESS")) {
      parentWaiting.resolve();
      await parentExit.promise;
      return fixture.textAnswer("Parent finishes its held model turn");
    }
    // Pi may consume the separate messages together or on successive turns.
    // The plugin never rewrites the ordinary message with the terminal.
    const deliveries = request.context.messages.filter(
      (message) => message.role !== "system" && JSON.stringify(message.content).includes("PARENT_MERGE_PROGRESS"),
    );
    assert.equal(deliveries.length, 1, "the busy parent observes peer progress exactly once");
    assert.doesNotMatch(JSON.stringify(deliveries[0]?.content ?? ""), /\[Subagent .* completed/);
    progressSeen = true;
    terminalSeen = request.text.includes(`[Subagent ${parentOwner().id}_01 completed`);
    return fixture.textAnswer("Parent received independent progress and terminal events");
  };
  parent = await fixture.create("PARENT_MERGE_OWNER: delegate one leaf and consume its result");
  await parentWaiting.promise;
  const leaf = listedActors(await fixture.call("subagent_list", { all: true })).find(
    (entry) => entry.id !== "Main" && entry.id !== parentOwner().id,
  );
  assert.ok(leaf, "the parent must have created exactly one leaf");
  send.resolve();
  await waitForCondition(() => progressWriteCompleted, "leaf progress write completion");
  await fixture.stopped(leaf.id);
  parentExit.resolve();
  await waitForCondition(() => progressSeen && terminalSeen, "busy Subagent parent consumes both independent events");
  await fixture.stopped(parent.id);
  await fixture.session.waitForIdle();
  assert.ok(parentRequests === 3 || parentRequests === 4, "Pi chooses whether separate queued messages need one or two turns");
  assert.equal(fixture.classifications.length, 4, "the terminal notice does not route another parent assignment");
  const history = (await fixture.stopped(parent.id)).history;
  assert.ok(history);
  const stored = await readTranscriptEvents(history.cleanJsonl);
  const progress = stored.filter(
    (event) => event.role === 'custom' && event.customType === 'agent-delivery' &&
      detailsOf(event.details).source === 'agent' && JSON.stringify(event.content ?? '').includes('PARENT_MERGE_PROGRESS'),
  );
  assert.equal(progress.length, 1, 'the peer steer remains one independent native event');
  assert.match(JSON.stringify(progress[0]?.content ?? ''), new RegExp(`\\[Message from ${leaf.id}\\]`));
  assert.equal(detailsOf(progress[0]?.details).sourceId, leaf.id);
  assert.equal(detailsOf(progress[0]?.details).round, 1);
  assert.equal(detailsOf(progress[0]?.details).jobId, leaf.id);
  assert.equal(stored.filter((event) => event.role === 'user' && JSON.stringify(event.content ?? '').includes('PARENT_MERGE_PROGRESS')).length,
    0, 'peer bodies must not be concatenated into a control/user prompt');
  const terminals = stored.filter(
    (event) =>
      event.role === "custom" &&
      event.customType === "agent-delivery" &&
      detailsOf(event.details).source === "host" &&
      detailsOf(event.details).sourceId === leaf.id,
  );
  assert.equal(terminals.length, 1, "the terminal notice is stored exactly once");
  const terminal = terminals[0];
  assert.ok(terminal);
  assert.equal(detailsOf(terminal.details).status, "completed");
  assert.equal(
    JSON.stringify(terminal.content ?? "").includes("PARENT_MERGE_PROGRESS"),
    false,
    "the terminal notice never absorbs the earlier progress",
  );
}

/** Corrupt restored ownership must fail closed as an invalid runtime state. */
export async function runRestoreInvalidScenario(fixture: ScenarioFixture): Promise<void> {
  fixture.sessionManager.appendCustomEntry("subagent-job", {
    v: 2,
    jobId: "sub_99",
    agentId: "sub_99",
    actor: { name: "corrupt", parentAgentId: null, depth: 1 },
    createdBy: "unknown-sender",
    spec: { task: "Must not execute" },
    continuedFromJobId: null,
  });
  await fixture.session.reload();
  await assert.rejects(
    fixture.call("subagent_list", {}),
    (error: unknown) => isSubagentError(error, "invalid_state"),
  );
  const recovery = fixture.sessionManager.getBranch().filter((entry) => {
    if (entry.type !== "custom" || entry.customType !== "subagent-job-end") return false;
    const data = entry.data;
    return typeof data === "object" && data !== null && !Array.isArray(data) && "jobId" in data && data.jobId === "sub_99";
  });
  assert.equal(recovery.length, 0, "a rejected registry must not append recovery events");
  assert.equal(fixture.chats.length, 0);
  assert.equal(fixture.classifications.length, 0);
}
