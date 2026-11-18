/**
 * The Subagent tool surface of one Pi session.
 *
 * This module owns tool declarations and registration, the inherited-context
 * capture and the transplantability filter that warns about parent tools a
 * child cannot inherit. It owns no lifecycle, no runtime map, no SDK run and no
 * persistence: the root service implements {@link SubagentSurfaceHost}, and
 * `resolveHost` decides per execution which host generation answers.
 *
 * Host resolution is deliberately per call and per generation:
 *
 * - every tool calls `resolveHost` with the *current* execute context, so a
 *   replaced root session is never answered by a retired service;
 * - a child surface's resolver returns its captured root service guarded by its
 *   generation instead of deriving a service from `ctx.sessionId`, so a child
 *   never reaches a later root session through a stale session id;
 * - `host.create` owns post-admission listener error reporting. The surface
 *   never invokes a listener operation itself.
 *
 * Messaging has one dedicated tool. The SDK's native file write tool is never
 * overridden or coupled to the Subagent service.
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";

import { captureInheritedContext, type InheritedSnapshot } from "../inherited-context.ts";
import { fillPrompt, promptString, promptStrings } from "../prompt-text.ts";
import {
  createMessageWriteTool,
  type ManagedWriteTool,
} from "./message-write.ts";
import type { ManagedWriteHost } from "./managed-send.ts";
import { MAIN_ACTOR } from "./address.ts";
import { droppedInheritedTools, inheritedToolsWarning } from "./tool-policy.ts";
import type { CreatedBatch, DetailedAgentItem, SignalResult } from "./runtime.ts";

/** Resolved admission caps reported to the model in the prompt section. */
export interface ChildCapacity {
  readonly maxActiveBatches: number;
  readonly maxActiveSubagents: number;
  readonly maxActiveInheritedSubagents: number;
}

/** The caller-facing scope of one installed surface. */
export interface SubagentSurfaceScope {
  /** The surface owner: canonical `main` for the root, else the child actor's own key. */
  readonly callerId: string;
  /** Nesting depth of the surface owner below Main. */
  readonly depth: number;
  /** Whether this surface's creator admission accepts Inherited children. */
  readonly allowInherited: boolean;
  /** The root's resolved maximum nesting depth; a child at it is a leaf. */
  readonly maxDepth: number;
  /**
   * Read per run so the section follows the snapshot that governs admission.
   * The root resolves it from its config provider; a child closes over the
   * config it was created with.
   */
  readonly capacityFor: (ctx: ExtensionContext) => ChildCapacity;
}

/** Where a created Job comes from; host-owned, passed through unchanged. */
export interface SubagentSurfaceOrigin {
  readonly cwd: string;
  readonly trusted: boolean;
  readonly sessionId: string;
  readonly agentId: string | null;
  readonly mode: string;
}

export interface SubagentSurfaceCreateOptions {
  readonly parentAgentId: string | null;
  readonly allowInherited: boolean;
  readonly origin: SubagentSurfaceOrigin;
  /** Lazy capture: the runtime calls it only for an Inherited admission. */
  readonly captureInheritedContext: () => unknown;
}

/**
 * The root service the surface speaks to. It extends the managed-write host, so
 * the same generation guard covers sends and Job admission.
 */
export interface SubagentSurfaceHost extends ManagedWriteHost {
  /**
   * The host root's resolved maximum nesting depth. The lazy inherited capture
   * uses it, so the capture and the runner share one snapshot even though the
   * root surface's own registration was resolved earlier.
   */
  readonly maxDepth: number;
  create(batch: SubagentCreateBatch, options: SubagentSurfaceCreateOptions, ctx: ExtensionContext): Promise<CreatedBatch>;
  list(filter: SubagentListFilter, callerId: string): Promise<DetailedAgentItem | null>;
  /** Signal one target for `callerId`; the root binds the sender's full address. */
  signal(target: string, action: SubagentSignalTarget["action"], callerId: string): Promise<SignalResult>;
}

/** The only shape the surface needs from a registered tool. */
export interface SubagentSurfaceToolInfo {
  readonly name: string;
  readonly sourceInfo?: { readonly source?: string | undefined; readonly path?: string | undefined } | undefined;
}

/**
 * The narrow extension-API view the surface reads. `ExtensionAPI` satisfies it;
 * registration itself stays with {@link installSessionSurface}.
 */
