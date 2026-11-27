import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { HookRepeat } from './config.ts';

export const HOOK_REPEAT_RECORD = 'hook-repeat';
export const HOOK_HINT_MESSAGE = 'harness-hook-hint';
export interface HookReceipt { readonly key: string; readonly turn: number }
interface Usage { readonly count: number; readonly turn: number }

function isReceipt(data: unknown): data is HookReceipt {
  return typeof data === 'object' && data !== null && 'key' in data && typeof data.key === 'string'
    && 'turn' in data && typeof data.turn === 'number' && Number.isSafeInteger(data.turn) && data.turn >= 0;
}

export function readHintReceipts(details: unknown): readonly HookReceipt[] {
  if (typeof details !== 'object' || details === null || !('repeat' in details)
      || !Array.isArray(details.repeat) || details.repeat.length > 96) return [];
  return details.repeat.filter(isReceipt);
}

/** Branch-local state for current effective rule identities only. */
export function restoreRepeat(branch: readonly SessionEntry[], rules: ReadonlyMap<string, HookRepeat>) {
  const usage = new Map<string, Usage>();
  let userTurn = 0;
  const accept = (key: string, turn: number): void => {
    const previous = usage.get(key);
    usage.set(key, { count: (previous?.count ?? 0) + 1, turn: Math.max(previous?.turn ?? 0, turn) });
  };
  const compact = (): void => {
    for (const [key, rule] of rules) if (rule.resetOnCompaction) usage.delete(key);
  };
  const replay = (data: unknown): void => {
    if (isReceipt(data) && rules.has(data.key)) accept(data.key, data.turn);
  };
  for (const entry of branch) {
    if (entry.type === 'message' && entry.message.role === 'user') userTurn += 1;
    else if (entry.type === 'compaction') compact();
    else if (entry.type === 'custom' && entry.customType === HOOK_REPEAT_RECORD) replay(entry.data);
    else if (entry.type === 'custom_message' && entry.customType === HOOK_HINT_MESSAGE) {
      for (const receipt of readHintReceipts(entry.details)) if (rules.has(receipt.key)) accept(receipt.key, receipt.turn);
    }
  }
  return {
    userTurn,
    compact,
    accept,
    allows(key: string, turn: number, pending: readonly HookReceipt[] = []): boolean {
      const rule = rules.get(key);
      const last = usage.get(key);
      const count = (last?.count ?? 0) + pending.length;
      const lastTurn = Math.max(last?.turn ?? 0, pending.at(-1)?.turn ?? 0);
      return rule === undefined || count === 0
        || ((rule.maxTriggers === undefined || count < rule.maxTriggers)
          && (rule.cooldownTurns === undefined || turn - lastTurn >= rule.cooldownTurns));
    },
  };
}
