/**
 * The user-facing capability catalog.
 *
 * `/capability list` reads one current view:
 * one eligible-tool read, one classification, one filter and one stable order.
 * The view is a value for one command; it is not cached, it grants nothing, and
 * it never starts retrieval.
 *
 * Categories partition the catalog: an MCP tool is only `mcp`, a non-MCP
 * namespace member is only `namespace`, everything else is `tool`. Skills are
 * not part of this entry; Pi's own skill handling is enough.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isNativeDiscoveryTool } from './admission.ts';
import { capabilityRootOnlyPolicy } from './scope.ts';
import { createEligibleToolCatalog } from './tool-catalog.ts';

export type CapabilityCategory = 'tool' | 'mcp' | 'namespace';

/** Category order and headings, stable across sessions. */
export const CATEGORY_ORDER: readonly CapabilityCategory[] = ['tool', 'mcp', 'namespace'];
export const CATEGORY_LABEL: Readonly<Record<CapabilityCategory, string>> = {
  tool: 'Tools',
  mcp: 'MCP servers',
  namespace: 'Namespaces',
};

/** One selectable tool with everything the list and the picker show. */
export interface CapabilityCatalogEntry {
  readonly name: string;
  /** Name without its namespace prefix, for humans. */
  readonly display: string;
  readonly description: string;
  readonly category: CapabilityCategory;
  /** MCP server or namespace the tool belongs to; `Tools` for plain tools. */
  readonly group: string;
  readonly active: boolean;
  /** Listed as manual-only: browsable, but only the user command may enable it. */
  readonly manual: boolean;
}

export interface CapabilityCatalogGroup {
  readonly group: string;
  readonly entries: readonly CapabilityCatalogEntry[];
}

export interface CapabilityCatalogSection {
  readonly category: CapabilityCategory;
  readonly groups: readonly CapabilityCatalogGroup[];
}

export interface CapabilityCatalogView {
  /** Every entry after filtering, in display order. */
  readonly entries: readonly CapabilityCatalogEntry[];
  /** Non-empty sections and groups, in display order. */
  readonly sections: readonly CapabilityCatalogSection[];
}

export interface CapabilityCatalogOptions {
  readonly category?: CapabilityCategory;
  /** Case-insensitive text over name, description and group. */
  readonly filter?: string;
}

const NATIVE_MCP_TOOLS = new Set(['read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates']);

function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__') || NATIVE_MCP_TOOLS.has(name);
}

function stripNamespace(name: string, namespace: string | undefined): string {
  if (namespace !== undefined && name.startsWith(`${namespace}__`)) return name.slice(namespace.length + 2);
  return name;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })
    || left.localeCompare(right);
}

/**
 * The one filter rule for `list` and the picker: case-insensitive text over the
 * tool name, display name, full description and group. Display truncation never
 * feeds this predicate.
 */
export function capabilityEntryMatches(entry: CapabilityCatalogEntry, needle: string): boolean {
  if (needle === '') return true;
  return entry.name.toLowerCase().includes(needle)
    || entry.display.toLowerCase().includes(needle)
    || entry.description.toLowerCase().includes(needle)
    || entry.group.toLowerCase().includes(needle);
}

/** Read the current catalog once and classify it. */
export function createCapabilityCatalog(
  pi: ExtensionAPI,
  options: CapabilityCatalogOptions = {},
): CapabilityCatalogView {
  const catalog = createEligibleToolCatalog(pi, { includeManual: true });
  const rootOnly = capabilityRootOnlyPolicy(pi);
  const active = new Set(pi.getActiveTools());
  const needle = (options.filter ?? '').trim().toLowerCase();
  const entries = catalog.tools
    // Disabled native discovery tools can never execute; listing them would
    // offer an activation that the execution guard always refuses.
    .filter((tool) => !isNativeDiscoveryTool(tool.name))
    .map((tool): CapabilityCatalogEntry => {
      const namespace = tool.namespace?.name;
      const mcp = isMcpTool(tool.name);
      const category: CapabilityCategory = mcp ? 'mcp' : namespace === undefined ? 'tool' : 'namespace';
      const group = mcp
        ? tool.namespace?.aliases?.[0] ?? namespace?.replace(/^mcp__/, '') ?? 'MCP'
        : namespace ?? 'Tools';
      return {
        name: tool.name,
        display: stripNamespace(tool.name, namespace),
        description: typeof tool.description === 'string' ? tool.description : '',
        category,
        group,
        active: active.has(tool.name),
        manual: rootOnly?.(tool.name) === true,
      };
    })
    .filter((entry) => options.category === undefined || entry.category === options.category)
    .filter((entry) => capabilityEntryMatches(entry, needle))
    .sort((left, right) => CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category)
      || compareText(left.group, right.group)
      || compareText(left.display, right.display)
      || compareText(left.name, right.name));

  const sections: CapabilityCatalogSection[] = [];
  for (const category of CATEGORY_ORDER) {
    const groups: CapabilityCatalogGroup[] = [];
    for (const entry of entries) {
      if (entry.category !== category) continue;
      const last = groups.at(-1);
      if (last !== undefined && last.group === entry.group) {
        groups[groups.length - 1] = { group: last.group, entries: [...last.entries, entry] };
      } else {
        groups.push({ group: entry.group, entries: [entry] });
      }
    }
    if (groups.length > 0) sections.push({ category, groups });
  }
  return { entries, sections };
}