export interface SubagentSurfaceApi {
  getAllTools(): readonly SubagentSurfaceToolInfo[];
  getActiveTools(): readonly string[];
}

/**
 * Capture one inherited-context snapshot for a child at `childDepth`, adding
 * the host-generated warning for whatever the child cannot inherit.
 *
 * The capture pins the spawning call's physical model before removing pending
 * calls from the inherited native entries.
 */
export function captureContextForChild(
  api: SubagentSurfaceApi,
  ctx: ExtensionContext,
  childDepth: number,
  maxDepth: number,
  toolCallId?: string,
): InheritedSnapshot & { readonly warnings?: readonly string[] } {
  const snapshot = captureInheritedContext(api, ctx, toolCallId);
  const dropped = droppedInheritedTools(api.getAllTools(), snapshot.tools, childDepth, maxDepth);
  return dropped.length === 0 ? snapshot : { ...snapshot, warnings: [inheritedToolsWarning(dropped)] };
}

/** One created member as callers address it. */
export interface CreatedMemberView {
  /** This actor's local key, as create and list show it. */
  readonly id: string;
  /** This actor's full logical address, the messaging and signal target. */
  readonly address: string;
  readonly name: string | null;
}

/**
 * The create result shared by the model tool and RPC clients.
 *
 * Execution keeps the numeric batch, the launch roster and per-member
 * goal/role/model internally; callers only need the group address, each
 * member's addressing identity and host diagnostics. Both public entry points
 * project through {@link projectCreatedBatch} so the shape cannot drift.
 */
export interface CreatedBatchView {
  /** The batch's group selector. */
  readonly address: string;
  readonly items: readonly CreatedMemberView[];
  /** Host diagnostics that belong to the whole batch. */
  readonly warnings?: readonly string[];
}

/** Pure public projection of a registered batch; execution state stays internal. */
export function projectCreatedBatch(batch: CreatedBatch): CreatedBatchView {
  return {
    address: batch.address,
    items: batch.items.map(item => ({ id: item.id, address: item.address, name: item.name })),
    ...(batch.warnings === undefined ? {} : { warnings: batch.warnings }),
  };
}

/** The tools one surface installs, already typed for their own parameters. */
export interface SubagentSurfaceTools {
  /** null at the leaf depth, where a child may not create further subagents. */
  readonly create: ToolDefinition<typeof createParameters, CreatedBatchView> | null;
  readonly list: ToolDefinition<typeof listParameters, DetailedAgentItem | null>;
  /** null at the leaf depth, where a child may not signal other agents. */
  readonly signal: ToolDefinition<typeof signalParameters, SignalResult> | null;
  readonly msg_write: ManagedWriteTool;
}

export interface SubagentSurfaceToolOptions {
  readonly api: SubagentSurfaceApi;
  readonly resolveHost: (ctx: ExtensionContext) => Promise<SubagentSurfaceHost>;
  readonly scope: SubagentSurfaceScope;
}

/**
 * Build the tool definitions of one surface without registering them. Tests use
 * this narrow factory; {@link installSessionSurface} is the SDK boundary.
 */
