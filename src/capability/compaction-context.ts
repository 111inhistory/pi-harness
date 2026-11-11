import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SystemMessage } from '@earendil-works/pi-ai';
import { buildSessionProjection, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { promptString } from '../prompt-text.ts';
import { latestPruneRecord } from './discovery-record.ts';

/** Mask retired declaration contributions by native source-entry provenance. */
export function projectPrunedToolHistory(
  messages: readonly AgentMessage[],
  branch: readonly SessionEntry[],
): AgentMessage[] {
  const removedAt = new Map<string, number>();
  let checkpoint: number | undefined;
  let initialRequest = false;
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index]!;
    const prune = latestPruneRecord([entry]);
    for (const name of prune?.removedTools ?? []) removedAt.set(name, index);
    if (entry.type === 'compaction') {
      checkpoint = index;
      initialRequest = true;
    } else if (entry.type === 'message' && initialRequest) {
      if (entry.message.role === 'assistant') initialRequest = false;
      else if (entry.message.role === 'system' && checkpoint !== undefined) {
        // Compaction hooks can remove disabled tools after the SDK captured
        // its checkpoint. The first request's native removal fixes that head;
        // a later enable must append, never restore the old head declaration.
        for (const tool of entry.message.toolsRemoved ?? []) {
          removedAt.set(tool.name, Math.max(removedAt.get(tool.name) ?? checkpoint, checkpoint));
        }
      }
    }
  }
  if (removedAt.size === 0) return [...messages];
  const positions = new Map(branch.map((entry, index) => [entry.id, index]));
  const sources = buildSessionProjection([...branch]).entries.flatMap(entry =>
    entry.messages.map(() => positions.get(entry.sourceEntry.id)!));
  const reintroduced = new Set<string>();
  return messages.map((message, ordinal) => {
    if (message.role !== 'system') return message;
    const position = sources[ordinal];
    if (position === undefined) return message;
    const toolsRemoved = message.toolsRemoved?.filter(tool => !removedAt.has(tool.name) || reintroduced.has(tool.name));
    const toolsAdded = message.toolsAdded?.filter(tool => {
      const retiredAt = removedAt.get(tool.name);
      const keep = retiredAt === undefined || position > retiredAt;
      if (keep && retiredAt !== undefined) reintroduced.add(tool.name);
      return keep;
    });
    return {
      ...message,
      ...(toolsAdded ? { toolsAdded } : {}),
      ...(toolsRemoved ? { toolsRemoved } : {}),
    };
  });
}

/** A fixed section in this compaction boundary's leading system message. */
export function projectCompactionCapabilityNotice(
  messages: readonly AgentMessage[],
  branch: readonly SessionEntry[],
): AgentMessage[] {
  const boundary = branch.findLast(entry => entry.type === 'compaction' || entry.type === 'context_edit');
  const prune = latestPruneRecord(branch);
  if (boundary?.type !== 'compaction' || prune?.checkpointId !== boundary.id) return [...messages];
  const removed = [...prune.removedTools, ...(prune.removedGroups ?? [])];
  if (removed.length === 0) return [...messages];
  const text = promptString('capability-policy.json', 'compactionPruned')
    .replace('{capabilities}', removed.map(name => `- ${name}`).join('\n'));
  const head = messages[0];
  if (head?.role === 'system') return [{
    ...head, sections: { ...head.sections, 'capability-availability': text },
  }, ...messages.slice(1)];
  const notice: SystemMessage = {
    role: 'system', content: '', sections: { 'capability-availability': text },
    timestamp: Date.parse(boundary.timestamp),
  };
  return [notice, ...messages];
}
