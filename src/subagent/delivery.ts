/**
 * One independent custom message per event. Pi owns queueing and execution.
 *
 * The envelope is built here once and consumed by both delivery paths:
 *
 * - `NativeDeliveryRouter` sends it to Main or hands it to the runner;
 * - the native Job runner builds the very same envelope for a peer hand-over and
 *   for startup input, so a peer event, a terminal notice and a run's buffered
 *   input all enter native history with one shape.
 *
 * `deliveryEntryFor` is the shared RuntimeDelivery-to-entry mapping; the runner
 * uses it for startup input instead of formatting a second, text-only shape.
 * The delivery router can switch its own local mapping to it as well.
 */

import { formatPeerMessage } from './prompt.ts';
import type { TerminalNotification } from "./lifecycle.ts";
import type { RuntimeDelivery } from "./runtime.ts";

export const DELIVERY_CUSTOM_TYPE = "agent-delivery";

export interface DeliveryTerminal {
  status: string;
  details?: unknown;
}

export interface DeliveryEntry {
  sourceId: string;
  round: string | number;
  content: string;
  /** Sender Job id, when the runtime supplies one. */
  jobId?: string;
  terminal?: DeliveryTerminal;
}

export interface DeliveryDetails {
  sourceId: string;
  round: string | number;
  source: "agent" | "host";
  status: string;
  jobId?: string;
  terminal?: DeliveryTerminal;
}

export interface DeliveryCustomMessage {
  role: "custom";
  customType: typeof DELIVERY_CUSTOM_TYPE;
  content: string;
  display: true;
  details: DeliveryDetails;
  timestamp: number;
}

export interface DeliveryResult {
  accepted: boolean;
  reason?: "inactive";
  /** Native handoff only, not model acknowledgement. Never rejects. */
  completion?: Promise<{ ok: boolean; error?: unknown }>;
}

/** The peer input shape a hand-over carries; round defaults to the first. */
export interface PeerDeliveryInput {
  from: string;
  content: string;
  round?: string | number | undefined;
  jobId?: string | null | undefined;
}

function validateDeliveryEntry(entry: DeliveryEntry): void {
  if (typeof entry.sourceId !== "string" || entry.sourceId === "") throw new TypeError("Delivery sourceId must be a non-empty string.");
  if (typeof entry.round !== "string" && typeof entry.round !== "number") throw new TypeError("Delivery round must be a string or number.");
  if (typeof entry.content !== "string") throw new TypeError("Delivery content must be a string.");
  if (entry.jobId !== undefined && typeof entry.jobId !== "string") throw new TypeError("Delivery jobId must be a string when provided.");
}

function formatDetails(details: unknown): string {
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details) ?? String(details);
  } catch {
    return String(details);
  }
}

/**
 * Build the one native custom message for an event. The terminal marker is part
 * of the content exactly once; no caller re-formats or merges it.
 */
export function deliveryMessage(entry: DeliveryEntry): DeliveryCustomMessage {
  validateDeliveryEntry(entry);
  let content = entry.content;
  if (entry.terminal !== undefined) {
    const details = entry.terminal.details === undefined ? "" : `: ${formatDetails(entry.terminal.details)}`;
    const marker = `[Subagent ${entry.sourceId} ${entry.terminal.status} (round ${String(entry.round)})]${details}`;
    content = content === "" ? marker : `${content}\n\n${marker}`;
  }
  return {
    role: "custom", customType: DELIVERY_CUSTOM_TYPE, content, display: true,
    details: { sourceId: entry.sourceId, round: entry.round,
      source: entry.terminal === undefined ? "agent" : "host",
      status: entry.terminal?.status ?? "running",
      ...(entry.jobId === undefined ? {} : { jobId: entry.jobId }),
      ...(entry.terminal === undefined ? {} : { terminal: entry.terminal }),
    },
    timestamp: Date.now(),
  };
}

/** The peer entry: the shared message label, the sender's round and Job id. */
export function peerDeliveryEntry(input: PeerDeliveryInput): DeliveryEntry {
  const jobId = input.jobId ?? undefined;
  return {
    sourceId: input.from,
    round: input.round ?? 1,
    content: formatPeerMessage({ from: input.from, content: input.content }),
    ...(jobId === undefined ? {} : { jobId }),
  };
}

function noticeDetails(notice: TerminalNotification): Record<string, unknown> {
  return { type: notice.type, from: notice.from, subagentId: notice.subagentId,
    jobId: notice.jobId, round: notice.round, status: notice.status,
    error: notice.error, history: notice.history };
}

/**
 * Map one runtime event to its delivery entry. A peer message keeps its sender,
 * round and Job id; a terminal notice keeps its status and details so the native
 * content carries the one marker the terminal path always used.
 */
export function deliveryEntryFor(message: RuntimeDelivery): DeliveryEntry {
  if (message.type === "message") {
    return peerDeliveryEntry({
      from: message.from,
      content: message.content,
      ...(message.round === undefined ? {} : { round: message.round }),
      ...(message.jobId === undefined ? {} : { jobId: message.jobId }),
    });
  }
  return { sourceId: message.subagentId, round: message.round, jobId: message.jobId, content: message.content,
    terminal: { status: message.status, details: noticeDetails(message) } };
}

export function sendDelivery(
  entry: DeliveryEntry,
  options: {
    send(message: DeliveryCustomMessage): void | Promise<void>;
    isActive?: () => boolean;
  },
): DeliveryResult {
  validateDeliveryEntry(entry);
  try {
    if (options.isActive !== undefined && !options.isActive()) return { accepted: false, reason: "inactive" };
  } catch {
    return { accepted: false, reason: "inactive" };
  }
  const message = deliveryMessage(entry);
  try {
    const completion = Promise.resolve(options.send(message)).then(
      () => ({ ok: true }), (error: unknown) => ({ ok: false, error }),
    );
    return { accepted: true, completion };
  } catch (error) {
    return { accepted: true, completion: Promise.resolve({ ok: false, error }) };
  }
}
