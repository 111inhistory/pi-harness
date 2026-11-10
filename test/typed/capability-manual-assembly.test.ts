/**
 * Manual-tool contract at the real extension boundaries.
 *
 * These cases run the installed extension handlers (`before_agent_start`,
 * `context_with_system`, `tool_call`) plus the Codemode loadout hook, because
 * the unit tests around `createToolAdmission` cannot prove the assembly honours
 * the configuration. They cover the three defects a review found:
 *
 * - a manual MCP tool with the user's branch record must pass native MCP
 *   admission;
 * - an authorized manual tool is branch authority, not request memory: it is
 *   declared and executable in Main and never reaches a child;
 * - a `defaultActive` manual tool must not be usable before that record exists.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import capabilityExtension from "../../src/capability/extension.ts";
import { CAPABILITY_TOOL_PERMISSION_RECORD } from "../../src/capability/tool-permission.ts";
import { CAPABILITY_SECTION } from "../../src/capability/prompt.ts";
import { resolveHarnessConfig } from "../../src/harness-config.ts";
import { setCapabilityParent } from "../../src/capability/scope.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

interface FakeTool {
  readonly name: string;
  readonly description?: string;
  readonly exposure?: string;
  readonly namespace?: { readonly name: string; readonly aliases?: readonly string[] };
  readonly sourceInfo?: { readonly source?: string; readonly path?: string };
}

const MANUAL = resolveHarnessConfig([
  { source: "test", value: { capability: { manualTools: ["deploy", "mcp__demo__*"] } } },
]);

/** Registration-only assembly: real extension factories, no session or provider. */
function assemble(tools: FakeTool[], active: string[]) {
  const handlers = new Map<string, Handler[]>();
  const definitions = new Map<string, ToolDefinition>();
  let activeTools = [...active];
  const entries: { customType: string; data?: unknown }[] = [];
  const registry = [...tools];
  const pi = {
    registerTool(tool: ToolDefinition) { definitions.set(tool.name, tool); },
    registerCommand() {},
    on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {}; },
    getAllTools: () => registry,
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      activeTools = names.filter((name) => registry.some((tool) => tool.name === name && tool.exposure !== "hidden"));
    },
    getSettings: () => ({ codemode: { mode: "on" } }),
    appendEntry(customType: string, data?: unknown) { entries.push({ customType, data }); },
  } as unknown as ExtensionAPI;
  capabilityExtension(pi, { discovery: false, config: MANUAL });
  return {
    pi,
    definitions,
    entries,
    active: () => [...activeTools],
    async run(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown> {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        const verdict = await handler(payload as never, ctx);
        if (verdict === undefined) continue;
        result = verdict;
        // Context handlers chain: the next handler sees the previous result.
        const messages = (verdict as { messages?: unknown }).messages;
        if (Array.isArray(messages)) (payload as { messages?: unknown }).messages = messages;
      }
      return result;
    },
    async startTurn(ctx: ExtensionContext) {
      const payload = {
        systemPromptOptions: {
          skills: [] as unknown[], selectedTools: [...activeTools], sections: {} as Record<string, string>,
        },
      };
      await this.run("before_agent_start", payload, ctx);
      return payload;
    },
  };
}

/** The branch shape the handlers read: canonical enabled entries. */
function manualBranch(names: readonly string[]): unknown[] {
  return [{
    type: "custom",
    customType: CAPABILITY_TOOL_PERMISSION_RECORD,
    data: { version: 1, set: names.map((name) => ({ target: name, state: "enabled" })) },
  }];
}

