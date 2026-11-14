/**
 * Resolve one preset against the live catalog into an apply plan.
 *
 * This is the pure core of applying a preset. It answers, without mutating any
 * session, "given this preset and what this session currently knows, what should
 * change, and what is wrong?". The extension wiring then executes the plan
 * through the SDK. Keeping resolution pure makes the "validate before reporting
 * success" rule testable: a plan is only returned when the hard checks pass.
 *
 * Failure policy:
 * - An unknown model is a hard error. The apply must not proceed and must not
 *   report success, matching the requirement not to copy the reference plugin's
 *   "model switch failed but still announce activation".
 * - Unknown tool names and invalid modifier tokens are warnings. The known part
 *   of the selection still applies, and the dropped names are reported, the way
 *   Pi's own `defaultTools` tolerates a stale name.
 * - Thinking level is carried as-is; clamping to what a model supports is a
 *   runtime concern of the apply step, not a config error.
 */

import {
  type CodemodeMode,
  type PresetConfig,
  type PresetModel,
  type ThinkingLevelName,
} from './config.ts';
import { applyToolModifiers, parseToolModifiers, excludedPresetTools } from './modifiers.ts';

/** What the resolver needs to know about the live session. */
export interface PresetCatalogView {
  /** Whether `provider/id` exists in the model catalog. */
  hasModel(provider: string, id: string): boolean;
  /** Every registered tool name eligible for a preset selection. */
  allToolNames(): readonly string[];
  /** The stable base selection modifiers are computed against. */
  baseToolSet(): readonly string[];
}

export type PresetIssueSeverity = 'error' | 'warning';

/** One reason a preset was not applied (error) or only partly applied (warning). */
export interface PresetIssue {
  readonly severity: PresetIssueSeverity;
  readonly kind:
    | 'unknown_model'
    | 'invalid_tool_modifier'
    | 'unknown_tool'
    | 'invalid_codemode_mode';
  readonly detail: string;
}

/** The resolved, side-effect-free instruction to apply a preset. */
export interface PresetApplyPlan {
  readonly name: string;
  readonly model?: PresetModel;
  readonly thinkingLevel?: ThinkingLevelName;
  /** Absolute final tool selection, when the preset configured tools. */
  readonly tools?: readonly string[];
  readonly disabledTools?: readonly string[];
  readonly codemode?: { readonly mode: CodemodeMode };
  /** Resolved instruction text; null when the preset carries none. */
  readonly instructions: string | null;
}

export interface PresetResolution {
  /** Present only when no error-severity issue occurred. */
  readonly plan: PresetApplyPlan | null;
  readonly issues: readonly PresetIssue[];
}

/**
 * Resolve `preset` against `view`. The returned plan is a plain value safe to
 * persist as a snapshot before/after the apply step mutates the session.
 */
export function resolvePreset(name: string, preset: PresetConfig, view: PresetCatalogView): PresetResolution {
  const issues: PresetIssue[] = [];

  let model: PresetModel | undefined;
  if (preset.model !== undefined) {
    if (view.hasModel(preset.model.provider, preset.model.id)) model = preset.model;
    else {
      issues.push({
        severity: 'error',
        kind: 'unknown_model',
        detail: `model ${preset.model.provider}/${preset.model.id} is not in the catalog`,
      });
    }
  }

  let tools: readonly string[] | undefined;
  if (preset.tools !== undefined) {
    const parsed = parseToolModifiers(preset.tools);
    for (const raw of parsed.invalid) {
      issues.push({ severity: 'warning', kind: 'invalid_tool_modifier', detail: `ignored tool token "${raw}"` });
    }
    if (parsed.tokens.some(token => token.op === '=') && parsed.tokens.some(token => token.op !== '=')) {
      issues.push({ severity: 'error', kind: 'invalid_tool_modifier', detail: 'plain tool names cannot be mixed with + or - modifiers' });
    }
    const known = new Set(view.allToolNames());
    const resolved = applyToolModifiers(view.baseToolSet(), parsed.tokens);
    const kept: string[] = [];
    for (const toolName of resolved) {
      if (known.has(toolName)) kept.push(toolName);
      else if (parsed.tokens.some((token) => token.op === '+' && token.name === toolName)) {
        // Only an explicit add of an unknown name is worth reporting; removing a
        // name that is not present is a no-op, not a mistake.
        issues.push({ severity: 'warning', kind: 'unknown_tool', detail: `unknown tool "${toolName}" not added` });
      }
    }
    tools = kept;
  }

  const hasError = issues.some((issue) => issue.severity === 'error');
  if (hasError) return { plan: null, issues };

  const plan: PresetApplyPlan = {
    name,
    ...(model === undefined ? {} : { model }),
    ...(preset.thinkingLevel === undefined ? {} : { thinkingLevel: preset.thinkingLevel }),
    ...(tools === undefined ? {} : { tools, disabledTools: excludedPresetTools(preset.tools) }),
    ...(preset.codemode === undefined ? {} : { codemode: preset.codemode }),
    instructions: preset.instructions ?? null,
  };
  return { plan, issues };
}
