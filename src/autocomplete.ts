/**
 * Slash-command argument completion for extension commands.
 *
 * The editor requests Tab suggestions with `force: true`, and the built-in
 * provider only serves slash-command argument completions when `force` is
 * false. A command that accepts an argument therefore shows no candidates after
 * the accepted value and its space: the user has to type and delete a character
 * to trigger a non-forced request.
 *
 * This wrapper retries the forced request without the flag, but only for the
 * command it is installed for, so file completion after other commands is
 * untouched. It delegates every other call unchanged; it is not a second
 * completion engine.
 */

import type { AutocompleteProvider } from '@earendil-works/pi-tui';

/** Wrap the provider for one slash command (name without the leading slash). */
export function argumentCompletionProvider(
  base: AutocompleteProvider,
  command: string,
): AutocompleteProvider {
  const pattern = new RegExp(`^/${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  return {
    getSuggestions(lines, cursorLine, cursorCol, options) {
      const text = (lines[cursorLine] ?? '').slice(0, cursorCol).trimStart();
      if (options.force === true && pattern.test(text)) {
        return base.getSuggestions(lines, cursorLine, cursorCol, { ...options, force: false });
      }
      return base.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      base.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    ...(base.triggerCharacters === undefined ? {} : { triggerCharacters: base.triggerCharacters }),
    ...(base.shouldTriggerFileCompletion === undefined ? {} : {
      shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
        base.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol),
    }),
  };
}
