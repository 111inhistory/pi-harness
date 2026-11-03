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

import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand, Theme } from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider, CURSOR_MARKER, getKeybindings, type AutocompleteProvider,
  type Component, type Focusable, type KeybindingsManager,
} from "@earendil-works/pi-tui";

import {
  appendManualRecord,
  CAPABILITY_DISCOVERY_RECORD,
  discoveryRecords,
  manualEnabledTools,
} from "../../src/capability/discovery-record.ts";
import { CAPABILITY_SECTION, capabilityPromptTranscript } from "../../src/capability/prompt.ts";
import { enableManualTools, type ManualEnableHost } from "../../src/capability/manual.ts";
import { createToolAdmission } from "../../src/capability/admission.ts";
import {
  capabilityArgumentCompletions, installCapabilityCommand, parseCapabilityCommand,
} from "../../src/capability/command.ts";
import { argumentCompletionProvider } from "../../src/autocomplete.ts";
import { createCapabilityCatalog } from "../../src/capability/catalog.ts";
import { createCapabilitySelector } from "../../src/capability/selector.ts";
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
  { name: "mcp__git__status", description: "Show repository status", exposure: "deferred", namespace: { name: "mcp__git", aliases: ["git"] } },
  { name: "mcp__git__log", description: "Show commit log", exposure: "deferred", namespace: { name: "mcp__git", aliases: ["git"] } },
  { name: "msg_write", description: "Send a message to a child", exposure: "deferred", namespace: { name: "subagent" } },
];

test("the command line parser accepts only list and enable", () => {
  assert.deepEqual(parseCapabilityCommand(""), { verb: "list", filter: "" });
  assert.deepEqual(parseCapabilityCommand("  list "), { verb: "list", filter: "" });
  assert.deepEqual(parseCapabilityCommand("list mcp"), { verb: "list", category: "mcp", filter: "" });
  assert.deepEqual(parseCapabilityCommand("list tool git status"), { verb: "list", category: "tool", filter: "git status" });
  assert.deepEqual(parseCapabilityCommand("list git status"), { verb: "list", filter: "git status" });
  assert.deepEqual(parseCapabilityCommand("enable"), { verb: "enable", names: [] });
  assert.deepEqual(parseCapabilityCommand("enable deck_pages read"), { verb: "enable", names: ["deck_pages", "read"] });
  assert.throws(() => parseCapabilityCommand("search git"), /Unknown subcommand/);
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
  const again = enableManualTools(api, ["deck_pages"], { recorded: new Set(["deck_pages"]) });
  assert.deepEqual(again.enabled, []);
  assert.deepEqual(again.alreadyActive, ["deck_pages"]);
  assert.equal(api.entries.length, 1, "an already recorded tool is not recorded again");
  assert.deepEqual(api.activeNames(), ["deck_pages"]);
});

test("an already-active manual tool is authorized by the user command", () => {
  const api = host(tools, ["deck_pages"]);
  setCapabilityRootOnlyPolicy(api, manualToolMatcher(["deck_pages"]));
  const result = enableManualTools(api, ["deck_pages"]);
  assert.deepEqual(result.enabled, ["deck_pages"], "activation alone never authorizes a manual tool");
  assert.deepEqual(result.alreadyActive, ["deck_pages"]);
  assert.equal(api.entries.length, 1);
  const record = api.entries[0]?.data as { result: { manual: { name: string }[] } };
  assert.deepEqual(record.result.manual.map((hit) => hit.name), ["deck_pages"]);
});

