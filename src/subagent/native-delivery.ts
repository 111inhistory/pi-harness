/**
 * Routes one delivery event into the root or into a live native Job.
 *
 * A peer message is the only model-visible delivery: terminal Job state stays
 * an internal wake owned by the runtime/root. The runner alone owns the SDK
 * input queue, so this module only checks root ownership and forwards.
 */

import { sendDelivery, deliveryEntryFor, type DeliveryCustomMessage } from './delivery.ts';
import type { NativeJobRunner } from './native-runner.ts';
import { SubagentError, type DeliverMessageRequest, type DeliveryOutcome } from './runtime.ts';

export interface NativeDeliveryDeps {
  readonly runner: Pick<NativeJobRunner, 'handoff'>;
  ownsContext(): boolean;
  canWake(): boolean;
  sendToMain(message: DeliveryCustomMessage, triggerTurn: boolean): void | Promise<void>;
  /** Make the reply tool available before an external peer message wakes Main. */
  activateReply(): void;
}

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

/** One admission check and one forward; the runner owns the native queue. */
export class NativeDeliveryRouter {
  readonly #deps: NativeDeliveryDeps;
  constructor(deps: NativeDeliveryDeps) { this.#deps = deps; }

  async toMain(message: DeliverMessageRequest['message']): Promise<void> {
    const external = message.external !== undefined;
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
    if (request.jobId === null) return { accepted: false, reason: 'job_closed' };
    return this.#deps.runner.handoff(request.jobId, request.message);
  }
}
