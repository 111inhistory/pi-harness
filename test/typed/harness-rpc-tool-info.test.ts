import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildToolPort } from "../../src/harness-rpc/ports/tool-info.ts";
import { RpcRequestError } from "../../src/harness-rpc/error.ts";
import { setIndependentDeclarations } from "../../src/capability/declaration-visibility.ts";

interface FakeTool {
  name: string;
  description?: string;
  parameters?: unknown;
  promptGuidelines?: string[];
  reachesTools?: boolean;
  exposure: string;
  namespace?: { name: string; aliases?: string[] };
  sourceInfo?: { source?: string };
}

interface VisibilityBus {
  emit(event: string, data?: unknown): unknown;
  on(event: string, handler: (data: unknown) => void): unknown;
}

/** A synchronous extension bus shared by two different API objects. */
function makeBus(): VisibilityBus {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(event: string, data?: unknown): unknown {
      for (const handler of handlers.get(event) ?? []) handler(data);
      return undefined;
    },
    on(event: string, handler: (data: unknown) => void): unknown {
      let set = handlers.get(event);
      if (set === undefined) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
  };
}

function makeApi(tools: FakeTool[], active: string[], branch: unknown[] = [], events?: VisibilityBus): ExtensionAPI {
  let activeSet = new Set(active);
  return {
    getAllTools: () => tools,
    getActiveTools: () => [...activeSet],
    setActiveTools: (names: string[]) => {
      activeSet = new Set(names);
    },
    appendEntry: (customType: string, data?: unknown) => {
      branch.push({ type: "custom", customType, data });
    },
    events,
  } as unknown as ExtensionAPI;
}

function seedBaseline(branch: unknown[], baseline: readonly string[] = []): void {
  branch.push({ type: "custom", customType: "capability-tool-base", data: { version: 1, baseline: [...baseline] } });
}

function makeContext(branch: unknown[] = []): ExtensionContext {
  return {
    cwd: "/tmp/project",
    mode: "rpc",
    ui: { notify() {} },
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "session-xyz", getBranch: () => branch },
  } as unknown as ExtensionContext;
}

const TOOLS: FakeTool[] = [
  { name: "read", description: "Read files", parameters: { type: "object" }, promptGuidelines: ["read it"], exposure: "direct", sourceInfo: { source: "builtin" } },
  { name: "write", description: "Write files", parameters: { type: "object" }, exposure: "direct", sourceInfo: { source: "builtin" } },
  { name: "codemode", description: "Run scripts", exposure: "direct", sourceInfo: { source: "harness" } },
  { name: "mcp__srv__query", description: "Query", exposure: "direct", namespace: { name: "mcp__srv", aliases: ["srv"] }, sourceInfo: { source: "mcp" } },
  { name: "script_only", description: "Script only", exposure: "codemode", sourceInfo: { source: "harness" } },
];

function byName<T extends { name: string }>(entries: readonly T[], name: string): T | undefined {
  return entries.find((entry) => entry.name === name);
}

test("catalog default lists current base+dynamic members with independent facts", () => {
  const branch: unknown[] = [];
  seedBaseline(branch);
  const api = makeApi(TOOLS, ["codemode"], branch);
  const port = buildToolPort(api, makeContext(branch));

  port.baseAdd({ targets: ["read", "write"] });
  port.activate({ targets: ["mcp__srv__query"] });

  const result = port.catalog({});
  assert.deepEqual(result.entries.map((entry) => entry.name).sort(), ["mcp__srv__query", "read", "write"]);

  const read = byName(result.entries, "read");
  assert.ok(read);
  assert.equal(read.registered, true);
  assert.equal(read.eligible, true);
  assert.equal(read.base, true);
  assert.equal(read.dynamic, false);
  assert.equal(read.blacklisted, false);
  assert.equal(read.activatable, false);
  assert.equal(read.usable, true);
  assert.equal(read.active, true);
  assert.deepEqual(read.blacklistSources, []);
  assert.equal(read.category, "tool");
  assert.equal(read.exposure, "direct");

  const mcp = byName(result.entries, "mcp__srv__query");
  assert.equal(mcp?.base, false);
  assert.equal(mcp?.dynamic, true);
  assert.equal(mcp?.category, "mcp");
  assert.equal(mcp?.namespace, "mcp__srv");
});

