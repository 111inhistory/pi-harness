import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  CustomMessageEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  createSteerDelivery,
  DELIVERY_CUSTOM_TYPE,
  type DeliveryCustomMessage,
  type DeliveryEnqueueResult,
} from "../../src/subagent/delivery.ts";

function nativeCustomMessage(
  content: string,
  details: Record<string, unknown>,
): AgentMessage {
  return {
    role: "custom",
    customType: DELIVERY_CUSTOM_TYPE,
    content,
    display: true,
    details,
    timestamp: 1234,
  } as unknown as AgentMessage;
}

interface InspectableMessage {
  content: string;
  details: Record<string, unknown>;
  role?: unknown;
  customType?: unknown;
  timestamp?: number;
}

function inspect(message: AgentMessage): InspectableMessage {
  return message as unknown as InspectableMessage;
}

function completionOf(result: DeliveryEnqueueResult): Promise<{
  ok: boolean;
  batchId: string;
  error?: unknown;
}> {
  const completion = result.completion;
  assert.ok(completion, "accepted entries expose a completion");
  return completion;
}

test("coalesces interleaved updates in one slot and finalizes a merged snapshot", async () => {
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({
    send: (entry) => {
      sent.push(entry);
    },
  });

  const first = delivery.enqueue({
    sourceId: "sub_a",
    round: 1,
    content: "CHILD_PROGRESS",
  });
  assert.equal(first.accepted, true);
  assert.equal(first.coalesced, false);
  assert.equal(sent.length, 1);
  const firstPayload = sent[0];
  assert.ok(firstPayload);
  assert.equal(firstPayload.content, "CHILD_PROGRESS");
  assert.equal(firstPayload.details.source, "agent");
  assert.equal(firstPayload.details.status, "running");

  const update = delivery.enqueue({
    sourceId: "sub_a",
    round: 1,
    content: "CHILD_COMPLETED",
    terminal: {
      status: "completed",
      details: { jobId: "job_1", history: "/tmp/history.jsonl" },
    },
  });
  assert.equal(update.accepted, true);
  assert.equal(update.coalesced, true);
  assert.equal(update.batchId, first.batchId);
  assert.equal(update.completion, first.completion);
  assert.equal(sent.length, 1, "updates do not send a second message");

  // The queued native payload is a snapshot and stays untouched.
  assert.equal(firstPayload.content, "CHILD_PROGRESS");
  assert.equal(firstPayload.details.source, "agent");
  assert.equal(firstPayload.details.status, "running");

  const original = nativeCustomMessage("CHILD_PROGRESS", {
    batchId: first.batchId,
    custom: "kept",
  });
  const replacement = delivery.replaceMessage(original);
  assert.ok(replacement);
  assert.equal(replacement.role, "custom");
  assert.equal(
    (replacement as unknown as { customType: string }).customType,
    DELIVERY_CUSTOM_TYPE,
  );
  assert.equal(
    (replacement as unknown as { timestamp: number }).timestamp,
    1234,
    "native message metadata is preserved",
  );
  assert.match(
    inspect(replacement).content,
    /^CHILD_PROGRESS\n\nCHILD_COMPLETED\n\n\[Subagent sub_a completed \(round 1\)\]/,
  );
  assert.match(inspect(replacement).content, /job_1/);

  const details = inspect(replacement).details;
  assert.equal(details.batchId, first.batchId);
  assert.equal(details.sourceId, "sub_a");
  assert.equal(details.round, 1);
  assert.equal(details.source, "host");
  assert.equal(details.status, "completed");
  assert.equal(details.custom, "kept", "unknown native details are preserved");
  assert.deepEqual(details.terminal, {
    status: "completed",
    details: { jobId: "job_1", history: "/tmp/history.jsonl" },
  });

  // The input message is not mutated.
  assert.equal(inspect(original).content, "CHILD_PROGRESS");
  assert.equal(
    (original as unknown as { details: Record<string, unknown> }).details.status,
    undefined,
  );

  const outcome = await completionOf(first);
  assert.deepEqual(outcome, { ok: true, batchId: first.batchId });
});

test("seals during replacement and gives later arrivals a new slot", async () => {
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({ send: (entry) => void sent.push(entry) });

  const first = delivery.enqueue({ sourceId: "sub_a", round: 1, content: "FIRST" });
  assert.ok(first.batchId);
  const replacement = delivery.replaceMessage(
    nativeCustomMessage("FIRST", { batchId: first.batchId }),
  );
  assert.ok(replacement);
  assert.equal(inspect(replacement).content, "FIRST");

  // The first slot is sealed at handler return. The second call cannot revive it.
  assert.equal(
    delivery.replaceMessage(nativeCustomMessage("FIRST", { batchId: first.batchId })),
    undefined,
  );

  const late = delivery.enqueue({
    sourceId: "sub_a",
    round: 1,
    content: "LATE_DONE",
    terminal: { status: "completed" },
  });
  assert.equal(late.coalesced, false);
  assert.notEqual(late.batchId, first.batchId);
  assert.equal(sent.length, 2);
  assert.equal(
    sent[1]?.content,
    "LATE_DONE\n\n[Subagent sub_a completed (round 1)]",
  );

  const lateReplacement = delivery.replaceMessage(
    nativeCustomMessage("LATE_DONE", { batchId: late.batchId }),
  );
  assert.ok(lateReplacement);
  assert.match(inspect(lateReplacement).content, /^LATE_DONE\n\n/);
  assert.equal(
    (lateReplacement as unknown as { details: Record<string, unknown> }).details.status,
    "completed",
  );
});

