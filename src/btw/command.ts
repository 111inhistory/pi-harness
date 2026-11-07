import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { harnessConfigFor } from '../harness-config.ts';
import { captureInheritedContext } from '../inherited-context.ts';
import { BtwPanel, btwRequiredTerminalRows } from './panel.ts';
import { openBtwConversation, type BtwConversation } from './session.ts';

interface OpenPanel {
  readonly controller: AbortController;
  opening?: Promise<BtwConversation>;
  panel?: BtwPanel;
  closing?: Promise<void>;
}

/**
 * Close one `/btw` run exactly once.
 *
 * The panel is torn down synchronously, then the internal session is disposed.
 * Releasing the run is the caller's invariant, not a reward for a clean
 * teardown: a rejected dispose still clears ownership, and the rejection is
 * propagated so the failure is reported instead of being mistaken for success.
 */
function closeBtwRun(run: OpenPanel, release: () => void): Promise<void> {
  if (run.closing) return run.closing;
  run.controller.abort();
  run.panel?.dispose();
  run.closing = (async () => {
    try {
      // A rejected creation owns its own partial setup cleanup.
      const session = await run.opening?.catch(() => undefined);
      await session?.dispose();
    } finally {
      release();
    }
  })();
  return run.closing;
}

/**
 * One line that keeps the cause chain: an aggregate cleanup failure is useless
 * to the user without the provider error underneath it.
 */
function errorDetail(error: unknown, depth = 0): string {
  const message = error instanceof Error ? error.message : String(error);
  if (depth >= 3 || !(error instanceof Error)) return message;
  const nested: unknown[] = [];
  const aggregated: unknown = (error as { errors?: unknown }).errors;
  if (Array.isArray(aggregated)) nested.push(...aggregated);
  if (error.cause !== undefined) nested.push(error.cause);
  const parts = [...new Set(nested
    .map((cause) => errorDetail(cause, depth + 1))
    .filter((part) => part !== '' && part !== message))];
  return parts.length === 0 ? message : `${message}: ${parts.join('; ')}`;
}

/** The dock needs the fullscreen renderer: regular mode delivers no mouse input. */
class TerminalNotFullscreen extends Error {
  constructor() {
    super('/btw needs fullscreen TUI mode; set tuiMode to "fullscreen" and reopen it.');
    this.name = 'TerminalNotFullscreen';
  }
}

/**
 * Best-effort check: the terminal cannot even hold the preferred minimum plus one
 * row for the main conversation. It says nothing about the height the SDK layout
 * finally grants the dock.
 */
class TerminalTooSmall extends Error {
  constructor(minRows: number, rows: number) {
    super(
      `/btw prefers at least ${String(btwRequiredTerminalRows(minRows))} terminal rows for its ${String(minRows)}-row dock; this terminal has ${String(rows)}.`,
    );
    this.name = 'TerminalTooSmall';
  }
}

/** The dialog and its internal SDK session share one lifetime, separate from Main. */
export function installBtwCommand(pi: ExtensionAPI): void {
  const configFor = harnessConfigFor(pi);
  let active: OpenPanel | undefined;
  const release = (run: OpenPanel): void => {
    if (active === run) active = undefined;
  };
  const close = (run: OpenPanel): Promise<void> => closeBtwRun(run, () => release(run));
  // Lifecycle events keep their awaited contract: the SDK waits for this promise,
  // so a replacement cannot race past a pending child cleanup. The failure is
  // reported through the event's own live context, never through cached state.
  const closeForEvent = async (ctx: ExtensionContext): Promise<void> => {
    if (active === undefined) return;
    const run = active;
    try {
      await close(run);
    } catch (error) {
      ctx.ui.notify(`Closed /btw, but its session cleanup failed: ${errorDetail(error)}`, 'error');
    }
  };
  pi.on('session_shutdown', (_event, ctx) => closeForEvent(ctx));
  pi.on('session_tree', (_event, ctx) => closeForEvent(ctx));
  pi.registerCommand('btw', {
    description: 'Ask a side question in a separate conversation',
    async handler(args, ctx) {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('/btw requires interactive terminal mode.', 'error');
        return;
      }
      if (active !== undefined) {
        ctx.ui.notify('A /btw conversation is already open or closing.', 'info');
        return;
      }
      let snapshot;
      try {
        snapshot = captureInheritedContext(pi, ctx);
        if (snapshot.model === null) throw new Error('Select a model before opening /btw.');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        return;
      }
      const minRows = configFor(ctx).btw.panelMinRows;
      const run: OpenPanel = { controller: new AbortController() };
      active = run;
      const session = () => run.opening ??= openBtwConversation(pi, ctx, snapshot, run.controller.signal);
      try {
        // Inline custom UI: the SDK mounts it in the editor slot at the bottom of
        // the screen, so the main transcript stays visible above the panel.
        await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
          // The regular renderer never enables mouse reporting, so the dock's
          // viewport controls would be advertised but dead. Refuse it explicitly
          // instead of shipping a keyboard-only downgrade.
          if (tui.mode !== 'fullscreen') throw new TerminalNotFullscreen();
          const rows = tui.terminal.rows;
          // A dock that cannot keep its configured minimum rows is refused rather
          // than squeezed, so the answer never becomes unreadable. The transcript
          // keeps one row above the dock, and the SDK's dock frame keeps its own.
          if (!Number.isFinite(rows) || rows < btwRequiredTerminalRows(minRows)) {
            throw new TerminalTooSmall(minRows, Number.isFinite(rows) ? rows : 0);
          }
          const panel = new BtwPanel(tui, theme, keybindings, {
            minRows,
            ...(args.trim() ? { initialQuestion: args.trim() } : {}),
            async ask(question, onText) { await (await session()).ask(question, onText); },
            async cancel() { if (run.opening) await (await run.opening).cancel(); },
            onClose: () => done(),
          });
          run.panel = panel;
          return panel;
        });
      } catch (error) {
        if (error instanceof TerminalTooSmall || error instanceof TerminalNotFullscreen) {
          ctx.ui.notify(error.message, 'error');
          return;
        }
        throw error;
      } finally {
        try {
          await close(run);
        } catch (error) {
          // The dock is already gone; say that cleanup failed instead of hiding it.
          ctx.ui.notify(`Closed /btw, but its session cleanup failed: ${errorDetail(error)}`, 'error');
        }
      }
    },
  });
}
