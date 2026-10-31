import assert from "node:assert/strict";
import { test } from "node:test";
import { sendDelivery, DELIVERY_CUSTOM_TYPE, type DeliveryCustomMessage } from "../../src/subagent/delivery.ts";

const progress = { sourceId: "sub_01", round: 1, content: "progress" };

test("ordinary messages and terminal notices are independent native sends", async () => {
  const sent: DeliveryCustomMessage[] = [];
  const options = { send: (message: DeliveryCustomMessage) => { sent.push(message); } };
  sendDelivery(progress, options);
  const first = structuredClone(sent[0]);
  sendDelivery({ ...progress, content: "more progress" }, options);
  const terminal = sendDelivery({ ...progress, content: "done", terminal: { status: "completed", details: { jobId: "sub_01" } } }, options);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[0], first, "later delivery never edits an earlier payload");
  assert.equal(sent[0]!.content, "progress");
  assert.equal(sent[1]!.content, "more progress");
  assert.equal(sent[2]!.details.source, "host");
  assert.equal(sent[2]!.details.status, "completed");
  assert.match(sent[2]!.content, /Subagent sub_01 completed/);
  assert.equal(sent[2]!.content.includes("progress"), false);
  assert.equal("batchId" in sent[2]!.details, false);
  assert.deepEqual(await terminal.completion, { ok: true });
});

test("clearing the caller's native queue cannot absorb a later terminal send", () => {
  const queue: DeliveryCustomMessage[] = [];
  const options = { send: (message: DeliveryCustomMessage) => { queue.push(message); } };
  sendDelivery(progress, options);
  queue.length = 0; // Native ownership: the sender has no shadow queue.
  sendDelivery({ ...progress, content: "done", terminal: { status: "completed" } }, options);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!.details.status, "completed");
  assert.equal(queue[0]!.content.includes("progress"), false);
  queue.length = 0;
  assert.equal(queue.length, 0, "clearing the terminal does not trigger a resend");
});

test("source and round metadata are preserved without grouping or deduplication", () => {
  const sent: DeliveryCustomMessage[] = [];
  for (const sourceId of ["sub_01", "sub_02"]) for (const round of [1, "1", 2]) {
    sendDelivery({ sourceId, round, content: "same" }, { send: (message) => { sent.push(message); } });
  }
  assert.equal(sent.length, 6);
  assert.deepEqual(sent.map((message) => message.details.round), [1, "1", 2, 1, "1", 2]);
  assert.ok(sent.every((message) => message.customType === DELIVERY_CUSTOM_TYPE && message.role === "custom"));
});

test("inactive or throwing generation checks reject before sending", () => {
  let count = 0;
  const send = () => { count++; };
  assert.deepEqual(sendDelivery(progress, { send, isActive: () => false }), { accepted: false, reason: "inactive" });
  assert.deepEqual(sendDelivery(progress, { send, isActive: () => { throw new Error("retired"); } }), { accepted: false, reason: "inactive" });
  assert.equal(count, 0);
  assert.equal(sendDelivery(progress, { send, isActive: () => true }).accepted, true);
  assert.equal(count, 1);
});

test("async handoff is observable without blocking later independent sends", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = sendDelivery(progress, { send: () => gate });
  let finished = false;
  void first.completion!.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  let sent = 0;
  sendDelivery({ ...progress, content: "next" }, { send: () => { sent++; } });
  assert.equal(sent, 1);
  release();
  assert.deepEqual(await first.completion, { ok: true });
});

for (const asynchronous of [false, true]) test(`failed handoff is contained without retry (async=${asynchronous})`, async () => {
  let attempts = 0;
  const failure = new Error("send failed");
  const result = sendDelivery(progress, { send: () => {
    attempts++;
    if (asynchronous) return Promise.reject(failure);
    throw failure;
  } });
  assert.equal(result.accepted, true);
  assert.deepEqual(await result.completion, { ok: false, error: failure });
  await Promise.resolve();
  assert.equal(attempts, 1);
});

for (const status of ["cancelled", "failed"]) test(`${status} remains a host-owned terminal event`, () => {
  const sent: DeliveryCustomMessage[] = [];
  sendDelivery({ ...progress, content: "", terminal: { status, details: { error: "reason" } } }, { send: (message) => { sent.push(message); } });
  assert.equal(sent[0]!.details.source, "host");
  assert.equal(sent[0]!.details.status, status);
  assert.match(sent[0]!.content, new RegExp(status));
});
