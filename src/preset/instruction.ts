/** Current Preset instructions are appended to the native SDK `addendum` (`appendSystemPrompt`). */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { restorePresetSnapshot } from './state.ts';

/** Append active Preset instructions onto the base `appendSystemPrompt` without mutating it. */
export function appendPresetAddendum(
  baseAddendum: string | undefined,
  branch: readonly unknown[],
): string {
  const base = baseAddendum ?? '';
  const instructions = restorePresetSnapshot(branch)?.instructions?.trim() ?? '';
  if (instructions.length === 0) return base;
  return base.trim().length > 0 ? `${base}\n\n${instructions}` : instructions;
}

/** Install in every live caller, including Preset-only extension configurations. */
export function installPresetInstruction(pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event, ctx) => {
    event.systemPromptOptions.appendSystemPrompt = appendPresetAddendum(
      event.systemPromptOptions.appendSystemPrompt,
      ctx.sessionManager.getBranch(),
    );
  });
}
