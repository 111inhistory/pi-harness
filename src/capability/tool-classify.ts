/**
 * Display classification shared by the catalog and the tool-access listing.
 *
 * Categories partition registered tools: an MCP tool is only `mcp`, a non-MCP
 * namespace member is only `namespace`, everything else is `tool`. Display and
 * group names are for humans; they never take part in matching or authority.
 */

/** Human-facing category of one registered tool. */
export type ToolCategory = 'tool' | 'mcp' | 'namespace';

const NATIVE_MCP_TOOLS = new Set(['read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates']);

/** Whether a name belongs to the native MCP surface. */
export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__') || NATIVE_MCP_TOOLS.has(name);
}

/** One tool's display classification. */
export interface ToolClassification {
  readonly category: ToolCategory;
  /** Name without its namespace prefix, for humans. */
  readonly display: string;
  /** MCP server or namespace the tool belongs to; `Tools` for plain tools. */
  readonly group: string;
}

function stripNamespace(name: string, namespace: string | undefined): string {
  if (namespace !== undefined && name.startsWith(`${namespace}__`)) return name.slice(namespace.length + 2);
  return name;
}

/** Classify one registered tool for listing; hidden tools are classified too. */
export function classifyTool(tool: {
  readonly name: string;
  readonly namespace?: { readonly name: string; readonly aliases?: readonly string[] } | undefined;
}): ToolClassification {
  const namespace = tool.namespace?.name;
  if (isMcpTool(tool.name)) {
    return {
      category: 'mcp',
      display: stripNamespace(tool.name, namespace),
      group: tool.namespace?.aliases?.[0] ?? namespace?.replace(/^mcp__/, '') ?? 'MCP',
    };
  }
  return {
    category: namespace === undefined ? 'tool' : 'namespace',
    display: stripNamespace(tool.name, namespace),
    group: namespace ?? 'Tools',
  };
}
