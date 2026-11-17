import type { TUI } from '@earendil-works/pi-tui';

/** Fallback when a terminal (or a test harness) reports no finite row count. */
const FALLBACK_TERMINAL_ROWS = 24;

/**
 * Normalize the terminal height to positive whole rows.
 *
 * A component can render before the TUI knows the real size, so a missing or
 * non-finite value falls back instead of yielding an empty frame. Both inline
 * consumers (the `/btw` dock and the capability picker) must budget from the
 * same number or one of them can overdraw the other's reserved rows.
 */
export function terminalRows(tui: TUI): number {
  const rows = tui.terminal?.rows;
  return Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : FALLBACK_TERMINAL_ROWS;
}

/**
 * Rows an inline component can occupy after reserving rows that must stay
 * visible around it (the Main conversation row, or a picker's header/footer).
 *
 * Clamping at one row is deliberate: an inline component that returns no lines
 * disappears with no way to recover, so the smallest honest answer is a single
 * clipped row. Callers with no chrome keep the default one-row reservation.
 */
export function availableInlineRows(tui: TUI, reservedRows = 1): number {
  const reserved = Number.isFinite(reservedRows) ? Math.max(0, Math.floor(reservedRows)) : 1;
  return Math.max(1, terminalRows(tui) - reserved);
}