test("includeActivatable expands self-loadable tools and includeUsable filters callable tools", () => {
  const branch: unknown[] = [];
  seedBaseline(branch, ["codemode"]);
  const port = buildToolPort(makeApi(TOOLS, ["codemode"], branch), makeContext(branch));
  port.baseAdd({ targets: ["read"] });

  const defaultNames = port.catalog({}).entries.map((entry) => entry.name);
  assert.deepEqual(defaultNames, ["codemode", "read"]);

  const activatable = port.catalog({ includeActivatable: true });
  const scriptOnly = byName(activatable.entries, "script_only");
  assert.equal(scriptOnly?.activatable, true);
  assert.equal(scriptOnly?.usable, false);
  const write = byName(activatable.entries, "write");
  assert.equal(write?.activatable, true);

  const usable = port.catalog({ includeUsable: true });
  assert.equal(byName(usable.entries, "codemode")?.usable, true);
  assert.equal(byName(usable.entries, "write"), undefined,
    "--usable filters out requested but inactive base members");
  assert.equal(byName(usable.entries, "read")?.usable, true);
});

test("detail reports the same facts and rejects an unknown tool", () => {
  const branch: unknown[] = [];
  seedBaseline(branch);
  const api = makeApi(TOOLS, [], branch);
  const port = buildToolPort(api, makeContext(branch));
  port.baseAdd({ targets: ["write"] });

  const detail = port.detail({ name: "write" });
  assert.equal(detail.name, "write");
  assert.deepEqual(detail.parameters, { type: "object" });
  assert.equal(detail.registered, true);
  assert.equal(detail.base, true);
  assert.equal(detail.dynamic, false);
  assert.equal(detail.blacklisted, false);
  assert.equal(detail.activatable, false);
  assert.equal(detail.usable, true);

  assert.throws(
    () => port.detail({ name: "nope" }),
    (error: unknown) => error instanceof RpcRequestError && error.code === "not_found",
  );
});

test("base list reports sources and base remove preserves dynamic membership", () => {
  const branch: unknown[] = [];
  seedBaseline(branch);
  const api = makeApi(TOOLS, [], branch);
  const port = buildToolPort(api, makeContext(branch));

  port.baseAdd({ targets: ["write"] });
  port.activate({ targets: ["write"] });
  const listed = port.baseList();
  assert.deepEqual(listed.targets.map((entry) => entry.target.target), ["write"]);
  assert.deepEqual(listed.targets[0]?.sources, ["branch"]);
  assert.deepEqual(listed.targets[0]?.affectedTools, ["write"]);

  const removed = port.baseRemove({ targets: ["write"] });
  assert.equal(removed.action, "base-remove");
  assert.ok(api.getActiveTools().includes("write"), "dynamic membership still preserves the active tool");
  assert.deepEqual(port.catalog({}).entries.map((entry) => entry.name), ["write"]);
});

test("blacklist add removes codemode-only members, holds declared ones and notices used tools", () => {
  const branch: unknown[] = [
    { type: "message", message: { role: "toolResult", toolName: "write", isError: false } },
  ];
  seedBaseline(branch);
  const api = makeApi(TOOLS, ["write", "script_only"], branch);
  const port = buildToolPort(api, makeContext(branch));

  const added = port.blacklistAdd({ targets: ["write", "script_only"] });
  assert.equal(added.action, "blacklist-add");
  assert.ok(added.affectedTools.includes("write"));
  assert.ok(added.affectedTools.includes("script_only"));
  assert.deepEqual(added.removedActive, ["script_only"]);
  assert.equal(api.getActiveTools().includes("script_only"), false);
  assert.deepEqual(added.pendingCompaction, ["write"]);
  assert.equal(api.getActiveTools().includes("write"), true);
  assert.deepEqual(added.noticed, ["write"]);
  assert.deepEqual([...added.stillBlacklisted].sort(), ["script_only", "write"]);
  assert.deepEqual([...added.remainingSources], ["branch"]);

  const write = port.detail({ name: "write" });
  assert.equal(write.blacklisted, true);
  assert.equal(write.usable, false);
  assert.deepEqual(write.blacklistSources, ["branch"]);

  const listed = port.blacklistList();
  assert.deepEqual(listed.entries.map((entry) => entry.target.target).sort(), ["script_only", "write"]);
  assert.deepEqual(listed.entries[0]?.sources, ["branch"]);
});

