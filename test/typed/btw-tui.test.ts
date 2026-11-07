import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { initTheme, type KeybindingsManager, type Theme } from '@earendil-works/pi-coding-agent';
import {
  CURSOR_MARKER,
  KeybindingsManager as TuiKeybindingsManager,
  Container,
  ScrollView,
  TUI_KEYBINDINGS,
  Text,
  TuiAltScreen,
  VStack,
  stripTerminalSequences,
  visibleWidth,
  type Component,
  type ProgramStatus,
  type Terminal,
} from '@earendil-works/pi-tui';

import { BtwPanel, type BtwPanelOptions } from '../../src/btw/panel.ts';

/** Public `Terminal` that records writes and replays input and resize events. */
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

  write(data: string): void {
    this.writes.push(data);
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

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
  }

  resize(rows: number, columns = this.columns): void {
    this.rows = rows;
    this.columns = columns;
    this.resizeHandler?.();
  }
}

interface PendingAsk {
  readonly question: string;
  readonly onText: (text: string) => void;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface NativeHarness {
  readonly terminal: RecordingTerminal;
  readonly tui: TuiAltScreen;
  readonly panel: BtwPanel;
  readonly calls: PendingAsk[];
  readonly closeCalls: { count: number };
  screen(): string[];
  wheel(button: number, row: number): void;
  click(row: number): void;
  key(data: string): void;
}

function activeTheme(): Theme {
  initTheme('dark');
  const value = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for('@earendil-works/pi-coding-agent:theme')
  ];
  assert.ok(value, 'Pi theme is initialized');
  return value as Theme;
}

/** The dock's row budget: half the terminal, floored, capped by the rows it can claim. */
function panelRows(rows: number, minRows = 8): number {
  return Math.max(1, Math.min(Math.max(minRows, Math.round(rows / 2)), rows - 1));
}

/** Best-effort floor: the preferred minimum plus one row for the main conversation. */
function requiredRows(minRows = 8): number {
  return minRows + 1;
}

/**
 * Footer slot as the SDK composes it: a one-row spacer above a two-row footer
 * body. `Text` pads one row on each side by default, which would silently turn
 * the footer into four rows, so every fixture passes explicit padding.
 */
function footerSlot(body = 'FOOTER_MODEL\nFOOTER_HINTS'): Text {
  return new Text(` \n${body}`, 0, 0);
}

/** First screen row of the panel: the spacer sits above it, the footer below. */
function panelTop(rows: number): number {
  return rows - panelRows(rows) - 2;
}

function longAnswer(count: number): string {
  return Array.from({ length: count }, (_, index) => `ANSWER_${String(index).padStart(2, '0')}`).join('\n');
}

function mainTranscript(rows: number): string {
  return Array.from({ length: rows * 3 }, (_, index) => `MAIN_${String(index).padStart(2, '0')}`).join('\n');
}

/**
 * Mount the dock exactly as the SDK does: a transcript that grows, and the
 * panel in the editor slot with its natural height at the bottom.
 */
/** Shape of the SDK's internal dock composition; the package exports no types for it. */
interface ChatViewportModule {
  createChatViewport(options: {
    document: Component;
    pendingMessages: Component;
    status: Component;
    editor: Component;
    footer: Component;
    widgetsAbove?: Component | undefined;
    widgetsBelow?: Component | undefined;
  }): { root: Component; transcript: ScrollView };
}

/**
 * The SDK does not export its dock composition from the package entry point, so
 * tests load the runtime file the client actually uses. A missing file is a hard
 * failure: a hand-copied layout would hide exactly the regression under test.
 */
async function loadChatViewport(): Promise<ChatViewportModule> {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const file = path.join(path.dirname(entry), 'modes/interactive/chat-viewport.js');
  return await import(pathToFileURL(file).href) as unknown as ChatViewportModule;
}

interface DockExtras {
  readonly statusRows?: number;
  readonly widgetRows?: number;
}

