/** The same declaration projection is used by Main and inherited retrieval. */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { promptString } from '../prompt-text.ts';

const codemodeFallback = promptString('native-discovery.json', 'codemodeFallback');

export function projectDiscoveryDeclarations(
  messages: readonly AgentMessage[],
  declares: (name: string) => boolean,
  getCodemodeDescription: () => string | undefined = () => codemodeFallback,
): AgentMessage[] {
  let codemodeDescription: string | undefined;
  return messages.map(message => {
    if (message.role !== 'system') return message;
    const sections = { ...message.sections };
    delete sections['mcp_servers'];
    return {
      ...message,
      sections,
      ...(message.toolsAdded ? { toolsAdded: message.toolsAdded.filter(tool => declares(tool.name)).map(tool => {
        // A stored native catalog must receive the caller's exact safe metadata
        // in inherited sessions too; an execution stub does not change its wire declaration.
        if (tool.name !== 'codemode' || !/\bsearchTools\b|\bmcp__/.test(tool.description)) return tool;
        codemodeDescription ??= getCodemodeDescription() ?? codemodeFallback;
        return { ...tool, description: codemodeDescription };
      }) } : {}),
      ...(message.toolsRemoved ? { toolsRemoved: message.toolsRemoved.filter(tool => declares(tool.name)) } : {}),
    };
  });
}
