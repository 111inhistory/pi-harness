import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { isHookId } from './config.ts';

export const HOOK_OVERRIDE_RECORD = 'harness-hook-override';
export type HookOverride =
  | { readonly version: 1; readonly op: 'mute' | 'unmute'; readonly id: string }
  | { readonly version: 1; readonly op: 'reset' };

function readHookOverride(value: unknown): HookOverride | undefined {
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 || !('op' in value)) return;
  if (value.op === 'reset') return { version: 1, op: 'reset' };
  if ((value.op === 'mute' || value.op === 'unmute') && 'id' in value && isHookId(value.id)) {
    return { version: 1, op: value.op, id: value.id };
  }
}

/** Return whether the operation changed the branch's effective mute set. */
export function applyHookOverride(muted: Set<string>, delta: HookOverride): boolean {
  if (delta.op === 'reset') {
    if (muted.size === 0) return false;
    muted.clear();
    return true;
  }
  if (delta.op === 'unmute') return muted.delete(delta.id);
  if (muted.has(delta.id)) return false;
  muted.add(delta.id);
  return true;
}

export function restoreHookOverrides(branch: readonly SessionEntry[]): Set<string> {
  const muted = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== HOOK_OVERRIDE_RECORD) continue;
    const delta = readHookOverride(entry.data);
    if (delta !== undefined) applyHookOverride(muted, delta);
  }
  return muted;
}
