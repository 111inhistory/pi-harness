/**
 * Execute a resolved preset plan against a session, honestly.
 *
 * The resolver already decided *what* to change and what version that is. This
 * step performs the minimal, ordered mutations and reports exactly what happened.
 * Four rules drive it:
 *
 * 1. Validate before success. An `expectedVersion` mismatch and a model that
 *    cannot be selected are both decided before any record or live effect; the
 *    apply never announces an activation that did not happen.
 * 2. Persist before effect. The one v2 `preset-state` record carries the whole
 *    version pack (snapshot + permanent `baselineAdditions`), so there is no
 *    half-written state to reconcile. A failed record write changes no tool
 *    membership. A loadout sync failure is reported as a warning on the durable
 *    outcome instead of escaping: the record stays authoritative and there is no
 *    automatic retry or rollback.
 * 3. Do not write redundant records. Re-applying the preset that is already
 *    recorded with the same content hash writes nothing; only a desynchronized
 *    live loadout is resynchronized, so an explicit retry is never swallowed.
 *    A NEW record always recomputes the loadout, even when the live set happens
 *    to match: withdrawing the previous preset's contribution is part of
 *    applying the next one.
 * 4. Do not fake unsupported effects. Codemode is not a separate wire record:
 *    the mode lives in the snapshot and the harness loadout reads it in branch
 *    order. There is therefore no "recorded but not applied" state to report.
 *
 * The host is a narrow interface so this logic is unit-testable without an SDK
 * session; the extension adapts the real `pi`/`ctx` surface to it.
 */

import type { PresetModel, ThinkingLevelName } from './config.ts';
import { buildPresetSnapshot, type PresetSnapshot } from './state.ts';
import type { PresetApplyPlan, PresetIssue } from './resolve.ts';

/** The side effects an apply needs; the extension maps these to the SDK. */
export interface PresetApplyHost {
  /** Select a model; resolves false when its provider is not authenticated. */
  setModel(provider: string, id: string): Promise<boolean>;
  setThinkingLevel(level: ThinkingLevelName): void;
  /**
   * Recompute the live tool loadout from the branch after {@link appendState}.
   * The tool-access domain owns baseline/dynamic/blacklist collections; this
   * host method only applies its result. Returns the error text when the effect
   * failed, or null when it was applied; a failure never un-writes the record.
   */
  syncTools(): string | null;
  /**
   * Whether the live active set already matches the branch collections. A false
   * answer only costs a redundant recompute, so an adapter that cannot prove
   * synchronization must answer false.
   */
  toolsInSync(): boolean;
  /** One durable v2 record: the snapshot plus its permanent baseline increments. */
  appendState(record: {
    readonly snapshot: PresetSnapshot | null;
    readonly baselineAdditions?: readonly string[];
  }): void;
  /** The snapshot currently in force on this branch, null when cleared/unset. */
  recordedSnapshot(): PresetSnapshot | null;
  /**
   * Opaque identity of the branch the plan was resolved against. Compares
   * unequal after a tree switch, a fork or any other append during an awaited
   * effect, which is why the apply re-checks it before writing.
   */
  contextToken(): string;
  /**
   * Names the latest preset excludes but the user's manual `/capability base`
   * layer keeps available. Reported as a warning so the loadout is not a
   * surprise.
   */
  retainedToolNames?(): readonly string[];
  /**
   * Caller-owned session identity check (for example an RPC session id).
   * Returns the reason when the session is no longer the targeted one.
   */
  assertSession?(): string | null;
}

/** Admission options evaluated before any record or live effect. */
export interface PresetApplyOptions {
  /** The version the caller previewed; a mismatch refuses the write. */
  readonly expectedVersion?: string;
}

