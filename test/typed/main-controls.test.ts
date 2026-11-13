import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fauxProvider, InMemoryCredentialStore, type AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime,
  SessionManager, SettingsManager, type AgentSession, type CreateAgentSessionRuntimeFactory } from '@earendil-works/pi-coding-agent';
import { createSdkMainControls, MainControlError, type MainEvent } from '../../src/session/main-controls.ts';

async function fixture(t: test.TestContext) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'main-controls-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ models: [{ id: 'main-fixture', reasoning: true }] });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = faux.models[0]!;
  modelRuntime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
  modelRuntime.hasConfiguredAuth = () => true;
  let finish: (() => void) | undefined;
  let beforeRun: (() => Promise<void>) | undefined;
  let cancelReplacement = false;
  let started!: () => void;
  const providerStarted = new Promise<void>(resolve => { started = resolve; });
  modelRuntime.streamSimple = () => {
    const stream = new AssistantMessageEventStream();
    started();
    finish = () => {
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: 'done' }], stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: 'done', reason: 'stop', message }); stream.end();
    };
    return stream;
  };
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd: targetCwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: targetCwd, agentDir: path.join(cwd, 'agent'), modelRuntime,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
        extensionFactories: [{ name: 'main-test', factory(api) {
          api.registerCommand('handled', { description: 'Consume input without a run', handler: async () => {} });
          api.on('before_agent_start', async () => { await beforeRun?.(); });
          api.on('session_before_switch', () => cancelReplacement ? { cancel: true } : undefined);
        } }] } });
    return { ...await createAgentSessionFromServices({ services, sessionManager, model,
      ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }) }), services, diagnostics: [] };
  };
  const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir: path.join(cwd, 'agent'), sessionManager: SessionManager.create(cwd, path.join(cwd, 'sessions')) });
  await runtime.session.bindExtensions({});
  t.after(() => runtime.dispose());
  return { runtime,
    cancelReplacement() { cancelReplacement = true; },
    pauseAdmission() {
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      beforeRun = async () => { entered(); await waiting; };
      return { ready, release };
    },
    async finish() { await providerStarted; assert.ok(finish, 'provider must have started'); finish(); },
  };
}

function countObservers(session: AgentSession) {
  const subscribe = session.subscribe.bind(session);
  let live = 0;
  session.subscribe = listener => {
    live++;
    const unsubscribe = subscribe(listener);
    return () => { live--; unsubscribe(); };
  };
  return () => live;
}

test('SDK prompt admission returns before completion, reports handled inputs and rejects preflight failures', async t => {
  const fx = await fixture(t);
  const controls = createSdkMainControls({ session: fx.runtime.session });
  t.after(() => controls.dispose());
  assert.equal(controls.capabilities().newSession, false);
  assert.throws(() => controls.newSession(), (error: unknown) => error instanceof MainControlError && error.code === 'unavailable');
  assert.equal((await controls.submitInput({ text: '/handled' })).disposition, 'handled');
  const accepted = await controls.submitInput({ text: 'hold' });
  assert.equal(accepted.disposition, 'started');
  assert.equal(controls.state().idle, false);
  await assert.rejects(controls.submitInput({ text: 'cannot implicitly queue' }), /stream|running/i);
  assert.equal(await controls.steer('steering'), 'queued');
  assert.equal(await controls.followUp('follow-up'), 'queued');
  assert.equal(controls.state().pendingMessageCount, 2);
  fx.runtime.session.clearQueue();
  await fx.finish();
  await fx.runtime.session.waitForIdle();
  assert.equal(controls.state().idle, true);
  assert.doesNotThrow(() => JSON.stringify(controls.state()));
  await controls.interrupt();
});

test('observers rebind to real replacement sessions and detach on disconnect/dispose', async t => {
  const fx = await fixture(t);
  const first = fx.runtime.session;
  const firstLive = countObservers(first);
  const controls = createSdkMainControls({ session: first, runtime: fx.runtime });
  t.after(() => controls.dispose());
  const events: MainEvent[] = [];
  const disconnect = controls.subscribe(event => events.push(event));
  assert.equal(firstLive(), 1);
  first.setThinkingLevel('low');
  assert.ok(events.some(event => event.type === 'native' && event.event.type === 'thinking_level_changed'));
  const firstGeneration = controls.state().generation;
  // The embedding host owns this callback and explicitly supplies the next session.
  fx.runtime.setRebindSession(async next => { controls.bindSession(next); await next.bindExtensions({}); });
  assert.equal((await controls.newSession()).cancelled, false);
  assert.equal(firstLive(), 0);
  assert.notEqual(controls.state().sessionId, first.sessionId);
  assert.equal(controls.state().generation, firstGeneration + 1);
  const next = fx.runtime.session;
  const nextLive = countObservers(next);
  disconnect();
  const unsubscribe = controls.subscribe(() => {});
  assert.equal(nextLive(), 1);
  unsubscribe();
  assert.equal(nextLive(), 0);
  const reconnect = controls.subscribe(() => {});
  controls.dispose();
  assert.equal(nextLive(), 0);
  reconnect();
  assert.throws(() => controls.state(), (error: unknown) => error instanceof MainControlError && error.code === 'disposed');
  // Adapter disposal does not invalidate the caller-owned SDK session.
  await next.prompt('/handled');
});

// Unbinding releases adapter waiters without treating an ambiguous SDK handoff as retryable.
test('unbind releases pending admission without aborting the caller-owned SDK run', async t => {
  const fx = await fixture(t);
  const controls = createSdkMainControls({ session: fx.runtime.session });
  t.after(() => controls.dispose());
  const gate = fx.pauseAdmission();
  const submission = controls.submitInput({ text: 'pause before admission' });
  await gate.ready;
  const rejected = assert.rejects(submission, (error: unknown) =>
    error instanceof MainControlError && error.code === 'session_replaced' && /unknown/.test(error.message));
  controls.bindSession(undefined);
  await rejected;
  assert.throws(() => controls.state(), /No Main SDK session/);
  gate.release();
  await fx.finish();
  await fx.runtime.session.waitForIdle();
  assert.equal(fx.runtime.session.getLastAssistantText(), 'done');
});

test('SDK cancellation leaves the bound session and its generation intact', async t => {
  const fx = await fixture(t);
  const original = fx.runtime.session;
  const controls = createSdkMainControls({ session: original, runtime: fx.runtime });
  t.after(() => controls.dispose());
  const generation = controls.state().generation;
  fx.cancelReplacement();
  assert.deepEqual(await controls.newSession(), { cancelled: true });
  assert.equal(fx.runtime.session, original);
  assert.equal(controls.state().generation, generation);
  assert.equal((await controls.submitInput({ text: '/handled' })).disposition, 'handled');
});
