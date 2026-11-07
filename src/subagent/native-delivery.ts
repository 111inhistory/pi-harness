import { sendDelivery, deliveryEntryFor, type DeliveryCustomMessage } from './delivery.ts';
import type { NativeJobRunner } from './native-runner.ts';
import type { NativeCustomHandoff } from './native-types.ts';
import { SubagentError, type DeliverMessageRequest, type DeliveryOutcome, type RuntimeDelivery } from './runtime.ts';

export interface NativeDeliveryDeps {
  readonly runner: Pick<NativeJobRunner, 'handoff' | 'handoffCustom'>;
  ownsContext(): boolean;
  canWake(): boolean;
  sendToMain(message: DeliveryCustomMessage, triggerTurn: boolean): void | Promise<void>;
  /** Make the reply tool available before an external peer message wakes Main. */
  activateReply(): void;
  appendRetained(agentId: string, message: NativeCustomHandoff): Promise<boolean>;
  onError(error: Error): void;
}

class HandoffRefused extends Error {}

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

/** Routes one event; NativeJobRunner alone owns the SDK input queue. */
export class NativeDeliveryRouter {
  readonly #deps: NativeDeliveryDeps;
  constructor(deps: NativeDeliveryDeps) { this.#deps = deps; }

  async toMain(message: RuntimeDelivery): Promise<void> {
    const external = message.type === 'message' && message.external !== undefined;
    const result = sendDelivery(deliveryEntryFor(message), {
      isActive: () => this.#deps.ownsContext(),
      send: (payload) => {
        // A cross-session peer addresses Main directly. Load the reply tool only
        // after ownership is confirmed and before the triggered turn builds its
        // loadout; a stale root must not activate a tool in the current root.
        if (external) this.#deps.activateReply();
        return this.#deps.sendToMain(payload, this.#deps.canWake());
      },
    });
    if (!result.accepted) throw new SubagentError('runtime_closed', 'The original root no longer owns this notification.');
    const handoff = await result.completion;
    if (!handoff?.ok) throw asError(handoff?.error ?? new Error('The root message handoff failed.'));
  }

  async toAgent(request: DeliverMessageRequest): Promise<DeliveryOutcome> {
    if (!this.#deps.ownsContext()) return { accepted: false, reason: 'runtime_retired' };
    const { agentId, jobId, message } = request;
    if (message.type === 'message') {
      if (jobId === null) return { accepted: false, reason: 'job_closed' };
      return this.#deps.runner.handoff(jobId, message);
    }
    // A terminal notice belongs to the parent's current Job. It is handed to
    // that live job when one exists and retained for a stopping/closed/stopped
    // parent; a notice never allocates a continuation Job.
    const payloadEntry = deliveryEntryFor(message);
    let retained: NativeCustomHandoff | undefined;
    const result = sendDelivery(payloadEntry, {
      isActive: () => this.#deps.ownsContext(),
      send: async (payload) => {
        retained = { from: message.from, customType: payload.customType, content: payload.content,
          display: payload.display, details: payload.details };
        if (!this.#deps.canWake() || jobId === null) throw new HandoffRefused('No live parent Job is available.');
        const outcome = await this.#deps.runner.handoffCustom(jobId, retained);
        if (!outcome.accepted) throw new HandoffRefused(outcome.reason ?? 'Native input is closed.');
      },
    });
    if (!result.accepted) return { accepted: false, reason: 'runtime_retired' };
    const completion = await result.completion;
    if (completion?.ok) return { accepted: true, mode: 'delivered' };
    if (completion?.error instanceof HandoffRefused && retained !== undefined) {
      try {
        const appended = await this.#deps.appendRetained(agentId, retained);
        return { accepted: appended, mode: 'retained', ...(appended ? {} : { reason: 'no_retained_session' }) };
      } catch (error) {
        this.#deps.onError(asError(error));
        return { accepted: false, reason: 'retained_append_failed' };
      }
    }
    // An arbitrary SDK rejection is not proof that nothing was enqueued.
    // Report it; appending/replaying here could deliver the terminal twice.
    this.#deps.onError(asError(completion?.error ?? new Error('Native notification handoff failed.')));
    return { accepted: false, reason: 'delivery_uncertain' };
  }
}
