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
import { Type } from 'typebox';
import subagentExtension from '../../src/subagent/extension.ts';
import { RootService } from '../../src/subagent/root-service.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function runBoundary({ rejectWrite = false, unlistedModel = false, children = 1,
  catalogSize = 0, historyTurns = 0, managedTools = false, isolateFailure = false }: {
  rejectWrite?: boolean; unlistedModel?: boolean; children?: number;
  catalogSize?: number; historyTurns?: number; managedTools?: boolean; isolateFailure?: boolean;
} = {}): Promise<number> {
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
  const allStarted = deferred();
  const firstFinished = deferred();
  const terminalRejected = deferred();
  const nativeCancelled = deferred();
  const finish = deferred();
  const initialize = RootService.prototype.initialize;
  let root: RootService | undefined;
  if (isolateFailure) RootService.prototype.initialize = async function () {
    root = this;
    await initialize.call(this);
  };
  let dispatchedCalls = 0;
  let childActiveNames: string[] = [];
  runtime.streamSimple = (_model, _context, options) => {
    dispatchedCalls += 1;
    const stream = new AssistantMessageEventStream();
    started.resolve();
    if (dispatchedCalls === children) allStarted.resolve();
    if (isolateFailure && dispatchedCalls === 2) options?.signal?.addEventListener('abort', () => {
      nativeCancelled.resolve();
      finish.resolve();
    }, { once: true });
    const completion = isolateFailure && dispatchedCalls === 1 ? firstFinished.promise : finish.promise;
    void completion.then(() => {
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
  let sentTerminalNotices = 0;
  let catalogReads = 0;
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{ name: 'real-subagent-boundary', factory(api) {
      const getAllTools = api.getAllTools.bind(api);
      api.getAllTools = () => { catalogReads += 1; return getAllTools(); };
      for (let index = 0; index < catalogSize; index += 1) {
        api.registerTool({
          name: `fixture_${index}`, label: `Fixture ${index}`, description: 'Synthetic parent tool',
          parameters: Type.Object({}),
          async execute() { return { content: [{ type: 'text', text: 'fixture' }], details: null }; },
        });
      }
      const send = api.sendMessage.bind(api);
      api.sendMessage = (message, options) => {
        if (message.customType === 'agent-delivery') sentTerminalNotices += 1;
        return send(message, options);
      };
      const append = api.appendEntry.bind(api);
      api.appendEntry = (customType, data) => {
        if (customType === 'subagent-job-end') {
          terminalAttempts += 1;
          if (rejectTerminal) {
            terminalRejected.resolve();
            throw new Error('fixture terminal metadata write failed');
          }
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
    const manager = SessionManager.create(cwd, path.join(cwd, 'sessions'));
    for (let index = 0; index < historyTurns; index += 1) {
      manager.appendMessage({ role: 'user', content: `Synthetic turn ${index}`, timestamp: index });
      manager.appendMessage({
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: `Synthetic answer ${index}` }], stopReason: 'stop', timestamp: index,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
    }
    ({ session } = await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, sessionManager: manager,
      settingsManager, resourceLoader,
    }));
    const extensionErrors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
    const create = session.getToolDefinition('subagent_create');
    assert.ok(create);
    const context = session.extensionRunner.createToolContext('create', undefined);
    if (managedTools) {
      assert.ok(session.getActiveToolNames().includes('read'));
      assert.ok(session.getActiveToolNames().includes('write'));
      assert.ok(session.getActiveToolNames().includes('edit'));
      manager.appendCustomEntry('capability-tool-permission', {
        version: 1,
        set: [{ target: 'read', state: 'enabled' }, { target: 'write', state: 'disabled' }],
      });
    }
    // A programmatic SDK model need not be discoverable in the registry. The
    // original captured chat model is still valid for this initial Inherited Job.
    if (unlistedModel) context.modelRegistry.find = () => undefined;
    if (children > 1 || managedTools) {
      let childPrompts = 0;
      AgentSession.prototype.prompt = async function(this: AgentSession, ...args: Parameters<AgentSession['prompt']>) {
        childActiveNames = this.getActiveToolNames();
        if (++childPrompts === 2 && children > 1) {
          secondPromptRequested.resolve();
          await releaseSecondPrompt.promise;
        }
        return originalPrompt.apply(this, args);
      };
    }
    const readsBeforeCreation = catalogReads;
    let returned = false;
    const creation = create.execute('create', { tasks: Array.from({ length: children }, () => ({ task: 'Wait for navigation', inheritContext: true })) },
      undefined, undefined, context);
    void creation.then(() => { returned = true; }, () => { returned = true; });
    if (children > 1) {
      await Promise.all([started.promise, secondPromptRequested.promise]);
      assert.equal(dispatchedCalls, 1);
      const ready = await creation;
      assert.equal(returned, true, 'local readiness does not wait for provider dispatch');
      assert.ok(ready.details);
      releaseSecondPrompt.resolve();
    }
    const created = await creation;
    const creationCatalogReads = catalogReads - readsBeforeCreation;
    assert.ok(dispatchedCalls <= children);
    const registration = created.details as { items: Record<string, unknown>[] };
    assert.ok(registration.items[0]);
    assert.equal(registration.items[0].model, model.id);
    assert.equal(registration.items[0].role, null);
    await started.promise;
    if (managedTools) {
      assert.equal(childActiveNames.includes('read'), false, 'root explicit enable is root-only');
      assert.equal(childActiveNames.includes('write'), false, 'root disable excludes the child tool');
      assert.equal(childActiveNames.includes('edit'), true, 'unmanaged native tools remain available');
    }
    rejectTerminal = rejectWrite;
    if (isolateFailure) {
      await allStarted.promise;
      firstFinished.resolve();
      await terminalRejected.promise;
      assert.ok(root);
      const sibling = registration.items[1]!.id as string;
      const job = root.runtime.jobs().jobs.find(item => item.agentId === sibling)!;
      assert.equal(job.status, 'running');
      const list = session.getToolDefinition('subagent_list')!;
      const tree = await list.execute('inspect', { id: sibling }, undefined, undefined, context);
      assert.equal((tree.details as { id: string }).id, sibling, 'the real surface can inspect after a write failure');
      assert.ok(root.liveSnapshot(job.jobId));
      assert.notEqual(root.liveEndEntryId(job.jobId), undefined);
      const detach = root.subscribeJobEvents(job.jobId, () => {});
      assert.equal(typeof detach, 'function');
      detach!();
      await assert.rejects(create.execute('blocked', { tasks: [{ task: 'Must not start', inheritContext: true }] },
        undefined, undefined, context), /fixture terminal metadata write failed/);
      assert.equal(dispatchedCalls, 2, 'persistence failure still blocks new work');
      const stop = session.getToolDefinition('subagent_stop')!;
      const stopped = await stop.execute('stop', { id: sibling }, undefined, undefined, context);
      assert.equal((stopped.details as { status: string }).status, 'stopping');
      await nativeCancelled.promise;
      await root.runtime.jobDone(job.jobId);
    }
    const navigation = session.extensionRunner.emit({
      type: 'session_before_switch', reason: 'resume', targetSessionFile: path.join(cwd, 'other.jsonl'),
    });
    // The real SDK native run is allowed to settle only after retirement starts.
    await new Promise<void>((resolve) => setImmediate(resolve));
    finish.resolve();
    const result = await navigation;
    assert.equal(terminalAttempts, isolateFailure ? 1 : children,
      'the first persistence failure fences subsequent writes while cancellation can still finish');
    assert.deepEqual(extensionErrors, []);
    if (rejectWrite) {
      assert.equal(result?.cancel, true, 'a failed terminal append must reach the before-hook cancellation result');
      if (isolateFailure) {
        assert.ok(root);
        await assert.rejects(root.list({}, 'Main'), /not accepting new operations/);
        assert.throws(() => root!.stop(registration.items[1]!.id), /not accepting new operations/);
        assert.throws(() => root!.liveSnapshot(registration.items[1]!.id as string), /not accepting new operations/);
        await assert.rejects(session.getToolDefinition('subagent_list')!.execute('retired', {}, undefined, undefined, context), /quiescing/);
      }
    } else {
      assert.equal(result, undefined);
      const terminal = session.sessionManager.getBranch().filter((entry) =>
        entry.type === 'custom' && entry.customType === 'subagent-job-end');
      assert.equal(terminal.length, children, 'the old root owns terminal appends until its before-hook settles');
      assert.equal(sentTerminalNotices, children, 'the quiescing root still retains terminal notices');
    }
    return creationCatalogReads;
  } finally {
    releaseSecondPrompt.resolve();
    AgentSession.prototype.prompt = originalPrompt;
    RootService.prototype.initialize = initialize;
    firstFinished.resolve();
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
  await runBoundary();
});

test('actual extension cancels navigation when quiescing terminal metadata cannot persist', { timeout: 15000 }, async () => {
  await runBoundary({ rejectWrite: true });
});

test('initial Inherited Job retains SDK custom model even when absent from catalog', { timeout: 15000 }, async () => {
  await runBoundary({ unlistedModel: true });
});

test('batch create waits for local readiness without waiting for every provider dispatch', { timeout: 15000 }, async () => {
  await runBoundary({ children: 2 });
});

test('actual root excludes explicitly enabled and disabled tools from an Inherited child loadout', { timeout: 15000 }, async () => {
  await runBoundary({ managedTools: true });
});

test('Inherited creation reads the root catalog per operation with a long parent history', { timeout: 15000 }, async () => {
  const reads = await runBoundary({ catalogSize: 250, historyTurns: 500 });
  // Exercise the actual tool, RootService and child SDK initialization. A broad
  // count bound catches per-tool registry reconstruction without timing the host.
  assert.ok(reads < 100, `creation read the root catalog ${reads} times for 250 tools`);
});

test('metadata failure preserves current-generation inspection and cancellation but still blocks creation and navigation', { timeout: 15000 }, async () => {
  await runBoundary({ rejectWrite: true, children: 2, isolateFailure: true });
});
