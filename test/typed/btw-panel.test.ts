import assert from 'node:assert/strict';
import test from 'node:test';

import { initTheme, type KeybindingsManager, type Theme } from '@earendil-works/pi-coding-agent';
import {
  CURSOR_MARKER,
  Markdown,
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
  stripTerminalSequences,
  visibleWidth,
  type TUI,
  type TuiMouseEvent,
} from '@earendil-works/pi-tui';

import { BtwPanel, type BtwPanelOptions } from '../../src/btw/panel.ts';

class FakeTui {
  readonly terminal = { rows: 20, columns: 80 };
  readonly mode: 'fullscreen' | 'regular';
  renders = 0;

  constructor(rows: number, mode: 'fullscreen' | 'regular' = 'fullscreen') {
    this.terminal.rows = rows;
    this.mode = mode;
  }

  requestRender(): void {
    this.renders++;
  }

  asTui(): TUI {
    return this as unknown as TUI;
  }
}

interface PendingAsk {
  readonly question: string;
  readonly onText: (text: string) => void;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface Harness {
  readonly tui: FakeTui;
  readonly panel: BtwPanel;
  readonly calls: PendingAsk[];
  readonly cancelCalls: {
    count: number;
    resolve(): void;
    reject(error: unknown): void;
  };
  readonly closeCalls: { count: number };
}

function activeTheme(): Theme {
  initTheme('dark');
  const value = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for('@earendil-works/pi-coding-agent:theme')
  ];
  assert.ok(value, 'Pi theme is initialized');
  return value as Theme;
}

function harness(
  options: { initialQuestion?: string; rows?: number; minRows?: number; mode?: 'fullscreen' | 'regular' } = {},
): Harness {
  const tui = new FakeTui(options.rows ?? 24, options.mode ?? 'fullscreen');
  const calls: PendingAsk[] = [];
  let cancelResolve: (() => void) | undefined;
  let cancelReject: ((error: unknown) => void) | undefined;
  const cancelCalls = {
    count: 0,
    resolve(): void {
      cancelResolve?.();
    },
    reject(error: unknown): void {
      cancelReject?.(error);
    },
  };
  const closeCalls = { count: 0 };
  const panelOptions = {
    minRows: options.minRows ?? 8,
    ...(options.initialQuestion === undefined ? {} : { initialQuestion: options.initialQuestion }),
    ask(question: string, onText: (cumulativeText: string) => void): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        calls.push({ question, onText, resolve, reject });
      });
    },
    cancel(): Promise<void> {
      cancelCalls.count++;
      return new Promise<void>((resolve, reject) => {
        cancelResolve = resolve;
        cancelReject = reject;
      });
    },
    onClose(): void {
      closeCalls.count++;
    },
  } satisfies BtwPanelOptions;

  const keybindings = new TuiKeybindingsManager(TUI_KEYBINDINGS) as unknown as KeybindingsManager;
  const panel = new BtwPanel(tui.asTui(), activeTheme(), keybindings, panelOptions);
  return { tui, panel, calls, cancelCalls, closeCalls };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const plain = (lines: string[]): string => lines.map((line) => stripTerminalSequences(line)).join('\n');
const renderPlain = (panel: BtwPanel, width = 60): string => plain(panel.render(width));

function typeText(panel: BtwPanel, text: string): void {
  for (const character of text) panel.handleInput(character);
}

/** The dock's row budget: half the terminal, floored, capped by the rows it can claim. */
function panelRows(rows: number, minRows = 8): number {
  return Math.max(1, Math.min(Math.max(minRows, Math.round(rows / 2)), rows - 1));
}

/** Best-effort floor: the preferred minimum plus one row for the main conversation. */
function requiredRows(minRows = 8): number {
  return minRows + 1;
}

function longAnswer(count: number): string {
  return Array.from({ length: count }, (_, index) => `LINE_${String(index).padStart(2, '0')}`).join('\n');
}

