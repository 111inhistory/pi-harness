/**
 * Contract tests for the Subagent session surface.
 *
 * The surface factory is the real production builder; the fakes implement only
 * the declared host/api ports. Messaging uses the standalone tool; native file
 * writes remain SDK-owned. The SDK context fixture supplies only the members
 * used by the surface and inherited-context capture.
 */

import assert from "node:assert/strict";
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
import {
  createSurfaceTools,
  installSessionSurface,
} from "../../src/subagent/surface.ts";
import { inheritedToolsWarning } from "../../src/subagent/tool-policy.ts";
import type {
  CreatedBatchView,
  SubagentSurfaceApi,
  SubagentSurfaceCreateOptions,
  SubagentSurfaceHost,
  SubagentSurfaceScope,
  SubagentSurfaceToolInfo,
} from "../../src/subagent/surface.ts";
import type {
  BroadcastReceipt,
  CreatedBatch,
  DetailedAgentItem,
  MessageReceipt,
  SignalResult,
} from "../../src/subagent/runtime.ts";
import type { ResolvedTarget } from "../../src/subagent/managed-send.ts";

const MAX_DEPTH = 2;

const ROOT_SCOPE: SubagentSurfaceScope = {
  callerId: "main",
  depth: 0,
  allowInherited: true,
  maxDepth: MAX_DEPTH,
  capacityFor: () => ({ maxActiveBatches: 3, maxActiveSubagents: 8, maxActiveInheritedSubagents: 3 }),
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

/** One logical actor address for this root, as the model would read it. */
const agentAddress = (key: string): string => `01a1deac:${key}`;

const createdBatch: CreatedBatch = {
  batch: 1,
  address: "01a1deac:batch_1",
  roster: [{ address: agentAddress("sub_1-1"), name: "parser", goal: "fix it" }],
  items: [{
    id: "sub_1-1", address: agentAddress("sub_1-1"), name: "parser", goal: "fix it",
    role: "executor", model: "fake-model",
  }],
  warnings: ["one inherited tool was dropped"],
};

/** The public projection both the tool and RPC return: identity and diagnostics. */
const createdView: CreatedBatchView = {
  address: "01a1deac:batch_1",
  items: [{ id: "sub_1-1", address: agentAddress("sub_1-1"), name: "parser" }],
  warnings: ["one inherited tool was dropped"],
};

const signalResult: SignalResult = {
  ok: true,
  action: "interrupt",
  to: agentAddress("sub_1-1"),
  targets: [{ address: agentAddress("sub_1-1"), ok: true, status: "running" }],
};

class RecordingHost implements SubagentSurfaceHost {
  maxDepth = MAX_DEPTH;
  readonly creates: RecordedCreate[] = [];
  readonly lists: Array<{ filter: unknown; callerId: string }> = [];
  readonly signals: Array<{ target: string; action: string; callerId: string }> = [];
  readonly sends: unknown[] = [];
  readonly receipts: MessageReceipt[] = [];
  target: ResolvedTarget = { kind: "local" };
  created: CreatedBatch = createdBatch;
  signalResult: SignalResult = signalResult;

  async resolveTarget(): Promise<ResolvedTarget> {
    return this.target;
  }

  async sendCrossSession(command: Parameters<SubagentSurfaceHost["sendCrossSession"]>[0]): Promise<void> {
    this.crossSessions.push(command);
  }

  readonly crossSessions: unknown[] = [];

  async sendMessage(command: Parameters<SubagentSurfaceHost["sendMessage"]>[0]): Promise<MessageReceipt | BroadcastReceipt> {
    this.sends.push(command);
    const receipt: MessageReceipt = { ok: true, to: command.to, jobId: null };
    this.receipts.push(receipt);
    return receipt;
  }

  async create(batch: unknown, options: SubagentSurfaceCreateOptions, ctx: ExtensionContext): Promise<CreatedBatch> {
    this.creates.push({ batch, options, ctx });
    return this.created;
  }

  async list(filter: unknown, callerId: string): Promise<DetailedAgentItem | null> {
    this.lists.push({ filter, callerId });
    return null;
  }

  signal(target: string, action: "interrupt" | "stop", callerId: string): Promise<SignalResult> {
    this.signals.push({ target, action, callerId });
    return Promise.resolve(this.signalResult);
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
    getActiveTools: () => ["subagent_create"],
  };
  let limits = { maxActiveBatches: 3, maxActiveSubagents: 8, maxActiveInheritedSubagents: 3 };
  installSessionSurface(api as unknown as ExtensionAPI, async () => new RecordingHost(), {
    ...ROOT_SCOPE,
    capacityFor: () => limits,
  });

  const handler = handlers.find((entry) => entry.event === "before_agent_start")?.handler;
  assert.ok(handler);
  const firstOptions = { selectedTools: ["subagent_create"], promptGuidelines: [] as string[], sections: {} as Record<string, string> };
  const ctx = sdkContext({ cwd: "/tmp/project" });

  await handler({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: firstOptions } as never, ctx as never);
  const first = firstOptions.promptGuidelines.at(-1);
  assert.equal(firstOptions.sections["subagent_capacity"], undefined, "capacity is not emitted as an independent section");
  assert.match(first ?? "", /at most 3 active batches, 8 active subagents and 3 active inherited subagents/);
  assert.equal(
    registered.find((tool) => tool.name === "subagent_create")?.description,
    JSON.parse(promptText("subagent-tools.json")).create.description,
    "tool text stays static so a cap change does not move the prompt prefix",
  );

  const secondOptions = { selectedTools: ["subagent_create"], promptGuidelines: [] as string[], sections: {} as Record<string, string> };
  await handler({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: secondOptions } as never, ctx as never);
  assert.equal(secondOptions.promptGuidelines.at(-1), first, "an unchanged snapshot produces identical text");

  limits = { maxActiveBatches: 1, maxActiveSubagents: 4, maxActiveInheritedSubagents: 2 };
  const thirdOptions = { selectedTools: ["subagent_create"], promptGuidelines: [] as string[], sections: {} as Record<string, string> };
  await handler({ type: "before_agent_start", systemPrompt: "", systemPromptOptions: thirdOptions } as never, ctx as never);
  assert.match(thirdOptions.promptGuidelines.at(-1) ?? "", /at most 1 active batches, 4 active subagents and 2 active inherited subagents/);
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
    "subagent_signal",
    "msg_write",
  ]);
  const asset = JSON.parse(promptText("subagent-tools.json"));
  for (const tool of registered) {
    assert.equal(tool.namespace?.name, "subagent");
    assert.ok((tool.namespace?.description ?? "") !== "");
    assert.ok((tool.namespace?.instructions ?? "") !== "");
    assert.equal(tool.defaultActive, false, "Main activates messaging through the Capability/Subagent namespace");
    assert.equal(tool.promptSnippet, undefined);
    assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length >= 1,
      "static subagent guidance moves to native ToolDefinition.promptGuidelines");
    assert.equal(tool.promptGuidelines[0], asset.instructions);
    assert.ok(tool.description.length > 0, "usage guidance travels in the tool declaration");
  }
  assert.deepEqual(registered[0]!.promptGuidelines, [asset.instructions, asset.create.guideline]);
  assert.deepEqual(registered[1]!.promptGuidelines, [asset.instructions, asset.list.guideline]);
  assert.deepEqual(registered[2]!.promptGuidelines, [asset.instructions, asset.signal.guideline]);
  assert.deepEqual(registered[3]!.promptGuidelines, [asset.instructions, ...asset.msg_write.guidelines]);

  // The shared namespace text is only what applies to every member tool.
  for (const specific of ['children', 'msg_write', 'subagent_list', 'subagent_create', 'inheritContext']) {
    assert.ok(!asset.instructions.toLowerCase().includes(specific.toLowerCase()),
      `shared namespace instructions must not carry tool-specific text: ${specific}`);
  }
  // Create orchestration belongs only to subagent_create.
  const createGuidelines = registered[0]!.promptGuidelines ?? [];
  assert.ok(createGuidelines.includes(asset.create.guideline));
  for (const other of [1, 2, 3]) {
    assert.ok(!registered[other]!.promptGuidelines?.includes(asset.create.guideline),
      'create orchestration must not leak into another Subagent tool');
  }
  // Messaging rules belong only to msg_write; list guidance belongs only to subagent_list.
  const msgWriteGuidelines = registered[3]!.promptGuidelines ?? [];
  assert.ok(msgWriteGuidelines.includes(asset.list.guideline) === false,
    'the list usage rule is not messaging guidance');
  for (const rule of asset.msg_write.guidelines) {
    assert.ok(msgWriteGuidelines.includes(rule));
    for (const other of [0, 1, 2]) {
      assert.ok(!registered[other]!.promptGuidelines?.includes(rule),
        'messaging rules must not attach to a non-messaging Subagent tool');
    }
  }
  assert.ok(asset.msg_write.guidelines.some((rule: string) => rule.includes('batch_<batch>')),
    'broadcast messaging guidance lives on msg_write');
  assert.ok(asset.msg_write.guidelines.some((rule: string) => rule.includes('revives')),
    'revive semantics live on msg_write');
  assert.ok(!registered.some(tool => tool.name === "write"));
  for (const text of [asset.instructions, asset.create.snippet, asset.create.guideline, asset.list.guideline,
    asset.list.snippet, asset.signal.snippet, asset.msg_write.snippet, ...asset.msg_write.guidelines]) {
    assert.ok(!registered.some((tool) => tool.description.includes(text)),
      "guidance is projected natively via promptGuidelines, not folded into a tool description");
  }

  const create = schemaOf(registered[0] as ToolDefinition);
  assert.deepEqual(create["required"], ["agents"]);
  assert.equal(create["additionalProperties"], false);
  const agents = propertyOf(create, "agents");
  assert.equal(agents["minItems"], 1);
  const agentItem = agents["items"] as Record<string, unknown>;
  assert.deepEqual(agentItem["required"], ["goal"], "a member declares a goal; its label is optional");
  assert.equal(agentItem["additionalProperties"], false);
  assert.ok(propertyOf(agentItem, "name"));
  assert.ok(propertyOf(agentItem, "inheritContext"));

  const list = schemaOf(registered[1] as ToolDefinition);
  assert.equal(list["required"], undefined);
  assert.ok(propertyOf(list, "all"));
  assert.ok(propertyOf(list, "id"));

  const signal = schemaOf(registered[2] as ToolDefinition);
  assert.deepEqual(signal["required"], ["target", "action"]);
  assert.equal(signal["additionalProperties"], false);

  const msgWrite = schemaOf(registered[3] as ToolDefinition);
  assert.deepEqual(msgWrite["required"], ["to", "content"]);
});

