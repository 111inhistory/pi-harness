/**
 * Contract tests for the Subagent session surface.
 *
 * The surface factory is the real production builder; the fakes implement only
 * the declared host/api ports. Messaging uses the standalone tool; native file
 * writes remain SDK-owned. The SDK context fixture supplies only the members
 * used by the surface and inherited-context capture.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { promptText } from "../../src/prompt-text.ts";
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { fauxProvider } from '@earendil-works/pi-ai';
import type { EndpointResolverResult } from "../../src/ipc/socket.ts";
import {
  captureContextForChild,
  createSurfaceTools,
  installSessionSurface,
} from "../../src/subagent/surface.ts";
import {
  droppedInheritedTools,
  harnessToolsForDepth,
  inheritedToolNames,
  inheritedToolsWarning,
  transplantableToolNames,
} from "../../src/subagent/tool-policy.ts";
import type {
  SubagentSurfaceApi,
  SubagentSurfaceCreateOptions,
  SubagentSurfaceHost,
  SubagentSurfaceScope,
  SubagentSurfaceToolInfo,
} from "../../src/subagent/surface.ts";
import type {
  BroadcastReceipt,
  CreatedAgents,
  DetailedAgentItem,
  MessageReceipt,
  StopResult,
} from "../../src/subagent/runtime.ts";
import type { SessionEndpoint } from "../../src/subagent/message-write.ts";

const MAX_DEPTH = 2;

const ROOT_SCOPE: SubagentSurfaceScope = {
  callerId: "Main",
  depth: 0,
  allowInherited: true,
  cwd: "/tmp/project",
  maxDepth: MAX_DEPTH,
  capacityFor: () => ({ maxActiveChildren: 4, maxActiveInheritedChildren: 2 }),
};

/** Derived from the exported context type: the SDK entry point does not export it. */
type SurfaceMode = ExtensionContext["mode"];
type SurfaceSessionManager = Pick<
  ExtensionContext["sessionManager"],
  "getSessionId" | "getHeader" | "getBranch"
>;

interface ContextFixture {
  cwd: string;
  sessionId?: string;
  trusted?: boolean;
  systemPrompt?: string;
  mode?: SurfaceMode;
}

/**
 * The subset of the SDK tool context this surface reads. Every property is
 * typed exactly like `ExtensionToolContext`, so the one assertion at the SDK
 * boundary is legal without `unknown`: the real interface is assignable to this
 * subset. `model` and `thinkingLevel` are intentionally absent, so the capture
 * sees the SDK's own "not provided" value (undefined).
 */
interface SurfaceContextSubset {
  cwd: string;
  mode: SurfaceMode;
  sessionManager: SurfaceSessionManager;
  isProjectTrusted(): boolean;
  getSystemPrompt(): string;
}

/** The SDK tool context is a large interface; this fixture fills the subset. */
function sdkContext(fixture: ContextFixture): ExtensionToolContext {
  const context: SurfaceContextSubset = {
    cwd: fixture.cwd,
    mode: fixture.mode ?? "tui",
    sessionManager: {
      getSessionId: () => fixture.sessionId ?? "session-1",
      getHeader: () => null,
      getBranch: () => [],
    },
    isProjectTrusted: () => fixture.trusted ?? true,
    getSystemPrompt: () => fixture.systemPrompt ?? "SYSTEM PROMPT",
  };
  return context as ExtensionToolContext;
}

class FakeSurfaceApi implements SubagentSurfaceApi {
  catalog: SubagentSurfaceToolInfo[] = [];
  active: string[] = [];

  getAllTools(): readonly SubagentSurfaceToolInfo[] {
    return this.catalog;
  }

  getActiveTools(): string[] {
    return this.active;
  }
}

interface RecordedCreate {
  readonly batch: unknown;
  readonly options: SubagentSurfaceCreateOptions;
  readonly ctx: ExtensionContext;
}

class RecordingHost implements SubagentSurfaceHost {
  maxDepth = MAX_DEPTH;
  readonly creates: RecordedCreate[] = [];
  readonly lists: Array<{ filter: unknown; callerId: string }> = [];
  readonly stops: unknown[] = [];
  readonly sends: unknown[] = [];
  readonly receipts: MessageReceipt[] = [];
  endpoint: EndpointResolverResult = { isManaged: true, targetId: "sub_02" };

