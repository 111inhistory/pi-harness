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
import { fauxProvider, normalizeContext } from '@earendil-works/pi-ai';
import type { Api, Message, Model, SystemMessage, Tool } from '@earendil-works/pi-ai';
import { stream as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { stream as streamChatCompletions } from '@earendil-works/pi-ai/api/openai-completions';
import { convertResponsesMessages } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js';
import { getAgentSocketPath, type EndpointResolverResult } from "../../src/ipc/socket.ts";
import {
  captureContextForChild,
  createSurfaceTools,
  installSessionSurface,
  SUBAGENT_NAMESPACE,
} from "../../src/subagent/surface.ts";
import { SUBAGENT_TOOL_GUIDANCE } from "../../src/subagent/tool-guidance.ts";
import { projectRecordedToolGuidance, projectToolGuidance, toolGuidanceSection } from "../../src/tool-guidance.ts";
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

/** A real managed endpoint address for this platform: a socket file or a pipe. */
const agentAddress = (id: string): string => getAgentSocketPath(id, path.join("/tmp/project", ".pi"));

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

  async sessionEndpoint(): Promise<SessionEndpoint> {
    return { kind: "local" };
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

function declaration(name: string): Tool {
  return { name, description: `${name} fixture`, parameters: { type: "object", properties: {} } };
}

function anchor(...names: string[]): SystemMessage {
  return {
    role: "system",
    content: `anchor ${names.join(",")}`,
    toolsAdded: names.map(declaration),
    timestamp: 0,
  };
}

function guidanceMessages(messages: readonly unknown[], id: string): SystemMessage[] {
  return messages.flatMap((message) => {
    if (!isRecord(message) || message.role !== "system") return [];
    const sections = message.sections;
    if (!isRecord(sections) || typeof sections[toolGuidanceSection(id)] !== "string") return [];
    return [message as unknown as SystemMessage];
  });
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

function responsesWire(messages: readonly unknown[]): readonly unknown[] {
  const model = {
    ...fauxProvider().getModel(),
    api: "openai-responses",
    provider: "offline-responses",
    id: "offline",
  } as Model<Api>;
  return convertResponsesMessages(
    model,
    normalizeContext({ messages: messages as Message[] }),
    new Set([model.provider]),
    { includeSystemPrompt: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  ) as unknown as readonly unknown[];
}

async function anthropicWire(messages: readonly unknown[]): Promise<unknown> {
  const model = {
    ...fauxProvider().getModel(),
    api: "anthropic-messages",
    provider: "offline-anthropic",
    id: "offline",
    compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
  } as Model<"anthropic-messages">;
  let captured: unknown;
  const stream = streamAnthropic(model, normalizeContext({ messages: messages as Message[] }), {
    apiKey: "offline-fixture",
    cacheRetention: "none",
    fetch: async () => { throw new Error("network access is forbidden in subagent-surface.test.ts"); },
    onPayload: (payload) => {
      captured = payload;
      throw new Error("payload captured");
    },
  });
  const result = await stream.result();
  assert.equal(result.stopReason, "error");
  return captured;
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
    "msg_write",
  ]);
  for (const tool of registered) {
    assert.equal(tool.namespace?.name, "subagent");
    assert.ok((tool.namespace?.description ?? "") !== "");
    assert.ok((tool.namespace?.instructions ?? "") !== "");
    assert.equal(tool.defaultActive, false, "Main activates messaging through the Capability/Subagent namespace");
    assert.equal(tool.promptSnippet, undefined);
    assert.equal(tool.promptGuidelines, undefined);
    assert.ok(tool.description.length > 0, "usage guidance travels in the tool declaration");
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

test("tool-owned parameter labels and descriptions stay on the prompt assets", () => {
  const asset = JSON.parse(promptText("subagent-tools.json"));
  const tools = createSurfaceTools({ api: new FakeSurfaceApi(), resolveHost: async () => new RecordingHost(), scope: ROOT_SCOPE });
  assert.ok(tools.create && tools.stop);
  assert.equal(tools.create.description, asset.create.description);
  assert.equal(tools.list.description, asset.list.description);
  assert.equal(tools.stop.description, asset.stop.description);
  assert.equal(tools.msg_write.description, asset.msg_write.description);
  assert.equal(SUBAGENT_NAMESPACE.instructions, asset.instructions, "namespace carries only common instructions");
  for (const tool of [tools.create, tools.list, tools.stop, tools.msg_write]) {
    assert.equal(tool.namespace?.instructions, asset.instructions);
    assert.equal(tool.promptSnippet, undefined);
    assert.equal(tool.promptGuidelines, undefined);
  }
  for (const text of [asset.instructions, asset.create.snippet, asset.create.guideline,
    asset.list.snippet, asset.stop.snippet, asset.msg_write.snippet, ...asset.msg_write.guidelines]) {
    assert.ok(![tools.create.description, tools.list.description, tools.stop.description, tools.msg_write.description]
      .some((description) => description.includes(text)), "guidance is projected as context, not folded into a tool description");
  }

  assert.deepEqual(SUBAGENT_TOOL_GUIDANCE.map((entry) => entry.id), ["subagent", "subagent_create", "msg_write"]);
  const common = SUBAGENT_TOOL_GUIDANCE.find((entry) => entry.id === "subagent");
  assert.ok(common);
  assert.deepEqual(common.tools, ["subagent_create", "subagent_list", "subagent_stop", "msg_write"]);
  assert.equal(common.text, asset.instructions);
  const createGuidance = SUBAGENT_TOOL_GUIDANCE.find((entry) => entry.id === "subagent_create");
  assert.ok(createGuidance);
  assert.deepEqual(createGuidance.tools, ["subagent_create"]);
  assert.equal(createGuidance.text, asset.create.guideline);
  const messageGuidance = SUBAGENT_TOOL_GUIDANCE.find((entry) => entry.id === "msg_write");
  assert.ok(messageGuidance);
  assert.deepEqual(messageGuidance.tools, ["msg_write"]);
  assert.equal(messageGuidance.text, asset.msg_write.guidelines.join("\n\n"));
  for (const guideline of asset.msg_write.guidelines) assert.ok(messageGuidance.text.includes(guideline));

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
  assert.equal(leaf.list.description, asset.list.description);
  assert.equal(leaf.list.promptSnippet, undefined);
  assert.equal(leaf.list.promptGuidelines, undefined);
});

test("tool guidance projects once at first anchors, common before specific", () => {
  const list = anchor("subagent_list");
  const create = anchor("subagent_create");
  const repeat = anchor("subagent_list");
  const projected = projectToolGuidance([list, create, repeat], SUBAGENT_TOOL_GUIDANCE);

  assert.equal(projected.length, 5);
  assert.equal(projected[0], list);
  assert.equal(projected[2], create);
  assert.equal(projected[4], repeat);
  const common = guidanceMessages(projected, "subagent");
  assert.equal(common.length, 1);
  assert.deepEqual(common[0]?.sections, {
    [toolGuidanceSection("subagent")]: SUBAGENT_TOOL_GUIDANCE[0]?.text,
  });
  assert.equal(guidanceMessages(projected, "subagent_create").length, 1);
  assert.equal(guidanceMessages(projected, "msg_write").length, 0);

  const again = projectToolGuidance(projected, SUBAGENT_TOOL_GUIDANCE);
  assert.deepEqual(again, projected, "re-projection is idempotent");
});

test("one anchor keeps table order and only section markers suppress guidance", () => {
  const all = anchor("subagent_create", "msg_write", "subagent_list");
  const projected = projectToolGuidance([all], SUBAGENT_TOOL_GUIDANCE);
  assert.equal(projected.length, 4);
  assert.deepEqual(projected.slice(1).map((message) => {
    const sections = (message as SystemMessage).sections ?? {};
    return Object.keys(sections)[0];
  }), [
    toolGuidanceSection("subagent"),
    toolGuidanceSection("subagent_create"),
    toolGuidanceSection("msg_write"),
  ]);

  const userLookalike = { role: "user", content: SUBAGENT_TOOL_GUIDANCE[0]?.text ?? "", timestamp: 1 };
  const fromUser = projectToolGuidance([userLookalike, anchor("subagent_list")], SUBAGENT_TOOL_GUIDANCE);
  assert.equal(guidanceMessages(fromUser, "subagent").length, 1, "user content cannot suppress projection");

  const inherited = {
    role: "system",
    content: "",
    sections: { [toolGuidanceSection("subagent")]: SUBAGENT_TOOL_GUIDANCE[0]?.text ?? "" },
    timestamp: 2,
  } as SystemMessage;
  const withInherited = projectToolGuidance([anchor("subagent_list"), inherited], SUBAGENT_TOOL_GUIDANCE);
  assert.equal(guidanceMessages(withInherited, "subagent").length, 1);
  assert.equal(withInherited[1], inherited, "inherited guidance keeps its position");
});

test("real serializers carry projected section text at the tail without duplication", async () => {
  const asset = JSON.parse(promptText("subagent-tools.json"));
  const list = anchor("subagent_list");
  const user = { role: "user", content: "GO", timestamp: 1 };
  const create = anchor("subagent_create");
  const first = projectToolGuidance([list, user], SUBAGENT_TOOL_GUIDANCE);
  const later = projectToolGuidance([list, user, create], SUBAGENT_TOOL_GUIDANCE);

  assert.equal(guidanceMessages(first, "subagent").length, 1);
  assert.equal(guidanceMessages(later, "subagent").length, 1);
  assert.equal(guidanceMessages(later, "subagent_create").length, 1);

  const firstWire = responsesWire(first);
  const laterWire = responsesWire(later);
  assert.deepEqual(laterWire.slice(0, firstWire.length), firstWire, "adding create leaves the list/common prefix unchanged");
  const laterJson = JSON.stringify(laterWire);
  assert.equal(occurrences(laterJson, asset.instructions), 1);
  assert.equal(occurrences(laterJson, asset.create.guideline), 1);
  assert.match(laterJson, new RegExp(toolGuidanceSection("subagent")));
  const commonIndex = laterWire.findIndex((item) => JSON.stringify(item).includes(asset.instructions));
  const createIndex = laterWire.findIndex((item) => JSON.stringify(item).includes(asset.create.guideline));
  assert.ok(commonIndex > 0 && createIndex > commonIndex, "guidance renders as later provider context");

  const anthropicJson = JSON.stringify(await anthropicWire(later));
  assert.equal(occurrences(anthropicJson, asset.instructions), 1);
  assert.equal(occurrences(anthropicJson, asset.create.guideline), 1);
  assert.match(anthropicJson, new RegExp(toolGuidanceSection("subagent")));
});

test("a later null guidance marker permits an incremental reinstatement", () => {
  const section = toolGuidanceSection('delivery');
  const text = 'Current delivery guidance';
  const native: Message[] = [
    anchor('msg_write'),
    { role: 'system', content: '', sections: { [section]: text }, timestamp: 1 },
    { role: 'system', content: '', sections: { [section]: null }, timestamp: 2 },
    { role: 'user', content: 'Continue', timestamp: 3 },
  ];
  const projected = projectToolGuidance(native, [{ id: 'delivery', tools: ['msg_write'], text }]);
  assert.deepEqual(projected.slice(0, native.length), native);
  assert.deepEqual((projected.at(-1) as SystemMessage).sections, { [section]: text });
  assert.equal(projected.length, native.length + 1, 'the null marker supersedes the earlier identical text');
});

test("recorded guidance updates preserve native Responses and Anthropic request prefixes", async () => {
  const manager = SessionManager.inMemory('/tmp/project');
  manager.appendMessage(anchor('msg_write'));
  manager.appendMessage({ role: 'user', content: 'First question', timestamp: 1 });
  const project = (target: SessionManager, text: string) => projectRecordedToolGuidance(
    target.buildSessionProjection().messages,
    [{ id: 'msg_write', tools: ['msg_write'], text }],
    {
      branch: target.getBranch(), checkpointId: null,
      appendEntry: (kind, data) => { target.appendCustomEntry(kind, data); },
    },
  );
  const answer = (timestamp: number) => manager.appendMessage({
    role: 'assistant', api: 'openai-responses', provider: 'offline-responses', model: 'offline',
    content: [{ type: 'text', text: 'Answer' }], stopReason: 'stop', timestamp,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const first = project(manager, 'Initial delivery guidance');
  answer(2);
  manager.appendMessage({ role: 'user', content: 'Second question', timestamp: 3 });
  const updated = project(manager, 'Updated delivery guidance');
  answer(4);
  manager.appendMessage({ role: 'user', content: 'Third question', timestamp: 5 });
  const later = project(manager, 'Updated delivery guidance');
  const restored = SessionManager.inMemory('/tmp/project', {}, [manager.getHeader()!, ...manager.getEntries()]);
  const resumed = project(restored, 'Updated delivery guidance');

  const firstResponses = responsesWire(first);
  const updatedResponses = responsesWire(updated);
  const laterResponses = responsesWire(later);
  assert.deepEqual(updatedResponses.slice(0, firstResponses.length), firstResponses);
  assert.deepEqual(laterResponses.slice(0, updatedResponses.length), updatedResponses,
    'the update stays before the later answer and question');
  assert.deepEqual(responsesWire(resumed), laterResponses, 'resume replays the exact recorded placements');

  const firstAnthropic = await anthropicWire(first) as { messages: unknown[]; system: unknown };
  const updatedAnthropic = await anthropicWire(updated) as { messages: unknown[]; system: unknown };
  const laterAnthropic = await anthropicWire(later) as { messages: unknown[]; system: unknown };
  const resumedAnthropic = await anthropicWire(resumed);
  assert.deepEqual(updatedAnthropic.system, firstAnthropic.system);
  assert.deepEqual(updatedAnthropic.messages.slice(0, firstAnthropic.messages.length), firstAnthropic.messages);
  assert.deepEqual(laterAnthropic.messages.slice(0, updatedAnthropic.messages.length), updatedAnthropic.messages);
  assert.deepEqual(resumedAnthropic, laterAnthropic);
});

test("real Chat Completions serialization keeps guidance through native collapse", async () => {
  const asset = JSON.parse(promptText("subagent-tools.json"));
  const projected = projectToolGuidance([
    anchor("subagent_create", "msg_write"),
  ], SUBAGENT_TOOL_GUIDANCE);
  const model = {
    ...fauxProvider().getModel(),
    api: "openai-completions",
    provider: "offline-chat",
    id: "offline",
    compat: { supportsMidConvoSystemMessages: false },
  } as Model<"openai-completions">;
  const compatBefore = structuredClone(model.compat);
  let captured: unknown;
  const stream = streamChatCompletions(model, normalizeContext({
    messages: projected as Message[],
  }), {
    apiKey: "offline-fixture",
    fetch: async () => { throw new Error("network access is forbidden in subagent-surface.test.ts"); },
    onPayload: (payload) => {
      captured = payload;
      throw new Error("payload captured");
    },
  });
  const result = await stream.result();
  assert.equal(result.stopReason, "error");
  const payload = captured as { readonly messages?: readonly unknown[]; readonly tools?: readonly unknown[] };
  const messages = payload.messages ?? [];
  assert.equal(messages.filter((message) => {
    return isRecord(message) && message.role === "system";
  }).length, 1, "Chat Completions natively folds the later guidance into the leading system message");
  const leading = JSON.stringify(messages[0]);
  for (const text of [asset.instructions, asset.create.guideline, ...asset.msg_write.guidelines]) {
    assert.ok(leading.includes(text), "the collapsed Chat request retains every projected rule");
  }
  const tools = JSON.stringify(payload.tools);
  assert.ok(tools.includes("subagent_create") && tools.includes("msg_write"));
  for (const text of [asset.instructions, asset.create.guideline, ...asset.msg_write.guidelines]) {
    assert.equal(tools.includes(text), false, "guidance stays in context, not Chat-specific tool wire");
  }
  assert.deepEqual(model.compat, compatBefore, "the native Chat adapter receives no compat mutation");
});

test("the surface registers no session management tool", () => {
  const tools = createSurfaceTools({
    api: new FakeSurfaceApi(),
    resolveHost: async () => new RecordingHost(),
    scope: { ...ROOT_SCOPE, callerId: "sub_01", depth: 1 },
  });
  assert.equal("sessions" in tools, false);
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
    { path: agentAddress("sub_02"), content: "hello agent" },
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
    { path: agentAddress("sub_02"), content: "once" },
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
    tools.msg_write.execute("c1", { path: agentAddress("sub_02"), content: "first" }, undefined, undefined, ctxA),
    tools.msg_write.execute("c2", { path: agentAddress("sub_03"), content: "second" }, undefined, undefined, ctxB),
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
