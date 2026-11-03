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
  Input, SelectList, Text, type Component, type Focusable, type KeybindingsManager, type SelectItem,
  type SelectListTheme,
} from '@earendil-works/pi-tui';

import { capabilityEntryMatches, type CapabilityCatalogEntry } from './catalog.ts';

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

class CapabilitySelector implements Component, Focusable {
  readonly #theme: Theme;
  readonly #entries: readonly CapabilityCatalogEntry[];
  readonly #input: Input;
  readonly #listTheme: SelectListTheme;
  readonly #keybindings: KeybindingsManager;
  readonly #done: (name: string | undefined) => void;
  #list: SelectList;
  #finished = false;

  constructor(
    entries: readonly CapabilityCatalogEntry[],
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (name: string | undefined) => void,
  ) {
    this.#keybindings = keybindings;
    this.#done = done;
    this.#theme = theme;
    this.#entries = entries;
    this.#listTheme = listTheme(theme);
    this.#input = new Input({ placeholder: 'Filter by name, purpose or group…' });
    this.#list = this.#buildList();
    this.#input.onEscape = () => this.#finish(undefined);
  }

  /**
   * A container around `Input` must forward focus: the TUI positions the
   * hardware cursor (and the IME candidate window) from the focused child.
   */
  get focused(): boolean {
    return this.#input.focused;
  }

  set focused(value: boolean) {
    this.#input.focused = value;
  }

  /**
   * The native list filters by `value` prefix; the picker filters by the same
   * catalog rule as `list` (full name, purpose and group), then hands the
   * visible entries to a fresh native list.
   */
  #buildList(): SelectList {
    const needle = this.#input.getValue().trim().toLowerCase();
    const visible = this.#entries
      .filter((entry) => capabilityEntryMatches(entry, needle))
      .map((entry): SelectItem => ({
        value: entry.name,
        label: `${entry.active ? '✔' : '○'} ${entry.display}${entry.manual ? '  [manual]' : ''}`,
        description: `${entry.group} · ${entry.description === '' ? 'no description' : entry.description}`,
      }));
    const list = new SelectList(visible, MAX_VISIBLE, this.#listTheme);
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
    // Themed text is computed per render so a theme change cannot leave stale
    // ANSI in application state.
    return [
      ...new Text(this.#theme.fg('accent', this.#theme.bold(TITLE)), 1, 0).render(width),
      ...new Text(this.#theme.fg('muted', HINT), 1, 0).render(width),
      ...this.#input.render(width),
      ...this.#list.render(width),
    ];
  }

  invalidate(): void {
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
  entries: readonly CapabilityCatalogEntry[],
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (name: string | undefined) => void,
): Component {
  return new CapabilitySelector(entries, theme, keybindings, done);
}