/** A runtime effect that the resolved plan could not apply. */
export type PresetApplyProblem =
  | {
      readonly severity: 'error';
      readonly kind: 'model_unauthenticated';
      readonly model: PresetModel;
      readonly detail: string;
    }
  | {
      readonly severity: 'error';
      readonly kind: 'version_mismatch';
      readonly expected: string;
      readonly actual: string;
      readonly detail: string;
    }
  | {
      readonly severity: 'warning';
      readonly kind: 'tool_sync_failed';
      readonly detail: string;
    }
  | {
      readonly severity: 'error';
      readonly kind: 'context_changed';
      readonly detail: string;
    }
  | {
      readonly severity: 'warning';
      readonly kind: 'tool_retained_by_branch';
      readonly retainedTools: readonly string[];
      readonly detail: string;
    };

export interface PresetApplyOutcome {
  readonly applied: boolean;
  /**
   * True when the requested definition was already recorded and in force, so no
   * new branch record was written. A desynchronized loadout may still have been
   * resynchronized.
   */
  readonly unchanged: boolean;
  /**
   * The snapshot in force after the apply: the new one, the already recorded one
   * when unchanged, or null when nothing was applied.
   */
  readonly snapshot: PresetSnapshot | null;
  readonly issues: readonly PresetIssue[];
  /** Runtime effects that could not be applied. */
  readonly problems: readonly PresetApplyProblem[];
}

export interface PresetClearOutcome {
  readonly cleared: true;
  readonly snapshot: null;
  /**
   * The loadout effect failed after the clear was durable. Null means the
   * withdrawal was applied; either way the cleared state is authoritative.
   */
  readonly toolSyncError: string | null;
}

function syncFailure(error: string): PresetApplyProblem {
  return {
    severity: 'warning',
    kind: 'tool_sync_failed',
    detail: `the tool loadout could not be synchronized from the recorded collections: ${error}`,
  };
}

/** A refused apply: no record, no live effect, an explicit reason. */
function refused(issues: readonly PresetIssue[], problem: PresetApplyProblem): PresetApplyOutcome {
  return { applied: false, unchanged: false, snapshot: null, issues, problems: [problem] };
}

/**
 * Apply a resolved plan. A refused admission (version mismatch, model
 * authentication) reports `applied: false`; a durable apply whose loadout effect
 * failed stays `applied: true` with an explicit warning, because the record is
 * the truth.
 */
