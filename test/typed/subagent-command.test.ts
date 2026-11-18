/**
 * `/subagent` command contract: parsing, read-only listing and signal summaries.
 *
 * These cases use a fake service so they pin the command's own behaviour. The
 * SDK registration path is covered separately.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

import subagentExtension from "../../extensions/harness.ts";
import { installSubagentCommand, parseCommand } from "../../src/subagent/command.ts";
import type { RootService } from "../../src/subagent/root-service.ts";
import {
  SubagentError,
  type AgentView,
  type DetailedAgentItem,
  type SignalResult,
} from "../../src/subagent/runtime.ts";
import { renderSubagentList } from "../../src/subagent/status-view.ts";
import { formatAddress, MAIN_ACTOR } from "../../src/subagent/address.ts";

const actor = (agentId: string, kind: AgentView["kind"], status: AgentView["status"], depth: number): AgentView => ({
  agentId, address: `01a1958d:${agentId}`, name: null, goal: "g", batch: 1,
  parentAgentId: null, status, depth, kind,
});

/** A list node carries identity and topology only: no goal, activity or model. */
const node = (
  id: string,
  children: DetailedAgentItem[] = [],
  extra: Partial<DetailedAgentItem> = {},
): DetailedAgentItem => ({
  id, address: `01a1958d:${id}`, status: "idle", name: null, children, ...extra,
});

const tree: DetailedAgentItem = node("main", [
  node("sub_1", [
    node("sub_1_1", [], { kind: "inherited" }),
  ], { kind: "fresh", role: "executor", name: "parser", status: "running(tool-12s)" }),
  node("sub_2", [], { kind: "fresh", name: "reviewer", status: "stopped(failed)" }),
], { status: "running" });


function context(notifications: Array<{ text: string; type: string }>): ExtensionCommandContext {
  return {
    ui: { notify: (text: string, type: string = "info") => { notifications.push({ text, type }); } },
    sessionManager: { getSessionId: () => "01a1958d-0000-7000-8000-000000000000" },
  } as unknown as ExtensionCommandContext;
}

type Registered = { name: string; handler: RegisteredCommand["handler"] };

function install(service: RootService | (() => Promise<RootService>)): { handler: (raw: string, ctx: ExtensionCommandContext) => Promise<void> } {
  let command: Registered | undefined;
  const api = {
    registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      command = { name, handler: options.handler };
    },
  } as unknown as ExtensionAPI;
  const resolve = typeof service === "function" ? service : async () => service;
  installSubagentCommand(api, resolve, async () => []);
  const registered = command;
  assert.ok(registered);
  return { handler: async (raw, ctx) => { await registered.handler(raw, ctx); } };
}

test("parses the supported subcommands and rejects the rest", () => {
  assert.deepEqual(parseCommand(""), { verb: "list", all: false, id: null });
  assert.deepEqual(parseCommand("list"), { verb: "list", all: false, id: null });
  assert.deepEqual(parseCommand("list --all"), { verb: "list", all: true, id: null });
  assert.deepEqual(parseCommand("list --id sub_1"), { verb: "list", all: false, id: "sub_1" });
  assert.deepEqual(parseCommand("interrupt sub_1"), { verb: "interrupt", target: "sub_1" });
  assert.deepEqual(parseCommand("stop children"), { verb: "stop", target: "children" });
  assert.deepEqual(parseCommand("stop main"), { verb: "stop", target: "main" });
  assert.deepEqual(parseCommand("sessions"), { verb: "sessions" });
  assert.deepEqual(parseCommand("sessions connect bbbbbb"), { verb: "sessionsConnect", target: "bbbbbb" });
  assert.deepEqual(
    parseCommand("sessions  connect  01a1958d-0000-7000-8000-000000000000"),
    { verb: "sessionsConnect", target: "01a1958d-0000-7000-8000-000000000000" },
  );
  for (const raw of [
    "show", "signal sub_1 stop", "stop --all", "interrupt", "interrupt a b",
    "interrupt --all", "stop --bogus", "list --id", "list --bogus", "list --id --all",
    "sessions all", "sessions connect", "sessions connect a b", "sessions connect --all",
  ]) {
    assert.throws(
      () => parseCommand(raw),
      (error: unknown) => error instanceof SubagentError && error.code === "invalid_command_args",
      raw,
    );
  }
});