  async resolveEndpoint(): Promise<EndpointResolverResult> {
    return this.endpoint;
  }

  async sendCrossSession(command: Parameters<SubagentSurfaceHost["sendCrossSession"]>[0]): Promise<void> {
    this.crossSessions.push(command);
  }

  async sessionEndpoint(address: string): Promise<SessionEndpoint> {
    return address.startsWith("/tmp/sockets/aaaaaa") ? { kind: "local" } : { kind: "local" };
  }

  async listSessions() {
    return [{
      sessionId: "current", uid: "aaaaaa", socketDir: "/tmp/sockets/aaaaaa", pid: 1,
      cwd: "/tmp/project", name: "reviewing", startedAt: 1,
    }];
  }

  readonly crossSessions: unknown[] = [];

  async sendMessage(command: Parameters<SubagentSurfaceHost["sendMessage"]>[0]): Promise<MessageReceipt | BroadcastReceipt> {
    this.sends.push(command);
    const receipt: MessageReceipt = { ok: true, to: command.to, jobId: null };
    this.receipts.push(receipt);
    return receipt;
  }

  async create(batch: unknown, options: SubagentSurfaceCreateOptions, ctx: ExtensionContext): Promise<CreatedAgents> {
    this.creates.push({ batch, options, ctx });
    return { items: [{ id: "sub_02", socket: "/tmp/project/.pi/sub_02.sock" }] };
  }

  async list(filter: unknown, callerId: string): Promise<DetailedAgentItem | null> {
    this.lists.push({ filter, callerId });
    return null;
  }

