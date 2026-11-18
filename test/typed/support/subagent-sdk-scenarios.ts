/**
 * Real-SDK Subagent scenarios.
 *
 * Runtime owns managed delivery. Scenarios verify the native tool result and the
 * peer's actual native transcript instead of socket writes. One root owns one
 * `main.sock`; Actors are reached by logical address, and a terminal Job is an
 * internal wake rather than a synthetic parent result.
 */

import assert from "node:assert/strict";
import path from "node:path";

import { formatMainEndpointPath } from "../../../src/subagent/address.ts";
import {
  abortableGate,
  assertEndpointReachable,
  assertMessageSuccessFromMessage,
  createdItems,
  createdItemsFromMessage,
  deliverToActor,
  isStoppingRefusal,
  isSubagentError,
  lastToolResult,
  listedActors,
  occurrences,
  waitForCondition,
} from "./subagent-sdk-fixture.ts";
import type { FixtureActor, ScenarioFixture } from "./subagent-sdk-fixture.ts";

/** Every registered Actor stays reachable through the one root endpoint. */
export async function runListenerCacheScenario(fixture: ScenarioFixture): Promise<void> {
  fixture.controls.chat = async (request) => {
    if (request.text.includes("CACHE_PARENT")) {
      const created = lastToolResult(request.context.messages, "subagent_create");
      if (created === undefined) {
        return fixture.toolAnswer("subagent_create", {
          agents: [1, 2, 3, 4].map(() => ({ goal: "CACHE_CHILD complete promptly" })),
        });
      }
      const children = createdItemsFromMessage(created);
      await Promise.all(children.map((child) => fixture.settled(child.id)));
    }
    return fixture.textAnswer("Cache actor complete");
  };
  const parent = await fixture.create("CACHE_PARENT create four children and finish");
  await fixture.settled(parent.id);
  for (let index = 0; index < 11; index += 1) {
    await fixture.settled((await fixture.create("Cache history entry")).id);
  }
  const mainAddress = formatMainEndpointPath(fixture.sessionSocketDir);
  await assertEndpointReachable(mainAddress);
  const registered = (await listedActors(await fixture.call("subagent_list", { all: true }))).filter(
    (actor) => actor.id !== "main",
  );
  assert.equal(registered.length, 16, "every created Actor stays registered");
  assert.ok(registered.every((actor) => actor.address.endsWith(`:${actor.id}`)), "each address carries its Actor key");
  const before = fixture.chats.length;
  await deliverToActor(fixture, parent, "Resume historical parent");
  await waitForCondition(() => fixture.chats.length > before, "historical parent revival");
  await fixture.settled(parent.id);
  const session = parent.address.slice(0, parent.address.indexOf(":"));
  await assert.rejects(
    fixture.call("msg_write", { to: `${session}:sub_99`, content: "unknown" }),
    (error: unknown) => isSubagentError(error, "unknown_agent"),
  );
  await fixture.session.reload();
  const restored = (await listedActors(await fixture.call("subagent_list", { all: true }))).filter(
    (actor) => actor.id !== "main",
  );
  assert.equal(restored.length, 16, "a durable reload restores every registered Actor, not only the visible window");
  await assertEndpointReachable(mainAddress);
  assert.deepEqual(
    (await listedActors(await fixture.call("subagent_list", { all: true }))).map((actor) => actor.id).filter((id) => id !== "main").length,
    16,
    "the list window never drops a registered Actor",
  );
  const child = restored.find((actor) => actor.id.startsWith("sub_2-"));
  assert.ok(child, "the restored depth-2 child remains registered");
  const childBefore = fixture.chats.length;
  await deliverToActor(fixture, child, "Resume restored depth-2 child");
  await waitForCondition(() => fixture.chats.length > childBefore, "restored depth-2 child revival");
  await fixture.settled(child.id);
}

/**
 * Managed writes accept logical addresses only: an unknown target is refused
 * before delivery, and a stopping Actor is not revived by a same-named path.
 */