/** Mount the panel through the SDK's own `createChatViewport` dock. */
async function sdkNative(rows: number, columns: number, extras: DockExtras = {}): Promise<NativeHarness> {
  const { createChatViewport } = await loadChatViewport();
  const terminal = new RecordingTerminal(columns, rows);
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  const calls: PendingAsk[] = [];
  const closeCalls = { count: 0 };
  const keybindings = new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;
  const panel = new BtwPanel(tui, activeTheme(), keybindings, {
    minRows: 8,
    ask(question, onText) {
      return new Promise<void>((resolve, reject) => {
        calls.push({ question, onText, resolve, reject });
      });
    },
    async cancel() {},
    onClose() { closeCalls.count++; },
  });
  const statusRows = extras.statusRows ?? 0;
  const widgetRows = extras.widgetRows ?? 0;
  const filler = (count: number, label: string): Text =>
    new Text(Array.from({ length: count }, (_, index) => `${label}_${String(index)}`).join('\n'), 0, 0);
  const viewport = createChatViewport({
    document: new Text(mainTranscript(rows), 0, 0),
    // The SDK keeps these as Containers, which render zero rows when empty.
    pendingMessages: new Container(),
    status: statusRows > 0 ? filler(statusRows, 'STATUS') : new Container(),
    editor: panel,
    widgetsAbove: widgetRows > 0 ? filler(widgetRows, 'WIDGET') : undefined,
    footer: footerSlot(),
  });
  tui.setLayoutRoot(viewport.root);
  tui.start();
  tui.setFocus(panel);
  panel.focused = true;
  tui.renderNow(true);

  const column = Math.floor(columns / 2);
  return {
    terminal,
    tui,
    panel,
    calls,
    closeCalls,
    screen: () => tui.getScreenLines().map((line) => stripTerminalSequences(line)),
    wheel(button: number, row: number): void {
      terminal.emit(`\x1b[<${String(button)};${String(column)};${String(row + 1)}M`);
      tui.renderNow(true);
    },
    click(row: number): void {
      terminal.emit(`\x1b[<0;${String(column)};${String(row + 1)}M`);
      terminal.emit(`\x1b[<0;${String(column)};${String(row + 1)}m`);
      tui.renderNow(true);
    },
    key(data: string): void {
      terminal.emit(data);
      tui.renderNow(true);
    },
  };
}

/** Screen row of the panel's first line inside the SDK dock. */
function sdkPanelTop(frame: string[]): number {
  return frame.findIndex((line) => /^─+$/.test(line) && line.length > 10);
}

