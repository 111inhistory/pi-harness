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
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-ai";

import { captureInheritedContext, type InheritedSnapshot } from "../inherited-context.ts";
import { fillPrompt, promptString } from "../prompt-text.ts";
import {
  createMessageWriteTool,
  type ManagedWriteHost,
  type ManagedWriteTool,
} from "./message-write.ts";
import { droppedInheritedTools, inheritedToolsWarning } from "./tool-policy.ts";
import type { CreatedAgents, DetailedAgentItem, StopResult } from "./runtime.ts";
import { crossSessionAddress, crossSessionSupported, type LiveSession } from "./session-directory.ts";

/** Resolved active-child caps reported to the model in the prompt section. */
export interface ChildCapacity {
  readonly maxActiveChildren: number;
  readonly maxActiveInheritedChildren: number;
}

/** The caller-facing scope of one installed surface. */
export interface SubagentSurfaceScope {
  /** The surface owner: `Main` for the root session, else the child actor's own id. */
  readonly callerId: string;
  /** Nesting depth of the surface owner below Main. */
  readonly depth: number;
  /** Whether this surface's creator admission accepts Inherited children. */
  readonly allowInherited: boolean;
  /** Working directory of the surface owner. */
  readonly cwd: string;
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
  create(batch: unknown, options: SubagentSurfaceCreateOptions, ctx: ExtensionContext): Promise<CreatedAgents>;
  list(filter: unknown, callerId: string): Promise<DetailedAgentItem | null>;
  stop(target: unknown): StopResult;
  /** Live sessions of this user, for cross-session coordination. */
  listSessions(): Promise<readonly LiveSession[]>;
  /** Publish this session's coordination intent. */
  setIntent(intent: string): Promise<LiveSession>;
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

/** The tools one surface installs, already typed for their own parameters. */
export interface SubagentSurfaceTools {
  /** null at the leaf depth, where a child may not create further subagents. */
  readonly create: ToolDefinition<typeof createParameters, CreatedAgents> | null;
  readonly list: ToolDefinition<typeof listParameters, DetailedAgentItem | null>;
  /** null at the leaf depth, where a child may not stop other agents. */
  readonly stop: ToolDefinition<typeof stopParameters, StopResult> | null;
  readonly msg_write: ManagedWriteTool;
  /** Cross-session discovery; null below Main, where sessions are not coordinated. */
  readonly sessions: ToolDefinition<typeof sessionListParameters, SessionListView> | null;
  readonly intent: ToolDefinition<typeof sessionIntentParameters, SessionIntentView> | null;
}

/** One reachable session as the discovery tool reports it. */
export interface SessionListView {
  /** False where cross-session coordination is unavailable on this platform. */
  readonly available: boolean;
  readonly sessions: readonly {
    readonly uid: string;
    readonly sessionId: string;
    readonly cwd: string;
    readonly pid: number;
    readonly startedAt: number;
    readonly intent: string;
    readonly current: boolean;
    readonly address: string;
  }[];
}

export interface SessionIntentView {
  readonly uid: string;
  readonly sessionId: string;
  readonly intent: string;
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
  const messageTemplate = createMessageWriteTool({ cwd: scope.cwd, senderId: caller.callerId, host: UNRESOLVED_HOST });
  const msg_write: ManagedWriteTool = {
    ...messageTemplate,
    namespace: SUBAGENT_NAMESPACE,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let resolved: Promise<SubagentSurfaceHost> | undefined;
      const host = (): Promise<SubagentSurfaceHost> => resolved ??= resolveHost(ctx);
      return createMessageWriteTool({ cwd: scope.cwd, senderId: caller.callerId, host: {
        resolveEndpoint: async address => (await host()).resolveEndpoint(address),
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
        label: "Create Subagent",
        description: TOOL_TEXT.create.description,
        promptSnippet: TOOL_TEXT.create.snippet,
        promptGuidelines: [...SUBAGENT_NAMESPACE.instructions?.split("\n") ?? [], TOOL_TEXT.create.guideline],
        parameters: createParameters,
        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
          const host = await resolveHost(ctx);
          return respond(await host.create(params, {
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
          }, ctx));
        },
      }
    : null;

  const list: SubagentSurfaceTools["list"] = {
    name: "subagent_list",
    namespace: SUBAGENT_NAMESPACE,
    defaultActive: false,
    label: "List Subagents",
    description: TOOL_TEXT.list.description,
    promptSnippet: TOOL_TEXT.list.snippet,
    promptGuidelines: [...SUBAGENT_NAMESPACE.instructions?.split("\n") ?? []],
    parameters: listParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const host = await resolveHost(ctx);
      return respond(await host.list(params, caller.callerId));
    },
  };

  const stop: SubagentSurfaceTools["stop"] = shallow
    ? {
        name: "subagent_stop",
        namespace: SUBAGENT_NAMESPACE,
        defaultActive: false,
        label: "Stop Subagent",
        description: TOOL_TEXT.stop.description,
        promptSnippet: TOOL_TEXT.stop.snippet,
        promptGuidelines: [...SUBAGENT_NAMESPACE.instructions?.split("\n") ?? []],
        parameters: stopParameters,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const host = await resolveHost(ctx);
          return respond(host.stop(params.id));
        },
      }
    : null;

