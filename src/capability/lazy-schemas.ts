/**
 * Lazy schema refs for Capability.
 *
 * A user may name whole MCP servers or namespaces whose parameter and return
 * schemas are withheld from the model while Codemode runs in `only` mode. The
 * model still sees member names and can read one interface through Codemode's
 * `describeTool` / `describeNamespace`. This module only translates the config
 * refs into group membership and answers whether the lazy projection is active;
 * the Codemode loadout and the result projection decide what a match means.
 *
 * Refs reuse the shared capability identity scheme: `mcp://<server>` (an exact
 * member ref narrows to its server) and `namespace://<name>`. Unknown schemes
 * are ignored so a stray value can never match unrelated tools, matching the
 * load-time rule that only rejects empty entries.
 */

import { effectiveCodemodeMode } from './codemode-mode.ts';

/** The namespace metadata a tool carries, as group matching needs it. */
export interface LazySchemaNamespace {
  readonly name: string;
  readonly aliases?: readonly string[] | undefined;
}

/** Parsed lazy refs. `empty` short-circuits every match. */
export interface LazySchemaRefs {
  readonly mcpServers: ReadonlySet<string>;
  readonly namespaces: ReadonlySet<string>;
  /** Retained valid refs, in config order. */
  readonly refs: readonly string[];
  readonly empty: boolean;
}

const MCP_SCHEME = 'mcp://';
const NAMESPACE_SCHEME = 'namespace://';

function decode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Parse the configured refs once per operation; invalid entries are skipped. */
export function parseLazySchemaRefs(refs: readonly string[] | undefined): LazySchemaRefs {
  const mcpServers = new Set<string>();
  const namespaces = new Set<string>();
  const kept: string[] = [];
  for (const raw of refs ?? []) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith(MCP_SCHEME)) {
      const rest = decode(trimmed.slice(MCP_SCHEME.length));
      if (rest === null) continue;
      const server = rest.split('/', 1)[0] ?? '';
      if (server === '') continue;
      mcpServers.add(server);
      kept.push(trimmed);
    } else if (trimmed.startsWith(NAMESPACE_SCHEME)) {
      const name = decode(trimmed.slice(NAMESPACE_SCHEME.length));
      if (name === null || name === '') continue;
      namespaces.add(name);
      kept.push(trimmed);
    }
  }
  return { mcpServers, namespaces, refs: kept, empty: mcpServers.size === 0 && namespaces.size === 0 };
}

/**
 * Whether one tool's owning group is a configured lazy group.
 *
 * MCP membership follows the same server matching used for enablement: the
 * namespace name (`mcp__<server>`), its aliases, or the tool prefix, so a
 * project that set a bare server alias still matches. A namespace ref matches
 * the namespace name or any alias.
 */
export function matchesLazySchemaRef(
  refs: LazySchemaRefs,
  toolName: string,
  namespace: LazySchemaNamespace | undefined,
): boolean {
  if (refs.empty || namespace === undefined) return false;
  const nsName = namespace.name;
  const aliases = namespace.aliases ?? [];
  if (refs.namespaces.has(nsName) || aliases.some((alias) => refs.namespaces.has(alias))) return true;
  for (const server of refs.mcpServers) {
    if (nsName === server || nsName === `mcp__${server}` || aliases.includes(server)) return true;
    if (nsName.startsWith('mcp__') && toolName.startsWith(`mcp__${server}__`)) return true;
  }
  return false;
}

/** The host surface activation needs; an ExtensionAPI satisfies it. */
export interface LazySchemaHost {
  getActiveTools(): readonly string[];
  getSettings?(): { readonly codemode?: { readonly mode?: string } | undefined } | undefined;
}

/**
 * Lazy projection applies only while Codemode is the active tool and the effective
 * mode is `only`. The effective mode is a preset's recorded override on the
 * branch when present, otherwise the Settings value. Any other state (Codemode
 * off, effective `on`, missing branch/settings) leaves the refs inert.
 */
export function lazySchemasActive(host: LazySchemaHost, branch?: readonly unknown[] | null): boolean {
  if (!host.getActiveTools().includes('codemode')) return false;
  let settingsMode: string | undefined;
  try {
    settingsMode = host.getSettings?.()?.codemode?.mode;
  } catch {
    return false;
  }
  return effectiveCodemodeMode(branch, settingsMode) === 'only';
}
