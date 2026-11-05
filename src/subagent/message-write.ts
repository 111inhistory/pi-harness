import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import path from 'node:path';
import { isIpcPath, isWindowsPipe, type EndpointResolverResult } from '../ipc/socket.ts';
import { promptString } from '../prompt-text.ts';
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
  | { readonly kind: 'self' }
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

const text = {
  description: promptString('subagent-tools.json', 'msg_write', 'description'),
  parameters: {
    path: promptString('subagent-tools.json', 'msg_write', 'parameters', 'path'),
    content: promptString('subagent-tools.json', 'msg_write', 'parameters', 'content'),
  },
};
const parameters = Type.Object({
  path: Type.String({ description: text.parameters.path }),
  content: Type.String({ description: text.parameters.content }),
}, { additionalProperties: false });
export type ManagedWriteTool = ToolDefinition<typeof parameters, undefined>;
const actorId = (id: string): string => id.toLowerCase() === 'main' ? 'Main' : id;

/** Send through the root's message admission, without filesystem operations. */
export function createMessageWriteTool(options: {
  cwd: string;
  senderId: string;
  host: ManagedWriteHost;
}): ManagedWriteTool {
  return {
    name: 'msg_write',
    defaultActive: false,
    label: 'Send Agent Message',
    description: text.description,
    parameters,
    async execute(_id, args, signal) {
      if (!isIpcPath(args.path) && !isWindowsPipe(args.path)) {
        throw new SubagentError('invalid_target', 'msg_write requires a managed endpoint address.');
      }
      if (signal?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
      const from = actorId(options.senderId);
      const address = isWindowsPipe(args.path) ? args.path : path.resolve(options.cwd, args.path);
      // This root's own endpoints are local traffic, including Main's own
      // endpoint: the runtime's self-send rule rejects that, never the
      // cross-session path. Only a path this root does not own can be another
      // live session's Main.
      const endpoint = await options.host.resolveEndpoint(address);
      if (!endpoint.isManaged) {
        const target = await options.host.sessionEndpoint(address);
        if (target.kind === 'self') {
          throw new SubagentError('invalid_target', 'A session cannot send a cross-session message to itself.');
        }
        if (target.kind === 'foreign') {
          throw new SubagentError('invalid_target', 'Cross-session messages are Main-to-Main only.');
        }
        if (target.kind === 'session') {
          // Cross-session coordination is Main-to-Main; the receiving endpoint
          // still owns recipient admission.
          if (from !== 'Main') {
            throw new SubagentError('invalid_target', 'Cross-session messages are sent by Main only.');
          }
          await options.host.sendCrossSession({ target: target.session, content: args.content,
            ...(signal === undefined ? {} : { signal }) });
          if (signal?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
          return { content: [{ type: 'text', text: `Successfully sent message to ${args.path}` }], details: undefined };
        }
        throw new SubagentError('unmanaged_endpoint', `No registered Agent owns this IPC address: ${args.path}`);
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
      const receipt = await options.host.sendMessage({ from, to, content: args.content,
        ...(signal === undefined ? {} : { signal }) });
      if (!receipt.ok) throw new SubagentError('delivery_failed', receipt.errors.map(error => `${error.to}: ${error.message}`).join('; '));
      if (signal?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
      return { content: [{ type: 'text', text: `Successfully sent message to ${args.path}` }], details: undefined };
    },
  };
}
