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
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { waitFor } from '../../test-support/async.ts';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';

import { connectHarnessRpc, RpcClientError, TypedRpcClient } from '../../src/harness-rpc/client.ts';
import {
  validateMethodParams,
  validateMethodResult,
  type ApprovalsEvent,
  type MainEventPayload,
  type MainInputParams,
  type MethodResult,
} from '../../src/harness-rpc/contract.ts';
import type { MainInput } from '../../src/session/main-controls.ts';
import { createRouter, createTypedRouter, type RouterDeps, type TypedMethodHandlers } from '../../src/harness-rpc/router.ts';
import type { PresetConfig as DomainPresetConfig } from '../../src/preset/config.ts';
import type { PresetSnapshot as DomainPresetSnapshot } from '../../src/preset/state.ts';
import type {
  PresetApplyOutcome as DomainPresetApplyOutcome,
  PresetClearOutcome as DomainPresetClearOutcome,
} from '../../src/preset/apply.ts';
import type {
  ShellApprovalPending as DomainShellApprovalPending,
  ShellApprovalRespondResult as DomainShellApprovalRespondResult,
} from '../../src/shell-approval/types.ts';
import type { LiveSession as DomainLiveSession } from '../../src/subagent/session-directory.ts';
import type { SessionConnect as DomainSessionConnect } from '../../src/subagent/session-peers.ts';
import { createHarnessRpcServer, type RpcConnection, type RpcHandler } from '../../src/harness-rpc/transport.ts';
import { buildToolPort, type ToolPort } from '../../src/harness-rpc/ports/tool-info.ts';
import { buildSubagentPort } from '../../src/harness-rpc/ports/subagent.ts';
import { buildHistoryPort } from '../../src/harness-rpc/ports/history.ts';
import { buildStreamPort } from '../../src/harness-rpc/ports/stream.ts';
import { HARNESS_RPC_PROTOCOL_VERSION, RPC_ERROR, RPC_METHODS, type RpcMethod } from '../../src/harness-rpc/protocol.ts';
import { HARNESS_RPC_METHOD_SCHEMAS, harnessRpcSchemaRef } from '../../src/harness-rpc/schema.ts';
import { RpcRequestError } from '../../src/harness-rpc/error.ts';
import { getAgentSocketPath, getBroadcastSocketPath } from '../../src/ipc/socket.ts';
import { createSubagentRuntime, type JobRecordView, type JobView, type SubagentRuntime } from '../../src/subagent/runtime.ts';
import { startRunningJob } from './support/rpc-job-fixture.ts';
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
const streamStub = { subscribe: unused } as unknown as RouterDeps['stream'];

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
    [RPC_METHODS.messageSend, { path: getAgentSocketPath('sub_01', '/tmp/project'), content: 'hi' }],
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
  assertResult(RPC_METHODS.messageSend, await call(broadcastRouter, RPC_METHODS.messageSend, { path: getBroadcastSocketPath('Main', '/tmp/project'), content: 'hi' }));

  const crossRoot = makeRoot({
    resolveEndpoint: async () => ({ isManaged: false }),
    sessionEndpoint: async () => ({ kind: 'session', session: {} }),
  });
  const crossRouter = createRouter({
    sessionId: 's', tool: toolStub, subagent: buildSubagentPort(api, ctx, crossRoot), history: historyStub, stream: streamStub,
  });
  assertResult(RPC_METHODS.messageSend, await call(crossRouter, RPC_METHODS.messageSend, { path: getAgentSocketPath('Main', '/tmp/project/other'), content: 'hi' }));
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

