/**
 * Compact hierarchical multi-select picker for `/capability activate|deactivate`.
 *
 * Root rows preview each namespace/MCP container's first seven members with a
 * non-selectable remaining-count marker. Entering a container shows its full
 * member list through the scrolling viewport. Navigation stays level-local:
 * Up/Down among siblings, Right enters a container, Left returns to the parent
 * and remembers the child cursor.
 *
 * Tab toggles a tool's selection or bulk-toggles a container's members. Space
 * directly cycles default/lazy/no-lazy on container rows only. Enter confirms
 * once from any row; Escape cancels. No record is
 * written before confirmation.
 */
import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';

import type { ToolAccessListing } from '../capability/tool-access-view.ts';
import { INLINE_HOST_RESERVE_ROWS, inlinePanelBudget } from './terminal-layout.ts';

export type PickerMode = 'activate' | 'deactivate';
type PickerModeValue = 'default' | 'lazy' | 'no-lazy';

const MEMBER_PREVIEW = 7;
/** Component floor: separators, title, meaningful viewport and footer. */
const PICKER_MIN_INLINE_ROWS = 8;
/** Physical terminal rows required for the picker floor plus the shared host reserve. */
export function requiredPickerTerminalRows(): number {
  return PICKER_MIN_INLINE_ROWS + INLINE_HOST_RESERVE_ROWS;
}

function modeLabel(mode: PickerModeValue): string {
  return mode === 'default' ? 'none' : mode;
}

function cycleMode(mode: PickerModeValue): PickerModeValue {
  return mode === 'default' ? 'lazy' : mode === 'lazy' ? 'no-lazy' : 'default';
}

interface PickerMember {
  readonly name: string;
  readonly configLazy: boolean;
  readonly schemaWithheld: boolean;
  readonly blocked: boolean;
  readonly banOverridden: boolean;
  selected: boolean;
}

interface PickerContainer {
  readonly id: string;
  readonly target: string;
  readonly kind: 'namespace' | 'mcp';
  readonly group: string;
  readonly members: PickerMember[];
  mode: PickerModeValue;
}

interface PickerTool {
  readonly name: string;
  readonly configLazy: boolean;
  readonly schemaWithheld: boolean;
  readonly blocked: boolean;
  readonly banOverridden: boolean;
  selected: boolean;
}

type Cursor =
  | { readonly level: 'root'; readonly index: number }
  | { readonly level: 'child'; readonly container: PickerContainer; readonly index: number };

type DisplayRow =
  | { readonly kind: 'tool'; readonly tool: PickerTool }
  | { readonly kind: 'container'; readonly container: PickerContainer }
  | { readonly kind: 'child'; readonly container: PickerContainer; readonly member: PickerMember; readonly index: number; readonly last: boolean }
  | { readonly kind: 'summary'; readonly count: number };

function toolStatus(entry: ToolAccessListing): Pick<PickerTool, 'configLazy' | 'schemaWithheld' | 'blocked' | 'banOverridden'> {
  return {
    configLazy: entry.configLazy,
    schemaWithheld: entry.schemaWithheld,
    blocked: entry.blocked,
    banOverridden: entry.banOverridden,
  };
}

function memberStatus(entry: ToolAccessListing): Pick<PickerMember, 'configLazy' | 'schemaWithheld' | 'blocked' | 'banOverridden'> {
  return toolStatus(entry);
}

