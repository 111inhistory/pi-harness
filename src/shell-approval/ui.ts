import type { ExtensionContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import {
  Key,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';

import type {
  ShellApprovalController,
  ShellApprovalPending,
  ShellApprovalReason,
  ShellApprovalRequest,
  ShellApprovalResult,
} from './types.ts';

const MAX_COMMAND_VIEWPORT_ROWS = 10;

/** Sanitize title and single-line prompts to prevent terminal escape injection. */
export function sanitizeTerminalText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sanitize command for terminal rendering without losing structure or content. */
export function sanitizeCommandDisplay(command: string): string {
  return stripTerminalSequences(command)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\r\n/g, '\n');
}

/** Inline TUI component displaying shell approval details, countdown, and scrollable command. */
export class ShellApprovalComponent implements Component {
  readonly capturesViewportInput = true;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly request: ShellApprovalRequest;
  private readonly remainingSeconds: () => number;
  private readonly onDecision: (result: ShellApprovalResult) => void;

  private settled = false;
  private scrollOffset = 0;
  private maxScrollOffset = 0;
  private cachedRenderWidth: number | null = null;
  private cachedRenderLines: string[] | null = null;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    request: ShellApprovalRequest,
    remainingSeconds: number | (() => number),
    onDecision: (result: ShellApprovalResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.request = request;
    this.remainingSeconds = typeof remainingSeconds === 'function'
      ? remainingSeconds
      : () => remainingSeconds;
    this.onDecision = onDecision;

    const rawLines = sanitizeCommandDisplay(this.request.command || '').split('\n');
    this.maxScrollOffset = Math.max(0, rawLines.length - MAX_COMMAND_VIEWPORT_ROWS);
  }

  get remainingTime(): number {
    return Math.max(0, Math.floor(this.remainingSeconds()));
  }

  get isSettled(): boolean {
    return this.settled;
  }

  get currentScrollOffset(): number {
    return this.scrollOffset;
  }

  invalidate(): void {
    this.cachedRenderWidth = null;
    this.cachedRenderLines = null;
  }

  decide(reason: ShellApprovalReason): void {
    if (this.settled) return;
    this.settled = true;
    this.onDecision({ approved: reason === 'approved', reason });
  }

  dispose(): void {
    if (!this.settled) this.decide('cancelled');
  }

  handleInput(data: string): void {
    if (this.settled) return;
    if (
      data === Key.enter || data === Key.return || data === '\r' || data === '\n' || data === 'y' || data === 'Y' ||
      matchesKey(data, Key.enter) || matchesKey(data, Key.return) || this.keybindings.matches(data, 'tui.select.confirm')
    ) {
      return this.decide('approved');
    }
    if (
      data === Key.escape || data === Key.esc || data === '\x1b' || data === 'n' || data === 'N' ||
      matchesKey(data, Key.escape) || matchesKey(data, Key.esc) || this.keybindings.matches(data, 'tui.select.cancel')
    ) {
      return this.decide('rejected');
    }
    if (data === Key.up || matchesKey(data, Key.up)) return this.scrollTo(this.scrollOffset - 1);
    if (data === Key.down || matchesKey(data, Key.down)) return this.scrollTo(this.scrollOffset + 1);
    if (data === Key.pageUp || matchesKey(data, Key.pageUp)) return this.scrollTo(this.scrollOffset - MAX_COMMAND_VIEWPORT_ROWS);
    if (data === Key.pageDown || matchesKey(data, Key.pageDown)) return this.scrollTo(this.scrollOffset + MAX_COMMAND_VIEWPORT_ROWS);
    if (data === Key.home || matchesKey(data, Key.home)) return this.scrollTo(0);
    if (data === Key.end || matchesKey(data, Key.end)) return this.scrollTo(Number.POSITIVE_INFINITY);
  }

  private scrollTo(target: number): void {
    const nextOffset = Math.max(0, Math.min(target, this.maxScrollOffset));
    if (nextOffset !== this.scrollOffset) {
      this.scrollOffset = nextOffset;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    if (this.cachedRenderLines && this.cachedRenderWidth === width) return this.cachedRenderLines;

    const termWidth = Math.max(16, Math.floor(width));
    const innerWidth = Math.max(4, termWidth - 4);
    const border = (s: string) => this.theme.fg('accent', s);
    const label = (s: string) => this.theme.fg('muted', s);
    const accent = (s: string) => this.theme.fg('accent', s);
    const dim = (s: string) => this.theme.fg('dim', s);

    const prefix = border('┌─ ') + accent('Shell Approval') + ' ';
    const suffix = border('┐');
    const fillCols = Math.max(0, termWidth - visibleWidth(prefix) - visibleWidth(suffix));
    const topLine = prefix + border('─'.repeat(fillCols)) + suffix;
    const divider = border('├' + '─'.repeat(termWidth - 2) + '┤');
    const bottomLine = border('└' + '─'.repeat(termWidth - 2) + '┘');

    const formatRow = (text: string): string => {
      const v = visibleWidth(text);
      if (v > innerWidth) {
        const truncated = truncateToWidth(text, innerWidth);
        const pad = Math.max(0, innerWidth - visibleWidth(truncated));
        return border('│ ') + truncated + ' '.repeat(pad) + border(' │');
      }
      return border('│ ') + text + ' '.repeat(innerWidth - v) + border(' │');
    };

    const remaining = this.remainingTime;
    const lines: string[] = [
      topLine,
      formatRow(`${label('Source agent:')} ${sanitizeTerminalText(this.request.sourceAgent || 'unknown')}`),
      formatRow(`${label('Target shell:')} ${sanitizeTerminalText(this.request.shell || 'shell')}`),
      formatRow(`${label('Working dir:')}  ${sanitizeTerminalText(this.request.cwd || '')}`),
      formatRow(`${label('Reason:')}       ${sanitizeTerminalText(this.request.reason || 'none')}`),
      divider,
    ];

    const sanitizedCommand = sanitizeCommandDisplay(this.request.command || '');
    const rawLines = sanitizedCommand.split('\n');
    const wrappedLines: string[] = [];
    const commandWrapWidth = Math.max(10, innerWidth - 4);

    for (const raw of rawLines) {
      if (raw.length === 0) wrappedLines.push('');
      else wrappedLines.push(...wrapTextWithAnsi(raw, commandWrapWidth));
    }

    const totalLines = wrappedLines.length;
    const viewportHeight = Math.min(MAX_COMMAND_VIEWPORT_ROWS, Math.max(1, totalLines));
    this.maxScrollOffset = Math.max(0, totalLines - viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScrollOffset));

    const visibleLines = wrappedLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
    const countInfo = totalLines <= viewportHeight
      ? `(${totalLines} lines):`
      : `(lines ${this.scrollOffset + 1}-${this.scrollOffset + visibleLines.length} of ${totalLines}, ↑/↓ to scroll):`;

    lines.push(formatRow(`${accent('Command')} ${dim(countInfo)}`));
    for (const cmdLine of visibleLines) lines.push(formatRow(`  ${cmdLine}`));
    lines.push(divider);

    const countdownColor = remaining <= 10 ? 'error' : 'warning';
    lines.push(formatRow(this.theme.fg(countdownColor, `Timeout: ${remaining}s (auto-reject on expiry)`)));
    lines.push(formatRow(dim('Keys: [Enter/y] allow once  [Esc/n] reject  [↑/↓] scroll')));
    lines.push(bottomLine);

    const finalLines = lines.map((line) => truncateToWidth(line, width));
    this.cachedRenderWidth = width;
    this.cachedRenderLines = finalLines;
    return finalLines;
  }
}

export interface ShellApprovalTuiAdapterOptions {
  readonly controller: ShellApprovalController;
  /** The adapter is reusable across tree switches; callers update the root context. */
  readonly context: () => ExtensionContext | undefined;
  readonly onDisplay?: ((request: ShellApprovalRequest) => void) | undefined;
}

interface ApprovalDialog {
  pending: ShellApprovalPending;
  readonly request: ShellApprovalRequest;
  component: ShellApprovalComponent | null;
  tui: TUI | null;
  done: ((result: ShellApprovalResult) => void) | null;
  doneCalled: boolean;
  finalResult: ShellApprovalResult | null;
  ticker: ReturnType<typeof setInterval> | null;
}

/** Terminal adapter over the root approval controller. It owns only rendering and dialog lifecycle. */
export class ShellApprovalTuiAdapter {
  readonly #controller: ShellApprovalController;
  readonly #context: () => ExtensionContext | undefined;
  readonly #onDisplay: ((request: ShellApprovalRequest) => void) | undefined;
  readonly #unsubscribe: () => void;

  #dialog: ApprovalDialog | null = null;
  #disposed = false;

  constructor(options: ShellApprovalTuiAdapterOptions) {
    this.#controller = options.controller;
    this.#context = options.context;
    this.#onDisplay = options.onDisplay;
    this.#unsubscribe = this.#controller.subscribe((snapshot) => this.#sync(snapshot), { consumer: false });
  }

  canPresent(): boolean {
    const ctx = this.#context();
    return ctx !== undefined && ctx.hasUI && ctx.mode === 'tui';
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    const dialog = this.#dialog;
    this.#dialog = null;
    if (dialog !== null) this.#close(dialog, { approved: false, reason: 'cancelled' });
  }

  #sync(snapshot: readonly ShellApprovalPending[]): void {
    if (this.#disposed) return;
    const active = snapshot.find((pending) => pending.state === 'active');
    if (active === undefined) {
      const dialog = this.#dialog;
      if (dialog !== null) this.#close(dialog, this.#closeReason(dialog));
      return;
    }

    if (this.#dialog?.pending.id === active.id) {
      this.#dialog.pending = active;
      return;
    }

    const current = this.#dialog;
    if (current !== null) {
      this.#close(current, this.#closeReason(current));
      // The SDK owns unmounting. Wait for its promise before opening another dialog.
      return;
    }

    this.#open(active);
  }

  #closeReason(dialog: ApprovalDialog): ShellApprovalResult {
    if (dialog.finalResult !== null) return dialog.finalResult;
    const expired = dialog.pending.expiresAt !== null && Date.now() >= dialog.pending.expiresAt;
    return { approved: false, reason: expired ? 'timeout' : 'cancelled' };
  }

  #open(pending: ShellApprovalPending): void {
    const ctx = this.#context();
    if (ctx === undefined || !ctx.hasUI || ctx.mode !== 'tui') {
      return;
    }

    const request: ShellApprovalRequest = {
      sourceAgent: pending.sourceAgent,
      shell: pending.shell,
      cwd: pending.cwd,
      command: pending.command,
      reason: pending.reason ?? undefined,
      timeoutSeconds: pending.timeoutSeconds,
    };
    const dialog: ApprovalDialog = {
      pending,
      request,
      component: null,
      tui: null,
      done: null,
      doneCalled: false,
      finalResult: null,
      ticker: null,
    };
    this.#dialog = dialog;

    const sanitizedCommand = sanitizeTerminalText(request.command);
    const displayTitle = `Shell approval: ${truncateToWidth(sanitizedCommand, 40)}`;

    try {
      ctx.ui.notify(
        `[Shell approval] ${request.sourceAgent || 'unknown'} requests: ${truncateToWidth(sanitizedCommand, 50)}`,
        'warning',
      );
    } catch {}
    try {
      if (process.stdout?.isTTY) process.stdout.write('\x07');
    } catch {}
    try { this.#onDisplay?.(request); } catch { /* Notification failure does not decide approval. */ }

    void ctx.ui
      .custom<ShellApprovalResult>(
        (tui, theme, keybindings, done) => {
          dialog.done = done;
          dialog.tui = tui;
          dialog.component = new ShellApprovalComponent(
            tui,
            theme,
            keybindings,
            request,
            () => remainingSeconds(dialog),
            (result) => this.#onDecision(dialog, result),
          );
          this.#startTicker(dialog);

          if (dialog.finalResult !== null) {
            this.#callDone(dialog, dialog.finalResult);
            dialog.component.decide(dialog.finalResult.reason);
          }
          return dialog.component;
        },
        { blocked: { kind: 'permission', message: displayTitle } },
      )
      .then((result) => {
        if (dialog.doneCalled) return;
        dialog.finalResult = result;
        if (this.#controller.get(pending.id) !== undefined) {
          this.#controller.respond(pending.id, result.approved ? 'allow' : 'deny');
        }
        this.#close(dialog, result);
      })
      .catch(() => {
        if (dialog.doneCalled) return;
        if (this.#controller.get(pending.id) !== undefined) {
          this.#controller.respond(pending.id, 'deny');
        }
        this.#close(dialog, { approved: false, reason: 'rejected' });
      })
      .finally(() => {
        this.#stopTicker(dialog);
        if (dialog.component !== null && !dialog.component.isSettled) dialog.component.dispose();
        if (this.#dialog === dialog) this.#dialog = null;
        if (!this.#disposed) this.#sync(this.#controller.list());
      });
  }

  #onDecision(dialog: ApprovalDialog, result: ShellApprovalResult): void {
    if (dialog.doneCalled) return;
    dialog.finalResult ??= result;
    if (this.#controller.get(dialog.pending.id) !== undefined) {
      const response = this.#controller.respond(
        dialog.pending.id,
        result.reason === 'approved' ? 'allow' : 'deny',
      );
      if (!response.accepted && result.reason === 'approved') {
        dialog.finalResult = { approved: false, reason: 'cancelled' };
      }
    }
    this.#close(dialog, dialog.finalResult);
  }

  #close(dialog: ApprovalDialog, result: ShellApprovalResult): void {
    dialog.finalResult ??= result;
    this.#stopTicker(dialog);
    this.#callDone(dialog, dialog.finalResult);
    if (dialog.component !== null && !dialog.component.isSettled) dialog.component.dispose();
  }

  #callDone(dialog: ApprovalDialog, result: ShellApprovalResult): void {
    if (dialog.done === null || dialog.doneCalled) return;
    dialog.doneCalled = true;
    dialog.done(result);
  }

  #startTicker(dialog: ApprovalDialog): void {
    this.#stopTicker(dialog);
    dialog.ticker = setInterval(() => {
      if (dialog.doneCalled) return;
      dialog.component?.invalidate();
      dialog.tui?.requestRender();
    }, 1000);
    dialog.ticker.unref();
  }

  #stopTicker(dialog: ApprovalDialog): void {
    if (dialog.ticker !== null) {
      clearInterval(dialog.ticker);
      dialog.ticker = null;
    }
  }
}

function remainingSeconds(dialog: ApprovalDialog): number {
  if (dialog.pending.expiresAt === null) return dialog.pending.timeoutSeconds;
  return Math.max(0, Math.ceil((dialog.pending.expiresAt - Date.now()) / 1000));
}