function historyRoot(runtime: SubagentRuntime, live: NativeLiveSnapshot | null): RootService {
  return {
    sessionId: 'session-root',
    runtime,
    liveEndEntryId: () => live === null ? undefined : live.endEntryId,
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
  const running = startRunningJob();
  const produced = { role: 'assistant', content: [{ type: 'text', text: 'already said' }] };
  const partial = { role: 'assistant', content: [{ type: 'text', text: 'streaming' }] };
  const live: NativeLiveSnapshot = {
    endEntryId: 'e2',
    messages: [produced],
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
    [RPC_METHODS.presetsCatalog]: { id: 'r', method: RPC_METHODS.presetsCatalog },
    [RPC_METHODS.presetsCurrent]: { id: 'r', method: RPC_METHODS.presetsCurrent },
    [RPC_METHODS.presetsApply]: { id: 'r', method: RPC_METHODS.presetsApply, params: { name: 'fast' } },
    [RPC_METHODS.presetsClear]: { id: 'r', method: RPC_METHODS.presetsClear },
    [RPC_METHODS.approvalsList]: { id: 'r', method: RPC_METHODS.approvalsList },
    [RPC_METHODS.approvalsGet]: { id: 'r', method: RPC_METHODS.approvalsGet, params: { id: 'req-1' } },
    [RPC_METHODS.approvalsRespond]: { id: 'r', method: RPC_METHODS.approvalsRespond, params: { id: 'req-1', decision: 'allow' } },
    [RPC_METHODS.approvalsSubscribe]: { id: 'r', method: RPC_METHODS.approvalsSubscribe },
    [RPC_METHODS.sessionsList]: { id: 'r', method: RPC_METHODS.sessionsList },
    [RPC_METHODS.sessionsConnect]: { id: 'r', method: RPC_METHODS.sessionsConnect, params: { target: 'deadbeef' } },
    [RPC_METHODS.mainState]: { id: 'r', method: RPC_METHODS.mainState },
    [RPC_METHODS.mainInput]: { id: 'r', method: RPC_METHODS.mainInput, params: { text: 'hello' } },
    [RPC_METHODS.mainInterrupt]: { id: 'r', method: RPC_METHODS.mainInterrupt },
    [RPC_METHODS.mainCompact]: { id: 'r', method: RPC_METHODS.mainCompact },
    [RPC_METHODS.mainNavigate]: { id: 'r', method: RPC_METHODS.mainNavigate, params: { targetId: 'entry-1' } },
    [RPC_METHODS.mainReload]: { id: 'r', method: RPC_METHODS.mainReload },
    [RPC_METHODS.mainNew]: { id: 'r', method: RPC_METHODS.mainNew },
    [RPC_METHODS.mainSwitch]: { id: 'r', method: RPC_METHODS.mainSwitch, params: { sessionPath: '/tmp/s.jsonl' } },
    [RPC_METHODS.mainFork]: { id: 'r', method: RPC_METHODS.mainFork, params: { entryId: 'entry-1' } },
    [RPC_METHODS.mainSubscribe]: { id: 'r', method: RPC_METHODS.mainSubscribe },
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

test('router rejects malformed optional and required parameters and normalizes absent/null optional params', async () => {
  const branch: unknown[] = [];
  const root = makeRoot({ jobs: [jobView('sub_01')], records: { sub_01: recordWith() }, list: null });
  const router = createRouter({
    sessionId: 'session-xyz',
    tool: buildToolPort(makeToolApi(TOOLS, ['read'], branch), makeToolContext(branch)),
    subagent: buildSubagentPort(api, ctx, root),
    history: historyStub,
    stream: streamStub,
  });

  // Optional-parameter methods accept undefined and null.
  for (const method of [
    RPC_METHODS.info,
    RPC_METHODS.toolsCatalog,
    RPC_METHODS.permissionQuery,
    RPC_METHODS.agentsTree,
    RPC_METHODS.jobsList,
  ]) {
    assertResult(method, await call(router, method, undefined));
    assertResult(method, await call(router, method, null));
  }

  // Malformed optional fields, arrays, missing required params, and unknown methods fail cleanly.
  const invalidRequests: Array<{ method: string; params?: unknown; code: string }> = [
    { method: RPC_METHODS.toolsCatalog, params: { filter: 123 }, code: RPC_ERROR.invalidRequest },
    { method: RPC_METHODS.toolsCatalog, params: { category: 'bogus' }, code: RPC_ERROR.invalidRequest },
    { method: RPC_METHODS.permissionQuery, params: { expr: 42 }, code: RPC_ERROR.invalidRequest },
    { method: RPC_METHODS.jobsList, params: { jobIds: 'sub_01' }, code: RPC_ERROR.invalidRequest },
    { method: RPC_METHODS.jobsList, params: { jobIds: [123] }, code: RPC_ERROR.invalidRequest },
    { method: RPC_METHODS.subagentCreate, params: { context: 123, tasks: [{ task: 'ok' }] }, code: RPC_ERROR.invalidRequest },
    { method: RPC_METHODS.subagentCreate, params: { tasks: [{ task: 'ok', name: '' }] }, code: RPC_ERROR.invalidRequest },
    { method: RPC_METHODS.subagentCreate, params: { tasks: [{ task: 'ok', inheritContext: 'yes' }] }, code: RPC_ERROR.invalidRequest },
    { method: RPC_METHODS.subagentCreate, params: { tasks: [{ task: 'ok', extra: true }] }, code: RPC_ERROR.invalidRequest },
    { method: RPC_METHODS.toolsCatalog, params: [], code: RPC_ERROR.invalidRequest },
    { method: RPC_METHODS.toolsDetail, params: undefined, code: RPC_ERROR.invalidRequest },
    { method: RPC_METHODS.toolsDetail, params: null, code: RPC_ERROR.invalidRequest },
    { method: RPC_METHODS.toolsDetail, params: { name: '' }, code: RPC_ERROR.invalidRequest },
    { method: 'unknown.method', params: {}, code: RPC_ERROR.methodNotFound },
  ];

  for (const entry of invalidRequests) {
    await assert.rejects(
      () => router({ id: 'bad', method: entry.method, ...(entry.params === undefined ? {} : { params: entry.params }) }, connection),
      (error: unknown) => error instanceof RpcRequestError && error.code === entry.code,
      `expected ${entry.code} for ${entry.method} with ${JSON.stringify(entry.params)}`,
    );
  }
});

test('typed client works end-to-end over socket with events, errors and optional result validation', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-harness-rpc-client-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const branch: unknown[] = [];
  const running = startRunningJob();
  const live: NativeLiveSnapshot = { endEntryId: 'e2', messages: [], partial: null };
  const streamHarness = streamRoot(running.runtime, live);

  const router = createRouter({
    sessionId: 'session-client',
    tool: buildToolPort(makeToolApi(TOOLS, ['read'], branch), makeToolContext(branch)),
    subagent: buildSubagentPort(api, ctx, makeRoot({ list: { id: 'Main', status: 'running', socket: '/tmp/main.sock', children: [] } })),
    history: historyStub,
    stream: buildStreamPort(streamHarness.root),
  });

  const server = createHarnessRpcServer({
    address: getAgentSocketPath('harness-rpc', dir),
    root: dir,
    handler: router,
  });
  t.after(() => server.close());
  await server.ready;

  const events: unknown[] = [];
  const client = await connectHarnessRpc(server.address, {
    validateResults: true,
    onEvent: (event) => events.push(event),
  });
  t.after(() => client.close());

  const info = await client.call(RPC_METHODS.info);
  assert.equal(info.protocolVersion, HARNESS_RPC_PROTOCOL_VERSION);
  assert.equal(info.sessionId, 'session-client');

  const catalog = await client.call(RPC_METHODS.toolsCatalog);
  assert.equal(catalog.total, TOOLS.length);
  const filtered = await client.call(RPC_METHODS.toolsCatalog, { filter: 'read', category: 'tool' });
  assert.deepEqual(filtered.entries.map((entry) => entry.name), ['read']);

  const detail = await client.call(RPC_METHODS.toolsDetail, { name: 'read' });
  assert.equal(detail.active, true);

  const tree = await client.call(RPC_METHODS.agentsTree);
  assert.equal(tree?.id, 'Main');

  await assert.rejects(
    () => client.call(RPC_METHODS.toolsDetail, { name: 'missing' }),
    (error: unknown) => error instanceof RpcClientError && error.code === RPC_ERROR.notFound,
  );

  const sub = await client.call(RPC_METHODS.streamSubscribe, { jobId: running.jobId });
  assert.equal(sub.live, true);
  streamHarness.listener()?.({ type: 'message_start', message: { role: 'assistant', content: [] } });
  running.finish('e3');
  await running.runtime.jobDone(running.jobId);
  await waitFor(() => events.length >= 2, { label: 'session and terminal events over the socket' });
  assert.equal(events.length >= 2, true);

  const unsub = await client.call(RPC_METHODS.streamUnsubscribe, { subscription: sub.subscription });
  assert.equal(unsub.removed, true);

  const badResultClient = new TypedRpcClient(
    async (request) => ({ id: request.id, ok: true, result: { bogus: true } }),
    { validateResults: true },
  );
  await assert.rejects(
    () => badResultClient.call(RPC_METHODS.info),
    (error: unknown) => error instanceof RpcClientError && error.code === 'invalid_response',
  );
});

// Compile-time negative contract checks: wrong result or param shapes must fail tsc.
function _compileTimeContractAssertions(base: TypedMethodHandlers): void {
  createTypedRouter({
    ...base,
    // @ts-expect-error wrong result shape for harness.info (missing sessionId/pid)
    [RPC_METHODS.info]: () => ({ protocolVersion: HARNESS_RPC_PROTOCOL_VERSION }),
  });
  createTypedRouter({
    ...base,
    [RPC_METHODS.toolsDetail]: () => ({
      name: 'read',
      description: '',
      namespace: null,
      exposure: null,
      parameters: null,
      promptGuidelines: null,
      registered: true,
      eligible: true,
      // @ts-expect-error wrong result shape for tools.detail (active must be boolean)
      active: 'yes',
      permission: 'active',
      managed: false,
    }),
  });
  createTypedRouter({
    ...base,
    // @ts-expect-error wrong params type for tools.detail (expects { name: string })
    [RPC_METHODS.toolsDetail]: (params: { missing: number }) =>
      base[RPC_METHODS.toolsDetail]({ name: String(params.missing) }, connection),
  });
}
void _compileTimeContractAssertions;

test('connectHarnessRpc rejects malformed wire frames without uncaught errors and cleans up pending calls', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-harness-rpc-badwire-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  for (const rawBadFrame of [
    '{"id":null,"ok":false}\n',
    '{not-json\n',
    '{"event":{"subscription":"sub-1","seq":0,"payload":{}}}\n',
  ]) {
    const address = getAgentSocketPath(`bad-${Math.random().toString(36).slice(2)}`, dir);
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.write(rawBadFrame));
    });
    server.listen(address);
    await once(server, 'listening');

    const errors: Error[] = [];
    const client = await connectHarnessRpc(address, {
      onError: (error) => {
        errors.push(error);
        throw new Error('user onError threw');
      },
    });
    t.after(async () => {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    await assert.rejects(
      () => client.call(RPC_METHODS.info),
      (error: unknown) => error instanceof RpcClientError && error.code === 'invalid_frame',
    );
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof RpcClientError && errors[0].code === 'invalid_frame');
    await client.close();
    assert.equal(client.closed, true);
    await assert.rejects(() => client.call(RPC_METHODS.info));
  }
});

