import {
  createMcpExtension,
  type ExtensionAPI,
  type ExtensionContext,
  type McpExtensionOptions,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { discoveryRecords } from './discovery-record.ts';
import { installCapabilityCodemode } from './codemode.ts';
import { createCapabilityScopeView } from './scope.ts';
import { promptString } from '../prompt-text.ts';

const text = {
  disabledDescription: promptString('native-discovery.json', 'disabledDescription'),
  codemodeFallback: promptString('native-discovery.json', 'codemodeFallback'),
  resourceReadRequirement: promptString('native-discovery.json', 'resourceReadRequirement'),
};

const DISABLED = new Set(['tool_search', 'list_mcp_resources', 'list_mcp_resource_templates']);

export function isNativeDiscoveryTool(name: string): boolean {
  return DISABLED.has(name);
}

function isMcpExecutionTool(name: string): boolean {
  return name.startsWith('mcp__') || name === 'read_mcp_resource';
}

/** Read selection from canonical branch records, never from a process-wide allowlist. */
function selectedNames(ctx: ExtensionContext): Set<string> {
  const names = new Set<string>();
  for (const result of discoveryRecords(ctx.sessionManager.getBranch()).map((record) => record.result)) {
    for (const category of ['tools', 'mcp'] as const) {
      for (const hit of result[category]) {
        if (hit.status && hit.status !== 'available') continue;
        for (const member of hit.tools ?? [hit]) {
          if (typeof member.name === 'string') names.add(member.name);
        }
      }
    }
  }
  return names;
}

function selectedServer(pi: ExtensionAPI, ctx: ExtensionContext, server: unknown): boolean {
  if (typeof server !== 'string') return false;
  const selected = selectedNames(ctx);
  const active = new Set(pi.getActiveTools());
  const view = createCapabilityScopeView(pi);
  return pi.getAllTools().some((tool) => selected.has(tool.name) && active.has(tool.name) &&
    tool.exposure !== 'hidden' && tool.exposure !== 'model-only' && view.allows(tool.name) && tool.name.startsWith('mcp__') &&
    tool.namespace?.name.startsWith('mcp__') && tool.namespace.aliases?.includes(server));
}

/** Disable discovery as executable tools, not just as prompt recommendations. */
export function installNativeDiscoveryBoundary(pi: ExtensionAPI): () => ReadonlySet<string> {
  let currentContext: ExtensionContext | undefined;
  pi.on('session_start', (_event, ctx) => { currentContext = ctx; });
  pi.on('session_shutdown', () => { currentContext = undefined; });
  // Pi's replaceable built-ins are omitted when these names are already owned.
  // Hidden exposure also prevents setActiveTools() from restoring tool_search.
  for (const name of ['tool_search']) {
    pi.registerTool({
      name,
      label: 'Disabled native discovery',
      description: text.disabledDescription,
      exposure: 'hidden',
      defaultActive: false,
      parameters: { type: 'object', properties: {} },
      execute: async () => { throw new Error(`${name} is disabled; use capability.`); },
    });
  }

  const permits = (ctx: ExtensionContext, name: string) => !isNativeDiscoveryTool(name) &&
    createCapabilityScopeView(pi).allows(name) &&
    (!isMcpExecutionTool(name) || selectedNames(ctx).has(name));
  const declaredTools = installCapabilityCodemode(pi, permits, (name) => currentContext
    ? permits(currentContext, name)
    : !isNativeDiscoveryTool(name) && !isMcpExecutionTool(name));

  pi.on('tool_call', (event, ctx) => {
    if (isNativeDiscoveryTool(event.toolName)) {
      return { block: true, reason: `${event.toolName} is disabled; use capability.` };
    }
    if (isMcpExecutionTool(event.toolName) &&
        (!selectedNames(ctx).has(event.toolName) || !pi.getActiveTools().includes(event.toolName))) {
      return { block: true, reason: 'This MCP tool has not been selected and activated by Capability on this branch.' };
    }
    if (event.toolName === 'read_mcp_resource' && !selectedServer(pi, ctx, event.input['server'])) {
      return { block: true, reason: 'Reading resources requires a selected, enabled MCP server permitted in the current scope.' };
    }
    return undefined;
  });

  pi.on('before_agent_start', (event, ctx) => {
    currentContext = ctx;
    const selected = selectedNames(ctx);
    const allowed = (name: string) => !isNativeDiscoveryTool(name) && (!isMcpExecutionTool(name) || selected.has(name));
    const active = pi.getActiveTools();
    const next = active.filter(allowed);
    if (next.length !== active.length) pi.setActiveTools(next);
    event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(allowed);
    delete event.systemPromptOptions.sections['mcp_servers'];
  });

  pi.on('context_with_system', (event, ctx) => {
    currentContext = ctx;
    const selected = selectedNames(ctx);
    const allowed = (name: string) => !isNativeDiscoveryTool(name) && (!isMcpExecutionTool(name) || selected.has(name));
    // Old branch checkpoints can contain catalogs/declarations from before this
    // boundary was installed. Filter structured state, not arbitrary user text.
    const messages = event.messages.map((message) => {
      if (message.role !== 'system') return message;
      const sections = { ...message.sections };
      delete sections['mcp_servers'];
      return {
        ...message,
        sections,
        ...(message.toolsAdded ? { toolsAdded: message.toolsAdded.filter((tool) => allowed(tool.name)).map((tool) => {
          // Old native Codemode snapshots embed a catalog inside this retained
          // declaration. Filtering separate MCP declarations is not enough.
          if (tool.name !== 'codemode' || !/\bsearchTools\b|\bmcp__/.test(tool.description)) return tool;
          const current = pi.getAllTools().find((entry) => entry.name === 'codemode');
          return { ...tool, description: current?.description ?? text.codemodeFallback };
        }) } : {}),
        ...(message.toolsRemoved ? { toolsRemoved: message.toolsRemoved.filter((tool) => allowed(tool.name)) } : {}),
      };
    });
    return { messages };
  });
  return declaredTools;
}

function executionTool<TParams extends ToolDefinition['parameters'], TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
  const scoped: ToolDefinition<TParams, TDetails, TState> = {
    ...tool, defaultActive: false,
    exposure: tool.exposure === 'hidden' || isNativeDiscoveryTool(tool.name) ? 'hidden' : 'deferred',
  };
  if (tool.name !== 'read_mcp_resource') return scoped;
  return {
    ...scoped,
    description: `${tool.description}\n${text.resourceReadRequirement}`,
    async execute(...args) {
      try { return await tool.execute(...args); }
      catch (error) {
        // Pi's unsupported-server diagnostic lists all resource-enabled servers.
        // Do not expose that catalog through an approved generic reader.
        if (error instanceof Error && error.message.includes('Servers with resources:')) {
          throw new Error('No readable resources are available from the selected MCP server.');
        }
        throw error;
      }
    },
  };
}

