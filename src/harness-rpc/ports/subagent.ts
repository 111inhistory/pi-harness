/**
 * Subagent-control port for the Harness RPC endpoint.
 *
 * Every operation enters through the current root service resolver's domain
 * methods; nothing caches a retired RootService or bypasses the epoch/admission
 * fences. Queries never reuse the TUI's per-group display window: an unknown Job
 * and a not-yet-settled Job are reported distinctly from an empty result.
 *
 * Creating a batch binds parent identity, root session, cwd and inherited
 * capture on the host side; the client supplies the goal, shared context and
 * the declared members. A registered batch whose local preparation then fails
 * still reports its registered items — it never implies the whole batch had no
 * effect.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { sendManagedMessage } from '../../subagent/managed-send.ts';

import type { RootService } from '../../subagent/root-service.ts';
import { captureContextForChild, projectCreatedBatch, type CreatedBatchView } from '../../subagent/surface.ts';
import { MAIN_ACTOR } from '../../subagent/address.ts';
import type { DetailedAgentItem, JobRecordView, JobView, SignalResult } from '../../subagent/runtime.ts';
import type {
  JobIdParams,
  JobsListParams,
  MessageSendParams,
  MessageSendResult,
  SubagentCreateParams,
  SubagentSignalParams,
} from '../contract.ts';
import { RPC_ERROR } from '../protocol.ts';
import { RpcRequestError } from '../error.ts';

export interface SubagentPort {
  tree(): Promise<DetailedAgentItem | null>;
  jobs(params: JobsListParams): { readonly jobs: readonly JobView[] };
  job(params: JobIdParams): { readonly job: JobView; readonly record: JobRecordView | null };
  result(params: JobIdParams): JobRecordView;
  create(params: SubagentCreateParams): Promise<CreatedBatchView>;
  signal(params: SubagentSignalParams): Promise<SignalResult>;
  send(params: MessageSendParams): Promise<MessageSendResult>;
}

function findJobView(root: RootService, jobId: string): JobView | undefined {
  return root.runtime.jobs().jobs.find((job) => job.jobId === jobId);
}

export function buildSubagentPort(api: ExtensionAPI, ctx: ExtensionContext, root: RootService): SubagentPort {
  const requireJob = (jobId: string): JobView => {
    const job = findJobView(root, jobId);
    if (job === undefined) throw new RpcRequestError(RPC_ERROR.notFound, `No Job with id "${jobId}".`);
    return job;
  };

  return {
    tree(): Promise<DetailedAgentItem | null> {
      // `all` reads the whole tree, not the TUI's windowed sibling rows.
      return root.list({ all: true }, MAIN_ACTOR);
    },

    jobs(params: JobsListParams): { readonly jobs: readonly JobView[] } {
      return root.runtime.jobs(params.jobIds === undefined ? null : { jobIds: params.jobIds });
    },

    job(params: JobIdParams): { readonly job: JobView; readonly record: JobRecordView | null } {
      const job = requireJob(params.jobId);
      return { job, record: root.runtime.jobRecord(params.jobId) };
    },

    result(params: JobIdParams): JobRecordView {
      const record = root.runtime.jobRecord(params.jobId);
      if (record !== null) return record;
      // Distinguish "does not exist" from "not settled yet" instead of returning empty.
      if (findJobView(root, params.jobId) === undefined) {
        throw new RpcRequestError(RPC_ERROR.notFound, `No Job with id "${params.jobId}".`);
      }
      throw new RpcRequestError(RPC_ERROR.notReady, `Job "${params.jobId}" has not settled yet.`);
    },

    async create(params: SubagentCreateParams): Promise<CreatedBatchView> {
      // The host binds parent identity, cwd, session and inherited capture; the
      // client never supplies trusted identity or raw inherited entries.
      const created = await root.create(params, {
        parentAgentId: null,
        allowInherited: true,
        origin: {
          cwd: ctx.cwd,
          trusted: ctx.isProjectTrusted(),
          sessionId: ctx.sessionManager.getSessionId(),
          agentId: null,
          mode: ctx.mode,
        },
        captureInheritedContext: () => captureContextForChild(api, ctx, 1, root.maxDepth),
      }, ctx);
      return projectCreatedBatch(created);
    },

    signal(params: SubagentSignalParams): Promise<SignalResult> {
      return root.signal(params.target, params.action, MAIN_ACTOR);
    },

    async send(params: MessageSendParams): Promise<MessageSendResult> {
      return sendManagedMessage(root, { senderId: MAIN_ACTOR, ...params });
    },
  };
}