test("the configured maximum depth moves the surface leaf", () => {
  const api = new FakeSurfaceApi();
  const deep = createSurfaceTools({
    api,
    resolveHost: async () => new RecordingHost(),
    scope: { ...ROOT_SCOPE, callerId: "sub_01", depth: 1, maxDepth: 3 },
  });
  assert.ok(deep.create);
  assert.ok(deep.signal);
  const shallow = createSurfaceTools({
    api,
    resolveHost: async () => new RecordingHost(),
    scope: { ...ROOT_SCOPE, callerId: "sub_01", depth: 1, maxDepth: 1 },
  });
  assert.equal(shallow.create, null);
  assert.equal(shallow.signal, null);
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
  const batch = { context: "shared context", agents: [{ name: "parser", goal: "fix the parser" }] };

  const result = await tools.create.execute("call-1", batch, undefined, undefined, ctx);

  assert.deepEqual(seen, [ctx]);
  assert.equal(host.creates.length, 1);
  const call = host.creates[0];
  assert.ok(call !== undefined);
  assert.equal(call.ctx, ctx);
  assert.deepEqual(call.batch, batch, "the declared batch is passed through unchanged");
  assert.equal(call.options.parentAgentId, null);
  assert.equal(call.options.allowInherited, true);
  assert.deepEqual(call.options.origin, {
    cwd: "/tmp/project",
    trusted: true,
    sessionId: "session-7",
    agentId: null,
    mode: "tui",
  });
  assert.deepEqual(result.details, createdView, "the tool returns the shared public projection");
  const batchFields = result.details as unknown as Record<string, unknown>;
  for (const field of ["batch", "roster"]) assert.equal(field in batchFields, false, field);
  const member = (result.details.items[0] ?? {}) as Record<string, unknown>;
  for (const field of ["goal", "role", "model", "warnings"]) assert.equal(field in member, false, field);
  assert.match(JSON.stringify(result.content), /01a1deac:sub_1-1/);
  assert.doesNotMatch(JSON.stringify(result.content), /fix it|fake-model|executor|roster/);

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
      callerId: "sub_01", depth: 1, allowInherited: false, maxDepth: MAX_DEPTH,
      capacityFor: () => ({ maxActiveBatches: 3, maxActiveSubagents: 8, maxActiveInheritedSubagents: 3 }),
    },
  });
  assert.ok(tools.create !== null);
  const ctx = sdkContext({ cwd: "/tmp/child" });

  await tools.create.execute("call-2", { agents: [{ goal: "nested" }] }, undefined, undefined, ctx);
  const call = host.creates[0];
  assert.ok(call !== undefined);
  assert.equal(call.options.parentAgentId, "sub_01");
  assert.equal(call.options.allowInherited, false);
  assert.equal(call.options.origin.agentId, "sub_01");

  await tools.list.execute("call-3", {}, undefined, undefined, ctx);
  assert.deepEqual(host.lists, [{ filter: {}, callerId: "sub_01" }]);
});

