import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stringify } from 'smol-toml';
import { fileURLToPath } from 'node:url';
import {
  AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import subagentExtension from '../../extensions/harness.ts';
import { RootService } from '../../src/subagent/root-service.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function runBoundary({ rejectWrite = false, unlistedModel = false, children = 1,
  catalogSize = 0, historyTurns = 0, managedTools = false, managedMessageDisabled = false, isolateFailure = false,
  packageRegistration = false, inheritContext = true }: {
  rejectWrite?: boolean; unlistedModel?: boolean; children?: number;
  catalogSize?: number; historyTurns?: number; managedTools?: boolean; managedMessageDisabled?: boolean; isolateFailure?: boolean;
  packageRegistration?: boolean; inheritContext?: boolean;
} = {}): Promise<number> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'root-boundary-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir);
  if (packageRegistration) {
    const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
    const rootEntries = ['harness', 'capability', 'btw', 'preset'].map(name =>
      fileURLToPath(new URL(`../../extensions/${name}.ts`, import.meta.url)));
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
      packages: [packageRoot],
      extensions: rootEntries,
      defaultTools: ['+codemode'],
    }), 'utf8');
  }
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
  if (packageRegistration) {
    await writeFile(path.join(agentDir, 'harness.json'), JSON.stringify({
      classifier: { models: [{ provider: model.provider, id: model.id }] },
    }), 'utf8');
    await writeFile(path.join(agentDir, 'subagent-routing.toml'), stringify({
      version: 4,
      instructions: { role: 'Select the executor.', model: 'Use the fixture model.' },
      roles: [{
        id: 'executor',
        instructions: 'Execute the fixture task.',
        candidates: { fixture: {
          model: { provider: model.provider, id: model.id }, thinkingLevel: 'high',
        } },
      }],
    }), 'utf8');
  }
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
  const dispatchedModels: string[] = [];
  let childActiveNames: string[] = [];
  runtime.streamSimple = (_model, _context, options) => {
    dispatchedCalls += 1;
    dispatchedModels.push(_model.id);
    const stream = new AssistantMessageEventStream();
    started.resolve();
    if (dispatchedCalls === children) allStarted.resolve();
    if (isolateFailure && dispatchedCalls === 2) options?.signal?.addEventListener('abort', () => {
      nativeCancelled.resolve();
      finish.resolve();
    }, { once: true });
    // A normal finish gives the Job one in-band msg_write-presence reminder
    // turn. Model it as a turn that completes on its own: the fixture must not
    // make the reminder wait for an external event, or the Job could never
    // reach its terminal append.
    const completion = isolateFailure && dispatchedCalls === 1 ? firstFinished.promise
      : isolateFailure && dispatchedCalls > children ? Promise.resolve()
      : finish.promise;
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
      manager.appendCustomEntry('capability-tool-base', {
        version: 1,
        add: ['read', ...(managedMessageDisabled ? [] : ['msg_write'])],
      });
      manager.appendCustomEntry('capability-tool-blacklist', {
        version: 1,
        add: ['write', ...(managedMessageDisabled ? ['msg_write'] : [])],
      });
    }
    // A programmatic SDK model need not be discoverable in the registry. The
    // original captured chat model is still valid for this initial Inherited Job.
    if (unlistedModel) context.modelRegistry.find = () => undefined;
    if (packageRegistration) {
      const classifierModel = { ...model, type: 'classifier' as const };
      context.modelRegistry.findOfType = (() => classifierModel) as typeof context.modelRegistry.findOfType;
      context.modelRegistry.classify = (async (classifier: { api: string; provider: string; id: string }) => ({
        api: classifier.api, provider: classifier.provider, model: classifier.id, timestamp: 0,
        answers: { role: { type: 'choice', choice: 'executor', probabilities: { executor: 1 }, confidence: 1 } },
        stopReason: 'stop',
      })) as typeof context.modelRegistry.classify;
    }
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
    const creation = create.execute('create', { agents: Array.from({ length: children }, () => ({ goal: 'Wait for navigation', inheritContext })) },
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
    const registration = created.details as Record<string, unknown> & { items: Record<string, unknown>[] };
    assert.ok(registration.items[0]);
    // The public create result carries addressing identity and diagnostics only;
    // the routed role and model stay internal execution state.
    for (const field of ['batch', 'roster']) assert.equal(field in registration, false, field);
    for (const field of ['goal', 'role', 'model']) assert.equal(field in registration.items[0]!, false, field);
    await started.promise;
    assert.ok(dispatchedModels.length >= 1, 'the Fresh/Inherited child must dispatch its first model request');
    assert.ok(dispatchedModels.every((id) => id === model.id),
      `child requests must use the routed fixture model: ${dispatchedModels.join(', ')}`);
    if (managedTools) {
      // Base/dynamic are availability, not authorization grants: the root's base
      // add neither denies nor grants the child a tool outside its own loadout.
      assert.equal(childActiveNames.includes('read'), true, 'a base member is not a child denial');
      assert.equal(childActiveNames.includes('write'), false, 'the root blacklist excludes the child tool');
      assert.equal(childActiveNames.includes('msg_write'), !managedMessageDisabled,
        managedMessageDisabled
          ? 'the root blacklist overrides the independent depth-owned Harness grant'
          : 'a base membership does not revoke the independent depth-owned Harness grant');
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
      const beforeBlocked = dispatchedCalls;
      await assert.rejects(create.execute('blocked', { agents: [{ goal: 'Must not start', inheritContext: true }] },
        undefined, undefined, context), /fixture terminal metadata write failed/);
      assert.equal(dispatchedCalls, beforeBlocked, 'persistence failure still blocks new work');
      const signal = session.getToolDefinition('subagent_signal')!;
      const stopped = await signal.execute('signal', { target: registration.items[1]!.address as string, action: 'stop' }, undefined, undefined, context);
      const targets = (stopped.details as { targets: Array<{ status: string }> }).targets;
      assert.equal(targets[0]?.status, 'stopping');
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
        await assert.rejects(root.list({}, 'main'), /not accepting new operations/);
        assert.throws(() => root!.signal(registration.items[1]!.address as string, 'stop', 'main'), /not accepting new operations/);
        assert.throws(() => root!.liveSnapshot(registration.items[1]!.id as string), /not accepting new operations/);
        await assert.rejects(session.getToolDefinition('subagent_list')!.execute('retired', {}, undefined, undefined, context), /quiescing/);
      }
    } else {
      assert.equal(result, undefined);
      const terminal = session.sessionManager.getBranch().filter((entry) =>
        entry.type === 'custom' && entry.customType === 'subagent-job-end');
      assert.equal(terminal.length, children, 'the old root owns terminal appends until its before-hook settles');
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

test('actual package registration excludes root entries for Fresh and Inherited children', { timeout: 30000 }, async () => {
  // The child loads the package manifest's real extensions while the production
  // RootService installs its inline child surface. Root entries must be filtered
  // from the package for both inheritance modes; otherwise harness.ts registers
  // the root tools a second time and create fails before a child run.
  await runBoundary({ packageRegistration: true, inheritContext: false });
  await runBoundary({ packageRegistration: true, inheritContext: true });
});

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

test('actual root keeps independent Harness grants while its blacklist excludes other tools from an Inherited child loadout', { timeout: 15000 }, async () => {
  await runBoundary({ managedTools: true });
});

test('actual root blacklist overrides an independent Harness grant for an Inherited child loadout', { timeout: 15000 }, async () => {
  await runBoundary({ managedTools: true, managedMessageDisabled: true });
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