function wheel(panel: BtwPanel, delta: number, y = 3): ReturnType<BtwPanel['handleMouse']> {
  const event: TuiMouseEvent = {
    type: 'wheel',
    button: 'none',
    x: 5,
    y,
    screenX: 5,
    screenY: y,
    width: 60,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: delta,
  };
  return panel.handleMouse(event);
}

test('initial question submits once and cumulative text replaces the assistant answer', async () => {
  const h = harness({ initialQuestion: 'What changed?' });
  await flush();

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.question, 'What changed?');
  assert.equal(renderPlain(h.panel).split('What changed?').length - 1, 1);

  h.calls[0]!.onText('First');
  assert.match(renderPlain(h.panel), /First/);
  h.calls[0]!.onText('First answer');
  assert.ok(renderPlain(h.panel).split('\n').some((line) => line.includes('First answer')));

  h.calls[0]!.resolve();
  await flush();
  await flush();
  h.calls[0]!.onText('late after complete');
  assert.doesNotMatch(renderPlain(h.panel), /late after complete/);
  assert.equal(h.calls.length, 1, 'the initial question is submitted only once');
  assert.equal(h.closeCalls.count, 0);

  typeText(h.panel, 'follow up');
  h.panel.handleInput('\r');
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]!.question, 'follow up');
});

test('composer accepts multiline text and refuses a simultaneous ask', async () => {
  const h = harness();
  await flush();
  assert.equal(h.calls.length, 0);

  typeText(h.panel, 'first line');
  h.panel.handleInput('\x1b\r'); // shift+enter / explicit newline
  typeText(h.panel, 'second line');
  h.panel.handleInput('\r');
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.question, 'first line\nsecond line');

  typeText(h.panel, 'draft while waiting');
  h.panel.handleInput('\r');
  await flush();
  assert.equal(h.calls.length, 1, 'enter cannot start a simultaneous ask');

  h.panel.handleInput('\x15'); // ctrl+u clears the retained draft
  h.calls[0]!.resolve();
  await flush();

  typeText(h.panel, 'next question');
  h.panel.handleInput('\r');
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]!.question, 'next question');
  assert.equal(h.closeCalls.count, 0);

  h.panel.handleInput('\x03'); // ctrl+c without an active ask is not a close
  assert.equal(h.closeCalls.count, 0);
});

test('ctrl+c keeps the turn cancelling until cancel settles, then allows a follow-up', async () => {
  const h = harness({ initialQuestion: 'cancel this' });
  await flush();
  h.calls[0]!.onText('partial answer');

  h.panel.handleInput('\x03');
  await flush();
  assert.equal(h.cancelCalls.count, 1);
  assert.equal(h.closeCalls.count, 0);
  let text = renderPlain(h.panel);
  assert.match(text, /partial answer/);
  assert.match(text, /Cancelling/);
  assert.doesNotMatch(text, /Cancelled/);

  h.panel.handleInput('\x03'); // a second ctrl+c must not start another cancellation
  assert.equal(h.cancelCalls.count, 1);

  h.calls[0]!.onText('late answer');
  h.calls[0]!.resolve();
  await flush();
  assert.doesNotMatch(renderPlain(h.panel), /late answer/);

  typeText(h.panel, 'too early');
  h.panel.handleInput('\r');
  await flush();
  assert.equal(h.calls.length, 1, 'follow-up waits for cancellation to settle');

  h.cancelCalls.resolve();
  await flush();
  text = renderPlain(h.panel);
  assert.match(text, /Cancelled/);
  assert.doesNotMatch(text, /Cancelling/);

  h.panel.handleInput('\x15'); // clear the retained draft
  typeText(h.panel, 'follow up');
  h.panel.handleInput('\r');
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]!.question, 'follow up');
});

