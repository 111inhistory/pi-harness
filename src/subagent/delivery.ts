import { randomUUID } from "node:crypto";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Aggregates still-undelivered Subagent messages and host terminal notices
 * into one Pi custom message per source and execution round.
 *
 * The module owns one mutable slot per `(sourceId, round)`. A slot is handed
 * to `send` once; later entries for the same source/round append their ordinary
 * content in arrival order without touching the message already queued in Pi.
 * `replaceMessage` is meant to be returned from Pi's `message_end` hook: it
 * returns the latest merged snapshot and seals the slot. Pi owns steering,
 * queueing, interruption and continuation from there; this module never reads,
 * edits or clears SDK queues.
 *
 * The sealing point is the `message_end` handler's return, which is slightly
 * earlier than Pi's history write. Content arriving after that point gets a new
 * slot, even if Pi has not written the previous message to disk yet.
 */
export const DELIVERY_CUSTOM_TYPE = "agent-delivery";

export interface DeliveryTerminal {
  status: string;
  details?: unknown;
}

export interface DeliveryEntry {
  sourceId: string;
  round: string | number;
  content: string;
  terminal?: DeliveryTerminal;
}

export interface DeliveryDetails {
  batchId: string;
  sourceId: string;
  round: string | number;
  /** Distinguishes an Agent message from a host-produced terminal notice. */
  source: "agent" | "host";
  status: string;
  terminal?: DeliveryTerminal;
}

/** Shape accepted by `pi.sendMessage` (without transport options). */
export interface DeliveryCustomMessage {
  role: "custom";
  customType: typeof DELIVERY_CUSTOM_TYPE;
  content: string;
  display: true;
  details: DeliveryDetails;
  timestamp: number;
}

export interface DeliverySendOutcome {
  ok: boolean;
  batchId: string;
  error?: unknown;
}

export interface DeliveryEnqueueResult {
  accepted: boolean;
  batchId?: string;
  /** True when the entry updated an existing, still-pending slot. */
  coalesced?: boolean;
  reason?: "retired" | "inactive";
  /**
   * Resolves once this slot's one native send settles. It always resolves, so
   * an enqueue caller may ignore it without creating an unhandled rejection.
   * Ignoring it also avoids waiting for an idle-triggered parent run.
   */
  completion?: Promise<DeliverySendOutcome>;
}

export interface SteerDelivery {
  enqueue(entry: DeliveryEntry): DeliveryEnqueueResult;
  replaceMessage(message: AgentMessage): AgentMessage | undefined;
  /**
   * Report Pi's `message_start` for a native message. A batch that has started
   * may no longer be in the queue during preparation, so it stays mergeable
   * until `message_end` even when the pending oracle reports an empty queue.
   */
  messageStarted(message: AgentMessage): void;
  /**
   * Close the current source+round merge keys without discarding per-batch
   * lookups. Use this at an ordinary native input boundary: later content gets
   * a new batch, while an already prepared batch can still finalize.
   */
  breakMergeKeys(): void;
  /**
   * Native `agent_settled` bookkeeping: close merge keys and age unclaimed
   * batch lookups so repeated settles bound them even if no message_end arrives.
   */
  settle(): void;
  retire(): void;
}

export interface SteerDeliveryOptions {
  /**
   * Caller-owned native delivery. The caller decides trigger/steer options;
   * this module only supplies the custom-message payload.
   */
  send(entry: DeliveryCustomMessage): void | Promise<void>;
  /** Current host generation. A false result rejects new entries. */
  isActive?: () => boolean;
  /**
   * Optional oracle for whether this batch remains queued or host-buffered.
   * An aggregate native queue check is sufficient to prove emptiness, but an
   * owning caller can inspect its pending buffers and public steering preview
   * by batchId. It is only consulted before `message_start`; `false` sends a
   * fresh batch instead of updating a vanished snapshot. `true` or an
   * unavailable/throwing oracle keeps the conservative merge behavior.
   *
   * Do not pass `ctx.hasPendingMessages()` / `pendingMessageCount`: those
   * count only textual steering/follow-up inputs and exclude custom steered
   * messages.
   */
  hasPendingMessages?: (batchId: string) => boolean;
}

interface Slot {
  readonly key: string;
  readonly batchId: string;
  readonly sourceId: string;
  readonly round: string | number;
  /** Ordinary Agent contents in arrival order, including terminal summaries. */
  readonly contents: string[];
  /** Latest host terminal notice, retained even if ordinary content follows. */
  terminal?: DeliveryTerminal;
  details: DeliveryDetails;
  /** Pi emitted `message_start`: the snapshot is out of the queue. */
  started: boolean;
  /** Cleared on the next settle, retaining one settle of preparation grace. */
  dropOnSettle: boolean;
  readonly completion: Promise<DeliverySendOutcome>;
  readonly resolveCompletion: (outcome: DeliverySendOutcome) => void;
  sendFailed: boolean;
}

