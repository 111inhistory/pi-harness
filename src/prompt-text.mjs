import { readFileSync } from 'node:fs';

/** Read a repository-owned UTF-8 prompt asset verbatim. Callers supply fixed file names. */
export function promptText(name) {
  return readFileSync(new URL(`../prompts/${name}`, import.meta.url), 'utf8');
}