test("keeps different sources and different rounds separate", () => {
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({ send: (entry) => void sent.push(entry) });

  const a1 = delivery.enqueue({ sourceId: "sub_a", round: 1, content: "A1" });
  const a2 = delivery.enqueue({ sourceId: "sub_a", round: 2, content: "A2" });
  const b1 = delivery.enqueue({ sourceId: "sub_b", round: 1, content: "B1" });
  assert.deepEqual(
    [a1.batchId, a2.batchId, b1.batchId].filter((value) => value !== undefined).length,
    3,
  );
  assert.equal(new Set([a1.batchId, a2.batchId, b1.batchId]).size, 3);
  assert.equal(sent.length, 3);

  const a1Update = delivery.enqueue({
    sourceId: "sub_a",
    round: 1,
    content: "A1_DONE",
    terminal: { status: "failed" },
  });
  assert.equal(a1Update.batchId, a1.batchId);

  const a1Message = delivery.replaceMessage(
    nativeCustomMessage("A1", { batchId: a1.batchId }),
  );
  assert.ok(a1Message);
  assert.match(inspect(a1Message).content, /^A1\n\nA1_DONE\n\n/);
  assert.equal(
    (a1Message as unknown as { details: Record<string, unknown> }).details.status,
    "failed",
  );

  const a2Message = delivery.replaceMessage(
    nativeCustomMessage("A2", { batchId: a2.batchId }),
  );
  assert.ok(a2Message);
  assert.equal(inspect(a2Message).content, "A2", "another round was not merged into A1");
  assert.equal(
    (a2Message as unknown as { details: Record<string, unknown> }).details.status,
    "running",
  );

  const b1Message = delivery.replaceMessage(
    nativeCustomMessage("B1", { batchId: b1.batchId }),
  );
  assert.ok(b1Message);
  assert.equal(inspect(b1Message).content, "B1");
});

test("numeric and string round names identify the same slot", () => {
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({ send: (entry) => void sent.push(entry) });
  const numeric = delivery.enqueue({ sourceId: "sub_a", round: 1, content: "ONE" });
  const textual = delivery.enqueue({ sourceId: "sub_a", round: "1", content: "ONE" });
  assert.equal(textual.batchId, numeric.batchId);
  assert.equal(textual.coalesced, true);
  assert.equal(sent.length, 1);
});

test("ignores user, foreign custom messages and unknown batch identities", () => {
  const delivery = createSteerDelivery({ send: () => undefined });
  const ours = delivery.enqueue({ sourceId: "sub_a", round: 1, content: "HELLO" });

  const userMessage = {
    role: "user",
    content: "HELLO",
    timestamp: 1,
  } as unknown as AgentMessage;
  assert.equal(delivery.replaceMessage(userMessage), undefined);

  const foreign = {
    role: "custom",
    customType: "agent-message",
    content: "HELLO",
    display: true,
    details: { batchId: ours.batchId },
    timestamp: 1,
  } as unknown as AgentMessage;
  assert.equal(delivery.replaceMessage(foreign), undefined);

  const missingDetails = {
    role: "custom",
    customType: DELIVERY_CUSTOM_TYPE,
    content: "HELLO",
    display: true,
    timestamp: 1,
  } as unknown as AgentMessage;
  assert.equal(delivery.replaceMessage(missingDetails), undefined);

  assert.equal(
    delivery.replaceMessage(
      nativeCustomMessage("HELLO", { batchId: "not-ours" }),
    ),
    undefined,
  );

  // The real message is still replaceable after unrelated messages were seen.
  const replacement = delivery.replaceMessage(
    nativeCustomMessage("HELLO", { batchId: ours.batchId }),
  );
  assert.ok(replacement);
  assert.equal(inspect(replacement).content, "HELLO");
});

test("does not let another delivery instance replace this instance's message", () => {
  const first = createSteerDelivery({ send: () => undefined });
  const second = createSteerDelivery({ send: () => undefined });
  const mine = first.enqueue({ sourceId: "sub_a", round: 1, content: "MINE" });
  assert.equal(
    second.replaceMessage(nativeCustomMessage("MINE", { batchId: mine.batchId })),
    undefined,
  );
  assert.ok(
    first.replaceMessage(nativeCustomMessage("MINE", { batchId: mine.batchId })),
  );
});

