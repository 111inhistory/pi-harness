/**
 * Native picker for `/capability enable`.
 *
 * Built from the same `@earendil-works/pi-tui` components the built-in selectors
 * use: a one-line `Input` filter above a `SelectList`. Typing filters, arrows
 * move, Enter enables the highlighted tool, Esc cancels. Nothing here decides
 * authorization: the command runs the selected name through the existing
 * activation and `manual` record path.
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  Input, SelectList, Text, type Component, type KeybindingsManager, type SelectItem,
  type SelectListTheme,
} from '@earendil-works/pi-tui';

const MAX_VISIBLE = 15;
const TITLE = 'Enable a capability';
const HINT = 'Type to filter · ↑↓ move · Enter enables the highlighted tool only · Esc cancels';

function listTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg('accent', text),
    selectedText: (text) => theme.fg('accent', text),
    description: (text) => theme.fg('muted', text),
    scrollInfo: (text) => theme.fg('muted', text),
    noMatch: (text) => theme.fg('muted', text),
  };
}

class CapabilitySelector implements Component {
  readonly #title: Text;
  readonly #hint: Text;
  readonly #input: Input;
  readonly #items: readonly SelectItem[];
  readonly #listTheme: SelectListTheme;
  readonly #keybindings: KeybindingsManager;
  readonly #done: (name: string | undefined) => void;
  #list: SelectList;
  #finished = false;

  constructor(
    items: readonly SelectItem[],
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (name: string | undefined) => void,
  ) {
    this.#keybindings = keybindings;
    this.#done = done;
    this.#items = items;
    this.#listTheme = listTheme(theme);
    this.#title = new Text(theme.fg('accent', theme.bold(TITLE)), 1, 0);
    this.#hint = new Text(theme.fg('muted', HINT), 1, 0);
    this.#input = new Input({ placeholder: 'Filter by name, purpose or group…' });
    this.#list = this.#buildList();
    this.#input.onEscape = () => this.#finish(undefined);
  }

  /**
   * The native list filters by `value` prefix; the picker also needs the human
   * label, purpose and group, so it selects the visible items itself and hands
   * them to a fresh native list.
   */
  #buildList(): SelectList {
    const needle = this.#input.getValue().trim().toLowerCase();
    const visible = needle === '' ? this.#items : this.#items.filter((item) =>
      item.value.toLowerCase().includes(needle)
      || item.label.toLowerCase().includes(needle)
      || (item.description ?? '').toLowerCase().includes(needle));
    const list = new SelectList([...visible], MAX_VISIBLE, this.#listTheme);
    list.onSelect = (item) => this.#finish(item.value);
    list.onCancel = () => this.#finish(undefined);
    return list;
  }

  #finish(name: string | undefined): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#done(name);
  }

  handleInput(data: string): void {
    if (this.#keybindings.matches(data, 'tui.select.up') || this.#keybindings.matches(data, 'tui.select.down')) {
      this.#list.handleInput(data);
      return;
    }
    if (this.#keybindings.matches(data, 'tui.select.confirm') || data === '\r' || data === '\n') {
      const item = this.#list.getSelectedItem();
      if (item !== null) this.#finish(item.value);
      return;
    }
    if (this.#keybindings.matches(data, 'tui.select.cancel')) {
      this.#finish(undefined);
      return;
    }
    this.#input.handleInput(data);
    this.#list = this.#buildList();
  }

  render(width: number): string[] {
    return [
      ...this.#title.render(width),
      ...this.#hint.render(width),
      ...this.#input.render(width),
      ...this.#list.render(width),
    ];
  }

  invalidate(): void {
    this.#title.invalidate();
    this.#hint.invalidate();
    this.#input.invalidate();
    this.#list.invalidate();
  }

  dispose(): void {
    this.#input.invalidate();
    this.#list.invalidate();
  }
}

/** Build the picker component for `ctx.ui.custom`. */
export function createCapabilitySelector(
  items: readonly SelectItem[],
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (name: string | undefined) => void,
): Component {
  return new CapabilitySelector(items, theme, keybindings, done);
}