test("list and signal resolve the host with the current execute context", async () => {
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
  assert.deepEqual(first.lists, [{ filter: { all: true }, callerId: "main" }]);
  assert.deepEqual(second.lists, [{ filter: { id: "sub_02" }, callerId: "main" }]);

  assert.ok(tools.signal !== null);
  const result = await tools.signal.execute(
    "s1", { target: agentAddress("sub_1-1"), action: "interrupt" }, undefined, undefined, ctxA);
  assert.deepEqual(first.signals, [{ target: agentAddress("sub_1-1"), action: "interrupt", callerId: "main" }]);
  assert.deepEqual(result.details, signalResult);
});

test("msg_write rejects a non-logical target without resolving the host", async () => {
  const api = new FakeSurfaceApi();
  const seen: ExtensionContext[] = [];
  const tools = createSurfaceTools({
    api,
    resolveHost: async (ctx) => {
      seen.push(ctx);
      throw new Error("the host must not be resolved for an invalid address");
    },
    scope: ROOT_SCOPE,
  });
  const ctx = sdkContext({ cwd: "/tmp/project" });

  for (const target of ["notes.txt", "/tmp/project/.pi/sub_02.sock"]) {
    await assert.rejects(
      () => tools.msg_write.execute("m2", { to: target, content: "x" }, undefined, undefined, ctx),
      /requires a full logical Agent address/,
    );
  }
  assert.deepEqual(seen, []);
});