test("base overrides a local blacklist while the raw ban is retained", () => {
  const branch: unknown[] = [];
  seedBaseline(branch);
  const api = makeApi(TOOLS, [], branch);
  const port = buildToolPort(api, makeContext(branch));
  port.baseAdd({ targets: ["write"] });
  port.blacklistAdd({ targets: ["write"] });

  const list = port.catalog({ includeActivatable: true, includeUsable: true });
  const write = byName(list.entries, "write");
  assert.ok(write);
  assert.equal(write.base, true);
  assert.equal(write.blacklisted, true);
  assert.equal(write.blocked, false);
  assert.equal(write.banOverridden, true);
  assert.equal(write.usable, true);
  assert.equal(port.baseList().targets.length, 1, "base membership and raw blacklist survive together");
  assert.deepEqual(port.blacklistList().entries.map((entry) => entry.target.target), ["write"]);
});

test("a namespace ban is overridden only by exact base membership", () => {
  const branch: unknown[] = [];
  seedBaseline(branch);
  const api = makeApi(TOOLS, [], branch);
  const port = buildToolPort(api, makeContext(branch));
  port.blacklistAdd({ targets: ["mcp://srv"] });

  port.activate({ targets: ["mcp__srv__query"] });
  const dynamic = port.detail({ name: "mcp__srv__query" });
  assert.equal(dynamic.blacklisted, true);
  assert.equal(dynamic.blocked, true);
  assert.equal(dynamic.banOverridden, false);

  port.baseAdd({ targets: ["mcp__srv__query"] });
  const base = port.detail({ name: "mcp__srv__query" });
  assert.equal(base.blacklisted, true, "namespace raw ban remains");
  assert.equal(base.blocked, false);
  assert.equal(base.banOverridden, true);
  assert.equal(base.usable, true);
});

test("blacklist remove restores preserved membership and reports preset contributions that remain", () => {
  const branch: unknown[] = [
    {
      type: "custom",
      customType: "preset-state",
      data: { version: 1, snapshot: { name: "strict", tools: ["write"], disabledTools: ["write"], instructions: null } },
    },
  ];
  seedBaseline(branch);
  const api = makeApi(TOOLS, [], branch);
  const port = buildToolPort(api, makeContext(branch));
  port.baseAdd({ targets: ["write"] });

  const removed = port.blacklistRemove({ targets: ["write"] });
  assert.equal(removed.action, "blacklist-remove");
  assert.deepEqual([...removed.stillBlacklisted], ["write"]);
  assert.deepEqual([...removed.remainingSources], ["preset"]);
  assert.equal(api.getActiveTools().includes("write"), true, "base overrides the retained preset ban");
  assert.deepEqual(port.blacklistList().entries.map((entry) => entry.target.target), ["write"]);
});

test("blacklist remove activates preserved base or dynamic membership and marks unrequested names", () => {
  const branch: unknown[] = [];
  seedBaseline(branch);
  const api = makeApi(TOOLS, [], branch);
  const port = buildToolPort(api, makeContext(branch));
  port.baseAdd({ targets: ["read"] });
  port.activate({ targets: ["write"] });
  port.blacklistAdd({ targets: ["read", "write"] });

  const removed = port.blacklistRemove({ targets: ["read", "write"] });
  assert.deepEqual([...removed.activated, ...removed.alreadyActive].sort(), ["read", "write"]);
  assert.deepEqual(removed.notRequested, []);
  assert.deepEqual(removed.stillBlacklisted, []);
  assert.deepEqual(removed.remainingSources, []);
  assert.ok(api.getActiveTools().includes("read"));
  assert.ok(api.getActiveTools().includes("write"));
});

