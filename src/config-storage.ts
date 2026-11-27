import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

export type ConfigScope = 'global' | 'project';
export interface ConfigLocation {
  readonly agentDir: string;
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

export function configPaths(location: ConfigLocation, filename: string, scope: 'global-only' | 'global-and-project'):
readonly { readonly scope: ConfigScope; readonly path: string }[] {
  return [
    { scope: 'global', path: path.join(location.agentDir, filename) },
    ...(scope === 'global-and-project' && location.projectTrusted
      ? [{ scope: 'project' as const, path: path.join(location.cwd, '.pi', filename) }]
      : []),
  ];
}

export type ConfigDocument =
  | { readonly status: 'missing' }
  | { readonly status: 'ok'; readonly text: string; readonly value: unknown }
  | { readonly status: 'read_error'; readonly error: unknown }
  | { readonly status: 'parse_error'; readonly error: unknown };

export function readConfigDocument(filePath: string, codec: 'json' | 'toml',
  read: (filePath: string) => string | undefined = file => readFileSync(file, 'utf8')): ConfigDocument {
  let text: string | undefined;
  try { text = read(filePath); }
  catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? { status: 'missing' } : { status: 'read_error', error };
  }
  if (text === undefined) return { status: 'missing' };
  try { return { status: 'ok', text, value: codec === 'json' ? JSON.parse(text) as unknown : parseToml(text) }; }
  catch (error) { return { status: 'parse_error', error }; }
}

export type ConfigVersion =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly reason: 'not_object' | 'missing_version' | 'unsupported_version'; readonly expected: number };

export function requireConfigVersion(value: unknown, expected: number): ConfigVersion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return { ok: false, reason: 'not_object', expected };
  }
  if (!Object.hasOwn(value, 'version')) return { ok: false, reason: 'missing_version', expected };
  const { version, ...body } = value as Record<string, unknown>;
  return version === expected ? { ok: true, body } : { ok: false, reason: 'unsupported_version', expected };
}
