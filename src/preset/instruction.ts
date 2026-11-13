/** Current Preset instructions are emitted via native system prompt sections. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { applySystemPromptSections } from '../request-instructions.ts';
import { restorePresetSnapshot } from './state.ts';

export const PRESET_INSTRUCTION_SECTION = 'preset-instructions';

export function presetInstructionSections(branch: readonly unknown[]): Record<string, string | null> {
  return { [PRESET_INSTRUCTION_SECTION]: restorePresetSnapshot(branch)?.instructions ?? null };
}

/** Install in every live caller, including Preset-only extension configurations. */
export function installPresetInstruction(pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event, ctx) => {
    applySystemPromptSections(
      event.systemPromptOptions.sections ??= {},
      presetInstructionSections(ctx.sessionManager.getBranch()),
      [PRESET_INSTRUCTION_SECTION],
    );
  });
}
