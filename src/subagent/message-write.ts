import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { promptString } from '../prompt-text.ts';
import { SubagentError } from './runtime.ts';
import { sendManagedMessage, type ManagedWriteHost } from './managed-send.ts';

const text = {
  description: promptString('subagent-tools.json', 'msg_write', 'description'),
  parameters: {
    to: promptString('subagent-tools.json', 'msg_write', 'parameters', 'to'),
    content: promptString('subagent-tools.json', 'msg_write', 'parameters', 'content'),
  },
};
const parameters = Type.Object({
  to: Type.String({ description: text.parameters.to }),
  content: Type.String({ description: text.parameters.content }),
}, { additionalProperties: false });
export type ManagedWriteTool = ToolDefinition<typeof parameters, undefined>;

/** Bind model caller identity and render the shared managed-send outcome. */
export function createMessageWriteTool(options: { senderId: string; host: ManagedWriteHost }): ManagedWriteTool {
  return { name: 'msg_write', defaultActive: false, label: 'Send Agent Message', description: text.description, parameters,
    async execute(_id, args, signal) {
      const receipt = await sendManagedMessage(options.host, { senderId: options.senderId, ...args,
        ...(signal === undefined ? {} : { signal }) });
      if (!receipt.ok) throw new SubagentError('delivery_failed', receipt.errors.map(error => `${error.to}: ${error.message}`).join('; '));
      return { content: [{ type: 'text', text: `Successfully sent message to ${args.to}` }], details: undefined };
    },
  };
}
