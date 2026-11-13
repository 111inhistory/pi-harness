import path from 'node:path';
import { isIpcPath, isWindowsPipe, type EndpointResolverResult } from '../ipc/socket.ts';
import { SubagentError, type BroadcastReceipt, type MessageReceipt } from './runtime.ts';
import type { LiveSession } from './session-directory.ts';

type Receipt = MessageReceipt | BroadcastReceipt;

/**
 * What a managed address belongs to, resolved by the root that knows the shared
 * session directory. A foreign session's subagent endpoint is not a local
 * endpoint: it is refused instead of being written as local traffic.
 */
export type SessionEndpoint =
  | { readonly kind: 'local' }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'session'; readonly session: LiveSession };

export interface ManagedWriteHost {
  resolveEndpoint(address: string): Promise<EndpointResolverResult>;
  /** Classify a path against this root and the published sessions. */
  sessionEndpoint(address: string): Promise<SessionEndpoint>;
  sendMessage(command: {
    from: string;
    to: string;
    content: string;
    signal?: AbortSignal;
  }): Promise<Receipt>;
  /** Deliver to another live session's Main through its own endpoint. */
  sendCrossSession(command: {
    target: LiveSession;
    content: string;
    signal?: AbortSignal;
  }): Promise<void>;
}


const actorId = (id: string): string => id.toLowerCase() === 'main' ? 'Main' : id;
export type ManagedSendResult = Receipt | { readonly ok: true; readonly delivered: 'session'; readonly path: string };

/** One address/admission path shared by tools and user controls; an unknown handoff is never replayed. */
export async function sendManagedMessage(host: ManagedWriteHost, command: {
  readonly cwd: string; readonly senderId: string; readonly path: string; readonly content: string; readonly signal?: AbortSignal;
}): Promise<ManagedSendResult> {
  const signal = command.signal;
      if (!isIpcPath(command.path) && !isWindowsPipe(command.path)) {
        throw new SubagentError('invalid_target', 'msg_write requires a managed endpoint address.');
      }
      if (signal?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
      const from = actorId(command.senderId);
      const address = isWindowsPipe(command.path) ? command.path : path.resolve(command.cwd, command.path);
      // This root's own endpoints are local traffic, including Main's own
      // endpoint: the runtime's self-send rule rejects that, never the
      // cross-session path. Only a path this root does not own can be another
      // live session's Main.
      const endpoint = await host.resolveEndpoint(address);
      if (!endpoint.isManaged) {
        const target = await host.sessionEndpoint(address);
        if (target.kind === 'foreign') {
          throw new SubagentError('invalid_target', 'Cross-session messages are Main-to-Main only.');
        }
        if (target.kind === 'session') {
          // Cross-session coordination is Main-to-Main; the receiving endpoint
          // still owns recipient admission.
          if (from !== 'Main') {
            throw new SubagentError('invalid_target', 'Cross-session messages are sent by Main only.');
          }
          await host.sendCrossSession({ target: target.session, content: command.content,
            ...(signal === undefined ? {} : { signal }) });
          if (signal?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
          return { ok: true, delivered: 'session', path: command.path };
        }
        throw new SubagentError('unmanaged_endpoint', `No registered Agent owns this IPC address: ${command.path}`);
      }
      let to: string;
      if (endpoint.isBroadcast) {
        if (endpoint.parentId === undefined || actorId(endpoint.parentId) !== from) {
          throw new SubagentError('invalid_target', 'Only the parent may write its broadcast endpoint.');
        }
        to = 'all';
      } else {
        if (!endpoint.targetId) throw new SubagentError('unknown_endpoint', 'The managed endpoint has no registered recipient.');
        to = endpoint.targetId;
      }
      const receipt = await host.sendMessage({ from, to, content: command.content,
        ...(signal === undefined ? {} : { signal }) });

  if (signal?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
  return receipt;
}
