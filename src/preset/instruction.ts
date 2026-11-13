/** Current Preset instructions are request-local, not a placement journal. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendCurrentSections } from '../request-instructions.ts';
import { restorePresetSnapshot } from './state.ts';

export const PRESET_INSTRUCTION_SECTION = 'preset-instructions';

export function presetInstructionSections(branch: readonly unknown[]): Record<string, string | null> {
  return { [PRESET_INSTRUCTION_SECTION]: restorePresetSnapshot(branch)?.instructions ?? null };
}

/** Install in every live caller, including Preset-only extension configurations. */
export function installPresetInstruction(pi: ExtensionAPI): void {
  pi.on('context_with_system', (event, ctx) => ({
    messages: appendCurrentSections(event.messages, presetInstructionSections(ctx.sessionManager.getBranch())) as typeof event.messages,
  }));
}
