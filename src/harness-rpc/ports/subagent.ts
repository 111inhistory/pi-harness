/**
 * Subagent-control port for the Harness RPC endpoint.
 *
 * Every operation enters through the current root service resolver's domain
 * methods; nothing caches a retired RootService or bypasses the epoch/admission
 * fences. Queries never reuse the TUI's per-group display window: an unknown Job
 * and a not-yet-settled Job are reported distinctly from an empty result.
 *
 * Creating agents binds parent identity, root session, cwd and inherited capture
 * on the host side; the client supplies only task text. A registered batch whose
 * local preparation then fails still reports its registered items — it never
 * implies the whole batch had no effect.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import path from 'node:path';

import type { RootService } from '../../subagent/root-service.ts';
import { captureContextForChild } from '../../subagent/surface.ts';
import type { CreatedAgents, JobRecordView, JobView } from '../../subagent/runtime.ts';
import { isIpcPath, isWindowsPipe } from '../../ipc/socket.ts';
import { RPC_ERROR } from '../protocol.ts';
import { RpcRequestError } from '../error.ts';
import { asRecord, optionalStringArray, requireString } from '../util.ts';

export interface SubagentPort {
  tree(): Promise<unknown>;
  jobs(params: unknown): { jobs: readonly JobView[] };
  job(params: unknown): { job: JobView; record: JobRecordView | null };
  result(params: unknown): JobRecordView;
  create(params: unknown): Promise<CreatedAgents>;
  stop(params: unknown): unknown;
  send(params: unknown): Promise<unknown>;
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
    tree(): Promise<unknown> {
      // `all` reads the whole tree, not the TUI's windowed sibling rows.
      return root.list({ all: true }, 'Main');
    },

    jobs(params: unknown): { jobs: readonly JobView[] } {
      const jobIds = optionalStringArray(asRecord(params).jobIds);
      return root.runtime.jobs(jobIds === undefined ? null : { jobIds });
    },

    job(params: unknown): { job: JobView; record: JobRecordView | null } {
      const jobId = requireString(asRecord(params).jobId, 'jobId');
      const job = requireJob(jobId);
      return { job, record: root.runtime.jobRecord(jobId) };
    },

    result(params: unknown): JobRecordView {
      const jobId = requireString(asRecord(params).jobId, 'jobId');
      const record = root.runtime.jobRecord(jobId);
      if (record !== null) return record;
      // Distinguish "does not exist" from "not settled yet" instead of returning empty.
      if (findJobView(root, jobId) === undefined) {
        throw new RpcRequestError(RPC_ERROR.notFound, `No Job with id "${jobId}".`);
      }
      throw new RpcRequestError(RPC_ERROR.notReady, `Job "${jobId}" has not settled yet.`);
    },

    async create(params: unknown): Promise<CreatedAgents> {
      const input = asRecord(params);
      const tasks = input.tasks;
      if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new RpcRequestError(RPC_ERROR.invalidRequest, 'The "tasks" parameter must be a non-empty array.');
      }
      const context = typeof input.context === 'string' ? { context: input.context } : {};
      const batch = { ...context, tasks };
      // The host binds parent identity, cwd, session and inherited capture; the
      // client never supplies trusted identity or raw inherited entries.
      return root.create(batch, {
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
    },

    stop(params: unknown): unknown {
      const id = requireString(asRecord(params).id, 'id');
      return root.stop(id);
    },

    async send(params: unknown): Promise<unknown> {
      const input = asRecord(params);
      const rawPath = requireString(input.path, 'path');
      if (typeof input.content !== 'string') {
        throw new RpcRequestError(RPC_ERROR.invalidRequest, 'The "content" parameter must be a string.');
      }
      // Same managed-endpoint semantics as msg_write: a `path` address is
      // resolved to this root's recipient (or to another session's Main), never
      // treated as a bare actor id.
      if (!isIpcPath(rawPath) && !isWindowsPipe(rawPath)) {
        throw new RpcRequestError(RPC_ERROR.invalidRequest, 'message.send requires a managed endpoint address in "path".');
      }
      const address = isWindowsPipe(rawPath) ? rawPath : path.resolve(ctx.cwd, rawPath);
      const from = 'Main';
      const endpoint = await root.resolveEndpoint(address);
      if (!endpoint.isManaged) {
        const target = await root.sessionEndpoint(address);
        if (target.kind === 'foreign') {
          throw new RpcRequestError('invalid_target', 'Cross-session messages are Main-to-Main only.');
        }
        if (target.kind === 'session') {
          // Cross-session coordination is Main-to-Main; the receiver still owns admission.
          await root.sendCrossSession({ target: target.session, content: input.content });
          return { ok: true, delivered: 'session', path: rawPath };
        }
        throw new RpcRequestError('unmanaged_endpoint', `No registered Agent owns this IPC address: ${rawPath}`);
      }
      let to: string;
      if (endpoint.isBroadcast) {
        if (endpoint.parentId === undefined || endpoint.parentId.toLowerCase() !== 'main') {
          throw new RpcRequestError('invalid_target', 'Only the parent may write its broadcast endpoint.');
        }
        to = 'all';
      } else {
        if (endpoint.targetId === undefined) {
          throw new RpcRequestError('unknown_endpoint', 'The managed endpoint has no registered recipient.');
        }
        to = endpoint.targetId;
      }
      // Preserve the domain receipt (single result or per-recipient broadcast outcome).
      return root.sendMessage({ from, to, content: input.content });
    },
  };
}
