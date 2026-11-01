import { readFileSync } from 'node:fs';

const texts = new Map<string, string>();
const assets = new Map<string, Record<string, unknown>>();

/** Read a repository-owned asset verbatim. Names are fixed by the caller. */
export function promptText(name: string): string {
  let text = texts.get(name);
  if (text === undefined) {
    text = readFileSync(new URL(`../prompts/${name}`, import.meta.url), 'utf8');
    texts.set(name, text);
  }
  return text;
}

/** Parse each prompt asset once; field getters narrow its external JSON values. */
export function promptAsset(name: string): Readonly<Record<string, unknown>> {
  let asset = assets.get(name);
  if (asset === undefined) {
    const value: unknown = JSON.parse(promptText(name));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${name} must define a JSON object.`);
    }
    asset = value as Record<string, unknown>;
    assets.set(name, asset);
  }
  return asset;
}

export function promptField(name: string, ...fields: readonly string[]): unknown {
  let value: unknown = promptAsset(name);
  for (const field of fields) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, field)) {
      throw new TypeError(`${name} must define ${fields.join('.')}.`);
    }
    value = (value as Record<string, unknown>)[field];
  }
  return value;
}

export function promptString(name: string, ...fields: readonly string[]): string {
  const value = promptField(name, ...fields);
  if (typeof value !== 'string') throw new TypeError(`${name} must define string ${fields.join('.')}.`);
  return value;
}

export function promptStrings(name: string, ...fields: readonly string[]): readonly string[] {
  const value = promptField(name, ...fields);
  if (!Array.isArray(value) || !value.every((entry: unknown): entry is string => typeof entry === 'string')) {
    throw new TypeError(`${name} must define string array ${fields.join('.')}.`);
  }
  return value;
}

/** Replace `{key}` placeholders in prompt text with caller-supplied values. */
export function fillPrompt(text: string, values: Readonly<Record<string, string | number>>): string {
  let filled = text;
  for (const [key, value] of Object.entries(values)) {
    filled = filled.replaceAll(`{${key}}`, String(value));
  }
  const missing = filled.match(/\{[a-z][a-z0-9_]*\}/);
  if (missing) throw new TypeError(`Prompt placeholder ${missing[0]} has no value.`);
  return filled;
}
