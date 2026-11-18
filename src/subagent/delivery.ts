/**
 * One independent custom message per peer event. Pi owns queueing and execution.
 *
 * The envelope is built here once and consumed by both delivery paths:
 *
 * - `NativeDeliveryRouter` sends it to Main or hands it to the runner;
 * - the native Job runner builds the very same envelope for a peer hand-over and
 *   for startup input, so a peer event and a run's buffered input enter native
 *   history with one shape.
 *
 * Host notifications never synthesize a collaborator result: a Job's terminal
 * state is an internal wake, not a model-visible message. `deliveryEntryFor` is
 * therefore the one RuntimeDelivery-to-entry mapping and only peer messages
 * reach it.
 */

import { formatPeerMessage } from './prompt.ts';
import type { RuntimeDelivery } from "./runtime.ts";

export const DELIVERY_CUSTOM_TYPE = "agent-delivery";

export interface DeliveryEntry {
  sourceId: string;
  round: string | number;
  content: string;
  /** Sender Job id, when the runtime supplies one. */
  jobId?: string;
}

export interface DeliveryDetails {
  sourceId: string;
  round: string | number;
  source: "agent";
  jobId?: string;
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
  external?: { readonly sessionId: string; readonly sender: string; readonly replyTo: string } | undefined;
}

/**
 * Build the one native custom message for a peer event. The sender label is
 * part of `content` exactly once; no caller re-formats or merges it.
 */
export function deliveryMessage(entry: DeliveryEntry): DeliveryCustomMessage {
  return {
    role: "custom",
    customType: DELIVERY_CUSTOM_TYPE,
    content: entry.content,
    display: true,
    details: {
      sourceId: entry.sourceId,
      round: entry.round,
      source: "agent",
      ...(entry.jobId === undefined ? {} : { jobId: entry.jobId }),
    },
    timestamp: Date.now(),
  };
}

/** The peer entry: the shared message label, the sender's round and Job id. */
export function peerDeliveryEntry(input: PeerDeliveryInput): DeliveryEntry {
  const jobId = input.jobId ?? undefined;
  return {
    // A cross-session sender is displayed by its full identity, never as a
    // local Main plus a second session field.
    sourceId: input.external?.sender ?? input.from,
    round: input.round ?? 1,
    content: formatPeerMessage({ from: input.from, content: input.content,
      ...(input.external === undefined ? {} : { external: input.external }) }),
    ...(jobId === undefined ? {} : { jobId }),
  };
}

/** Map one peer message to its delivery entry. */
export function deliveryEntryFor(message: RuntimeDelivery): DeliveryEntry {
  return peerDeliveryEntry({
    from: message.from,
    content: message.content,
    ...(message.round === undefined ? {} : { round: message.round }),
    ...(message.jobId === undefined ? {} : { jobId: message.jobId }),
    ...(message.external === undefined ? {} : { external: message.external }),
  });
}

export function sendDelivery(
  entry: DeliveryEntry,
  options: {
    send(message: DeliveryCustomMessage): void | Promise<void>;
    isActive?: () => boolean;
  },
): DeliveryResult {
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
