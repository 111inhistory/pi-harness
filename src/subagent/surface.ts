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

import { captureInheritedContext } from "../inherited-context.mjs";
import { promptString, promptText } from "../prompt-text.mjs";
import {
  createMessageWriteTool,
  type ManagedWriteHost,
  type ManagedWriteTool,
} from "./message-write.ts";
import { MAX_AGENT_DEPTH } from "./runtime.ts";
import { droppedInheritedTools, inheritedToolsWarning } from "./tool-policy.ts";
import type { CreatedAgents, DetailedAgentItem, StopResult } from "./runtime.ts";

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
  create(batch: unknown, options: SubagentSurfaceCreateOptions, ctx: ExtensionContext): Promise<CreatedAgents>;
  list(filter: unknown, callerId: string): Promise<DetailedAgentItem | null>;
  stop(target: unknown): StopResult;
}

/** The only shape the surface needs from a registered tool. */
export interface SubagentSurfaceToolInfo {
  readonly name: string;
  readonly sourceInfo?: { readonly source?: string | undefined } | undefined;
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
 * The capture helper is a JavaScript boundary, so its result enters here as
 * `unknown` and is validated before any field is read. A malformed capture
 * throws; the runtime that invokes this lazily reports it as
 * `inherited_snapshot_failed`.
 */
export function captureContextForChild(
  api: SubagentSurfaceApi,
  ctx: ExtensionContext,
  childDepth: number,
): unknown {
  const captured: unknown = captureInheritedContext(api, ctx);
  const snapshot = requireCapturedContext(captured);
  const dropped = droppedInheritedTools(api.getAllTools(), snapshot["tools"], childDepth);
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
  const shallow = scope.depth < MAX_AGENT_DEPTH;
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
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
            captureInheritedContext: () => captureContextForChild(api, ctx, scope.depth + 1),
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

  return { create, list, stop, msg_write };
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
  api.registerTool(tools.msg_write);
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
};

function respond<T>(payload: T): AgentToolResult<T> {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
}

function requireCapturedContext(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError("The inherited-context capture returned no snapshot object.");
  }
  const tools = value["tools"];
  if (tools !== undefined && (!Array.isArray(tools) || tools.some((name) => typeof name !== "string"))) {
    throw new TypeError("The inherited-context capture returned a malformed tool list.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TOOL_TEXT = parseToolText();

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

/** The parts of `prompts/subagent-tools.json` this module renders. */
interface SurfaceToolText {
  readonly namespace: string;
  readonly create: {
    readonly description: string;
    readonly snippet: string;
    readonly guideline: string;
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
}

function parseToolText(): SurfaceToolText {
  const value: unknown = JSON.parse(promptText("subagent-tools.json"));
  const root = requireRecord(value, "the tool text");
  const create = requireRecord(root["create"], "create");
  const list = requireRecord(root["list"], "list");
  const stop = requireRecord(root["stop"], "stop");
  const createParams = requireRecord(create["parameters"], "create.parameters");
  const tasks = requireRecord(createParams["tasks"], "create.parameters.tasks");
  const items = requireRecord(tasks["items"], "create.parameters.tasks.items");
  const listParams = requireRecord(list["parameters"], "list.parameters");
  const stopParams = requireRecord(stop["parameters"], "stop.parameters");
  return {
    namespace: requireText(root["namespace"], "namespace"),
    create: {
      description: requireText(create["description"], "create.description"),
      snippet: requireText(create["snippet"], "create.snippet"),
      guideline: requireText(create["guideline"], "create.guideline"),
      parameters: {
        context: requireText(createParams["context"], "create.parameters.context"),
        tasks: {
          description: requireText(tasks["description"], "create.parameters.tasks.description"),
          items: {
            name: requireText(items["name"], "create.parameters.tasks.items.name"),
            task: requireText(items["task"], "create.parameters.tasks.items.task"),
            inheritContext: requireText(items["inheritContext"], "create.parameters.tasks.items.inheritContext"),
          },
        },
      },
    },
    list: {
      description: requireText(list["description"], "list.description"),
      snippet: requireText(list["snippet"], "list.snippet"),
      parameters: {
        all: requireText(listParams["all"], "list.parameters.all"),
        id: requireText(listParams["id"], "list.parameters.id"),
      },
    },
    stop: {
      description: requireText(stop["description"], "stop.description"),
      snippet: requireText(stop["snippet"], "stop.snippet"),
      parameters: { id: requireText(stopParams["id"], "stop.parameters.id") },
    },
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`Invalid Subagent tool text: ${label} must be an object.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`Invalid Subagent tool text: ${label} must be a non-empty string.`);
  }
  return value;
}

// The declared tool parameter types, exported so callers can name a batch.
export type SubagentTaskBatch = Static<typeof createParameters>;
export type SubagentListFilter = Static<typeof listParameters>;
export type SubagentStopTarget = Static<typeof stopParameters>;
