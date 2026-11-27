import { createHash } from 'node:crypto';
import { parseToolTarget } from '../capability/targets.ts';
import { configPaths, readConfigDocument, requireConfigVersion, type ConfigLocation, type ConfigScope } from '../config-storage.ts';
import type { HookClassifierInclude } from './projection.ts';
import { compileWhen, type WhenTrigger } from './when.ts';

export type HookTrigger = WhenTrigger;

export interface HookRepeat {
  readonly maxTriggers?: number;
  readonly cooldownTurns?: number;
  readonly resetOnCompaction?: true;
}

export type HookAction =
  | { readonly type: 'injectHint'; readonly text: string; readonly display?: true }
  | { readonly type: 'injectSection'; readonly text: string }
  | { readonly type: 'activate'; readonly targets: readonly string[] }
  | { readonly type: 'discoverCapability'; readonly hint?: string };

const HOOK_SLICE_FIELDS = ['prompt', 'result', 'recentInputs', 'recentTools', 'recentToolPreviews', 'toolDirectory'] as const satisfies readonly HookClassifierInclude[];
type DeferredAction = Exclude<HookAction, { type: 'injectSection' }>;
interface ClassifierPrompt {
  readonly question: string;
  readonly include: readonly HookClassifierInclude[];
}
export type HookClassification = ClassifierPrompt & (
  | { readonly kind: 'bool' }
  | { readonly kind: 'score'; readonly minScore: number }
  | { readonly kind: 'choice'; readonly choices: readonly string[] }
);

export interface HookRule {
  readonly on: HookTrigger;
  readonly when?: string;
  readonly repeat?: HookRepeat;
  readonly timeoutMs?: number;
  readonly actions: readonly HookAction[];
  readonly classify?: HookClassification;
  readonly onChoice?: Readonly<Record<string, readonly DeferredAction[]>>;
}

export type HookRules = Readonly<Record<string, HookRule | { readonly enabled: false }>>;

function table(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`${where} must be a table`);
  }
  return value as Record<string, unknown>;
}

function fields(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  const record = table(value, where);
  for (const key of Object.keys(record)) if (!keys.includes(key)) throw new Error(`${where}.${key} is unknown`);
  return record;
}

function boundedText(value: unknown, limit: number, where: string): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > limit) {
    throw new Error(`${where} must be non-empty text of at most ${limit} UTF-8 bytes`);
  }
  return value;
}

function optionalInteger(value: unknown, limit: number, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > limit) {
    throw new Error(`${where} must be an integer from 1 to ${limit}`);
  }
  return value;
}

function action(value: unknown, where: string): HookAction {
  const raw = fields(value, ['type', 'text', 'display', 'targets', 'hint'], where);
  switch (raw.type) {
    case 'injectHint':
      fields(raw, ['type', 'text', 'display'], where);
      if (raw.display !== undefined && typeof raw.display !== 'boolean') throw new Error(`${where}.display must be boolean`);
      return { type: 'injectHint', text: boundedText(raw.text, 4000, `${where}.text`), ...(raw.display ? { display: true } : {}) };
    case 'injectSection':
      fields(raw, ['type', 'text'], where);
      return { type: 'injectSection', text: boundedText(raw.text, 4000, `${where}.text`) };
    case 'activate': {
      fields(raw, ['type', 'targets'], where);
      if (!Array.isArray(raw.targets) || raw.targets.length === 0 || raw.targets.length > 32) {
        throw new Error(`${where}.targets must contain 1 to 32 explicit targets`);
      }
      const targets = raw.targets.map((value: unknown) => {
        const target = boundedText(value, 256, `${where}.targets`).trim();
        const parsed = parseToolTarget(target);
        if (!parsed || parsed.kind === 'prefix' || (parsed.kind === 'tool' && !/^[a-zA-Z0-9_.:-]+$/.test(target))) {
          throw new Error(`${where}.targets requires a tool name, mcp://server, or namespace://name`);
        }
        return target;
      });
      return { type: 'activate', targets: [...new Set(targets)] };
    }
    case 'discoverCapability':
      fields(raw, ['type', 'hint'], where);
      return { type: 'discoverCapability', ...(raw.hint === undefined ? {} : { hint: boundedText(raw.hint, 500, `${where}.hint`) }) };
    default:
      throw new Error(`${where}.type is not a Hook action`);
  }
}

