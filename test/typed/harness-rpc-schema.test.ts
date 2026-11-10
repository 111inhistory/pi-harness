/**
 * Schema conformance for the Harness RPC endpoint.
 *
 * The fixtures are the real ports (tool, subagent, history, stream) driven by
 * real domain objects where possible; the assertions check the produced
 * results and event payloads against `schemas/harness-rpc.schema.json`'s
 * definitions. This is the implementation-side check that the published schema
 * describes what the router actually returns.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';

import { createRouter, type RouterDeps } from '../../src/harness-rpc/router.ts';
import type { RpcHandler } from '../../src/harness-rpc/transport.ts';
import type { RpcConnection } from '../../src/harness-rpc/transport.ts';
import { buildToolPort, type ToolPort } from '../../src/harness-rpc/ports/tool-info.ts';
import { buildSubagentPort } from '../../src/harness-rpc/ports/subagent.ts';
import { buildHistoryPort } from '../../src/harness-rpc/ports/history.ts';
import { buildStreamPort } from '../../src/harness-rpc/ports/stream.ts';
import { RPC_METHODS, type RpcMethod } from '../../src/harness-rpc/protocol.ts';
import { HARNESS_RPC_METHOD_SCHEMAS, harnessRpcSchemaRef } from '../../src/harness-rpc/schema.ts';
import { RpcRequestError } from '../../src/harness-rpc/error.ts';
import { createSubagentRuntime, type JobRequest, type JobRecordView, type JobView, type SubagentRuntime } from '../../src/subagent/runtime.ts';
import type { RootService } from '../../src/subagent/root-service.ts';
import type { NativeLiveSnapshot } from '../../src/subagent/native-types.ts';

const connection = {
  addSubscription: () => 'sub-1',
  removeSubscription: () => true,
  pushEvent: () => {},
} as unknown as RpcConnection;

function errorsFor(name: string, value: unknown): string[] {
  return [...Value.Errors(harnessRpcSchemaRef(name), value)]
    .map((error) => `${error.instancePath || '/'} ${error.message}`);
}

function assertResult(method: RpcMethod, result: unknown): void {
  const name = HARNESS_RPC_METHOD_SCHEMAS[method].result;
  assert.deepEqual(errorsFor(name, result), [], `${method} result must match ${name}: ${JSON.stringify(result)}`);
}

function assertRequest(frame: unknown): void {
  assert.deepEqual(errorsFor('MethodRequest', frame), [], `request must match MethodRequest: ${JSON.stringify(frame)}`);
}

async function call(router: RpcHandler, method: RpcMethod, params?: unknown): Promise<unknown> {
  return router({ id: 'r1', method, ...(params === undefined ? {} : { params }) }, connection);
}

function unused(): never {
  throw new Error('unused port');
}

const toolStub = {
  catalog: unused, detail: unused, enable: unused, permissionQuery: unused,
  permissionEnable: unused, permissionDisable: unused, permissionReset: unused,
} as unknown as ToolPort;

const subagentStub = {
  tree: unused, jobs: unused, job: unused, result: unused,
  create: unused, stop: unused, send: unused,
} as unknown as RouterDeps['subagent'];

const historyStub = { read: unused } as unknown as RouterDeps['history'];
const streamStub = { subscribe: unused, unsubscribe: unused } as unknown as RouterDeps['stream'];

// ---------------------------------------------------------------------------
// Tool / permission fixtures
// ---------------------------------------------------------------------------

interface FakeTool {
  name: string;
  description?: string;
  parameters?: unknown;
  promptGuidelines?: string[];
  exposure: string;
  namespace?: { name: string; aliases?: string[] };
}

function makeToolApi(tools: FakeTool[], active: string[], branch: unknown[]): ExtensionAPI {
  let activeSet = new Set(active);
  return {
    getAllTools: () => tools,
    getActiveTools: () => [...activeSet],
    setActiveTools: (names: string[]) => { activeSet = new Set(names); },
    appendEntry: (customType: string, data?: unknown) => { branch.push({ type: 'custom', customType, data }); },
  } as unknown as ExtensionAPI;
}

function makeToolContext(branch: unknown[]): ExtensionContext {
  return {
    cwd: '/tmp/project',
    mode: 'rpc',
    ui: { notify() {} },
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => 'session-xyz', getBranch: () => branch },
  } as unknown as ExtensionContext;
}

const TOOLS: FakeTool[] = [
  { name: 'read', description: 'Read files', parameters: { type: 'object' }, promptGuidelines: ['read it'], exposure: 'direct' },
  { name: 'write', description: 'Write files', parameters: { type: 'object' }, exposure: 'direct' },
  { name: 'mcp__srv__query', description: 'Query', exposure: 'direct', namespace: { name: 'mcp__srv', aliases: ['srv'] } },
];

test('tool and permission method results match the schema', async () => {
  const branch: unknown[] = [];
  const router = createRouter({
    sessionId: 'session-xyz',
    tool: buildToolPort(makeToolApi(TOOLS, ['read'], branch), makeToolContext(branch)),
    subagent: subagentStub,
    history: historyStub,
    stream: streamStub,
  });

  const calls: Array<[RpcMethod, unknown]> = [
    [RPC_METHODS.toolsCatalog, {}],
    [RPC_METHODS.toolsDetail, { name: 'read' }],
    [RPC_METHODS.toolsEnable, { targets: ['read'] }],
    [RPC_METHODS.permissionQuery, { expr: 'enabled+active' }],
    [RPC_METHODS.permissionEnable, { targets: ['write'] }],
    [RPC_METHODS.permissionDisable, { targets: ['write'] }],
    [RPC_METHODS.permissionReset, { targets: ['write'] }],
  ];
  for (const [method, params] of calls) {
    assertResult(method, await call(router, method, params));
  }

  for (const [method, params] of calls) {
    assertRequest({ id: 'r1', method, params });
  }
});

// ---------------------------------------------------------------------------
// Subagent / message fixtures
// ---------------------------------------------------------------------------

const api = {} as unknown as ExtensionAPI;
const ctx = {
  cwd: '/tmp/project',
  mode: 'rpc',
  isProjectTrusted: () => false,
  sessionManager: { getSessionId: () => 's', getBranch: () => [] },
} as unknown as ExtensionContext;

function jobView(jobId: string, status: JobView['status'] = 'completed'): JobView {
  return {
    jobId,
    agentId: 'sub_01',
    name: null,
    parentAgentId: null,
    depth: 1,
    status,
    continuedFromJobId: null,
  };
}

function recordWith(): JobRecordView {
  return {
    jobId: 'sub_01',
    agentId: 'sub_01',
    name: null,
    round: 1,
    task: 't',
    status: 'completed',
    error: null,
    result: 'done',
    history: { startEntryId: 'a', endEntryId: 'b' },
    budget: null,
    previousJobId: null,
  };
}

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
    sessionId: 's',
    maxDepth: 2,
    runtime: {
      jobs: () => ({ jobs: shape.jobs ?? [] }),
      jobRecord: (jobId: string) => shape.records?.[jobId] ?? null,
    },
    list: async () => shape.list ?? null,
    create: shape.create ?? (async () => ({ items: [{ id: 'sub_01', socket: '/tmp/sub_01.sock' }] })),
    stop: shape.stop ?? ((id: string) => ({ ok: true, id, status: 'stopping' })),
    resolveEndpoint: shape.resolveEndpoint ?? (async () => ({ isManaged: true, targetId: 'sub_01' })),
    sessionEndpoint: shape.sessionEndpoint ?? (async () => ({ kind: 'local' })),
    sendMessage: shape.sendMessage ?? (() => ({ ok: true, to: 'sub_01', jobId: 'sub_01' })),
    sendCrossSession: shape.sendCrossSession ?? (async () => {}),
  } as unknown as RootService;
}

test('subagent, job and message method results match the schema', async () => {
  const tree = { id: 'Main', status: 'running', socket: '/tmp/main.sock', children: [] };
  const root = makeRoot({
    jobs: [jobView('sub_01')],
    records: { sub_01: recordWith() },
    list: tree,
  });
  const router = createRouter({
    sessionId: 's',
    tool: toolStub,
    subagent: buildSubagentPort(api, ctx, root),
    history: historyStub,
    stream: streamStub,
  });

  for (const [method, params] of [
    [RPC_METHODS.agentsTree, undefined],
    [RPC_METHODS.jobsList, {}],
    [RPC_METHODS.jobsGet, { jobId: 'sub_01' }],
    [RPC_METHODS.jobsResult, { jobId: 'sub_01' }],
    [RPC_METHODS.subagentCreate, { context: 'ctx', tasks: [{ name: 'one', task: 'do it' }] }],
    [RPC_METHODS.subagentStop, { id: 'sub_01' }],
    [RPC_METHODS.messageSend, { path: '/tmp/project/sub_01.sock', content: 'hi' }],
  ] as Array<[RpcMethod, unknown]>) {
    assertResult(method, await call(router, method, params));
  }

  // A running Job with no settled record reports record: null.
  const runningRoot = makeRoot({ jobs: [jobView('sub_02', 'running')], records: { sub_02: null } });
  const runningRouter = createRouter({
    sessionId: 's', tool: toolStub, subagent: buildSubagentPort(api, ctx, runningRoot), history: historyStub, stream: streamStub,
  });
  assertResult(RPC_METHODS.jobsGet, await call(runningRouter, RPC_METHODS.jobsGet, { jobId: 'sub_02' }));

  // Broadcast and cross-session receipts are part of message.send's result union.
  const broadcastRoot = makeRoot({
    resolveEndpoint: async () => ({ isManaged: true, isBroadcast: true, parentId: 'Main' }),
    sendMessage: () => ({ ok: true, to: 'all', sent: [{ to: 'sub_01', jobId: null }], errors: [] }),
  });
  const broadcastRouter = createRouter({
    sessionId: 's', tool: toolStub, subagent: buildSubagentPort(api, ctx, broadcastRoot), history: historyStub, stream: streamStub,
  });
  assertResult(RPC_METHODS.messageSend, await call(broadcastRouter, RPC_METHODS.messageSend, { path: '/tmp/project/broadcast.sock', content: 'hi' }));

  const crossRoot = makeRoot({
    resolveEndpoint: async () => ({ isManaged: false }),
    sessionEndpoint: async () => ({ kind: 'session', session: {} }),
  });
  const crossRouter = createRouter({
    sessionId: 's', tool: toolStub, subagent: buildSubagentPort(api, ctx, crossRoot), history: historyStub, stream: streamStub,
  });
  assertResult(RPC_METHODS.messageSend, await call(crossRouter, RPC_METHODS.messageSend, { path: '/tmp/project/other/Main.sock', content: 'hi' }));
});

test('job result errors keep the structured error envelope', async () => {
  const router = createRouter({
    sessionId: 's',
    tool: toolStub,
    subagent: buildSubagentPort(api, ctx, makeRoot({ jobs: [jobView('sub_01')], records: { sub_01: null } })),
    history: historyStub,
    stream: streamStub,
  });
  await assert.rejects(
    () => call(router, RPC_METHODS.jobsResult, { jobId: 'sub_01' }),
    (error: unknown) => {
      assert.ok(error instanceof RpcRequestError);
      assert.equal(error.code, 'not_ready');
      assert.deepEqual(errorsFor('RpcFailureResponse', {
        id: 'r1', ok: false, error: { code: error.code, message: error.message },
      }), []);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// History / stream fixtures
// ---------------------------------------------------------------------------

interface Running {
  readonly runtime: SubagentRuntime;
  readonly jobId: string;
  readonly agentId: string;
  readonly finish: (endEntryId: string) => void;
}

function runningJob(start: string | null = 'e1'): Running {
  let resolveDone!: (outcome: unknown) => void;
  const done = new Promise<unknown>((resolve) => { resolveDone = resolve; });
  const runtime = createSubagentRuntime({
    startJob: (request: JobRequest) => {
      request.recordStart(start);
      return { done, cancel() {} };
    },
  });
  const created = runtime.create({ tasks: [{ task: 'do work' }] });
  const item = created.items[0];
  assert.ok(item);
  return {
    runtime,
    jobId: item.id,
    agentId: item.id,
    finish: (endEntryId) => resolveDone({ status: 'completed', result: 'done', history: { startEntryId: start, endEntryId } }),
  };
}

function historyRoot(runtime: SubagentRuntime, live: NativeLiveSnapshot | null): RootService {
  return {
    sessionId: 'session-root',
    runtime,
    liveSnapshot: () => live,
    actors: { readInterval: () => [{ type: 'message', id: 'e1' }] },
  } as unknown as RootService;
}

interface StreamHarness {
  readonly root: RootService;
  listener(): ((event: unknown) => void) | null;
}

function streamRoot(runtime: SubagentRuntime, live: NativeLiveSnapshot | null): StreamHarness {
  let listener: ((event: unknown) => void) | null = null;
  const root = {
    sessionId: 'session-root',
    runtime,
    subscribeJobEvents: (_jobId: string, registered: (event: unknown) => void) => {
      if (live === null) return null;
      listener = registered;
      return () => {};
    },
    liveSnapshot: () => live,
  } as unknown as RootService;
  return { root, listener: () => listener };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('history and stream method results and event payloads match the schema', async () => {
  const running = runningJob();
  const produced = { role: 'assistant', content: [{ type: 'text', text: 'already said' }] };
  const partial = { role: 'assistant', content: [{ type: 'text', text: 'streaming' }] };
  const live: NativeLiveSnapshot = {
    startEntryId: 'e1',
    endEntryId: 'e2',
    messages: [produced],
    entries: [{ type: 'message', id: 'e2' }],
    partial,
  };

  const history = buildHistoryPort(historyRoot(running.runtime, live));
  const streamHarness = streamRoot(running.runtime, live);
  const events: Array<{ subscription: string; payload: unknown }> = [];
  const liveConnection = {
    addSubscription: () => 'sub-1',
    removeSubscription: () => true,
    pushEvent: (subscription: string, payload: unknown) => { events.push({ subscription, payload }); },
  } as unknown as RpcConnection;
  const router = createRouter({
    sessionId: 'session-root',
    tool: toolStub,
    subagent: subagentStub,
    history,
    stream: buildStreamPort(streamHarness.root),
  });

  assertResult(RPC_METHODS.historyRead, await call(router, RPC_METHODS.historyRead, { jobId: running.jobId }));

  const subscribed = await router(
    { id: 'r1', method: RPC_METHODS.streamSubscribe, params: { jobId: running.jobId } },
    liveConnection,
  );
  assertResult(RPC_METHODS.streamSubscribe, subscribed);

  streamHarness.listener()?.({
    type: 'message_update',
    message: { role: 'assistant', usage: {} },
    assistantMessageEvent: { type: 'text_delta', delta: ' more', contentIndex: 0, partial: { role: 'assistant' } },
  });
  assert.equal(events.length, 1);
  assert.deepEqual(errorsFor('StreamEventPayload', events[0]!.payload), []);

  running.finish('e3');
  await running.runtime.jobDone(running.jobId);
  await flush();
  assert.equal(events.length, 2);
  assert.deepEqual(errorsFor('StreamEventPayload', events[1]!.payload), []);

  const removed = await router(
    { id: 'r2', method: RPC_METHODS.streamUnsubscribe, params: { subscription: 'sub-1' } },
    liveConnection,
  );
  assertResult(RPC_METHODS.streamUnsubscribe, removed);

  // A Job whose start boundary is not recorded reports history_unavailable.
  const pending = createSubagentRuntime({
    startJob: () => ({ done: new Promise(() => {}), cancel() {} }),
  });
  const pendingJob = pending.create({ tasks: [{ task: 'pending' }] }).items[0]!;
  const unavailable = buildHistoryPort({
    sessionId: 'session-root',
    runtime: pending,
    liveSnapshot: () => null,
    actors: { readInterval: () => null },
  } as unknown as RootService).read({ jobId: pendingJob.id });
  assertResult(RPC_METHODS.historyRead, unavailable);
});

// ---------------------------------------------------------------------------
// Envelopes and request discrimination
// ---------------------------------------------------------------------------

test('envelopes and all method requests validate', () => {
  const requests: Record<RpcMethod, unknown> = {
    [RPC_METHODS.info]: { id: 'r', method: RPC_METHODS.info },
    [RPC_METHODS.toolsCatalog]: { id: 'r', method: RPC_METHODS.toolsCatalog, params: {} },
    [RPC_METHODS.toolsDetail]: { id: 'r', method: RPC_METHODS.toolsDetail, params: { name: 'read' } },
    [RPC_METHODS.toolsEnable]: { id: 'r', method: RPC_METHODS.toolsEnable, params: { targets: ['read'] } },
    [RPC_METHODS.permissionQuery]: { id: 'r', method: RPC_METHODS.permissionQuery, params: { expr: 'enabled' } },
    [RPC_METHODS.permissionEnable]: { id: 'r', method: RPC_METHODS.permissionEnable, params: { targets: ['read'] } },
    [RPC_METHODS.permissionDisable]: { id: 'r', method: RPC_METHODS.permissionDisable, params: { targets: ['read'] } },
    [RPC_METHODS.permissionReset]: { id: 'r', method: RPC_METHODS.permissionReset, params: { targets: ['read'] } },
    [RPC_METHODS.agentsTree]: { id: 'r', method: RPC_METHODS.agentsTree },
    [RPC_METHODS.jobsList]: { id: 'r', method: RPC_METHODS.jobsList, params: {} },
    [RPC_METHODS.jobsGet]: { id: 'r', method: RPC_METHODS.jobsGet, params: { jobId: 'j' } },
    [RPC_METHODS.jobsResult]: { id: 'r', method: RPC_METHODS.jobsResult, params: { jobId: 'j' } },
    [RPC_METHODS.subagentCreate]: { id: 'r', method: RPC_METHODS.subagentCreate, params: { tasks: [{ task: 't' }] } },
    [RPC_METHODS.subagentStop]: { id: 'r', method: RPC_METHODS.subagentStop, params: { id: 'a' } },
    [RPC_METHODS.messageSend]: { id: 'r', method: RPC_METHODS.messageSend, params: { path: '/tmp/p/Main.sock', content: 'x' } },
    [RPC_METHODS.historyRead]: { id: 'r', method: RPC_METHODS.historyRead, params: { jobId: 'j' } },
    [RPC_METHODS.streamSubscribe]: { id: 'r', method: RPC_METHODS.streamSubscribe, params: { jobId: 'j' } },
    [RPC_METHODS.streamUnsubscribe]: { id: 'r', method: RPC_METHODS.streamUnsubscribe, params: { subscription: 's' } },
  };
  for (const [method, frame] of Object.entries(requests)) assertRequest(frame);

  assert.notDeepEqual(errorsFor('MethodRequest', { id: 'r', method: RPC_METHODS.toolsDetail }), [], 'required params');
  assertRequest({ id: 'r', method: RPC_METHODS.info, params: null });
  assertRequest({ id: 'r', method: RPC_METHODS.toolsCatalog, params: null });
  assert.notDeepEqual(
    errorsFor('MethodRequest', { id: 'r', method: RPC_METHODS.toolsDetail, params: null }),
    [],
    'required params cannot be null',
  );
  assert.notDeepEqual(errorsFor('MethodRequest', { id: 'r', method: 'unknown.method' }), [], 'unknown method');
  assert.notDeepEqual(errorsFor('MethodRequest', { id: {}, method: RPC_METHODS.info }), [], 'id must be string/number');

  assert.deepEqual(errorsFor('RpcResponse', { id: null, ok: false, error: { code: 'invalid_request', message: 'bad' } }), []);
  assert.deepEqual(errorsFor('RpcResponse', { id: 1, ok: true, result: {} }), []);
  assert.deepEqual(errorsFor('RpcEventFrame', { event: { subscription: 's', seq: 1, payload: {} } }), []);
  assert.notDeepEqual(errorsFor('RpcEventFrame', { event: { subscription: 's', seq: 0, payload: {} } }), [], 'seq starts at 1');
});
