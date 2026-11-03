/**
 * Manual capability category and the `/capability` command.
 *
 * These cases pin the append-only contract: the command can enable registered
 * tools, records only what the session actually activated, and the request
 * projection re-checks live permissions for the `manual` category just like the
 * discovered ones.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

import {
  appendManualRecord,
  CAPABILITY_DISCOVERY_RECORD,
  discoveryRecords,
} from "../../src/capability/discovery-record.ts";
import { CAPABILITY_SECTION, capabilityPromptTranscript } from "../../src/capability/prompt.ts";
import { enableManualTools, type ManualEnableHost } from "../../src/capability/manual.ts";
import { parseCapabilityCommand, installCapabilityCommand } from "../../src/capability/command.ts";
import { setCapabilityParent } from "../../src/capability/scope.ts";

interface FakeTool {
  readonly name: string;
  readonly description?: string;
  readonly exposure?: string;
}

/** A host that behaves like the SDK's registry: unknown and hidden names are ignored. */
function host(tools: FakeTool[], active: string[] = [], mask: readonly string[] = []) {
  const state = { tools: [...tools], active: new Set(active), entries: [] as { customType: string; data?: unknown }[] };
  const api: ManualEnableHost & {
    readonly entries: { customType: string; data?: unknown }[];
    readonly activeNames: () => string[];
    failAppend(): void;
  } = {
    entries: state.entries,
    getAllTools: () => state.tools,
    getActiveTools: () => [...state.active],
    setActiveTools(names: string[]) {
      state.active = new Set(names.filter((name) => {
        const tool = state.tools.find((candidate) => candidate.name === name);
        return tool !== undefined && tool.exposure !== "hidden";
      }));
    },
    appendEntry(customType: string, data?: unknown) {
      if (failAppend) throw new Error("disk full");
      state.entries.push({ customType, data });
    },
    activeNames: () => [...state.active],
    failAppend() { failAppend = true; },
  };
  let failAppend = false;
  if (mask.length > 0) setCapabilityParent(api, null, mask);
  return api;
}

const tools: FakeTool[] = [
  { name: "read", description: "Read a file", exposure: "direct" },
  { name: "deck_pages", description: "List deck pages", exposure: "deferred" },
  { name: "secret", description: "Internal", exposure: "hidden" },
  { name: "mcp__git__status", description: "Show repository status", exposure: "deferred" },
];

test("the command line parser accepts only list, search and enable", () => {
  assert.deepEqual(parseCapabilityCommand(""), { verb: "list" });
  assert.deepEqual(parseCapabilityCommand("  list "), { verb: "list" });
  assert.deepEqual(parseCapabilityCommand("search git status"), { verb: "search", query: "git status" });
  assert.deepEqual(parseCapabilityCommand("enable deck_pages read"), { verb: "enable", names: ["deck_pages", "read"] });
  assert.throws(() => parseCapabilityCommand("list extra"), /takes no arguments/);
  assert.throws(() => parseCapabilityCommand("search"), /requires search text/);
  assert.throws(() => parseCapabilityCommand("enable"), /at least one tool name/);
  assert.throws(() => parseCapabilityCommand("disable read"), /Unknown subcommand/);
});

test("enablement activates and records only the tools the session really activated", () => {
  const api = host(tools, ["read"]);
  const result = enableManualTools(api, ["deck_pages", "read", "missing", "secret"]);
  assert.deepEqual(result.enabled, ["deck_pages"]);
  assert.deepEqual(result.alreadyActive, ["read"]);
  assert.deepEqual(result.skipped, [
    { name: "missing", reason: "not_registered" },
    { name: "secret", reason: "hidden" },
  ]);
  assert.equal(result.recordError, null);
  assert.deepEqual(api.activeNames().sort(), ["deck_pages", "read"]);
  assert.equal(api.entries.length, 1);
  assert.equal(api.entries[0]?.customType, CAPABILITY_DISCOVERY_RECORD);
  const record = api.entries[0]?.data as { toolCallId?: string; result: { manual: { ref: string; name: string; kind: string }[] } };
  assert.equal("toolCallId" in record, false, "a manual record is not anchored to a tool result");
  assert.deepEqual(record.result.manual.map((hit) => hit.ref), ["tool://deck_pages"]);
  assert.equal(record.result.manual[0]?.kind, "tool");
});

test("a tool outside the current qualification is refused, not activated", () => {
  const api = host(tools, [], ["mcp__git__status"]);
  const result = enableManualTools(api, ["mcp__git__status"]);
  assert.deepEqual(result.enabled, []);
  assert.deepEqual(result.skipped, [{ name: "mcp__git__status", reason: "not_permitted" }]);
  assert.deepEqual(api.activeNames(), []);
  assert.equal(api.entries.length, 0, "nothing is remembered when nothing was activated");
});

test("a repeated enable is idempotent and never removes existing memory", () => {
  const api = host(tools, []);
  enableManualTools(api, ["deck_pages"]);
  const again = enableManualTools(api, ["deck_pages"]);
  assert.deepEqual(again.enabled, []);
  assert.deepEqual(again.alreadyActive, ["deck_pages"]);
  assert.equal(api.entries.length, 1);
  assert.deepEqual(api.activeNames(), ["deck_pages"]);
});

