/** Resolve external Harness settings once per root, then share typed values. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { BudgetProfile } from './subagent/job-budget.ts';
import { promptString } from './prompt-text.ts';

export interface RoutingRetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}
export interface CapabilitySearchLimits {
  readonly tools: number;
  readonly mcp: number;
  readonly skills: number;
  readonly skillBodies: number;
  readonly requestTokens: number;
  readonly descriptionChars: number;
  readonly skillBodyChars: number;
}
export interface HarnessConfig {
  readonly subagent: {
    readonly maxDepth: number;
    readonly maxActiveChildren: number;
    readonly budgetsByDepth: Readonly<Record<number, BudgetProfile>>;
    readonly inheritedToolWaitMs: number;
    readonly routingRetry: RoutingRetryConfig;
    /** Resolved text, after applying global and trusted-project patches. */
    readonly prompts: { readonly common: string; readonly inherited: string };
  };
  readonly capability: {
    readonly noSelectionLimit: number;
    readonly budget: BudgetProfile;
    readonly search: {
      readonly bm25: { readonly k: number; readonly b: number; readonly d: number };
      readonly limits: CapabilitySearchLimits;
    };
  };
  readonly codemode: {
    readonly memoryLimitBytes: number;
    readonly defaultMaxOutputTokens: number;
  };
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  subagent: {
    maxDepth: 2,
    maxActiveChildren: 4,
    budgetsByDepth: {
      1: { modelCalls: { soft: 160, hard: 200 }, activeTimeMs: { soft: 5_400_000, hard: 7_200_000 }, lifetimeMs: 86_400_000 },
      2: { modelCalls: { soft: 48, hard: 64 }, activeTimeMs: { soft: 2_700_000, hard: 3_600_000 }, lifetimeMs: 43_200_000 },
    },
    inheritedToolWaitMs: 10_000,
    routingRetry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000, jitterRatio: 0.25 },
    prompts: { common: '', inherited: promptString('subagent-turns.json', 'inheritedContext') },
  },
  capability: {
    noSelectionLimit: 3,
    budget: { modelCalls: { soft: 16, hard: 20 }, activeTimeMs: { soft: 180_000, hard: 360_000 }, lifetimeMs: 600_000 },
    search: {
      bm25: { k: 0.9, b: 0.9, d: 0 },
      limits: { tools: 8, mcp: 8, skills: 6, skillBodies: 6, requestTokens: 128, descriptionChars: 240, skillBodyChars: 60_000 },
    },
  },
  codemode: { memoryLimitBytes: 256 * 1024 * 1024, defaultMaxOutputTokens: 10_000 },
};

export class HarnessConfigError extends Error {
  readonly source: string;
  readonly field: string;
  constructor(source: string, field: string, reason: string) {
    super(`${source}: ${field || 'config'} ${reason}`);
    this.name = 'HarnessConfigError';
    this.source = source;
    this.field = field;
  }
}

function object(value: unknown, source: string, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessConfigError(source, field, 'must be an object.');
  }
  return value as Record<string, unknown>;
}

function promptPatch(base: string, value: unknown, source: string, field: string): string {
  const patch = object(value, source, field);
  for (const key of Object.keys(patch)) {
    if (key !== 'replace' && key !== 'append') throw new HarnessConfigError(source, `${field}.${key}`, 'is unknown.');
    if (typeof patch[key] !== 'string') throw new HarnessConfigError(source, `${field}.${key}`, 'must be a string.');
  }
  const text = typeof patch.replace === 'string' ? patch.replace : base;
  const append = typeof patch.append === 'string' ? patch.append : '';
  return append === '' ? text : text === '' ? append : `${text}\n\n${append}`;
}

function numberValue(value: unknown, source: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HarnessConfigError(source, field, 'must be a finite number.');
  if (field.startsWith('capability.search.bm25.')) {
    if (value < 0 || (field.endsWith('.b') && value > 1)) throw new HarnessConfigError(source, field, 'is outside the BM25 range.');
  } else if (field === 'subagent.routingRetry.jitterRatio') {
    if (value < 0 || value > 1) throw new HarnessConfigError(source, field, 'must be between 0 and 1.');
  } else if (!Number.isSafeInteger(value) || value < 1) {
    throw new HarnessConfigError(source, field, 'must be a positive safe integer.');
  }
  return value;
}

function requireNewBudget(value: unknown, source: string, field: string): void {
  const profile = object(value, source, field);
  for (const key of ['modelCalls', 'activeTimeMs', 'lifetimeMs']) {
    if (!Object.hasOwn(profile, key)) throw new HarnessConfigError(source, `${field}.${key}`, 'is required for a new depth.');
  }
  for (const key of ['modelCalls', 'activeTimeMs']) {
    const limit = object(profile[key], source, `${field}.${key}`);
    for (const bound of ['soft', 'hard']) {
      if (!Object.hasOwn(limit, bound)) throw new HarnessConfigError(source, `${field}.${key}.${bound}`, 'is required for a new depth.');
    }
  }
}

/** Last layer index that wrote each field path, so later relations blame the right file. */
type FieldOrigins = Map<string, number>;

