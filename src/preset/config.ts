/**
 * Model preset configuration: file loading, schema validation and merge.
 *
 * A preset is a named bundle of model, thinking level, tool selection, codemode
 * declaration mode and model-specific instructions. This module only reads and
 * validates configuration; it never touches a session, a model or a tool. Every
 * consumer receives a fresh, frozen catalog so a later edit to the source file
 * cannot mutate a snapshot an apply already captured.
 *
 * Two files are layered, matching Pi's native preset/`defaultTools` convention:
 * the global `presets.toml` under the agent directory, and a project
 * `.pi/presets.toml` under the working directory. A project entry whose name
 * matches a global entry replaces it wholesale; presets are never field-merged
 * across layers, so a project preset cannot inherit a surprising half of a
 * global one.
 *
 * Malformed entries are tracked separately from missing names so an applied
 * snapshot can keep running and report why it cannot be updated.
 */

import { configPaths, readConfigDocument, requireConfigVersion, type ConfigLocation } from '../config-storage.ts';
import { normalizeHookRules, type HookRules } from '../hooks/config.ts';

/** Thinking levels Pi understands, including `off`. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** How codemode presents tools; mirrors Pie's `Settings.codemode.mode`. */
export const CODEMODE_MODES = ['on', 'only'] as const;
export type CodemodeMode = (typeof CODEMODE_MODES)[number];

/** A concrete model identity; never a URL or a header bag. */
export interface PresetModel {
  readonly provider: string;
  readonly id: string;
}

/** One validated preset. Every field is optional; an empty preset is valid. */
export interface PresetConfig {
  readonly description?: string;
  readonly model?: PresetModel;
  readonly thinkingLevel?: ThinkingLevelName;
  /** Native `+name`/`-name` (and plain-name) tool modifiers. */
  readonly tools?: readonly string[];
  readonly codemode?: { readonly mode: CodemodeMode };
  readonly instructions?: string;
  readonly hooks?: HookRules;
}

/** The merged, name-keyed preset catalog. */
export type PresetCatalog = ReadonlyMap<string, PresetConfig>;

/** A parsed-but-invalid entry is dropped and described by its warnings. */
export interface LoadedPresets {
  readonly presets: PresetCatalog;
  readonly warnings: readonly string[];
  readonly invalidNames: ReadonlySet<string>;
  readonly invalidDocument: boolean;
}

/** Read one config file, returning `undefined` when it does not exist. */
export type PresetFileReader = (filePath: string) => string | undefined;

export interface LoadPresetsOptions extends ConfigLocation {
  /** Test seam; defaults to the real filesystem. */
  readonly read?: PresetFileReader;
}

/** A malformed top-level presets document. */
export class PresetConfigError extends Error {
  readonly source: string;

  constructor(source: string, reason: string) {
    super(`${source}: ${reason}`);
    this.name = 'PresetConfigError';
    this.source = source;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isThinkingLevel(value: unknown): value is ThinkingLevelName {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isCodemodeMode(value: unknown): value is CodemodeMode {
  return typeof value === 'string' && (CODEMODE_MODES as readonly string[]).includes(value);
}

/**
 * Validate one raw preset object.
 *
 * Returns the normalized preset, or the list of reasons it is unusable. A preset
 * carrying any invalid field is rejected as a whole rather than partially
 * applied, so an apply never silently drops one of the author's intent fields.
 */
export function validatePreset(raw: unknown): { preset: PresetConfig } | { errors: readonly string[] } {
  if (!isRecord(raw)) return { errors: ['preset must be an object'] };
  const errors: string[] = [];
  const known = new Set(['description', 'model', 'thinkingLevel', 'tools', 'codemode', 'instructions', 'hooks']);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) errors.push(`unknown field "${key}"`);
  }

  let description: string | undefined;
  if (raw['description'] !== undefined) {
    if (typeof raw['description'] !== 'string') errors.push('description must be a string');
    else description = raw['description'];
  }

  let model: PresetModel | undefined;
  if (raw['model'] !== undefined) {
    const value = raw['model'];
    if (!isRecord(value)) errors.push('model must be an object');
    else if (!nonEmptyString(value['provider']) || !nonEmptyString(value['id'])) {
      errors.push('model.provider and model.id must be non-empty strings');
    } else {
      model = { provider: value['provider'], id: value['id'] };
    }
  }

  let thinkingLevel: ThinkingLevelName | undefined;
  if (raw['thinkingLevel'] !== undefined) {
    if (!isThinkingLevel(raw['thinkingLevel'])) {
      errors.push(`thinkingLevel must be one of ${THINKING_LEVELS.join(', ')}`);
    } else thinkingLevel = raw['thinkingLevel'];
  }

  let tools: readonly string[] | undefined;
  if (raw['tools'] !== undefined) {
    const value = raw['tools'];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      errors.push('tools must be an array of strings');
    } else tools = [...value];
  }