test('failed cancellation is reported as an error and never claims success', async () => {
  const h = harness({ initialQuestion: 'cancel fails' });
  await flush();
  h.calls[0]!.onText('partial answer');

  h.panel.handleInput('\x03');
  await flush();
  assert.match(renderPlain(h.panel), /Cancelling/);

  h.cancelCalls.reject(new Error('backend refused'));
  await flush();
  const text = renderPlain(h.panel);
  assert.match(text, /Error: cancellation failed: backend refused/);
  assert.doesNotMatch(text, /Cancelled/);

  typeText(h.panel, 'retry');
  h.panel.handleInput('\r');
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]!.question, 'retry');

  h.calls[0]!.onText('late answer');
  assert.doesNotMatch(renderPlain(h.panel), /late answer/);
});

test('escape closes immediately, cancels in-flight work, and dispose suppresses late callbacks', async () => {
  const h = harness({ initialQuestion: 'close this' });
  await flush();

  h.panel.handleInput('\x1b');
  assert.equal(h.closeCalls.count, 1, 'escape closes without waiting for cancel');
  assert.equal(h.cancelCalls.count, 1);

  h.calls[0]!.onText('late after close');
  h.calls[0]!.resolve();
  await flush();
  assert.doesNotMatch(renderPlain(h.panel), /late after close/);

  h.panel.dispose();
  h.panel.dispose();
  h.panel.handleInput('\x1b');
  assert.equal(h.closeCalls.count, 1);
});

test('escape closes immediately while a cancellation is pending', async () => {
  const h = harness({ initialQuestion: 'cancel then close' });
  await flush();
  h.panel.handleInput('\x03');
  await flush();
  assert.equal(h.cancelCalls.count, 1);
  assert.equal(h.closeCalls.count, 0);

  h.panel.handleInput('\x1b');
  assert.equal(h.closeCalls.count, 1);
  assert.equal(h.cancelCalls.count, 1);

  h.cancelCalls.resolve();
  await flush();
  assert.equal(h.closeCalls.count, 1);
});

test('escape closes an idle panel without cancelling a backend ask', () => {
  const h = harness();
  h.panel.handleInput('\x1b');
  assert.equal(h.closeCalls.count, 1);
  assert.equal(h.cancelCalls.count, 0);
});

test('dispose before the initial microtask suppresses the submit and notifies once', async () => {
  const h = harness({ initialQuestion: 'never ask' });
  h.panel.dispose();
  h.panel.dispose();
  await flush();

  assert.equal(h.calls.length, 0);
  assert.equal(h.closeCalls.count, 1);
});

test('dispose during an ask suppresses late text and resolves the owner once', async () => {
  const h = harness({ initialQuestion: 'dispose mid-ask' });
  await flush();
  h.calls[0]!.onText('before dispose');

  h.panel.dispose();
  h.calls[0]!.onText('after dispose');
  h.calls[0]!.resolve();
  await flush();

  assert.doesNotMatch(renderPlain(h.panel), /after dispose/);
  assert.equal(h.closeCalls.count, 1);
});

test('ask failure is shown as a turn error and a follow-up is accepted', async () => {
  const h = harness({ initialQuestion: 'fail' });
  await flush();

  h.calls[0]!.reject(new Error('backend unavailable'));
  await flush();
  const text = renderPlain(h.panel);
  assert.match(text, /Error: backend unavailable/);
  assert.equal(h.closeCalls.count, 0);

  typeText(h.panel, 'retry');
  h.panel.handleInput('\r');
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]!.question, 'retry');
});

test('the dock keeps a terminal-sized height that long answers cannot grow', async () => {
  const h = harness({ initialQuestion: 'size', rows: 20 });
  await flush();

  const before = h.panel.render(50);
  assert.equal(before.length, panelRows(20), 'height comes from the terminal, not the content');
  assert.match(plain(before), /─{10,}/, 'a clear separator opens the dock');

  h.calls[0]!.onText(longAnswer(200));
  const after = h.panel.render(50);
  assert.equal(after.length, panelRows(20), 'streaming answers do not resize the dock');
  assert.match(plain(after), /LINE_199/, 'the newest line is visible while following');

  for (const rows of [50, 24, 20, 16, 12]) {
    h.tui.terminal.rows = rows;
    const lines = h.panel.render(50);
    assert.equal(lines.length, panelRows(rows), `rows=${rows} keeps the dock bounded`);
    assert.ok(lines.length <= rows - 1, `rows=${rows} leaves room above`);
  }

  // Below the required terminal height the dock reports the problem in one row.
  for (const rows of [8, 5, 3, 1]) {
    h.tui.terminal.rows = rows;
    const lines = h.panel.render(50);
    assert.equal(lines.length, 1, `rows=${rows} collapses to the error row`);
    assert.match(plain(lines), /terminal too small for \/btw/);
  }
});

