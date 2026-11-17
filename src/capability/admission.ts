/**
 * One operation's tool-admission view.
 *
 * Direct declarations, direct execution and Codemode all need the same answer:
 * may this session use this tool right now? The answer combines the scope
 * chain, the branch's BASE/DYNAMIC/BLACKLIST collections, the active set and
 * the SDK's own selection.
 *
 * The view is a value for one synchronous operation. It is never cached across
 * requests, never invalidated and holds no authority of its own: every caller
 * still reads the current branch and registry, exactly like
 * `createCapabilityScopeView`.
 *
 * Declarations and execution are two questions. A blacklisted tool is blocked
 * from execution immediately, but an already-active independent declaration is
 * kept until the next successful compaction, so removing it never rewrites the
 * provider prefix mid-window. Base and dynamic membership are availability, not
 * authorization grants: only the blacklist and the role/depth/scope denials
 * can remove a name from a child.
 */

import { discoveryRecords, prunedToolNames } from './discovery-record.ts';
import { createToolAccessView } from './tool-access-view.ts';
import {
  createCapabilityScopeView,
  type CapabilityScopeView,
  type CapabilityScopedTool,
  type CapabilityToolCatalog,
} from './scope.ts';

/** Native discovery surfaces this harness disables as executable tools. */
const DISABLED_NATIVE = new Set(['tool_search', 'list_mcp_resources', 'list_mcp_resource_templates']);

export function isNativeDiscoveryTool(name: string): boolean {
  return DISABLED_NATIVE.has(name);
}

/** Tools whose execution depends on an MCP selection recorded on the branch. */
export function isMcpExecutionTool(name: string): boolean {
  return name.startsWith('mcp__') || name === 'read_mcp_resource';
}

/** The admission answers of one operation. */
export interface ToolAdmission {
  /**
   * Declaration rule: not a disabled native tool, still selected while it is an
   * MCP tool, in scope, not pruned, and not newly blacklisted. A blacklisted
   * tool that is still active keeps its existing declaration until compaction.
   */
  readonly declares: (name: string) => boolean;
  /**
   * Execution rule: the declaration rule, not blacklisted, and not awaiting a
   * completed removal. A retained declaration is not permission: a tool whose
   * base/dynamic membership was removed stops executing now even though its
   * declaration stays until the next compaction. A name this surface never
   * managed (for example a child session's own loadout) is not blocked.
   */
  readonly admits: (name: string) => boolean;
  /** Raw stored blacklist fact, for display. */
  readonly blacklisted: (name: string) => boolean;
  /** Effective prohibition after the base override; authority uses this. */
  readonly blocked: (name: string) => boolean;
  /** Whether base or dynamic membership requests `name` and no blacklist blocks it. */
  readonly requested: (name: string) => boolean;
  /** Whether a selected, active MCP member of `server` qualifies a resource read. */
  readonly admitsServer: (server: unknown) => boolean;
}

/** The registered tool metadata admission needs. */
export interface AdmissionTool extends CapabilityScopedTool {
  readonly namespace?: { readonly name: string; readonly aliases?: readonly string[] } | undefined;
}

/** The host surface admission reads; an ExtensionAPI satisfies it. */
export interface AdmissionHost extends CapabilityToolCatalog {
  getAllTools(): readonly AdmissionTool[];
  getActiveTools(): readonly string[];
}

/** What the branch records for discovery selection. */
export interface BranchSelection {
  /** Names the branch records as discovered/selected by discovery memory. */
  readonly selected: ReadonlySet<string>;
}

/**
 * One pass over the branch records yields discovered tool names.
 *
 * Retired legacy permission records are not scanned; the discovery memory and
 * the BASE/DYNAMIC/BLACKLIST records are the only sources.
 */
export function branchToolSelection(branch: readonly unknown[] | null | undefined): BranchSelection {
  const selected = new Set<string>();
  for (const record of discoveryRecords(branch)) {
    for (const category of ['tools', 'mcp'] as const) {
      for (const hit of record.result[category] ?? []) {
        if (hit.status && hit.status !== 'available') continue;
        for (const member of hit.tools ?? [hit]) {
          if (typeof member.name !== 'string' || member.name === '') continue;
          selected.add(member.name);
        }
      }
    }
  }
  return { selected };
}

/**
 * Resolve one operation's admission.
 *
 * `host` is the session's tool catalog; `branch` is its current branch. Both are
 * read now, so a later activation or record change needs a new view.
 */
export function createToolAdmission(
  host: AdmissionHost,
  branch: readonly unknown[] | null | undefined,
  catalog?: { readonly scope: CapabilityScopeView; readonly tools: readonly AdmissionTool[] },
): ToolAdmission {
  const scope = catalog?.scope ?? createCapabilityScopeView(host);
  // One registry snapshot per operation: an already-read catalog is reused, and
  // a caller without one pays exactly one read.
  const tools = catalog?.tools ?? host.getAllTools();
  const access = createToolAccessView(host, branch, tools, scope);
  const pruned = prunedToolNames(branch);
  const active = new Set(host.getActiveTools());
  const blacklisted = access.blacklisted;
  const blocked = access.blocked;
  const requested = access.requested;
  const declares = (name: string): boolean => {
    if (isNativeDiscoveryTool(name)) return false;
    // Scope is an execution check, not a declaration rewrite: a role denial must
    // not drop an already-published declaration (provider prefix stability).
    // A configured or preset blacklist is session-start policy: its declaration
    // goes at once. A branch blacklist is a mid-session user action, so an
    // already-active declaration is kept until compaction (execution is already
    // blocked) instead of rewriting the provider prefix.
    if (blocked(name)) return access.blacklistSources(name).includes('branch') && active.has(name);
    if (isMcpExecutionTool(name) && !requested(name)) return false;
    if (!pruned.has(name)) return true;
    // A prune removes dynamic membership; a base membership or a later
    // activate/base-add is a newer deliberate availability choice, so it
    // overrides the prune boundary without rewriting the discovery memory.
    return access.base(name) || access.requested(name);
  };
  const removalPending = access.removalPending;
  const admits = (name: string): boolean =>
    !blocked(name) &&
    scope.allows(name) &&
    declares(name) &&
    (requested(name) || !removalPending(name));
  const admitsServer = (server: unknown): boolean => {
    if (typeof server !== 'string' || server === '') return false;
    return tools.some((tool) => requested(tool.name) && active.has(tool.name) &&
      !blocked(tool.name) &&
      tool.exposure !== 'hidden' && tool.exposure !== 'model-only' &&
      scope.allows(tool.name) &&
      tool.name.startsWith('mcp__') && tool.namespace?.name.startsWith('mcp__') &&
      tool.namespace.aliases?.includes(server) === true);
  };
  return { declares, admits, blacklisted, blocked, requested, admitsServer };
}