  // Cross-session coordination is Main-only: a subagent has no session view and
  // cannot reach another session's Main.
  const mainOnly = caller.callerId === "Main";
  const sessions: SubagentSurfaceTools["sessions"] = mainOnly
    ? {
        name: "session_list",
        namespace: SUBAGENT_NAMESPACE,
        defaultActive: false,
        label: "List Sessions",
        description: TOOL_TEXT.session_list.description,
        promptSnippet: TOOL_TEXT.session_list.snippet,
        promptGuidelines: [...SUBAGENT_NAMESPACE.instructions?.split("\n") ?? []],
        parameters: sessionListParameters,
        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
          const host = await resolveHost(ctx);
          const current = ctx.sessionManager.getSessionId();
          const available = crossSessionSupported();
          const live = await host.listSessions();
          return respond({
            available,
            sessions: live.map((session) => ({
              uid: session.uid,
              sessionId: session.sessionId,
              cwd: session.cwd,
              pid: session.pid,
              startedAt: session.startedAt,
              intent: session.intent,
              current: session.sessionId === current,
              address: crossSessionAddress(session.uid),
            })),
          } satisfies SessionListView);
        },
      }
    : null;

  const intent: SubagentSurfaceTools["intent"] = mainOnly
    ? {
        name: "session_intent",
        namespace: SUBAGENT_NAMESPACE,
        defaultActive: false,
        label: "Publish Session Intent",
        description: TOOL_TEXT.session_intent.description,
        promptSnippet: TOOL_TEXT.session_intent.snippet,
        promptGuidelines: [...SUBAGENT_NAMESPACE.instructions?.split("\n") ?? []],
        parameters: sessionIntentParameters,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const host = await resolveHost(ctx);
          const updated = await host.setIntent(params.intent);
          return respond({ uid: updated.uid, sessionId: updated.sessionId, intent: updated.intent } satisfies SessionIntentView);
        },
      }
    : null;

  return { create, list, stop, msg_write, sessions, intent };
}

/**
 * Install one session surface on a Pi extension API.
 *
 * `resolveHost` is the owner's resolver: it receives the current execute
 * context of *every* tool call, including list and stop. A child surface's
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
  if (tools.stop !== null) api.registerTool(tools.stop);
  if (tools.sessions !== null) api.registerTool(tools.sessions);
  if (tools.intent !== null) api.registerTool(tools.intent);
  api.registerTool(tools.msg_write);
  api.on("before_agent_start", (event, ctx) => {
    const limits = scope.capacityFor(ctx);
    event.systemPromptOptions.sections.subagent_capacity = fillPrompt(TOOL_TEXT.create.capacity, {
      fresh: limits.maxActiveChildren,
      inherited: limits.maxActiveInheritedChildren,
    });
  });
}

/** `Main` is the root caller; every other caller is the child actor's own id. */
function surfaceCaller(scope: SubagentSurfaceScope): { callerId: string; parentAgentId: string | null } {
  const callerId = scope.callerId.toLowerCase() === "main" ? "Main" : scope.callerId;
  return { callerId, parentAgentId: callerId === "Main" ? null : callerId };
}