function native(rows = 30, columns = 100): NativeHarness {
  const terminal = new RecordingTerminal(columns, rows);
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  const document = new Text(mainTranscript(rows));
  const transcriptView = new ScrollView(document, { follow: 'end', primary: true });
  const calls: PendingAsk[] = [];
  const closeCalls = { count: 0 };
  const keybindings = new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;
  const options: BtwPanelOptions = {
    minRows: 8,
    ask(question, onText) {
      return new Promise<void>((resolve, reject) => {
        calls.push({ question, onText, resolve, reject });
      });
    },
    async cancel() {},
    onClose() {
      closeCalls.count++;
    },
  };
  const panel = new BtwPanel(tui, activeTheme(), keybindings, options);
  // The SDK's composition around the editor slot: a one-row spacer above it and a
  // two-row footer below. Without them the panel would look fine here and clip in
  // the real client.
  const spacer = new Text(' ', 0, 0);
  const footer = new Text('FOOTER_MODEL\nFOOTER_HINTS', 0, 0);
  const dock = new VStack([
    { component: spacer, basis: 1, shrink: 0 },
    { component: panel, basis: 'auto', shrink: 1, minSize: 3 },
    { component: footer, basis: 2, shrink: 0 },
  ]);
  tui.setLayoutRoot(
    new VStack([
      { component: transcriptView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: dock, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
    ]),
  );
  tui.start();
  tui.setFocus(panel);
  panel.focused = true;
  tui.renderNow(true);

  const column = Math.floor(columns / 2);
  return {
    terminal,
    tui,
    panel,
    calls,
    closeCalls,
    screen: () => tui.getScreenLines().map((line) => stripTerminalSequences(line)),
    wheel(button: number, row: number): void {
      // SGR mouse coordinates are 1-based.
      terminal.emit(`\x1b[<${String(button)};${String(column)};${String(row + 1)}M`);
      tui.renderNow(true);
    },
    click(row: number): void {
      terminal.emit(`\x1b[<0;${String(column)};${String(row + 1)}M`);
      terminal.emit(`\x1b[<0;${String(column)};${String(row + 1)}m`);
      tui.renderNow(true);
    },
    key(data: string): void {
      terminal.emit(data);
      tui.renderNow(true);
    },
  };
}

test('the dock sits at the bottom with a stable, terminal-sized height', () => {
  const h = native(30);
  const lines = h.screen();
  assert.equal(lines.length, 30, 'the frame fills the terminal');
  const top = panelTop(30);
  const height = panelRows(30);

  assert.match(lines[top] ?? '', /^─+$/, 'the panel opens with a full-width separator');
  assert.match(lines[top + 1] ?? '', /btw · side question/);
  assert.match(lines[30 - 3] ?? '', /esc close/, 'the help row is the last panel row, above the footer');
  assert.ok(lines.slice(30 - 2).join('\n').includes('FOOTER_MODEL'), 'the footer keeps its rows');
  assert.ok(lines[top - 1]?.trim() === '', 'the spacer row above the panel survives');
  assert.ok(lines.slice(0, top).some((line) => line.includes('MAIN_')), 'the transcript stays above the dock');
  assert.equal(h.panel.render(100).length, height, 'the panel claims exactly its budget');
});

test('the dock asks for half the terminal and the SDK grants it when nothing competes', async () => {
  const rows = 24;
  const h = await sdkNative(rows, 100);
  const frame = h.screen().join('\n');

  assert.equal(h.panel.render(100).length, panelRows(rows), 'the panel requests its half-screen budget');
  assert.match(frame, /btw · side question/);
  assert.match(frame, /esc close/, 'the request fits when the dock has no other rows');
  assert.match(frame, /FOOTER_HINTS/);
});

test('competing SDK dock rows preserve the terminal-driven height request', async () => {
  // SDK allocation may clip the result. The plugin keeps its preferred height;
  // the exact clipping policy belongs to the SDK rather than this contract.
  const rows = 12;
  const h = await sdkNative(rows, 100, { statusRows: 1, widgetRows: 4 });
  const frame = h.screen().join('\n');

  assert.match(frame, /btw · side question/, 'the panel still opens');
  assert.equal(h.panel.render(100).length, 8, 'surrounding widgets do not change the preferred minimum');
});

test('narrow terminals keep every dock row inside the viewport', () => {
  for (const width of [1, 2, 5, 20, 40, 100, 160]) {
    const h = native(30, width);
    const frame = h.screen();
    assert.equal(frame.length, 30, `width ${width} keeps the frame height`);
    assert.ok(
      frame.every((line) => visibleWidth(line) <= width),
      `width ${width} keeps every row inside the terminal`,
    );
  }
});

test('a long answer streams into the dock without moving the transcript', async () => {
  const h = native(30);
  const transcriptTop = h.tui.viewportTop;
  h.key('what happened');
  h.key('\r');
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.question, 'what happened');

  h.calls[0]!.onText(longAnswer(120));
  h.tui.renderNow(true);
  const lines = h.screen();
  assert.match(lines.join('\n'), /ANSWER_119/, 'the newest answer line is on screen');
  assert.equal(h.tui.viewportTop, transcriptTop, 'streaming does not scroll the main transcript');
  assert.equal(h.tui.isFollowingOutput, true, 'the transcript still follows its own output');
  assert.equal(lines.length, 30, 'the dock height does not follow the content');
});