test('narrow and degenerate widths stay inside the viewport', async () => {
  const h = harness({ rows: 16, initialQuestion: 'narrow' });
  await flush();
  h.calls[0]!.onText(longAnswer(40));

  for (const width of [1, 2, 3, 10, 20, 40, 80]) {
    const lines = h.panel.render(width);
    assert.ok(lines.length > 0, `width ${width} renders`);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `width ${width} is respected`,
    );
  }

  assert.deepEqual(h.panel.render(0), []);
  assert.deepEqual(h.panel.render(Number.NaN), []);
});

test('unchanged overflow frames reuse both widths instead of reflowing twice', async (t) => {
  const h = harness({ rows: 24, initialQuestion: 'layout cache' });
  await flush();
  h.calls[0]!.onText(longAnswer(400));

  // The public Markdown renderer is the document's only layout work, so counting
  // its calls counts layouts without adding a production counter.
  const originalRender = Markdown.prototype.render;
  let layouts = 0;
  Markdown.prototype.render = function counted(this: Markdown, width: number): string[] {
    layouts++;
    return originalRender.call(this, width);
  };
  t.after(() => {
    Markdown.prototype.render = originalRender;
  });

  h.panel.render(80);
  const opening = layouts;
  assert.ok(opening >= 1 && opening <= 2, `the opening frame lays out at most twice (got ${String(opening)})`);

  for (let repeat = 0; repeat < 10; repeat++) h.panel.render(80);
  assert.equal(layouts, opening, 'ten unchanged frames reflow nothing');

  h.calls[0]!.onText(longAnswer(401));
  h.panel.render(80);
  assert.equal(layouts, opening + 2, 'a changed overflow frame rebuilds the two widths it needs, once each');

  const streamed = layouts;
  for (let repeat = 0; repeat < 5; repeat++) h.panel.render(80);
  assert.equal(layouts, streamed, 'the rebuilt widths stay cached for following unchanged frames');

  h.tui.terminal.rows = 30;
  const resizedAt = layouts;
  for (let repeat = 0; repeat < 5; repeat++) h.panel.render(80);
  assert.equal(layouts, resizedAt, 'a taller terminal reuses the widths it already laid out');
});

test('an overflowing answer shows a scrollbar and a fitting one does not', async () => {
  const h = harness({ rows: 24, initialQuestion: 'scrollbar' });
  await flush();
  h.calls[0]!.onText('short');
  assert.doesNotMatch(renderPlain(h.panel, 40), /│|█/, 'no scrollbar without overflow');

  h.calls[0]!.onText(longAnswer(80));
  const text = renderPlain(h.panel, 40);
  assert.match(text, /│/, 'track is visible while overflowing');
  assert.match(text, /█/, 'thumb is visible while overflowing');
});

