import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildSubagentPort } from "../../src/harness-rpc/ports/subagent.ts";
import { RpcRequestError } from "../../src/harness-rpc/error.ts";
import type { RootService } from "../../src/subagent/root-service.ts";
import type { JobRecordView, JobView } from "../../src/subagent/runtime.ts";

function jobView(jobId: string): JobView {
  return {
    jobId,
    agentId: "sub_01",
    name: null,
    parentAgentId: null,
    depth: 1,
    status: "completed",
    continuedFromJobId: null,
  } as JobView;
}

function recordWith(): JobRecordView {
  return {
    jobId: "sub_01",
    agentId: "sub_01",
    name: null,
    round: 1,
    task: "t",
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
  stop?: (id: string) => unknown;
  resolveEndpoint?: (address: string) => unknown;
  sessionEndpoint?: (address: string) => unknown;
  sendMessage?: (command: unknown) => unknown;
  sendCrossSession?: (command: unknown) => unknown;
}

function makeRoot(shape: RootShape): RootService {
  return {
    maxDepth: 2,
    runtime: {
      jobs: () => ({ jobs: shape.jobs ?? [] }),
      jobRecord: (jobId: string) => shape.records?.[jobId] ?? null,
    },
    list: async () => shape.list ?? null,
    create: shape.create ?? (async () => ({ items: [] })),
    stop: shape.stop ?? (() => ({ ok: true })),
    resolveEndpoint: shape.resolveEndpoint ?? (async () => ({ isManaged: false })),
    sessionEndpoint: shape.sessionEndpoint ?? (async () => ({ kind: "local" })),
    sendMessage: shape.sendMessage ?? (() => ({ ok: true })),
    sendCrossSession: shape.sendCrossSession ?? (async () => {}),
  } as unknown as RootService;
}

test("tree and jobs pass through the root's domain queries", async () => {
  const tree = { id: "Main", children: [] };
  const port = buildSubagentPort(api, ctx, makeRoot({ list: tree }));
  assert.deepEqual(await port.tree(), tree);

  const jobsPort = buildSubagentPort(api, ctx, makeRoot({ jobs: [jobView("sub_01")] }));
  assert.deepEqual(jobsPort.jobs({}).jobs.map((job) => job.jobId), ["sub_01"]);
});

test("job detail returns the view plus record, and rejects an unknown job", () => {
  const record = recordWith();
  const port = buildSubagentPort(api, ctx, makeRoot({ jobs: [jobView("sub_01")], records: { sub_01: record } }));
  const detail = port.job({ jobId: "sub_01" });
  assert.equal(detail.job.jobId, "sub_01");
  assert.deepEqual(detail.record, record);

  assert.throws(
    () => port.job({ jobId: "sub_09" }),
    (error: unknown) => error instanceof RpcRequestError && error.code === "not_found",
  );
});

test("single result distinguishes not-found from not-ready and returns the record", () => {
  assert.throws(
    () => buildSubagentPort(api, ctx, makeRoot({})).result({ jobId: "sub_09" }),
    (error: unknown) => error instanceof RpcRequestError && error.code === "not_found",
  );
  assert.throws(
    () => buildSubagentPort(api, ctx, makeRoot({ jobs: [jobView("sub_01")], records: { sub_01: null } })).result({ jobId: "sub_01" }),
    (error: unknown) => error instanceof RpcRequestError && error.code === "not_ready",
  );
  const record = recordWith();
  assert.deepEqual(
    buildSubagentPort(api, ctx, makeRoot({ jobs: [jobView("sub_01")], records: { sub_01: record } })).result({ jobId: "sub_01" }),
    record,
  );
});

test("create binds parent identity and origin on the host side", async () => {
  const captured: { batch?: unknown; options?: { parentAgentId?: unknown; origin?: { mode?: unknown } } } = {};
  const root = makeRoot({
    create: async (batch, options) => {
      captured.batch = batch;
      captured.options = options as { parentAgentId?: unknown; origin?: { mode?: unknown } };
      return { items: [{ id: "sub_01", socket: "/tmp/sub_01.sock" }] };
    },
  });
  const port = buildSubagentPort(api, ctx, root);
  const result = await port.create({ tasks: [{ task: "do it" }], context: "ctx" });
  assert.deepEqual(result, { items: [{ id: "sub_01", socket: "/tmp/sub_01.sock" }] });
  assert.equal(captured.options?.parentAgentId, null);
  assert.equal(captured.options?.origin?.mode, "rpc");
  assert.deepEqual(captured.batch, { context: "ctx", tasks: [{ task: "do it" }] });
});

test("stop and single-recipient send go through the root domain", async () => {
  let sent: { from?: unknown; to?: unknown; content?: unknown } | null = null;
  const root = makeRoot({
    stop: (id) => ({ ok: true, id, status: "stopping" }),
    resolveEndpoint: async () => ({ isManaged: true, targetId: "sub_01" }),
    sendMessage: (command) => {
      sent = command as { from?: unknown; to?: unknown; content?: unknown };
      return { ok: true, to: "sub_01", jobId: "sub_01" };
    },
  });
  const port = buildSubagentPort(api, ctx, root);
  assert.deepEqual(port.stop({ id: "sub_01" }), { ok: true, id: "sub_01", status: "stopping" });
  const receipt = await port.send({ path: "/tmp/project/pi-session/sub_01.sock", content: "hi" });
  assert.deepEqual(receipt, { ok: true, to: "sub_01", jobId: "sub_01" });
  assert.deepEqual(sent, { from: "Main", to: "sub_01", content: "hi" });
});

test("broadcast send resolves to all, and unmanaged/foreign addresses are refused", async () => {
  const broadcast = buildSubagentPort(api, ctx, makeRoot({
    resolveEndpoint: async () => ({ isManaged: true, isBroadcast: true, parentId: "Main" }),
    sendMessage: () => ({ ok: true, to: "all", sent: [], errors: [] }),
  }));
  assert.deepEqual(
    await broadcast.send({ path: "/tmp/project/pi-session/children.sock", content: "hi" }),
    { ok: true, to: "all", sent: [], errors: [] },
  );

  const foreign = buildSubagentPort(api, ctx, makeRoot({
    resolveEndpoint: async () => ({ isManaged: false }),
    sessionEndpoint: async () => ({ kind: "foreign" }),
  }));
  await assert.rejects(
    foreign.send({ path: "/tmp/project/pi-session/Main.sock", content: "hi" }),
    (error: unknown) => error instanceof RpcRequestError && error.code === "invalid_target",
  );

  const notPath = buildSubagentPort(api, ctx, makeRoot({}));
  await assert.rejects(
    notPath.send({ path: "sub_01", content: "hi" }),
    (error: unknown) => error instanceof RpcRequestError && error.code === "invalid_request",
  );
});