interface DeliveryCandidate {
  details: Record<string, unknown> & { batchId: string };
}

function keyFor(sourceId: string, round: string | number): string {
  // `1` and `"1"` name the same logical round; JSON also keeps arbitrary
  // source IDs from colliding through a separator character.
  return JSON.stringify([sourceId, String(round)]);
}

function formatDetails(details: unknown): string {
  if (typeof details === "string") return details;
  try {
    const serialized = JSON.stringify(details);
    return serialized === undefined ? String(details) : serialized;
  } catch {
    return String(details);
  }
}

function formatContent(
  sourceId: string,
  round: string | number,
  contents: readonly string[],
  terminal: DeliveryTerminal | undefined,
): string {
  const body = contents.join("\n\n");
  if (terminal === undefined) return body;
  const details =
    terminal.details === undefined ? "" : `: ${formatDetails(terminal.details)}`;
  const marker = `[Subagent ${sourceId} ${terminal.status} (round ${String(round)})]${details}`;
  // The terminal notice is a host boundary after all ordinary content, even
  // when a late ordinary message arrived after the terminal event.
  return body === "" ? marker : `${body}\n\n${marker}`;
}

function buildDetails(
  batchId: string,
  sourceId: string,
  round: string | number,
  terminal: DeliveryTerminal | undefined,
): DeliveryDetails {
  const details: DeliveryDetails = {
    batchId,
    sourceId,
    round,
    source: terminal === undefined ? "agent" : "host",
    status: terminal === undefined ? "running" : terminal.status,
  };
  if (terminal !== undefined) details.terminal = terminal;
  return details;
}

