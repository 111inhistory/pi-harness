import { promptText } from './prompt-text.mjs';

const text = JSON.parse(promptText('subagent-turns.json'));
const context = promptText('subagent-context.md');

/** Protocol values are inserted literally, never interpreted as replacement patterns. */
export function childContext(agentId, parentId, parentSocket) {
  return context
    .replaceAll('{agentId}', () => agentId)
    .replaceAll('{parentId}', () => parentId)
    .replaceAll('{parentSocket}', () => parentSocket);
}

/** Shared by routing and execution so the classifier sees the exact assignment. */
export function composeAssignment(task, batchContext) {
  return batchContext.trim() === '' ? task : `${text.batchContext}\n\n${batchContext}\n\n${text.task}\n\n${task}`;
}

export function formatPeerMessage(message) {
  return `[${text.messageFrom} ${message.from}]\n${message.content}`;
}

export function composePrompt(assignment, messages) {
  if (messages.length === 0) return assignment;
  return `${assignment}\n\n${text.peerMessages}\n\n${messages.map((entry) => entry.text).join('\n\n')}`;
}

export function composeContinuationPrompt(messages, assignment) {
  const restating = typeof assignment === 'string' && assignment !== '';
  const parts = [];
  if (restating) parts.push(text.originalAssignment, '', text.restatement, '', assignment, '');
  parts.push(text.newMessage, '', restating ? text.firstRun : text.continuation, '', messages.map((entry) => entry.text).join('\n\n'));
  return parts.join('\n');
}
