/**
 * Typed catalog helpers and the real extension paths that use them.
 *
 * The tests instrument `getAllTools` on both a child and its parent. A whole
 * filter/name-set/map operation must read each catalog a fixed number of times,
 * independent of how many tools it inspects; a per-tool
 * `capabilityAllowsTool` loop re-reads the parent once per tool.
 */

import assert from "node:assert/strict";
import test from "node:test";

import capabilityExtension from "../../extensions/capability.mjs";
import { installNativeDiscoveryBoundary } from "../../src/capability/native-discovery.ts";
import { CAPABILITY_DISCOVERY_RECORD } from "../../src/capability/discovery-record.ts";
import { capabilityAllowsTool, setCapabilityParent } from "../../src/capability/scope.ts";
import {
  createEligibleToolCatalog,
  supplySelectedToolInterfaces,
  type CapabilityInterfaceTool,
  type TypedToolCatalog,
} from "../../src/capability/tool-catalog.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface TestSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, never>>;
}

interface TestNamespace {
  readonly name: string;
  readonly aliases?: readonly string[] | undefined;
}

interface TestTool extends CapabilityInterfaceTool {
  readonly description: string;
  readonly parameters: TestSchema;
  readonly outputSchema?: TestSchema | undefined;
  readonly promptGuidelines?: readonly string[] | undefined;
  readonly namespace?: TestNamespace | undefined;
}

interface SelectionHit {
  readonly name?: string;
  readonly kind?: string;
  readonly description?: string;
  readonly parameters?: TestSchema;
  readonly outputSchema?: TestSchema;
  readonly promptGuidelines?: readonly string[];
  readonly tools?: readonly SelectionHit[];
}

interface SelectionResult {
  readonly status: string;
  readonly tools: readonly SelectionHit[];
  readonly mcp: readonly SelectionHit[];
  readonly warnings: readonly string[];
}

interface CatalogFixture {
  readonly catalog: TypedToolCatalog<TestTool>;
  readonly pi: ExtensionAPI;
  readonly calls: { count: number };
  readonly handlers: Map<string, unknown[]>;
  readonly registered: Map<string, unknown>;
  readonly active: Set<string>;
  addTools(...tools: readonly TestTool[]): void;
  setTools(...tools: readonly TestTool[]): void;
}

const OBJECT_SCHEMA: TestSchema = { type: "object", properties: {} };

function tool(name: string, description = `${name} tool`, exposure?: string): TestTool {
  return {
    name,
    description,
    parameters: OBJECT_SCHEMA,
    ...(exposure === undefined ? {} : { exposure }),
  };
}

function interfaceTool(name: string): TestTool {
  return {
    name,
    description: `${name} full description`,
    parameters: OBJECT_SCHEMA,
    outputSchema: OBJECT_SCHEMA,
    promptGuidelines: [`${name} guideline`],
    exposure: "direct",
  };
}

function fixture(initial: readonly TestTool[]): CatalogFixture {
  let tools = [...initial];
  const calls = { count: 0 };
  const handlers = new Map<string, unknown[]>();
  const registered = new Map<string, unknown>();
  const active = new Set(initial.map((entry) => entry.name));
  const catalog: TypedToolCatalog<TestTool> = {
    getAllTools(): readonly TestTool[] {
      calls.count += 1;
      return tools;
    },
  };
  const pi = {
    on(event: string, handler: unknown): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(definition: unknown): void {
      if (definition && typeof definition === "object" && "name" in definition) {
        registered.set(String(definition.name), definition);
      }
    },
    getAllTools(): readonly TestTool[] {
      calls.count += 1;
      return tools;
    },
    getActiveTools(): string[] {
      return [...active];
    },
    setActiveTools(names: string[]): void {
      active.clear();
      for (const name of names) active.add(name);
    },
    getSettings(): Record<string, unknown> {
      return {};
    },
    appendEntry(): void {},
  } as unknown as ExtensionAPI;
  return {
    catalog,
    pi,
    calls,
    handlers,
    registered,
    active,
    addTools(...next: readonly TestTool[]): void {
      tools = [...tools, ...next];
    },
    setTools(...next: readonly TestTool[]): void {
      tools = [...next];
    },
  };
}