export function createSurfaceTools(options: SubagentSurfaceToolOptions): SubagentSurfaceTools {
  const { api, resolveHost, scope } = options;
  const caller = surfaceCaller(scope);
  const shallow = scope.depth < scope.maxDepth;
  const messageTemplate = createMessageWriteTool({ senderId: caller.callerId, host: UNRESOLVED_HOST });
  const msg_write: ManagedWriteTool = {
    ...messageTemplate,
    namespace: SUBAGENT_NAMESPACE,
    promptGuidelines: [SUBAGENT_NAMESPACE_INSTRUCTIONS, ...TOOL_TEXT.msgWriteGuidelines],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let resolved: Promise<SubagentSurfaceHost> | undefined;
      const host = (): Promise<SubagentSurfaceHost> => resolved ??= resolveHost(ctx);
      return createMessageWriteTool({ senderId: caller.callerId, host: {
        resolveTarget: async address => (await host()).resolveTarget(address),
        sendMessage: async command => (await host()).sendMessage(command),
        sendCrossSession: async command => (await host()).sendCrossSession(command),
      } }).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };

  const create: SubagentSurfaceTools["create"] = shallow
    ? {
        name: "subagent_create",
        namespace: SUBAGENT_NAMESPACE,
        defaultActive: false,
        label: "Create Subagents",
        description: TOOL_TEXT.create.description,
        promptGuidelines: [SUBAGENT_NAMESPACE_INSTRUCTIONS, TOOL_TEXT.create.guideline],
        parameters: createParameters,
        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
          const host = await resolveHost(ctx);
          const created = await host.create(params, {
            parentAgentId: caller.parentAgentId,
            allowInherited: scope.allowInherited,
            origin: {
              cwd: ctx.cwd,
              trusted: ctx.isProjectTrusted(),
              sessionId: ctx.sessionManager.getSessionId(),
              agentId: caller.parentAgentId,
              mode: ctx.mode,
            },
            captureInheritedContext: () => captureContextForChild(api, ctx, scope.depth + 1, host.maxDepth, toolCallId),
          }, ctx);
          return respond(projectCreatedBatch(created));
        },
      }
    : null;

  const list: SubagentSurfaceTools["list"] = {
    name: "subagent_list",
    namespace: SUBAGENT_NAMESPACE,
    defaultActive: false,
    label: "List Subagents",
    description: TOOL_TEXT.list.description,
    promptGuidelines: [SUBAGENT_NAMESPACE_INSTRUCTIONS, TOOL_TEXT.list.guideline],
    parameters: listParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const host = await resolveHost(ctx);
      return respond(await host.list(params, caller.callerId));
    },
  };

  const signal: SubagentSurfaceTools["signal"] = shallow
    ? {
        name: "subagent_signal",
        namespace: SUBAGENT_NAMESPACE,
        defaultActive: false,
        label: "Signal Subagent",
        description: TOOL_TEXT.signal.description,
        promptGuidelines: [SUBAGENT_NAMESPACE_INSTRUCTIONS, TOOL_TEXT.signal.guideline],
        parameters: signalParameters,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const host = await resolveHost(ctx);
          return respond(await host.signal(params.target, params.action, caller.callerId));
        },
      }
    : null;

  return { create, list, signal, msg_write };
}

/**
 * Install one session surface on a Pi extension API.
 *
 * `resolveHost` is the owner's resolver: it receives the current execute
 * context of *every* tool call, including list and signal. A child surface's
 * resolver returns its captured root service guarded by its generation, not a
 * service derived from `ctx.sessionId`.
 */
export function installSessionSurface(
  api: ExtensionAPI,
  resolveHost: (ctx: ExtensionContext) => Promise<SubagentSurfaceHost>,
  scope: SubagentSurfaceScope,
): void {
  const tools = createSurfaceTools({
    api: {
      getAllTools: () => api.getAllTools(),
      getActiveTools: () => api.getActiveTools(),
    },
    resolveHost,
    scope,
  });
  if (tools.create !== null) api.registerTool(tools.create);
  api.registerTool(tools.list);
  if (tools.signal !== null) api.registerTool(tools.signal);
  api.registerTool(tools.msg_write);
  api.on("before_agent_start", (event, ctx) => {
    if (tools.create === null) return;
    const active = event.systemPromptOptions.selectedTools?.includes("subagent_create")
      || api.getActiveTools().includes("subagent_create");
    if (!active) return;
    const limits = scope.capacityFor(ctx);
    const capacity = fillPrompt(TOOL_TEXT.create.capacity, {
      batches: limits.maxActiveBatches,
      subagents: limits.maxActiveSubagents,
      inherited: limits.maxActiveInheritedSubagents,
    });
    if (event.systemPromptOptions.customPrompt) {
      const base = event.systemPromptOptions.appendSystemPrompt ?? "";
      event.systemPromptOptions.appendSystemPrompt = base.trim().length > 0 ? `${base}\n\n${capacity}` : capacity;
      return;
    }
    // Emit via promptGuidelines (rather than toolGuidelines) so the cap rule
    // still reaches `<rules>` when `subagent_create` is active only via Codemode.
    (event.systemPromptOptions.promptGuidelines ??= []).push(capacity);
  });
}

/** The root caller is the canonical `main` key; every other caller is its own actor key. */
function surfaceCaller(scope: SubagentSurfaceScope): { callerId: string; parentAgentId: string | null } {
  const callerId = scope.callerId;
  return { callerId, parentAgentId: callerId === MAIN_ACTOR ? null : callerId };
}