test("one execute resolves the host once and sends the raw logical target", async () => {
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
    { to: agentAddress("sub_1-1"), content: "once" },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(resolutions, 1);
  assert.deepEqual(first.sends, [{ from: "main", to: agentAddress("sub_1-1"), content: "once" }]);
  assert.deepEqual(second.sends, []);
  assert.equal(result.details, undefined);
});

test("concurrent managed sends keep per-execution hosts isolated", async () => {
  const api = new FakeSurfaceApi();
  const first = new RecordingHost();
  const second = new RecordingHost();
  const ctxA = sdkContext({ cwd: "/tmp/project" });
  const ctxB = sdkContext({ cwd: "/tmp/project" });
  const tools = createSurfaceTools({
    api,
    resolveHost: async (ctx) => (ctx === ctxA ? first : second),
    scope: ROOT_SCOPE,
  });

  const [a, b] = await Promise.all([
    tools.msg_write.execute("c1", { to: agentAddress("sub_1-1"), content: "first" }, undefined, undefined, ctxA),
    tools.msg_write.execute("c2", { to: agentAddress("sub_1-2"), content: "second" }, undefined, undefined, ctxB),
  ]);

  assert.deepEqual(first.sends, [{ from: "main", to: agentAddress("sub_1-1"), content: "first" }]);
  assert.deepEqual(second.sends, [{ from: "main", to: agentAddress("sub_1-2"), content: "second" }]);
  assert.equal(a.details, undefined);
  assert.equal(b.details, undefined);
});

test('create forwards its tool call id to physical model capture before pending-call removal', async () => {
  const physical = fauxProvider().getModel();
  const manager = SessionManager.inMemory("/tmp/project");
  manager.appendMessage({
    role: 'assistant', api: physical.api, provider: physical.provider, model: physical.id,
    content: [{ type: 'toolCall', id: 'spawn-physical-call', name: 'subagent_create', arguments: {} }],
    stopReason: 'toolUse', timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const ctx = {
    ...sdkContext({ cwd: "/tmp/project" }),
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
  await tools.create.execute('spawn-physical-call', { agents: [{ goal: 'inherit', inheritContext: true }] }, undefined, undefined, ctx);
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
    // A file-backed MCP backend can be recreated in the child.
    { name: "mcp__fixture__inspect", sourceInfo: { source: "local", path: "/tmp/project/extensions/mcp-backend.ts" } },
  ];
  api.active = ["read", "extension_tool", "mcp__fixture__inspect", "subagent_create"];
  const host = new RecordingHost();
  const tools = createSurfaceTools({ api, resolveHost: async () => host, scope: ROOT_SCOPE });
  assert.ok(tools.create !== null);
  const ctx = sdkContext({ cwd: "/tmp/project", systemPrompt: "PARENT PROMPT" });

  await tools.create.execute("c1", { agents: [{ goal: "inherit me" }] }, undefined, undefined, ctx);
  const call = host.creates[0];
  assert.ok(call !== undefined);
  const snapshot = call.options.captureInheritedContext();
  assert.ok(isRecord(snapshot));
  const record = snapshot;
  assert.deepEqual(record["tools"], ["read", "extension_tool", "mcp__fixture__inspect", "subagent_create"]);
  assert.equal(record["systemPrompt"], "PARENT PROMPT");
  assert.deepEqual(record["warnings"], [
    inheritedToolsWarning(["extension_tool"]),
  ], "a file-backed MCP registration travels; an extension without a loader path does not");
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

  await tools.create.execute("c1", { agents: [{ goal: "inherit" }] }, undefined, undefined, ctx);
  const call = host.creates[0];
  assert.ok(call);
  const snapshot = call.options.captureInheritedContext();
  assert.ok(isRecord(snapshot));
  assert.deepEqual(snapshot["warnings"], [
    inheritedToolsWarning(["subagent_create", "capability"]),
  ]);
});