test("retire rejects new entries and drops pending replacement state", async () => {
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({ send: (entry) => void sent.push(entry) });
  const before = delivery.enqueue({ sourceId: "sub_a", round: 1, content: "BEFORE" });
  assert.ok(before.batchId);

  delivery.retire();
  assert.deepEqual(delivery.enqueue({ sourceId: "sub_a", round: 2, content: "AFTER" }), {
    accepted: false,
    reason: "retired",
  });
  assert.equal(sent.length, 1, "retirement does not send queued or new entries");

  // The already-handed-out message keeps Pi's original content; the retired
  // delivery cannot mutate it through a late message_end.
  assert.equal(
    delivery.replaceMessage(nativeCustomMessage("BEFORE", { batchId: before.batchId })),
    undefined,
  );
  await completionOf(before);
  delivery.retire();
});

test("reports a rejected native send once and never retries or resurrects it", async () => {
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({
    send: (entry) => {
      sent.push(entry);
      return Promise.reject(new Error(`native failure ${sent.length}`));
    },
  });

  const first = delivery.enqueue({ sourceId: "sub_a", round: 1, content: "FIRST" });
  const firstOutcome = await completionOf(first);
  assert.equal(firstOutcome.ok, false);
  assert.equal(firstOutcome.batchId, first.batchId);
  assert.match(String(firstOutcome.error), /native failure 1/);
  assert.equal(sent.length, 1);

  // New content gets a new batch, and only the new content is sent. The failed
  // accepted slot is not retried or merged into the replacement.
  const second = delivery.enqueue({ sourceId: "sub_a", round: 1, content: "SECOND" });
  assert.equal(second.coalesced, false);
  assert.notEqual(second.batchId, first.batchId);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.content, "SECOND");

  const secondOutcome = await completionOf(second);
  assert.equal(secondOutcome.ok, false);
  assert.equal(sent.length, 2, "settling a failure does not trigger a retry");

  // The old failed slot also cannot be updated or replaced after it was superseded.
  assert.equal(
    delivery.replaceMessage(nativeCustomMessage("FIRST", { batchId: first.batchId })),
    undefined,
  );
});

test("a synchronously throwing send is contained and reported", async () => {
  let calls = 0;
  const delivery = createSteerDelivery({
    send: () => {
      calls += 1;
      throw new Error("synchronous failure");
    },
  });
  const result = delivery.enqueue({ sourceId: "sub_a", round: 1, content: "FIRST" });
  const outcome = await completionOf(result);
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /synchronous failure/);
  assert.equal(calls, 1);
});

test("completion waits for the send without blocking enqueue side effects", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivery = createSteerDelivery({ send: () => gate });

  const result = delivery.enqueue({ sourceId: "sub_a", round: 1, content: "QUEUED" });
  assert.equal(result.accepted, true, "enqueue returned before the send settled");

  let settled = false;
  void completionOf(result).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  const outcome = await completionOf(result);
  assert.equal(outcome.ok, true);
  assert.equal(settled, true);
});

test("isActive governs new entries without rewriting an in-flight slot", () => {
  let active = true;
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({
    send: (entry) => void sent.push(entry),
    isActive: () => active,
  });

  const pending = delivery.enqueue({ sourceId: "sub_a", round: 1, content: "LIVE" });
  active = false;
  assert.deepEqual(delivery.enqueue({ sourceId: "sub_a", round: 1, content: "IGNORED" }), {
    accepted: false,
    reason: "inactive",
  });
  assert.equal(sent.length, 1);

  const replacement = delivery.replaceMessage(
    nativeCustomMessage("LIVE", { batchId: pending.batchId }),
  );
  assert.ok(replacement);
  assert.equal(inspect(replacement).content, "LIVE", "inactive only rejects new entries");

  active = true;
  const next = delivery.enqueue({ sourceId: "sub_a", round: 1, content: "NEXT" });
  assert.equal(next.coalesced, false);
  assert.equal(sent.length, 2);
});

test("treats a throwing isActive check as inactive", () => {
  const delivery = createSteerDelivery({
    send: () => undefined,
    isActive: () => {
      throw new Error("generation unavailable");
    },
  });
  assert.deepEqual(delivery.enqueue({ sourceId: "sub_a", round: 1, content: "NO" }), {
    accepted: false,
    reason: "inactive",
  });
});