  let codemode: { mode: CodemodeMode } | undefined;
  if (raw['codemode'] !== undefined) {
    const value = raw['codemode'];
    if (!isRecord(value) || !isCodemodeMode(value['mode'])) {
      errors.push(`codemode.mode must be one of ${CODEMODE_MODES.join(', ')}`);
    } else codemode = { mode: value['mode'] };
  }

  let instructions: string | undefined;
  if (raw['instructions'] !== undefined) {
    if (typeof raw['instructions'] !== 'string') errors.push('instructions must be a string');
    else instructions = raw['instructions'];
  }

  let hooks: HookRules | undefined;
  if (raw.hooks !== undefined) {
    try {
      const normalized = normalizeHookRules(raw.hooks);
      if (Object.keys(normalized).length > 0) hooks = normalized;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) return { errors };
  return {
    preset: {
      ...(description === undefined ? {} : { description }),
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(tools === undefined ? {} : { tools }),
      ...(codemode === undefined ? {} : { codemode }),
      ...(instructions === undefined ? {} : { instructions }),
      ...(hooks === undefined ? {} : { hooks }),
    },
  };
}

export const PRESET_CONFIG_VERSION = 1;

/** Validate one presets document into a name-keyed map plus warnings. */
export function validatePresetDocument(source: string, document: unknown): {
  catalog: Map<string, PresetConfig>; warnings: string[]; invalidNames: Set<string>;
} {
  const versioned = requireConfigVersion(document, PRESET_CONFIG_VERSION);
  if (!versioned.ok) {
    if (versioned.reason === 'not_object') throw new PresetConfigError(source, 'top level must be a table');
    throw new PresetConfigError(source, `version must be ${versioned.expected}. Run the offline config v1 migration for unversioned files.`);
  }
  for (const key of Object.keys(versioned.body)) {
    if (key !== 'presets') throw new PresetConfigError(source, `unknown top-level key: ${key}`);
  }
  const presets = versioned.body.presets === undefined ? {} : versioned.body.presets;
  if (!isRecord(presets)) throw new PresetConfigError(source, 'presets must be a table');
  const catalog = new Map<string, PresetConfig>();
  const invalidNames = new Set<string>();
  const warnings: string[] = [];
  for (const [name, raw] of Object.entries(presets)) {
    if (!nonEmptyString(name)) {
      warnings.push(`${source}: ignoring an empty preset name`);
      continue;
    }
    const result = validatePreset(raw);
    if ('errors' in result) {
      invalidNames.add(name);
      warnings.push(`${source}: preset "${name}" skipped: ${result.errors.join('; ')}`);
      continue;
    }
    catalog.set(name, result.preset);
  }
  return { catalog, warnings, invalidNames };
}

/**
 * Load and merge global and project presets.
 *
 * Project entries replace same-named global entries. The returned maps and the
 * preset arrays inside them are freshly built, so callers may hold them without
 * observing later file edits.
 */
export function loadPresets(options: LoadPresetsOptions): LoadedPresets {
  const presets = new Map<string, PresetConfig>();
  const invalidNames = new Set<string>();
  const warnings: string[] = [];
  let invalidDocument = false;
  const load = (filePath: string): void => {
    try {
      const document = readConfigDocument(filePath, 'toml', options.read);
      if (document.status === 'missing') return;
      if (document.status === 'read_error') throw document.error;
      if (document.status === 'parse_error') throw new PresetConfigError(filePath,
        `invalid TOML (${document.error instanceof Error ? document.error.message : String(document.error)})`);
      const parsed = validatePresetDocument(filePath, document.value);
      warnings.push(...parsed.warnings);
      for (const name of parsed.invalidNames) {
        presets.delete(name);
        invalidNames.add(name);
      }
      for (const [name, preset] of parsed.catalog) {
        invalidNames.delete(name);
        presets.set(name, preset);
      }
    } catch (error) {
      invalidDocument = true;
      // An unreadable higher-priority document may shadow any lower name.
      presets.clear();
      invalidNames.clear();
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  };

  for (const { path } of configPaths(options, 'presets.toml', 'global-and-project')) load(path);
  return { presets, warnings, invalidNames, invalidDocument };
}
