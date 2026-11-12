/**
 * Tool-selection modifiers: `+name`, `-name` and plain-name tokens.
 *
 * This mirrors Pi's native `defaultTools`/`--tools` syntax so a preset expresses
 * a tool selection the same way the rest of the CLI does: a plain name replaces
 * the inherited selection, `+name` adds a tool, and `-name` removes one.
 *
 * A preset's modifiers are always applied to the same *base* selection, never to
 * the selection a previous preset left behind. That is what makes "switch A then
 * B" and "apply B directly" land on the same final tool set: both compute from
 * the shared base instead of chaining. The base is a caller-supplied value, not
 * the current active set, precisely so this property holds.
 */

/** One token: `+` add, `-` remove, `=` plain (establishes the replacement base). */
export interface ToolModifierToken {
  readonly op: '+' | '-' | '=';
  readonly name: string;
}

/** Parsed tokens plus the raw tokens that named nothing usable. */
export interface ParsedToolModifiers {
  readonly tokens: readonly ToolModifierToken[];
  readonly invalid: readonly string[];
}

/**
 * Split a modifier list into tokens.
 *
 * A token is a leading `+`/`-` (an op) plus a non-empty tool name; anything else
 * is a plain name. Empty names (`"+"`, `"-"`, whitespace) are invalid and
 * reported instead of silently ignored.
 */
export function parseToolModifiers(list: readonly string[]): ParsedToolModifiers {
  const tokens: ToolModifierToken[] = [];
  const invalid: string[] = [];
  for (const raw of list) {
    const token = raw.trim();
    if (token === '') {
      invalid.push(raw);
      continue;
    }
    const head = token[0];
    if (head === '+' || head === '-') {
      const name = token.slice(1).trim();
      if (name === '') invalid.push(raw);
      else tokens.push({ op: head, name });
      continue;
    }
    tokens.push({ op: '=', name: token });
  }
  return { tokens, invalid };
}

/**
 * Compute the final selection from a stable base and parsed tokens.
 *
 * Plain names replace the base (a preset that lists explicit tools selects
 * exactly those). Adds and removes then apply in token order, so a later token
 * wins over an earlier one for the same name. The result preserves `base` order
 * for names it keeps and appends added names in the order first seen.
 */
export function applyToolModifiers(base: readonly string[], tokens: readonly ToolModifierToken[]): string[] {
  const plain = tokens.filter((token) => token.op === '=').map((token) => token.name);
  const selection = new Set<string>(plain.length > 0 ? plain : base);
  for (const token of tokens) {
    if (token.op === '+') selection.add(token.name);
    else if (token.op === '-') selection.delete(token.name);
  }
  return [...selection];
}

/** Explicit final removals also fence a Fresh child's execution loadout. */
export function excludedPresetTools(modifiers: readonly string[] = []): string[] {
  const excluded = new Set<string>();
  for (const token of parseToolModifiers(modifiers).tokens) {
    if (token.op === '-') excluded.add(token.name);
    else if (token.op === '+') excluded.delete(token.name);
  }
  return [...excluded];
}
