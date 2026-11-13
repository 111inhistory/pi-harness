/**
 * Child execution-stream port for the Harness RPC endpoint.
 *
 * `stream.subscribe` attaches to a live Job's full native event stream and
 * returns a real read boundary in the same response. The boundary is taken from
 * the native live snapshot: the recorded start/end of what the Job produced so
 * far plus the cumulative assistant partial the provider is streaming right
 * now. The subscription is attached before the snapshot is read (both
 * synchronous), so a client can render `boundary.messages`/`boundary.partial`
 * and then apply `message_update` deltas without a gap.
 *
 * The Runtime's Job terminal state is a different boundary from `agent_end` /
 * `agent_settled`; the stream reports it as a separate `job` event through a
 * detachable Runtime observer. Teardown releases both the native listener and
 * that observer, so an unsubscribed connection is not retained until the Job
 * settles. Observation never affects the Job.
 */

import type { RootService } from '../../subagent/root-service.ts';
import type { RpcConnection } from '../transport.ts';
import type {
  JobIdParams,
  StreamBoundary,
  StreamSubscribeResult,
  StreamUnsubscribeParams,
  StreamUnsubscribeResult,
} from '../contract.ts';
import { RPC_ERROR } from '../protocol.ts';
import { RpcRequestError } from '../error.ts';
import { projectSessionEvent } from '../stream-projection.ts';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export type { StreamBoundary };

export interface StreamPort {
  subscribe(params: JobIdParams, connection: RpcConnection): Promise<StreamSubscribeResult>;
  unsubscribe(params: StreamUnsubscribeParams, connection: RpcConnection): StreamUnsubscribeResult;
}

export function buildStreamPort(root: RootService): StreamPort {
  return {
    async subscribe(params: JobIdParams, connection: RpcConnection): Promise<StreamSubscribeResult> {
      const jobId = params.jobId;
      // Works for a running Job too; `jobRecord` is intentionally terminal-only.
      const snapshot = root.runtime.jobSnapshot(jobId);
      if (snapshot === null) throw new RpcRequestError(RPC_ERROR.notFound, `No Job with id "${jobId}".`);

      let active = true;
      let liveUnsubscribe: (() => void) | null = null;
      let terminalUnsubscribe: (() => void) | null = null;
      // Assign the subscription id before registering the listener. The
      // transport writes the response only after this async handler resolves,
      // so a native event can be pushed first; it must already carry the id the
      // client will use to correlate it with the response boundary.
      const subscriptionId = connection.addSubscription(() => {
        active = false;
        liveUnsubscribe?.();
        terminalUnsubscribe?.();
      });
      // Attach before reading the live snapshot. Both calls are synchronous and
      // the runner only registers the listener (it does not replay), so no
      // native event can interleave between this registration and the snapshot.
      liveUnsubscribe = root.subscribeJobEvents(jobId, (event) => {
        if (!active) return;
        connection.pushEvent(subscriptionId, {
          kind: 'session',
          rootSessionId: root.sessionId,
          jobId,
          agentId: snapshot.agentId,
          event: projectSessionEvent(event),
        });
      });
      const live = root.liveSnapshot(jobId);

      const start = snapshot.history?.startEntryId ?? null;
      const end = live?.endEntryId ?? snapshot.history?.endEntryId ?? null;
      const boundary: StreamBoundary = {
        status: snapshot.status,
        round: snapshot.round,
        history: start === null && end === null ? null : { startEntryId: start, endEntryId: end },
        messages: live?.messages ?? [],
        partial: live?.partial ?? null,
      };

      // A live Job's Runtime terminal state is reported separately from the
      // native agent_end/agent_settled events. A Job that is already terminal
      // has no future transition; its state is in the response boundary.
      if (!TERMINAL.has(snapshot.status)) {
        terminalUnsubscribe = root.runtime.observeJobDone(jobId, (view) => {
          if (!active) return;
          connection.pushEvent(subscriptionId, {
            kind: 'job',
            rootSessionId: root.sessionId,
            jobId,
            agentId: view.agentId,
            status: view.status,
          });
        });
      }

      return {
        subscription: subscriptionId,
        jobId,
        agentId: snapshot.agentId,
        rootSessionId: root.sessionId,
        live: liveUnsubscribe !== null,
        boundary,
      };
    },

    unsubscribe(params: StreamUnsubscribeParams, connection: RpcConnection): StreamUnsubscribeResult {
      return { removed: connection.removeSubscription(params.subscription) };
    },
  };
}
