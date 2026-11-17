import type { TUI } from '@earendil-works/pi-tui';

/** Fallback when a terminal (or a test harness) reports no finite row count. */
const FALLBACK_TERMINAL_ROWS = 24;

/**
 * Rows reserved for host chrome around an inline dock (transcript row, status,
 * footer, widgets). The SDK does not expose the component's final allocated
 * height, so this is a deliberate estimate, not a layout guarantee.
 */
export const INLINE_HOST_RESERVE_ROWS = 4;

/** Normalize the terminal height to positive whole rows. */
export function terminalRows(tui: TUI): number {
  const rows = tui.terminal?.rows;
  return Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : FALLBACK_TERMINAL_ROWS;
}

/**
 * Rows an inline component can occupy after the estimated host reserve.
 *
 * An explicit `reservedRows` replaces the default; it is not added to it.
 * Clamping at one row keeps a caller from producing an empty frame; callers
 * that need a real minimum must check {@link inlinePanelBudget}.fits.
 */
export function availableInlineRows(tui: TUI, reservedRows = INLINE_HOST_RESERVE_ROWS): number {
  const reserved = Number.isFinite(reservedRows) ? Math.max(0, Math.floor(reservedRows)) : INLINE_HOST_RESERVE_ROWS;
  return Math.max(1, terminalRows(tui) - reserved);
}

/** One inline panel's current height policy and whether the host can honor its floor. */
export interface InlinePanelBudget {
  /** Normalized physical terminal rows. */
  readonly terminalRows: number;
  /** Rows left after the estimated host reserve. */
  readonly availableRows: number;
  /** Component floor requested by the caller (for example `btw.panelMinRows`). */
  readonly minRows: number;
  /** Current render height: half-terminal target, floored by `minRows`, capped by `availableRows`. */
  readonly height: number;
  /** Whether the estimated host budget still covers the component floor. */
  readonly fits: boolean;
  /** Physical terminal rows needed for `minRows`: `minRows + INLINE_HOST_RESERVE_ROWS`. */
  readonly requiredTerminalRows: number;
}

/**
 * One shared policy for inline docks (BTW and the capability picker).
 *
 * `minRows` is a component floor, never a terminal threshold. The half-terminal
 * target is capped by the estimated host budget; when the estimate cannot cover
 * the floor, `fits` is false and the caller renders its own refusal instead of
 * squeezing a one-row panel. The reserve is a documented estimate because the
 * SDK offers no public allocated-height hook.
 */
export function inlinePanelBudget(tui: TUI, componentMinRows: number): InlinePanelBudget {
  const rows = terminalRows(tui);
  const minRows = Number.isFinite(componentMinRows) ? Math.max(1, Math.floor(componentMinRows)) : 1;
  const availableRows = availableInlineRows(tui);
  const desired = Math.max(minRows, Math.round(rows * 0.5));
  return {
    terminalRows: rows,
    availableRows,
    minRows,
    height: Math.max(1, Math.min(desired, availableRows)),
    fits: rows - INLINE_HOST_RESERVE_ROWS >= minRows,
    requiredTerminalRows: minRows + INLINE_HOST_RESERVE_ROWS,
  };
}
