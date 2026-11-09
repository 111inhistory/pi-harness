/**
 * Parse the `/preset` command line.
 *
 * Kept pure so the interactive handler only has to branch on a small, tested
 * value. `clear`/`none`/`off` all mean "stop managing"; a bare command opens the
 * selector; anything else is a preset name looked up by the handler.
 */

export type PresetCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'apply'; readonly name: string };

const CLEAR_WORDS = new Set(['clear', '(none)', 'none', 'off']);

export function parsePresetCommand(raw: string): PresetCommand {
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'show' };
  if (CLEAR_WORDS.has(trimmed.toLowerCase())) return { kind: 'clear' };
  return { kind: 'apply', name: trimmed };
}
