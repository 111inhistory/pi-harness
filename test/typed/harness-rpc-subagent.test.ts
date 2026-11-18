import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildSubagentPort } from "../../src/harness-rpc/ports/subagent.ts";
import { RpcRequestError } from "../../src/harness-rpc/error.ts";
import { formatAddress, formatChildrenAddress, formatGroupAddress } from "../../src/subagent/address.ts";
import type { RootService } from "../../src/subagent/root-service.ts";
import type { ResolvedTarget } from "../../src/subagent/managed-send.ts";
import {
  SubagentError,
  type JobRecordView,
  type JobView,
  type SignalResult,
} from "../../src/subagent/runtime.ts";

const SESSION = "01a1deac";
const actorAddress = (key: string): string => formatAddress(SESSION, key);

function jobView(jobId: string): JobView {
  return {
    jobId,
    agentId: "sub_1",
    address: actorAddress("sub_1"),
    name: null,
    parentAgentId: null,
    depth: 1,
    status: "completed",
    continuedFromJobId: null,
  } as JobView;
}

function recordWith(): JobRecordView {
  return {
    jobId: "job-1",
    agentId: "sub_1",
    name: null,
    round: 1,
    goal: "g",
    status: "completed",
    error: null,
    result: "done",
    history: { startEntryId: "a", endEntryId: "b" },
    budget: null,
    previousJobId: null,
  } as JobRecordView;
}

const api = {} as unknown as ExtensionAPI;
const ctx = {
  cwd: "/tmp/project",
  mode: "rpc",
  isProjectTrusted: () => false,
  sessionManager: { getSessionId: () => "s", getBranch: () => [] },
} as unknown as ExtensionContext;

interface RootShape {
  jobs?: JobView[];
  records?: Record<string, JobRecordView | null>;
  list?: unknown;
  create?: (batch: unknown, options: unknown, ctx: unknown) => Promise<unknown>;
  signal?: (target: string, action: string, callerId: string) => Promise<unknown>;
  resolveTarget?: (address: string) => Promise<ResolvedTarget>;
  sendMessage?: (command: unknown) => unknown;
  sendCrossSession?: (command: unknown) => unknown;
}

function makeRoot(shape: RootShape): RootService {
  return {
    sessionId: "s",
    maxDepth: 2,
    runtime: {
      jobs: () => ({ jobs: shape.jobs ?? [] }),
      jobRecord: (jobId: string) => shape.records?.[jobId] ?? null,
    },
    list: async () => shape.list ?? null,
    create: shape.create ?? (async () => ({ items: [] })),
    signal: shape.signal ?? (async (target: string) => ({
      ok: true, action: "stop", to: target, targets: [{ address: target, ok: true, status: "stopping" }],
    })),
    resolveTarget: shape.resolveTarget ?? (async () => ({ kind: "local" })),
    sendMessage: shape.sendMessage ?? (() => ({ ok: true })),
    sendCrossSession: shape.sendCrossSession ?? (async () => {}),
  } as unknown as RootService;
}

test("tree and jobs pass through the root's domain queries", async () => {
  const tree = { id: "main", children: [] };
  const port = buildSubagentPort(api, ctx, makeRoot({ list: tree }));
  assert.deepEqual(await port.tree(), tree);

  const jobsPort = buildSubagentPort(api, ctx, makeRoot({ jobs: [jobView("job-1")] }));
  assert.deepEqual(jobsPort.jobs({}).jobs.map((job) => job.jobId), ["job-1"]);
});

test("job detail returns the view plus record, and rejects an unknown job", () => {
  const record = recordWith();
  const port = buildSubagentPort(api, ctx, makeRoot({ jobs: [jobView("job-1")], records: { "job-1": record } }));
  const detail = port.job({ jobId: "job-1" });
  assert.equal(detail.job.jobId, "job-1");
  assert.deepEqual(detail.record, record);

  assert.throws(
    () => port.job({ jobId: "job-9" }),
    (error: unknown) => error instanceof RpcRequestError && error.code === "not_found",
  );
});

test("single result distinguishes not-found from not-ready and returns the record", () => {
  assert.throws(
    () => buildSubagentPort(api, ctx, makeRoot({})).result({ jobId: "job-9" }),
    (error: unknown) => error instanceof RpcRequestError && error.code === "not_found",
  );
  assert.throws(
    () => buildSubagentPort(api, ctx, makeRoot({ jobs: [jobView("job-1")], records: { "job-1": null } })).result({ jobId: "job-1" }),
    (error: unknown) => error instanceof RpcRequestError && error.code === "not_ready",
  );
  const record = recordWith();
  assert.deepEqual(
    buildSubagentPort(api, ctx, makeRoot({ jobs: [jobView("job-1")], records: { "job-1": record } })).result({ jobId: "job-1" }),
    record,
  );
});

