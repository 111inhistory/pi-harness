/**
 * Job-history read port for the Harness RPC endpoint.
 *
 * History is read from the Job's recorded native entry interval and native
 * messages, never by parsing the `views/` display files. A running Job returns
 * the interval produced so far (start boundary up to the live end), so a client
 * can render completed history and then consume live deltas from the stream
 * snapshot. A memory-only session has no durable interval and reports
 * `history_unavailable` explicitly.
 */

import type { RootService } from '../../subagent/root-service.ts';
import type { HistoryReadResult, JobIdParams } from '../contract.ts';
import { RPC_ERROR } from '../protocol.ts';
import { RpcRequestError } from '../error.ts';

export type JobHistoryResult = HistoryReadResult;

export interface HistoryPort {
  read(params: JobIdParams): HistoryReadResult;
}

export function buildHistoryPort(root: RootService): HistoryPort {
  return {
    read(params: JobIdParams): HistoryReadResult {
      const snapshot = root.runtime.jobSnapshot(params.jobId);
      if (snapshot === null) throw new RpcRequestError(RPC_ERROR.notFound, `No Job with id "${params.jobId}".`);

      if (snapshot.history === null) {
        // The Job is registered but its native start boundary is not recorded yet.
        return { available: false, jobId: params.jobId, status: snapshot.status, reason: 'history_unavailable' };
      }
      // A null startEntryId is a legitimate first-Job interval (the SDK leaf was
      // null before the session recorded anything), not "not started": read from
      // the branch head and return the null start verbatim.
      const start = snapshot.history.startEntryId;
      const liveEnd = root.liveEndEntryId(params.jobId);
      const live = liveEnd !== undefined;
      const end = liveEnd ?? snapshot.history.endEntryId ?? null;
      const entries = root.actors.readInterval({
        agentId: snapshot.agentId,
        startEntryId: start,
        endEntryId: end,
      });
      if (entries === null) {
        return { available: false, jobId: params.jobId, status: snapshot.status, reason: 'history_unavailable' };
      }
      return {
        available: true,
        jobId: params.jobId,
        status: snapshot.status,
        live,
        bounds: { startEntryId: start, endEntryId: end },
        entries,
      };
    },
  };
}
