import {
  createMcpExtension,
  type ExtensionAPI,
  type ExtensionContext,
  type McpExtensionOptions,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { getCurrentTools } from '@earendil-works/pi-ai';
import { createToolAdmission, isMcpExecutionTool, isNativeDiscoveryTool } from './admission.ts';
import { installCapabilityCodemode } from './codemode.ts';
import { setIndependentDeclarations } from './declaration-visibility.ts';
import { projectDiscoveryDeclarations } from './declarations.ts';
import { projectPrunedToolHistory } from './compaction-context.ts';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfigProvider } from '../harness-config.ts';
import { promptString } from '../prompt-text.ts';

const text = {
  disabledDescription: promptString('native-discovery.json', 'disabledDescription'),
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
  // The native loadout owns the real declaration mask (hidden declarations plus
  // lazy schemas). Publish it so permission changes can remove a tool at once
  // when it has no independent declaration left.
  setIndependentDeclarations(pi, declaredTools);

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
    const historical = projectPrunedToolHistory(event.messages, ctx.sessionManager.getBranch());
    const messages = projectDiscoveryDeclarations(historical, allowed,
      () => pi.getAllTools().find(tool => tool.name === 'codemode')?.description);
    return { messages };
  });
  return declaredTools;
}

function executionTool<TParams extends ToolDefinition['parameters'], TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
  // Preserve the native exposure the MCP extension computed for each tool
  // (`codemode`/`deferred`/`direct`/`hidden`). Capability controls which tools
  // become *active* through selective activation; it must not rewrite exposure,
  // which would change how codemode, only mode and the declaration mask treat
  // the tool. Only hidden tools and the disabled native discovery tools stay
  // hidden, and every MCP tool starts inactive so Capability decides what to
  // declare.
  const scoped: ToolDefinition<TParams, TDetails, TState> = {
    ...tool, defaultActive: false,
    exposure: tool.exposure === 'hidden' || isNativeDiscoveryTool(tool.name) ? 'hidden' : tool.exposure ?? 'direct',
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
 * Whether the first request still depends on a recorded MCP declaration.
 *
 * Pi restores the active loadout from the transcript's system messages and
 * activates a recorded name once its server registers. A recorded MCP name that
 * is not registered yet is therefore a real dependency of the first request, and
 * Pi's native startup wait is what gives its server the chance to register. An
 * unselected server has no recorded declaration, so waiting for it would only
 * delay the prompt. This is a first-request question like Pi's own
 * `waitedForStartup`, so it is answered once per session, not per prompt.
 */
function awaitsRecordedMcpTools(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
  const recorded = ctx.sessionManager.getBranch().flatMap((entry) =>
    entry.type === 'message' && entry.message.role === 'system' ? [entry.message] : []);
  if (recorded.length === 0) return false;
  const registered = new Set(pi.getAllTools().map((tool) => tool.name));
  return getCurrentTools(recorded).some((tool) => isMcpExecutionTool(tool.name) && !registered.has(tool.name));
}

/**
 * Reuse Pi's MCP transport, authentication, /mcp UI and tool pipeline. Only its
 * discovery surface is disabled: no directory hook, no default declarations,
 * and no global resource-listing tools. Owning /mcp replaces the CLI built-in,
 * preventing a second connection manager from running beside this one.
 */
export function installCapabilityMcp(pi: ExtensionAPI, options: McpExtensionOptions = {}): void {
  // Pi's native startup wait is decided once per session and its own
  // `waitedForStartup` latch is reset on session_start. The dependency check is
  // the same first-request question, so it runs once and is reset the same way,
  // instead of replaying the transcript before every prompt of a long
  // conversation.
  let startupDependencyUnchecked = true;
  pi.on('session_start', () => { startupDependencyUnchecked = true; });

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
      // Pi's startup hook waits for `direct` servers so their tools are
      // declared in the first request. Capability registers every MCP tool
      // inactive and declares only branch-selected tools, so only a recorded
      // declaration that is still unregistered can depend on that wait; an
      // unselected server must not hold the baseline prompt. Once the first
      // request is decided, an intentionally skipped wait is never invoked on a
      // later prompt, where it could add an unexpected delay. The directory
      // section is removed before Pi builds/persists the prompt; it is never a
      // model-facing instruction.
      if (event === 'before_agent_start') {
        return pi.on('before_agent_start', async (input, ctx) => {
          const waitForStartup = startupDependencyUnchecked && awaitsRecordedMcpTools(pi, ctx);
          startupDependencyUnchecked = false;
          if (waitForStartup) await adapted(input, ctx);
          delete input.systemPromptOptions.sections['mcp_servers'];
        });
      }
      return pi.on(event as never, adapted as never);
    }) as ExtensionAPI['on'],
    registerTool: (tool) => pi.registerTool(executionTool(tool)),
  };
  createMcpExtension(options)(adapter);
}
