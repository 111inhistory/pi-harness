import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { promptString } from '../prompt-text.ts';
import { latestPruneRecord } from './discovery-record.ts';

function capabilityPruneNotice(branch: readonly SessionEntry[]): { readonly text: string } | null {
  const boundary = branch.findLast(entry => entry.type === 'compaction' || entry.type === 'context_edit');
  const prune = latestPruneRecord(branch);
  if (boundary?.type !== 'compaction' || prune?.checkpointId !== boundary.id) return null;
  const removed = [...prune.removedTools, ...(prune.removedGroups ?? [])];
  if (removed.length === 0) return null;
  return {
    text: promptString('capability-policy.json', 'compactionPruned')
      .replace('{capabilities}', removed.map(name => `- ${name}`).join('\n')),
  };
}

/** The current prune notice as a request-local section. */
export function capabilityPruneSections(
  branch: readonly SessionEntry[],
): Readonly<Record<string, string | null>> {
  const notice = capabilityPruneNotice(branch);
  return notice === null ? {} : { 'capability-availability': notice.text };
}
