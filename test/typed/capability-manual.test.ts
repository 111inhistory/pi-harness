/**
 * Manual capability category and the `/capability list` command.
 *
 * These cases pin the manual contract after the old `/capability enable` command
 * was retired: a manual tool is usable only when the root branch carries the
 * user's `manual` record, the request projection re-checks live permissions for
 * that category, and `list` is the only command surface left. A preauthorized
 * session is seeded with `appendManualRecord` plus the active set as a test
 * fixture; no case drives a production enablement path.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";

import {
  appendManualRecord,
  CAPABILITY_DISCOVERY_RECORD,
  discoveryRecords,
  manualEnabledTools,
} from "../../src/capability/discovery-record.ts";
import { CAPABILITY_SECTION, capabilityPromptTranscript } from "../../src/capability/prompt.ts";
import { createToolAdmission } from "../../src/capability/admission.ts";
import {
  capabilityArgumentCompletions, installCapabilityCommand, parseCapabilityCommand,
} from "../../src/capability/command.ts";
import { argumentCompletionProvider } from "../../src/autocomplete.ts";
import { createCapabilityCatalog } from "../../src/capability/catalog.ts";
import { setCapabilityParent, setCapabilityRootOnlyPolicy } from "../../src/capability/scope.ts";
import { createEligibleToolCatalog } from "../../src/capability/tool-catalog.ts";
import { activateToolNames } from "../../src/capability/activation.ts";
import { manualToolMatcher } from "../../src/capability/manual-tools.ts";
import { resolveHarnessConfig } from "../../src/harness-config.ts";

interface FakeTool {
  readonly name: string;
  readonly description?: string;
  readonly exposure?: string;
  readonly namespace?: { readonly name: string; readonly aliases?: readonly string[] };
}

interface ManualHost {
  readonly entries: { customType: string; data?: unknown }[];
  getAllTools(): readonly FakeTool[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  appendEntry(customType: string, data?: unknown): void;
  activeNames(): string[];
}

/** A host that behaves like the SDK's registry: unknown and hidden names are ignored. */
function host(tools: FakeTool[], active: string[] = [], mask: readonly string[] = []): ManualHost {
  const state = { tools: [...tools], active: new Set(active), entries: [] as { customType: string; data?: unknown }[] };
  const api: ManualHost = {
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
      state.entries.push({ customType, data });
    },
    activeNames: () => [...state.active],
  };
  if (mask.length > 0) setCapabilityParent(api, null, mask);
  return api;
}

/**
 * Test fixture, not a production path: seed the state the retired user command
 * used to write — the names in the active set plus one `manual` branch record —
 * so the admission and projection cases can start from an authorized session.
 */
function seedManualGrant(api: ManualHost, names: readonly string[]): void {
  api.setActiveTools([...new Set([...api.getActiveTools(), ...names])]);
  appendManualRecord(api, names.map((name) => ({ ref: `tool://${name}`, name, kind: "tool", status: "available" })));
}

function branchOf(entries: readonly { customType: string; data?: unknown }[]): unknown[] {
  return entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data }));
}

const tools: FakeTool[] = [
  { name: "read", description: "Read a file", exposure: "direct" },
  { name: "deck_pages", description: "List deck pages", exposure: "deferred" },
  { name: "secret", description: "Internal", exposure: "hidden" },
  { name: "mcp__git__status", description: "Show repository status", exposure: "deferred", namespace: { name: "mcp__git", aliases: ["git"] } },
  { name: "mcp__git__log", description: "Show commit log", exposure: "deferred", namespace: { name: "mcp__git", aliases: ["git"] } },
  { name: "msg_write", description: "Send a message to a child", exposure: "deferred", namespace: { name: "subagent" } },
];

test("the command line parser accepts browsing and enabling", () => {
  assert.deepEqual(parseCapabilityCommand(""), { verb: "list", filter: "" });
  assert.deepEqual(parseCapabilityCommand("  list "), { verb: "list", filter: "" });
  assert.deepEqual(parseCapabilityCommand("list mcp"), { verb: "list", category: "mcp", filter: "" });
  assert.deepEqual(parseCapabilityCommand("list tool git status"), { verb: "list", category: "tool", filter: "git status" });
  assert.deepEqual(parseCapabilityCommand("list git status"), { verb: "list", filter: "git status" });
  assert.deepEqual(parseCapabilityCommand("enable"), { verb: "enable", targets: [] });
  assert.deepEqual(parseCapabilityCommand("enable deck_pages read"), { verb: "enable", targets: ["deck_pages", "read"] });
  assert.throws(() => parseCapabilityCommand("search git"), /Unknown subcommand/);
  assert.throws(() => parseCapabilityCommand("disable read"), /Unknown subcommand/);
});