test("argument errors never resolve the root service", async () => {
  let resolved = 0;
  const { handler } = install(async () => {
    resolved += 1;
    throw new Error("must not resolve");
  });
  const notifications: Array<{ text: string; type: string }> = [];
  await handler("interrupt", context(notifications));
  assert.equal(resolved, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]?.text ?? "", /^invalid_command_args: /);
});

test("the list view reports names, addresses, kinds, roles and models", () => {
  const text = renderSubagentList({
    root: "01a1958d",
    tree,
    actors: [
      actor("sub_1", "fresh", "running", 1),
      actor("sub_1_1", "inherited", "running", 2),
      actor("sub_2", "fresh", "idle", 1),
      actor("sub_3", "inherited", "idle", 1),
    ],
    models: new Map([["sub_1", "fake-a"], ["sub_2", "fake-b"]]),
  });
  assert.match(text, /^Subagents · 01a1958d · 4 agents · 2 active \(1 fresh \/ 1 inherited\)$/m);
  assert.match(text, /^  01a1958d:sub_1 \(parser\)\s+fresh\s+executor\s+fake-a\s+running\(tool-12s\)$/m);
  assert.match(text, /^ {4}01a1958d:sub_1_1\s+inherited\s+-\s+-\s+idle$/m,
    'an undeclared label adds no placeholder and never replaces the address');
  assert.match(text, /^  01a1958d:sub_2 \(reviewer\)\s+fresh\s+-\s+fake-b\s+stopped\(failed\)$/m,
    'the declared label is shown for a terminal agent as well');
  assert.doesNotMatch(text, /sub_1_1 \(|\(\)|\(unnamed\)/, 'no synthetic name for a null label');
  assert.doesNotMatch(text, /goal|activity|thinking|tool_call|elapsed|completed/i,
    'the list never renders a goal, an activity phase or a lifecycle status');
  assert.match(text, /window shows 3 of 4$/m, 'the footer counts the hidden rows');
  assert.doesNotMatch(text, /history/i, 'the list never renders a history directory');
});

test("list resolves the windowed tree and renders it despite unhealthy persistence", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  const filters: unknown[] = [];
  const service = {
    sessionId: "01a1958d-0000-7000-8000-000000000000",
    assertCurrent: () => {},
    assertOperational: () => { throw new Error('fixture metadata write failed'); },
    list: async (filter: unknown) => {
      filters.push(filter);
      return tree;
    },
    actors: {
      get: (agentId: string) => ({ modelRef: agentId === "sub_1" ? { provider: "fake", id: "fake-model" } : null }),
    },
    runtime: {
      list: () => ({ agents: [
        actor("sub_1", "fresh", "running", 1),
        actor("sub_1_1", "inherited", "running", 2),
        actor("sub_2", "fresh", "idle", 1),
      ] }),
    },
  } as unknown as RootService;
  const { handler } = install(service);
  await handler("list --all", context(notifications));
  assert.deepEqual(filters, [{ all: true }]);
  const text = notifications[0]?.text ?? "";
  assert.match(text, /^Subagents · 01a1958d · 3 agents · 2 active/m);
  assert.match(text, /executor/);
  assert.match(text, /fake-model/, 'the CLI resolves the model from the actor identity');
  assert.match(text, /01a1958d:sub_1 \(parser\)/, 'the tree projection, not a second actor lookup, carries the label');
  assert.doesNotMatch(text, /goal|activity|thinking|tool_call|elapsed/i);
});

test("a root replaced during the listing await is not rendered", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  let reads = 0;
  const first = {
    sessionId: "01a1958d-0000-7000-8000-000000000000",
    list: async () => tree,
    assertCurrent: () => { throw new SubagentError("runtime_closed", "The root is not accepting new operations."); },
    runtime: { list: () => { reads += 1; return { agents: [] }; } },
  } as unknown as RootService;
  let resolutions = 0;
  const { handler } = install(async () => {
    resolutions += 1;
    return first;
  });
  await handler("list", context(notifications));
  assert.equal(resolutions, 1);
  assert.equal(reads, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.text, "Root changed while listing; run /subagent again.");
});

