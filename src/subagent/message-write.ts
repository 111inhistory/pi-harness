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
export type ManagedWriteTool = ToolDefinition<NativeWriteTool['parameters'], Receipt | undefined>;

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

interface MessageToolText {
  message: { description: string; snippet: string; guidelines: string[] };
  parameters: { messagePath: string; messageContent: string };
}

function messageToolText(): MessageToolText {
  const value: unknown = JSON.parse(promptText('subagent-tools.json'));
  if (typeof value !== 'object' || value === null || !('message' in value) || !('parameters' in value)) {
    throw new TypeError('Invalid Subagent message tool text.');
  }
  const message = value.message;
  const parameters = value.parameters;
  if (typeof message !== 'object' || message === null ||
      !('description' in message) || typeof message.description !== 'string' ||
      !('snippet' in message) || typeof message.snippet !== 'string' ||
      !('guidelines' in message) || !Array.isArray(message.guidelines) ||
      !message.guidelines.every((item: unknown): item is string => typeof item === 'string') ||
      typeof parameters !== 'object' || parameters === null ||
      !('messagePath' in parameters) || typeof parameters.messagePath !== 'string' ||
      !('messageContent' in parameters) || typeof parameters.messageContent !== 'string') {
    throw new TypeError('Invalid Subagent message tool text.');
  }
  return {
    message: { description: message.description, snippet: message.snippet, guidelines: [...message.guidelines] },
    parameters: { messagePath: parameters.messagePath, messageContent: parameters.messageContent },
  };
}

const text = messageToolText();
const actorId = (id: string): string => id.toLowerCase() === 'main' ? 'Main' : id;

/**
 * Keep SDK path expansion and ordinary-file behavior, but replace the tool
 * result when a managed message was admitted. Each invocation owns its receipt;
 * SDK WriteOperations itself has a void result and cannot expose that receipt.
 * Runtime send is never executed under the listener-ownership mutex.
 */
export function createManagedWriteTools(options: {
  cwd: string;
  senderId: string;
  host: ManagedWriteHost;
}): { write: ManagedWriteTool; message: ManagedWriteTool } {
  const native = createWriteToolDefinition(options.cwd);
  const execute = async (...args: WriteArguments) => {
    let receipt: Receipt | undefined;
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
        receipt = await options.host.sendMessage({
          from, to, content: args[1].content,
          ...(args[2] === undefined ? {} : { signal: args[2] }),
        });
      },
    });
    if (process.platform === 'win32' && isWindowsPipe(args[1].path)) {
      // SDK's file mutation queue calls realpath(), which cannot resolve an
      // active Named Pipe. Pipes use message admission, not filesystem locking.
      if (args[2]?.aborted) throw new SubagentError('cancelled', 'Message send was cancelled.');
      await operations.writeFile(args[1].path, args[1].content);
    } else {
      const result = await createWriteToolDefinition(options.cwd, { operations }).execute(...args);
      if (receipt === undefined) return result;
    }
    if (receipt === undefined) throw new SubagentError('invalid_state', 'The message send returned no result.');
    return { content: [{ type: 'text' as const, text: JSON.stringify(receipt) }], details: receipt };
  };
  // Native's renderer assumes undefined details and a filesystem mutation.
  // Let Pi's generic renderer show structured message results instead.
  const { renderResult: _fileResultRenderer, ...metadata } = native;
  const write: ManagedWriteTool = { ...metadata, execute };
  const messagePath = { ...native.parameters.properties.path, description: text.parameters.messagePath };
  const messageContent = { ...native.parameters.properties.content, description: text.parameters.messageContent };
  const message: ManagedWriteTool = {
    ...write,
    name: 'msg_write',
    defaultActive: false,
    label: 'Send Agent Message',
    description: text.message.description,
    promptSnippet: text.message.snippet,
    promptGuidelines: [...text.message.guidelines],
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
  return { write, message };
}
