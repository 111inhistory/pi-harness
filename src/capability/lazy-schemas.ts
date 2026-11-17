/**
 * No-schema projection refs and planning for Capability.
 *
 * A user may withhold parameter and return schemas from the model while Codemode
 * runs in `only` mode. The model still sees member names and can read one
 * interface through Codemode's `describeTool` / `describeNamespace`. Two inputs
 * request that projection:
 *
 * - configured `capability.lazySchemas` refs, a default policy: whole MCP
 *   servers, whole namespaces, or one exact tool through `tool://<name>`;
 * - an explicit target-local selection modifier (`tool_a[lazy]` /
 *   `tool_a[no-lazy]`, or a container default for its selected members) stored
 *   by the tool-access records, replayed by its owner and supplied here as a
 *   per-tool mode.
 *
 * This module owns the single projection calculation. It never caches, never
 * writes authority state, and never decides registration, membership or
 * permission; the Codemode loadout and the result projection only consume its
 * answer for the current operation.
 *
 * Refs reuse the shared capability identity scheme: `mcp://<server>` (an exact
 * member ref narrows to its server), `namespace://<name>`, and
 * `tool://<exact name>`. Unknown schemes are ignored so a stray value can never
 * match unrelated tools, matching the load-time rule that only rejects empty
 * entries.
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
  /** Exact tool names requested through `tool://<name>`. */
  readonly tools: ReadonlySet<string>;
  /** Retained valid refs, in config order. */
  readonly refs: readonly string[];
  readonly empty: boolean;
}

const MCP_SCHEME = 'mcp://';
const NAMESPACE_SCHEME = 'namespace://';
const TOOL_SCHEME = 'tool://';

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
  const tools = new Set<string>();
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
    } else if (trimmed.startsWith(TOOL_SCHEME)) {
      const name = decode(trimmed.slice(TOOL_SCHEME.length));
      if (name === null || name === '') continue;
      tools.add(name);
      kept.push(trimmed);
    }
  }
  return {
    mcpServers,
    namespaces,
    tools,
    refs: kept,
    empty: mcpServers.size === 0 && namespaces.size === 0 && tools.size === 0,
  };
}

/**
 * Whether one tool's owning group is a configured lazy group, or the exact tool
 * itself is named by a `tool://` ref.
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
  if (refs.empty) return false;
  if (refs.tools.has(toolName)) return true;
  if (namespace === undefined) return false;
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

/** The registry facts one projection pass needs. */
export interface NoSchemaTool {
  readonly name: string;
  readonly exposure?: string | undefined;
  readonly namespace?: LazySchemaNamespace | undefined;
}

/** The recorded per-tool selection mode; `null` means no explicit record. */
export type ToolSchemaMode = 'no-schema' | 'schema';

/**
 * The branch selection input. A function instead of a materialized set keeps one
 * replay/view per operation and avoids carrying wide mutable snapshots through
 * unrelated callers.
 */
export interface NoSchemaSelection {
  readonly mode: (name: string) => ToolSchemaMode | null;
}

/** Why a requested no-schema tool is not withheld right now. */
export type NoSchemaInactiveReason = 'codemode_unavailable' | 'mode_not_only' | 'model_only';

/**
 * One operation's no-schema projection.
 *
 * `requested` is the policy request (config or an explicit selection, after a
 * `[no-lazy]` override). `withheld` is what is actually applied now and is
 * therefore the only set a declaration projection may consume. `inactive` names
 * the requested tools that cannot be withheld, with the reason, so a caller can
 * report the difference instead of silently declaring them with a schema.
 */
export interface NoSchemaPlan {
  readonly active: boolean;
  readonly requested: ReadonlySet<string>;
  readonly withheld: ReadonlySet<string>;
  readonly inactive: ReadonlyMap<string, NoSchemaInactiveReason>;
}

export interface NoSchemaPlanInput {
  readonly host: LazySchemaHost;
  readonly branch?: readonly unknown[] | null;
  readonly refs: readonly string[];
  readonly selection: NoSchemaSelection;
  /** One registry snapshot for this operation; the caller already has it. */
  readonly tools: readonly NoSchemaTool[];
  /**
   * Whether Codemode has a usable call path now (active, requested, eligible).
   * Omit when the caller has not narrowed it; another `getActiveTools` read is
   * then used only for the active check.
   */
  readonly codemodeUsable?: boolean;
}

interface ProjectionGate {
  readonly active: boolean;
  readonly reason: 'codemode_unavailable' | 'mode_not_only' | null;
}

/** The effective gate: active Codemode, mode `only`, and a usable call path. */
function projectionGate(
  host: LazySchemaHost,
  branch: readonly unknown[] | null | undefined,
  codemodeUsable: boolean | undefined,
): ProjectionGate {
  if (!host.getActiveTools().includes('codemode')) {
    return { active: false, reason: 'codemode_unavailable' };
  }
  let settingsMode: string | undefined;
  try {
    settingsMode = host.getSettings?.()?.codemode?.mode;
  } catch {
    return { active: false, reason: 'codemode_unavailable' };
  }
  if (effectiveCodemodeMode(branch, settingsMode) !== 'only') {
    return { active: false, reason: 'mode_not_only' };
  }
  if (codemodeUsable === false) {
    return { active: false, reason: 'codemode_unavailable' };
  }
  return { active: true, reason: null };
}

/**
 * Lazy projection applies only while Codemode is the active tool and the effective
 * mode is `only`. The effective mode is a preset's recorded override on the
 * branch when present, otherwise the Settings value. Any other state (Codemode
 * off, effective `on`, missing branch/settings) leaves the refs inert.
 */
export function lazySchemasActive(host: LazySchemaHost, branch?: readonly unknown[] | null): boolean {
  return projectionGate(host, branch, undefined).active;
}

/**
 * Compute the one no-schema projection for an operation.
 *
 * A `[no-lazy]` selection overrides a configured default for that exact tool.
 * Model-only tools are never withheld: they cannot be called through Codemode,
 * and hiding their declaration would strand them. The function reads the
 * supplied catalog once and performs no registry or branch read of its own
 * beyond the gate's settings/active check.
 */
export function planNoSchema(input: NoSchemaPlanInput): NoSchemaPlan {
  const refs = parseLazySchemaRefs(input.refs);
  const gate = projectionGate(input.host, input.branch, input.codemodeUsable);
  const requested = new Set<string>();
  const withheld = new Set<string>();
  const inactive = new Map<string, NoSchemaInactiveReason>();
  for (const tool of input.tools) {
    const mode = input.selection.mode(tool.name);
    const wanted = mode === 'schema'
      ? false
      : mode === 'no-schema' || matchesLazySchemaRef(refs, tool.name, tool.namespace);
    if (!wanted) continue;
    requested.add(tool.name);
    if (tool.exposure === 'model-only') {
      inactive.set(tool.name, 'model_only');
      continue;
    }
    if (!gate.active) {
      inactive.set(tool.name, gate.reason ?? 'codemode_unavailable');
      continue;
    }
    withheld.add(tool.name);
  }
  return { active: gate.active, requested, withheld, inactive };
}
