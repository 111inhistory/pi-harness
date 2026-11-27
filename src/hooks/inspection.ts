import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { restorePresetSnapshot } from '../preset/state.ts';
import { HookLayerError, hookLayerWinners, type HookAction, type HookSource, type readHookLayers } from './config.ts';
import { restoreHookOverrides } from './override.ts';
import type { HookStatsSnapshot } from './stats.ts';
import { compileWhen } from './when.ts';

interface Warning {
  readonly scope: HookSource;
  readonly id?: string;
  readonly code: 'version_invalid' | 'layer_invalid' | 'when_invalid' | 'classifier_unconfigured';
}

export function inspectHooks(ctx: ExtensionContext, readLayers: () => ReturnType<typeof readHookLayers>, classifierConfigured: boolean) {
  const branch = ctx.sessionManager.getBranch();
  const preset = restorePresetSnapshot(branch);
  const mutedIds = restoreHookOverrides(branch);
  const common = { preset: preset?.name ?? null, classifierConfigured, muted: [...mutedIds].sort() };
  const warnings: Warning[] = [];
  let layers: ReturnType<typeof readHookLayers>;
  try { layers = readLayers(); }
  catch (error) {
    if (!(error instanceof HookLayerError)) throw error;
    warnings.push({ scope: error.scope, code: error.code, ...(error.id === undefined ? {} : { id: error.id }) });
    return { ...common, valid: false, rules: [], disabled: [], warnings };
  }
  const disabled: string[] = [];
  const rules = hookLayerWinners(layers.global.rules, preset?.hooks ?? {}, layers.project.rules).flatMap(([id, { source, rule }]) => {
    if ('enabled' in rule) { disabled.push(id); return []; }
    const muted = mutedIds.has(id);
    const classifyKind = rule.classify?.kind ?? null;
    let active = !muted;
    // The file reader validated its expressions; persisted Presets may predate the current grammar.
    if (source === 'preset' && rule.when !== undefined) {
      try { compileWhen(rule.when, rule.on); }
      catch { active = false; warnings.push({ scope: source, id, code: 'when_invalid' }); }
    }
    if (classifyKind !== null && !classifierConfigured) {
      active = false;
      warnings.push({ scope: source, id, code: 'classifier_unconfigured' });
    }
    const actionTypes = new Set<HookAction['type']>();
    for (const action of rule.actions) actionTypes.add(action.type);
    for (const actions of Object.values(rule.onChoice ?? {})) {
      for (const action of actions) actionTypes.add(action.type);
    }
    return [{ id, source, on: rule.on, hasWhen: rule.when !== undefined, classifyKind, actionTypes: [...actionTypes],
      hasRepeat: rule.repeat !== undefined, observeOnly: actionTypes.size === 0, muted, active }];
  });
  return { ...common, valid: true, rules, disabled, warnings };
}

interface HookInspection {
  current(ctx: ExtensionContext): ReturnType<typeof inspectHooks> | undefined;
  stats(): HookStatsSnapshot | undefined;
}

const CHANNEL = 'pi-harness:hook-inspection';
interface Exchange { inspection?: HookInspection }

export function exposeHookInspection(pi: ExtensionAPI, inspection: HookInspection): void {
  pi.events.on(CHANNEL, data => { (data as Exchange).inspection = inspection; });
}

export function hookInspection(pi: ExtensionAPI): HookInspection | undefined {
  const request: Exchange = {};
  pi.events.emit(CHANNEL, request);
  return request.inspection;
}