test("manual usage needs the root session and a user enablement record", () => {
  const root = host(tools, []);
  setCapabilityRootOnlyPolicy(root, manualToolMatcher(["deck_pages"]));
  const branch: unknown[] = [];
  const before = createToolAdmission(root, branch);
  assert.equal(before.admitsManual("deck_pages"), false, "active or registered alone is not authority");
  assert.equal(before.admits("read"), true, "other tools are unaffected");

  enableManualTools(root, ["deck_pages"]);
  const record = root.entries[0]?.data;
  const enabledBranch = [{ type: "custom", customType: CAPABILITY_DISCOVERY_RECORD, data: record }];
  assert.deepEqual([...manualEnabledTools(enabledBranch)], ["deck_pages"]);
  assert.equal(createToolAdmission(root, enabledBranch).admits("deck_pages"), true);

  const child = host(tools, []);
  setCapabilityParent(child, root);
  const childAdmission = createToolAdmission(child, enabledBranch);
  assert.equal(childAdmission.admitsManual("deck_pages"), false, "a subagent never holds a manual tool");
  assert.equal(childAdmission.admits("deck_pages"), false);
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

interface InstallOptions {
  readonly mode?: "tui" | "rpc" | "print";
  readonly custom?: (factory: unknown) => Promise<unknown>;
}

function install(tools: FakeTool[], active: string[] = [], branch: unknown[] = [], options: InstallOptions = {}) {
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
    mode: options.mode ?? "tui",
    ui: {
      notify: (text: string, type: string = "info") => { notifications.push({ text, type }); },
      custom: (factory: unknown) => options.custom === undefined
        ? Promise.reject(new Error("no custom UI in this fixture"))
        : options.custom(factory),
    },
    sessionManager: { getBranch: () => branch },
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

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

/** Run the picker through the real component and return what the user chose. */
function drivePicker(keys: readonly string[]): (factory: unknown) => Promise<unknown> {
  return async (factory: unknown) => {
    let resolve!: (value: unknown) => void;
    const result = new Promise<unknown>((done) => { resolve = done; });
    const component = (factory as (
      tui: unknown, theme: Theme, keybindings: KeybindingsManager, done: (value: unknown) => void,
    ) => Component)(undefined, theme, getKeybindings(), resolve);
    for (const key of keys) component.handleInput?.(key);
    return result;
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

test("completions cover verbs, list categories and enable names, including trailing spaces", async () => {
  const fixture = install(tools, []);
  assert.deepEqual((await fixture.completions(""))?.map((item) => item.value), ["list ", "enable "]);
  assert.deepEqual((await fixture.completions("li"))?.map((item) => item.value), ["list "]);
  assert.equal(await fixture.completions("se"), null, "search is gone");
  assert.deepEqual((await fixture.completions("list "))?.map((item) => item.value),
    ["list tool ", "list mcp ", "list namespace "]);
  assert.deepEqual((await fixture.completions("list to"))?.map((item) => item.value), ["list tool "]);
  assert.equal(await fixture.completions("list tool "), null, "the rest of a category line is a free filter");
  assert.equal(await fixture.completions("list tool gi"), null);
  assert.deepEqual((await fixture.completions("enable "))?.map((item) => item.label),
    ["deck_pages", "read", "mcp__git__log", "mcp__git__status", "msg_write"]);
  assert.deepEqual((await fixture.completions("enable de"))?.map((item) => item.value), ["enable deck_pages "]);
  assert.deepEqual((await fixture.completions("enable deck_pages "))?.map((item) => item.label),
    ["read", "mcp__git__log", "mcp__git__status", "msg_write"]);
  assert.deepEqual((await fixture.completions("enable deck_pages re"))?.map((item) => item.value),
    ["enable deck_pages read "]);
});

test("enable without a name opens the native picker and enables the chosen tool", async () => {
  const fixture = install(tools, [], [], {
    mode: "tui",
    custom: drivePicker([...Array.from("stat"), "\r"]),
  });
  await fixture.run("enable");
  assert.match(fixture.notifications.at(-1)?.text ?? "", /Enabled: mcp__git__status/);
  assert.deepEqual(fixture.activeNames(), ["mcp__git__status"]);
  assert.equal(fixture.entries.length, 1, "the explicit selection is recorded once");
});

test("the picker is a native filterable list: typing narrows it, Enter selects", async () => {
  let rendered = "";
  const fixture = install(tools, [], [], {
    mode: "tui",
    custom: async (factory: unknown) => {
      let resolve!: (value: unknown) => void;
      const result = new Promise<unknown>((done) => { resolve = done; });
      const component = (factory as (
        tui: unknown, theme: Theme, keybindings: KeybindingsManager, done: (value: unknown) => void,
      ) => Component)(undefined, theme, getKeybindings(), resolve);
      const initial = component.render(100).join("\n");
      assert.match(initial, /Enable a capability/);
      assert.match(initial, /○ status/);
      assert.match(initial, /git · Show repository status/);
      assert.match(initial, /\[manual\]|○ deck_pages/, "manual tools are browsable in the picker");
      for (const key of "log") component.handleInput?.(key);
      rendered = component.render(100).join("\n");
      component.handleInput?.("\r");
      return result;
    },
  });
  await fixture.run("enable");
  assert.match(rendered, /log/);
  assert.doesNotMatch(rendered, /status/);
  assert.match(fixture.notifications.at(-1)?.text ?? "", /Enabled: mcp__git__log/);
});

test("Esc closes the picker without activating or recording anything", async () => {
  const fixture = install(tools, [], [], { mode: "tui", custom: drivePicker(["\x1b"]) });
  await fixture.run("enable");
  assert.deepEqual(fixture.activeNames(), []);
  assert.equal(fixture.entries.length, 0);
  assert.match(fixture.notifications.at(-1)?.text ?? "", /Cancelled/);
});

test("enable without a name reports the terminal UI requirement instead of guessing", async () => {
  const fixture = install(tools, [], [], { mode: "print" });
  await fixture.run("enable");
  assert.deepEqual(fixture.activeNames(), []);
  assert.equal(fixture.entries.length, 0);
  assert.match(fixture.notifications[0]?.text ?? "", /needs the terminal UI/);
});

test("a child scope's catalog never offers manual tools to list or the picker", () => {
  const rootHost = host(tools, []);
  setCapabilityRootOnlyPolicy(rootHost, manualToolMatcher(["deck_pages"]));
  const child = {
    getAllTools: () => tools,
    getActiveTools: () => [],
  };
  setCapabilityParent(child, rootHost);
  const view = createCapabilityCatalog(child as unknown as ExtensionAPI);
  assert.deepEqual(view.entries.some((entry) => entry.name === "deck_pages"), false,
    "the child list and picker exclude manual tools even though the root lists them");
  assert.deepEqual(view.entries.map((entry) => entry.name).sort(),
    ["mcp__git__log", "mcp__git__status", "msg_write", "read"]);
  assert.deepEqual(createCapabilityCatalog(rootHost as unknown as ExtensionAPI).entries
    .some((entry) => entry.name === "deck_pages"), true, "Main keeps the manual tool browsable");
});

test("list and the picker share one filter rule, including the description tail", async () => {
  const catalog = [...tools, {
    name: "long_tail",
    description: `${"x".repeat(90)} TAILWORD`,
    exposure: "deferred" as const,
  }];
  const listFixture = install(catalog, []);
  await listFixture.run("list tailword");
  assert.match(listFixture.notifications[0]?.text ?? "", /1 matches for "tailword"/);
  const fixture = install(catalog, [], [], {
    mode: "tui",
    custom: async (factory: unknown) => {
      let resolve!: (value: unknown) => void;
      const result = new Promise<unknown>((done) => { resolve = done; });
      const component = (factory as (
        tui: unknown, theme: Theme, keybindings: KeybindingsManager, done: (value: unknown) => void,
      ) => Component)(undefined, theme, getKeybindings(), resolve);
      for (const key of "tailword") component.handleInput?.(key);
      assert.match(component.render(120).join("\n"), /long_tail/,
        "a word past the display truncation still matches in the picker");
      component.handleInput?.("\r");
      return result;
    },
  });
  await fixture.run("enable");
  assert.match(fixture.notifications.at(-1)?.text ?? "", /Enabled: long_tail/);
});

test("an empty filter shows the same full catalog in list and the picker", async () => {
  const fixture = install(tools, []);
  await fixture.run("list");
  const listText = fixture.notifications[0]?.text ?? "";
  const entries = createCapabilityCatalog(fixture.pi).entries;
  assert.equal(entries.length, 5, "hidden tools stay out of both views");
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const entry of entries) {
    assert.match(listText, new RegExp(escape(entry.display)), `list shows ${entry.display}`);
  }
  const component = createCapabilitySelector(entries, theme, getKeybindings(), () => {});
  const rendered = component.render(120).join("\n");
  for (const entry of entries) {
    assert.match(rendered, new RegExp(escape(entry.display)), `the picker shows ${entry.display}`);
  }
});

test("the picker forwards focus to its input and re-themes on render", () => {
  const entries = createCapabilityCatalog(install(tools, []).pi).entries;
  let accent = "A";
  const liveTheme = {
    fg: (color: string, text: string) => (color === "accent" ? `${accent}${text}` : text),
    bold: (text: string) => text,
  } as unknown as Theme;
  const component = createCapabilitySelector(entries, liveTheme, getKeybindings(), () => {}) as Component & Focusable;
  assert.equal(component.focused, false);
  component.focused = true;
  assert.equal(component.focused, true, "focus reaches the wrapped input");
  assert.ok(component.render(100).some((line) => line.includes(CURSOR_MARKER)),
    "the focused input renders its cursor marker for IME positioning");
  assert.match(component.render(100).join("\n"), /AEnable a capability/);
  accent = "B";
  assert.match(component.render(100).join("\n"), /BEnable a capability/,
    "themed text is rebuilt on render, not frozen in constructor state");
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

  // Enable keeps the name shortcut and appends further names after a space.
  const enableApplied = wrapped.applyCompletion(["/capability enable "], 0, "/capability enable ".length,
    { value: "enable deck_pages ", label: "deck_pages" }, "enable ");
  assert.equal(enableApplied.lines[0], "/capability enable deck_pages ");
  const more = await wrapped.getSuggestions(enableApplied.lines, 0, enableApplied.cursorCol, { signal, force: true });
  assert.ok(more);
  assert.ok(more.items.some((item) => item.value === "enable deck_pages read "));
  assert.ok(!more.items.some((item) => item.value.startsWith("enable deck_pages deck_pages")),
    "an already chosen name is excluded");
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
    "the user command and the execution guard see it");

  const refused = activateToolNames(api, ["deck_pages"]);
  assert.deepEqual(refused.skipped, [{ name: "deck_pages", reason: "manual_only" }]);
  assert.deepEqual(api.activeNames(), []);

  const enabled = activateToolNames(api, ["deck_pages"], { includeManual: true });
  assert.deepEqual(enabled.activated, ["deck_pages"]);
});

test("a child scope never holds a manual tool, even after the root enabled it", () => {
  const root = host(tools, []);
  setCapabilityRootOnlyPolicy(root, manualToolMatcher(["deck_pages"]));
  enableManualTools(root, ["deck_pages"]);
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