/**
 * Reuse Pi's MCP transport, authentication, /mcp UI and tool pipeline. Only its
 * discovery surface is disabled: no directory hook, no default declarations,
 * and no global resource-listing tools. Owning /mcp replaces the CLI built-in,
 * preventing a second connection manager from running beside this one.
 */
export function installCapabilityMcp(pi: ExtensionAPI, options: McpExtensionOptions = {}): void {
  const backendContext = <T extends ExtensionContext>(ctx: T): T => {
    // The native backend does not know Capability can activate tools without
    // either discovery entry. Correct only its owned unreachable-tools warning.
    const ui = new Proxy(Object.create(ctx.ui) as typeof ctx.ui, { get(_facade, key) {
      const target = ctx.ui;
      if (key === 'notify') return (message: string, level?: 'info' | 'warning' | 'error') => {
        const obsolete = message.startsWith('MCP tools are only reachable from the codemode or tool_search tool, but neither is active');
        target.notify(obsolete ? 'Use capability to select MCP tools before calling them.' : message, obsolete ? 'info' : level);
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return new Proxy(ctx, { get(target, key) {
      if (key === 'ui') return ui;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const adapter: ExtensionAPI = {
    ...pi,
    registerCommand: (name, command) => pi.registerCommand(name, {
      ...command, handler: (args, ctx) => command.handler(args, backendContext(ctx)),
    }),
    on: ((event: string, handler: unknown) => {
      const adapted = (input: unknown, ctx: ExtensionContext) =>
        (handler as (event: unknown, ctx: ExtensionContext) => unknown)(input, backendContext(ctx));
      // Preserve native startup readiness, but remove the directory before Pi
      // builds/persists the prompt. This is not a model-facing instruction.
      if (event === 'before_agent_start') {
        return pi.on('before_agent_start', async (input, ctx) => {
          await adapted(input, ctx);
          delete input.systemPromptOptions.sections['mcp_servers'];
        });
      }
      return pi.on(event as never, adapted as never);
    }) as ExtensionAPI['on'],
    registerTool: (tool) => pi.registerTool(executionTool(tool)),
  };
  createMcpExtension(options)(adapter);
}