function classification(value: unknown, trigger: HookTrigger, where: string): HookClassification {
  const raw = fields(value, ['kind', 'question', 'include', 'minScore', 'choices'], where);
  const question = boundedText(raw.question, 1000, `${where}.question`);
  const include: HookClassifierInclude[] = [];
  if (raw.include !== undefined) {
    if (!Array.isArray(raw.include) || raw.include.length > HOOK_SLICE_FIELDS.length) throw new Error(`${where}.include must be a list of projection fields`);
    for (const item of raw.include) {
      const field = HOOK_SLICE_FIELDS.find(field => item === field);
      if (field === undefined || (field === 'result' && trigger === 'before_agent_start') || (field === 'prompt' && trigger === 'tool_result')) {
        throw new Error(`${where}.include contains an unavailable field for ${trigger}`);
      }
      if (include.includes(field)) throw new Error(`${where}.include contains a duplicate field`);
      include.push(field);
    }
    include.sort();
  }
  if (raw.kind !== 'score' && raw.minScore !== undefined) throw new Error(`${where}.minScore requires kind = 'score'`);
  if (raw.kind !== 'choice' && raw.choices !== undefined) throw new Error(`${where}.choices requires kind = 'choice'`);
  switch (raw.kind) {
    case 'bool': return { kind: 'bool', question, include };
    case 'score': {
      const minScore = raw.minScore;
      if (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) throw new Error(`${where}.minScore must be from 0 to 1`);
      return { kind: 'score', question, include, minScore };
    }
    case 'choice': {
      if (!Array.isArray(raw.choices) || raw.choices.length < 1 || raw.choices.length > 16) throw new Error(`${where}.choices requires 1 to 16 names`);
      const choices = raw.choices.map((item: unknown) => {
        const name = boundedText(item, 64, `${where}.choices`);
        if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`${where}.choices contains an invalid name`);
        return name;
      });
      if (new Set(choices).size !== choices.length) throw new Error(`${where}.choices contains duplicate names`);
      return { kind: 'choice', question, include, choices };
    }
    default: throw new Error(`${where}.kind must be bool, score, or choice`);
  }
}

function actionsOf(value: unknown, where: string): HookAction[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error(`${where} must be an array of at most 8 actions`);
  return value.map((item: unknown, index) => action(item, `${where}.${index}`));
}

function isDeferredAction(action: HookAction): action is DeferredAction {
  return action.type !== 'injectSection';
}

export function isHookId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

export function normalizeHookRules(value: unknown, validateWhen = true): HookRules {
  const entries = Object.entries(table(value, 'hooks')).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.length > 32) throw new Error('a Hook layer may define at most 32 rules');
  const rules: Record<string, HookRules[string]> = Object.create(null);
  for (const [id, value] of entries) {
    if (!isHookId(id)) throw new Error(`invalid Hook id: ${id}`);
    const raw = fields(value, ['enabled', 'description', 'on', 'when', 'repeat', 'timeoutMs', 'actions', 'classify', 'onChoice'], id);
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error(`${id}.enabled must be boolean`);
    if (raw.description !== undefined) boundedText(raw.description, 500, `${id}.description`);
    if (raw.enabled === false && Object.keys(raw).every(key => key === 'enabled' || key === 'description')) {
      rules[id] = { enabled: false };
      continue;
    }
    if (raw.on !== 'before_agent_start' && raw.on !== 'tool_result') throw new Error(`${id}.on is not a Hook trigger`);
    const when = raw.when === undefined ? undefined : boundedText(raw.when, 4096, `${id}.when`);
    if (validateWhen && when !== undefined) {
      try { compileWhen(when, raw.on); }
      catch (error) { throw new Error(`${id}.when: ${error instanceof Error ? error.message : String(error)}`); }
    }
    let repeat: HookRepeat | undefined;
    if (raw.repeat !== undefined) {
      const terms = fields(raw.repeat, ['maxTriggers', 'cooldownTurns', 'resetOnCompaction'], `${id}.repeat`);
      const maxTriggers = optionalInteger(terms.maxTriggers, 100_000, `${id}.repeat.maxTriggers`);
      const cooldownTurns = optionalInteger(terms.cooldownTurns, 100_000, `${id}.repeat.cooldownTurns`);
      if (terms.resetOnCompaction !== undefined && typeof terms.resetOnCompaction !== 'boolean') {
        throw new Error(`${id}.repeat.resetOnCompaction must be boolean`);
      }
      if (maxTriggers === undefined && cooldownTurns === undefined) {
        if (terms.resetOnCompaction) throw new Error(`${id}.repeat must set maxTriggers or cooldownTurns`);
      } else {
        repeat = { ...(maxTriggers === undefined ? {} : { maxTriggers }), ...(cooldownTurns === undefined ? {} : { cooldownTurns }),
          ...(terms.resetOnCompaction ? { resetOnCompaction: true } : {}) };
      }
    }
    const timeoutMs = optionalInteger(raw.timeoutMs, 120_000, `${id}.timeoutMs`);
    const actions = actionsOf(raw.actions === undefined ? [] : raw.actions, `${id}.actions`);
    const classify = raw.classify === undefined ? undefined : classification(raw.classify, raw.on, `${id}.classify`);
    let onChoice: HookRule['onChoice'];
    if (raw.onChoice !== undefined) {
      if (classify?.kind !== 'choice') throw new Error(`${id}.onChoice requires classify.kind = 'choice'`);
      const mapped = fields(raw.onChoice, classify.choices, `${id}.onChoice`);
      const normalized: Record<string, readonly DeferredAction[]> = Object.create(null);
      for (const choice of classify.choices) {
        if (!Object.hasOwn(mapped, choice)) continue;
        const branch = actionsOf(mapped[choice], `${id}.onChoice.${choice}`);
        if (!branch.every(isDeferredAction)) throw new Error(`${id}.onChoice cannot injectSection`);
        normalized[choice] = branch;
      }
      if (Object.keys(normalized).length > 0) onChoice = normalized;
    }
    if (classify?.kind === 'choice' && actions.length > 0) throw new Error(`${id}: use onChoice for choice actions`);
    if (classify !== undefined && !actions.every(isDeferredAction)) throw new Error(`${id}: classify cannot injectSection`);
    if (actions.some(item => item.type === 'injectSection')
        && (raw.on !== 'before_agent_start' || actions.length !== 1 || repeat !== undefined || timeoutMs !== undefined)) {
      throw new Error(`${id}: injectSection needs a dedicated before_agent_start rule without repeat or timeoutMs`);
    }
    rules[id] = raw.enabled === false ? { enabled: false } : {
      on: raw.on, ...(when === undefined ? {} : { when }), ...(repeat === undefined ? {} : { repeat }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }), actions,
      ...(classify === undefined ? {} : { classify }), ...(onChoice === undefined ? {} : { onChoice }),
    };
  }
  return rules;
}