export async function runExternalSocketScenario(fixture: ScenarioFixture): Promise<void> {
  const exit = fixture.gate();
  fixture.controls.chat = async (request) => {
    await exit.promise;
    if (request.options.signal?.aborted === true) throw new Error("cancelled local request");
    return fixture.textAnswer("native actor output");
  };
  const actor = await fixture.create("Actor with a same-named external path");
  await waitForCondition(() => fixture.chats.length === 1, "native actor request");
  const stopped = await fixture.call("subagent_signal", { target: actor.address, action: "stop" });
  assert.notEqual(stopped.isError, true, JSON.stringify(stopped.content));
  assert.equal((stopped.details as { targets: Array<{ status: string }> }).targets[0]?.status, "stopping");
  await assert.rejects(
    fixture.call("msg_write", { to: actor.address, content: "while stopping" }),
    (error: unknown) => isStoppingRefusal(actor.id, error),
  );
  // A filesystem path is no longer an address and must be refused before any
  // host code resolves or connects to it.
  await assert.rejects(
    fixture.call("msg_write", { to: path.join(fixture.sessionSocketDir, "ghost.sock"), content: "unmanaged" }),
    (error: unknown) => isSubagentError(error, "invalid_target"),
  );
  const session = actor.address.slice(0, actor.address.indexOf(":"));
  await assert.rejects(
    fixture.call("msg_write", { to: `${session}:sub_98`, content: "unknown" }),
    (error: unknown) => isSubagentError(error, "unknown_agent"),
  );
  assert.equal(fixture.chats.length, 1, "the stopping Actor is never revived");
  exit.resolve();
  await fixture.settled(actor.id);
}

/**
 * A child model's `msg_write` to a peer address must produce a message success
 * result, and the peer's actual provider request must keep the host-attributed
 * child sender.
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
        return fixture.toolAnswer("msg_write", { to: receiver.address, content: "PEER_SOURCE_MARKER" }, "peer-write");
      }
      assertMessageSuccessFromMessage(writeResult);
      peerWriteCompleted = true;
      return fixture.textAnswer("actor done");
    }
    if (request.text.includes("SOCKET_RECEIVER_ACTOR")) await receiverExit.promise;
    return fixture.textAnswer("actor done");
  };
  const creation = fixture.call("subagent_create", {
    agents: [
      { goal: "SOCKET_SENDER_ACTOR send to peer" },
      { goal: "SOCKET_RECEIVER_ACTOR receive from peer" },
    ],
  });
  await waitForCondition(() => fixture.classifications.length > 0, "creation waits for routing");
  const registered = listedActors(await fixture.call("subagent_list", { all: true })).filter((actor) => actor.id !== "main");
  sender = registered[0];
  receiver = registered[1];
  assert.ok(sender, "the sender Actor must be created");
  assert.ok(receiver, "the receiver Actor must be created");
  routing.resolve();
  const created = createdItems(await creation);
  assert.deepEqual(created.map((actor) => actor.id), [sender.id, receiver.id]);
  await waitForCondition(() => peerWriteCompleted, "native peer write completion");
  receiverExit.resolve();
  await Promise.all([fixture.settled(sender.id), fixture.settled(receiver.id)]);
  const receiverRequests = fixture.chats.filter((request) => request.text.includes("SOCKET_RECEIVER_ACTOR"));
  const receiverRequest = receiverRequests.at(-1);
  assert.ok(receiverRequest, "the receiver must dispatch a native request");
  const text = receiverRequest.text;
  assert.match(text, /PEER_SOURCE_MARKER/);
  assert.equal(text.includes("[Message from main]"), false, "the listener must not relabel a child sender as main");
  assert.equal(
    occurrences(text, `[Message from ${sender.address}]`),
    1,
    "the host frames the actual native write owner exactly once",
  );
}

/** Corrupt restored ownership must fail closed as an invalid runtime state. */
export async function runRestoreInvalidScenario(fixture: ScenarioFixture): Promise<void> {
  fixture.sessionManager.appendCustomEntry("subagent-job", {
    v: 3,
    jobId: "sub_99",
    agentId: "sub_99",
    actor: {
      name: "corrupt", parentAgentId: null, depth: 1,
      batch: 2, member: null, goal: "Must not execute", context: null,
      roster: [{ id: "sub_99", name: "corrupt", goal: "Must not execute" }],
    },
    createdBy: "main",
    spec: { kind: "initial", inheritedContext: null },
    origin: null,
    index: null,
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
