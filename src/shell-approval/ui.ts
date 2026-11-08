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

export type ShellApprovalReason =
  | 'approved'
  | 'rejected'
  | 'timeout'
  | 'cancelled'
  | 'no_ui'
  | 'disposed';

export interface ShellApprovalResult {
  readonly approved: boolean;
  readonly reason: ShellApprovalReason;
}

export interface ShellApprovalRequest {
  readonly sourceAgent: string;
  readonly shell: string;
  readonly cwd: string;
  readonly command: string;
  readonly reason?: string | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ManualApprovalQueueOptions {
  readonly defaultTimeoutSeconds?: number | undefined;
  readonly onDisplay?: (request: ShellApprovalRequest) => void;
}

const DEFAULT_TIMEOUT_SECONDS = 30;
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
  private readonly countdownSeconds: number;
  private readonly onDecision: (result: ShellApprovalResult) => void;

  private remainingSeconds: number;
  private timerId: ReturnType<typeof setInterval> | null = null;
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
    countdownSeconds: number,
    onDecision: (result: ShellApprovalResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.request = request;
    this.countdownSeconds = Math.max(1, Math.floor(countdownSeconds));
    this.onDecision = onDecision;
    this.remainingSeconds = this.countdownSeconds;

    const rawLines = sanitizeCommandDisplay(this.request.command || '').split('\n');
    this.maxScrollOffset = Math.max(0, rawLines.length - MAX_COMMAND_VIEWPORT_ROWS);

    this.timerId = setInterval(() => {
      this.remainingSeconds -= 1;
      if (this.remainingSeconds <= 0) {
        this.stopTimer();
        this.decide('timeout');
      } else {
        this.invalidate();
        this.tui.requestRender();
      }
    }, 1000);
    this.timerId.unref();
  }

  get remainingTime(): number {
    return this.remainingSeconds;
  }

  get isSettled(): boolean {
    return this.settled;
  }

  get currentScrollOffset(): number {
    return this.scrollOffset;
  }

  private stopTimer(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  invalidate(): void {
    this.cachedRenderWidth = null;
    this.cachedRenderLines = null;
  }

  decide(reason: ShellApprovalReason): void {
    if (this.settled) return;
    this.settled = true;
    this.stopTimer();
    this.onDecision({ approved: reason === 'approved', reason });
  }

  dispose(): void {
    this.stopTimer();
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

    const countdownColor = this.remainingSeconds <= 10 ? 'error' : 'warning';
    lines.push(formatRow(this.theme.fg(countdownColor, `Timeout: ${this.remainingSeconds}s (auto-reject on expiry)`)));
    lines.push(formatRow(dim('Keys: [Enter/y] allow once  [Esc/n] reject  [↑/↓] scroll')));
    lines.push(bottomLine);

    const finalLines = lines.map((line) => truncateToWidth(line, width));
    this.cachedRenderWidth = width;
    this.cachedRenderLines = finalLines;
    return finalLines;
  }
}

interface QueuedItem {
  readonly id: number;
  readonly request: ShellApprovalRequest;
  readonly ctx: ExtensionContext;
  readonly resolve: (result: ShellApprovalResult) => void;
  cleanupAbort: () => void;
}

interface ActiveItem {
  readonly queuedItem: QueuedItem;
  dismiss: (reason: ShellApprovalReason) => void;
}

let nextItemId = 1;

/** Coordinates manual shell execution approvals per root session, showing one request at a time. */
export class ManualApprovalQueue {
  private readonly defaultTimeoutSeconds: number;
  private readonly onDisplay: ((request: ShellApprovalRequest) => void) | undefined;
  private readonly queue: QueuedItem[] = [];
  private activeItem: ActiveItem | null = null;
  private activeProcessing = false;
  private disposed = false;

