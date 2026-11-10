/**
 * One operation's tool-admission view.
 *
 * Direct declarations, direct execution and Codemode all need the same answer:
 * may this session use this tool right now? The answer combines the scope chain,
 * the branch's capability records, the active set and the three-state permission
 * (explicitly enabled / explicitly disabled / unmanaged).
 *
 * The view is a value for one synchronous operation. It is never cached across
 * requests, never invalidated and holds no authority of its own: every caller
 * still reads the current branch and registry, exactly like
 * `createCapabilityScopeView`.
 *
 * A disabled tool stops execution and Codemode access immediately, but its
 * recorded native declaration is kept until the next successful compaction, so
 * the declaration removal is a compaction concern while the execution hook
 * already blocks it. An enabled tool is root-only: a child scope never admits
 * it, and the root filters it from child parent catalogs.
 */

import { discoveryRecords, prunedToolNames } from './discovery-record.ts';
import { createToolPermissionResolver } from './tool-permission.ts';
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
   * Declaration rule: not a disabled native tool, selected on the branch when it
   * is an MCP tool (or explicitly enabled), and not pruned.
   *
   * A disabled tool is deliberately not excluded here: its independent native
   * declaration is removed at the next successful compaction, while `admits`
   * blocks it now.
   */
  readonly declares: (name: string) => boolean;
  /** Execution rule: the declaration rule, scope qualification and not disabled. */
  readonly admits: (name: string) => boolean;
  /** Whether the effective permission prohibits `name` right now. */
  readonly disabled: (name: string) => boolean;
  /** Whether the effective permission explicitly enables `name`. */
  readonly enabled: (name: string) => boolean;
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
  /** Names the branch records as discovered/selected, including legacy manual. */
  readonly selected: ReadonlySet<string>;
  /** Legacy manual names; retained for preset retention, not execution authority. */
  readonly manual: ReadonlySet<string>;
}

/**
 * One pass over the branch records yields both sets.
 *
 * `manual` is legacy only (the three-state permission module migrates it to
 * `enabled`); `selected` keeps the discovery selection the MCP rule needs.
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
  catalog?: { readonly scope: CapabilityScopeView; readonly tools: readonly AdmissionTool[] },
): ToolAdmission {
  const scope = catalog?.scope ?? createCapabilityScopeView(host);
  const { selected } = branchToolSelection(branch);
  const pruned = prunedToolNames(branch);
  const active = new Set(host.getActiveTools());
  const tools = catalog?.tools ?? host.getAllTools();
  const permission = createToolPermissionResolver(host, tools, branch);
  const disabled = permission.disabled;
  const enabled = permission.enabled;
  // A `manualTools` seed is disabled from the start: it is pruned from the
  // declaration immediately. An explicit/migrated disable keeps an already-active
  // independent declaration until the next successful compaction; `admits`
  // already blocks it.
  const seedDisabled = permission.seedDisabled;
  const deferredDisabled = (name: string): boolean => disabled(name) && !seedDisabled(name);
  const mcpSelected = (name: string): boolean => selected.has(name) || enabled(name);
  const declares = (name: string): boolean =>
    !seedDisabled(name) &&
    !isNativeDiscoveryTool(name) &&
    (!isMcpExecutionTool(name) || mcpSelected(name)) &&
    (!pruned.has(name) || enabled(name)) &&
    (!enabled(name) || scope.root) &&
    (!deferredDisabled(name) || active.has(name));
  const admits = (name: string): boolean =>
    !disabled(name) && declares(name) && scope.allows(name) && (!enabled(name) || scope.root);
  const admitsServer = (server: unknown): boolean => {
    if (typeof server !== 'string' || server === '') return false;
    return tools.some((tool) => mcpSelected(tool.name) && active.has(tool.name) &&
      !disabled(tool.name) && (!enabled(tool.name) || scope.root) &&
      tool.exposure !== 'hidden' && tool.exposure !== 'model-only' &&
      scope.allows(tool.name) &&
      tool.name.startsWith('mcp__') && tool.namespace?.name.startsWith('mcp__') &&
      tool.namespace.aliases?.includes(server) === true);
  };
  return { declares, admits, disabled, enabled, admitsServer };
}
