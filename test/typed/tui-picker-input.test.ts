/**
 * Real TuiAltScreen input routing for the capability picker.
 *
 * Direct handleInput tests cannot prove that fullscreen viewport keys reach the
 * focused component instead of scrolling the host transcript. This harness
 * mounts the picker below a primary ScrollView with a recording terminal, like
 * the BTW dock tests do.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { initTheme, type KeybindingsManager, type Theme } from '@earendil-works/pi-coding-agent';
import {
  Container,
  KeybindingsManager as TuiKeybindingsManager,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  setKeybindings,
  stripTerminalSequences,
  type Component,
  type ProgramStatus,
  type Terminal,
} from '@earendil-works/pi-tui';

import { createCapabilityPicker } from '../../src/tui/capability-picker.ts';
import { queryToolAccess } from '../../src/capability/tool-access-view.ts';
import { capabilityHost, type CapabilityTestTool } from './support/capability-host.ts';

class RecordingTerminal implements Terminal {
  columns: number;
  rows: number;
  readonly writes: string[] = [];
  private input: ((data: string) => void) | undefined;
  private resizeHandler: (() => void) | undefined;

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.input = onInput;
    this.resizeHandler = onResize;
  }

  stop(): void {
    this.input = undefined;
    this.resizeHandler = undefined;
  }

  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  get kittyProtocolActive(): boolean { return false; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(_status: ProgramStatus): void {}

  emit(data: string): void {
    this.input?.(data);
    this.resizeHandler?.();
  }
}

function activeTheme(): Theme {
  initTheme('dark');
  const value = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for('@earendil-works/pi-coding-agent:theme')
  ];
  assert.ok(value, 'Pi theme is initialized');
  return value as Theme;
}

interface ChatViewportModule {
  createChatViewport(options: {
    document: Component;
    pendingMessages: Component;
    status: Component;
    editor: Component;
    footer: Component;
    widgetsAbove?: Component | undefined;
    widgetsBelow?: Component | undefined;
  }): { root: Component; transcript: { readonly scrollTop: number; scrollTo(value: number): void } };
}

async function loadChatViewport(): Promise<ChatViewportModule> {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const file = path.join(path.dirname(entry), 'modes/interactive/chat-viewport.js');
  return await import(pathToFileURL(file).href) as unknown as ChatViewportModule;
}

async function largePicker(rows: number) {
  const tools: CapabilityTestTool[] = [
    { name: 'codemode', description: 'Run scripts', exposure: 'direct' },
    ...Array.from({ length: 200 }, (_, index): CapabilityTestTool => ({
      name: `subagent_member_${String(index).padStart(3, '0')}`,
      description: 'Child operation',
      exposure: 'deferred',
      namespace: { name: 'subagent' },
    })),
  ];
  const fixture = capabilityHost(tools, ['codemode'], 'all');
  fixture.api.appendEntry('capability-tool-base', { version: 1, baseline: ['codemode'] });
  const entries = queryToolAccess(fixture.api, fixture.branch(), fixture.activeNames(), { includeActivatable: true }).entries;
  const terminal = new RecordingTerminal(80, rows);
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  const theme = activeTheme();
  const keybindings = new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;
  setKeybindings(keybindings as never);
  const picker = createCapabilityPicker({
    entries, mode: 'activate', tui, theme, keybindings, done: () => {},
  });
  const { createChatViewport } = await loadChatViewport();
  const viewport = createChatViewport({
    document: new Text(
      Array.from({ length: rows * 4 }, (_, index) => `MAIN_${String(index).padStart(3, '0')}`).join('\n'),
      0,
      0,
    ),
    pendingMessages: new Container(),
    status: new Container(),
    editor: picker,
    footer: new Text(' \nFOOTER_MODEL\nFOOTER_HINTS', 0, 0),
  });
  tui.setLayoutRoot(viewport.root);
  tui.start();
  tui.setFocus(picker);
  tui.renderNow(true);
  return { terminal, tui, transcript: viewport.transcript, picker };
}

type Harness = Awaited<ReturnType<typeof largePicker>>;

function emit(harness: Harness, data: string): void {
  harness.terminal.emit(data);
  harness.tui.renderNow(true);
}

function focusedLine(harness: Harness): string {
  return harness.tui.getScreenLines().map((line) => stripTerminalSequences(line))
    .find((line) => line.includes('→')) ?? '';
}

test('focused picker captures PageUp/PageDown/Home/End instead of scrolling the transcript', async (t) => {
  const harness = await largePicker(24);
  t.after(() => harness.tui.stop());
  assert.equal(harness.picker.capturesViewportInput, true);

  // Enter the 200-member container.
  emit(harness, '\x1b[B');
  emit(harness, '\x1b[C');
  const before = harness.transcript.scrollTop;
  const first = focusedLine(harness);

  emit(harness, '\x1b[6~');
  const afterPageDown = focusedLine(harness);
  assert.notEqual(afterPageDown, first, 'PageDown moves the picker child cursor');
  assert.equal(harness.transcript.scrollTop, before, 'PageDown does not scroll the host transcript');

  emit(harness, '\x1b[F');
  assert.match(focusedLine(harness), /subagent_member_199/);
  assert.equal(harness.transcript.scrollTop, before, 'End does not scroll the host transcript');
  emit(harness, '\x1b[H');
  assert.match(focusedLine(harness), /subagent_member_000/);
  assert.equal(harness.transcript.scrollTop, before, 'Home does not scroll the host transcript');

  // Leaving the focused component restores normal transcript viewport scrolling.
  harness.tui.setFocus(null);
  harness.transcript.scrollTo(0);
  const top = harness.transcript.scrollTop;
  emit(harness, '\x1b[6~');
  assert.ok(harness.transcript.scrollTop > top, 'host scrolling resumes after the picker closes');
});
