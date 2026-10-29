import { readFileSync } from 'node:fs';

/** Read a repository-owned UTF-8 prompt asset verbatim. Callers supply fixed file names. */
export function promptText(name) {
  return readFileSync(new URL(`../prompts/${name}`, import.meta.url), 'utf8');
}

/** Read a named JSON string without trimming or changing its model-facing text. */
export function promptString(name, field) {
  const asset = JSON.parse(promptText(name));
  if (asset === null || typeof asset !== 'object' || Array.isArray(asset) ||
      !Object.hasOwn(asset, field) || typeof asset[field] !== 'string') {
    throw new TypeError(`${name} must define string ${field}.`);
  }
  return asset[field];
}
