/**
 * Capability resource references.
 *
 * A ref is the identity of one discoverable resource in branch memory, search
 * results and request projection. The same encoding is used everywhere, so a
 * manually enabled tool and a searched tool share one ref namespace instead of
 * inventing a second identity scheme.
 */

/** `scheme://<encoded name>`; the name is the only variable part. */
export const capabilityRef = (scheme: string, name: string): string => `${scheme}://${encodeURIComponent(name)}`;

/** One tool's ref. A namespace member keeps its own tool ref. */
export const toolRef = (name: string): string => capabilityRef('tool', name);

/** One MCP server, optionally narrowed to a member tool. */
export const mcpRef = (server: string, tool?: string): string =>
  capabilityRef('mcp', server) + (tool ? `/${encodeURIComponent(tool)}` : '');