test('connectHarnessRpc handles opaque events, callback errors, unknown ids and serialization failures safely', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-harness-rpc-edge-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const address = getAgentSocketPath('edge', dir);
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const req = JSON.parse(line) as { id: number; method: string };
        socket.write(`${JSON.stringify({ id: null, ok: false, error: { code: 'invalid_request', message: 'noise' } })}\n`);
        socket.write(`${JSON.stringify({ id: 99999, ok: true, result: {} })}\n`);
        socket.write(`${JSON.stringify({ event: { subscription: 'sub-1', seq: 1, payload: { opaque: { nested: [1, 2] } } } })}\n`);
        socket.write(`${JSON.stringify({ id: req.id, ok: true, result: { protocolVersion: HARNESS_RPC_PROTOCOL_VERSION, sessionId: 's', pid: 1 } })}\n`);
      }
    });
  });
  server.listen(address);
  await once(server, 'listening');

  const seenEvents: unknown[] = [];
  const seenErrors: Error[] = [];
  const client = await connectHarnessRpc(address, {
    onEvent: (event) => {
      seenEvents.push(event);
      throw new Error('user onEvent threw');
    },
    onError: (error) => {
      seenErrors.push(error);
    },
  });
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Serialization failure must reject before inserting into pending or corrupting the stream.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(() => client.call(RPC_METHODS.toolsCatalog, circular as never), TypeError);

  const info = await client.call(RPC_METHODS.info);
  assert.equal(info.sessionId, 's');
  assert.equal(seenEvents.length, 1);
  assert.deepEqual((seenEvents[0] as { payload: unknown }).payload, { opaque: { nested: [1, 2] } });
  assert.equal(seenErrors.length, 2);
  assert.ok(seenErrors[0] instanceof RpcClientError && seenErrors[0].code === 'invalid_request');
  assert.equal(seenErrors[1]?.message, 'user onEvent threw');
});