/** Build the picker model from one query result. */
export function createPickerModel(entries: readonly ToolAccessListing[], mode: PickerMode): {
  readonly tools: PickerTool[];
  readonly containers: PickerContainer[];
} {
  // Activation includes already usable/base-overridden members so their
  // membership remains visible; nothing is preselected.
  const candidates = entries.filter((entry) => mode === 'activate'
    ? entry.activatable || entry.usable || (entry.base && entry.blacklisted)
    : entry.dynamic);
  const tools: PickerTool[] = [];
  const groups = new Map<string, PickerContainer>();
  for (const entry of candidates) {
    if (entry.category === 'tool') {
      tools.push({ name: entry.name, ...toolStatus(entry), selected: false });
      continue;
    }
    const target = entry.category === 'mcp' ? `mcp://${entry.group}` : `namespace://${entry.group}`;
    const id = `${entry.category}:${entry.group}`;
    const group: PickerContainer = groups.get(id) ?? {
      id, target, kind: entry.category, group: entry.group, members: [], mode: 'default',
    };
    group.members.push({ name: entry.name, ...memberStatus(entry), selected: false });
    groups.set(id, group);
  }
  tools.sort((left, right) => left.name.localeCompare(right.name));
  const containers = [...groups.values()].sort((left, right) =>
    (left.kind === right.kind ? 0 : left.kind === 'namespace' ? -1 : 1)
    || left.group.localeCompare(right.group));
  for (const container of containers) container.members.sort((left, right) => left.name.localeCompare(right.name));
  return { tools, containers };
}

function selectedMembers(container: PickerContainer): PickerMember[] {
  return container.members.filter((member) => member.selected);
}

/**
 * Targets for the current selection. Activation always emits an exact
 * `[ns,<container-mode>]` snapshot plus the displayed member names; deactivation
 * emits exact names only because namespace modifiers are invalid there.
 */
