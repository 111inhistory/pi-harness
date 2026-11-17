/**
 * Execute a resolved preset plan against a session, honestly.
 *
 * The resolver already decided *what* to change. This step performs the minimal,
 * ordered mutations and reports exactly what happened. Three rules drive it:
 *
 * 1. Validate before success. If the model cannot be selected (for example its
 *    provider is not authenticated), the apply stops before touching thinking,
 *    tools or the branch snapshot and reports failure. It never announces an
 *    activation that did not happen.
 * 2. Persist before effect. The preset's tool contributions and Codemode intent
 *    are branch records, so both are appended before the live loadout is
 *    recomputed from them. A failed record write changes no tool membership.
 *    A loadout sync failure is reported as a warning on the durable outcome
 *    instead of escaping: the records stay authoritative and there is no
 *    automatic retry or rollback.
 * 3. Do not fake unsupported effects. The harness host applies `codemode.mode`
 *    through a branch override for the next request. Hosts without that
 *    capability record the mode but report that it was not switched.
 *
 * The host is a narrow interface so this logic is unit-testable without an SDK
 * session; the extension adapts the real `pi`/`ctx` surface to it.
 */

import type { CodemodeMode, PresetModel, ThinkingLevelName } from './config.ts';
import type { PresetSnapshot } from './state.ts';
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
   * failed, or null when it was applied; a failure never un-writes the records.
   */
  syncTools(): string | null;
  appendState(record: { readonly snapshot: PresetSnapshot | null }): void;
  /** Apply a live Codemode mode on the harness loadout; omitted hosts cannot. */
  applyCodemodeMode?(mode: 'on' | 'only'): void;
  /** Clear a preset-applied Codemode mode back to Settings. */
  clearCodemodeMode?(): void;
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
      readonly severity: 'warning';
      readonly kind: 'codemode_not_applied';
      readonly codemode: { readonly mode: CodemodeMode };
      readonly detail: string;
    }
  | {
      readonly severity: 'warning';
      readonly kind: 'tool_sync_failed';
      readonly detail: string;
    };

export interface PresetApplyOutcome {
  readonly applied: boolean;
  /** The snapshot written to the branch (null when nothing was applied). */
  readonly snapshot: PresetSnapshot | null;
  readonly issues: readonly PresetIssue[];
  /** Runtime effects that could not be applied, including auth and Codemode. */
  readonly problems: readonly PresetApplyProblem[];
  /** True when a declared codemode mode could not be switched at runtime. */
  readonly codemodeNotApplied: boolean;
}

export interface PresetClearOutcome {
  readonly cleared: true;
  readonly snapshot: null;
  readonly codemodeCleared: boolean;
  /**
   * The loadout effect failed after the clear was durable. Null means the
   * withdrawal was applied; either way the cleared state is authoritative.
   */
  readonly toolSyncError: string | null;
}

/**
 * Apply a resolved plan. A failed hard validation (model authentication) reports
 * `applied: false`; a durable apply whose loadout effect failed stays
 * `applied: true` with an explicit warning, because the records are the truth.
 */
export async function applyPresetPlan(
  plan: PresetApplyPlan,
  issues: readonly PresetIssue[],
  host: PresetApplyHost,
): Promise<PresetApplyOutcome> {
  if (plan.model !== undefined) {
    const selected = await host.setModel(plan.model.provider, plan.model.id);
    if (!selected) {
      return {
        applied: false,
        snapshot: null,
        issues,
        problems: [{
          severity: 'error',
          kind: 'model_unauthenticated',
          model: plan.model,
          detail: `model ${plan.model.provider}/${plan.model.id} is not authenticated; nothing applied.`,
        }],
        codemodeNotApplied: false,
      };
    }
  }

  if (plan.thinkingLevel !== undefined) host.setThinkingLevel(plan.thinkingLevel);

  const snapshot: PresetSnapshot = {
    name: plan.name,
    ...(plan.model === undefined ? {} : { model: plan.model }),
    ...(plan.thinkingLevel === undefined ? {} : { thinkingLevel: plan.thinkingLevel }),
    ...(plan.tools === undefined ? {} : { tools: plan.tools }),
    ...(plan.disabledTools === undefined ? {} : { disabledTools: plan.disabledTools }),
    ...(plan.codemode === undefined ? {} : { codemode: plan.codemode }),
    instructions: plan.instructions,
  };
  // Durable records first: the snapshot is the base/blacklist contribution, and
  // the Codemode intent is a projection record. The loadout sync is the only
  // effect and reads both back, so it runs last.
  host.appendState({ snapshot });

  const problems: PresetApplyProblem[] = [];
  let codemodeNotApplied = false;
  if (plan.codemode !== undefined) {
    if (host.applyCodemodeMode !== undefined) {
      // The mode takes effect on the harness loadout from the next request, so a
      // declared mode is genuinely applied rather than merely recorded.
      host.applyCodemodeMode(plan.codemode.mode);
    } else {
      codemodeNotApplied = true;
      problems.push({
        severity: 'warning',
        kind: 'codemode_not_applied',
        codemode: { mode: plan.codemode.mode },
        detail: `codemode mode "${plan.codemode.mode}" cannot be applied in this session; it was recorded only.`,
      });
    }
  }

  const syncError = host.syncTools();
  if (syncError !== null) {
    problems.push({
      severity: 'warning',
      kind: 'tool_sync_failed',
      detail: `the tool loadout could not be synchronized from the recorded collections: ${syncError}`,
    });
  }

  return { applied: true, snapshot, issues, problems, codemodeNotApplied };
}

/**
 * Clear the active preset: stop managing without rolling the session back.
 *
 * The model, thinking level and base membership stay exactly as they are. The
 * null snapshot ends the preset's contributions, so its blacklist lifetime ends
 * too and the loadout is recomputed: a tool whose only prohibition was this
 * preset becomes available again, while the base selection it established stays
 * as ordinary session membership. The instruction section is withdrawn (the
 * next request projects a null section).
 */
export function clearActivePreset(host: PresetApplyHost): PresetClearOutcome {
  // Durable withdrawal first: the null snapshot and the Codemode intent both
  // stop the preset's contribution; the loadout sync is the last effect.
  host.appendState({ snapshot: null });
  const codemodeCleared = host.clearCodemodeMode !== undefined;
  host.clearCodemodeMode?.();
  const toolSyncError = host.syncTools();
  return { cleared: true, snapshot: null, codemodeCleared, toolSyncError };
}