test('preset, approval and session peer contracts match exact domain types and validate frames', () => {
  const presetConfig: DomainPresetConfig = {
    description: 'Fast preset',
    model: { provider: 'fake-provider', id: 'fast' },
    thinkingLevel: 'medium',
    tools: ['+read', '-write'],
    codemode: { mode: 'on' },
    instructions: 'Be concise.',
  };
  const presetSnapshot: DomainPresetSnapshot = {
    name: 'fast',
    model: { provider: 'fake-provider', id: 'fast' },
    thinkingLevel: 'medium',
    tools: ['read'],
    codemode: { mode: 'on' },
    instructions: 'Be concise.',
  };
  const applySuccess: DomainPresetApplyOutcome = {
    applied: true,
    snapshot: presetSnapshot,
    issues: [{ severity: 'warning', kind: 'unknown_tool', detail: 'unknown tool "foo" not added' }],
    problems: [{ severity: 'warning', kind: 'codemode_not_applied', codemode: { mode: 'on' }, detail: 'recorded only' }],
    codemodeNotApplied: true,
  };
  const applyFail: DomainPresetApplyOutcome = {
    applied: false,
    snapshot: null,
    issues: [],
    problems: [{ severity: 'error', kind: 'model_unauthenticated', model: { provider: 'p', id: 'm' }, detail: 'unauth' }],
    codemodeNotApplied: false,
  };
  const clearOutcome: DomainPresetClearOutcome = { cleared: true, snapshot: null, codemodeCleared: true };

  const pendingItem: DomainShellApprovalPending = {
    id: 'apr-1',
    sourceAgent: 'Main',
    shell: '/bin/sh',
    cwd: '/tmp/project',
    command: 'ls',
    reason: null,
    state: 'active',
    timeoutSeconds: 30,
    requestedAt: 1000,
    expiresAt: 31000,
  };
  const respondOk: DomainShellApprovalRespondResult = { accepted: true, decision: 'allow' };
  const respondMiss: DomainShellApprovalRespondResult = { accepted: false, reason: 'not_pending' };

  const liveSession: DomainLiveSession = {
    sessionId: 'session-peer',
    uid: '1234abcd',
    socketDir: '/tmp/sockets/1234abcd',
    pid: 42,
    cwd: '/tmp/project',
    name: null,
    startedAt: 2000,
  };
  const sessionConnect: DomainSessionConnect = {
    session: liveSession,
    address: '/tmp/sockets/1234abcd/Main.sock',
    enabled: ['msg_write'],
    alreadyEnabled: [],
  };

  // Compile-time domain-to-contract assignability checks (no casts).
  const catalogResult: MethodResult<'presets.catalog'> = {
    presets: [{ name: 'fast', config: presetConfig }],
    warnings: [],
  };
  const currentResult: MethodResult<'presets.current'> = { preset: presetSnapshot };
  const currentNull: MethodResult<'presets.current'> = { preset: null };
  const applyResultOk: MethodResult<'presets.apply'> = applySuccess;
  const applyResultFail: MethodResult<'presets.apply'> = applyFail;
  const clearResult: MethodResult<'presets.clear'> = clearOutcome;
  const approvalsList: MethodResult<'approvals.list'> = { items: [pendingItem] };
  const approvalsGet: MethodResult<'approvals.get'> = { item: pendingItem };
  const approvalsGetNull: MethodResult<'approvals.get'> = { item: null };
  const approvalsRespondOk: MethodResult<'approvals.respond'> = respondOk;
  const approvalsRespondMiss: MethodResult<'approvals.respond'> = respondMiss;
  const approvalsSub: MethodResult<'approvals.subscribe'> = { subscription: 'sub-1', items: [pendingItem] };
  const approvalsEvent: ApprovalsEvent = { kind: 'approvals', rootSessionId: 'root-1', items: [pendingItem] };
  const sessionsList: MethodResult<'sessions.list'> = { sessions: [liveSession] };
  const sessionsConnectResult: MethodResult<'sessions.connect'> = sessionConnect;

  assertResult(RPC_METHODS.presetsCatalog, catalogResult);
  assertResult(RPC_METHODS.presetsCurrent, currentResult);
  assertResult(RPC_METHODS.presetsCurrent, currentNull);
  assertResult(RPC_METHODS.presetsApply, applyResultOk);
  assertResult(RPC_METHODS.presetsApply, applyResultFail);
  assertResult(RPC_METHODS.presetsClear, clearResult);
  assertResult(RPC_METHODS.approvalsList, approvalsList);
  assertResult(RPC_METHODS.approvalsGet, approvalsGet);
  assertResult(RPC_METHODS.approvalsGet, approvalsGetNull);
  assertResult(RPC_METHODS.approvalsRespond, approvalsRespondOk);
  assertResult(RPC_METHODS.approvalsRespond, approvalsRespondMiss);
  assertResult(RPC_METHODS.approvalsSubscribe, approvalsSub);
  assert.deepEqual(errorsFor('ApprovalsEvent', approvalsEvent), []);
  assertResult(RPC_METHODS.sessionsList, sessionsList);
  assertResult(RPC_METHODS.sessionsConnect, sessionsConnectResult);

  // Runtime parameter & result validation for the 10 new methods.
  assert.equal(validateMethodParams(RPC_METHODS.presetsCatalog, undefined).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.presetsCurrent, null).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.presetsClear, {}).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.approvalsList, undefined).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.approvalsSubscribe, null).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.sessionsList, undefined).ok, true);

  assert.equal(validateMethodParams(RPC_METHODS.presetsApply, { name: 'fast' }).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.presetsApply, { name: '' }).ok, false);
  assert.equal(validateMethodParams(RPC_METHODS.presetsApply, undefined).ok, false);
  assert.equal(validateMethodParams(RPC_METHODS.approvalsGet, { id: 'apr-1' }).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.approvalsGet, {}).ok, false);
  assert.equal(validateMethodParams(RPC_METHODS.approvalsRespond, { id: 'apr-1', decision: 'deny' }).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.approvalsRespond, { id: 'apr-1', decision: 'maybe' }).ok, false);
  assert.equal(validateMethodParams(RPC_METHODS.sessionsConnect, { target: '1234abcd' }).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.sessionsConnect, { target: '' }).ok, false);
  assert.equal(validateMethodResult(RPC_METHODS.approvalsRespond, respondOk).ok, true);
});

