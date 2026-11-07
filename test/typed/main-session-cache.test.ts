import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  fauxProvider, InMemoryCredentialStore, lazyStream,
  type Api, type Model,
} from '@earendil-works/pi-ai';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { captureInheritedContext } from '../../src/inherited-context.ts';
import {
  CACHE_IDENTITY_CUSTOM_TYPE, installMainSessionCacheIdentity,
  installSessionCacheIdentity, resolveSessionCacheKey,
} from '../../src/session-cache-runtime.ts';

for (const observerFirst of [true, false]) {
  test(`Main records the final payload hook key and resumes it (observer first: ${observerFirst})`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'pi-main-cache-'));
    const sessions: AgentSession[] = [];
    t.after(async () => {
      for (const session of sessions.reverse()) {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      }
      await rm(root, { recursive: true, force: true });
    });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    const faux = fauxProvider({ models: [{ id: 'fixture-model' }] });
    const originalProviderStream = faux.provider.streamSimple.bind(faux.provider);
    const wire: { sessionId: string | undefined; payload: Record<string, unknown> }[] = [];
    faux.provider.streamSimple = (model, context, options) => lazyStream(model, async () => {
      const payload = { model: model.id, input: [], prompt_cache_key: options?.sessionId };
      const transformed = await options?.onPayload?.(payload, model);
      wire.push({ sessionId: options?.sessionId, payload: (transformed ?? payload) as Record<string, unknown> });
      return originalProviderStream(model, context, options);
    });
    runtime.registerNativeProvider(faux.provider);
    const model = { ...faux.models[0]!, api: 'openai-responses' } as Model<Api>;
    let api: ExtensionAPI | undefined;
    let ctx: ExtensionContext | undefined;
    let override = true;
    let overrideKey = 'actual-final-fixture-key';
    let payloadPause: Promise<void> | undefined;
    let payloadEntered: (() => void) | undefined;
    const settings = SettingsManager.inMemory({
      packages: [], extensions: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
    });
    const open = async (manager: SessionManager, main: boolean): Promise<AgentSession> => {
      const loader = new DefaultResourceLoader({
        cwd: root, agentDir: root, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: main ? (observerFirst ? [observer(), overrider()] : [overrider(), observer()]) : [],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const session = (await createAgentSession({
        cwd: root, agentDir: root, modelRuntime: runtime, model, settingsManager: settings,
        resourceLoader: loader, sessionManager: manager, tools: [],
      })).session;
      sessions.push(session);
      await session.bindExtensions({ onError: error => { throw new Error(JSON.stringify(error)); } });
      return session;
    };
    function observer() {
      return { name: 'cache-observer', factory(pi: ExtensionAPI) {
        api = pi;
        installMainSessionCacheIdentity(pi);
        pi.on('session_start', (_event, context) => { ctx = context; });
      } };
    }
    function overrider() {
      return { name: 'last-payload-customizer', factory(pi: ExtensionAPI) {
        pi.on('before_provider_request', async event => {
          payloadEntered?.();
          if (payloadPause) await payloadPause;
          return override
            ? { ...(event.payload as Record<string, unknown>), prompt_cache_key: overrideKey }
            : undefined;
        });
      } };
    }
    const initialStream = runtime.streamSimple;
    const parent = await open(SessionManager.create(root, path.join(root, 'sessions')), true);
    await parent.prompt('Record the final outgoing identity.');
    assert.equal(wire.at(-1)?.payload['prompt_cache_key'], 'actual-final-fixture-key');
    assert.equal(resolveSessionCacheKey(parent.sessionManager), 'actual-final-fixture-key');
    assert.ok(api && ctx);
    const snapshot = captureInheritedContext(api, ctx);
    assert.equal(snapshot.cacheKey, 'actual-final-fixture-key');
    const childManager = SessionManager.inMemory(root, {}, [...snapshot.entries]);
    const child = await open(childManager, false);
    const stopChildCache = installSessionCacheIdentity(child, snapshot.cacheKey);
    await child.prompt('Inherit the parent key.');
    assert.equal(wire.at(-1)?.payload['prompt_cache_key'], 'actual-final-fixture-key');
    assert.notEqual(wire.at(-1)?.sessionId, parent.sessionManager.getSessionId());
    stopChildCache();
    assert.equal(parent.sessionManager.getBranch().filter(entry => entry.type === 'custom' &&
      entry.customType === CACHE_IDENTITY_CUSTOM_TYPE).length, 1, 'child traffic does not alter Main lineage');
    await parent.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    assert.equal(runtime.streamSimple, initialStream, 'shutdown restores the shared runtime method');
    const file = parent.sessionManager.getSessionFile();
    assert.ok(file);
    override = false;
    const reopened = await open(SessionManager.open(file), true);
    await reopened.prompt('Continue after reopening without the overriding hook.');
    assert.equal(wire.at(-1)?.payload['prompt_cache_key'], 'actual-final-fixture-key');
    assert.equal(reopened.sessionManager.getBranch().filter(entry => entry.type === 'custom' &&
      entry.customType === CACHE_IDENTITY_CUSTOM_TYPE).length, 1, 'resume does not duplicate lineage');

    let releasePayload: (() => void) | undefined;
    payloadPause = new Promise(resolve => { releasePayload = resolve; });
    const entered = new Promise<void>(resolve => { payloadEntered = resolve; });
    override = true;
    overrideKey = 'late-retired-fixture-key';
    const pending = reopened.prompt('Fence a payload hook across shutdown.');
    await entered;
    await reopened.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    releasePayload?.();
    await pending;
    assert.equal(resolveSessionCacheKey(reopened.sessionManager), 'actual-final-fixture-key',
      'a hook completing after retirement cannot append a new lineage record');
    assert.equal(runtime.streamSimple, initialStream);
  });
}
