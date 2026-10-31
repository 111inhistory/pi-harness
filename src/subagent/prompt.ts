import { promptString } from '../prompt-text.ts';

const field = (name: string): string => promptString('subagent-turns.json', name);
const turns = { batchContext: field('batchContext'), task: field('task'), messageFrom: field('messageFrom'),
  originalAssignment: field('originalAssignment'), restatement: field('restatement'), control: field('control') };
const context: string = promptString('subagent-turns.json', 'context');
export const inheritedContextInstruction: string = field('inheritedContext');

/** Insert protocol values literally, not as replacement patterns. */
export function childContext(agentId: string, parentId: string, parentSocket: string): string {
  return context.replaceAll('{agentId}', () => agentId).replaceAll('{parentId}', () => parentId).replaceAll('{parentSocket}', () => parentSocket);
}

/** Assemble the current child identity without changing its inherited history. */
export function childPromptBlocks(options: {
  context: string;
  roleInstructions: string | null;
  inherited: boolean;
  inheritedContext: string;
}): string[] {
  return [
    ...(options.roleInstructions !== null ? [options.roleInstructions] : []),
    options.context,
    ...(options.inherited && options.inheritedContext.trim() !== "" ? [options.inheritedContext] : []),
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