test("a cancelled terminal stays host-owned and does not create retry state", async () => {
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({ send: (entry) => void sent.push(entry) });
  const result = delivery.enqueue({
    sourceId: "sub_a",
    round: 3,
    content: "",
    terminal: { status: "cancelled" },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.content, "[Subagent sub_a cancelled (round 3)]");
  assert.equal(sent[0]?.details.source, "host");
  assert.equal(sent[0]?.details.status, "cancelled");
  const outcome = await completionOf(result);
  assert.equal(outcome.ok, true);
  assert.equal(sent.length, 1, "cancelled delivery is not retried");

  const replacement = delivery.replaceMessage(
    nativeCustomMessage("unused", { batchId: result.batchId }),
  );
  assert.ok(replacement);
  assert.equal(inspect(replacement).content, "[Subagent sub_a cancelled (round 3)]");
  assert.equal(inspect(replacement).details.source, "host");
  assert.equal(inspect(replacement).details.status, "cancelled");
  assert.equal(
    delivery.replaceMessage(nativeCustomMessage("unused", { batchId: result.batchId })),
    undefined,
    "sealing leaves no retryable slot behind",
  );
});

test("appends two ordinary messages plus a distinct terminal summary without dedup", () => {
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({ send: (entry) => void sent.push(entry) });

  const first = delivery.enqueue({ sourceId: "sub_a", round: 4, content: "STEP_ONE" });
  const second = delivery.enqueue({ sourceId: "sub_a", round: 4, content: "STEP_TWO" });
  const repeated = delivery.enqueue({ sourceId: "sub_a", round: 4, content: "STEP_TWO" });
  const terminal = delivery.enqueue({
    sourceId: "sub_a",
    round: 4,
    content: "FINAL_SUMMARY",
    terminal: { status: "completed", details: { jobId: "job_4" } },
  });
  assert.equal(second.coalesced, true);
  assert.equal(repeated.coalesced, true);
  assert.equal(terminal.coalesced, true);
  assert.equal(sent.length, 1, "all deltas stay in the one queued steer");

  const replacement = delivery.replaceMessage(
    nativeCustomMessage("STEP_ONE", { batchId: first.batchId }),
  );
  assert.ok(replacement);
  assert.equal(
    inspect(replacement).content,
    'STEP_ONE\n\nSTEP_TWO\n\nSTEP_TWO\n\nFINAL_SUMMARY\n\n[Subagent sub_a completed (round 4)]: {"jobId":"job_4"}',
    "every ordinary delta is appended in order, including identical content",
  );
  assert.equal(inspect(replacement).details.source, "host");
  assert.equal(inspect(replacement).details.status, "completed");
  assert.deepEqual(inspect(replacement).details.terminal, {
    status: "completed",
    details: { jobId: "job_4" },
  });
});

test("keeps host terminal metadata when ordinary content arrives after the terminal", () => {
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({ send: (entry) => void sent.push(entry) });

  const first = delivery.enqueue({ sourceId: "sub_a", round: 5, content: "PROGRESS" });
  delivery.enqueue({
    sourceId: "sub_a",
    round: 5,
    content: "TERMINAL_SUMMARY",
    terminal: { status: "failed", details: { code: "model_error" } },
  });
  const late = delivery.enqueue({ sourceId: "sub_a", round: 5, content: "LATE_PROGRESS" });
  assert.equal(late.coalesced, true);
  assert.equal(sent.length, 1);

  const replacement = delivery.replaceMessage(
    nativeCustomMessage("PROGRESS", { batchId: first.batchId }),
  );
  assert.ok(replacement);
  assert.equal(
    inspect(replacement).content,
    'PROGRESS\n\nTERMINAL_SUMMARY\n\nLATE_PROGRESS\n\n[Subagent sub_a failed (round 5)]: {"code":"model_error"}',
  );
  assert.equal(inspect(replacement).details.source, "host", "late text did not downgrade source");
  assert.equal(inspect(replacement).details.status, "failed", "late text did not downgrade status");
  assert.deepEqual(inspect(replacement).details.terminal, {
    status: "failed",
    details: { code: "model_error" },
  });
});

test("clearQueue split sends the terminal in a new batch without duplicating progress", () => {
  let pending = true;
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({
    send: (entry) => void sent.push(entry),
    hasPendingMessages: () => pending,
  });

  const first = delivery.enqueue({
    sourceId: "sub_a",
    round: 6,
    content: "PROGRESS_1",
  });
  delivery.enqueue({ sourceId: "sub_a", round: 6, content: "PROGRESS_2" });
  assert.equal(sent.length, 1);

  // clearQueue removed the queued snapshot before message_start.
  pending = false;
  const terminal = delivery.enqueue({
    sourceId: "sub_a",
    round: 6,
    content: "TERMINAL",
    terminal: { status: "completed" },
  });
  assert.equal(terminal.coalesced, false);
  assert.notEqual(terminal.batchId, first.batchId);
  assert.equal(sent.length, 2);
  assert.equal(
    sent[1]?.content,
    "TERMINAL\n\n[Subagent sub_a completed (round 6)]",
    "new batch carries only the un-delivered terminal entry",
  );
  assert.doesNotMatch(sent[1]?.content ?? "", /PROGRESS_/);

  // A preparation race can still deliver the old snapshot after the split.
  const oldMessage = nativeCustomMessage("PROGRESS_1", { batchId: first.batchId });
  delivery.messageStarted(oldMessage);
  const oldReplacement = delivery.replaceMessage(oldMessage);
  assert.ok(oldReplacement);
  assert.equal(inspect(oldReplacement).content, "PROGRESS_1\n\nPROGRESS_2");
  assert.doesNotMatch(inspect(oldReplacement).content, /TERMINAL/);

  const terminalReplacement = delivery.replaceMessage(
    nativeCustomMessage("TERMINAL", { batchId: terminal.batchId }),
  );
  assert.ok(terminalReplacement);
  assert.equal(
    inspect(terminalReplacement).content,
    "TERMINAL\n\n[Subagent sub_a completed (round 6)]",
  );
});

test("an ordinary message after queue clear gets a fresh batch and retains later deltas", () => {
  const sent: DeliveryCustomMessage[] = [];
  const queued = new Set<string>();
  const delivery = createSteerDelivery({
    send: (entry) => { sent.push(entry); queued.add(entry.details.batchId); },
    hasPendingMessages: (batchId) => queued.has(batchId),
  });

  const first = delivery.enqueue({ sourceId: "sub_a", round: 12, content: "P1_CLEARED" });
  queued.clear();
  const second = delivery.enqueue({ sourceId: "sub_a", round: 12, content: "P2_AFTER_CLEAR" });
  const third = delivery.enqueue({ sourceId: "sub_a", round: 12, content: "P3" });
  const terminal = delivery.enqueue({ sourceId: "sub_a", round: 12, content: "DONE", terminal: { status: "completed" } });
  assert.equal(second.coalesced, false, "new ordinary content cannot update a vanished snapshot");
  assert.notEqual(second.batchId, first.batchId);
  assert.equal(third.coalesced, true);
  assert.equal(terminal.batchId, second.batchId);
  assert.equal(sent.length, 2);
  const replacement = delivery.replaceMessage(
    nativeCustomMessage("P2_AFTER_CLEAR", { batchId: second.batchId }),
  );
  assert.ok(replacement);
  assert.equal(inspect(replacement).content, "P2_AFTER_CLEAR\n\nP3\n\nDONE\n\n[Subagent sub_a completed (round 12)]");
});

test("message_start keeps an unstarted batch mergeable despite an empty oracle", () => {
  let pending = true;
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({
    send: (entry) => void sent.push(entry),
    hasPendingMessages: () => pending,
  });

  const first = delivery.enqueue({
    sourceId: "sub_a",
    round: 7,
    content: "PROGRESS_1",
  });
  delivery.enqueue({ sourceId: "sub_a", round: 7, content: "PROGRESS_2" });
  pending = false;

  const oldMessage = nativeCustomMessage("PROGRESS_1", { batchId: first.batchId });
  delivery.messageStarted(oldMessage);
  const terminal = delivery.enqueue({
    sourceId: "sub_a",
    round: 7,
    content: "TERMINAL",
    terminal: { status: "completed" },
  });
  assert.equal(terminal.coalesced, true, "started batch retains merge until message_end");
  assert.equal(terminal.batchId, first.batchId);
  assert.equal(sent.length, 1);

  const replacement = delivery.replaceMessage(oldMessage);
  assert.ok(replacement);
  assert.equal(
    inspect(replacement).content,
    "PROGRESS_1\n\nPROGRESS_2\n\nTERMINAL\n\n[Subagent sub_a completed (round 7)]",
  );
});

test("a true or unavailable pending oracle keeps the conservative merge", () => {
  const sentTrue: DeliveryCustomMessage[] = [];
  const pendingTrue = createSteerDelivery({
    send: (entry) => void sentTrue.push(entry),
    hasPendingMessages: () => true,
  });
  const firstTrue = pendingTrue.enqueue({ sourceId: "sub_a", round: 8, content: "P" });
  const terminalTrue = pendingTrue.enqueue({
    sourceId: "sub_a",
    round: 8,
    content: "T",
    terminal: { status: "completed" },
  });
  assert.equal(terminalTrue.coalesced, true);
  assert.equal(sentTrue.length, 1);
  const replacementTrue = pendingTrue.replaceMessage(
    nativeCustomMessage("P", { batchId: firstTrue.batchId }),
  );
  assert.ok(replacementTrue);
  assert.match(inspect(replacementTrue).content, /^P\n\nT\n\n/);

  const sentThrows: DeliveryCustomMessage[] = [];
  const pendingThrows = createSteerDelivery({
    send: (entry) => void sentThrows.push(entry),
    hasPendingMessages: () => {
      throw new Error("queue unavailable");
    },
  });
  const firstThrows = pendingThrows.enqueue({ sourceId: "sub_a", round: 9, content: "P" });
  const terminalThrows = pendingThrows.enqueue({
    sourceId: "sub_a",
    round: 9,
    content: "T",
    terminal: { status: "failed" },
  });
  assert.equal(terminalThrows.coalesced, true);
  assert.equal(sentThrows.length, 1);
  const replacementThrows = pendingThrows.replaceMessage(
    nativeCustomMessage("P", { batchId: firstThrows.batchId }),
  );
  assert.ok(replacementThrows);
  assert.match(inspect(replacementThrows).content, /^P\n\nT\n\n/);
});

test("breakMergeKeys closes the stale key at an input boundary but keeps its batch", () => {
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({
    send: (entry) => void sent.push(entry),
    // A user message may keep the aggregate oracle true even after clearQueue.
    hasPendingMessages: () => true,
  });

  const first = delivery.enqueue({ sourceId: "sub_a", round: 10, content: "OLD_PROGRESS" });
  delivery.breakMergeKeys();
  const terminal = delivery.enqueue({
    sourceId: "sub_a",
    round: 10,
    content: "TERMINAL",
    terminal: { status: "cancelled" },
  });
  assert.equal(terminal.coalesced, false);
  assert.notEqual(terminal.batchId, first.batchId);
  assert.equal(sent.length, 2);
  assert.equal(
    sent[1]?.content,
    "TERMINAL\n\n[Subagent sub_a cancelled (round 10)]",
  );

  const oldReplacement = delivery.replaceMessage(
    nativeCustomMessage("OLD_PROGRESS", { batchId: first.batchId }),
  );
  assert.ok(oldReplacement);
  assert.equal(inspect(oldReplacement).content, "OLD_PROGRESS");

  const terminalReplacement = delivery.replaceMessage(
    nativeCustomMessage("TERMINAL", { batchId: terminal.batchId }),
  );
  assert.ok(terminalReplacement);
  assert.equal(
    inspect(terminalReplacement).content,
    "TERMINAL\n\n[Subagent sub_a cancelled (round 10)]",
  );
});

test("settle closes merge keys and bounds stale batch lookups over turns", () => {
  const sent: DeliveryCustomMessage[] = [];
  const delivery = createSteerDelivery({
    send: (entry) => void sent.push(entry),
    hasPendingMessages: () => true,
  });

  const first = delivery.enqueue({ sourceId: "sub_a", round: 11, content: "OLD" });
  delivery.settle();
  const terminal = delivery.enqueue({
    sourceId: "sub_a",
    round: 11,
    content: "TERMINAL",
    terminal: { status: "completed" },
  });
  assert.equal(terminal.coalesced, false, "settle closed the old merge key");
  assert.equal(sent.length, 2);

  // One settle of grace keeps the old lookup available for a late message_end.
  delivery.settle();
  assert.equal(
    delivery.replaceMessage(nativeCustomMessage("OLD", { batchId: first.batchId })),
    undefined,
    "the next settle drops the unclaimed old batch",
  );
  const terminalReplacement = delivery.replaceMessage(
    nativeCustomMessage("TERMINAL", { batchId: terminal.batchId }),
  );
  assert.ok(terminalReplacement);
  assert.equal(
    inspect(terminalReplacement).content,
    "TERMINAL\n\n[Subagent sub_a completed (round 11)]",
  );
});

function isDeliveryEntry(entry: SessionEntry): entry is CustomMessageEntry {
  return (
    entry.type === "custom_message" &&
    entry.customType === DELIVERY_CUSTOM_TYPE
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = () => done();
  });
  return { promise, resolve };
}

