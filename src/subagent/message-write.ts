import {
  createWriteToolDefinition,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  createSocketAwareWriteOperations,
  isIpcPath,
  isWindowsPipe,
  type EndpointResolverResult,
} from '../ipc/socket.ts';
import { promptText } from '../prompt-text.mjs';
import { SubagentError, type BroadcastReceipt, type MessageReceipt } from './runtime.ts';

type NativeWriteTool = ReturnType<typeof createWriteToolDefinition>;
type WriteArguments = Parameters<NativeWriteTool['execute']>;
type Receipt = MessageReceipt | BroadcastReceipt;
export type ManagedWriteTool = ToolDefinition<NativeWriteTool['parameters'], undefined>;

export interface ManagedWriteHost {
  resolveEndpoint(address: string): Promise<EndpointResolverResult>;
  isReservedPath(address: string): Promise<boolean>;
  sendMessage(command: {
    from: string;
    to: string;
    content: string;
    signal?: AbortSignal;
  }): Promise<Receipt>;
}

interface MsgWriteToolText {
  msg_write: { description: string; snippet: string; guidelines: string[] };
  parameters: { path: string; content: string };
}

function msgWriteToolText(): MsgWriteToolText {
  const value: unknown = JSON.parse(promptText('subagent-tools.json'));
  if (typeof value !== 'object' || value === null || !('msg_write' in value)) {
    throw new TypeError('Invalid Subagent msg_write tool text.');
  }
  const msg_write = value.msg_write;
  if (typeof msg_write !== 'object' || msg_write === null || !('parameters' in msg_write)) {
    throw new TypeError('Invalid Subagent msg_write tool text.');
  }
  const parameters = msg_write.parameters;
  if (!('description' in msg_write) || typeof msg_write.description !== 'string' ||
      !('snippet' in msg_write) || typeof msg_write.snippet !== 'string' ||
      !('guidelines' in msg_write) || !Array.isArray(msg_write.guidelines) ||
      !msg_write.guidelines.every((item: unknown): item is string => typeof item === 'string') ||
      typeof parameters !== 'object' || parameters === null ||
      !('path' in parameters) || typeof parameters.path !== 'string' ||
      !('content' in parameters) || typeof parameters.content !== 'string') {
    throw new TypeError('Invalid Subagent msg_write tool text.');
  }
  return {
    msg_write: { description: msg_write.description, snippet: msg_write.snippet, guidelines: [...msg_write.guidelines] },
    parameters: { path: parameters.path, content: parameters.content },
  };
}

const text = msgWriteToolText();
const actorId = (id: string): string => id.toLowerCase() === 'main' ? 'Main' : id;

/**
 * Keep the SDK write result for files and messages alike. Delivery receipts
 * stay internal; rejected messages and partial broadcasts fail the tool.
 * Runtime send is never executed under the listener-ownership mutex.
 */
export function createManagedWriteTools(options: {
  cwd: string;
  senderId: string;
  host: ManagedWriteHost;
}): { write: ManagedWriteTool; msg_write: ManagedWriteTool } {
  const native = createWriteToolDefinition(options.cwd);
  const execute = async (...args: WriteArguments) => {
    const operations = createSocketAwareWriteOperations({
      senderId: options.senderId,
      resolveEndpoint: (address) => options.host.resolveEndpoint(address),
      isReservedPath: (address) => options.host.isReservedPath(address),
      sendManaged: async (endpoint) => {
        const from = actorId(options.senderId);
        let to: string;
        if (endpoint.isBroadcast === true) {
          if (endpoint.parentId === undefined || actorId(endpoint.parentId) !== from) {
            throw new SubagentError('invalid_target', 'Only the parent may write its broadcast endpoint.');
          }
          to = 'all';
        } else {
          if (typeof endpoint.targetId !== 'string' || endpoint.targetId === '') {
            throw new SubagentError('unknown_endpoint', 'The managed endpoint has no registered recipient.');
          }
          to = endpoint.targetId;
        }
        const receipt = await options.host.sendMessage({
          from, to, content: args[1].content,
          ...(args[2] === undefined ? {} : { signal: args[2] }),
        });
        if (!receipt.ok) {
          throw new SubagentError('delivery_failed', receipt.errors.map((error) => `${error.to}: ${error.message}`).join('; '));
        }
        if (args[2]?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
      },
    });
    if (process.platform === 'win32' && isWindowsPipe(args[1].path)) {
      // SDK's file mutation queue calls realpath(), which cannot resolve an
      // active Named Pipe. Pipes use message admission, not filesystem locking.
      if (args[2]?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
      await operations.writeFile(args[1].path, args[1].content);
      // Named Pipes bypass the SDK's filesystem queue, but use its result format.
      return { content: [{ type: 'text' as const, text: `Successfully wrote to ${args[1].path}` }], details: undefined };
    }
    return createWriteToolDefinition(options.cwd, { operations }).execute(...args);
  };
  const write: ManagedWriteTool = { ...native, execute };
  const messagePath = { ...native.parameters.properties.path, description: text.parameters.path };
  const messageContent = { ...native.parameters.properties.content, description: text.parameters.content };
  const msg_write: ManagedWriteTool = {
    ...write,
    name: 'msg_write',
    defaultActive: false,
    label: 'Send Agent Message',
    description: text.msg_write.description,
    promptSnippet: text.msg_write.snippet,
    promptGuidelines: [...text.msg_write.guidelines],
    parameters: {
      ...native.parameters,
      properties: {
        ...native.parameters.properties,
        path: messagePath,
        content: messageContent,
      },
    },
    async execute(...args: WriteArguments) {
      if (!isIpcPath(args[1].path)) throw new SubagentError('invalid_target', 'msg_write requires an IPC endpoint address.');
      return execute(...args);
    },
  };
  return { write, msg_write };
}
