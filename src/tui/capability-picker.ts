/**
 * One-page hierarchical multi-select picker for `/capability activate|deactivate`.
 *
 * Root rows are standalone tools and namespace/MCP containers. Container
 * children are drawn as a tree; only a bounded member window is rendered, with
 * a `…N tools remain` marker that is never a selectable row. Navigation is
 * level-local: Up/Down stays among siblings, Right enters a container, Left
 * returns to its parent and remembers the previous child cursor.
 *
 * Tab focuses a capability field on the current row; Space changes that field.
 * Tool rows expose selection and schema policy; container rows expose load
 * selection and their schema default. Schema policy is never bound to the
 * hierarchy keys. One confirmation produces one domain write; cancel and
 * browsing never append a record.
 */
import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';

import type { ToolAccessListing } from '../capability/tool-access-view.ts';
import { availableInlineRows, terminalRows } from './terminal-layout.ts';

export type PickerMode = 'activate' | 'deactivate';
type PickerModeValue = 'default' | 'lazy' | 'no-lazy';
type LoadMode = 'none' | 'all' | 'explicit';

const MEMBER_WINDOW = 7;

function schemaLabel(entry: ToolAccessListing): string {
  const configured = entry.configLazy ? 'config:lazy' : 'config:schema';
  const override = entry.schemaMode === null ? 'override:none'
    : entry.schemaMode === 'no-schema' ? 'override:lazy' : 'override:schema';
  const applied = entry.schemaWithheld ? 'applied:withheld'
    : entry.schemaMode === 'no-schema' ? 'applied:not-active' : 'applied:schema';
  const ban = entry.banOverridden ? 'ban:overridden-by-base'
    : entry.blocked ? 'ban:blocked' : entry.blacklisted ? 'ban:raw' : '';
  return [configured, override, applied, ...(ban === '' ? [] : [ban])].join(' · ');
}

function modeSuffix(mode: PickerModeValue): string {
  return mode === 'lazy' ? '[lazy]' : mode === 'no-lazy' ? '[no-lazy]' : '';
}

function cycleMode(mode: PickerModeValue): PickerModeValue {
  return mode === 'default' ? 'lazy' : mode === 'lazy' ? 'no-lazy' : 'default';
}

function modeLabel(mode: PickerModeValue): string {
  return mode === 'default' ? 'default' : mode === 'lazy' ? 'lazy' : 'no-lazy';
}

interface PickerMember {
  readonly name: string;
  readonly label: string;
  readonly schema: string;
  mode: PickerModeValue;
  selected: boolean;
}

interface PickerContainer {
  readonly id: string;
  readonly target: string;
  readonly kind: 'namespace' | 'mcp';
  readonly group: string;
  readonly members: PickerMember[];
  load: LoadMode;
  mode: PickerModeValue;
}

interface PickerTool {
  readonly name: string;
  readonly label: string;
  readonly schema: string;
  mode: PickerModeValue;
  selected: boolean;
}

type Field = 'selection' | 'schema' | 'load';

type Cursor =
  | { readonly level: 'root'; readonly index: number }
  | { readonly level: 'child'; readonly container: PickerContainer; readonly index: number };

type DisplayRow =
  | { readonly kind: 'tool'; readonly tool: PickerTool }
  | { readonly kind: 'container'; readonly container: PickerContainer }
  | { readonly kind: 'child'; readonly container: PickerContainer; readonly member: PickerMember; readonly index: number }
  | { readonly kind: 'fold'; readonly count: number; readonly before: boolean }
  | { readonly kind: 'confirm' };

