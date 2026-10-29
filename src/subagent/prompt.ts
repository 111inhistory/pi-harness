import { promptText } from '../prompt-text.mjs';

const parsed: unknown = JSON.parse(promptText('subagent-turns.json'));
if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('subagent-turns.json must contain an object.');
const text: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
function field(name: string): string {
  const value = text[name];
  if (typeof value !== 'string') throw new TypeError(`subagent-turns.json must define string ${name}.`);
  return value;
}
const turns = { batchContext: field('batchContext'), task: field('task'), messageFrom: field('messageFrom'),
  originalAssignment: field('originalAssignment'), restatement: field('restatement'), control: field('control') };
const context: string = promptText('subagent-context.md');

/** Insert protocol values literally, not as replacement patterns. */
export function childContext(agentId: string, parentId: string, parentSocket: string): string {
  return context.replaceAll('{agentId}', () => agentId).replaceAll('{parentId}', () => parentId).replaceAll('{parentSocket}', () => parentSocket);
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