/** The default shape is also the field schema; special nodes are explicit. */
function mergeNode(base: object, value: unknown, source: string, field: string, origins: FieldOrigins, layer: number): Record<string, unknown> {
  const patch = object(value, source, field);
  const merged: Record<string, unknown> = { ...base };
  for (const [key, item] of Object.entries(patch)) {
    const child = field === '' ? key : `${field}.${key}`;
    if (field === 'subagent.budgetsByDepth') {
      const depth = /^[1-9][0-9]*$/.test(key) ? Number(key) : Number.NaN;
      if (!Number.isSafeInteger(depth)) throw new HarnessConfigError(source, child, 'must name a positive integer depth.');
      const previous = merged[key];
      if (previous === undefined) requireNewBudget(item, source, child);
      const profile = previous === undefined ? DEFAULT_HARNESS_CONFIG.subagent.budgetsByDepth[1]! : object(previous, source, child);
      merged[key] = mergeNode(profile, item, source, child, origins, layer);
    } else if (!Object.hasOwn(merged, key)) {
      throw new HarnessConfigError(source, child, 'is unknown.');
    } else {
      const previous = merged[key];
      if (field === 'subagent.prompts') merged[key] = promptPatch(previous as string, item, source, child);
      else if (typeof previous === 'number') merged[key] = numberValue(item, source, child);
      else merged[key] = mergeNode(previous as object, item, source, child, origins, layer);
    }
    origins.set(child, layer);
  }
  return merged;
}

/**
 * Layers compose before they are judged: a global value may be completed by a
 * trusted project value. Relations are therefore checked once on the final
 * snapshot, and each violation is attributed to the last layer that touched
 * either side of the relation.
 */
function validateRelations(config: HarnessConfig, origins: FieldOrigins, sources: readonly string[]): void {
  const layerOf = (field: string): number => {
    for (let current = field; ;) {
      const found = origins.get(current);
      if (found !== undefined) return found;
      const dot = current.lastIndexOf('.');
      if (dot < 0) return -1;
      current = current.slice(0, dot);
    }
  };
  const fail = (fields: readonly string[], field: string, reason: string): never => {
    const layer = Math.max(...fields.map(layerOf));
    throw new HarnessConfigError(layer < 0 ? sources.at(-1) ?? '' : sources[layer]!, field, reason);
  };
  const budget = (profile: BudgetProfile, field: string): void => {
    for (const key of ['modelCalls', 'activeTimeMs'] as const) {
      if (profile[key].soft > profile[key].hard) {
        fail([`${field}.${key}.hard`, `${field}.${key}.soft`], `${field}.${key}.hard`, 'must be at least soft.');
      }
    }
  };
  budget(config.capability.budget, 'capability.budget');
  for (const [depth, profile] of Object.entries(config.subagent.budgetsByDepth)) {
    budget(profile, `subagent.budgetsByDepth.${depth}`);
  }
  for (let depth = 1; depth <= config.subagent.maxDepth; depth++) {
    if (!config.subagent.budgetsByDepth[depth]) {
      fail(['subagent.maxDepth'], `subagent.budgetsByDepth.${depth}`, 'is required by subagent.maxDepth.');
    }
  }
  const retry = config.subagent.routingRetry;
  if (retry.maxDelayMs < retry.baseDelayMs) {
    fail(['subagent.routingRetry.maxDelayMs', 'subagent.routingRetry.baseDelayMs'], 'subagent.routingRetry.maxDelayMs', 'must be at least baseDelayMs.');
  }
}

export interface HarnessConfigLayer { readonly value: unknown; readonly source: string }

/** Apply text patches in layer order, rather than merging patch objects. */
export function resolveHarnessConfig(layers: readonly HarnessConfigLayer[] = []): HarnessConfig {
  let config = DEFAULT_HARNESS_CONFIG;
  const origins: FieldOrigins = new Map();
  for (const [index, layer] of layers.entries()) {
    config = mergeNode(config, layer.value, layer.source, '', origins, index) as unknown as HarnessConfig;
  }
  validateRelations(config, origins, layers.map((layer) => layer.source));
  return config;
}

export interface LoadHarnessConfigOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly projectTrusted: boolean;
}

export function loadHarnessConfig({ cwd, agentDir, projectTrusted }: LoadHarnessConfigOptions): HarnessConfig {
  const files = [path.join(agentDir, 'harness.json'), ...(projectTrusted ? [path.join(cwd, '.pi', 'harness.json')] : [])];
  const layers: HarnessConfigLayer[] = [];
  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new HarnessConfigError(file, '', 'must contain valid JSON.'); }
    layers.push({ source: file, value });
  }
  return resolveHarnessConfig(layers);
}

export type HarnessConfigProvider = (ctx: ExtensionContext) => HarnessConfig;
const providers = new WeakMap<ExtensionAPI, HarnessConfigProvider>();

/** One provider per SDK surface; child surfaces receive their root's snapshot. */
export function harnessConfigFor(pi: ExtensionAPI, fixed?: HarnessConfig): HarnessConfigProvider {
  const existing = providers.get(pi);
  if (existing) return existing;
  let cached: HarnessConfig | undefined = fixed;
  const provider: HarnessConfigProvider = fixed
    ? () => fixed
    : (ctx) => cached ??= loadHarnessConfig({ cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() });
  if (!fixed) {
    const reset = (): void => { cached = undefined; };
    pi.on('session_start', reset);
    pi.on('session_tree', reset);
    pi.on('session_shutdown', reset);
  }
  providers.set(pi, provider);
  return provider;
}