/** Build the picker model from one query result. */
export function createPickerModel(entries: readonly ToolAccessListing[], mode: PickerMode): {
  readonly tools: PickerTool[];
  readonly containers: PickerContainer[];
} {
  // Activation includes already usable members so their schema policy remains
  // editable; they stay unselected until the user actually changes that row.
  // Keep base override states visible even when an outer fence still blocks the
  // tool; the row shows actual usability rather than pretending the raw ban won.
  const candidates = entries.filter((entry) => mode === 'activate'
    ? entry.activatable || entry.usable || (entry.base && entry.blacklisted)
    : entry.dynamic);
  const tools: PickerTool[] = [];
  const groups = new Map<string, PickerContainer>();
  for (const entry of candidates) {
    if (entry.category === 'tool') {
      tools.push({ name: entry.name, label: entry.name, schema: schemaLabel(entry), mode: 'default', selected: false });
      continue;
    }
    const target = entry.category === 'mcp' ? `mcp://${entry.group}` : `namespace://${entry.group}`;
    const id = `${entry.category}:${entry.group}`;
    const group: PickerContainer = groups.get(id) ?? {
      id, target, kind: entry.category, group: entry.group, members: [], load: 'none', mode: 'default',
    };
    group.members.push({ name: entry.name, label: entry.name, schema: schemaLabel(entry), mode: 'default', selected: false });
    groups.set(id, group);
  }
  tools.sort((left, right) => left.name.localeCompare(right.name));
  const containers = [...groups.values()].sort((left, right) =>
    (left.kind === right.kind ? 0 : left.kind === 'namespace' ? -1 : 1)
    || left.group.localeCompare(right.group));
  for (const container of containers) container.members.sort((left, right) => left.name.localeCompare(right.name));
  return { tools, containers };
}

/**
 * Targets for the current selection.
 *
 * Activation always emits an exact snapshot: `[ns]` plus the displayed member
 * names, even for a full container. Re-expanding a group at write time could
 * include an MCP member that registered while the picker was open. Deactivation
 * emits exact names only because namespace selection modifiers are invalid
 * there. Neither path changes membership silently.
 */
export function pickerTargets(
  model: { readonly tools: readonly PickerTool[]; readonly containers: readonly PickerContainer[] },
  mode: PickerMode,
): string[] {
  const targets: string[] = [];
  if (mode === 'deactivate') {
    for (const container of model.containers) {
      const selected = container.load === 'all'
        ? container.members
        : container.load === 'explicit' ? container.members.filter((member) => member.selected) : [];
      for (const member of selected) targets.push(member.name);
    }
    for (const tool of model.tools) if (tool.selected) targets.push(tool.name);
    return targets;
  }
  for (const container of model.containers) {
    const selected = container.load === 'all'
      ? container.members
      : container.load === 'explicit' ? container.members.filter((member) => member.selected) : [];
    if (selected.length === 0) continue;
    const modifiers = ['ns', ...(container.mode === 'default' ? [] : [modeLabel(container.mode)])];
    targets.push(`${container.target}[${modifiers.join(',')}]`);
    for (const member of selected) {
      const override = member.mode !== 'default' && member.mode !== container.mode;
      targets.push(`${member.name}${override ? modeSuffix(member.mode) : ''}`);
    }
  }
  for (const tool of model.tools) if (tool.selected) targets.push(`${tool.name}${modeSuffix(tool.mode)}`);
  return targets;
}

export interface CapabilityPickerOptions {
  readonly entries: readonly ToolAccessListing[];
  readonly mode: PickerMode;
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly done: (targets: readonly string[] | null) => void;
}

export interface CapabilityPickerComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

