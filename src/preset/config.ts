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
 * the global `presets.json` under the agent directory, and a project
 * `.pi/presets.json` under the working directory. A project entry whose name
 * matches a global entry replaces it wholesale; presets are never field-merged
 * across layers, so a project preset cannot inherit a surprising half of a
 * global one.
 *
 * Validation is total but lenient per entry: one malformed preset is skipped
 * with a warning and the rest still load, because a typo in one preset must not
 * make every other preset unusable. A malformed top-level document (not an
 * object) is a hard error because there is nothing left to salvage.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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
}

/** The merged, name-keyed preset catalog. */
export type PresetCatalog = ReadonlyMap<string, PresetConfig>;

/** A parsed-but-invalid entry is dropped and described by its warnings. */
export interface LoadedPresets {
  readonly presets: PresetCatalog;
  readonly warnings: readonly string[];
}

/** Read one config file, returning `undefined` when it does not exist. */
export type PresetFileReader = (filePath: string) => string | undefined;

export interface LoadPresetsOptions {
  readonly cwd: string;
  readonly agentDir: string;
  /** A project `.pi/presets.json` loads only when the project is trusted. */
  readonly projectTrusted: boolean;
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

const defaultReader: PresetFileReader = (filePath) =>
  existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
function validatePreset(raw: unknown): { preset: PresetConfig } | { errors: readonly string[] } {
  if (!isRecord(raw)) return { errors: ['preset must be an object'] };
  const errors: string[] = [];
  const known = new Set(['description', 'model', 'thinkingLevel', 'tools', 'codemode', 'instructions']);
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

  if (errors.length > 0) return { errors };
  return {
    preset: {
      ...(description === undefined ? {} : { description }),
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(tools === undefined ? {} : { tools }),
      ...(codemode === undefined ? {} : { codemode }),
      ...(instructions === undefined ? {} : { instructions }),
    },
  };
}

/** Parse and validate one presets document into a name-keyed map plus warnings. */
function parseDocument(source: string, text: string): { catalog: Map<string, PresetConfig>; warnings: string[] } {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new PresetConfigError(source, `invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isRecord(document)) throw new PresetConfigError(source, 'top level must be an object');
  const catalog = new Map<string, PresetConfig>();
  const warnings: string[] = [];
  for (const [name, raw] of Object.entries(document)) {
    if (!nonEmptyString(name)) {
      warnings.push(`${source}: ignoring an empty preset name`);
      continue;
    }
    const result = validatePreset(raw);
    if ('errors' in result) {
      warnings.push(`${source}: preset "${name}" skipped: ${result.errors.join('; ')}`);
      continue;
    }
    catalog.set(name, result.preset);
  }
  return { catalog, warnings };
}

/**
 * Load and merge global and project presets.
 *
 * Project entries replace same-named global entries. The returned maps and the
 * preset arrays inside them are freshly built, so callers may hold them without
 * observing later file edits.
 */
export function loadPresets(options: LoadPresetsOptions): LoadedPresets {
  const read = options.read ?? defaultReader;
  const warnings: string[] = [];
  const load = (filePath: string): Map<string, PresetConfig> => {
    const text = read(filePath);
    if (text === undefined) return new Map();
    try {
      const parsed = parseDocument(filePath, text);
      warnings.push(...parsed.warnings);
      return parsed.catalog;
    } catch (error) {
      if (error instanceof PresetConfigError) {
        warnings.push(error.message);
        return new Map();
      }
      throw error;
    }
  };

  const globalPath = path.join(options.agentDir, 'presets.json');
  const globalCatalog = load(globalPath);
  const projectPath = path.join(options.cwd, '.pi', 'presets.json');
  const projectCatalog = options.projectTrusted ? load(projectPath) : new Map<string, PresetConfig>();

  const merged = new Map<string, PresetConfig>(globalCatalog);
  for (const [name, preset] of projectCatalog) merged.set(name, preset);
  return { presets: merged, warnings };
}