test('wheel scrolling pauses following, keeps the reading position, and resumes at the end', async () => {
  const h = harness({ rows: 24, initialQuestion: 'follow' });
  await flush();
  h.calls[0]!.onText(longAnswer(60));
  assert.equal(h.panel.isFollowingEnd, true);
  assert.match(renderPlain(h.panel, 50), /LINE_59/);

  const result = wheel(h.panel, -3);
  assert.deepEqual(result, { handled: true }, 'the dock consumes wheel input');
  assert.equal(h.panel.isFollowingEnd, false);
  const pausedTop = h.panel.scrollTop;
  const paused = renderPlain(h.panel, 50);
  assert.doesNotMatch(paused, /LINE_59/, 'scrolling up leaves the newest line');

  h.calls[0]!.onText(longAnswer(120));
  assert.equal(h.panel.scrollTop, pausedTop, 'streaming updates do not move a paused viewport');
  assert.match(renderPlain(h.panel, 50), new RegExp(paused.split('\n').find((line) => line.includes('LINE_'))!.trim().split(/\s+/)[0]!));

  for (let notch = 0; notch < 60; notch++) wheel(h.panel, 3);
  assert.equal(h.panel.isFollowingEnd, true, 'scrolling back to the end resumes following');
  assert.match(renderPlain(h.panel, 50), /LINE_119/);

  h.calls[0]!.onText(longAnswer(140));
  assert.match(renderPlain(h.panel, 50), /LINE_139/, 'following keeps up with new text');
});

test('one wheel event never steps over lines the user cannot see', async () => {
  const h = harness({ rows: 24, initialQuestion: 'step size' });
  await flush();
  h.calls[0]!.onText(longAnswer(200));
  h.panel.render(50);

  const viewport = h.panel.viewportRows;
  assert.ok(viewport > 1, 'the viewport has room to scroll');
  const page = viewport - 1;

  const top = h.panel.scrollTop;
  wheel(h.panel, -1);
  assert.equal(h.panel.scrollTop, top - 1, 'an isolated notch moves a single line');

  const beforeClamp = h.panel.scrollTop;
  wheel(h.panel, -6);
  assert.equal(h.panel.scrollTop, beforeClamp - Math.min(page, 6), 'an accelerated notch stays within a page');

  const beforeHostile = h.panel.scrollTop;
  wheel(h.panel, -400);
  assert.equal(h.panel.scrollTop, beforeHostile - page, 'an oversized delta is clamped to one page');

  // Every line must become visible: consecutive windows always overlap.
  let previousTop = h.panel.scrollTop;
  for (let step = 0; step < 400 && previousTop > 0; step++) {
    wheel(h.panel, -400);
    const next = h.panel.scrollTop;
    assert.ok(previousTop - next <= page, 'a step never exceeds one page');
    assert.ok(next + viewport > previousTop, 'consecutive windows overlap, so no line is skipped');
    previousTop = next;
  }
  assert.equal(previousTop, 0, 'repeated wheel events reach the top of the answer');
});

test('wheel input is consumed everywhere in the dock, even at the boundaries', async () => {
  const h = harness({ rows: 24, initialQuestion: 'bounds' });
  await flush();
  h.calls[0]!.onText('one line');

  assert.deepEqual(wheel(h.panel, 3), { handled: true }, 'wheel down at the end is still ours');
  assert.deepEqual(wheel(h.panel, -3), { handled: true }, 'wheel up without overflow is still ours');
  assert.deepEqual(wheel(h.panel, -3, 0), { handled: true }, 'wheel over the title row is still ours');
  assert.equal(h.panel.scrollTop, 0);
});

test('page keys scroll the answer viewport and the panel captures viewport input', async () => {
  const h = harness({ rows: 24, initialQuestion: 'paging' });
  await flush();
  h.calls[0]!.onText(longAnswer(120));
  h.panel.render(50);

  assert.equal(h.panel.capturesViewportInput, true, 'PgUp/PgDn must not be taken by the transcript');

  const before = h.panel.scrollTop;
  h.panel.handleInput('\x1b[5~');
  assert.ok(h.panel.scrollTop < before, 'PgUp scrolls the answer up');
  assert.equal(h.panel.isFollowingEnd, false);

  h.panel.handleInput('\x1b[6~');
  assert.ok(h.panel.scrollTop > 0 || h.panel.isFollowingEnd, 'PgDn moves back down');

  for (let press = 0; press < 40; press++) h.panel.handleInput('\x1b[6~');
  assert.equal(h.panel.isFollowingEnd, true);
});