export const HOOK_CONFIG_VERSION = 1;

export class HookConfigError extends Error {
  readonly code: 'version_invalid' | 'layer_invalid';

  constructor(file: string, code: HookConfigError['code'], reason: string) {
    super(`${file}: ${reason}`);
    this.name = 'HookConfigError';
    this.code = code;
  }
}

export function validateHookDocument(file: string, value: unknown): HookRules {
  const document = requireConfigVersion(value, HOOK_CONFIG_VERSION);
  if (!document.ok) {
    if (document.reason === 'not_object') throw new HookConfigError(file, 'layer_invalid', 'top level must be a table');
    throw new HookConfigError(file, 'version_invalid', `version must be ${document.expected}. Run the offline config v1 migration for unversioned files.`);
  }
  try {
    fields(document.body, ['hooks'], 'config');
    return normalizeHookRules(document.body.hooks === undefined ? {} : document.body.hooks);
  } catch (error) {
    throw new HookConfigError(file, 'layer_invalid', error instanceof Error ? error.message : String(error));
  }
}

export function readHookLayer(file: string): { readonly rules: HookRules; readonly digest: string | null } {
  const document = readConfigDocument(file, 'toml');
  if (document.status === 'missing') return { rules: {}, digest: null };
  if (document.status !== 'ok') throw new HookConfigError(file, 'layer_invalid',
    document.error instanceof Error ? document.error.message : String(document.error));
  return { rules: validateHookDocument(file, document.value), digest: createHash('sha256').update(document.text).digest('hex') };
}

export class HookLayerError extends Error {
  readonly scope: ConfigScope;
  readonly code: HookConfigError['code'];

  constructor(scope: ConfigScope, error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'HookLayerError';
    this.scope = scope;
    this.code = error instanceof HookConfigError ? error.code : 'layer_invalid';
  }
}

export function readHookLayers(location: ConfigLocation) {
  const layers = { global: { rules: {} as HookRules, digest: null as string | null }, project: { rules: {} as HookRules, digest: null as string | null } };
  for (const { scope, path } of configPaths(location, 'hooks.toml', 'global-and-project')) {
    try { layers[scope] = readHookLayer(path); }
    catch (error) { throw new HookLayerError(scope, error); }
  }
  return layers;
}

export function mergeHookLayers(...layers: readonly HookRules[]): readonly (readonly [string, HookRule])[] {
  const merged = new Map<string, HookRule>();
  for (const layer of layers) {
    for (const [id, rule] of Object.entries(layer)) {
      if ('enabled' in rule) merged.delete(id);
      else merged.set(id, rule);
    }
  }
  return [...merged].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
