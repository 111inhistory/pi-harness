import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrepareRequest, PrepareRequestContext, StreamFn } from '@earendil-works/pi-agent-core';
import { fauxProvider, normalizeContext, type TranscriptContext } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { BUDGET_WARNING_MESSAGE, createJobBudget } from '../../src/subagent/job-budget.ts';
import { ModelCallBudgetError, installModelCallBudget, type ModelCallBudgetSession } from '../../src/subagent/pi-job-budget.ts';

const PROFILE = { modelCalls: { soft: 2, hard: 3 }, activeTimeMs: { soft: 10_000, hard: 20_000 }, lifetimeMs: 60_000 };
const model = fauxProvider({ models: [{ id: 'budget-fixture' }] }).models[0]!;
function request(): PrepareRequestContext & { context: TranscriptContext & { tools: [] } } {
  return { model, thinkingLevel: 'off', context: { ...normalizeContext({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 0 }],
  }), tools: [] } };
}
function fixture() {
  let prepared = 0;
  let streamed = 0;
  let aborts = 0;
  let forwarded: { model: unknown; context: TranscriptContext; options: unknown } | undefined;
  const stream = new AssistantMessageEventStream();
  const session: ModelCallBudgetSession & { agent: { prepareRequest: PrepareRequest; streamFunction: StreamFn } } = {
    agent: {
      async prepareRequest(input) { prepared++; return { context: input.context, thinkingLevel: 'high' }; },
      streamFunction(model, context, options) { streamed++; forwarded = { model, context, options }; return stream; },
    },
    abort() { aborts++; },
  };
  return { session, stream, counts: () => ({ prepared, streamed, aborts }), forwarded: () => forwarded };
}

test('charges at dispatch, chains native preparation and restores both hooks', async () => {
  const f = fixture();
  const originalPrepare = f.session.agent.prepareRequest;
  const originalStream = f.session.agent.streamFunction;
  const budget = createJobBudget({ profile: PROFILE });
  const cleanup = installModelCallBudget(f.session, budget);
  const input = request();
  const update = await f.session.agent.prepareRequest(input);
  assert.equal(update?.thinkingLevel, 'high');
  assert.equal(f.counts().prepared, 1);
  assert.equal(budget.snapshot().modelCalls, 0);
  const signal = new AbortController().signal;
  assert.equal(f.session.agent.streamFunction(model, normalizeContext(input.context), { signal }), f.stream);
  assert.equal(f.forwarded()?.model, model);
  assert.deepEqual(f.forwarded()?.context, normalizeContext(input.context));
  assert.deepEqual(f.forwarded()?.options, { signal });
  assert.equal(budget.snapshot().modelCalls, 1);
  cleanup();
  assert.equal(f.session.agent.streamFunction, originalStream);
  assert.equal(f.session.agent.prepareRequest, originalPrepare);
});

test('compaction and retry attempts debit once each and the refused attempt never dispatches', () => {
  const f = fixture();
  const budget = createJobBudget({ profile: PROFILE });
  installModelCallBudget(f.session, budget);
  for (let attempt = 0; attempt < 3; attempt++) f.session.agent.streamFunction(model, normalizeContext({ messages: [] }));
  assert.equal(f.counts().streamed, 3);
  assert.equal(budget.snapshot().modelCalls, 3);
  assert.throws(() => f.session.agent.streamFunction(model, normalizeContext({ messages: [] })), (error: unknown) => {
    assert.ok(error instanceof ModelCallBudgetError);
    assert.equal(error.code, 'budget_exceeded');
    assert.equal(error.terminal?.status, 'failed');
    return true;
  });
  assert.equal(f.counts().streamed, 3);
  assert.equal(f.counts().aborts, 1);
});

test('soft warning is injected once without mutating the prepared context', async () => {
  const f = fixture();
  const budget = createJobBudget({ profile: PROFILE });
  installModelCallBudget(f.session, budget, { warningText: warning => `WRAP ${warning}` });
  const input = request();
  for (let attempt = 0; attempt < 2; attempt++) {
    const update = await f.session.agent.prepareRequest(input);
    assert.equal(update?.context?.messages.length, 1);
    f.session.agent.streamFunction(model, normalizeContext(input.context));
  }
  const update = await f.session.agent.prepareRequest(input);
  const warning = update?.context?.messages[1];
  assert.ok(warning?.role === 'user');
  assert.deepEqual(warning.content, [{ type: 'text', text: `WRAP ${BUDGET_WARNING_MESSAGE}` }]);
  assert.equal(typeof warning.timestamp, 'number');
  assert.equal((await f.session.agent.prepareRequest(input))?.context?.messages.length, 1);
  assert.equal(input.context.messages.length, 1);
});

test('beforeRequest refuses compaction and ordinary dispatch before charging', () => {
  const f = fixture();
  const budget = createJobBudget({ profile: PROFILE });
  installModelCallBudget(f.session, budget, { beforeRequest: () => ({ stop: true, reason: 'already finished' }) });
  assert.throws(() => f.session.agent.streamFunction(model, normalizeContext({ messages: [] })), /already finished/);
  assert.equal(budget.snapshot().modelCalls, 0);
  assert.deepEqual(f.counts(), { prepared: 0, streamed: 0, aborts: 1 });
});

test('cleanup preserves later hooks and removes an originally absent prepare hook', () => {
  const f = fixture();
  const cleanup = installModelCallBudget(f.session, createJobBudget({ profile: PROFILE }));
  const prepare: PrepareRequest = async () => undefined;
  const stream: StreamFn = () => f.stream;
  f.session.agent.prepareRequest = prepare;
  f.session.agent.streamFunction = stream;
  cleanup();
  assert.equal(f.session.agent.prepareRequest, prepare);
  assert.equal(f.session.agent.streamFunction, stream);
  const session: ModelCallBudgetSession = { agent: { streamFunction: stream }, abort() {} };
  const remove = installModelCallBudget(session, createJobBudget({ profile: PROFILE }));
  assert.equal(typeof session.agent?.prepareRequest, 'function');
  remove();
  assert.equal(session.agent?.prepareRequest, undefined);
});

test('a session without an agent boundary reports a clear hook error', () => {
  assert.throws(() => installModelCallBudget({ abort() {} }, createJobBudget({ profile: PROFILE })),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'budget_hook_unavailable');
});