function handlerFor(fixtureValue: CatalogFixture, event: string): (input: unknown, ctx: unknown) => unknown {
  const handlers = fixtureValue.handlers.get(event);
  const handler = handlers?.at(-1);
  assert.equal(typeof handler, "function", `${event} handler must be installed`);
  return handler as (input: unknown, ctx: unknown) => unknown;
}

function selectedBranch(...names: readonly string[]): unknown[] {
  return [{
    type: "custom",
    customType: CAPABILITY_DISCOVERY_RECORD,
    data: {
      version: 1,
      result: {
        status: "ok",
        tools: names.map((name) => ({ ref: `tool://${name}`, name, status: "available" })),
        mcp: [],
        skills: [],
        coverage: { local: "searched", remote: "not_searched" },
      },
    },
  }];
}

test("eligible catalog reads each catalog once per operation and keeps full metadata", () => {
  const read = interfaceTool("read");
  const hidden = tool("hidden", "hidden tool", "hidden");
  const denied = interfaceTool("denied");
  const root = fixture([read, hidden, denied]);
  const child = fixture([read, hidden, denied]);
  setCapabilityParent(child.catalog, root.catalog, ["denied"]);

  child.calls.count = 0;
  root.calls.count = 0;
  const visible = createEligibleToolCatalog(child.catalog);
  assert.equal(child.calls.count, 2, "scope view plus one full catalog read for the child");
  assert.equal(root.calls.count, 1, "the parent chain is enumerated once");
  assert.equal(child.calls.count + root.calls.count, 3);
  assert.deepEqual([...visible.names], ["read"]);
  assert.equal(visible.byName.get("read"), read, "the full tool record is preserved");
  assert.equal(visible.tools[0]?.description, "read full description");
  assert.equal(visible.tools[0]?.parameters, OBJECT_SCHEMA);

  const rootVisible = createEligibleToolCatalog(root.catalog);
  assert.equal(rootVisible.byName.has("hidden"), false, "hidden tools never enter an eligible catalog");
});

test("one operation's catalog reads stay linear as the tool count grows", () => {
  for (const count of [1, 20, 200]) {
    const names = Array.from({ length: count }, (_, index) => `tool_${index}`);
    const tools = names.map((name) => interfaceTool(name));
    const root = fixture(tools);
    const child = fixture(tools);
    setCapabilityParent(child.catalog, root.catalog);

    child.calls.count = 0;
    root.calls.count = 0;
    const eligible = createEligibleToolCatalog(child.catalog);
    assert.equal(eligible.tools.length, count);
    assert.equal(child.calls.count + root.calls.count, 3, `catalog size ${count} does not multiply reads`);

    child.calls.count = 0;
    root.calls.count = 0;
    for (const entry of child.catalog.getAllTools()) capabilityAllowsTool(child.catalog, entry.name);
    assert.equal(
      child.calls.count + root.calls.count,
      1 + count,
      `the single-name path repeats the parent lookup once per tool for size ${count}`,
    );
  }
});

