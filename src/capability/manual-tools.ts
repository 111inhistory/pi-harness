/**
 * Permission target parsing and matching.
 *
 * This module owns the user-visible target grammar (`tool`, `mcp://server`,
 * `namespace://name`) and the config-only prefix form (`foo*`). It grants
 * nothing and holds no policy: the permission domain decides which parsed
 * target wins.
 *
 * A bare trailing `*` is a prefix target, shared by config defaults, canonical
 * records and reset; schemes stay explicit groups. It grants nothing by itself.
 */

/** What a target names. `prefix` exists only for config defaults. */
export type ToolPermissionKind = 'tool' | 'mcp' | 'namespace' | 'prefix';

/** One parsed target. */
export interface ToolPermissionTarget {
  readonly target: string;
  readonly kind: ToolPermissionKind;
  readonly name: string;
  readonly id: string;
}

/** The registered tool shape matching needs. */
export interface ToolPermissionTool {
  readonly name: string;
  readonly namespace?: { readonly name: string; readonly aliases?: readonly string[] } | undefined;
  readonly exposure?: string | undefined;
}

function makeTarget(kind: ToolPermissionKind, name: string, target: string): ToolPermissionTarget {
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

/** Parse one writable target: exact tool name, `mcp://server`, or `namespace://name`. */
export function parseToolPermissionTarget(raw: string): ToolPermissionTarget | null {
  const target = raw.trim();
  if (target === '') return null;
  // One prefix grammar is shared by config defaults, canonical records and
  // reset: a bare trailing `*` is a prefix target; schemes stay explicit groups.
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

function matchesServer(tool: ToolPermissionTool | undefined, server: string, name: string): boolean {
  const namespace = tool?.namespace;
  if (namespace !== undefined) {
    if (namespace.name === `mcp__${server}` || namespace.name === server) return true;
    if (namespace.aliases?.includes(server) === true) return true;
    if (namespace.name.startsWith('mcp__') && name.startsWith(`mcp__${server}__`)) return true;
  }
  return name === `mcp__${server}` || name.startsWith(`mcp__${server}__`);
}

function matchesNamespace(tool: ToolPermissionTool | undefined, namespace: string, name: string): boolean {
  const own = tool?.namespace;
  if (own !== undefined) {
    if (own.name === namespace || own.name === `mcp__${namespace}`) return true;
    if (own.aliases?.includes(namespace) === true) return true;
    if (own.name.startsWith('mcp__') && own.name.slice('mcp__'.length) === namespace) return true;
  }
  return name.startsWith(`${namespace}__`) || name.startsWith(`mcp__${namespace}__`);
}

/** Whether one parsed entry names this registered tool or name. */
export function matchesEntry(entry: ToolPermissionTarget, tool: ToolPermissionTool | undefined, name: string): boolean {
  switch (entry.kind) {
    case 'tool': return name === entry.name;
    case 'mcp': return matchesServer(tool, entry.name, name);
    case 'namespace': return matchesNamespace(tool, entry.name, name);
    case 'prefix': return name.startsWith(entry.name);
  }
}