/** The interactive component; exported so tests drive real input transitions. */
export function createCapabilityPicker(options: CapabilityPickerOptions): CapabilityPickerComponent {
  const { mode, tui, theme, keybindings, done } = options;
  const model = createPickerModel(options.entries, mode);
  let cursor: Cursor = { level: 'root', index: 0 };
  let field: Field = 'selection';
  const childMemory = new Map<string, number>();

  const rootRows = (): DisplayRow[] => [
    ...model.tools.map((tool): DisplayRow => ({ kind: 'tool', tool })),
    ...model.containers.map((container): DisplayRow => ({ kind: 'container', container })),
    { kind: 'confirm' },
  ];

  const rootSiblingCount = (): number => model.tools.length + model.containers.length + 1;

  const containerIndex = (container: PickerContainer): number => model.tools.length + model.containers.indexOf(container);

  const childOffset = (container: PickerContainer, index: number): number => {
    const max = Math.max(0, container.members.length - MEMBER_WINDOW);
    return Math.max(0, Math.min(index - Math.floor(MEMBER_WINDOW / 2), max));
  };

  const displayRows = (): DisplayRow[] => {
    const rows: DisplayRow[] = model.tools.map((tool): DisplayRow => ({ kind: 'tool', tool }));
    for (const container of model.containers) {
      rows.push({ kind: 'container', container });
      const focusIndex = cursor.level === 'child' && cursor.container === container ? cursor.index : -1;
      const start = focusIndex >= 0 ? childOffset(container, focusIndex) : 0;
      const end = Math.min(container.members.length, start + MEMBER_WINDOW);
      if (start > 0) rows.push({ kind: 'fold', count: start, before: true });
      for (let index = start; index < end; index += 1) {
        rows.push({ kind: 'child', container, member: container.members[index]!, index });
      }
      if (end < container.members.length) rows.push({ kind: 'fold', count: container.members.length - end, before: false });
    }
    rows.push({ kind: 'confirm' });
    return rows;
  };

  const displayIndex = (rows: readonly DisplayRow[]): number => {
    if (cursor.level === 'root') {
      if (cursor.index < model.tools.length) return cursor.index;
      const container = model.containers[cursor.index - model.tools.length];
      if (container !== undefined) return rows.findIndex((row) => row.kind === 'container' && row.container === container);
      return rows.length - 1;
    }
    const active = cursor;
    return rows.findIndex((row) => row.kind === 'child' && row.container === active.container && row.index === active.index);
  };

  const currentContainer = (): PickerContainer | null =>
    cursor.level === 'child' ? cursor.container
      : cursor.index >= model.tools.length ? model.containers[cursor.index - model.tools.length] ?? null : null;

  const currentTool = (): PickerTool | null =>
    cursor.level === 'root' && cursor.index < model.tools.length ? model.tools[cursor.index]! : null;

  const currentField = (): Field | null => {
    if (cursor.level === 'child') return field === 'load' ? 'schema' : field;
    if (currentTool() !== null) return field === 'load' ? 'selection' : field;
    if (currentContainer() !== null) return field === 'selection' ? 'load' : field;
    return null;
  };

  const resetField = (): void => {
    field = cursor.level === 'root' && currentContainer() !== null ? 'load' : 'selection';
  };

  const moveSibling = (delta: number): void => {
    if (cursor.level === 'root') {
      const count = rootSiblingCount();
      cursor = { level: 'root', index: (cursor.index + delta + count) % count };
    } else {
      const count = cursor.container.members.length;
      if (count === 0) return;
      const index = (cursor.index + delta + count) % count;
      cursor = { level: 'child', container: cursor.container, index };
      childMemory.set(cursor.container.id, index);
    }
    resetField();
  };

  const jumpSibling = (toEnd: boolean): void => {
    if (cursor.level === 'root') {
      cursor = { level: 'root', index: toEnd ? rootSiblingCount() - 1 : 0 };
    } else {
      const count = cursor.container.members.length;
      if (count === 0) return;
      const index = toEnd ? count - 1 : 0;
      cursor = { level: 'child', container: cursor.container, index };
      childMemory.set(cursor.container.id, index);
    }
    resetField();
  };

  const pageSibling = (delta: number, capacity: number): void => {
    if (cursor.level === 'root') {
      const count = rootSiblingCount();
      cursor = { level: 'root', index: Math.max(0, Math.min(count - 1, cursor.index + delta * Math.max(1, capacity))) };
    } else {
      const count = cursor.container.members.length;
      const index = Math.max(0, Math.min(count - 1, cursor.index + delta * Math.max(1, capacity)));
      cursor = { level: 'child', container: cursor.container, index };
      childMemory.set(cursor.container.id, index);
    }
    resetField();
  };

  const memberSelected = (container: PickerContainer, member: PickerMember): boolean =>
    container.load === 'all' || member.selected;

  const toggleTool = (tool: PickerTool): void => { tool.selected = !tool.selected; };

  const cycleLoad = (container: PickerContainer): void => {
    if (container.load === 'none') {
      container.load = 'all';
      for (const member of container.members) member.selected = true;
    } else if (container.load === 'all') {
      container.load = 'explicit';
    } else {
      container.load = 'none';
      for (const member of container.members) member.selected = false;
    }
  };

  const toggleChild = (container: PickerContainer, member: PickerMember): void => {
    if (container.load === 'all') {
      container.load = 'explicit';
      for (const candidate of container.members) candidate.selected = candidate !== member;
      return;
    }
    if (container.load === 'none') container.load = 'explicit';
    member.selected = !member.selected;
  };

  const cycleField = (): void => {
    const target = currentField();
    if (target === null) return;
    const options: Field[] = currentContainer() !== null && cursor.level === 'root'
      ? ['load', 'schema'] : ['selection', 'schema'];
    const index = options.indexOf(target);
    field = options[(index + 1) % options.length]!;
  };

  const changeField = (): void => {
    const target = currentField();
    if (target === null) return;
    if (cursor.level === 'child') {
      const member = cursor.container.members[cursor.index]!;
      if (target === 'schema') member.mode = cycleMode(member.mode);
      else toggleChild(cursor.container, member);
      return;
    }
    const tool = currentTool();
    if (tool !== null) {
      if (target === 'selection') toggleTool(tool);
      else tool.mode = cycleMode(tool.mode);
      return;
    }
    const container = currentContainer();
    if (container === null) return;
    if (target === 'load') cycleLoad(container);
    else container.mode = cycleMode(container.mode);
  };

  const enterContainer = (container: PickerContainer): void => {
    const remembered = childMemory.get(container.id) ?? 0;
    const index = Math.min(remembered, Math.max(0, container.members.length - 1));
    cursor = { level: 'child', container, index };
    resetField();
  };

  const leaveChild = (): void => {
    if (cursor.level !== 'child') return;
    const parent = containerIndex(cursor.container);
    childMemory.set(cursor.container.id, cursor.index);
    cursor = { level: 'root', index: parent };
    resetField();
  };

  const complete = (): void => {
    const targets = pickerTargets(model, mode);
    done(targets.length === 0 ? null : targets);
  };

  const header = (): string[] => {
    const context = cursor.level === 'child'
      ? `In ${cursor.container.target} · child cursor remembered`
      : 'Tab field · space change · ↑↓ siblings · ← parent · → child · enter confirm · esc cancel';
    return [
      theme.fg('accent', theme.bold(`Capability · ${mode === 'activate' ? 'activate' : 'deactivate'} · hierarchical selector`)),
      theme.fg('dim', context),
    ];
  };

  const renderDisplayRow = (row: DisplayRow, index: number, cursorIndex: number): string[] => {
    const pointer = index === cursorIndex ? theme.fg('accent', '→ ') : '  ';
    if (row.kind === 'fold') {
      return [`${pointer}${theme.fg('dim', row.before ? `…${row.count} tools earlier` : `…${row.count} tools remain`)}`];
    }
    if (row.kind === 'confirm') return [`${pointer}${theme.fg('accent', 'Confirm selection')}`];
    if (row.kind === 'tool') {
      const focused = index === cursorIndex ? currentField() : null;
      const box = row.tool.selected ? theme.fg('success', '[x]') : '[ ]';
      const selection = focused === 'selection' ? theme.fg('accent', box) : box;
      const policy = focused === 'schema' ? theme.fg('accent', `pending:${modeLabel(row.tool.mode)}`) : `pending:${modeLabel(row.tool.mode)}`;
      return [`${pointer}${selection} ${row.tool.name}  ${policy} · ${row.tool.schema}`];
    }
    if (row.kind === 'container') {
      const selected = row.container.load === 'all' ? row.container.members.length
        : row.container.members.filter((member) => member.selected).length;
      const box = row.container.load === 'none' ? '[ ]' : selected === row.container.members.length ? theme.fg('success', '[x]') : theme.fg('warning', '[~]');
      const focused = index === cursorIndex ? currentField() : null;
      const load = focused === 'load' ? theme.fg('accent', `load:${row.container.load}`) : `load:${row.container.load}`;
      const policy = focused === 'schema' ? theme.fg('accent', `schema:${modeLabel(row.container.mode)}`) : `schema:${modeLabel(row.container.mode)}`;
      return [`${pointer}${box} ${row.container.target}  ${load} · ${policy} · ${selected}/${row.container.members.length}`];
    }
    const last = row.index === row.container.members.length - 1;
    const prefix = last ? '└─' : '├─';
    const focus = index === cursorIndex ? currentField() : null;
    const box = memberSelected(row.container, row.member) ? theme.fg('success', '[x]') : '[ ]';
    const selected = focus === 'selection' ? theme.fg('accent', box) : box;
    const inherited = row.member.mode === 'default' && row.container.mode !== 'default'
      ? ` (inherits ${modeLabel(row.container.mode)})` : '';
    const policy = focus === 'schema'
      ? theme.fg('accent', `pending:${modeLabel(row.member.mode)}${inherited}`)
      : `pending:${modeLabel(row.member.mode)}${inherited}`;
    return [`${pointer}${prefix} ${selected} ${row.member.name}  ${policy} · ${row.member.schema}`];
  };

  return {
    render(width: number): string[] {
      if (!Number.isFinite(width) || width < 1) return [];
      const columns = Math.max(1, Math.floor(width));
      const rows = terminalRows(tui);
      if (rows <= 3) {
        return [truncateToWidth(theme.fg('error', `terminal too small for /capability · needs more rows · esc cancels`), columns, '')]
          .slice(0, rows);
      }
      const head = header();
      const footer = [theme.fg('dim', 'pick a row, then confirm once · no writes before confirmation')];
      const available = availableInlineRows(tui, head.length + footer.length);
      const display = displayRows();
      const activeIndex = Math.max(0, displayIndex(display));
      const start = Math.max(0, Math.min(activeIndex - Math.floor(available / 2), display.length - available));
      const visible = display.slice(start, start + available);
      const offset = start;
      const lines = [
        ...head,
        ...visible.flatMap((row, index) => renderDisplayRow(row, offset + index, activeIndex)),
        ...footer,
      ];
      return lines.slice(0, rows).map((line) => truncateToWidth(line, columns));
    },
    handleInput(data: string): void {
      const available = availableInlineRows(tui, header().length + 1);
      if (keybindings.matches(data, 'tui.select.up')) { moveSibling(-1); tui.requestRender(); return; }
      if (keybindings.matches(data, 'tui.select.down')) { moveSibling(1); tui.requestRender(); return; }
      if (keybindings.matches(data, 'tui.select.cancel')) { done(null); return; }
      if (keybindings.matches(data, 'tui.select.confirm')) {
        const row = displayRows()[displayIndex(displayRows())];
        if (row?.kind === 'confirm') { complete(); return; }
      }
      const pageCapacity = cursor.level === 'root' ? available : Math.min(MEMBER_WINDOW, available);
      if (keybindings.matches(data, 'tui.select.pageUp')) { pageSibling(-1, pageCapacity); tui.requestRender(); return; }
      if (keybindings.matches(data, 'tui.select.pageDown')) { pageSibling(1, pageCapacity); tui.requestRender(); return; }
      if (keybindings.matches(data, 'tui.editor.cursorLineStart')) { jumpSibling(false); tui.requestRender(); return; }
      if (keybindings.matches(data, 'tui.editor.cursorLineEnd')) { jumpSibling(true); tui.requestRender(); return; }
      if (keybindings.matches(data, 'tui.editor.cursorLeft')) { leaveChild(); tui.requestRender(); return; }
      if (keybindings.matches(data, 'tui.editor.cursorRight')) {
        const container = currentContainer();
        if (container !== null && cursor.level === 'root') enterContainer(container);
        tui.requestRender();
        return;
      }
      if (keybindings.matches(data, 'tui.input.tab')) { cycleField(); tui.requestRender(); return; }
      if (data === ' ') { changeField(); tui.requestRender(); return; }
      if (data === 'c') {
        for (const tool of model.tools) tool.selected = false;
        for (const container of model.containers) {
          container.load = 'none';
          for (const member of container.members) member.selected = false;
        }
        tui.requestRender();
      }
    },
    invalidate(): void {},
  };
}