export async function applyPresetPlan(
  plan: PresetApplyPlan,
  issues: readonly PresetIssue[],
  host: PresetApplyHost,
  options: PresetApplyOptions = {},
): Promise<PresetApplyOutcome> {
  if (options.expectedVersion !== undefined && options.expectedVersion !== plan.contentHash) {
    return refused(issues, {
      severity: 'error',
      kind: 'version_mismatch',
      expected: options.expectedVersion,
      actual: plan.contentHash,
      detail: `the configured preset "${plan.name}" is now version ${plan.contentHash}, `
        + `not the previewed ${options.expectedVersion}; nothing applied. Re-read presets.current.`,
    });
  }

  const recorded = host.recordedSnapshot();
  const alreadyRecorded = recorded !== null
    && recorded.contentHash === plan.contentHash
    // The name is the branch's preset identity even though it is not hashed,
    // and a pending baseline increment is a durable fact the record must carry.
    && recorded.name === plan.name
    && plan.baselineAdditions.length === 0;

  if (alreadyRecorded) {
    // A true no-op: no model, thinking, record or loadout effect. Only a
    // desynchronized loadout is repaired, so an explicit retry is never
    // swallowed; a synchronized one returns without touching anything.
    if (host.toolsInSync()) {
      return { applied: true, unchanged: true, snapshot: recorded, issues, problems: [] };
    }
    const retryError = host.syncTools();
    return {
      applied: true,
      unchanged: false,
      snapshot: recorded,
      issues,
      problems: retryError === null ? [] : [syncFailure(retryError)],
    };
  }

  if (plan.model !== undefined) {
    const token = host.contextToken();
    const selected = await host.setModel(plan.model.provider, plan.model.id);
    // An await is an interleaving point: a tree switch, a fork, a retirement or
    // another branch entry invalidates the resolution. Nothing is written and the
    // apply is never replayed automatically.
    const caller = host.assertSession?.() ?? null;
    if (caller !== null) return refused(issues, { severity: 'error', kind: 'context_changed', detail: caller });
    if (host.contextToken() !== token) {
      return refused(issues, {
        severity: 'error',
        kind: 'context_changed',
        detail: 'the session branch changed during the model switch; nothing applied.',
      });
    }
    if (!selected) {
      return refused(issues, {
        severity: 'error',
        kind: 'model_unauthenticated',
        model: plan.model,
        detail: `model ${plan.model.provider}/${plan.model.id} is not authenticated; nothing applied.`,
      });
    }
  }
  if (plan.thinkingLevel !== undefined) host.setThinkingLevel(plan.thinkingLevel);

  const snapshot = buildPresetSnapshot({
    name: plan.name,
    ...(plan.model === undefined ? {} : { model: plan.model }),
    ...(plan.thinkingLevel === undefined ? {} : { thinkingLevel: plan.thinkingLevel }),
    ...(plan.tools === undefined ? {} : { tools: plan.tools }),
    ...(plan.disabledTools === undefined ? {} : { disabledTools: plan.disabledTools }),
    ...(plan.codemode === undefined ? {} : { codemode: plan.codemode }),
    instructions: plan.instructions,
    toolSelection: plan.toolSelection,
  });

  const problems: PresetApplyProblem[] = [];

  // Durable record first: it carries the tool selection and the permanent
  // baseline increments together, so the loadout sync below reads one consistent
  // version pack. A changed record always recomputes the loadout: withdrawing the
  // previous preset contribution is part of applying the new one.
  host.appendState({
    snapshot,
    ...(plan.baselineAdditions.length === 0 ? {} : { baselineAdditions: plan.baselineAdditions }),
  });
  const syncError = host.syncTools();
  if (syncError !== null) problems.push(syncFailure(syncError));
  const retained = host.retainedToolNames?.() ?? [];
  if (retained.length > 0) {
    // Informational, not a failure: the manual layer wins by design, but the
    // user must be able to see why a `-name` did not take a tool away.
    problems.push({
      severity: 'warning',
      kind: 'tool_retained_by_branch',
      retainedTools: [...retained],
      detail: `${retained.join(', ')} stayed available: the manual /capability base layer keeps them; `
        + 'remove that membership to let the preset exclude them.',
    });
  }

  return { applied: true, unchanged: false, snapshot, issues, problems };
}

/**
 * Clear the active preset: stop managing without rolling the session back.
 *
 * The null snapshot withdraws the preset's own layer, and nothing else:
 * - a `replace` selection stops replacing the effective baseline, so the
 *   recorded baseline membership becomes visible again;
 * - a preset `+name` contribution disappears again;
 * - its `disabledTools` lifetime ends, so a tool whose only prohibition was this
 *   preset becomes available again;
 * - the manual `/capability base` layer and every permanent `baselineAdditions`
 *   increment stay untouched, and model/thinking are never changed.
 * The instruction section is withdrawn (the next request projects a null
 * section). A `replace` selection therefore does change the effective base while
 * it is active — the clear is what restores the recorded membership.
 */
export function clearActivePreset(host: PresetApplyHost): PresetClearOutcome {
  if (host.recordedSnapshot() === null) {
    // Nothing is managed by a preset: no record to write. A loadout left behind
    // by an earlier failed sync is still repaired.
    const toolSyncError = host.toolsInSync() ? null : host.syncTools();
    return { cleared: true, snapshot: null, toolSyncError };
  }
  // Durable withdrawal first: the null snapshot stops the preset's contribution;
  // the loadout sync is the last effect.
  host.appendState({ snapshot: null });
  const toolSyncError = host.syncTools();
  return { cleared: true, snapshot: null, toolSyncError };
}