test('real wheel routing scrolls the dock and never the transcript underneath', async () => {
  const h = native(30);
  h.key('scroll me');
  h.key('\r');
  await Promise.resolve();
  h.calls[0]!.onText(longAnswer(120));
  h.tui.renderNow(true);

  const viewportRow = 30 - panelRows(30) + 3;
  const transcriptTop = h.tui.viewportTop;
  assert.equal(h.panel.isFollowingEnd, true);

  h.wheel(64, viewportRow); // wheel up
  assert.equal(h.panel.isFollowingEnd, false, 'the dock scrolled up');
  assert.equal(h.tui.viewportTop, transcriptTop, 'the transcript did not move');
  const paused = h.panel.scrollTop;

  h.calls[0]!.onText(longAnswer(200));
  h.tui.renderNow(true);
  assert.equal(h.panel.scrollTop, paused, 'a paused dock keeps its reading position while text streams');
  assert.equal(h.tui.viewportTop, transcriptTop);

  for (let notch = 0; notch < 400 && !h.panel.isFollowingEnd; notch++) h.wheel(65, viewportRow);
  assert.equal(h.panel.isFollowingEnd, true, 'returning to the end resumes following');
  assert.equal(h.tui.viewportTop, transcriptTop, 'the transcript never scrolled during dock scrolling');
  assert.match(h.screen().join('\n'), /ANSWER_199/);
});

test('a real wheel notch moves one line and never skips content', async () => {
  const h = native(30);
  h.key('fine grained');
  h.key('\r');
  await Promise.resolve();
  h.calls[0]!.onText(longAnswer(120));
  h.tui.renderNow(true);

  const row = 30 - panelRows(30) + 3;
  const viewport = h.panel.viewportRows;
  const page = viewport - 1;
  const start = h.panel.scrollTop;
  assert.ok(start > 0, 'the answer is longer than the viewport');

  h.wheel(64, row);
  assert.equal(h.panel.scrollTop, start - 1, 'a single notch moves exactly one line');

  let previousTop = h.panel.scrollTop;
  for (let notch = 0; notch < 300 && previousTop > 0; notch++) {
    h.wheel(64, row);
    const next = h.panel.scrollTop;
    assert.ok(previousTop - next <= page, 'no notch moves more than one page');
    assert.ok(next + viewport > previousTop, 'windows overlap, so every line is reachable');
    previousTop = next;
  }
  assert.equal(previousTop, 0, 'the wheel reaches the first answer line');
});

test('wheel at the dock boundary stays in the dock, wheel above it moves the transcript', async () => {
  const h = native(30);
  h.key('boundary');
  h.key('\r');
  await Promise.resolve();
  h.calls[0]!.onText('short answer');
  h.tui.renderNow(true);

  const row = 30 - panelRows(30) + 2;
  const transcriptTop = h.tui.viewportTop;
  h.wheel(65, row); // wheel down with nothing to scroll
  h.wheel(64, row);
  h.wheel(65, row);
  assert.equal(h.tui.viewportTop, transcriptTop, 'the dock consumed wheel input at its boundaries');

  h.wheel(64, 2); // wheel up over the transcript
  assert.ok(h.tui.viewportTop < transcriptTop, 'wheel above the dock scrolls the transcript');
});

test('PgUp and PgDn belong to the focused dock instead of the transcript', async () => {
  const h = native(30);
  h.key('paging');
  h.key('\r');
  await Promise.resolve();
  h.calls[0]!.onText(longAnswer(200));
  h.tui.renderNow(true);

  const transcriptTop = h.tui.viewportTop;
  h.key('\x1b[5~');
  assert.equal(h.panel.isFollowingEnd, false, 'PgUp scrolled the dock');
  assert.equal(h.tui.viewportTop, transcriptTop, 'PgUp did not scroll the transcript');

  for (let press = 0; press < 40; press++) h.key('\x1b[6~');
  assert.equal(h.panel.isFollowingEnd, true, 'PgDn returns the dock to the end');
  assert.equal(h.tui.viewportTop, transcriptTop);

  h.tui.setFocus(null);
  h.key('\x1b[5~');
  assert.ok(h.tui.viewportTop < transcriptTop, 'without the dock focused the transcript pages again');
});