  constructor(options?: ManualApprovalQueueOptions) {
    this.onDisplay = options?.onDisplay;
    this.defaultTimeoutSeconds = Math.max(
      1,
      Math.floor(options?.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS),
    );
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get activeCount(): number {
    return this.activeItem !== null ? 1 : 0;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  async requestApproval(
    request: ShellApprovalRequest,
    ctx: ExtensionContext,
  ): Promise<ShellApprovalResult> {
    if (this.disposed) return { approved: false, reason: 'disposed' };
    if (!ctx || !ctx.hasUI || ctx.mode !== 'tui') return { approved: false, reason: 'no_ui' };
    if (request.signal?.aborted || ctx.signal?.aborted) return { approved: false, reason: 'cancelled' };

    return new Promise<ShellApprovalResult>((resolve) => {
      let settled = false;
      const safeResolve = (result: ShellApprovalResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const queuedItem: QueuedItem = {
        id: nextItemId++,
        request,
        ctx,
        resolve: safeResolve,
        cleanupAbort: () => {},
      };

      const onAbort = () => {
        this.removeFromQueue(queuedItem);
        safeResolve({ approved: false, reason: 'cancelled' });
      };

      if (request.signal) request.signal.addEventListener('abort', onAbort, { once: true });
      if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });

      queuedItem.cleanupAbort = () => {
        request.signal?.removeEventListener('abort', onAbort);
        ctx.signal?.removeEventListener('abort', onAbort);
      };

      this.queue.push(queuedItem);
      this.processNext();
    });
  }

  private removeFromQueue(item: QueuedItem): void {
    item.cleanupAbort();
    const index = this.queue.indexOf(item);
    if (index !== -1) this.queue.splice(index, 1);
  }

  private processNext(): void {
    if (this.disposed || this.activeProcessing || this.queue.length === 0) return;

    const current = this.queue.shift()!;
    current.cleanupAbort();

    if (current.request.signal?.aborted || current.ctx.signal?.aborted) {
      current.resolve({ approved: false, reason: 'cancelled' });
      this.processNext();
      return;
    }

    this.activeProcessing = true;
    let activeSettled = false;
    let dismissComponent: ((reason: ShellApprovalReason) => void) | undefined;

    const resolvePrompt = (result: ShellApprovalResult) => {
      if (activeSettled) return;
      activeSettled = true;
      current.resolve(result);
    };

    this.activeItem = {
      queuedItem: current,
      dismiss: (reason) => {
        resolvePrompt({ approved: false, reason });
        dismissComponent?.(reason);
      },
    };

    const sanitizedCommand = sanitizeTerminalText(current.request.command);
    const displayTitle = `Shell approval: ${truncateToWidth(sanitizedCommand, 40)}`;

    try {
      current.ctx.ui.notify(
        `[Shell approval] ${current.request.sourceAgent || 'unknown'} requests: ${truncateToWidth(sanitizedCommand, 50)}`,
        'warning',
      );
    } catch {}

    try {
      if (process.stdout?.isTTY) process.stdout.write('\x07');
    } catch {}

    const onActiveAbort = () => {
      if (this.activeItem?.queuedItem === current) this.activeItem.dismiss('cancelled');
    };

    current.request.signal?.addEventListener('abort', onActiveAbort, { once: true });
    current.ctx.signal?.addEventListener('abort', onActiveAbort, { once: true });

    const cleanupActiveAbort = () => {
      current.request.signal?.removeEventListener('abort', onActiveAbort);
      current.ctx.signal?.removeEventListener('abort', onActiveAbort);
    };

    const effectiveTimeout = Math.max(1, Math.floor(current.request.timeoutSeconds ?? this.defaultTimeoutSeconds));
    let activeComponent: ShellApprovalComponent | null = null;

    void current.ctx.ui
      .custom<ShellApprovalResult>(
        (tui, theme, keybindings, done) => {
          let componentDoneCalled = false;
          const safeDone = (res: ShellApprovalResult) => {
            if (componentDoneCalled) return;
            componentDoneCalled = true;
            resolvePrompt(res);
            done(res);
          };

          dismissComponent = (reason) => {
            activeComponent?.decide(reason);
            safeDone({ approved: false, reason });
          };

          activeComponent = new ShellApprovalComponent(tui, theme, keybindings, current.request, effectiveTimeout, safeDone);
          this.onDisplay?.(current.request);
          return activeComponent;
        },
        {
          blocked: {
            kind: 'permission',
            message: displayTitle,
          },
        },
      )
      .then((res) => {
        resolvePrompt(res);
      })
      .catch(() => {
        resolvePrompt({ approved: false, reason: 'rejected' });
      })
      .finally(() => {
        cleanupActiveAbort();
        this.activeItem = null;
        this.activeProcessing = false;
        this.processNext();
      });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const pending = [...this.queue];
    this.queue.length = 0;
    for (const item of pending) {
      item.cleanupAbort();
      item.resolve({ approved: false, reason: 'disposed' });
    }

    if (this.activeItem) {
      const active = this.activeItem;
      this.activeItem = null;
      active.dismiss('disposed');
    }
  }
}