test('scrollbar press and drag move the answer viewport', async () => {
  const h = harness({ rows: 24, initialQuestion: 'drag' });
  await flush();
  h.calls[0]!.onText(longAnswer(200));
  h.panel.render(40);

  const column = 39;
  const press: TuiMouseEvent = {
    type: 'press', button: 'left', x: column, y: 2, screenX: column, screenY: 2,
    width: 40, height: 10, shift: false, alt: false, ctrl: false,
  };
  const result = h.panel.handleMouse(press);
  assert.deepEqual(result, { handled: true, capture: true });
  assert.equal(h.panel.isFollowingEnd, false, 'dragging the thumb leaves the end');

  const drag: TuiMouseEvent = { ...press, type: 'drag', y: 8, screenY: 8 };
  assert.deepEqual(h.panel.handleMouse(drag), { handled: true, capture: true });
  assert.ok(h.panel.scrollTop > 0);
});

test('the scrollbar owns only its column inside the viewport, and only the left button', async () => {
  const h = harness({ rows: 24, initialQuestion: 'hit test' });
  await flush();
  h.calls[0]!.onText(longAnswer(200));
  const lines = h.panel.render(80).map((line) => stripTerminalSequences(line));
  const column = 79;
  const titleRow = 1;
  const viewportTop = 2;
  const viewportHeight = h.panel.viewportRows;
  const composerRow = lines.findIndex((line, index) => index > viewportTop && line.startsWith('─'));
  const before = h.panel.scrollTop;
  assert.ok(viewportHeight > 0, 'the answer overflows');
  assert.ok(composerRow > viewportTop, 'the composer is below the viewport');

  const press = (y: number, button: TuiMouseEvent['button'] = 'left'): ReturnType<BtwPanel['handleMouse']> =>
    h.panel.handleMouse({
      type: 'press', button, x: column, y, screenX: column, screenY: y,
      width: 80, height: 11, shift: false, alt: false, ctrl: false,
    });

  assert.equal(press(titleRow), undefined, 'the title row of the same column is not the scrollbar');
  assert.deepEqual(press(composerRow + 1), { handled: true, focus: true }, 'the composer of the same column focuses instead');
  assert.equal(press(viewportTop, 'right'), undefined, 'the right button does not grab the scrollbar');
  assert.equal(h.panel.scrollTop, before, 'none of those presses moved the answer');

  assert.deepEqual(press(viewportTop), { handled: true, capture: true }, 'a left press in the viewport grabs the bar');
  assert.notEqual(h.panel.scrollTop, before);
});

test('pressing the thumb keeps its grab offset and the drag continues off the column', async () => {
  const h = harness({ rows: 24, initialQuestion: 'thumb' });
  await flush();
  h.calls[0]!.onText(longAnswer(400));
  h.panel.render(80);
  const viewportTop = 2;
  const viewportHeight = h.panel.viewportRows;

  // Park the view in the middle so the thumb is not pinned to an edge.
  for (let notch = 0; notch < 20; notch++) wheel(h.panel, 3);
  const middle = h.panel.scrollTop;
  assert.ok(middle > 0, 'the answer is scrolled');

  const rows = h.panel.render(80).map((line) => stripTerminalSequences(line));
  const thumbRows = rows
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.includes('█'))
    .map((entry) => entry.index);
  assert.ok(thumbRows.length >= 1, 'the thumb is drawn');
  const thumbTop = thumbRows[0]!;

  const at = (type: TuiMouseEvent['type'], y: number, x = 79): ReturnType<BtwPanel['handleMouse']> =>
    h.panel.handleMouse({
      type, button: 'left', x, y, screenX: x, screenY: y,
      width: 80, height: 11, shift: false, alt: false, ctrl: false,
    });

  assert.deepEqual(at('press', thumbTop), { handled: true, capture: true });
  if (thumbRows.length > 1) {
    assert.equal(h.panel.scrollTop, middle, 'pressing the upper cell of a two-row thumb does not jump');
  }

  at('press', thumbTop);
  const grabbed = h.panel.scrollTop;
  assert.deepEqual(at('drag', thumbTop - 1, 70), { handled: true, capture: true }, 'the drag survives leaving the column');
  assert.ok(h.panel.scrollTop < grabbed, 'dragging up scrolls back');
  assert.deepEqual(at('release', thumbTop - 1, 70), { handled: true });
  assert.equal(at('drag', thumbTop - 3, 70), undefined, 'a drag after release is not ours');
  assert.ok(viewportTop >= 0 && viewportHeight > 0);
});

