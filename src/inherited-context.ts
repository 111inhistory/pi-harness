/** Native branch capture shared by Capability and inherited Subagents. */
import { randomUUID } from 'node:crypto';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ExtensionContext, FileEntry } from '@earendil-works/pi-coding-agent';
import { isHarnessEntry, withoutEntries } from './subagent/storage.ts';
import { physicalModelForCall } from './subagent/model-runtime.ts';

export interface InheritedSnapshot {
  readonly capturedAt: number;
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly model: Model<Api> | null;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly tools: readonly string[];
  readonly entries: readonly FileEntry[];
}

function withOwnSessionId(entries: readonly FileEntry[]): FileEntry[] {
  let replaced = false;
  return entries.map(entry => {
    if (replaced || entry.type !== 'session') return entry;
    replaced = true;
    return { ...entry, id: randomUUID() };
  });
}

/** Remove only unresolved calls in the trailing assistant message, retaining native blocks. */
function withoutInFlightToolCalls(entries: FileEntry[]): FileEntry[] {
  const index = entries.findLastIndex(entry => entry.type === 'message' && entry.message.role === 'assistant');
  const entry = entries[index];
  if (entry?.type !== 'message' || entry.message.role !== 'assistant') return entries;
  const message = entry.message;
  const resolved = new Set(entries.flatMap(value => value.type === 'message' && value.message.role === 'toolResult'
    ? [value.message.toolCallId] : []));
  const content = message.content.filter(block => block.type !== 'toolCall' || resolved.has(block.id));
  if (content.length === message.content.length) return entries;
  if (content.length === 0) return withoutEntries(entries, (value: FileEntry) => value === entry) as FileEntry[];
  const copy = [...entries];
  copy[index] = { ...entry, message: { ...message, content } };
  return copy;
}

/** Resolve the producing model before sanitizing the still-running spawning call. */
export function captureInheritedContext(
  pi: Pick<ExtensionAPI, 'getActiveTools'>,
  ctx: Pick<ExtensionContext, 'cwd' | 'model' | 'thinkingLevel' | 'modelRegistry' | 'sessionManager' | 'getSystemPrompt'>,
  toolCallId?: string,
): InheritedSnapshot {
  const model = physicalModelForCall(ctx, toolCallId);
  const header = ctx.sessionManager.getHeader();
  const branch = ctx.sessionManager.getBranch();
  const entries = withoutEntries(header === null ? branch : [header, ...branch], isHarnessEntry) as FileEntry[];
  return {
    capturedAt: Date.now(), cwd: ctx.cwd, systemPrompt: ctx.getSystemPrompt(), model,
    thinkingLevel: ctx.thinkingLevel ?? null, tools: pi.getActiveTools(),
    entries: withOwnSessionId(withoutInFlightToolCalls(entries)),
  };
}