function deliveryCandidate(message: AgentMessage): DeliveryCandidate | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as {
    role?: unknown;
    customType?: unknown;
    details?: unknown;
  };
  if (candidate.role !== "custom" || candidate.customType !== DELIVERY_CUSTOM_TYPE) {
    return undefined;
  }
  if (typeof candidate.details !== "object" || candidate.details === null) {
    return undefined;
  }
  const details = candidate.details as Record<string, unknown>;
  if (typeof details.batchId !== "string" || details.batchId === "") return undefined;
  return { details: details as Record<string, unknown> & { batchId: string } };
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export function createSteerDelivery(options: SteerDeliveryOptions): SteerDelivery {
  const pendingByKey = new Map<string, Slot>();
  const pendingByBatch = new Map<string, Slot>();
  let retired = false;

  function active(): boolean {
    if (retired) return false;
    if (options.isActive === undefined) return true;
    try {
      return options.isActive() === true;
    } catch {
      // A host whose liveness check fails cannot accept a new delivery.
      return false;
    }
  }

  function removeSlot(slot: Slot): void {
    if (pendingByKey.get(slot.key) === slot) pendingByKey.delete(slot.key);
    if (pendingByBatch.get(slot.batchId) === slot) pendingByBatch.delete(slot.batchId);
  }

  function closeMergeKey(slot: Slot): void {
    // Keep pendingByBatch: a prepared snapshot may still produce message_start
    // and message_end after its queue entry disappeared.
    if (pendingByKey.get(slot.key) === slot) pendingByKey.delete(slot.key);
  }

  function nativePending(batchId: string): boolean | undefined {
    if (options.hasPendingMessages === undefined) return undefined;
    try {
      return options.hasPendingMessages(batchId) === true;
    } catch {
      // An unavailable oracle is not evidence that the snapshot vanished.
      return undefined;
    }
  }

  function resolveSend(slot: Slot, outcome: DeliverySendOutcome): void {
    slot.resolveCompletion(outcome);
  }

  function failSend(slot: Slot, error: unknown): void {
    slot.sendFailed = true;
    resolveSend(slot, { ok: false, batchId: slot.batchId, error });
  }

  function startSend(slot: Slot, payload: DeliveryCustomMessage): void {
    let outcome: void | Promise<void>;
    try {
      outcome = options.send(payload);
    } catch (error) {
      failSend(slot, error);
      return;
    }
    if (!isPromiseLike(outcome)) {
      resolveSend(slot, { ok: true, batchId: slot.batchId });
      return;
    }
    // Do not await from enqueue: an idle `triggerTurn` send can stay pending
    // for the whole parent run. The caller can observe completion explicitly.
    Promise.resolve(outcome).then(
      () => resolveSend(slot, { ok: true, batchId: slot.batchId }),
      (error: unknown) => failSend(slot, error),
    );
  }

  function createSlot(entry: DeliveryEntry): Slot {
    const batchId = randomUUID();
    let resolveCompletion!: (outcome: DeliverySendOutcome) => void;
    const completion = new Promise<DeliverySendOutcome>((resolve) => {
      resolveCompletion = resolve;
    });
    const details = buildDetails(
      batchId,
      entry.sourceId,
      entry.round,
      entry.terminal,
    );
    const contents = [entry.content];
    const content = formatContent(
      entry.sourceId,
      entry.round,
      contents,
      entry.terminal,
    );
    const slot: Slot = {
      key: keyFor(entry.sourceId, entry.round),
      batchId,
      sourceId: entry.sourceId,
      round: entry.round,
      contents,
      details,
      started: false,
      dropOnSettle: false,
      completion,
      resolveCompletion,
      sendFailed: false,
    };
    if (entry.terminal !== undefined) slot.terminal = entry.terminal;
    pendingByKey.set(slot.key, slot);
    pendingByBatch.set(batchId, slot);
    // The payload is a snapshot. Updating a slot never mutates an object that
    // Pi has queued; only `replaceMessage` supplies the later snapshot.
    startSend(slot, {
      role: "custom",
      customType: DELIVERY_CUSTOM_TYPE,
      content,
      display: true,
      details,
      timestamp: Date.now(),
    });
    return slot;
  }

  function enqueue(entry: DeliveryEntry): DeliveryEnqueueResult {
    if (typeof entry.sourceId !== "string" || entry.sourceId === "") {
      throw new TypeError("Delivery sourceId must be a non-empty string.");
    }
    if (typeof entry.round !== "string" && typeof entry.round !== "number") {
      throw new TypeError("Delivery round must be a string or number.");
    }
    if (typeof entry.content !== "string") {
      throw new TypeError("Delivery content must be a string.");
    }
    if (retired) return { accepted: false, reason: "retired" };
    if (!active()) return { accepted: false, reason: "inactive" };

    const key = keyFor(entry.sourceId, entry.round);
    const existing = pendingByKey.get(key);
    if (existing !== undefined && !existing.sendFailed) {
      // Any new content needs a fresh send if its earlier snapshot vanished.
      // Restricting this check to terminal entries would silently lose ordinary
      // messages sent after a native queue clear. The old lookup remains for
      // preparation races; the new batch never duplicates cleared content.
      if (!existing.started && nativePending(existing.batchId) === false) {
        closeMergeKey(existing);
      } else {
        // Production callers send deltas: append every ordinary message, with
        // no implicit dedup. Once a terminal notice exists, a later ordinary
        // message must not downgrade `source`/`status` or drop terminal metadata.
        existing.contents.push(entry.content);
        if (entry.terminal !== undefined) existing.terminal = entry.terminal;
        existing.details = buildDetails(
          existing.batchId,
          existing.sourceId,
          existing.round,
          existing.terminal,
        );
        return {
          accepted: true,
          batchId: existing.batchId,
          coalesced: true,
          completion: existing.completion,
        };
      }
    } else if (existing !== undefined) {
      // A failed native send is never resurrected or retried. New content gets
      // a new batch; the old failure stays observable through its completion.
      removeSlot(existing);
    }

    const slot = createSlot(entry);
    return {
      accepted: true,
      batchId: slot.batchId,
      coalesced: false,
      completion: slot.completion,
    };
  }

  function replaceMessage(message: AgentMessage): AgentMessage | undefined {
    const candidate = deliveryCandidate(message);
    if (candidate === undefined) return undefined;
    const slot = pendingByBatch.get(candidate.details.batchId);
    if (slot === undefined) return undefined;

    // Seal before returning: this handler's return is the effective merger
    // cutoff, a little earlier than Pi's history write.
    removeSlot(slot);
    const mergedDetails = { ...candidate.details, ...slot.details };
    return {
      ...message,
      content: formatContent(
        slot.sourceId,
        slot.round,
        slot.contents,
        slot.terminal,
      ),
      details: mergedDetails,
    } as AgentMessage;
  }

  function messageStarted(message: AgentMessage): void {
    const candidate = deliveryCandidate(message);
    if (candidate === undefined) return;
    const slot = pendingByBatch.get(candidate.details.batchId);
    if (slot !== undefined) slot.started = true;
  }

  function breakMergeKeys(): void {
    pendingByKey.clear();
  }

  function settle(): void {
    // A run boundary closes coalescing for every old batch. Batch lookups get
    // one settle of grace so a preparation race can still finalize; the next
    // settle drops anything no message_end claimed.
    pendingByKey.clear();
    for (const slot of [...pendingByBatch.values()]) {
      if (slot.dropOnSettle) removeSlot(slot);
      else slot.dropOnSettle = true;
    }
  }

  function retire(): void {
    retired = true;
    pendingByKey.clear();
    pendingByBatch.clear();
  }

  return {
    enqueue,
    replaceMessage,
    messageStarted,
    breakMergeKeys,
    settle,
    retire,
  };
}