test("blacklist writes read the declaration mask across extension API objects via the shared bus", () => {
  const bus = makeBus();
  const branch: unknown[] = [
    { type: "message", message: { role: "toolResult", toolName: "write", isError: false } },
  ];
  seedBaseline(branch);
  const capabilityApi = { events: bus } as unknown as ExtensionAPI;
  const rpcApi = makeApi(TOOLS, ["write"], branch, bus);
  assert.notEqual(rpcApi, capabilityApi, "the two extensions have distinct API objects");

  setIndependentDeclarations(capabilityApi, () => new Set(["read"]));

  const port = buildToolPort(rpcApi, makeContext(branch));
  const added = port.blacklistAdd({ targets: ["write"] });
  assert.ok(added.removedActive.includes("write"));
  assert.deepEqual(added.pendingCompaction, []);
  assert.equal(rpcApi.getActiveTools().includes("write"), false);
});

test("an SDK effect failure after a durable record is reported separately", () => {
  const branch: unknown[] = [];
  seedBaseline(branch);
  const api = makeApi(TOOLS, [], branch);
  const port = buildToolPort(api, makeContext(branch));
  api.setActiveTools = () => { throw new Error("sdk effect boom"); };

  const result = port.baseAdd({ targets: ["read"] });
  assert.equal(result.recordError, null);
  assert.match(result.effectError ?? "", /sdk effect boom/);
  assert.deepEqual(result.changed.map((change) => change.target), ["read"]);
  assert.ok(branch.some((entry) => (entry as { customType?: string }).customType === "capability-tool-base"));
});

test("unresolved targets are reported without changing membership", () => {
  const branch: unknown[] = [];
  seedBaseline(branch);
  const api = makeApi(TOOLS, [], branch);
  const port = buildToolPort(api, makeContext(branch));

  const result = port.baseAdd({ targets: ["missing"] });
  assert.deepEqual(result.unresolved, ["missing"]);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(port.baseList().targets, []);
});


test("container and member schema modifiers stay one raw-target batch with separate result facts", () => {
  const branch: unknown[] = [];
  seedBaseline(branch, ["codemode"]);
  branch.push({ type: "custom", customType: "codemode-mode", data: { version: 1, mode: "only" } });
  const tools: FakeTool[] = [
    { name: "read", description: "Read files", exposure: "direct" },
    { name: "codemode", description: "Run scripts", exposure: "direct" },
    { name: "msg_write", description: "Send a message", exposure: "deferred", namespace: { name: "subagent" } },
    { name: "subagent_list", description: "List children", exposure: "deferred", namespace: { name: "subagent" } },
    { name: "subagent_create", description: "Create a child", exposure: "deferred", namespace: { name: "subagent" } },
  ];
  const port = buildToolPort(makeApi(tools, ["codemode"], branch), makeContext(branch));

  const result = port.activate({
    targets: ["namespace://subagent[ns,lazy]", "msg_write", "subagent_list[no-lazy]", "-subagent_create"],
  });
  assert.equal(result.rejected, null);
  assert.deepEqual(result.selected, ["msg_write", "subagent_list"]);
  assert.deepEqual(result.noSchema, ["msg_write"]);
  assert.deepEqual(result.schema, ["subagent_list"]);
  assert.deepEqual(result.excluded, ["subagent_create"]);
  assert.equal(result.containers.length, 1);
  assert.equal(result.containers[0]?.target, "namespace://subagent");
  assert.equal(result.containers[0]?.explicit, true);
  assert.deepEqual(result.containers[0]?.members, ["msg_write", "subagent_list"]);
  const record = branch.at(-1) as { customType?: string; data?: unknown } | undefined;
  assert.equal(record?.customType, "capability-tool-dynamic");
  assert.deepEqual(record?.data, {
    version: 1,
    load: ["namespace://subagent"],
    activate: ["msg_write", "subagent_list"],
    noSchema: ["msg_write"],
    schema: ["subagent_list"],
  });

  const before = branch.length;
  const empty = port.activate({ targets: ["namespace://subagent[ns]"] });
  assert.equal(empty.rejected?.code, "container_without_members");
  assert.equal(branch.length, before, "rejection writes nothing");

  const malformed = port.activate({ targets: ["namespace://subagent[ns,lazy,no-lazy]"] });
  assert.equal(malformed.rejected?.code, "invalid_selection");
  assert.equal(branch.length, before, "malformed modifiers write nothing");

  const blacklist = port.blacklistAdd({ targets: ["namespace://subagent[lazy]"] });
  assert.equal(blacklist.rejected?.code, "selection_not_supported");
  assert.equal(branch.length, before, "blacklist rejects selection modifiers");
});