test("a manual tool needs the root session and a user record, not activation", () => {
  const root = host(tools, []);
  setCapabilityRootOnlyPolicy(root, manualToolMatcher(["deck_pages"]));
  assert.equal(createToolAdmission(root, []).admitsManual("deck_pages"), false, "registration is not authority");
  root.setActiveTools(["deck_pages"]);
  assert.equal(createToolAdmission(root, []).admits("deck_pages"), false, "an active manual tool is still unauthorized");
  assert.equal(createToolAdmission(root, []).admits("read"), true, "other tools are unaffected");

  seedManualGrant(root, ["deck_pages"]);
  const granted = branchOf(root.entries);
  assert.deepEqual([...manualEnabledTools(granted)], ["deck_pages"]);
  assert.equal(createToolAdmission(root, granted).admits("deck_pages"), true);

  const child = host(tools, []);
  setCapabilityParent(child, root);
  const childAdmission = createToolAdmission(child, granted);
  assert.equal(childAdmission.admitsManual("deck_pages"), false, "a subagent never holds a manual tool");
  assert.equal(childAdmission.admits("deck_pages"), false);
});

test("a user enablement is branch authority, never request state", () => {
  const entries: { customType: string; data?: unknown }[] = [];
  appendManualRecord({ appendEntry: (customType, data) => { entries.push({ customType, data }); } }, [
    { ref: "tool://deck_pages", name: "deck_pages", description: "List deck pages", exposure: "deferred", kind: "tool" },
  ]);
  const branch = entries.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data }));
  const records = discoveryRecords(branch);
  assert.deepEqual(records[0]?.result.manual?.map((hit) => hit.ref), ["tool://deck_pages"]);
  assert.equal(createToolAdmission(rootWith(tools), branch).admits("deck_pages"), true,
    "the record is the authority");

  // The declaration carries the interface, so projecting the authorization again
  // would only change the leading system prompt. Pi folds a mid-conversation
  // system section into that head for every transport without native support,
  // which invalidates the whole cached prefix.
  const head = [{ role: "system", content: "base", sections: { preamble: "Base" }, timestamp: 0 }];
  assert.deepEqual(capabilityPromptTranscript(head, branch, { allowsTool: () => true }), head,
    "an enablement adds no system section and no message");
  assert.deepEqual(capabilityPromptTranscript(head, branch, { allowsTool: () => false }), head,
    "a denied manual tool changes nothing either");
});

function rootWith(registered: FakeTool[]): ManualHost {
  const api = host(registered, []);
  setCapabilityRootOnlyPolicy(api, manualToolMatcher(["deck_pages"]));
  return api;
}

