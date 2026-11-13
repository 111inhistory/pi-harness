/**
 * Pure lifecycle decisions shared by the Subagent runtime and its host adapter.
 *
 * This module intentionally owns no SDK object, timer, socket or registry entry.
 * It answers the questions both sides must answer the same way:
 *
 * - Which reason wins when several terminal transitions become visible?
 * - What does one terminal notification say about its Job and execution round?
 */

export type TerminalStatus = "completed" | "failed" | "cancelled";

export interface LifecycleError {
  code: string;
  message: string;
  detail?: unknown;
}

export interface StoppingReason {
  status: TerminalStatus;
  error: LifecycleError | null;
}

export interface TerminalDecisionInput {
  /** Reason recorded when the Job first entered `stopping`, if it did. */
  stopping: StoppingReason | null;
  /** Public Budget failure, or null when the Budget has not failed. */
  budgetError: LifecycleError | null;
  /** Normalized execution error reported by the adapter. */
  executionError: LifecycleError | null;
  /** Status reported by the adapter, if any. */
  executionStatus: string | null;
}

export interface TerminalDecision {
  status: TerminalStatus;
  error: LifecycleError | null;
}

/**
 * Preserve the first effective stopping reason.
 *
 * A later observation must not rewrite why a Job is stopping. Cancellation
 * before a Budget failure therefore stays a cancellation; a Budget failure
 * observed while the Job is still running stays the recorded failure reason.
 */
export function firstEffectiveStopping(
  current: StoppingReason | null,
  next: StoppingReason,
): StoppingReason {
  return current ?? next;
}

/**
 * Freeze the one terminal status and error of a Job.
 *
 * Ordering is part of the contract:
 *
 * 1. A recorded stopping reason wins: it was decided while the native run was
 *    still alive and must survive that run's eventual return value.
 * 2. Otherwise a failed Budget wins over the adapter's own payload.
 * 3. Otherwise the adapter's failed/cancelled report decides.
 * 4. Otherwise the Job completed.
 */
export function adjudicateTerminal(input: TerminalDecisionInput): TerminalDecision {
  if (input.stopping !== null) {
    return { status: input.stopping.status, error: input.stopping.error };
  }
  if (input.budgetError !== null) {
    return { status: "failed", error: input.budgetError };
  }
  if (input.executionError !== null) {
    return { status: "failed", error: input.executionError };
  }
  if (input.executionStatus === "failed") {
    return { status: "failed", error: null };
  }
  if (input.executionStatus === "cancelled") {
    return { status: "cancelled", error: { code: "cancelled", message: "Job cancelled." } };
  }
  return { status: "completed", error: null };
}

export interface TerminalNotificationInput {
  agentId: string;
  jobId: string;
  round: number;
  name?: string | null;
  status: TerminalStatus;
  content: string;
  error?: LifecycleError | null;
  history: unknown;
}

export interface TerminalNotification {
  type: "notification";
  from: string;
  subagentId: string;
  jobId: string;
  round: number;
  name?: string | null;
  status: TerminalStatus;
  content: string;
  error: string | null;
  history: unknown;
}

/**
 * Build the host-owned terminal envelope.
 *
 * `from`, `jobId` and `round` identify the sender and execution round of this
 * independent notification.
 */
export function terminalNotification(input: TerminalNotificationInput): TerminalNotification {
  const notification: TerminalNotification = {
    type: "notification",
    from: input.agentId,
    subagentId: input.agentId,
    jobId: input.jobId,
    round: input.round,
    status: input.status,
    content: input.content,
    error: input.error === null || input.error === undefined ? null : input.error.message,
    history: input.history,
  };
  if (input.name !== undefined) notification.name = input.name;
  return notification;
}

export type QueueMode = "all" | "one-at-a-time";

/**
 * The public queue surface shared by Pi's Agent and AgentSession.
 *
 * `peekQueuedMessages()` intentionally returns only the next batch in the
 * configured mode. Reading both queues losslessly therefore needs a temporary
 * probe: with both modes set to `all`, a probe in one queue makes that queue
 * selected, so every original message in it can be read before clearing it.
 */
export interface QueueCapable {
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  steer(message: unknown): void;
  followUp(message: unknown): void;
  peekQueuedMessages(): unknown[];
  clearSteeringQueue(): void;
  clearFollowUpQueue(): void;
}

/**
 * Read and clear every queued steering and follow-up message, preserving order
 * within each queue. The probe messages are removed by identity, so arbitrary
 * custom-message content (including text that looks like a probe) is untouched.
 *
 * Modes are restored even if a queue operation throws. The caller remains
 * responsible for clearing any AgentSession text mirrors after the Agent queues
 * are empty.
 */
export function takeQueuedMessages(
  agent: QueueCapable,
  createProbe: (queue: "steering" | "followUp") => unknown,
): unknown[] {
  const steeringMode = agent.steeringMode;
  const followUpMode = agent.followUpMode;
  try {
    agent.steeringMode = "all";
    agent.followUpMode = "all";

    const steeringProbe = createProbe("steering");
    agent.steer(steeringProbe);
    const steering = agent.peekQueuedMessages().filter((message) => message !== steeringProbe);
    agent.clearSteeringQueue();

    const followUpProbe = createProbe("followUp");
    agent.followUp(followUpProbe);
    const followUp = agent.peekQueuedMessages().filter((message) => message !== followUpProbe);
    agent.clearFollowUpQueue();

    return [...steering, ...followUp];
  } finally {
    agent.steeringMode = steeringMode;
    agent.followUpMode = followUpMode;
  }
}
