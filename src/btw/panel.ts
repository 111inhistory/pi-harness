import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import {
  CURSOR_MARKER,
  Editor,
  ScrollView,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorTheme,
  type Focusable,
  type SelectListTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';

import { BtwTranscript, type BtwTurnState } from './transcript.ts';

export interface BtwPanelOptions {
  /** Fewest rows the dock may occupy; configured through `btw.panelMinRows`. */
  minRows: number;
  initialQuestion?: string;
  ask(question: string, onText: (cumulativeText: string) => void): Promise<void>;
  cancel(): Promise<void>;
  onClose(): void;
}

/** The dock targets half of the terminal. */
const PANEL_HEIGHT_RATIO = 0.5;

/** Best-effort terminal check: the preferred panel floor plus one Main row. */
export function btwRequiredTerminalRows(minRows: number): number {
  return Math.max(1, Math.floor(minRows)) + 1;
}

/** The composer keeps at least one row and never grows past this share of the panel. */
const EDITOR_MAX_ROWS = 5;
const SCROLLBAR_TRACK = '│';
const SCROLLBAR_THUMB = '█';

interface PanelLayout {
  readonly separator: boolean;
  readonly title: boolean;
  readonly help: boolean;
  readonly viewport: number;
  readonly editor: number;
}

interface PanelGeometry {
  readonly viewportTop: number;
  readonly viewportHeight: number;
  readonly editorTop: number;
  readonly scrollbarColumn: number;
  readonly contentHeight: number;
  readonly scrollable: boolean;
}

function terminalRows(tui: TUI): number {
  const rows = tui.terminal.rows;
  return Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
}

/**
 * Bottom-docked side conversation for `/btw`.
 *
 * The panel is mounted inline in the SDK's editor slot, so the main transcript
 * stays visible and scrollable above it and the main composer is restored on
 * close. Its height comes from the terminal, never from the conversation, so
 * streaming answers cannot push the transcript around.
 *
 * Scrolling is native `ScrollView` state: `follow: 'end'` keeps the newest text
 * in view, an upward scroll pins the reading position, and returning to the end
 * resumes following. The panel draws that state itself because an inline editor
 * slot renders a component's own lines instead of laying out a scroll node.
 *
 * Every asynchronous update is fenced by a generation counter so a late
 * callback can never mutate a newer turn or a disposed panel.
 */
export class BtwPanel implements Component, Focusable {
  /** Viewport keys (PgUp/PgDn) belong to this panel while it is open. */
  readonly capturesViewportInput = true;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly options: BtwPanelOptions;
  private readonly editor: Editor;
  private readonly transcript: BtwTranscript;
  private readonly view: ScrollView;

  private active: number | null = null;
  private askGeneration = 0;
  private closed = false;
  private disposed = false;
  private closeNotified = false;
  private focusedValue = false;
  private geometry: PanelGeometry | null = null;
  private viewportHeight = 0;
  /** Active scrollbar drag: where inside the thumb the pointer grabbed it. */
  private scrollbarDrag: { readonly grabOffset: number } | null = null;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    options: BtwPanelOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.options = options;
    this.transcript = new BtwTranscript(theme);
    this.view = new ScrollView(this.transcript, { follow: 'end' });
    this.editor = new Editor(tui, this.createEditorTheme());
    this.editor.onSubmit = (text) => this.submitComposer(text);

    const initial = options.initialQuestion?.trim();
    if (initial) {
      // Submit after the owner has had a chance to mount the component.
      queueMicrotask(() => {
        if (this.disposed || this.closed || this.active !== null) return;
        void this.runAsk(initial).catch(() => {});
      });
    }
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    if (this.focusedValue === value) return;
    this.focusedValue = value;
    // Propagate focus so the Editor emits CURSOR_MARKER for CJK IME placement.
    this.editor.focused = value;
    this.requestRender();
  }

  /** Current scroll offset of the answer viewport, for tests and diagnostics. */
  get scrollTop(): number {
    return this.view.scrollTop;
  }

  /** Whether the answer viewport follows new text. */
  get isFollowingEnd(): boolean {
    return this.view.isFollowingEnd;
  }

  /** Rows the answer viewport currently shows, for tests and diagnostics. */
  get viewportRows(): number {
    return this.viewportHeight;
  }

  render(width: number): string[] {
    if (!Number.isFinite(width) || width < 1) return [];
    const columns = Math.max(1, Math.floor(width));
    // A resize can shrink the terminal under the configured minimum at any time.
    // The dock then reports the problem instead of squeezing the answer, and it
    // comes back by itself when the terminal grows again.
    if (!this.terminalFits()) {
      this.geometry = null;
      this.viewportHeight = 0;
      return [truncateToWidth(this.tooSmallLine(), columns, '')];
    }
    const editorLines = this.editor.render(columns);
    const layout = this.panelLayout(editorLines.length);
    this.viewportHeight = layout.viewport;

    // Overflow is always judged on the full width, then redrawn one column
    // narrower to make room for the scrollbar. The transcript keeps both forms
    // cached, so an unchanged frame reuses them instead of reflowing twice.
    let contentWidth = columns;
    let content = this.transcript.render(contentWidth);
    let scrollbar = layout.viewport > 0 && content.length > layout.viewport;
    if (scrollbar && columns > 1) {
      contentWidth = columns - 1;
      content = this.transcript.render(contentWidth);
      scrollbar = content.length > layout.viewport;
    }

    this.view.updateLayout(content.length, layout.viewport, () => this.requestRender());
    const top = this.view.scrollTop;
    const visible: string[] = [];
    for (let row = 0; row < layout.viewport; row++) {
      const line = content[top + row] ?? '';
      visible.push(
        scrollbar
          ? this.viewportLine(line, contentWidth, row, top, content.length, layout.viewport)
          : line,
      );
    }

    const titleRows = (layout.separator ? 1 : 0) + (layout.title ? 1 : 0);
    this.geometry = {
      viewportTop: titleRows,
      viewportHeight: layout.viewport,
      editorTop: titleRows + layout.viewport,
      scrollbarColumn: columns - 1,
      contentHeight: content.length,
      scrollable: content.length > layout.viewport,
    };

    const lines: string[] = [];
    if (layout.separator) lines.push(this.theme.fg('borderMuted', '─'.repeat(columns)));
    if (layout.title) lines.push(this.titleLine());
    lines.push(...visible);
    lines.push(...this.editorWindow(editorLines, layout.editor));
    if (layout.help) lines.push(this.helpLine(columns));

    return lines.map((line) => truncateToWidth(line, columns, ''));
  }

  handleInput(data: string): void {
    if (this.disposed || this.closed) return;

    if (matchesKey(data, 'escape')) {
      this.close();
      return;
    }

    if (this.active !== null && matchesKey(data, 'ctrl+c')) {
      this.cancelActive();
      return;
    }

    // While the dock is hidden for lack of rows, typing must not edit an
    // invisible composer.
    if (!this.terminalFits()) return;

    if (this.keybindings.matches(data, 'tui.altScreen.pageUp')) {
      this.view.scrollBy(-this.pageLines());
      return;
    }
    if (this.keybindings.matches(data, 'tui.altScreen.pageDown')) {
      this.view.scrollBy(this.pageLines());
      return;
    }

    this.editor.handleInput(data);
  }

  /**
   * Wheel and drag handling for the docked panel.
   *
   * The panel consumes every wheel event it receives, including at either end of
   * the answer, so the main transcript never scrolls underneath the dock.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed || this.closed) return undefined;

    if (event.type === 'wheel') {
      // `wheelDelta` already carries the host's line count and velocity, exactly
      // as the transcript uses it. Moving by more than one page would step over
      // lines that never become visible, so a single event stays within a page.
      const geometry = this.geometry;
      const delta = event.wheelDelta ?? 0;
      if (geometry && delta !== 0 && geometry.viewportHeight > 0) {
        const page = Math.max(1, geometry.viewportHeight - 1);
        const step = Math.max(1, Math.min(page, Math.abs(delta)));
        this.view.scrollBy(delta > 0 ? step : -step);
      }
      return { handled: true };
    }

    const geometry = this.geometry;
    if (!geometry) return undefined;

    // A captured drag continues while the pointer drifts off the scrollbar column,
    // and only the release ends it.
    if (event.type === 'drag' && this.scrollbarDrag !== null) {
      this.dragScrollbar(event.y - geometry.viewportTop, geometry.viewportHeight, geometry.contentHeight);
      return { handled: true, capture: true };
    }
    if (event.type === 'release') {
      if (this.scrollbarDrag === null) return undefined;
      this.scrollbarDrag = null;
      return { handled: true };
    }

    if (event.type === 'press') {
      // The scrollbar owns its column only inside the answer viewport, and only
      // the left button grabs it. A press on the title or the composer of the
      // same column must not scroll the answer.
      const inViewport =
        event.y >= geometry.viewportTop && event.y < geometry.viewportTop + geometry.viewportHeight;
      if (geometry.scrollable && event.button === 'left' && inViewport && event.x === geometry.scrollbarColumn) {
        this.grabScrollbar(event.y - geometry.viewportTop, geometry.viewportHeight, geometry.contentHeight);
        return { handled: true, capture: true };
      }
      if (event.y >= geometry.editorTop) return { handled: true, focus: true };
      return undefined;
    }

    if (event.type === 'click' && event.y >= geometry.editorTop) {
      return { handled: true, focus: true };
    }

    return undefined;
  }

  invalidate(): void {
    this.transcript.invalidate();
    this.editor.invalidate();
  }

  /**
   * Stop all further UI updates and release the owner exactly once.
   * A backend ask that is still running is left to the owner; its late
   * callbacks and rejection are ignored here.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closed = true;
    this.askGeneration++;
    this.active = null;
    this.editor.disableSubmit = false;
    this.notifyClose();
  }

  private createEditorTheme(): EditorTheme {
    const selectList: SelectListTheme = {
      selectedPrefix: (text) => this.theme.fg('accent', text),
      selectedText: (text) => this.theme.fg('accent', text),
      description: (text) => this.theme.fg('muted', text),
      scrollInfo: (text) => this.theme.fg('muted', text),
      noMatch: (text) => this.theme.fg('muted', text),
    };
    return {
      borderColor: (text) => this.theme.fg(this.focused ? 'borderAccent' : 'borderMuted', text),
      selectList,
    };
  }

  /** Rows left for the dock once the main conversation keeps one row above it. */
  private availableRows(): number {
    return Math.max(1, terminalRows(this.tui) - 1);
  }

  /** Best-effort floor: the preferred minimum rows plus one for the main conversation. */
  private requiredRows(): number {
    return btwRequiredTerminalRows(this.options.minRows);
  }

  private terminalFits(): boolean {
    return terminalRows(this.tui) >= this.requiredRows();
  }

  private tooSmallLine(): string {
    return this.theme.fg(
      'error',
      `terminal too small for /btw · needs ${String(this.requiredRows())} rows · esc closes`,
    );
  }

  /**
   * The dock targets half of the terminal, the height the user asked for; only
   * the row the main conversation keeps above it caps that target.
   */
  private panelLayout(editorHeight: number): PanelLayout {
    const rows = terminalRows(this.tui);
    const floor = Math.max(1, Math.floor(this.options.minRows));
    const desired = Math.max(floor, Math.round(rows * PANEL_HEIGHT_RATIO));
    const total = Math.max(1, Math.min(desired, this.availableRows()));

    // The title always survives; the help row and separator give way first, then
    // the composer shrinks to a single row so the answer keeps one visible line.
    if (total <= 1) return { separator: false, title: true, help: false, viewport: 0, editor: 0 };
    if (total === 2) return { separator: false, title: true, help: false, viewport: 0, editor: 1 };

    let separator = total >= 4;
    let help = total >= 8;
    const chrome = (): number => (separator ? 1 : 0) + 1 + (help ? 1 : 0);
    const minViewport = total >= 7 ? 2 : 1;
    while (total - chrome() - 1 < minViewport && (help || separator)) {
      if (help) help = false;
      else separator = false;
    }
    const remaining = total - chrome();
    const editor = Math.max(1, Math.min(editorHeight, EDITOR_MAX_ROWS, remaining - minViewport));
    return { separator, title: true, help, viewport: Math.max(0, remaining - editor), editor };
  }

  /** Keep the composer cursor visible when the editor is taller than its slot. */
  private editorWindow(lines: string[], height: number): string[] {
    const limit = Math.max(0, height);
    if (limit === 0) return [];
    if (lines.length <= limit) return lines;
    const markerLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
    const offset = markerLine >= limit ? markerLine - limit + 1 : 0;
    return lines.slice(offset, offset + limit);
  }

  private viewportLine(
    line: string,
    contentWidth: number,
    row: number,
    top: number,
    contentHeight: number,
    viewport: number,
  ): string {
    const clipped = truncateToWidth(line, contentWidth, '');
    const padding = Math.max(0, contentWidth - visibleWidth(clipped));
    return clipped + ' '.repeat(padding) + this.scrollbarCell(row, top, viewport, contentHeight);
  }

  private scrollbarCell(row: number, top: number, viewport: number, contentHeight: number): string {
    if (viewport <= 0 || contentHeight <= viewport) return ' ';
    // Same geometry the pointer hit test uses, so pressing the drawn thumb never jumps.
    const thumb = this.thumbGeometryFor(top, viewport, contentHeight);
    return row >= thumb.top && row < thumb.top + thumb.height
      ? this.theme.fg('scrollbarThumb', SCROLLBAR_THUMB)
      : this.theme.fg('scrollbarTrack', SCROLLBAR_TRACK);
  }

  private titleLine(): string {
    const title = this.theme.style('btw · side question', { fg: 'accent', bold: true });
    const status = this.statusText();
    return status ? `${title} ${this.theme.fg('muted', `· ${status}`)}` : title;
  }

  private statusText(): string {
    if (this.active !== null) {
      const state: BtwTurnState | undefined = this.transcript.state(this.active);
      if (state === 'cancelling') return 'cancelling…';
      if (state === 'streaming') return 'answering…';
    }
    const geometry = this.geometry;
    if (geometry && !this.view.isFollowingEnd) {
      const behind = Math.max(0, geometry.contentHeight - geometry.viewportHeight - this.view.scrollTop);
      return behind > 0 ? `scrolled · ↓${behind}` : 'scrolled';
    }
    return '';
  }

  /**
   * `/btw` is only mounted in the fullscreen renderer, so the wheel is always a
   * real control here. The variants only shed detail on narrow terminals.
   */
  private helpLine(columns: number): string {
    const variants = [
      'enter ask · shift+enter newline · wheel/pgup/pgdn scroll · ctrl+c cancel · esc close',
      'enter ask · wheel/pgup/pgdn scroll · esc close',
      'enter · esc',
    ];
    const text = variants.find((variant) => visibleWidth(variant) <= columns) ?? variants.at(-1)!;
    return this.theme.fg('dim', text);
  }

  private pageLines(): number {
    return Math.max(1, this.viewportHeight - 1);
  }

  /**
   * Press on the scrollbar. Pressing the thumb keeps the pointer's offset inside
   * it, so the answer never jumps under the cursor; pressing the empty track
   * centres the thumb on the pointer once, then drags from there.
   */
  private grabScrollbar(localRow: number, viewport: number, contentHeight: number): void {
    const thumb = this.thumbGeometry(viewport, contentHeight);
    const insideThumb = localRow >= thumb.top && localRow < thumb.top + thumb.height;
    const grabOffset = insideThumb ? localRow - thumb.top : Math.floor(thumb.height / 2);
    if (!insideThumb) this.dragScrollbar(localRow, viewport, contentHeight, grabOffset);
    this.scrollbarDrag = { grabOffset };
  }

  private dragScrollbar(localRow: number, viewport: number, contentHeight: number, grabOffset = this.scrollbarDrag?.grabOffset ?? 0): void {
    const thumb = this.thumbGeometry(viewport, contentHeight);
    this.view.scrollTo(this.scrollTopForThumb(localRow - grabOffset, viewport, contentHeight, thumb));
  }

  private thumbGeometry(viewport: number, contentHeight: number): { top: number; height: number } {
    return this.thumbGeometryFor(this.view.scrollTop, viewport, contentHeight);
  }

  private thumbGeometryFor(scrollTop: number, viewport: number, contentHeight: number): { top: number; height: number } {
    const height = Math.max(
      Math.min(2, viewport),
      Math.min(viewport, Math.round((viewport * viewport) / Math.max(1, contentHeight))),
    );
    const maxScroll = Math.max(0, contentHeight - viewport);
    const maxThumbTop = viewport - height;
    const top = maxScroll === 0 ? 0 : Math.round((scrollTop / maxScroll) * maxThumbTop);
    return { top, height };
  }

  private scrollTopForThumb(thumbTop: number, viewport: number, contentHeight: number, thumb: { top: number; height: number }): number {
    const maxScroll = Math.max(0, contentHeight - viewport);
    const maxThumbTop = viewport - thumb.height;
    if (maxThumbTop <= 0) return 0;
    const ratio = Math.min(1, Math.max(0, thumbTop / maxThumbTop));
    return Math.round(ratio * maxScroll);
  }

  private submitComposer(text: string): void {
    const question = text.trim();
    if (!question) return;

    if (this.disposed || this.closed || this.active !== null) {
      // The Editor clears its buffer before calling onSubmit. Restore the
      // draft when a second ask is refused so the user does not lose it.
      if (this.active !== null) this.editor.setText(text);
      return;
    }

    void this.runAsk(question).catch(() => {});
  }

  private async runAsk(question: string): Promise<void> {
    const text = question.trim();
    if (!text || this.disposed || this.closed || this.active !== null) return;

    const index = this.transcript.begin(text);
    this.active = index;
    this.editor.disableSubmit = true;
    this.view.scrollToEnd();
    this.requestRender();

    const generation = ++this.askGeneration;
    try {
      await this.options.ask(text, (cumulativeText) => {
        if (this.disposed || generation !== this.askGeneration || this.active !== index) return;
        this.transcript.setAnswer(index, cumulativeText);
        this.requestRender();
      });

      if (this.disposed || generation !== this.askGeneration || this.active !== index) return;
      this.transcript.settle(index, 'complete');
    } catch (error) {
      if (this.disposed || generation !== this.askGeneration || this.active !== index) return;
      this.transcript.settle(index, 'error', error);
    } finally {
      if (!this.disposed && generation === this.askGeneration && this.active === index) {
        this.active = null;
        this.editor.disableSubmit = false;
        this.requestRender();
      }
    }
  }

  private cancelActive(): void {
    const index = this.active;
    if (index === null) return;
    if (this.transcript.state(index) === 'cancelling') return;

    // Fence the ask immediately; the backend may still deliver text or settle
    // while cancellation is in flight.
    this.askGeneration++;
    this.transcript.setState(index, 'cancelling');
    this.requestRender();

    let cancellation: Promise<void>;
    try {
      cancellation = this.options.cancel();
    } catch (error) {
      this.settleCancellation(index, true, error);
      return;
    }

    void cancellation
      .then(
        () => this.settleCancellation(index, false),
        (error: unknown) => this.settleCancellation(index, true, error),
      )
      .catch(() => {});
  }

  private settleCancellation(index: number, failed: boolean, error?: unknown): void {
    if (this.disposed || this.closed || this.active !== index) return;

    this.active = null;
    this.editor.disableSubmit = false;
    if (failed) {
      this.transcript.settle(index, 'error', new Error(`cancellation failed: ${errorText(error)}`));
      this.view.scrollToEnd();
    } else {
      this.transcript.setState(index, 'cancelled');
    }
    this.requestRender();
  }

  private close(): void {
    if (this.closed || this.disposed) return;
    this.closed = true;
    if (this.active !== null) this.cancelActive();
    this.notifyClose();
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    try {
      this.options.onClose();
    } catch {
      // Closing the panel must not throw into the TUI input loop.
    }
  }

  private requestRender(): void {
    if (this.disposed || this.closed) return;
    this.tui.requestRender();
  }
}

function errorText(error: unknown): string {
  if (error === undefined) return 'side question failed';
  const raw = error instanceof Error ? error.message : String(error);
  return raw.trim() || 'side question failed';
}