test(
  "real Pi SDK: message_end replaces a queued steer with one merged host notice",
  { timeout: 30_000 },
  async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const {
      createAgentSession,
      DefaultResourceLoader,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-delivery-smoke-"));
    const gate = deferred();
    const release = deferred();
    const requests: unknown[][] = [];
    const errors: string[] = [];
    let delivery: ReturnType<typeof createSteerDelivery> | undefined;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

    try {
      const runtime = await ModelRuntime.create({
        authPath: path.join(cwd, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
      assert.ok(model);

      type SimpleStream = typeof runtime.streamSimple;
      runtime.streamSimple = ((
        _model: Parameters<SimpleStream>[0],
        context: Parameters<SimpleStream>[1],
      ) => {
        requests.push(structuredClone(context.messages) as unknown[]);
        const first = requests.length === 1;
        const stopReason = first ? ("toolUse" as const) : ("stop" as const);
        const reply: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: first
            ? [{ type: "toolCall", id: "gate-call", name: "gate", arguments: {} }]
            : [{ type: "text", text: "done" }],
          stopReason,
          timestamp: Date.now(),
          usage: {
            input: 1,
            output: 1,
            totalTokens: 2,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
          },
        };
        const stream = new AssistantMessageEventStream();
        stream.push({ type: "done", reason: stopReason, message: reply });
        stream.end();
        return stream;
      }) as SimpleStream;
      runtime.getAuth = (async () => ({
        auth: { apiKey: "offline-only" },
        env: {},
      })) as unknown as typeof runtime.getAuth;
      runtime.hasConfiguredAuth = (() => true) as typeof runtime.hasConfiguredAuth;

      const settingsManager = SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
        cacheWarming: "off",
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [
          {
            name: "delivery-smoke",
            factory(pi) {
              delivery = createSteerDelivery({
                send: (entry) => {
                  pi.sendMessage(entry, { triggerTurn: true, deliverAs: "steer" });
                },
                isActive: () => session !== undefined,
              });
              pi.registerTool({
                name: "gate",
                label: "Gate",
                description: "Offline synchronization gate",
                parameters: { type: "object", properties: {} },
                execute: async () => {
                  gate.resolve();
                  await release.promise;
                  return {
                    content: [{ type: "text", text: "released" }],
                    details: undefined,
                  };
                },
              });
              pi.on("message_end", (event) => {
                const replacement = delivery?.replaceMessage(event.message);
                return replacement === undefined ? undefined : { message: replacement };
              });
            },
          },
        ],
      });
      await resourceLoader.reload();
      ({ session } = await createAgentSession({
        cwd,
        agentDir: cwd,
        modelRuntime: runtime,
        model,
        sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
        resourceLoader,
        settingsManager,
      }));
      await session.bindExtensions({
        onError: (error) => {
          errors.push(String((error as { error?: unknown }).error ?? error));
        },
      });
      session.setActiveToolsByName(["gate"]);

      const running = session.prompt("Run a gated tool");
      await gate.promise;
      assert.ok(delivery);
      const pending = delivery.enqueue({
        sourceId: "sub_fixture",
        round: 1,
        content: "CHILD_PROGRESS",
      });
      const secondProgress = delivery.enqueue({
        sourceId: "sub_fixture",
        round: 1,
        content: "CHILD_PROGRESS_2",
      });
      const terminal = delivery.enqueue({
        sourceId: "sub_fixture",
        round: 1,
        content: "CHILD_COMPLETED",
        terminal: { status: "completed", details: { jobId: "job_fixture" } },
      });
      assert.equal(secondProgress.coalesced, true);
      assert.equal(terminal.coalesced, true);
      assert.equal(terminal.batchId, pending.batchId);
      release.resolve();
      await running;
      await session.waitForIdle();

      const branch = session.sessionManager.getBranch();
      const deliveries = branch.filter(isDeliveryEntry);
      assert.equal(deliveries.length, 1, "Pi wrote one merged native message");
      const committed = deliveries[0];
      assert.ok(committed);
      assert.equal(
        committed.content,
        "CHILD_PROGRESS\n\nCHILD_PROGRESS_2\n\nCHILD_COMPLETED\n\n[Subagent sub_fixture completed (round 1)]: {\"jobId\":\"job_fixture\"}",
      );
      const committedDetails = committed.details as Record<string, unknown>;
      assert.equal(committedDetails.batchId, pending.batchId);
      assert.equal(committedDetails.source, "host");
      assert.equal(committedDetails.status, "completed");

      const serialized = requests.map((messages) => JSON.stringify(messages));
      assert.equal(
        serialized.filter((text) => text.includes("CHILD_PROGRESS")).length,
        1,
        "the merged notice occupied one later model request",
      );
      const mergedRequest = serialized.at(-1) ?? "";
      assert.match(mergedRequest, /CHILD_PROGRESS_2/);
      assert.match(mergedRequest, /CHILD_COMPLETED/);
      assert.match(mergedRequest, /job_fixture/);

      // The first slot was sealed by message_end. A later arrival is a new
      // native steer, even though the same source/round is named.
      const late = delivery.enqueue({
        sourceId: "sub_fixture",
        round: 1,
        content: "CHILD_LATE",
      });
      assert.equal(late.coalesced, false);
      assert.notEqual(late.batchId, pending.batchId);
      await new Promise<void>((done) => setImmediate(done));
      await session.waitForIdle();

      const after = session.sessionManager.getBranch().filter(isDeliveryEntry);
      assert.deepEqual(
        after.map((entry) => entry.content),
        [
          "CHILD_PROGRESS\n\nCHILD_PROGRESS_2\n\nCHILD_COMPLETED\n\n[Subagent sub_fixture completed (round 1)]: {\"jobId\":\"job_fixture\"}",
          "CHILD_LATE",
        ],
      );
      assert.deepEqual(errors, []);
    } finally {
      release.resolve();
      gate.resolve();
      delivery?.retire();
      await session?.waitForIdle();
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "real Pi SDK: clearQueue before message_start sends the terminal in a fresh batch",
  { timeout: 30_000 },
  async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const {
      createAgentSession,
      DefaultResourceLoader,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await import("@earendil-works/pi-coding-agent");
    const { AssistantMessageEventStream } = await import(
      "@earendil-works/pi-ai/utils/event-stream"
    );
    type AssistantMessage = import("@earendil-works/pi-ai").AssistantMessage;

    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-delivery-clear-"));
    const gate = deferred();
    const release = deferred();
    const requests: unknown[][] = [];
    const errors: string[] = [];
    let delivery: ReturnType<typeof createSteerDelivery> | undefined;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

    try {
      const runtime = await ModelRuntime.create({
        authPath: path.join(cwd, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
      assert.ok(model);

      type SimpleStream = typeof runtime.streamSimple;
      runtime.streamSimple = ((
        _model: Parameters<SimpleStream>[0],
        context: Parameters<SimpleStream>[1],
      ) => {
        requests.push(structuredClone(context.messages) as unknown[]);
        const first = requests.length === 1;
        const stopReason = first ? ("toolUse" as const) : ("stop" as const);
        const reply: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: first
            ? [{ type: "toolCall", id: "gate-call", name: "gate", arguments: {} }]
            : [{ type: "text", text: "done" }],
          stopReason,
          timestamp: Date.now(),
          usage: {
            input: 1,
            output: 1,
            totalTokens: 2,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
          },
        };
        const stream = new AssistantMessageEventStream();
        stream.push({ type: "done", reason: stopReason, message: reply });
        stream.end();
        return stream;
      }) as SimpleStream;
      runtime.getAuth = (async () => ({
        auth: { apiKey: "offline-only" },
        env: {},
      })) as unknown as typeof runtime.getAuth;
      runtime.hasConfiguredAuth = (() => true) as typeof runtime.hasConfiguredAuth;

      const settingsManager = SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
        cacheWarming: "off",
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        extensionFactories: [
          {
            name: "delivery-clear-smoke",
            factory(pi) {
              delivery = createSteerDelivery({
                send: (entry) => {
                  pi.sendMessage(entry, { triggerTurn: true, deliverAs: "steer" });
                },
                hasPendingMessages: () =>
                  session !== undefined && session.agent.hasQueuedMessages(),
                isActive: () => session !== undefined,
              });
              pi.registerTool({
                name: "gate",
                label: "Gate",
                description: "Offline synchronization gate",
                parameters: { type: "object", properties: {} },
                execute: async () => {
                  gate.resolve();
                  await release.promise;
                  return {
                    content: [{ type: "text", text: "released" }],
                    details: undefined,
                  };
                },
              });
              pi.on("message_start", (event) => {
                delivery?.messageStarted(event.message);
              });
              pi.on("message_end", (event) => {
                const replacement = delivery?.replaceMessage(event.message);
                return replacement === undefined ? undefined : { message: replacement };
              });
            },
          },
        ],
      });
      await resourceLoader.reload();
      ({ session } = await createAgentSession({
        cwd,
        agentDir: cwd,
        modelRuntime: runtime,
        model,
        sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
        resourceLoader,
        settingsManager,
      }));
      await session.bindExtensions({
        onError: (error) => {
          errors.push(String((error as { error?: unknown }).error ?? error));
        },
      });
      session.setActiveToolsByName(["gate"]);

      const running = session.prompt("Run a gated tool");
      await gate.promise;
      assert.ok(delivery);
      const progress = delivery.enqueue({
        sourceId: "sub_clear",
        round: 1,
        content: "PROGRESS_EXPLICITLY_CLEARED",
      });
      delivery.enqueue({
        sourceId: "sub_clear",
        round: 1,
        content: "MORE_PROGRESS_EXPLICITLY_CLEARED",
      });
      assert.equal(session.agent.hasQueuedMessages(), true);

      session.clearQueue();
      assert.equal(session.agent.hasQueuedMessages(), false);

      const terminal = delivery.enqueue({
        sourceId: "sub_clear",
        round: 1,
        content: "TERMINAL_AFTER_CLEAR",
        terminal: { status: "completed", details: { jobId: "job_clear" } },
      });
      assert.equal(terminal.coalesced, false, "cleared batch cannot absorb the terminal");
      assert.notEqual(terminal.batchId, progress.batchId);
      assert.equal(session.agent.hasQueuedMessages(), true, "terminal queues afresh");

      release.resolve();
      await running;
      await session.waitForIdle();

      const received = session.sessionManager.getBranch().filter(isDeliveryEntry);
      assert.equal(received.length, 1, "only the post-clear terminal is committed");
      const committed = received[0];
      assert.ok(committed);
      assert.equal(
        committed.content,
        'TERMINAL_AFTER_CLEAR\n\n[Subagent sub_clear completed (round 1)]: {"jobId":"job_clear"}',
      );
      assert.doesNotMatch(
        JSON.stringify(committed.content),
        /PROGRESS_EXPLICITLY_CLEARED/,
      );
      const details = committed.details as Record<string, unknown>;
      assert.equal(details.source, "host");
      assert.equal(details.status, "completed");

      const lastRequest = JSON.stringify(requests.at(-1) ?? []);
      assert.match(lastRequest, /TERMINAL_AFTER_CLEAR/);
      assert.doesNotMatch(lastRequest, /PROGRESS_EXPLICITLY_CLEARED/);
      assert.deepEqual(errors, []);
    } finally {
      release.resolve();
      gate.resolve();
      delivery?.retire();
      await session?.waitForIdle();
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
