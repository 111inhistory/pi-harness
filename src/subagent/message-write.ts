import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import path from 'node:path';
import { isIpcPath, isWindowsPipe, type EndpointResolverResult } from '../ipc/socket.ts';
import { promptText } from '../prompt-text.ts';
import { SubagentError, type BroadcastReceipt, type MessageReceipt } from './runtime.ts';

type Receipt = MessageReceipt | BroadcastReceipt;

export interface ManagedWriteHost {
  resolveEndpoint(address: string): Promise<EndpointResolverResult>;
  sendMessage(command: {
    from: string;
    to: string;
    content: string;
    signal?: AbortSignal;
  }): Promise<Receipt>;
}

interface MsgWriteToolText {
  description: string;
  snippet: string;
  guidelines: string[];
  parameters: { path: string; content: string };
}

const text: MsgWriteToolText = JSON.parse(promptText('subagent-tools.json')).msg_write;
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
    defaultActive: true,
    label: 'Send Agent Message',
    description: text.description,
    promptSnippet: text.snippet,
    promptGuidelines: [...text.guidelines],
    parameters,
    async execute(_id, args, signal) {
      if (!isIpcPath(args.path)) throw new SubagentError('invalid_target', 'msg_write requires an IPC endpoint address.');
      if (signal?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
      const address = isWindowsPipe(args.path) ? args.path : path.resolve(options.cwd, args.path);
      const endpoint = await options.host.resolveEndpoint(address);
      if (!endpoint.isManaged) throw new SubagentError('unmanaged_endpoint', `No registered Agent owns this IPC address: ${args.path}`);
      const from = actorId(options.senderId);
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