test("projecting the same branch twice produces the same transcript", () => {
  const branch = [{
    type: "custom", customType: CAPABILITY_DISCOVERY_RECORD,
    data: {
      version: 1, result: {
        status: "ok", tools: [], mcp: [], skills: [],
        manual: [{ ref: "tool://deck_pages", name: "deck_pages", kind: "tool" }],
        coverage: { local: "not_searched", remote: "not_searched" },
      },
    },
  }];
  const messages = [
    { role: "system", content: "base", sections: { preamble: "Base" }, timestamp: 1_793_789_005_311 },
    { role: "user", content: "first", timestamp: 1_793_789_005_311 },
    { role: "assistant", content: "ok", timestamp: 1_793_789_005_316 },
    { role: "user", content: "second", timestamp: 1_793_789_005_400 },
  ];
  const first = capabilityPromptTranscript(messages, branch, { allowsTool: () => true });
  const second = capabilityPromptTranscript(messages, branch, { allowsTool: () => true });
  assert.deepEqual(first, second);
  assert.deepEqual(first, messages, "a branch with only a user record reproduces the request exactly");
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

function install(tools: FakeTool[], active: string[] = []) {
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
    ui: {
      notify: (text: string, type: string = "info") => { notifications.push({ text, type }); },
    },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionCommandContext;
  assert.ok(registered);
  const command = registered;
  return {
    pi: pi as unknown as ExtensionAPI,
    notifications,
    entries,
    activeNames: () => [...activeNames],
    completions: async (prefix: string) => (await command.getArgumentCompletions?.(prefix)) ?? null,
    run: async (raw: string) => { await command.handler(raw, ctx); },
  };
}

test("list groups the catalog by category and server, in a stable order", async () => {
  const fixture = install(tools, ["read"]);
  setCapabilityRootOnlyPolicy(fixture.pi, manualToolMatcher(["deck_pages"]));
  await fixture.run("");
  const text = fixture.notifications[0]?.text ?? "";
  assert.match(text, /Capability · 5 tools · all categories/);
  assert.match(text, /Tools · Tools\n  ○ deck_pages  \[manual\]/);
  assert.match(text, /✔ read  \[active\]/);
  assert.match(text, /MCP servers · git\n  ○ log/);
  assert.match(text, /○ status/);
  assert.match(text, /Namespaces · subagent\n  ○ msg_write/);
  assert.doesNotMatch(text, /secret|tool:\/\/|Registered eligible/,
    "hidden tools and internal diagnostics stay out of the human view");
  assert.ok(text.indexOf("deck_pages") < text.indexOf("✔ read"), "display names sort inside a group");
  assert.ok(text.indexOf("○ log") < text.indexOf("○ status"), "MCP members sort by display name");
});

test("list filters by category and by free text, with a recoverable empty result", async () => {
  const fixture = install(tools, []);
  await fixture.run("list mcp");
  const mcp = fixture.notifications[0]?.text ?? "";
  assert.match(mcp, /MCP servers · git/);
  assert.doesNotMatch(mcp, /Tools ·|Namespaces ·/);
  await fixture.run("list namespace");
  assert.match(fixture.notifications[1]?.text ?? "", /Namespaces · subagent/);
  await fixture.run("list status");
  const filtered = fixture.notifications[2]?.text ?? "";
  assert.match(filtered, /1 matches for "status"/);
  assert.match(filtered, /status/);
  assert.doesNotMatch(filtered, /msg_write|deck_pages/);
  await fixture.run("list tool status");
  assert.match(fixture.notifications[3]?.text ?? "", /No tools match/);
  assert.match(fixture.notifications[3]?.text ?? "", /Try \/capability list/);
});

test("the user command is the one path that authorizes a manual tool", async () => {
  const fixture = install(tools, ["read"]);
  setCapabilityRootOnlyPolicy(fixture.pi, manualToolMatcher(["deck_pages"]));
  await fixture.run("enable deck_pages");
  const text = fixture.notifications[0]?.text ?? "";
  assert.match(text, /Enabled\n {2}✔ deck_pages/);
  assert.deepEqual(fixture.activeNames(), ["read", "deck_pages"], "the user's own command activates it");
  assert.equal(fixture.entries.length, 1, "one append-only authorization record");
  const branch = branchOf(fixture.entries);
  assert.deepEqual([...manualEnabledTools(branch)], ["deck_pages"]);
  assert.equal(createToolAdmission(fixture.pi, branch).admits("deck_pages"), true,
    "the command's record is what admits the tool");
  await fixture.run("list deck_pages");
  assert.match(fixture.notifications[1]?.text ?? "", /✔ deck_pages {2}\[active, manual\]/);
});

test("browsing a manual tool grants nothing", async () => {
  const fixture = install(tools, ["read"]);
  setCapabilityRootOnlyPolicy(fixture.pi, manualToolMatcher(["deck_pages"]));
  await fixture.run("list deck");
  await fixture.run("list deck_pages");
  assert.match(fixture.notifications[0]?.text ?? "", /deck_pages/);
  assert.deepEqual(fixture.activeNames(), ["read"], "no tool is activated");
  assert.deepEqual(fixture.entries, [], "no manual record is written");
  assert.equal(createToolAdmission(fixture.pi, []).admits("deck_pages"), false);
});

test("completions cover both verbs, the list categories and enable targets", async () => {
  const fixture = install(tools, []);
  assert.deepEqual((await fixture.completions(""))?.map((item) => item.value), ["list ", "enable "]);
  assert.deepEqual((await fixture.completions("li"))?.map((item) => item.value), ["list "]);
  assert.deepEqual((await fixture.completions("en"))?.map((item) => item.value), ["enable "]);
  assert.equal(await fixture.completions("se"), null, "search is not a verb");
  assert.deepEqual((await fixture.completions("list "))?.map((item) => item.value),
    ["list tool ", "list mcp ", "list namespace "]);
  assert.deepEqual((await fixture.completions("list to"))?.map((item) => item.value), ["list tool "]);
  assert.equal(await fixture.completions("list tool "), null, "the rest of a category line is a free filter");
  assert.equal(await fixture.completions("list tool gi"), null);
  assert.ok((await fixture.completions("enable "))?.some((item) => item.value === "enable deck_pages "));
});

test("a child scope's catalog never offers manual tools to list", () => {
  const rootHost = host(tools, []);
  setCapabilityRootOnlyPolicy(rootHost, manualToolMatcher(["deck_pages"]));
  const child = {
    getAllTools: () => tools,
    getActiveTools: () => [],
  };
  setCapabilityParent(child, rootHost);
  const view = createCapabilityCatalog(child as unknown as ExtensionAPI);
  assert.deepEqual(view.entries.some((entry) => entry.name === "deck_pages"), false,
    "the child list excludes manual tools even though the root lists them");
  assert.deepEqual(view.entries.map((entry) => entry.name).sort(),
    ["mcp__git__log", "mcp__git__status", "msg_write", "read"]);
  assert.deepEqual(createCapabilityCatalog(rootHost as unknown as ExtensionAPI).entries
    .some((entry) => entry.name === "deck_pages"), true, "Main keeps the manual tool browsable");
});

test("list matches a word past the display truncation", async () => {
  const catalog = [...tools, {
    name: "long_tail",
    description: `${"x".repeat(90)} TAILWORD`,
    exposure: "deferred" as const,
  }];
  const fixture = install(catalog, []);
  await fixture.run("list tailword");
  const text = fixture.notifications[0]?.text ?? "";
  assert.match(text, /1 matches for "tailword"/);
  assert.match(text, /long_tail/, "a word past the display truncation still matches");
});

test("the editor's forced Tab request reaches argument completions through the wrapper", async () => {
  const fixture = install(tools, []);
  const provider: AutocompleteProvider = new CombinedAutocompleteProvider([{
    name: "capability",
    description: "Browse the catalog",
    getArgumentCompletions: (prefix: string) => capabilityArgumentCompletions(prefix, fixture.pi),
  }], process.cwd());
  const wrapped = argumentCompletionProvider(provider, "capability");
  const signal = new AbortController().signal;

  // The command name completes with the editor's own trailing space.
  const names = await provider.getSuggestions(["/capab"], 0, 6, { signal, force: false });
  assert.ok(names);
  const commandApplied = provider.applyCompletion(["/capab"], 0, 6, names.items[0]!, names.prefix);
  assert.equal(commandApplied.lines[0], "/capability ");
  assert.equal(commandApplied.cursorCol, "/capability ".length);

  // Root cause: the editor's Tab path forces the request, and the built-in
  // provider skips slash-command arguments then.
  const forced = await provider.getSuggestions(commandApplied.lines, 0, commandApplied.cursorCol, { signal, force: true });
  assert.ok(!(forced?.items ?? []).some((item) => item.value === "list "),
    "a forced Tab never returns argument completions (it falls through to file completion)");
  const verbs = await wrapped.getSuggestions(commandApplied.lines, 0, commandApplied.cursorCol, { signal, force: true });
  assert.ok(verbs);
  assert.deepEqual(verbs.items.map((item) => item.value), ["list ", "enable "]);
  const listApplied = wrapped.applyCompletion(commandApplied.lines, 0, commandApplied.cursorCol, verbs.items[0]!, verbs.prefix);
  assert.equal(listApplied.lines[0], "/capability list ");
  assert.equal(listApplied.cursorCol, "/capability list ".length);

  const categories = await wrapped.getSuggestions(listApplied.lines, 0, listApplied.cursorCol, { signal, force: true });
  assert.ok(categories);
  assert.deepEqual(categories.items.map((item) => item.value), ["list tool ", "list mcp ", "list namespace "]);
  const toolApplied = wrapped.applyCompletion(listApplied.lines, 0, listApplied.cursorCol, categories.items[0]!, categories.prefix);
  assert.equal(toolApplied.lines[0], "/capability list tool ");
  assert.equal(await wrapped.getSuggestions(toolApplied.lines, 0, toolApplied.cursorCol, { signal, force: true }), null,
    "a free filter has no candidates, but the cursor is in the right position");
});

test("the /subagent wrapper restores its verb candidates on a forced Tab too", async () => {
  const provider: AutocompleteProvider = new CombinedAutocompleteProvider([{
    name: "subagent",
    description: "Inspect subagents",
    getArgumentCompletions: (prefix: string) => {
      const items = ["list", "stop", "sessions"]
        .filter((item) => item.startsWith(prefix.trim()))
        .map((item) => ({ value: item, label: item }));
      return items.length === 0 ? null : items;
    },
  }], process.cwd());
  const wrapped = argumentCompletionProvider(provider, "subagent");
  const signal = new AbortController().signal;
  const forced = await provider.getSuggestions(["/subagent "], 0, 10, { signal, force: true });
  assert.ok(!(forced?.items ?? []).some((item) => item.value === "list"),
    "a forced Tab never returns argument completions");
  const verbs = await wrapped.getSuggestions(["/subagent "], 0, 10, { signal, force: true });
  assert.ok(verbs);
  assert.deepEqual(verbs.items.map((item) => item.value), ["list", "stop", "sessions"]);
});

test("a manual tool is invisible to discovery and cannot be activated by it", () => {
  const api = host(tools, []);
  setCapabilityRootOnlyPolicy(api, manualToolMatcher(["deck_*"]));

  assert.deepEqual(createEligibleToolCatalog(api).names.has("deck_pages"), false, "discovery never sees it");
  assert.deepEqual(createEligibleToolCatalog(api, { includeManual: true }).names.has("deck_pages"), true,
    "the execution guard sees it");

  const refused = activateToolNames(api, ["deck_pages"]);
  assert.deepEqual(refused.skipped, [{ name: "deck_pages", reason: "manual_only" }]);
  assert.deepEqual(api.activeNames(), []);

  const enabled = activateToolNames(api, ["deck_pages"], { includeManual: true });
  assert.deepEqual(enabled.activated, ["deck_pages"]);
});

test("a child scope never holds a manual tool, even after the root authorized it", () => {
  const root = host(tools, []);
  setCapabilityRootOnlyPolicy(root, manualToolMatcher(["deck_pages"]));
  seedManualGrant(root, ["deck_pages"]);
  assert.deepEqual(root.activeNames(), ["deck_pages"]);

  const child = host(tools, []);
  setCapabilityParent(child, root);
  assert.equal(createEligibleToolCatalog(child, { includeManual: true }).names.has("deck_pages"), false,
    "an inherited or learned grant cannot qualify a manual tool below Main");
  const outcome = activateToolNames(child, ["deck_pages"], { includeManual: true });
  assert.deepEqual(outcome.skipped, [{ name: "deck_pages", reason: "not_permitted" }]);
  assert.deepEqual(child.activeNames(), []);
});

test("the manual tool list is configured per layer and validated", () => {
  const config = resolveHarnessConfig([
    { source: "global", value: { capability: { manualTools: ["deploy_prod", "mcp__prod__*"] } } },
  ]);
  assert.deepEqual(config.capability.manualTools, ["deploy_prod", "mcp__prod__*"]);
  const matcher = manualToolMatcher(config.capability.manualTools);
  assert.equal(matcher("deploy_prod"), true);
  assert.equal(matcher("mcp__prod__rotate"), true);
  assert.equal(matcher("mcp__staging__rotate"), false);

  const replaced = resolveHarnessConfig([
    { source: "global", value: { capability: { manualTools: ["a"] } } },
    { source: "project", value: { capability: { manualTools: ["b"] } } },
  ]);
  assert.deepEqual(replaced.capability.manualTools, ["b"], "a later layer replaces the list");

  for (const value of [[1], [""], "deploy_prod", { tool: "x" }]) {
    assert.throws(
      () => resolveHarnessConfig([{ source: "global", value: { capability: { manualTools: value } } }]),
      /manualTools must be an array of non-empty tool name patterns/,
      JSON.stringify(value),
    );
  }
});