test("create binds parent identity and origin and returns the public projection", async () => {
  const created = {
    batch: 1,
    address: formatGroupAddress(SESSION, 1),
    roster: [{ address: actorAddress("sub_1-1"), name: "parser", goal: "fix it" }],
    items: [{
      id: "sub_1-1", address: actorAddress("sub_1-1"), name: "parser", goal: "fix it",
      role: "executor", model: "fake-model",
    }],
    warnings: ["one inherited tool was dropped"],
  };
  const captured: { batch?: unknown; options?: { parentAgentId?: unknown; origin?: { mode?: unknown } } } = {};
  const root = makeRoot({
    create: async (batch, options) => {
      captured.batch = batch;
      captured.options = options as { parentAgentId?: unknown; origin?: { mode?: unknown } };
      return created;
    },
  });
  const port = buildSubagentPort(api, ctx, root);
  const params = { context: "ctx", agents: [{ name: "parser", goal: "fix it" }] };
  const result = await port.create(params);
  assert.deepEqual(result, {
    address: formatGroupAddress(SESSION, 1),
    items: [{ id: "sub_1-1", address: actorAddress("sub_1-1"), name: "parser" }],
    warnings: ["one inherited tool was dropped"],
  }, "the RPC result is the shared public projection");
  const batchFields = result as unknown as Record<string, unknown>;
  for (const field of ["batch", "roster"]) assert.equal(field in batchFields, false, field);
  const member = result.items[0] as unknown as Record<string, unknown>;
  for (const field of ["goal", "role", "model"]) assert.equal(field in member, false, field);
  assert.equal(captured.options?.parentAgentId, null);
  assert.equal(captured.options?.origin?.mode, "rpc");
  assert.deepEqual(captured.batch, params, "the declared batch is passed through unchanged");
});

test("signal binds the local Main caller and a full logical target", async () => {
  const calls: Array<{ target: string; action: string; callerId: string }> = [];
  const expected: SignalResult = {
    ok: true, action: "interrupt", to: actorAddress("sub_1-1"),
    targets: [{ address: actorAddress("sub_1-1"), ok: true, status: "running" }],
  };
  const port = buildSubagentPort(api, ctx, makeRoot({
    signal: async (target, action, callerId) => {
      calls.push({ target, action, callerId });
      return expected;
    },
  }));
  assert.deepEqual(await port.signal({ target: actorAddress("sub_1-1"), action: "interrupt" }), expected);
  assert.deepEqual(calls, [{ target: actorAddress("sub_1-1"), action: "interrupt", callerId: "main" }]);
});

test("single and group sends go through the root domain", async () => {
  let sent: { from?: unknown; to?: unknown; content?: unknown } | null = null;
  const root = makeRoot({
    resolveTarget: async () => ({ kind: "local" }),
    sendMessage: (command) => {
      sent = command as { from?: unknown; to?: unknown; content?: unknown };
      return { ok: true, to: actorAddress("sub_1-1"), jobId: "job-1" };
    },
  });
  const port = buildSubagentPort(api, ctx, root);
  const receipt = await port.send({ to: actorAddress("sub_1-1"), content: "hi" });
  assert.deepEqual(receipt, { ok: true, to: actorAddress("sub_1-1"), jobId: "job-1" });
  assert.deepEqual(sent, { from: "main", to: actorAddress("sub_1-1"), content: "hi" });
});

test("group sends, cross-session sends and foreign or non-logical targets are distinguished", async () => {
  const group = formatGroupAddress(SESSION, 2);
  const broadcast = buildSubagentPort(api, ctx, makeRoot({
    resolveTarget: async () => ({ kind: "local" }),
    sendMessage: () => ({ ok: true, to: group, sent: [{ to: actorAddress("sub_2-1"), jobId: null }], errors: [] }),
  }));
  assert.deepEqual(
    await broadcast.send({ to: group, content: "hi" }),
    { ok: true, to: group, sent: [{ to: actorAddress("sub_2-1"), jobId: null }], errors: [] },
  );

  const cross = buildSubagentPort(api, ctx, makeRoot({
    resolveTarget: async () => ({
      kind: "session",
      session: {
        sessionId: "other-session", uid: "bbbbbb", socketDir: "/tmp/sockets/bbbbbb", pid: 22,
        cwd: "/tmp/project-b", name: null, startedAt: 1,
      },
    }),
  }));
  assert.deepEqual(
    await cross.send({ to: `${SESSION}:main`, content: "hi" }),
    { ok: true, delivered: "session", to: `${SESSION}:main` },
  );

  const foreign = buildSubagentPort(api, ctx, makeRoot({
    resolveTarget: async () => ({ kind: "foreign" }),
  }));
  await assert.rejects(
    foreign.send({ to: `${SESSION}:sub_1-1`, content: "hi" }),
    (error: unknown) => error instanceof SubagentError && error.code === "invalid_target",
  );

  const unknown = buildSubagentPort(api, ctx, makeRoot({
    resolveTarget: async () => ({ kind: "unknown" }),
  }));
  await assert.rejects(
    unknown.send({ to: `${SESSION}:main`, content: "hi" }),
    (error: unknown) => error instanceof SubagentError && error.code === "unknown_session",
  );

  const notLogical = buildSubagentPort(api, ctx, makeRoot({}));
  await assert.rejects(
    notLogical.send({ to: "sub_1-1", content: "hi" }),
    (error: unknown) => error instanceof SubagentError && error.code === "invalid_target",
  );
});

test("a children address is forwarded unchanged", async () => {
  const children = formatChildrenAddress(SESSION, "sub_1");
  const seen: string[] = [];
  const port = buildSubagentPort(api, ctx, makeRoot({
    resolveTarget: async () => ({ kind: "local" }),
    sendMessage: (command) => {
      seen.push((command as { to: string }).to);
      return { ok: true, to: children, sent: [], errors: [] };
    },
  }));
  await port.send({ to: children, content: "hi" });
  assert.deepEqual(seen, [children]);
});
