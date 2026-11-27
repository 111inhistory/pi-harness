import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { parseToolTarget } from '../capability/targets.ts';
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

export interface HookRule {
  readonly on: HookTrigger;
  readonly when?: string;
  readonly repeat?: HookRepeat;
  readonly timeoutMs?: number;
  readonly actions: readonly HookAction[];
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

export function normalizeHookRules(value: unknown, validateWhen = true): HookRules {
  const entries = Object.entries(table(value, 'hooks')).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.length > 32) throw new Error('a Hook layer may define at most 32 rules');
  const rules: Record<string, HookRules[string]> = Object.create(null);
  for (const [id, value] of entries) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error(`invalid Hook id: ${id}`);
    const raw = fields(value, ['enabled', 'description', 'on', 'when', 'repeat', 'timeoutMs', 'actions'], id);
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
    const rawActions = raw.actions ?? [];
    if (!Array.isArray(rawActions) || rawActions.length > 8) throw new Error(`${id}.actions must be an array of at most 8 actions`);
    const actions = rawActions.map((item: unknown, index) => action(item, `${id}.actions.${index}`));
    if (actions.some(item => item.type === 'injectSection')
        && (raw.on !== 'before_agent_start' || actions.length !== 1 || repeat !== undefined || timeoutMs !== undefined)) {
      throw new Error(`${id}: injectSection needs a dedicated before_agent_start rule without repeat or timeoutMs`);
    }
    rules[id] = raw.enabled === false ? { enabled: false } : {
      on: raw.on, ...(when === undefined ? {} : { when }), ...(repeat === undefined ? {} : { repeat }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }), actions,
    };
  }
  return rules;
}

export function readHookLayer(directory: string): HookRules {
  const file = path.join(directory, 'hooks.toml');
  try {
    return normalizeHookRules(parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
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