test('main session control contracts match domain inputs and validate results and events', () => {
  const inputParams: MainInputParams = {
    text: 'run tests',
    images: [{ type: 'image', data: 'AQID', mimeType: 'image/png' }],
    streamingBehavior: 'steer',
    expandPromptTemplates: false,
  };
  const domainInput: MainInput = inputParams;
  assert.equal(domainInput.text, 'run tests');

  const sdkState: MethodResult<'main.state'> = {
    generation: 1,
    session: {
      sessionId: 'root-1',
      sessionFile: '/tmp/root.jsonl',
      name: 'Main',
      leafId: 'leaf-1',
      model: { provider: 'fake-provider', id: 'fake-model' },
      thinkingLevel: 'medium',
      idle: true,
      streaming: false,
      compacting: false,
      retrying: false,
      pendingMessageCount: 0,
      activeTools: ['read'],
      capabilities: {
        input: true,
        interrupt: true,
        compact: true,
        events: true,
        navigateTree: true,
        reload: true,
        newSession: true,
        switchSession: true,
        fork: true,
        inputAdmission: true,
      },
    },
  };
  const extState: MethodResult<'main.state'> = {
    generation: 1,
    session: {
      sessionId: 'root-1',
      sessionFile: null,
      name: null,
      leafId: null,
      model: null,
      thinkingLevel: 'off',
      idle: true,
      streaming: null,
      compacting: null,
      retrying: null,
      pendingMessageCount: null,
      activeTools: [],
      capabilities: {
        input: true,
        interrupt: true,
        compact: true,
        events: true,
        navigateTree: false,
        reload: false,
        newSession: false,
        switchSession: false,
        fork: false,
        inputAdmission: false,
      },
    },
  };

  assertResult(RPC_METHODS.mainState, sdkState);
  assertResult(RPC_METHODS.mainState, extState);
  assertResult(RPC_METHODS.mainInput, { generation: 1, sessionId: 'root-1', disposition: 'submitted' });
  assertResult(RPC_METHODS.mainInterrupt, { requested: true });
  assertResult(RPC_METHODS.mainReload, { requested: true });
  assertResult(RPC_METHODS.mainCompact, { completed: true, result: { summary: 'ok', firstKeptEntryId: 'e1' } });
  assertResult(RPC_METHODS.mainCompact, { completed: false, result: null });
  assertResult(RPC_METHODS.mainNavigate, { cancelled: false, editorText: 'draft', aborted: false });
  assertResult(RPC_METHODS.mainNew, { cancelled: false });
  assertResult(RPC_METHODS.mainSwitch, { cancelled: true });
  assertResult(RPC_METHODS.mainFork, { cancelled: false, selectedText: 'forked' });
  assertResult(RPC_METHODS.mainSubscribe, { subscription: 'sub-main-1' });

  const mainEvent: MainEventPayload = {
    kind: 'main',
    generation: 2,
    rootSessionId: 'root-1',
    source: 'sdk',
    event: { type: 'agent_start' },
  };
  assert.deepEqual(errorsFor('MainEventPayload', mainEvent), []);

  assert.equal(validateMethodParams(RPC_METHODS.mainState, undefined).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.mainInput, inputParams).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.mainInput, { text: 'hi', streamingBehavior: 'bad' }).ok, false);
  assert.equal(validateMethodParams(RPC_METHODS.mainInput, {}).ok, false);
  assert.equal(validateMethodParams(RPC_METHODS.mainCompact, undefined).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.mainCompact, { instructions: 123 }).ok, false);
  assert.equal(validateMethodParams(RPC_METHODS.mainNavigate, { targetId: 'e1', summarize: true }).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.mainNavigate, { targetId: '' }).ok, false);
  assert.equal(validateMethodParams(RPC_METHODS.mainNew, undefined).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.mainNew, { parentSession: '' }).ok, false);
  assert.equal(validateMethodParams(RPC_METHODS.mainSwitch, { sessionPath: '/tmp/a.jsonl' }).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.mainSwitch, undefined).ok, false);
  assert.equal(validateMethodParams(RPC_METHODS.mainFork, { entryId: 'e1', position: 'before' }).ok, true);
  assert.equal(validateMethodParams(RPC_METHODS.mainFork, { entryId: 'e1', position: 'after' }).ok, false);
  assert.equal(validateMethodParams(RPC_METHODS.mainSubscribe, null).ok, true);
});