/** Unreachable host of the metadata template: execute is always replaced. */
const UNRESOLVED_HOST: ManagedWriteHost = {
  resolveEndpoint: async () => {
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
    description: text('create', 'description'), snippet: text('create', 'snippet'), guideline: text('create', 'guideline'),
    capacity: text('create', 'capacity'),
    parameters: {
      context: text('create', 'parameters', 'context'),
      tasks: {
        description: text('create', 'parameters', 'tasks', 'description'),
        items: {
          name: text('create', 'parameters', 'tasks', 'items', 'name'),
          task: text('create', 'parameters', 'tasks', 'items', 'task'),
          inheritContext: text('create', 'parameters', 'tasks', 'items', 'inheritContext'),
        },
      },
    },
  },
  list: {
    description: text('list', 'description'), snippet: text('list', 'snippet'),
    parameters: { all: text('list', 'parameters', 'all'), id: text('list', 'parameters', 'id') },
  },
  stop: {
    description: text('stop', 'description'), snippet: text('stop', 'snippet'),
    parameters: { id: text('stop', 'parameters', 'id') },
  },
  session_list: { description: text('session_list', 'description'), snippet: text('session_list', 'snippet') },
  session_intent: {
    description: text('session_intent', 'description'), snippet: text('session_intent', 'snippet'),
    parameters: { intent: text('session_intent', 'parameters', 'intent') },
  },
};

export const SUBAGENT_NAMESPACE: ToolNamespace = Object.freeze({
  name: "subagent",
  description: TOOL_TEXT.namespace,
  instructions: promptString("subagent-tools.json", "instructions"),
});

const createParameters = Type.Object({
  context: Type.Optional(Type.String({ description: TOOL_TEXT.create.parameters.context })),
  tasks: Type.Array(
    Type.Object({
      name: Type.Optional(Type.String({ description: TOOL_TEXT.create.parameters.tasks.items.name })),
      task: Type.String({ description: TOOL_TEXT.create.parameters.tasks.items.task }),
      inheritContext: Type.Optional(Type.Boolean({ description: TOOL_TEXT.create.parameters.tasks.items.inheritContext })),
    }, { additionalProperties: false }),
    { minItems: 1, description: TOOL_TEXT.create.parameters.tasks.description },
  ),
}, { additionalProperties: false });

const listParameters = Type.Object({
  all: Type.Optional(Type.Boolean({ description: TOOL_TEXT.list.parameters.all })),
  id: Type.Optional(Type.String({ description: TOOL_TEXT.list.parameters.id })),
});

const stopParameters = Type.Object({
  id: Type.String({ description: TOOL_TEXT.stop.parameters.id }),
});

const sessionListParameters = Type.Object({}, { additionalProperties: false });

const sessionIntentParameters = Type.Object({
  intent: Type.String({ description: TOOL_TEXT.session_intent.parameters.intent }),
}, { additionalProperties: false });

/** The parts of `prompts/subagent-tools.json` this module renders. */
interface SurfaceToolText {
  readonly namespace: string;
  readonly create: {
    readonly description: string;
    readonly snippet: string;
    readonly guideline: string;
    readonly capacity: string;
    readonly parameters: {
      readonly context: string;
      readonly tasks: {
        readonly description: string;
        readonly items: { readonly name: string; readonly task: string; readonly inheritContext: string };
      };
    };
  };
  readonly list: { readonly description: string; readonly snippet: string; readonly parameters: { readonly all: string; readonly id: string } };
  readonly stop: { readonly description: string; readonly snippet: string; readonly parameters: { readonly id: string } };
  readonly session_list: { readonly description: string; readonly snippet: string };
  readonly session_intent: {
    readonly description: string;
    readonly snippet: string;
    readonly parameters: { readonly intent: string };
  };
}

// The declared tool parameter types, exported so callers can name a batch.
export type SubagentTaskBatch = Static<typeof createParameters>;
export type SubagentListFilter = Static<typeof listParameters>;
export type SubagentStopTarget = Static<typeof stopParameters>;
export type SubagentSessionIntent = Static<typeof sessionIntentParameters>;