function context(branch: readonly unknown[]): ExtensionContext {
  return {
    cwd: "/tmp/project",
    sessionManager: { getBranch: () => branch, getSessionId: () => "session-1" },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

const toolContext = (branch: readonly unknown[]): ExtensionToolContext => context(branch) as unknown as ExtensionToolContext;

function blocked(verdict: unknown): boolean {
  return typeof verdict === "object" && verdict !== null && "block" in verdict && verdict.block === true;
}

const tools: FakeTool[] = [
  { name: "read", description: "Read a file", exposure: "direct", sourceInfo: { source: "builtin" } },
  { name: "deploy", description: "Deploy the service", exposure: "direct", sourceInfo: { source: "builtin" } },
  {
    name: "mcp__demo__deploy", description: "Deploy through the demo MCP server", exposure: "deferred",
    namespace: { name: "mcp__demo", aliases: ["demo"] }, sourceInfo: { source: "mcp", path: "mcp:demo/deploy" },
  },
  { name: "read_mcp_resource", description: "Read a resource", exposure: "deferred", sourceInfo: { source: "mcp", path: "mcp" } },
];

test("a default-active manual tool is not declared or callable before the user's record", async () => {
  const assembly = assemble(tools, ["read", "deploy"]);
  const ctx = context([]);

  const payload = await assembly.startTurn(ctx);
  assert.deepEqual(assembly.active(), ["read"], "an active manual tool is dropped from the loadout");
  assert.deepEqual(payload.systemPromptOptions.selectedTools, ["read"]);

  assert.equal(blocked(await assembly.run("tool_call", { toolName: "deploy" }, toolContext([]))), true,
    "the execution guard refuses it even if some other path activated it");
  assert.equal(blocked(await assembly.run("tool_call", { toolName: "read" }, toolContext([]))), false);
});

test("the user's enablement record authorizes the manual tool", async () => {
  const branch = manualBranch(["deploy"]);
  const assembly = assemble(tools, ["read", "deploy"]);
  const ctx = context(branch);

  const payload = await assembly.startTurn(ctx);
  assert.deepEqual(assembly.active(), ["read", "deploy"], "a recorded manual tool stays active");
  assert.deepEqual(payload.systemPromptOptions.selectedTools, ["read", "deploy"]);
  assert.equal(blocked(await assembly.run("tool_call", { toolName: "deploy" }, toolContext(branch))), false);
});

test("a manual MCP tool with the user's record passes native MCP admission", async () => {
  const name = "mcp__demo__deploy";
  const withoutRecord = assemble(tools, ["read", name]);
  assert.equal(blocked(await withoutRecord.run("tool_call", { toolName: name }, toolContext([]))), true,
    "an unselected MCP tool is refused by the native boundary");
  assert.deepEqual((await withoutRecord.startTurn(context([]))).systemPromptOptions.selectedTools, ["read"],
    "the native boundary removes the unselected MCP declaration");

  // The generic reader is a tool of its own; the user authorizes it explicitly.
  const branch = manualBranch([name, "read_mcp_resource"]);
  const withRecord = assemble(tools, ["read", name, "read_mcp_resource"]);
  assert.equal(blocked(await withRecord.run("tool_call", { toolName: name }, toolContext(branch))), false,
    "a manual record is a selection for native MCP admission");
  assert.deepEqual((await withRecord.startTurn(context(branch))).systemPromptOptions.selectedTools,
    ["read", name, "read_mcp_resource"]);
  assert.equal(blocked(await withRecord.run("tool_call", { toolName: "read_mcp_resource", input: { server: "demo" } },
    toolContext(branch))), false, "resource reads follow the same selected-server rule");
  assert.equal(blocked(await withRecord.run("tool_call", { toolName: "read_mcp_resource", input: { server: "other" } },
    toolContext(branch))), true);
});

test("an enabled manual tool is branch authority, not request memory, and never a child's", async () => {
  const branch = manualBranch(["deploy"]);
  const root = assemble(tools, ["read", "deploy"]);
  const head = { role: "system", content: "base", sections: { preamble: "Base" }, timestamp: 0 };
  const projected = await root.run("context_with_system", { messages: [head] }, context(branch)) as {
    messages: unknown[];
  };
  // The declaration carries the interface, so the request gains nothing: a
  // request-memory patch would change the leading system prompt, and Pi's
  // conversion folds that into the head for transports without mid-conversation
  // system messages.
  assert.deepEqual(projected.messages, [head], "a user enablement adds no request memory");

  // The record is the authority the declaration and execution checks read.
  assert.deepEqual((await root.startTurn(context(branch))).systemPromptOptions.selectedTools, ["read", "deploy"]);
  assert.equal(blocked(await root.run("tool_call", { toolName: "deploy" }, toolContext(branch))), false);

  const child = assemble(tools, ["read"]);
  setCapabilityParent(child.pi, root.pi);
  const childProjection = await child.run("context_with_system", { messages: [head] }, context(branch)) as {
    messages: { sections?: Record<string, string> }[];
  };
  assert.equal(childProjection.messages.some((message) => message.sections?.[CAPABILITY_SECTION]), false,
    "a subagent never sees the manual capability");
  assert.equal(blocked(await child.run("tool_call", { toolName: "deploy" }, toolContext(branch))), true,
    "a subagent never holds a manual tool, even with the root's record");
});

test("Codemode's callable catalog follows the same manual gate", async () => {
  const name = "mcp__demo__deploy";
  const callable = (assembly: ReturnType<typeof assemble>) => {
    const codemode = assembly.definitions.get("codemode");
    assert.ok(codemode?.prepareLoadout);
    const tool = {
      name, label: name, description: "Deploy through the demo MCP server",
      parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }),
    };
    const declared = {
      name: "codemode", label: "codemode", description: "codemode",
      parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }),
    };
    const changes = codemode.prepareLoadout({
      declared: [declared, tool], registered: [declared, tool], callable: [declared, tool],
      getExposure: () => "codemode", getNamespace: () => undefined, getPromptGuidelines: () => [],
    });
    return changes?.descriptions?.["codemode"] ?? "";
  };

  const denied = assemble(tools, [name]);
  await denied.startTurn(context([]));
  assert.doesNotMatch(callable(denied), /demo MCP server/);

  const allowed = assemble(tools, [name]);
  await allowed.startTurn(context(manualBranch([name])));
  assert.match(callable(allowed), /demo MCP server/);
});
