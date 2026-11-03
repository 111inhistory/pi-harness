/**
 * `/subagent` command contract: parsing, read-only listing and stop summaries.
 *
 * These cases use a fake service so they pin the command's own behaviour. The
 * SDK registration path is covered separately.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

import subagentExtension from "../../src/subagent/extension.ts";
import { installSubagentCommand, parseCommand } from "../../src/subagent/command.ts";
import type { RootService } from "../../src/subagent/root-service.ts";
import { SubagentError, type AgentView, type DetailedAgentItem, type JobView } from "../../src/subagent/runtime.ts";
import { renderSubagentList } from "../../src/subagent/status-view.ts";

const actor = (agentId: string, kind: AgentView["kind"], status: AgentView["status"], depth: number): AgentView => ({
  agentId, name: null, parentAgentId: null, status, depth, kind,
});

const job = (agentId: string, status: JobView["status"], calls: number): JobView => ({
  jobId: `job-${agentId}`, agentId, name: null, parentAgentId: null, depth: 1,
  status, continuedFromJobId: null,
  budget: {
    jobId: `job-${agentId}`, depth: 1, phase: "normal", modelCalls: calls, activeTimeMs: 0,
    rejectedProjectedModelCalls: null, running: true, warningTaken: false, terminal: null,
  },
});

const tree: DetailedAgentItem = {
  id: "Main", status: "running", socket: "/tmp/main.sock", children: [
    { id: "sub_01", status: "running", socket: "/tmp/sub_01.sock", kind: "fresh", children: [
      { id: "sub_01_01", status: "running", socket: "/tmp/sub_01_01.sock", kind: "inherited", children: [] },
    ] },
    { id: "sub_02", status: "stopped", socket: "/tmp/sub_02.sock", kind: "fresh", children: [] },
  ],
};

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
  installSubagentCommand(api, resolve);
  const registered = command;
  assert.ok(registered);
  return { handler: async (raw, ctx) => { await registered.handler(raw, ctx); } };
}

test("parses the supported subcommands and rejects the rest", () => {
  assert.deepEqual(parseCommand(""), { verb: "list", all: false, id: null });
  assert.deepEqual(parseCommand("list"), { verb: "list", all: false, id: null });
  assert.deepEqual(parseCommand("list --all"), { verb: "list", all: true, id: null });
  assert.deepEqual(parseCommand("list --id sub_01"), { verb: "list", all: false, id: "sub_01" });
  assert.deepEqual(parseCommand("stop sub_01"), { verb: "stop", actorId: "sub_01" });
  assert.deepEqual(parseCommand("stop --all"), { verb: "stopAll" });
  assert.deepEqual(parseCommand("sessions"), { verb: "sessions" });
  for (const raw of ["show", "stop", "stop a b", "list --id", "list --bogus", "list --id --all", "stop --bogus", "sessions all"]) {
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
  await handler("stop", context(notifications));
  assert.equal(resolved, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]?.text ?? "", /^invalid_command_args: /);
});

test("the list view reports kind, full-root counts and hidden nodes", () => {
  const text = renderSubagentList({
    root: "01a1958d",
    tree,
    actors: [
      actor("sub_01", "fresh", "running", 1),
      actor("sub_01_01", "inherited", "running", 2),
      actor("sub_02", "fresh", "idle", 1),
      actor("sub_03", "inherited", "idle", 1),
    ],
    jobs: [job("sub_01", "running", 12), job("sub_01_01", "running", 3)],
    roles: new Map([["sub_01", "executor"], ["sub_01_01", "researcher"]]),
    historyDir: "/tmp/views",
  });
  assert.match(text, /^Subagents · 01a1958d · 4 actors · 2 active \(1 fresh \/ 1 inherited\)$/m);
  assert.match(text, /● sub_01\s+d1\s+fresh\s+executor\s+running\s+12 calls/);
  assert.match(text, /  ● sub_01_01\s+d2\s+inherited\s+researcher\s+running\s+3 calls/);
  assert.match(text, /○ sub_02\s+d1\s+fresh\s+-\s+idle\s+–/);
  assert.match(text, /window shows 3 of 4 · history \/tmp\/views/);
});

test("list resolves the windowed tree and renders it", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  const filters: unknown[] = [];
  const service = {
    sessionId: "01a1958d-0000-7000-8000-000000000000",
    assertOperational: () => {},
    list: async (filter: unknown) => {
      filters.push(filter);
      return tree;
    },
    runtime: {
      list: () => ({ agents: [
        actor("sub_01", "fresh", "running", 1),
        actor("sub_01_01", "inherited", "running", 2),
        actor("sub_02", "fresh", "idle", 1),
      ] }),
      jobs: () => ({ jobs: [job("sub_01", "running", 12)] }),
    },
    actors: { get: (id: string) => (id === "sub_01" ? { roleId: "executor" } : null) },
  } as unknown as RootService;
  const { handler } = install(service);
  await handler("list --all", context(notifications));
  assert.deepEqual(filters, [{ all: true }]);
  const text = notifications[0]?.text ?? "";
  assert.match(text, /^Subagents · 01a1958d · 3 actors · 2 active/m);
  assert.match(text, /executor/);
});

test("the depth column keeps absolute depth for a filtered subtree", () => {
  const subtree: DetailedAgentItem = {
    id: "Main", status: "running", socket: "/tmp/main.sock", children: [
      { id: "sub_01_01", status: "running", socket: "/tmp/sub_01_01.sock", kind: "inherited", children: [
        { id: "sub_01_01_01", status: "running", socket: "/tmp/sub_01_01_01.sock", kind: "inherited", children: [] },
      ] },
    ],
  };
  const text = renderSubagentList({
    root: "01a1958d",
    tree: subtree,
    actors: [
      actor("sub_01_01", "inherited", "running", 2),
      actor("sub_01_01_01", "inherited", "running", 3),
    ],
    jobs: [],
    roles: new Map(),
    historyDir: null,
  });
  assert.match(text, /  ● sub_01_01\s+d2\s+inherited/);
  assert.match(text, /    ● sub_01_01_01\s+d3\s+inherited/);
});

test("a root replaced during the listing await is not rendered", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  let reads = 0;
  const first = {
    sessionId: "01a1958d-0000-7000-8000-000000000000",
    list: async () => tree,
    assertOperational: () => { throw new SubagentError("runtime_closed", "The root is not accepting new operations."); },
    runtime: { list: () => { reads += 1; return { agents: [] }; }, jobs: () => ({ jobs: [] }) },
    actors: { get: () => null },
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

test("stop reports requested and refused stops without inventing state", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  const service = {
    stop: () => ({ ok: true, id: "sub_01", status: "stopping" }),
  } as unknown as RootService;
  const { handler } = install(service);
  await handler("stop sub_01", context(notifications));
  assert.equal(notifications[0]?.text, "Stop requested: sub_01 (stopping)");

  const idle = {
    stop: () => ({ ok: true, id: "sub_03", status: "idle" }),
  } as unknown as RootService;
  await install(idle).handler("stop sub_03", context(notifications));
  assert.equal(notifications[1]?.text, "sub_03 has no running job.");

  const refused = {
    stop: () => ({ ok: false, id: "sub_02", status: "completed", reason: "already_finished" }),
  } as unknown as RootService;
  const refusedHandler = install(refused).handler;
  await refusedHandler("stop sub_02", context(notifications));
  assert.equal(notifications[2]?.text, "sub_02 already finished.");
});

test("stop --all requests every running job and summarizes immediately", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  const cancelled: string[] = [];
  const service = {
    runtime: {
      jobs: () => ({ jobs: [job("sub_01", "running", 1), job("sub_02", "running", 2), job("sub_03", "completed", 3)] }),
      cancelJob: (jobId: string) => {
        cancelled.push(jobId);
        if (jobId === "job-sub_02") throw new Error("native handle gone");
        return { ok: true, job: { jobId, status: "stopping" } };
      },
    },
  } as unknown as RootService;
  const { handler } = install(service);
  await handler("stop --all", context(notifications));
  assert.deepEqual(cancelled, ["job-sub_01", "job-sub_02"]);
  const text = notifications[0]?.text ?? "";
  assert.match(text, /^Stop results for 2 job\(s\): 1 requested, 0 refused, 1 failed$/m);
  assert.match(text, /requested\s+sub_01/);
  assert.match(text, /failed\s+sub_02: native handle gone/);
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

test("sessions lists live sessions with their cross-session addresses and marks the current one", async () => {
  const notifications: Array<{ text: string; type: string }> = [];
  const service = {
    sessionId: "current-session",
    listSessions: async () => [
      { sessionId: "current-session", uid: "aaaaaa", socketDir: "/tmp/sockets/aaaaaa", pid: 11, cwd: "/tmp/project-a", intent: "", startedAt: 1 },
      { sessionId: "other-session", uid: "bbbbbb", socketDir: "/tmp/sockets/bbbbbb", pid: 22, cwd: "/tmp/project-b", intent: "migrating the parser", startedAt: 2 },
    ],
  } as unknown as RootService;
  const { handler } = install(service);
  await handler("sessions", context(notifications));
  const text = notifications[0]?.text ?? "";
  assert.match(text, /^Live sessions \(2\):/m);
  assert.match(text, /^\* aaaaaa\s+pid 11\s+\/tmp\/project-a$/m);
  assert.match(text, /^ {2}bbbbbb\s+pid 22\s+\/tmp\/project-b$/m);
  assert.match(text, /main: session:aaaaaa/);
  assert.match(text, /main: session:bbbbbb/);
  assert.match(text, /intent: \(unset\)/);
  assert.match(text, /intent: migrating the parser/);
  assert.match(text, /session other-session/);
});
