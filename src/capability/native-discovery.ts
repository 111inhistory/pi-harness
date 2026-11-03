import {
  createMcpExtension,
  type ExtensionAPI,
  type ExtensionContext,
  type McpExtensionOptions,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createToolAdmission, isMcpExecutionTool, isNativeDiscoveryTool } from './admission.ts';
import { installCapabilityCodemode } from './codemode.ts';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfigProvider } from '../harness-config.ts';
import { promptString } from '../prompt-text.ts';

const text = {
  disabledDescription: promptString('native-discovery.json', 'disabledDescription'),
  codemodeFallback: promptString('native-discovery.json', 'codemodeFallback'),
  resourceReadRequirement: promptString('native-discovery.json', 'resourceReadRequirement'),
};

/** Disable discovery as executable tools, not just as prompt recommendations. */
export function installNativeDiscoveryBoundary(
  pi: ExtensionAPI,
  configFor: HarnessConfigProvider = () => DEFAULT_HARNESS_CONFIG,
): () => ReadonlySet<string> {
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

  // One admission view per operation: the scope chain and the branch records
  // are resolved once, then every tool in that operation reuses the answer.
  const admissionFor = (ctx: ExtensionContext) => createToolAdmission(pi, ctx.sessionManager.getBranch());
  const declaredTools = installCapabilityCodemode(
    pi,
    (ctx) => admissionFor(ctx).admits,
    () => currentContext === undefined
      ? (name: string) => !isNativeDiscoveryTool(name) && !isMcpExecutionTool(name)
      : admissionFor(currentContext).admits,
    configFor,
  );

  pi.on('tool_call', (event, ctx) => {
    if (isNativeDiscoveryTool(event.toolName)) {
      return { block: true, reason: `${event.toolName} is disabled; use capability.` };
    }
    const admission = admissionFor(ctx);
    if (isMcpExecutionTool(event.toolName) &&
        (!admission.declares(event.toolName) || !pi.getActiveTools().includes(event.toolName))) {
      return { block: true, reason: 'This MCP tool has not been selected and activated by Capability on this branch.' };
    }
    if (event.toolName === 'read_mcp_resource' && !admission.admitsServer(event.input['server'])) {
      return { block: true, reason: 'Reading resources requires a selected, enabled MCP server permitted in the current scope.' };
    }
    return undefined;
  });

  // The one declaration prune. It drops disabled native tools, unselected MCP
  // tools and manual tools the user has not enabled, so no second hook repeats
  // the same active-set and selectedTools filtering. Scope is an execution
  // check, not a declaration rewrite.
  pi.on('before_agent_start', (event, ctx) => {
    currentContext = ctx;
    const admission = admissionFor(ctx);
    const active = pi.getActiveTools();
    const next = active.filter((name) => admission.declares(name));
    if (next.length !== active.length) pi.setActiveTools(next);
    event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools
      .filter((name) => admission.declares(name));
    delete event.systemPromptOptions.sections['mcp_servers'];
  });

  pi.on('context_with_system', (event, ctx) => {
    currentContext = ctx;
    const admission = admissionFor(ctx);
    const allowed = (name: string) => admission.declares(name);
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
