import { promptString } from '../prompt-text.ts';

const field = (name: string): string => promptString('subagent-turns.json', name);
const turns = { batchContext: field('batchContext'), task: field('task'), messageFrom: field('messageFrom'),
  originalAssignment: field('originalAssignment'), restatement: field('restatement'), control: field('control') };
const context: string = promptString('subagent-turns.json', 'context');

/** Insert protocol values literally, not as replacement patterns. */
export function childContext(agentId: string, parentId: string, parentSocket: string): string {
  return context.replaceAll('{agentId}', () => agentId).replaceAll('{parentId}', () => parentId).replaceAll('{parentSocket}', () => parentSocket);
}

/**
 * Assemble the current child's guidance without changing its inherited history.
 *
 * One assembly for Fresh and Inherited: the routed role first, then the
 * host-owned identity/delivery context, then the resolved common guidance, then
 * the Inherited-only guidance. Each conceptual section is its own block; blank
 * configured sections add nothing, so the default order stays [role, host,
 * inherited] while `common` remains empty.
 */
export function childPromptBlocks(options: {
  roleInstructions: string | null;
  common: string;
  inherited: boolean;
  inheritedPrompt: string;
  context: string;
}): string[] {
  return [
    ...(options.roleInstructions !== null ? [options.roleInstructions] : []),
    options.context,
    ...(options.common.trim() !== "" ? [options.common] : []),
    ...(options.inherited && options.inheritedPrompt.trim() !== "" ? [options.inheritedPrompt] : []),
  ];
}

/** Routing and execution must see the same assignment. */
export function composeAssignment(task: string, batchContext: string): string {
  return batchContext.trim() === '' ? task : `${turns.batchContext}\n\n${batchContext}\n\n${turns.task}\n\n${task}`;
}

export function formatPeerMessage(message: { from: string; content: string }): string {
  return `[${turns.messageFrom} ${message.from}]\n${message.content}`;
}

/** Events already exist as separate native entries above this control prompt. */
export function continuationControlPrompt(assignment: string | null): string {
  const parts: string[] = [];
  if (assignment !== null) parts.push(turns.originalAssignment, '', turns.restatement, '', assignment, '');
  parts.push(turns.control);
  return parts.join('\n');
}
