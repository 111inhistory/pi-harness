import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import subagentExtension from '../../src/subagent/extension.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function runBoundary(rejectWrite: boolean, unlistedModel = false, children = 1): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'root-boundary-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir);
  const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const oldSocketDir = process.env['PI_SUBAGENT_SOCKET_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(cwd, 'uds');
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: 'root-boundary' }] });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.models[0];
  assert.ok(model);
  runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
  const secondPromptRequested = deferred();
  const releaseSecondPrompt = deferred();
  const originalPrompt = AgentSession.prototype.prompt;
  runtime.hasConfiguredAuth = () => true;
  const started = deferred();
  const finish = deferred();
  let dispatchedCalls = 0;
  runtime.streamSimple = () => {
    dispatchedCalls += 1;
    const stream = new AssistantMessageEventStream();
    started.resolve();
    void finish.promise.then(() => {
      const message: AssistantMessage = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: 'done' }], stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
    });
    return stream;
  };
  let rejectTerminal = false;
  let terminalAttempts = 0;
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{ name: 'real-subagent-boundary', factory(api) {
      const append = api.appendEntry.bind(api);
      api.appendEntry = (customType, data) => {
        if (customType === 'subagent-job-end') {
          terminalAttempts += 1;
          if (rejectTerminal) throw new Error('fixture terminal metadata write failed');
        }
        append(customType, data);
      };
      subagentExtension(api);
    } }],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, sessionManager: SessionManager.create(cwd, path.join(cwd, 'sessions')),
      settingsManager, resourceLoader,
    }));
    const extensionErrors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
    const create = session.getToolDefinition('subagent_create');
    assert.ok(create);
    const context = session.extensionRunner.createToolContext('create', undefined);
    // A programmatic SDK model need not be discoverable in the registry. The
    // original captured chat model is still valid for this initial Inherited Job.
    if (unlistedModel) context.modelRegistry.find = () => undefined;
    if (children > 1) {
      let childPrompts = 0;
      AgentSession.prototype.prompt = async function(this: AgentSession, ...args: Parameters<AgentSession['prompt']>) {
        if (++childPrompts === 2) {
          secondPromptRequested.resolve();
          await releaseSecondPrompt.promise;
        }
        return originalPrompt.apply(this, args);
      };
    }
    let returned = false;
    const creation = create.execute('create', { tasks: Array.from({ length: children }, () => ({ task: 'Wait for navigation', inheritContext: true })) },
      undefined, undefined, context);
    void creation.then(() => { returned = true; }, () => { returned = true; });
    if (children > 1) {
      await Promise.all([started.promise, secondPromptRequested.promise]);
      assert.equal(dispatchedCalls, 1);
      assert.equal(returned, false, 'one dispatched child cannot resolve batch creation while another is still preparing');
      releaseSecondPrompt.resolve();
    }
    const created = await creation;
    assert.equal(dispatchedCalls, children, 'create must await every first dispatch without waiting for the held responses');
    const registration = created.details as { items: Record<string, unknown>[] };
    assert.ok(registration.items[0]);
    assert.equal('status' in registration.items[0], false);
    await started.promise;
    rejectTerminal = rejectWrite;
    const navigation = session.extensionRunner.emit({
      type: 'session_before_switch', reason: 'resume', targetSessionFile: path.join(cwd, 'other.jsonl'),
    });
    // The real SDK native run is allowed to settle only after retirement starts.
    await new Promise<void>((resolve) => setImmediate(resolve));
    finish.resolve();
    const result = await navigation;
    assert.equal(terminalAttempts, children, 'one terminal owner per child attempts one append during quiescence');
    assert.deepEqual(extensionErrors, []);
    if (rejectWrite) {
      assert.equal(result?.cancel, true, 'a failed terminal append must reach the before-hook cancellation result');
    } else {
      assert.equal(result, undefined);
      const terminal = session.sessionManager.getBranch().filter((entry) =>
        entry.type === 'custom' && entry.customType === 'subagent-job-end');
      assert.equal(terminal.length, children, 'the old root owns terminal appends until its before-hook settles');
    }
  } finally {
    releaseSecondPrompt.resolve();
    AgentSession.prototype.prompt = originalPrompt;
    finish.resolve();
    await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session?.dispose();
    if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
    if (oldSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
    else process.env['PI_SUBAGENT_SOCKET_DIR'] = oldSocketDir;
    await rm(cwd, { recursive: true, force: true });
  }
}

test('actual quiescing root persists its one terminal event before the before-hook returns', { timeout: 15000 }, async () => {
  await runBoundary(false);
});

test('actual extension cancels navigation when quiescing terminal metadata cannot persist', { timeout: 15000 }, async () => {
  await runBoundary(true);
});

test('initial Inherited Job retains SDK custom model even when absent from catalog', { timeout: 15000 }, async () => {
  await runBoundary(false, true);
});

test('batch create waits for every first SDK dispatch, not merely the first child or completed output', { timeout: 15000 }, async () => {
  await runBoundary(false, false, 2);
});