/** Unreachable host of the metadata template: execute is always replaced. */
const UNRESOLVED_HOST: ManagedWriteHost = {
  resolveTarget: async () => {
    throw new Error("The Subagent surface host was not resolved for this tool execution.");
  },
  sendMessage: async () => {
    throw new Error("The Subagent surface host was not resolved for this tool execution.");
  },
  sendCrossSession: async () => {
    throw new Error("The Subagent surface host was not resolved for this tool execution.");
  },
};

function respond<T>(payload: T): AgentToolResult<T> {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
}

const text = (...fields: string[]): string => promptString('subagent-tools.json', ...fields);
const TOOL_TEXT: SurfaceToolText = {
  namespace: text('namespace'),
  create: {
    description: text('create', 'description'),
    guideline: text('create', 'guideline'),
    capacity: text('create', 'capacity'),
    parameters: {
      context: text('create', 'parameters', 'context'),
      agents: {
        description: text('create', 'parameters', 'agents', 'description'),
        items: {
          name: text('create', 'parameters', 'agents', 'items', 'name'),
          goal: text('create', 'parameters', 'agents', 'items', 'goal'),
          inheritContext: text('create', 'parameters', 'agents', 'items', 'inheritContext'),
        },
      },
    },
  },
  list: {
    description: text('list', 'description'),
    guideline: text('list', 'guideline'),
    parameters: { all: text('list', 'parameters', 'all'), id: text('list', 'parameters', 'id') },
  },
  signal: {
    description: text('signal', 'description'),
    guideline: text('signal', 'guideline'),
    parameters: { target: text('signal', 'parameters', 'target'), action: text('signal', 'parameters', 'action') },
  },
  msgWriteGuidelines: promptStrings('subagent-tools.json', 'msg_write', 'guidelines'),
};

const SUBAGENT_NAMESPACE_INSTRUCTIONS = promptString("subagent-tools.json", "instructions");

export const SUBAGENT_NAMESPACE: ToolNamespace = Object.freeze({
  name: "subagent",
  description: TOOL_TEXT.namespace,
  instructions: SUBAGENT_NAMESPACE_INSTRUCTIONS,
});

const createParameters = Type.Object({
  context: Type.Optional(Type.String({ description: TOOL_TEXT.create.parameters.context })),
  agents: Type.Array(
    Type.Object({
      name: Type.Optional(Type.String({ description: TOOL_TEXT.create.parameters.agents.items.name })),
      goal: Type.String({ description: TOOL_TEXT.create.parameters.agents.items.goal }),
      inheritContext: Type.Optional(Type.Boolean({ description: TOOL_TEXT.create.parameters.agents.items.inheritContext })),
    }, { additionalProperties: false }),
    { minItems: 1, description: TOOL_TEXT.create.parameters.agents.description },
  ),
}, { additionalProperties: false });

const listParameters = Type.Object({
  all: Type.Optional(Type.Boolean({ description: TOOL_TEXT.list.parameters.all })),
  id: Type.Optional(Type.String({ description: TOOL_TEXT.list.parameters.id })),
});

const signalParameters = Type.Object({
  target: Type.String({ description: TOOL_TEXT.signal.parameters.target }),
  action: Type.Union([Type.Literal("interrupt"), Type.Literal("stop")], {
    description: TOOL_TEXT.signal.parameters.action,
  }),
}, { additionalProperties: false });

/** The parts of `prompts/subagent-tools.json` this module renders. */
interface SurfaceToolText {
  readonly namespace: string;
  readonly create: {
    readonly description: string;
    readonly guideline: string;
    readonly capacity: string;
    readonly parameters: {
      readonly context: string;
      readonly agents: {
        readonly description: string;
        readonly items: { readonly name: string; readonly goal: string; readonly inheritContext: string };
      };
    };
  };
  readonly list: {
    readonly description: string;
    readonly guideline: string;
    readonly parameters: { readonly all: string; readonly id: string };
  };
  readonly signal: {
    readonly description: string;
    readonly guideline: string;
    readonly parameters: { readonly target: string; readonly action: string };
  };
  readonly msgWriteGuidelines: readonly string[];
}

// The declared tool parameter types, exported so callers can name a batch.
export type SubagentCreateBatch = Static<typeof createParameters>;
export type SubagentListFilter = Static<typeof listParameters>;
export type SubagentSignalTarget = Static<typeof signalParameters>;
