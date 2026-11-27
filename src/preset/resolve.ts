/**
 * Resolve one preset against the live catalog into an apply plan.
 *
 * This is the pure core of applying a preset. It answers, without mutating any
 * session, "given this preset and what this session currently knows, what should
 * change, what version is that, and what is wrong?". The extension wiring then
 * executes the plan through the SDK. Keeping resolution pure makes the "validate
 * before reporting success" rule testable: a plan is only returned when the hard
 * checks pass.
 *
 * Failure policy:
 * - An unknown model is a hard error. The apply must not proceed and must not
 *   report success, matching the requirement not to copy the reference plugin's
 *   "model switch failed but still announce activation".
 * - Unknown tool names and invalid modifier tokens are warnings. The known part
 *   of the selection still applies, and the dropped names are reported, the way
 *   Pi's own `defaultTools` tolerates a stale name.
 * - The resolved selection is a layer contribution, not a grant: a final `-name`
 *   token becomes the current-preset blacklist entry, and every blacklist source
 *   still wins when the tool-access domain recomputes the loadout.
 * - Thinking level is carried as-is; clamping to what a model supports is a
 *   runtime concern of the apply step, not a config error.
 *
 * THE NOMINAL CANDIDATE BASELINE
 * A selection is computed from a *nominal* baseline, not from the recorded
 * session baseline alone: `session baseline ∪ registered Harness default tools`.
 * An old session's recorded baseline predates tools such as `job_stop`, so
 * computing only from it would resolve every modifier selection to a set that
 * silently drops the new default tools. The Harness-owned list below is explicit
 * (never every registered tool) so late-registered MCP tools stay out, matching
 * the rule that a tool registered during the run does not join the preset base.
 * User `base remove`/`blacklist` state is deliberately NOT applied here: the
 * manual layer must not pollute the preset's version identity. The four-layer
 * precedence is applied once, by the tool-access domain, when the live loadout
 * is generated.
 */

import { CAPABILITY_TOOL_NAME } from '../capability/contracts.ts';
import { JOB_TOOLS } from '../harness-tools.ts';
import {
  type CodemodeMode,
  type PresetConfig,
  type PresetModel,
  type ThinkingLevelName,
} from './config.ts';
import { applyToolModifiers, excludedPresetTools, parseToolModifiers } from './modifiers.ts';
import {
  presetContentHash,
  type PresetToolSelection,
} from './state.ts';

/**
 * Harness tools that are active by default when their surface registers them.
 *
 * `defaultActive: false` registrations (Subagent tools, `msg_write`, native
 * discovery tools) are excluded on purpose: a preset must not grant them by
 * counting them into the baseline. Registration is still required — a surface
 * that never registered a name cannot contribute it.
 */
export const PRESET_DEFAULT_ACTIVE_TOOLS: readonly string[] = [...JOB_TOOLS, CAPABILITY_TOOL_NAME];

/** What the resolver needs to know about the live session. */
export interface PresetCatalogView {
  /** Whether `provider/id` exists in the model catalog. */
  hasModel(provider: string, id: string): boolean;
  /** Every registered tool name eligible for a preset selection. */
  allToolNames(): readonly string[];
  /**
   * The effective session baseline: the recorded baseline plus every permanent
   * preset `baselineAdditions` entry. Never the current active set.
   */
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
  /** Resolved tool-name projection of `toolSelection`; absent when undeclared. */
  readonly tools?: readonly string[];
  /** Current-preset blacklist: explicit final minus tokens. */
  readonly disabledTools?: readonly string[];
  /** Normalized intent the tool-access replay re-derives membership from. */
  readonly toolSelection: PresetToolSelection;
  readonly codemode?: { readonly mode: CodemodeMode };
  /** Resolved instruction text; null when the preset carries none. */
  readonly instructions: string | null;
  readonly hooks?: NonNullable<PresetConfig['hooks']>;
  /** Version identity of every semantic field above. */
  readonly contentHash: string;
  /** Registered Harness default tools this apply adds to the permanent baseline. */
  readonly baselineAdditions: readonly string[];
}

export interface PresetResolution {
  /** Present only when no error-severity issue occurred. */
  readonly plan: PresetApplyPlan | null;
  readonly issues: readonly PresetIssue[];
}

/** Fold `+`/`-` tokens to their final add/remove sets (a later token wins). */
function foldModifiers(tokens: readonly { readonly op: '+' | '-' | '='; readonly name: string }[]): PresetToolSelection {
  const add = new Set<string>();
  const remove = new Set<string>();
  for (const token of tokens) {
    if (token.op === '+') {
      remove.delete(token.name);
      add.add(token.name);
    } else if (token.op === '-') {
      add.delete(token.name);
      remove.add(token.name);
    }
  }
  return { kind: 'modifiers', add: [...add], remove: [...remove] };
}