test('resize keeps the dock at the bottom and inside the new terminal', () => {
  const h = native(30);
  for (const rows of [24, 20, 16, 13]) {
    h.terminal.resize(rows);
    h.tui.renderNow(true);
    const lines = h.screen();
    const top = panelTop(rows);
    assert.equal(lines.length, rows, `rows=${rows} fills the terminal`);
    assert.match(lines[top + 1] ?? '', /btw · side question/, `rows=${rows} keeps the dock at the bottom`);
    assert.equal(lines[top] ?? '', '─'.repeat(100), `rows=${rows} keeps the panel separator on its own row`);
    assert.match(lines[rows - 3] ?? '', /esc close/, `rows=${rows} keeps the panel help row unclipped`);
    assert.ok(lines.slice(rows - 2).join('\n').includes('FOOTER_MODEL'), `rows=${rows} keeps the footer unclipped`);
    assert.ok(top >= 1, `rows=${rows} keeps a transcript row above the dock`);
    assert.doesNotMatch(lines[top - 1] ?? '', /─/, `rows=${rows} leaves the panel chrome inside the dock`);
    if (rows >= 16) {
      assert.ok(
        lines.slice(0, top).some((line) => line.includes('MAIN_')),
        `rows=${rows} keeps the transcript above the dock`,
      );
    }
    assert.equal(h.panel.render(100).length, panelRows(rows), `rows=${rows} gives the panel exactly its budget`);
  }
});

test('a real resize below the dock minimum surfaces an error and recovers', async () => {
  const h = native(30);
  h.key('resize me');
  h.key('\r');
  await Promise.resolve();
  h.calls[0]!.onText(longAnswer(60));
  h.tui.renderNow(true);
  assert.match(h.screen().join('\n'), /btw · side question/);

  h.terminal.resize(8);
  h.tui.renderNow(true);
  const shrunk = h.screen();
  assert.equal(shrunk.length, 8, 'the frame follows the new terminal height');
  assert.match(shrunk.join('\n'), new RegExp(`terminal too small for /btw · needs ${String(requiredRows())} rows`));
  assert.doesNotMatch(shrunk.join('\n'), /btw · side question/, 'no squeezed dock is left behind');
  assert.ok(shrunk.slice(8 - 2).join('\n').includes('FOOTER_MODEL'), 'the footer still gets its rows');

  h.terminal.resize(30);
  h.tui.renderNow(true);
  const restored = h.screen().join('\n');
  assert.match(restored, /btw · side question/, 'the dock comes back after the terminal grows');
  assert.match(restored, /esc close/);
  assert.match(restored, /ANSWER_59/, 'the answer survives the shrink');
});

test('the composer keeps native focus, shows typed text, and emits the cursor marker', () => {
  const h = native(30);
  h.key('hello composer');
  h.tui.renderNow(true);

  const lines = h.screen();
  const composer = lines.findIndex((line) => line.includes('hello composer'));
  assert.ok(composer >= 0, 'typed text is visible in the dock');
  assert.ok(composer >= 30 - panelRows(30), 'the composer sits inside the dock');
  assert.ok(
    h.panel.render(100).some((line) => line.includes(CURSOR_MARKER)),
    'the native editor still emits CURSOR_MARKER for IME placement',
  );
});

test('shift+enter adds a composer line and the dock keeps its height', () => {
  const h = native(30);
  h.key('line one');
  h.key('\x1b\r');
  h.key('line two');
  h.tui.renderNow(true);
  const lines = h.screen();
  const dock = lines.slice(30 - panelRows(30)).join('\n');
  assert.match(dock, /line one/);
  assert.match(dock, /line two/);
  assert.equal(lines.length, 30, 'a multiline composer does not grow past the dock');
});

test('escape closes the dock once and later input is ignored', async () => {
  const h = native(30);
  h.key('close me');
  h.key('\r');
  await Promise.resolve();
  h.calls[0]!.onText('answer');
  h.tui.renderNow(true);

  h.key('\x1b');
  assert.equal(h.closeCalls.count, 1, 'escape released the owner once');
  const before = h.panel.render(100);
  h.key('ignored');
  h.key('\r');
  assert.deepEqual(h.panel.render(100), before, 'a closed dock ignores further input');
  assert.equal(h.calls.length, 1, 'a closed dock never starts another ask');
});

test('clicking the composer restores focus to the dock', () => {
  const h = native(30);
  h.tui.setFocus(null);
  assert.equal(h.panel.focused, false);

  // The composer input sits one row below the editor's top border.
  h.click(panelTop(30) + 1 + 1 + h.panel.viewportRows + 1);
  assert.equal(h.panel.focused, true, 'a composer click focuses the dock');
  assert.equal(h.tui.getFocusedComponent(), h.panel);
});
