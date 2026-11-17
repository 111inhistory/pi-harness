/**
 * Tool target parsing and matching.
 *
 * A target is the user-visible way to name one or more registered tools in a
 * base, dynamic or blacklist record: an exact tool name, `mcp://server`,
 * `namespace://name`, or (config only) a `foo*` prefix. The grammar grants
 * nothing and holds no policy: the tool-access domain decides which collection
 * a target belongs to and which precedence applies.
 *
 * Targets are stored as the user wrote them (trimmed), so a group rule keeps
 * covering members that register after the record was written. Matching is a
 * pure read of the current registry.
 */

/** What one target names. `prefix` exists only for config patterns. */
export type ToolTargetKind = 'tool' | 'mcp' | 'namespace' | 'prefix';

/** One parsed target. */
export interface ToolTarget {
  readonly target: string;
  readonly kind: ToolTargetKind;
  readonly name: string;
  readonly id: string;
}

/** The registered tool shape matching needs. */
export interface ToolTargetRecord {
  readonly name: string;
  readonly description?: string | undefined;
  readonly namespace?: {
    readonly name: string;
    readonly aliases?: readonly string[];
    readonly description?: string | undefined;
    readonly instructions?: string | undefined;
  } | undefined;
  readonly exposure?: string | undefined;
}

function makeTarget(kind: ToolTargetKind, name: string, target: string): ToolTarget {
  return { target, kind, name, id: `${kind}:${name}` };
}

function decodeAfter(raw: string, scheme: string): string | null {
  try {
    return decodeURIComponent(raw.slice(scheme.length));
  } catch {
    return null;
  }
}

const MCP_SCHEME = 'mcp://';
const NAMESPACE_SCHEME = 'namespace://';

/**
 * Parse one writable target.
 *
 * A bare trailing `*` is a prefix target, so config patterns and explicit
 * records share one grammar. Schemes stay explicit groups; an empty name is
 * rejected instead of matching everything.
 */
export function parseToolTarget(raw: string): ToolTarget | null {
  const target = raw.trim();
  if (target === '') return null;
  // `[ns]` and a leading `-` are selection syntax, never persisted target text.
  if (target.includes('[') || target.includes(']') || target.startsWith('-')) return null;
  if (target.endsWith('*') && !target.includes('://')) {
    const prefix = target.slice(0, -1);
    return prefix === '' ? null : makeTarget('prefix', prefix, target);
  }
  const lower = target.toLowerCase();
  if (lower.startsWith(MCP_SCHEME)) {
    const server = decodeAfter(target, target.slice(0, MCP_SCHEME.length));
    return server === null || server.trim() === '' ? null : makeTarget('mcp', server, target);
  }
  if (lower.startsWith(NAMESPACE_SCHEME)) {
    const name = decodeAfter(target, target.slice(0, NAMESPACE_SCHEME.length));
    return name === null || name.trim() === '' ? null : makeTarget('namespace', name, target);
  }
  return makeTarget('tool', target, target);
}

function matchesServer(tool: ToolTargetRecord | undefined, server: string, name: string): boolean {
  const namespace = tool?.namespace;
  if (namespace !== undefined) {
    if (namespace.name === `mcp__${server}` || namespace.name === server) return true;
    if (namespace.aliases?.includes(server) === true) return true;
    if (namespace.name.startsWith('mcp__') && name.startsWith(`mcp__${server}__`)) return true;
  }
  return name === `mcp__${server}` || name.startsWith(`mcp__${server}__`);
}

function matchesNamespace(tool: ToolTargetRecord | undefined, namespace: string, name: string): boolean {
  const own = tool?.namespace;
  if (own !== undefined) {
    if (own.name === namespace || own.name === `mcp__${namespace}`) return true;
    if (own.aliases?.includes(namespace) === true) return true;
    if (own.name.startsWith('mcp__') && own.name.slice('mcp__'.length) === namespace) return true;
  }
  return name.startsWith(`${namespace}__`) || name.startsWith(`mcp__${namespace}__`);
}

/** Whether one parsed target names this registered tool or tool name. */
export function matchesToolTarget(entry: ToolTarget, tool: ToolTargetRecord | undefined, name: string): boolean {
  switch (entry.kind) {
    case 'tool': return name === entry.name;
    case 'mcp': return matchesServer(tool, entry.name, name);
    case 'namespace': return matchesNamespace(tool, entry.name, name);
    case 'prefix': return name.startsWith(entry.name);
  }
}
