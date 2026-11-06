/**
 * Capability retrieval placeholders.
 *
 * Inherited declarations remain visible to the retrieval session, but only the
 * internal retrieval tools may execute. Historical declarations never carry a
 * parent executable handle; every blocked placeholder throws locally.
 */
import type { Tool } from '@earendil-works/pi-ai';

import { firstToolDeclarations, type TranscriptMessageLike } from '../session-transcript.ts';

export interface BlockedRetrievalTool extends Tool {
  readonly label: string;
  execute(): Promise<never>;
}

/** Inherited declarations remain visible, but carry no execution authority. */
export function retrievalToolLoadout<T extends { readonly name: string }>(
  messages: readonly TranscriptMessageLike[],
  retrievalTools: readonly T[],
): Array<BlockedRetrievalTool | T> {
  const names = new Set(retrievalTools.map((tool) => tool.name));
  const allowed = names.size === 0 ? "No retrieval tool may execute." : `Only ${[...names].join(", ")} may execute.`;
  const blocked = firstToolDeclarations(messages)
    .filter((tool) => !names.has(tool.name))
    .map((tool): BlockedRetrievalTool => ({
      ...tool,
      label: tool.name,
      async execute(): Promise<never> {
        throw new Error(`Tool ${tool.name} is unavailable in capability discovery. ${allowed}`);
      },
    }));
  return [...blocked, ...retrievalTools];
}
