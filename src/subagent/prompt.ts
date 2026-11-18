import { promptString } from '../prompt-text.ts';

const field = (name: string): string => promptString('subagent-turns.json', name);
const turns = {
  batchContext: field('batchContext'), goal: field('goal'),
  roster: field('roster'), collaborate: field('collaborate'), unnamedMember: field('unnamedMember'),
  messageFrom: field('messageFrom'), replyTo: field('replyTo'),
  originalAssignment: field('originalAssignment'), restatement: field('restatement'), control: field('control'),
};
const context: string = promptString('subagent-turns.json', 'context');

/** Insert protocol values literally, not as replacement patterns. */
export function childContext(agentAddress: string, creatorAddress: string): string {
  return context.replaceAll('{agentAddress}', () => agentAddress)
    .replaceAll('{creatorAddress}', () => creatorAddress);
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

/** One declared batch member: its optional label, logical address and own goal. */
export interface BatchRosterMember {
  readonly name: string | null;
  readonly address: string;
  readonly goal: string;
}

export interface BatchContextInput {
  /** Shared background and source material, verbatim. */
  readonly context: string;
  /** Every declared member, in launch order. */
  readonly roster: readonly BatchRosterMember[];
}

/**
 * Render the launch context of one batch for one Job.
 *
 * A singleton receives only the shared context: its own address and goal are
 * already in its host context and assignment, so a one-member roster would
 * repeat them and imply a team that does not exist. A batch with peers gets the
 * fixed roster (optional name, logical address, own goal) plus one positive
 * cooperation line. Callers render this per Job from the launch snapshot; no
 * formatted copy is persisted.
 */
export function batchContextText(input: BatchContextInput): string {
  if (input.roster.length <= 1) return input.context.trim() === '' ? '' : input.context;
  const lines: string[] = [];
  if (input.context.trim() !== '') lines.push(input.context, '');
  lines.push(turns.roster);
  for (const member of input.roster) {
    lines.push(`- ${member.name ?? turns.unnamedMember} (${member.address}): ${member.goal.trim()}`);
  }
  lines.push('', turns.collaborate);
  return lines.join('\n');
}

/** Routing and execution must see the same assignment. */
export function composeAssignment(goal: string, batchContext: string): string {
  return batchContext.trim() === '' ? goal : `${turns.batchContext}\n\n${batchContext}\n\n${turns.goal}\n\n${goal}`;
}

/**
 * The one model-facing message label.
 *
 * A same-session peer needs only its id. A sender from another live session is
 * named with that session and gets one reply address, so the recipient can
 * answer without a directory lookup of its own.
 */
export function formatPeerMessage(message: {
  from: string;
  content: string;
  external?: { readonly sender: string; readonly replyTo: string } | undefined;
}): string {
  // One label for every message. A cross-session sender is already the full
  // identity `<session-uid>:Main`; the reply address is its real Main endpoint.
  const identity = message.external === undefined ? message.from : message.external.sender;
  const header = `[${turns.messageFrom} ${identity}]`;
  return message.external === undefined
    ? `${header}\n${message.content}`
    : `${header}\n${turns.replyTo}: ${message.external.replyTo}\n${message.content}`;
}

/**
 * The one sender-bound notice appended to a running Job after `interrupt`.
 *
 * The runner aborts the current native run; the notice is the only thing the
 * member reads about it, so it names the interrupter and states that the
 * interrupted work is not retried. `from` is a full logical address.
 */
export function interruptionNotice(from: string): string {
  return interruptionText.replaceAll('{from}', () => from);
}

const interruptionText: string = field('interruptionNotice');

/**
 * The one self-reminder a normal Job finish may append when its recent rounds
 * contain no msg_write. The runner owns when it is used; the text owns only
 * what the member is asked to reconsider, never a forced send.
 */
export const msgWriteReminder: string = field('msgWriteReminder');

/** Events already exist as separate native entries above this control prompt. */
export function continuationControlPrompt(assignment: string | null): string {
  const parts: string[] = [];
  if (assignment !== null) parts.push(turns.originalAssignment, '', turns.restatement, '', assignment, '');
  parts.push(turns.control);
  return parts.join('\n');
}