test("selectedInterfaces supply enriches qualified metadata, preserves groups, and skips hidden or denied hits", () => {
  const read = interfaceTool("read");
  const hidden = tool("hidden", "hidden tool", "hidden");
  const denied = interfaceTool("denied");
  const root = fixture([read, hidden, denied]);
  const child = fixture([read, hidden, denied]);
  setCapabilityParent(child.catalog, root.catalog, ["denied"]);

  const result: SelectionResult = {
    status: "ok",
    tools: [
      { name: "read", kind: "tool", description: "ranking description" },
      { name: "hidden", kind: "tool" },
      { name: "denied", kind: "tool" },
      {
        name: "group",
        kind: "server",
        tools: [{ name: "read", kind: "tool" }, { name: "hidden", kind: "tool" }],
      },
    ],
    mcp: [{ name: "server", kind: "server", tools: [{ name: "read", kind: "tool" }] }],
    warnings: ["keep"],
  };

  child.calls.count = 0;
  root.calls.count = 0;
  const supplied = supplySelectedToolInterfaces(result, child.catalog);
  assert.equal(child.calls.count + root.calls.count, 3, "one view for the whole selectedInterfaces map");
  assert.equal(supplied.status, "ok");
  assert.deepEqual(supplied.warnings, ["keep"]);
  assert.equal(supplied.tools[0]?.parameters, OBJECT_SCHEMA);
  assert.equal(supplied.tools[0]?.outputSchema, OBJECT_SCHEMA);
  assert.deepEqual(supplied.tools[0]?.promptGuidelines, ["read guideline"]);
  assert.equal(supplied.tools[0]?.description, "ranking description");
  assert.equal(supplied.tools[1]?.parameters, undefined, "hidden tools keep their original hit");
  assert.equal(supplied.tools[2]?.parameters, undefined, "denied tools keep their original hit");
  assert.equal(supplied.tools[3]?.tools?.[0]?.parameters, OBJECT_SCHEMA, "nested group hits are enriched");
  assert.equal(supplied.tools[3]?.tools?.[1]?.parameters, undefined);
  assert.equal(supplied.mcp[0]?.tools?.[0]?.parameters, OBJECT_SCHEMA);
});

test("the real context_with_system handler resolves one view instead of one per tool", () => {
  const childTools = Array.from({ length: 12 }, (_, index) => interfaceTool(`child_${index}`));
  const root = fixture([...childTools, interfaceTool("parent_extra")]);
  const child = fixture(childTools);
  setCapabilityParent(child.pi, root.pi);
  capabilityExtension(child.pi, { discovery: false });
  const handler = handlerFor(child, "context_with_system");

  child.calls.count = 0;
  root.calls.count = 0;
  const projected = handler(
    { messages: [] },
    { sessionManager: { getBranch: () => [] }, model: { api: "fixture" } },
  ) as { messages: unknown[] };
  assert.deepEqual(projected.messages, []);
  assert.equal(child.calls.count, 2, "the handler reads the child once for the view and once for metadata");
  assert.equal(root.calls.count, 1);
  assert.equal(child.calls.count + root.calls.count, 3, "12 tools did not multiply the parent catalog reads");
});

test("the real tool_call guard re-resolves eligibility on each call", () => {
  const read = interfaceTool("read");
  const root = fixture([read]);
  const child = fixture([read]);
  setCapabilityParent(child.pi, root.pi);
  capabilityExtension(child.pi, { discovery: false });
  const handler = handlerFor(child, "tool_call");
  const ctx = { sessionManager: { getBranch: () => [] } };

  assert.equal(handler({ toolName: "read", input: {} }, ctx), undefined);
  setCapabilityParent(child.pi, root.pi, ["read"]);
  const blocked = handler({ toolName: "read", input: {} }, ctx) as { block?: boolean };
  assert.equal(blocked.block, true, "a denial added later is visible to the next tool call");
});

test("selectedServer resolves one scope view outside its catalog loop", () => {
  const inspect = { ...interfaceTool("mcp__fixture__inspect"), namespace: { name: "mcp__fixture", aliases: ["fixture"] } };
  const resourceRead = interfaceTool("read_mcp_resource");
  const distractors = Array.from({ length: 8 }, (_, index) => interfaceTool(`filler_${index}`));
  const tools = [inspect, resourceRead, ...distractors];
  const root = fixture(tools);
  const child = fixture(tools);
  setCapabilityParent(child.pi, root.pi);
  installNativeDiscoveryBoundary(child.pi);
  const branch = selectedBranch("read_mcp_resource", "mcp__fixture__inspect");
  const handler = handlerFor(child, "tool_call");

  child.calls.count = 0;
  root.calls.count = 0;
  const outcome = handler(
    { toolName: "read_mcp_resource", input: { server: "fixture" } },
    { sessionManager: { getBranch: () => branch } },
  );
  assert.equal(outcome, undefined, "the selected server is readable");
  assert.equal(child.calls.count, 2, "the scope view and the selectedServer loop share the child catalog");
  assert.equal(root.calls.count, 1, "the parent is enumerated once, not once per tool");
  assert.equal(child.calls.count + root.calls.count, 3);
});