export function pickerTargets(
  model: { readonly tools: readonly PickerTool[]; readonly containers: readonly PickerContainer[] },
  mode: PickerMode,
): string[] {
  const targets: string[] = [];
  if (mode === 'deactivate') {
    for (const container of model.containers) for (const member of selectedMembers(container)) targets.push(member.name);
    for (const tool of model.tools) if (tool.selected) targets.push(tool.name);
    return targets;
  }
  for (const container of model.containers) {
    const selected = selectedMembers(container);
    if (selected.length === 0) continue;
    const modifiers = ['ns', ...(container.mode === 'default' ? [] : [container.mode])];
    targets.push(`${container.target}[${modifiers.join(',')}]`);
    for (const member of selected) targets.push(member.name);
  }
  for (const tool of model.tools) if (tool.selected) targets.push(tool.name);
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
  readonly capturesViewportInput: true;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

interface Layout {
  readonly height: number;
  readonly viewport: number;
  readonly topSeparator: boolean;
  readonly bottomSeparator: boolean;
  readonly footerRows: number;
  readonly fits: boolean;
}

/** The interactive component; exported so tests drive real input transitions. */
export function createCapabilityPicker(options: CapabilityPickerOptions): CapabilityPickerComponent {
  const { mode, tui, theme, keybindings, done } = options;
  const model = createPickerModel(options.entries, mode);
  let cursor: Cursor = { level: 'root', index: 0 };
  let expanded: PickerContainer | null = null;
  const childMemory = new Map<string, number>();

  const rootSiblingCount = (): number => model.tools.length + model.containers.length;

  const containerIndex = (container: PickerContainer): number => model.tools.length + model.containers.indexOf(container);

  const layout = (): Layout => {
    const budget = inlinePanelBudget(tui, PICKER_MIN_INLINE_ROWS);
    const height = budget.height;
    const topSeparator = height >= 5;
    const bottomSeparator = height >= 4;
    const footerRows = height >= 7 ? 2 : 1;
    const viewport = Math.max(1, height - 1 - (topSeparator ? 1 : 0) - (bottomSeparator ? 1 : 0) - footerRows);
    return { height, viewport, topSeparator, bottomSeparator, footerRows, fits: budget.fits };
  };

  const displayRows = (): DisplayRow[] => {
    if (cursor.level === 'child' && expanded !== null) {
      // Child focus shows only the parent container and its full member list;
      // the title carries the parent context.
      const rows: DisplayRow[] = [{ kind: 'container', container: expanded }];
      for (let index = 0; index < expanded.members.length; index += 1) {
        rows.push({
          kind: 'child', container: expanded, member: expanded.members[index]!, index,
          last: index === expanded.members.length - 1,
        });
      }
      return rows;
    }
    const rows: DisplayRow[] = model.tools.map((tool): DisplayRow => ({ kind: 'tool', tool }));
    for (const container of model.containers) {
      rows.push({ kind: 'container', container });
      if (expanded === container) {
        // Entered child focus renders the full member list, no summary.
        for (let index = 0; index < container.members.length; index += 1) {
          rows.push({
            kind: 'child', container, member: container.members[index]!, index,
            last: index === container.members.length - 1,
          });
        }
        continue;
      }
      // Root tree previews every container; entering one is not required to see
      // its first members. Preview rows are non-navigable and capped at seven.
      const preview = Math.min(MEMBER_PREVIEW, container.members.length);
      for (let index = 0; index < preview; index += 1) {
        rows.push({
          kind: 'child', container, member: container.members[index]!, index,
          last: index === preview - 1,
        });
      }
      if (preview < container.members.length) rows.push({ kind: 'summary', count: container.members.length - preview });
    }
    return rows;
  };

  const displayIndex = (rows: readonly DisplayRow[]): number => {
    if (cursor.level === 'root') {
      if (cursor.index < model.tools.length) return cursor.index;
      const container = model.containers[cursor.index - model.tools.length];
      return container === undefined ? 0 : rows.findIndex((row) => row.kind === 'container' && row.container === container);
    }
    const active = cursor;
    return rows.findIndex((row) => row.kind === 'child' && row.container === active.container && row.index === active.index);
  };

  const currentContainer = (): PickerContainer | null =>
    cursor.level === 'child' ? cursor.container
      : cursor.index >= model.tools.length ? model.containers[cursor.index - model.tools.length] ?? null : null;

  const currentTool = (): PickerTool | null =>
    cursor.level === 'root' && cursor.index < model.tools.length ? model.tools[cursor.index]! : null;

  const moveSibling = (delta: number): void => {
    if (cursor.level === 'root') {
      const count = rootSiblingCount();
      if (count === 0) return;
      cursor = { level: 'root', index: (cursor.index + delta + count) % count };
      expanded = null;
    } else {
      const count = cursor.container.members.length;
      if (count === 0) return;
      const index = (cursor.index + delta + count) % count;
      cursor = { level: 'child', container: cursor.container, index };
      childMemory.set(cursor.container.id, index);
    }
  };

  const jumpSibling = (toEnd: boolean): void => {
    if (cursor.level === 'root') {
      const count = rootSiblingCount();
      cursor = { level: 'root', index: toEnd ? Math.max(0, count - 1) : 0 };
      expanded = null;
    } else {
      const count = cursor.container.members.length;
      if (count === 0) return;
      const index = toEnd ? count - 1 : 0;
      cursor = { level: 'child', container: cursor.container, index };
      childMemory.set(cursor.container.id, index);
    }
  };

  const pageSibling = (delta: number, capacity: number): void => {
    if (cursor.level === 'root') {
      const count = rootSiblingCount();
      if (count === 0) return;
      cursor = { level: 'root', index: Math.max(0, Math.min(count - 1, cursor.index + delta * Math.max(1, capacity))) };
      expanded = null;
    } else {
      const count = cursor.container.members.length;
      const index = Math.max(0, Math.min(count - 1, cursor.index + delta * Math.max(1, capacity)));
      cursor = { level: 'child', container: cursor.container, index };
      childMemory.set(cursor.container.id, index);
    }
  };

  const toggleContainer = (container: PickerContainer): void => {
    const all = container.members.length > 0 && container.members.every((member) => member.selected);
    for (const member of container.members) member.selected = !all;
  };

  const selectCurrent = (): void => {
    if (cursor.level === 'child') {
      const member = cursor.container.members[cursor.index];
      if (member !== undefined) member.selected = !member.selected;
      return;
    }
    const tool = currentTool();
    if (tool !== null) { tool.selected = !tool.selected; return; }
    const container = currentContainer();
    if (container !== null) toggleContainer(container);
  };

  const cycleContainerSchema = (): void => {
    if (cursor.level !== 'root') return;
    const container = currentContainer();
    if (container !== null) container.mode = cycleMode(container.mode);
  };

  const enterContainer = (container: PickerContainer): void => {
    expanded = container;
    const remembered = childMemory.get(container.id) ?? 0;
    cursor = { level: 'child', container, index: Math.min(remembered, Math.max(0, container.members.length - 1)) };
  };

  const leaveChild = (): void => {
    if (cursor.level !== 'child') return;
    childMemory.set(cursor.container.id, cursor.index);
    cursor = { level: 'root', index: containerIndex(cursor.container) };
    expanded = null;
  };

  const complete = (): void => {
    const targets = pickerTargets(model, mode);
    done(targets.length === 0 ? null : targets);
  };

  const selectedCount = (): number => model.tools.filter((tool) => tool.selected).length
    + model.containers.reduce((total, container) => total + selectedMembers(container).length, 0);

  const configSummary = (container: PickerContainer): string => {
    const lazy = container.members.filter((member) => member.configLazy).length;
    const total = container.members.length;
    if (total === 0 || lazy === 0) return 'cfg:default';
    if (lazy === total) return 'cfg:lazy';
    return `cfg:mixed ${lazy}/${total}`;
  };

  const actualSummary = (container: PickerContainer): string | null => {
    const withheld = container.members.filter((member) => member.schemaWithheld).length;
    return withheld > 0 ? `now:withheld ${withheld}` : null;
  };

  const toolStatusText = (tool: PickerTool): string => {
    if (tool.schemaWithheld) return ' · withheld';
    if (tool.blocked) return ' · blocked';
    if (tool.banOverridden) return ' · ban overridden';
    return '';
  };

  const header = (): string[] => {
    const context = cursor.level === 'child' ? ` · in ${cursor.container.target}` : '';
    return [theme.fg('accent', theme.bold(`Capability · ${mode} · ${selectedCount()} selected${context}`))];
  };

  const footer = (height: number): string[] => height >= 7
    ? [
      theme.fg('dim', 'Enter confirm · Esc cancel · ↑↓ siblings · ←/→ parent/child'),
      theme.fg('dim', 'Tab select/bulk · Space container schema'),
    ]
    : [theme.fg('dim', 'Enter confirm · Esc cancel · Tab select · Space schema')];

  const renderRow = (row: DisplayRow, index: number, activeIndex: number): string => {
    const pointer = index === activeIndex ? theme.fg('accent', '→ ') : '  ';
    if (row.kind === 'summary') {
      return `${' '.repeat(5)}${theme.fg('dim', `… ${row.count} tools remain`)}`;
    }
    if (row.kind === 'tool') {
      const box = row.tool.selected ? theme.fg('success', '[x]') : '[ ]';
      return `${pointer}${box} ${row.tool.name}${toolStatusText(row.tool)}`;
    }
    if (row.kind === 'container') {
      const selected = selectedMembers(row.container).length;
      const total = row.container.members.length;
      const box = selected === 0 ? '[ ]' : selected === total ? theme.fg('success', '[x]') : theme.fg('warning', '[~]');
      const override = row.container.mode === 'default' ? null : `ovr:${modeLabel(row.container.mode)}`;
      const schema = override;
      const parts = [`${selected}/${total}`, configSummary(row.container), ...(schema === null ? [] : [schema]), ...(actualSummary(row.container) === null ? [] : [actualSummary(row.container)!])];
      return `${pointer}${box} ${row.container.target}  ${parts.join(' · ')}`;
    }
    const box = row.member.selected ? theme.fg('success', '[x]') : '[ ]';
    const status = row.member.schemaWithheld ? ' · withheld'
      : row.member.blocked ? ' · blocked'
        : row.member.banOverridden ? ' · ban overridden' : '';
    return `${pointer}${row.last ? '└─' : '├─'} ${box} ${row.member.name}${status}`;
  };

  return {
    capturesViewportInput: true,
    render(width: number): string[] {
      if (!Number.isFinite(width) || width < 1) return [];
      const columns = Math.max(1, Math.floor(width));
      const currentLayout = layout();
      if (!currentLayout.fits) {
        const needs = `terminal too small · /capability needs ${requiredPickerTerminalRows()} rows (${PICKER_MIN_INLINE_ROWS} picker+${INLINE_HOST_RESERVE_ROWS} host) · esc closes`;
        return [truncateToWidth(theme.fg('error', needs), columns, '')];
      }
      const head = header();
      const foot = footer(currentLayout.height);
      const display = displayRows();
      const activeIndex = Math.max(0, displayIndex(display));
      let start = Math.max(0, Math.min(activeIndex - Math.floor(currentLayout.viewport / 2), display.length - currentLayout.viewport));
      // Keep a focused parent's indented collapse summary visible together with
      // its container row, even on a short half-screen viewport.
      if (cursor.level === 'root' && currentContainer() !== null
        && display.some((row, index) => index > activeIndex && row.kind === 'summary')) {
        start = Math.max(0, Math.min(activeIndex, display.length - currentLayout.viewport));
      }
      const visible = display.slice(start, start + currentLayout.viewport);
      const body = visible.map((row, index) => renderRow(row, start + index, activeIndex));
      const separator = theme.fg('borderMuted', '─'.repeat(columns));
      const lines = [
        ...(currentLayout.topSeparator ? [separator] : []),
        ...head,
        ...body,
        ...(currentLayout.bottomSeparator ? [separator] : []),
        ...foot,
      ];
      // Preserve the key hints even when the host gives a short inline dock.
      const bounded = lines.length <= currentLayout.height ? lines
        : currentLayout.height <= 1 ? [foot[0]!]
          : currentLayout.height === 2 ? [body[0] ?? head[0]!, foot[0]!]
            : [...lines.slice(0, currentLayout.height - 1), foot[0]!];
      return bounded.slice(0, currentLayout.height).map((line) => truncateToWidth(line, columns));
    },
    handleInput(data: string): void {
      if (!layout().fits) {
        if (keybindings.matches(data, 'tui.select.cancel')) done(null);
        return;
      }
      const currentLayout = layout();
      if (keybindings.matches(data, 'tui.select.up')) { moveSibling(-1); tui.requestRender(); return; }
      if (keybindings.matches(data, 'tui.select.down')) { moveSibling(1); tui.requestRender(); return; }
      if (keybindings.matches(data, 'tui.select.cancel')) { done(null); return; }
      if (keybindings.matches(data, 'tui.select.confirm')) { complete(); return; }
      if (keybindings.matches(data, 'tui.altScreen.pageUp') || keybindings.matches(data, 'tui.select.pageUp')) {
        pageSibling(-1, currentLayout.viewport);
        tui.requestRender(); return;
      }
      if (keybindings.matches(data, 'tui.altScreen.pageDown') || keybindings.matches(data, 'tui.select.pageDown')) {
        pageSibling(1, currentLayout.viewport);
        tui.requestRender(); return;
      }
      if (keybindings.matches(data, 'tui.altScreen.top') || keybindings.matches(data, 'tui.editor.cursorLineStart')) {
        jumpSibling(false); tui.requestRender(); return;
      }
      if (keybindings.matches(data, 'tui.altScreen.bottom') || keybindings.matches(data, 'tui.editor.cursorLineEnd')) {
        jumpSibling(true); tui.requestRender(); return;
      }
      if (keybindings.matches(data, 'tui.editor.cursorLeft')) { leaveChild(); tui.requestRender(); return; }
      if (keybindings.matches(data, 'tui.editor.cursorRight')) {
        const container = currentContainer();
        if (container !== null && cursor.level === 'root') enterContainer(container);
        tui.requestRender(); return;
      }
      if (keybindings.matches(data, 'tui.input.tab')) { selectCurrent(); tui.requestRender(); return; }
      if (data === ' ') { cycleContainerSchema(); tui.requestRender(); }
    },
    invalidate(): void {},
  };
}