test("interrupt and stop report accepted, idle and refused targets without inventing state", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  const calls: Array<{ target: string; action: string; callerId: string }> = [];
  const results: SignalResult[] = [
    { ok: true, action: "interrupt", to: "01a1958d:sub_1", targets: [{ address: "01a1958d:sub_1", ok: true, status: "running" }] },
    { ok: true, action: "stop", to: "01a1958d:sub_2", targets: [{ address: "01a1958d:sub_2", ok: true, status: "stopping" }] },
    { ok: true, action: "stop", to: "01a1958d:sub_3", targets: [{ address: "01a1958d:sub_3", ok: true, status: "idle" }] },
    { ok: false, action: "stop", to: "01a1958d:sub_2", targets: [{ address: "01a1958d:sub_2", ok: false, status: "completed", reason: "already_finished" }] },
    { ok: false, action: "interrupt", to: "01a1958d:sub_1", targets: [{ address: "01a1958d:sub_1", ok: false, status: "running", reason: "interrupt_unsupported" }] },
  ];
  const service = {
    signal: async (target: string, action: string, callerId: string) => {
      calls.push({ target, action, callerId });
      return results.shift()!;
    },
  } as unknown as RootService;
  const { handler } = install(service);

  await handler("interrupt sub_1", context(notifications));
  await handler("stop sub_2", context(notifications));
  await handler("stop sub_3", context(notifications));
  await handler("stop sub_2", context(notifications));
  await handler("interrupt sub_1", context(notifications));

  assert.deepEqual(calls, [
    { target: "sub_1", action: "interrupt", callerId: "main" },
    { target: "sub_2", action: "stop", callerId: "main" },
    { target: "sub_3", action: "stop", callerId: "main" },
    { target: "sub_2", action: "stop", callerId: "main" },
    { target: "sub_1", action: "interrupt", callerId: "main" },
  ]);
  assert.equal(notifications[0]?.text, "Interrupted: 01a1958d:sub_1 (running)");
  assert.equal(notifications[1]?.text, "Stop requested: 01a1958d:sub_2 (stopping)");
  assert.equal(notifications[2]?.text, "01a1958d:sub_3 has no running job.");
  assert.equal(notifications[3]?.text, "01a1958d:sub_2 already finished.");
  assert.equal(notifications[4]?.text, "01a1958d:sub_1 cannot be interrupted by this execution; nothing changed.");
});

test("a children target summarizes every filtered child", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  const service = {
    signal: async () => ({
      ok: true,
      action: "stop",
      to: "01a1958d:main/children",
      targets: [
        { address: "01a1958d:sub_1", ok: true, status: "stopping" },
        { address: "01a1958d:sub_2", ok: false, status: "completed", reason: "already_finished" },
      ],
    }),
  } as unknown as RootService;
  await install(service).handler("stop children", context(notifications));
  const text = notifications[0]?.text ?? "";
  assert.match(text, /^Signal stop for 2 agent\(s\): 1 accepted, 1 refused$/m);
  assert.match(text, /requested\s+01a1958d:sub_1 \(stopping\)/);
  assert.match(text, /refused\s+01a1958d:sub_2 already finished\./);
});

test("a transitioning root is reported with its error code", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  const { handler } = install(async () => {
    throw new SubagentError("runtime_transitioning", "The root is quiescing.");
  });
  await handler("list", context(notifications));
  assert.equal(notifications[0]?.type, "error");
  assert.equal(notifications[0]?.text, "runtime_transitioning: The root is quiescing.");
});

test("connect reports the peer session and the msg_write grant", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  const targets: string[] = [];
  const session = {
    sessionId: "other-session", uid: "bbbbbb", socketDir: "/tmp/sockets/bbbbbb", pid: 22,
    cwd: "/tmp/project-b", name: "parser work", startedAt: 2,
  };
  const service = {
    connectSession: async (target: string) => {
      targets.push(target);
      return {
        session, address: "/tmp/sockets/bbbbbb/Main.sock",
        enabled: ["msg_write"], alreadyEnabled: [],
      };
    },
  } as unknown as RootService;
  await install(service).handler("sessions connect bbbbbb", context(notifications));
  assert.deepEqual(targets, ["bbbbbb"]);
  assert.equal(notifications[0]?.type, "info");
  assert.match(notifications[0]?.text ?? "", /^Connected bbbbbb \(parser work\) at \/tmp\/project-b$/m);
  assert.match(notifications[0]?.text ?? "", /^main: \/tmp\/sockets\/bbbbbb\/Main\.sock$/m);
  assert.match(notifications[0]?.text ?? "", /^msg_write: enabled$/m);
});

test("a connect lookup failure is reported with its code and appends nothing", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  const service = {
    connectSession: async () => { throw new SubagentError("session_not_found", "No live session matches zzzzzz."); },
  } as unknown as RootService;
  await install(service).handler("sessions connect zzzzzz", context(notifications));
  assert.deepEqual(notifications, [{ text: "session_not_found: No live session matches zzzzzz.", type: "error" }]);
});

