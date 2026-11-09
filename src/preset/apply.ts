/**
 * Execute a resolved preset plan against a session, honestly.
 *
 * The resolver already decided *what* to change. This step performs the minimal,
 * ordered mutations and reports exactly what happened. Two rules drive it:
 *
 * 1. Validate before success. If the model cannot be selected (for example its
 *    provider is not authenticated), the apply stops before touching thinking,
 *    tools or the branch snapshot and reports failure. It never announces an
 *    activation that did not happen.
 * 2. Do not fake unsupported effects. The harness host applies `codemode.mode`
 *    through a branch override for the next request. Hosts without that
 *    capability record the mode but report that it was not switched.
 *
 * The host is a narrow interface so this logic is unit-testable without an SDK
 * session; the extension adapts the real `pi`/`ctx` surface to it.
 */

import type { PresetSnapshot } from './state.ts';
import type { PresetApplyPlan, PresetIssue } from './resolve.ts';
import type { ThinkingLevelName } from './config.ts';

/** The side effects an apply needs; the extension maps these to the SDK. */
export interface PresetApplyHost {
  /** Select a model; resolves false when its provider is not authenticated. */
  setModel(provider: string, id: string): Promise<boolean>;
  setThinkingLevel(level: ThinkingLevelName): void;
  setActiveTools(tools: readonly string[]): void;
  appendState(record: { readonly snapshot: PresetSnapshot | null }): void;
  notify(message: string, level: 'info' | 'warning' | 'error'): void;
  /** Apply a live Codemode mode on the harness loadout; omitted hosts cannot. */
  applyCodemodeMode?(mode: 'on' | 'only'): void;
  /** Clear a preset-applied Codemode mode back to Settings. */
  clearCodemodeMode?(): void;
}

export interface PresetApplyOutcome {
  readonly applied: boolean;
  /** The snapshot written to the branch (null when nothing was applied). */
  readonly snapshot: PresetSnapshot | null;
  readonly issues: readonly PresetIssue[];
  /** True when a declared codemode mode could not be switched at runtime. */
  readonly codemodeNotApplied: boolean;
}

/** Apply a resolved plan. Never reports success when a hard step failed. */
export async function applyPresetPlan(
  plan: PresetApplyPlan,
  issues: readonly PresetIssue[],
  host: PresetApplyHost,
): Promise<PresetApplyOutcome> {
  if (plan.model !== undefined) {
    const selected = await host.setModel(plan.model.provider, plan.model.id);
    if (!selected) {
      host.notify(
        `Preset "${plan.name}": model ${plan.model.provider}/${plan.model.id} is not authenticated; nothing applied.`,
        'error',
      );
      return { applied: false, snapshot: null, issues, codemodeNotApplied: false };
    }
  }

  if (plan.thinkingLevel !== undefined) host.setThinkingLevel(plan.thinkingLevel);
  if (plan.tools !== undefined) host.setActiveTools(plan.tools);

  let codemodeNotApplied = false;
  if (plan.codemode !== undefined) {
    if (host.applyCodemodeMode !== undefined) {
      // The mode takes effect on the harness loadout from the next request, so a
      // declared mode is genuinely applied rather than merely recorded.
      host.applyCodemodeMode(plan.codemode.mode);
    } else {
      codemodeNotApplied = true;
      host.notify(
        `Preset "${plan.name}": codemode mode "${plan.codemode.mode}" cannot be applied in this session; it was recorded only.`,
        'warning',
      );
    }
  }

  const snapshot: PresetSnapshot = {
    name: plan.name,
    ...(plan.model === undefined ? {} : { model: plan.model }),
    ...(plan.thinkingLevel === undefined ? {} : { thinkingLevel: plan.thinkingLevel }),
    ...(plan.tools === undefined ? {} : { tools: plan.tools }),
    ...(plan.codemode === undefined ? {} : { codemode: plan.codemode }),
    instructions: plan.instructions,
  };
  host.appendState({ snapshot });
  host.notify(
    codemodeNotApplied
      ? `Preset "${plan.name}" applied; codemode mode was recorded but not switched.`
      : `Preset "${plan.name}" applied.`,
    codemodeNotApplied ? 'warning' : 'info',
  );
  return { applied: true, snapshot, issues, codemodeNotApplied };
}

/**
 * Clear the active preset: stop managing without rolling anything back.
 *
 * The model, thinking level and tool set are left exactly as they are; only the
 * instruction section is withdrawn (the next request projects a null section) and
 * a null snapshot is recorded so resume knows the session is no longer managed.
 */
export function clearActivePreset(host: PresetApplyHost): void {
  host.appendState({ snapshot: null });
  host.clearCodemodeMode?.();
  host.notify('Preset cleared; model, thinking and tools are unchanged.', 'info');
}