  stop(target: unknown): StopResult {
    this.stops.push(target);
    return { ok: true, id: String(target), status: "stopping" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaOf(tool: { readonly parameters: unknown }): Record<string, unknown> {
  const parameters: unknown = tool.parameters;
  assert.ok(isRecord(parameters));
  return parameters;
}

function propertyOf(schema: Record<string, unknown>, key: string): Record<string, unknown> {
  const properties = schema["properties"];
  assert.ok(isRecord(properties));
  const value = properties[key];
  assert.ok(isRecord(value));
  return value;
}

function resolveWith(host: SubagentSurfaceHost, seen: ExtensionContext[]): (ctx: ExtensionContext) => Promise<SubagentSurfaceHost> {
  return async (ctx) => {
    seen.push(ctx);
    return host;
  };
}

test("the capacity section follows the resolved caps without rewriting tool text", async () => {
  const registered: ToolDefinition[] = [];
  const handlers: Array<{ event: string; handler: (...args: never[]) => unknown }> = [];
  interface SurfaceApiSubset {
    registerTool(tool: ToolDefinition): void;
    on(event: string, handler: (...args: never[]) => unknown): void;
    getAllTools(): ExtensionAPI["getAllTools"] extends () => infer T ? T : never;
    getActiveTools(): string[];
  }
  const api: SurfaceApiSubset = {
    registerTool: (tool) => { registered.push(tool); },
    on: (event, handler) => { handlers.push({ event, handler }); },
    getAllTools: () => [],
    getActiveTools: () => [],
  };
  let limits = { maxActiveChildren: 4, maxActiveInheritedChildren: 2 };
  installSessionSurface(api as unknown as ExtensionAPI, async () => new RecordingHost(), {
    ...ROOT_SCOPE,
    capacityFor: () => limits,
  });

  const handler = handlers.find((entry) => entry.event === "before_agent_start")?.handler;
  assert.ok(handler);
  const options = { sections: {} as Record<string, string> };
  const event = { type: "before_agent_start", systemPrompt: "", systemPromptOptions: options };
  const ctx = sdkContext({ cwd: "/tmp/project" });

  await handler(event as never, ctx as never);
  const first = options.sections["subagent_capacity"];
  assert.match(first ?? "", /at most 4 fresh and 2 inherited children per parent/);
  assert.equal(
    registered.find((tool) => tool.name === "subagent_create")?.description,
    JSON.parse(promptText("subagent-tools.json")).create.description,
    "tool text stays static so a cap change does not move the prompt prefix",
  );

  await handler(event as never, ctx as never);
  assert.equal(options.sections["subagent_capacity"], first, "an unchanged snapshot produces identical text");

  limits = { maxActiveChildren: 1, maxActiveInheritedChildren: 3 };
  await handler(event as never, ctx as never);
  assert.match(options.sections["subagent_capacity"] ?? "", /at most 1 fresh and 3 inherited children per parent/);
});

test("the root surface registers controls and messaging without overriding write", () => {
  const registered: ToolDefinition[] = [];
  // Registration-only subset of ExtensionAPI; the assembly below is the SDK
  // boundary this test crosses.
  interface SurfaceApiSubset {
    registerTool(tool: ToolDefinition): void;
    on(event: string, handler: (...args: never[]) => unknown): void;
    getAllTools(): ExtensionAPI["getAllTools"] extends () => infer T ? T : never;
    getActiveTools(): string[];
  }
  const api: SurfaceApiSubset = {
    registerTool: (tool) => { registered.push(tool); },
    on: () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
  };
  installSessionSurface(api as unknown as ExtensionAPI, async () => new RecordingHost(), ROOT_SCOPE);

  assert.deepEqual(registered.map((tool) => tool.name), [
    "subagent_create",
    "subagent_list",
    "subagent_stop",
    "session_list",
    "msg_write",
  ]);
  for (const tool of registered) {
    assert.equal(tool.namespace?.name, "subagent");
    assert.ok((tool.namespace?.description ?? "") !== "");
    assert.ok((tool.namespace?.instructions ?? "") !== "");
    assert.equal(tool.defaultActive, false, "Main activates messaging through the Capability/Subagent namespace");
    assert.ok((tool.promptSnippet ?? "") !== "");
    assert.ok((tool.promptGuidelines?.length ?? 0) > 0);
  }
  assert.ok(!registered.some(tool => tool.name === "write"));

  const create = schemaOf(registered[0] as ToolDefinition);
  assert.deepEqual(create["required"], ["tasks"]);
  assert.equal(create["additionalProperties"], false);
  const tasks = propertyOf(create, "tasks");
  assert.equal(tasks["minItems"], 1);
  const taskItem = tasks["items"] as Record<string, unknown>;
  assert.deepEqual(taskItem["required"], ["task"]);
  assert.equal(taskItem["additionalProperties"], false);

  const list = schemaOf(registered[1] as ToolDefinition);
  assert.equal(list["required"], undefined);
  assert.ok(propertyOf(list, "all"));
  assert.ok(propertyOf(list, "id"));

  const stop = schemaOf(registered[2] as ToolDefinition);
  assert.deepEqual(stop["required"], ["id"]);
});

test("the leaf surface keeps list and messaging but no create/stop", () => {
  const api = new FakeSurfaceApi();
  const tools = createSurfaceTools({
    api,
    resolveHost: async () => new RecordingHost(),
    scope: { ...ROOT_SCOPE, callerId: "sub_01", depth: MAX_DEPTH },
  });

  assert.equal(tools.create, null);
  assert.equal(tools.stop, null);
  assert.equal(tools.list.name, "subagent_list");
  assert.equal(tools.msg_write.name, "msg_write");
  assert.equal("message" in tools, false);
});

test("the configured maximum depth moves the surface leaf", () => {
  const api = new FakeSurfaceApi();
  const deep = createSurfaceTools({
    api,
    resolveHost: async () => new RecordingHost(),
    scope: { ...ROOT_SCOPE, callerId: "sub_01", depth: 1, maxDepth: 3 },
  });
  assert.ok(deep.create);
  assert.ok(deep.stop);
  const shallow = createSurfaceTools({
    api,
    resolveHost: async () => new RecordingHost(),
    scope: { ...ROOT_SCOPE, callerId: "sub_01", depth: 1, maxDepth: 1 },
  });
  assert.equal(shallow.create, null);
  assert.equal(shallow.stop, null);
});

test("tool-owned parameter labels and create-only guidance follow the assets", () => {
  const asset = JSON.parse(promptText("subagent-tools.json"));
  const tools = createSurfaceTools({ api: new FakeSurfaceApi(), resolveHost: async () => new RecordingHost(), scope: ROOT_SCOPE });
  assert.ok(tools.create && tools.stop);
  const common = asset.instructions.split("\n");
  assert.deepEqual(tools.create.promptGuidelines, [...common, asset.create.guideline]);
  assert.deepEqual(tools.list.promptGuidelines, common);
  assert.deepEqual(tools.stop.promptGuidelines, common);
  assert.equal("parameters" in asset, false, "parameter labels belong to their tools, not a flat shared map");
  const create = schemaOf(tools.create);
  assert.equal(propertyOf(create, "context")["description"], asset.create.parameters.context);
  const tasks = propertyOf(create, "tasks");
  assert.equal(tasks["description"], asset.create.parameters.tasks.description);
  const item = tasks["items"] as Record<string, unknown>;
  for (const key of ["name", "task", "inheritContext"]) {
    assert.equal(propertyOf(item, key)["description"], asset.create.parameters.tasks.items[key]);
  }
  for (const key of ["all", "id"]) {
    assert.equal(propertyOf(schemaOf(tools.list), key)["description"], asset.list.parameters[key]);
  }
  assert.equal(propertyOf(schemaOf(tools.stop), "id")["description"], asset.stop.parameters.id);
  for (const key of ["path", "content"]) {
    assert.equal(propertyOf(schemaOf(tools.msg_write), key)["description"], asset.msg_write.parameters[key]);
  }
  const leaf = createSurfaceTools({ api: new FakeSurfaceApi(), resolveHost: async () => new RecordingHost(),
    scope: { ...ROOT_SCOPE, callerId: "sub_01", depth: MAX_DEPTH } });
  assert.equal(leaf.create, null);
  assert.deepEqual(leaf.list.promptGuidelines, common);
});

test("the root session_list reports the discovery view with addresses and the current marker", async () => {
  const host = new RecordingHost();
  const tools = createSurfaceTools({ api: new FakeSurfaceApi(), resolveHost: async () => host, scope: ROOT_SCOPE });
  assert.ok(tools.sessions);
  const ctx = sdkContext({ cwd: "/tmp/project", sessionId: "current" });
  const result = await tools.sessions.execute("call-sessions", {}, undefined, undefined, ctx);
  assert.deepEqual(result.details, {
    available: true,
    sessions: [{
      uid: "aaaaaa", sessionId: "current", name: "reviewing", cwd: "/tmp/project", pid: 1, startedAt: 1,
      current: true, address: "/tmp/sockets/aaaaaa/Main.sock",
    }],
  });
});

test("a subagent surface has no cross-session discovery or intent tools", () => {
  const tools = createSurfaceTools({
    api: new FakeSurfaceApi(),
    resolveHost: async () => new RecordingHost(),
    scope: { ...ROOT_SCOPE, callerId: "sub_01", depth: 1 },
  });
  assert.equal(tools.sessions, null);
});

test("the root create tool maps Main to no parent and passes origin and lazy capture", async () => {
  const api = new FakeSurfaceApi();
  api.catalog = [{ name: "read", sourceInfo: { source: "builtin" } }];
  api.active = ["read", "subagent_create"];
  const host = new RecordingHost();
  const seen: ExtensionContext[] = [];
  const tools = createSurfaceTools({ api, resolveHost: resolveWith(host, seen), scope: ROOT_SCOPE });
  assert.ok(tools.create !== null);
  const ctx = sdkContext({ cwd: "/tmp/project", sessionId: "session-7", trusted: true, mode: "tui" });

  const result = await tools.create.execute("call-1", {
    context: "batch context",
    tasks: [{ task: "do the task" }],
  }, undefined, undefined, ctx);

  assert.deepEqual(seen, [ctx]);
  assert.equal(host.creates.length, 1);
  const call = host.creates[0];
  assert.ok(call !== undefined);
  assert.equal(call.ctx, ctx);
  assert.deepEqual(call.batch, { context: "batch context", tasks: [{ task: "do the task" }] });
  assert.equal(call.options.parentAgentId, null);
  assert.equal(call.options.allowInherited, true);
  assert.deepEqual(call.options.origin, {
    cwd: "/tmp/project",
    trusted: true,
    sessionId: "session-7",
    agentId: null,
    mode: "tui",
  });
  assert.deepEqual(result.details, {
    items: [{ id: "sub_02", socket: "/tmp/project/.pi/sub_02.sock" }],
  });
  assert.match(JSON.stringify(result.content), /sub_02/);

  // The capture is lazy and validated when the runtime asks for it.
  const snapshot = call.options.captureInheritedContext();
  assert.ok(isRecord(snapshot));
  const record = snapshot;
  assert.deepEqual(record["tools"], ["read", "subagent_create"]);
  assert.equal(record["cwd"], "/tmp/project");
  assert.equal(record["warnings"], undefined);
});

test("a child surface reports its own actor id as the parent, never its parent's id", async () => {
  const api = new FakeSurfaceApi();
  const host = new RecordingHost();
  const tools = createSurfaceTools({
    api,
    resolveHost: async () => host,
    scope: {
      callerId: "sub_01", depth: 1, allowInherited: false, cwd: "/tmp/project", maxDepth: MAX_DEPTH,
      capacityFor: () => ({ maxActiveChildren: 4, maxActiveInheritedChildren: 2 }),
    },
  });
  assert.ok(tools.create !== null);
  const ctx = sdkContext({ cwd: "/tmp/child" });

  await tools.create.execute("call-2", { tasks: [{ task: "nested" }] }, undefined, undefined, ctx);
  const call = host.creates[0];
  assert.ok(call !== undefined);
  assert.equal(call.options.parentAgentId, "sub_01");
  assert.equal(call.options.allowInherited, false);
  assert.equal(call.options.origin.agentId, "sub_01");

  await tools.list.execute("call-3", {}, undefined, undefined, ctx);
  assert.deepEqual(host.lists, [{ filter: {}, callerId: "sub_01" }]);
});

test("list and stop resolve the host with the current execute context", async () => {
  const api = new FakeSurfaceApi();
  const first = new RecordingHost();
  const second = new RecordingHost();
  const seen: ExtensionContext[] = [];
  const ctxA = sdkContext({ cwd: "/tmp/a" });
  const ctxB = sdkContext({ cwd: "/tmp/b" });
  const tools = createSurfaceTools({
    api,
    resolveHost: async (ctx) => {
      seen.push(ctx);
      return ctx === ctxB ? second : first;
    },
    scope: ROOT_SCOPE,
  });

  await tools.list.execute("l1", { all: true }, undefined, undefined, ctxA);
  await tools.list.execute("l2", { id: "sub_02" }, undefined, undefined, ctxB);
  assert.deepEqual(seen, [ctxA, ctxB]);
  assert.deepEqual(first.lists, [{ filter: { all: true }, callerId: "Main" }]);
  assert.deepEqual(second.lists, [{ filter: { id: "sub_02" }, callerId: "Main" }]);

  assert.ok(tools.stop !== null);
  await tools.stop.execute("s1", { id: "sub_02" }, undefined, undefined, ctxA);
  assert.deepEqual(first.stops, ["sub_02"]);
});

test("msg_write sends messages and keeps routing metadata internal", async () => {
  const api = new FakeSurfaceApi();
  const host = new RecordingHost();
  const seen: ExtensionContext[] = [];
  const tools = createSurfaceTools({ api, resolveHost: resolveWith(host, seen), scope: ROOT_SCOPE });
  const ctx = sdkContext({ cwd: "/tmp/project" });

  const result = await tools.msg_write.execute(
    "m1",
    { path: "/tmp/project/.pi/sub_02.sock", content: "hello agent" },
    undefined,
    undefined,
    ctx,
  );

  // Endpoint ownership and the send share one resolution for this execution.
  assert.deepEqual(seen, [ctx]);
  assert.deepEqual(host.sends, [{ from: "Main", to: "sub_02", content: "hello agent" }]);
  assert.equal(result.details, undefined);
  assert.match(JSON.stringify(result.content), /Successfully sent message/);
});

test("msg_write still rejects a non-IPC path without resolving the host", async () => {
  const api = new FakeSurfaceApi();
  const seen: ExtensionContext[] = [];
  const tools = createSurfaceTools({
    api,
    resolveHost: async (ctx) => {
      seen.push(ctx);
      throw new Error("the host must not be resolved for a non-IPC path");
    },
    scope: ROOT_SCOPE,
  });
  const ctx = sdkContext({ cwd: "/tmp/project" });

  await assert.rejects(
    tools.msg_write.execute("m2", { path: "notes.txt", content: "x" }, undefined, undefined, ctx),
    /requires a managed endpoint address/,
  );
  assert.deepEqual(seen, []);
});

test("endpoint ownership and send share one cached resolution per execute", async () => {
  const api = new FakeSurfaceApi();
  const first = new RecordingHost();
  const second = new RecordingHost();
  let resolutions = 0;
  const tools = createSurfaceTools({
    api,
    resolveHost: async () => {
      resolutions += 1;
      // A root switch mid-call must not be consulted again by this execute.
      return resolutions === 1 ? first : second;
    },
    scope: ROOT_SCOPE,
  });
  const ctx = sdkContext({ cwd: "/tmp/project" });

  const result = await tools.msg_write.execute(
    "m3",
    { path: "/tmp/project/.pi/sub_02.sock", content: "once" },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(resolutions, 1);
  assert.deepEqual(first.sends, [{ from: "Main", to: "sub_02", content: "once" }]);
  assert.deepEqual(second.sends, []);
  assert.equal(result.details, undefined);
});

test("concurrent managed sends keep per-execution hosts isolated", async () => {
  const api = new FakeSurfaceApi();
  const first = new RecordingHost();
  first.endpoint = { isManaged: true, targetId: "sub_02" };
  const second = new RecordingHost();
  second.endpoint = { isManaged: true, targetId: "sub_03" };
  const ctxA = sdkContext({ cwd: "/tmp/project" });
  const ctxB = sdkContext({ cwd: "/tmp/project" });
  const tools = createSurfaceTools({
    api,
    resolveHost: async (ctx) => (ctx === ctxA ? first : second),
    scope: ROOT_SCOPE,
  });

  const [a, b] = await Promise.all([
    tools.msg_write.execute("c1", { path: "/tmp/project/.pi/sub_02.sock", content: "first" }, undefined, undefined, ctxA),
    tools.msg_write.execute("c2", { path: "/tmp/project/.pi/sub_03.sock", content: "second" }, undefined, undefined, ctxB),
  ]);

  assert.deepEqual(first.sends, [{ from: "Main", to: "sub_02", content: "first" }]);
  assert.deepEqual(second.sends, [{ from: "Main", to: "sub_03", content: "second" }]);
  assert.equal(a.details, undefined);
  assert.equal(b.details, undefined);
});

test('create forwards its tool call id to physical model capture before pending-call removal', async () => {
  const physical = fauxProvider().getModel();
  const manager = SessionManager.inMemory(ROOT_SCOPE.cwd);
  manager.appendMessage({
    role: 'assistant', api: physical.api, provider: physical.provider, model: physical.id,
    content: [{ type: 'toolCall', id: 'spawn-physical-call', name: 'subagent_create', arguments: {} }],
    stopReason: 'toolUse', timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const ctx = {
    ...sdkContext({ cwd: ROOT_SCOPE.cwd }),
    model: { ...physical, api: 'pi-virtual' },
    modelRegistry: { runtime: {
      streamSimple() {}, getAuth() {}, getRegisteredProviderIds() {},
      getPhysicalModel(provider: string, id: string) {
        assert.equal(provider, physical.provider);
        assert.equal(id, physical.id);
        return physical;
      },
    } },
    sessionManager: manager,
  } as unknown as ExtensionToolContext;
  const host = new RecordingHost();
  const tools = createSurfaceTools({ api: new FakeSurfaceApi(), resolveHost: async () => host, scope: ROOT_SCOPE });
  assert.ok(tools.create);
  await tools.create.execute('spawn-physical-call', { tasks: [{ task: 'inherit', inheritContext: true }] }, undefined, undefined, ctx);
  const recorded = host.creates[0];
  assert.ok(recorded);
  const snapshot = recorded.options.captureInheritedContext();
  assert.ok(isRecord(snapshot));
  assert.equal(snapshot['model'], physical);
  assert.ok(Array.isArray(snapshot['entries']));
  assert.equal(snapshot['entries'].filter((entry: unknown) => isRecord(entry) && entry['type'] === 'message').length, 0,
    'the pending spawning call is removed only after physical identity is captured');
});

test("inherited capture warns about non-transplantable parent tools", async () => {
  const api = new FakeSurfaceApi();
  api.catalog = [
    { name: "read", sourceInfo: { source: "builtin" } },
    { name: "extension_tool", sourceInfo: { source: "extension" } },
  ];
  api.active = ["read", "extension_tool", "subagent_create"];
  const host = new RecordingHost();
  const tools = createSurfaceTools({ api, resolveHost: async () => host, scope: ROOT_SCOPE });
  assert.ok(tools.create !== null);
  const ctx = sdkContext({ cwd: "/tmp/project", systemPrompt: "PARENT PROMPT" });

  await tools.create.execute("c1", { tasks: [{ task: "inherit me" }] }, undefined, undefined, ctx);
  const call = host.creates[0];
  assert.ok(call !== undefined);
  const snapshot = call.options.captureInheritedContext();
  assert.ok(isRecord(snapshot));
  const record = snapshot;
  assert.deepEqual(record["tools"], ["read", "extension_tool", "subagent_create"]);
  assert.equal(record["systemPrompt"], "PARENT PROMPT");
  assert.deepEqual(record["warnings"], [
    inheritedToolsWarning(["extension_tool"]),
  ]);
});

test("inherited capture uses the resolved host maximum depth", async () => {
  const api = new FakeSurfaceApi();
  api.catalog = [
    { name: "read", sourceInfo: { source: "builtin" } },
    // Real Harness tools are registered by a file-backed extension.
    { name: "capability", sourceInfo: { source: "local", path: "/tmp/project/extensions/harness.ts" } },
    { name: "subagent_create", sourceInfo: { source: "local", path: "/tmp/project/extensions/harness.ts" } },
  ];
  api.active = ["read", "subagent_create", "capability"];
  const host = new RecordingHost();
  // The root surface registered with the default depth, but the resolved
  // snapshot says the first child is already a leaf.
  host.maxDepth = 1;
  assert.equal(ROOT_SCOPE.maxDepth, MAX_DEPTH);
  const tools = createSurfaceTools({ api, resolveHost: async () => host, scope: ROOT_SCOPE });
  assert.ok(tools.create);
  const ctx = sdkContext({ cwd: "/tmp/project" });

  await tools.create.execute("c1", { tasks: [{ task: "inherit" }] }, undefined, undefined, ctx);
  const call = host.creates[0];
  assert.ok(call);
  const snapshot = call.options.captureInheritedContext();
  assert.ok(isRecord(snapshot));
  assert.deepEqual(snapshot["warnings"], [
    inheritedToolsWarning(["subagent_create", "capability"]),
  ]);
});

test("transplantability filters built-in and harness tools only", () => {
  const api = new FakeSurfaceApi();
  api.catalog = [
    { name: "read", sourceInfo: { source: "builtin" } },
    { name: "write", sourceInfo: { source: "builtin" } },
    { name: "extension_tool", sourceInfo: { source: "extension" } },
  ];

  assert.deepEqual(
    [...transplantableToolNames(api.getAllTools(), 0, MAX_DEPTH)].sort(),
    ["capability", "msg_write", "read", "subagent_create", "subagent_list", "subagent_stop", "write"],
  );
  assert.deepEqual(droppedInheritedTools(api.getAllTools(), ["read", "extension_tool", "extension_tool"], 0, MAX_DEPTH), ["extension_tool"]);
  assert.deepEqual(
    inheritedToolNames(api.getAllTools(), ["read", "extension_tool", "write"], 0, MAX_DEPTH),
    ["read", "write", "subagent_create", "subagent_list", "subagent_stop", "capability", "msg_write"],
  );
  assert.deepEqual(harnessToolsForDepth(MAX_DEPTH, MAX_DEPTH), ["subagent_list", "msg_write"]);
  assert.deepEqual(harnessToolsForDepth(MAX_DEPTH - 1, MAX_DEPTH), [
    "subagent_create",
    "subagent_list",
    "subagent_stop",
    "capability",
    "msg_write",
  ]);
});

test("capture of an empty session adds no warnings and no fabricated fields", () => {
  // The capture helper is production code; this verifies the exported wrapper
  // passes the captured snapshot through unchanged when nothing was dropped.
  const api = new FakeSurfaceApi();
  api.catalog = [];
  api.active = [];
  const ctx = sdkContext({ cwd: "/tmp/project" });
  const snapshot = captureContextForChild(api, ctx, 1, MAX_DEPTH);
  assert.ok(isRecord(snapshot));
  const record = snapshot;
  assert.deepEqual(record["tools"], []);
  assert.deepEqual(record["entries"], []);
  assert.equal(record["warnings"], undefined);
});
