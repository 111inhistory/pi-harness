/**
 * One operation's tool-admission view.
 *
 * Direct declarations, direct execution and Codemode all need the same answer:
 * may this session use this tool right now? The answer combines four facts —
 * the scope chain, the branch's capability records, the active set and the
 * user's manual enablement. This module resolves them once per operation and
 * returns per-name predicates, so a loop over tools neither re-walks the
 * ancestor chain nor re-scans the branch for every name.
 *
 * The view is a value for one synchronous operation. It is never cached across
 * requests, never invalidated and holds no authority of its own: every caller
 * still reads the current branch and registry, exactly like
 * `createCapabilityScopeView`.
 *
 * Entry points keep their own differences. A direct call also needs the tool
 * declared or active, Codemode additionally needs its own exposure, and a
 * resource read needs a selected server; only the shared rule lives here.
 */

import { discoveryRecords } from './discovery-record.ts';
import {
  createCapabilityScopeView,
  type CapabilityRootOnlyPolicy,
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
   * Declaration rule: not a disabled native tool, selected on the branch when it
   * is an MCP tool, and manual-authorized.
   *
   * Scope is deliberately absent. A role denial closes execution; it does not
   * rewrite what the branch selected or what the transcript declared, so a
   * denial added later must not silently shrink the recorded loadout.
   */
  readonly declares: (name: string) => boolean;
  /** Execution rule: the declaration rule plus current scope qualification. */
  readonly admits: (name: string) => boolean;
  /** The manual-authorization part alone, for a precise refusal reason. */
  readonly admitsManual: (name: string) => boolean;
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

/** What the branch records, resolved in one pass over its capability entries. */
export interface BranchSelection {
  /** Names the branch records as selected, including manual enablement. */
  readonly selected: ReadonlySet<string>;
  /** Names with explicit user authorization on the branch. */
  readonly manual: ReadonlySet<string>;
}

/**
 * One pass over the branch records yields both sets.
 *
 * The user command reads the same view, so "already recorded" and "authorized"
 * cannot drift into two different answers.
 */
export function branchToolSelection(branch: readonly unknown[] | null | undefined): BranchSelection {
  const selected = new Set<string>();
  const manual = new Set<string>();
  for (const record of discoveryRecords(branch)) {
    for (const category of ['tools', 'mcp', 'manual'] as const) {
      for (const hit of record.result[category] ?? []) {
        if (hit.status && hit.status !== 'available') continue;
        for (const member of hit.tools ?? [hit]) {
          if (typeof member.name !== 'string' || member.name === '') continue;
          selected.add(member.name);
          if (category === 'manual') manual.add(member.name);
        }
      }
    }
  }
  return { selected, manual };
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
): ToolAdmission {
  const scope = createCapabilityScopeView(host);
  const { selected, manual } = branchToolSelection(branch);
  const active = new Set(host.getActiveTools());
  const tools = host.getAllTools();
  const rootOnly: CapabilityRootOnlyPolicy | null = scope.rootOnly;

  // Manual tools belong to the root session and require the user's own record;
  // an active state or a discovered grant is not authority.
  const admitsManual = (name: string): boolean =>
    rootOnly === null || !rootOnly(name) || (scope.root && manual.has(name));
  const declares = (name: string): boolean =>
    !isNativeDiscoveryTool(name) &&
    (!isMcpExecutionTool(name) || selected.has(name)) &&
    admitsManual(name);
  const admits = (name: string): boolean => declares(name) && scope.allows(name);
  const admitsServer = (server: unknown): boolean => {
    if (typeof server !== 'string' || server === '') return false;
    return tools.some((tool) => selected.has(tool.name) && active.has(tool.name) &&
      tool.exposure !== 'hidden' && tool.exposure !== 'model-only' &&
      scope.allows(tool.name) && admitsManual(tool.name) &&
      tool.name.startsWith('mcp__') && tool.namespace?.name.startsWith('mcp__') &&
      tool.namespace.aliases?.includes(server) === true);
  };
  return { declares, admits, admitsManual, admitsServer };
}