test("completions offer verbs, session connect targets and target sugar without activating a service", async () => {
  type Options = Parameters<ExtensionAPI["registerCommand"]>[1];
  let options: Options | undefined;
  const api = {
    registerCommand: (_name: string, value: Options) => { options = value; },
  } as unknown as ExtensionAPI;
  let sessions = [{ sessionId: "peer-native-id", uid: "bbbbbb", socketDir: "/tmp/sockets/bbbbbb", pid: 22, cwd: "/tmp/project", name: "parser work", startedAt: 1 }];
  installSubagentCommand(api, async () => { throw new Error("completion must not activate a service"); }, async () => sessions);
  const complete = options?.getArgumentCompletions;
  assert.ok(complete);
  const values = async (raw: string): Promise<string[] | null> => {
    const items = await complete(raw);
    return items?.map(item => item.value) ?? null;
  };
  assert.deepEqual(await values("sessions "), ["sessions connect "]);
  assert.deepEqual(await values("sessions con"), ["sessions connect "]);
  assert.deepEqual(await values("sessions connect "), ["sessions connect bbbbbb"]);
  assert.deepEqual(await values("sessions connect bbb"), ["sessions connect bbbbbb"]);
  assert.deepEqual(await values("sessions connect peer-native"), ["sessions connect bbbbbb"]);
  assert.deepEqual(await values("sessions connect parser"), ["sessions connect bbbbbb"]);
  const items = await complete("sessions connect ");
  assert.match(items?.[0]?.label ?? "", /parser work/);
  assert.match(items?.[0]?.description ?? "", /\/tmp\/project/);
  sessions = [];
  assert.equal(await values("sessions connect "), null, "exited sessions disappear on the next completion read");
  assert.equal(await values("sessions unknown "), null);
  assert.deepEqual(await values("int"), ["interrupt"]);
  assert.deepEqual(await values("sto"), ["stop"]);
  assert.deepEqual(await values("interrupt "), ["interrupt children", "interrupt main"]);
  assert.deepEqual(await values("stop chi"), ["stop children"]);
  assert.equal(await values("stop sub_1"), null);
  assert.deepEqual(await values("list --a"), ["list --all"]);
});

test("the harness extension registers the subagent command", () => {
  const names: string[] = [];
  const api = {
    on: () => {},
    registerTool: () => {},
    registerCommand: (name: string) => { names.push(name); },
  } as unknown as ExtensionAPI;
  subagentExtension(api);
  assert.deepEqual(names, ["subagent"]);
});

test("sessions lists live sessions with their managed Main address and native name", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  const current = { sessionId: "current-session", uid: "aaaaaa", socketDir: "/tmp/sockets/aaaaaa", pid: 11, cwd: "/tmp/project-a", name: null, startedAt: 1 };
  const other = { sessionId: "other-session", uid: "bbbbbb", socketDir: "/tmp/sockets/bbbbbb", pid: 22, cwd: "/tmp/project-b", name: "parser work", startedAt: 2 };
  const service = {
    sessionId: "current-session",
    listSessions: async () => [current, other],
  } as unknown as RootService;
  const { handler } = install(service);
  await handler("sessions", context(notifications));
  const text = notifications[0]?.text ?? "";
  assert.match(text, /^Live sessions \(2\):/m);
  assert.match(text, /^\* aaaaaa\s+\(unnamed\)\s+pid 11\s+\/tmp\/project-a$/m);
  assert.match(text, /^ {2}bbbbbb\s+parser work\s+pid 22\s+\/tmp\/project-b$/m);
  // The displayed Main address is the logical address msg_write accepts.
  assert.ok(text.includes(`main: ${formatAddress(current.uid, MAIN_ACTOR)}`), text);
  assert.ok(text.includes(`main: ${formatAddress(other.uid, MAIN_ACTOR)}`), text);
  assert.match(text, /session other-session/);
});

test("sessions reports directory lookup failures instead of claiming no live sessions", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  const failure = new Error("ENOTDIR: not a directory, scandir '/tmp/sockets/sessions'");
  (failure as NodeJS.ErrnoException).code = "ENOTDIR";
  const service = {
    sessionId: "current-session",
    listSessions: async () => { throw failure; },
  } as unknown as RootService;
  const { handler } = install(service);
  await handler("sessions", context(notifications));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]?.text ?? "", /ENOTDIR/);
  assert.doesNotMatch(notifications[0]?.text ?? "", /none/);
});
