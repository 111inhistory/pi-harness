import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildToolPort } from "../../src/harness-rpc/ports/tool-info.ts";
import { RpcRequestError } from "../../src/harness-rpc/error.ts";
import { noticedToolPermissionNames } from "../../src/capability/tool-permission.ts";
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

test("catalog reports runtime facts and the four-state permission", () => {
  const port = buildToolPort(makeApi(TOOLS, ["codemode"]), makeContext());
  const result = port.catalog({});
  assert.equal(result.total, 5);

  const read = result.entries.find((entry) => entry.name === "read");
  assert.ok(read);
  assert.equal(read.registered, true);
  assert.equal(read.eligible, true);
  assert.equal(read.active, false);
  assert.equal(read.permission, "inactive");
  assert.equal(read.managed, false);
  assert.equal(read.exposure, "direct");

  const codemode = result.entries.find((entry) => entry.name === "codemode");
  // Runtime active and the derived permission state are both reported.
  assert.equal(codemode?.active, true);
  assert.equal(codemode?.permission, "active");

  const mcp = result.entries.find((entry) => entry.name === "mcp__srv__query");
  assert.equal(mcp?.category, "mcp");
  assert.equal(mcp?.namespace, "mcp__srv");
});

test("catalog filter narrows entries", () => {
  const port = buildToolPort(makeApi(TOOLS, []), makeContext());
  const result = port.catalog({ filter: "read" });
  assert.deepEqual(result.entries.map((entry) => entry.name), ["read"]);
});

test("detail returns the schema and status, and rejects an unknown tool", () => {
  const port = buildToolPort(makeApi(TOOLS, []), makeContext());
  const detail = port.detail({ name: "write" });
  assert.equal(detail.name, "write");
  assert.deepEqual(detail.parameters, { type: "object" });
  assert.equal(detail.registered, true);
  assert.equal(detail.active, false);
  assert.equal(detail.permission, "inactive");

  assert.throws(
    () => port.detail({ name: "nope" }),
    (error: unknown) => error instanceof RpcRequestError && error.code === "not_found",
  );
});

test("capability user-enable still activates a registered tool", () => {
  const api = makeApi(TOOLS, []);
  const port = buildToolPort(api, makeContext());
  const result = port.enable({ targets: ["write"] });
  assert.ok(result.enabled.includes("write"));
  assert.ok(api.getActiveTools().includes("write"));
});

test("permission disable reads the declaration mask across extension API objects via the shared bus", () => {
  const bus = makeBus();
  const branch: unknown[] = [
    { type: "message", message: { role: "toolResult", toolName: "write", isError: false } },
  ];
  const capabilityApi = { events: bus } as unknown as ExtensionAPI;
  const rpcApi = makeApi(TOOLS, ["write"], branch, bus);
  assert.notEqual(rpcApi, capabilityApi, "the two extensions have distinct API objects");

  // `write` is NOT independently declared by the native loadout; `read` is.
  setIndependentDeclarations(capabilityApi, () => new Set(["read"]));

  const port = buildToolPort(rpcApi, makeContext(branch));
  const result = port.permissionDisable({ targets: ["write"] });

  // The RPC port's own API object found the reader through the bus, so the
  // decided effect is "no independent declaration" -> removed now.
  assert.ok(result.removedActive.includes("write"));
  assert.deepEqual(result.pendingCompaction, []);
  assert.equal(rpcApi.getActiveTools().includes("write"), false);
});

test("permission query uses the shared domain and rejects an invalid expression", () => {
  const branch: unknown[] = [];
  const port = buildToolPort(makeApi(TOOLS, ["codemode"], branch), makeContext(branch));

  const byDefault = port.permissionQuery({});
  assert.equal(byDefault.scope, "branch");
  assert.equal(typeof byDefault.expression, "string");
  assert.ok(byDefault.entries.some((entry) => entry.name === "codemode" && entry.state === "active"));

  const inactive = port.permissionQuery({ expr: "inactive" });
  assert.ok(inactive.entries.some((entry) => entry.name === "read" && entry.state === "inactive"));
  assert.equal(inactive.entries.some((entry) => entry.name === "codemode"), false);

  assert.throws(
    () => port.permissionQuery({ expr: "enabled nope" }),
    (error: unknown) => error instanceof RpcRequestError && error.code === "invalid_request",
  );
});

test("permission disable drops active codemode-only tools, holds declared ones and notices used tools", () => {
  // No `events` bus: this covers the pure-domain / no-reader host, where the
  // disabled branch falls back to each tool's exposure.
  const branch: unknown[] = [
    // Evidence that `write` was actually used: a completed direct tool result.
    { type: "message", message: { role: "toolResult", toolName: "write", isError: false } },
  ];
  const api = makeApi(TOOLS, ["write", "script_only"], branch);
  const port = buildToolPort(api, makeContext(branch));

  const disabled = port.permissionDisable({ targets: ["write", "script_only"] });
  assert.equal(disabled.state, "disabled");
  assert.ok(disabled.affectedTools.includes("write"));
  assert.ok(disabled.affectedTools.includes("script_only"));
  // A Codemode-only active tool is removed from the active set immediately.
  assert.deepEqual(disabled.removedActive, ["script_only"]);
  assert.equal(api.getActiveTools().includes("script_only"), false);
  // An independently declared active tool keeps its declaration until compaction.
  assert.deepEqual(disabled.pendingCompaction, ["write"]);
  assert.equal(api.getActiveTools().includes("write"), true);
  // An enabled-and-used tool gets a model-facing notice.
  assert.deepEqual(disabled.noticed, ["write"]);
  assert.equal(noticedToolPermissionNames(branch).has("write"), true);

  // User-facing catalogues retain disabled tools so their permission can be managed.
  const entries = port.catalog({}).entries;
  for (const name of ["write", "script_only"]) {
    const entry = entries.find(item => item.name === name);
    assert.ok(entry);
    assert.equal(entry.permission, "disabled");
    assert.equal(entry.eligible, false);
  }
  assert.equal(port.detail({ name: "write" }).permission, "disabled");

  const query = port.permissionQuery({ expr: "disabled" });
  assert.deepEqual(query.entries.map((entry) => entry.name).sort(), ["script_only", "write"]);
});

test("permission enable re-admits a disabled tool and permission reset clears management", () => {
  const branch: unknown[] = [];
  const api = makeApi(TOOLS, [], branch);
  const port = buildToolPort(api, makeContext(branch));

  port.permissionDisable({ targets: ["write"] });
  assert.equal(port.catalog({}).entries.find((entry) => entry.name === "write")?.permission, "disabled");

  const enabled = port.permissionEnable({ targets: ["write"] });
  assert.equal(enabled.state, "enabled");
  assert.ok(enabled.activated.includes("write"));
  assert.equal(port.catalog({}).entries.some((entry) => entry.name === "write"), true);
  assert.equal(port.detail({ name: "write" }).permission, "enabled");

  const reset = port.permissionReset({ targets: ["write", "never_managed"] });
  assert.deepEqual(reset.reset.map((change) => change.target), ["write"]);
  assert.deepEqual(reset.notManaged, ["never_managed"]);
  // After reset the tool falls back to its runtime state (still active).
  assert.equal(port.detail({ name: "write" }).managed, false);
  assert.equal(port.detail({ name: "write" }).permission, "active");
});