/** The nominal candidate baseline described in the module comment. */
function candidateBaseline(sessionBase: readonly string[], registered: readonly string[]): string[] {
  const base = [...new Set(sessionBase)];
  const known = new Set(registered);
  const present = new Set(base);
  for (const name of PRESET_DEFAULT_ACTIVE_TOOLS) {
    if (!known.has(name) || present.has(name)) continue;
    present.add(name);
    base.push(name);
  }
  return base;
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

  let toolSelection: PresetToolSelection = { kind: 'none' };
  let tools: readonly string[] | undefined;
  let disabledTools: readonly string[] | undefined;
  const toolFields = (): { readonly tools?: readonly string[]; readonly disabledTools?: readonly string[] } =>
    tools === undefined || disabledTools === undefined ? {} : { tools, disabledTools };
  let baselineAdditions: readonly string[] = [];
  if (preset.tools !== undefined) {
    const declared = preset.tools;
    const parsed = parseToolModifiers(declared);
    for (const raw of parsed.invalid) {
      issues.push({ severity: 'warning', kind: 'invalid_tool_modifier', detail: `ignored tool token "${raw}"` });
    }
    const mixed = parsed.tokens.some(token => token.op === '=') && parsed.tokens.some(token => token.op !== '=');
    if (mixed) {
      issues.push({ severity: 'error', kind: 'invalid_tool_modifier', detail: 'plain tool names cannot be mixed with + or - modifiers' });
    }
    if (parsed.tokens.length === 0) {
      // An explicitly empty list is a deliberate empty selection; a list whose
      // every token was unusable is only a warning and declares nothing.
      if (declared.length === 0) toolSelection = { kind: 'replace', names: [] };
    } else if (parsed.tokens.every((token) => token.op === '=')) {
      toolSelection = { kind: 'replace', names: [...new Set(parsed.tokens.map((token) => token.name))] };
    } else {
      toolSelection = foldModifiers(parsed.tokens);
    }

    if (toolSelection.kind !== 'none' && !mixed) {
      // One read of each session fact: the baseline capture may write the
      // baseline record, so it must not be asked twice.
      const registered = view.allToolNames();
      const sessionBase = view.baseToolSet();
      const base = candidateBaseline(sessionBase, registered);
      const inSession = new Set(sessionBase);
      baselineAdditions = base.filter((toolName) => !inSession.has(toolName));
      // `replace` selects exactly its names; `modifiers` fold onto the candidate
      // baseline, so a switch and a direct apply land on the same selection.
      const resolved = toolSelection.kind === 'replace'
        ? toolSelection.names
        : applyToolModifiers(base, parsed.tokens);
      const known = new Set(registered);
      const kept: string[] = [];
      for (const toolName of resolved) {
        if (known.has(toolName)) {
          kept.push(toolName);
          continue;
        }
        // A plain name is a declaration, and an explicit add is a request;
        // removing an absent name is a no-op, not a mistake.
        if (toolSelection.kind === 'replace' || parsed.tokens.some((token) => token.op === '+' && token.name === toolName)) {
          issues.push({ severity: 'warning', kind: 'unknown_tool', detail: `unknown tool "${toolName}" not selected` });
        }
      }
      tools = kept;
      disabledTools = excludedPresetTools(declared);
    }
  }

  const hasError = issues.some((issue) => issue.severity === 'error');
  if (hasError) return { plan: null, issues };

  const instructions = preset.instructions ?? null;
  const codemode = preset.codemode === undefined ? undefined : { mode: preset.codemode.mode };
  const plan: PresetApplyPlan = {
    name,
    ...(model === undefined ? {} : { model }),
    ...(preset.thinkingLevel === undefined ? {} : { thinkingLevel: preset.thinkingLevel }),
    ...toolFields(),
    toolSelection,
    ...(codemode === undefined ? {} : { codemode }),
    instructions,
    ...(preset.hooks === undefined ? {} : { hooks: preset.hooks }),
    baselineAdditions,
    contentHash: presetContentHash({
      ...(model === undefined ? {} : { model }),
      ...(preset.thinkingLevel === undefined ? {} : { thinkingLevel: preset.thinkingLevel }),
      toolSelection,
      ...toolFields(),
      ...(codemode === undefined ? {} : { codemode }),
      instructions,
      ...(preset.hooks === undefined ? {} : { hooks: preset.hooks }),
    }),
  };
  return { plan, issues };
}