test("a failed branch write is reported instead of claiming durable memory", () => {
  const api = host(tools, []);
  api.failAppend();
  const result = enableManualTools(api, ["deck_pages"]);
  assert.deepEqual(result.enabled, ["deck_pages"]);
  assert.match(result.recordError ?? "", /disk full/);
  assert.deepEqual(api.activeNames(), ["deck_pages"], "activation is not rolled back");
});

test("manual records project under their own category and obey live permissions", () => {
  const entries: { customType: string; data?: unknown }[] = [];
  appendManualRecord({ appendEntry: (customType, data) => { entries.push({ customType, data }); } }, [
    { ref: "tool://deck_pages", name: "deck_pages", description: "List deck pages", exposure: "deferred", kind: "tool" },
  ]);
  const branch = entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data }));
  const records = discoveryRecords(branch);
  assert.deepEqual(records[0]?.result.manual?.map((hit) => hit.ref), ["tool://deck_pages"]);

  const head = [{ role: "system", content: "base", sections: { preamble: "Base" }, timestamp: 0 }];
  const allowed = capabilityPromptTranscript(head, branch, { allowsTool: () => true });
  assert.match(allowed[0]?.sections?.[CAPABILITY_SECTION] ?? "", /"category":"manual"/);
  const denied = capabilityPromptTranscript(head, branch, { allowsTool: () => false });
  assert.equal(denied[0]?.sections?.[CAPABILITY_SECTION], undefined);
});

test("appendManualRecord refuses an empty selection", () => {
  const entries: unknown[] = [];
  assert.throws(
    () => appendManualRecord({ appendEntry: (_type, data) => { entries.push(data); } }, []),
    /at least one resource/,
  );
  assert.deepEqual(entries, []);
});

type Notification = { text: string; type: string };

function install(tools: FakeTool[], active: string[] = [], branch: unknown[] = []) {
  const notifications: Notification[] = [];
  const entries: { customType: string; data?: unknown }[] = [];
  let registered: RegisteredCommand | undefined;
  let activeNames = new Set(active);
  const registry = [...tools];
  const pi = {
    registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      registered = { name, ...options } as RegisteredCommand;
    },
    getAllTools: () => registry,
    getActiveTools: () => [...activeNames],
    setActiveTools: (names: string[]) => { activeNames = new Set(names); },
    appendEntry: (customType: string, data?: unknown) => { entries.push({ customType, data }); },
  } as unknown as ExtensionAPI;
  installCapabilityCommand(pi);
  const ctx = {
    ui: { notify: (text: string, type: string = "info") => { notifications.push({ text, type }); } },
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionCommandContext;
  assert.ok(registered);
  const command = registered;
  return {
    notifications,
    entries,
    activeNames: () => [...activeNames],
    completions: async (prefix: string) => (await command.getArgumentCompletions?.(prefix)) ?? null,    run: async (raw: string) => { await command.handler(raw, ctx); },
  };
}

test("the command lists manual memory, active tools and the eligible count", async () => {
  const branch = [
    {
      type: "custom",
      customType: CAPABILITY_DISCOVERY_RECORD,
      data: {
        version: 1,
        result: {
          status: "ok", tools: [], mcp: [], skills: [], coverage: { local: "not_searched", remote: "not_searched" },
          manual: [{ ref: "tool://deck_pages", name: "deck_pages", kind: "tool", status: "available" }],
        },
      },
    },
  ];
  const fixture = install(tools, ["read"], branch);
  await fixture.run("");
  const text = fixture.notifications[0]?.text ?? "";
  assert.match(text, /Manual capabilities \(1\):/);
  assert.match(text, /tool:\/\/deck_pages/);
  assert.match(text, /Active tools \(1\): read/);
  assert.match(text, /Registered eligible tools: 3/, "the hidden tool is not offered");
});

test("the command searches eligible tools and marks the active ones", async () => {
  const fixture = install(tools, ["read"]);
  await fixture.run("search git");
  const text = fixture.notifications[0]?.text ?? "";
  assert.match(text, /Matches for "git" \(1\)/);
  assert.match(text, /mcp__git__status/);
  assert.doesNotMatch(text, /deck_pages/);

  await fixture.run("search status");
  assert.match(fixture.notifications[1]?.text ?? "", /Show repository status/);
});

test("the command enables tools and reports every refused name", async () => {
  const fixture = install(tools, ["read"]);
  await fixture.run("enable deck_pages read missing secret");
  const text = fixture.notifications[0]?.text ?? "";
  assert.match(text, /Enabled: deck_pages/);
  assert.match(text, /Already active: read/);
  assert.match(text, /Not registered: missing/);
  assert.match(text, /Hidden: secret/);
  assert.deepEqual(fixture.activeNames().sort(), ["deck_pages", "read"]);
  assert.equal(fixture.entries.length, 1);
});

test("the command reports an invalid subcommand without touching tools", async () => {
  const fixture = install(tools, []);
  await fixture.run("disable read");
  assert.equal(fixture.notifications[0]?.type, "error");
  assert.match(fixture.notifications[0]?.text ?? "", /invalid_command_args/);
  assert.deepEqual(fixture.activeNames(), []);
});

test("completions offer subcommands, then registered names after enable", async () => {
  const fixture = install(tools, []);
  assert.deepEqual((await fixture.completions("en") ?? []).map((item) => item.value), ["enable"]);
  assert.equal(await fixture.completions("search gi"), null);
  const values = (await fixture.completions("enable de") ?? []).map((item) => item.value);
  assert.deepEqual(values, ["enable deck_pages"]);
});