test('clicking the composer focuses the panel, clicks elsewhere do not', async () => {
  const h = harness({ rows: 24 });
  const lines = h.panel.render(40).map((line) => stripTerminalSequences(line));
  // The last full-width rule closes the composer; the row above it is its input.
  const lastRule = lines.reduce((found, line, index) => (line.startsWith('─') ? index : found), 0);
  assert.ok(lastRule > 2, 'the composer is bordered');

  const title: TuiMouseEvent = {
    type: 'press', button: 'left', x: 3, y: 1, screenX: 3, screenY: 1,
    width: 40, height: 10, shift: false, alt: false, ctrl: false,
  };
  assert.equal(h.panel.handleMouse(title), undefined, 'the title row does not steal focus');

  const composer: TuiMouseEvent = { ...title, y: lastRule - 1, screenY: lastRule - 1 };
  assert.deepEqual(h.panel.handleMouse(composer), { handled: true, focus: true });
});

test('invalidate rebuilds markdown safely after a theme change', async () => {
  const h = harness({ rows: 40, initialQuestion: 'theme' });
  await flush();
  h.calls[0]!.onText('# Heading\n\n**bold**');
  h.calls[0]!.resolve();
  await flush();
  assert.match(renderPlain(h.panel), /Heading/);

  initTheme('light');
  h.panel.invalidate();
  const text = renderPlain(h.panel);
  assert.match(text, /Heading/);
  assert.match(text, /bold/);
});

test('focused panel propagates focus to the native editor for CJK IME placement', () => {
  const h = harness();
  assert.ok(!h.panel.render(40).some((line) => line.includes(CURSOR_MARKER)));

  h.panel.focused = true;
  assert.ok(h.panel.render(40).some((line) => line.includes(CURSOR_MARKER)));

  h.panel.focused = false;
  assert.ok(!h.panel.render(40).some((line) => line.includes(CURSOR_MARKER)));
});

test('shrinking the terminal below the dock minimum reports an error instead of squeezing', async () => {
  const h = harness({ rows: 24, initialQuestion: 'resize' });
  await flush();
  h.calls[0]!.onText(longAnswer(60));
  h.panel.render(50);
  assert.ok(h.panel.render(50).length > 1, 'the dock is open');

  h.tui.terminal.rows = 8; // one row short of the preferred minimum plus a transcript row
  const small = h.panel.render(50);
  assert.equal(small.length, 1, 'a squeezed dock is replaced by a single error row');
  assert.match(plain(small), /terminal too small for \/btw · needs 9 rows/);

  typeText(h.panel, 'invisible');
  h.panel.handleInput('\r');
  await flush();
  assert.equal(h.calls.length, 1, 'a hidden dock cannot start an ask');

  assert.deepEqual(wheel(h.panel, -6), { handled: true }, 'the dock still keeps wheel input');

  h.panel.handleInput('\x1b');
  assert.equal(h.closeCalls.count, 1, 'escape still closes a hidden dock');

  h.tui.terminal.rows = 24;
  const restored = h.panel.render(50);
  assert.ok(restored.length > 1, 'growing the terminal back restores the dock');
  assert.match(plain(restored), /btw · side question/);
  assert.match(plain(restored), /LINE_59/, 'the answer survives the shrink');
});

test('a disposed panel stops rendering and ignores input', async () => {
  const h = harness({ initialQuestion: 'dispose' });
  await flush();
  const renders = h.tui.renders;
  h.panel.dispose();
  h.panel.handleInput('x');
  h.calls[0]!.onText('ignored');
  assert.equal(h.tui.renders, renders);
  assert.equal(h.closeCalls.count, 1);
});
