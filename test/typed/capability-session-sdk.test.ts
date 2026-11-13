/**
 * Real Capability tool-call acceptance for the shared provider policy.
 *
 * The parent session calls the real `capability` tool. That call creates the
 * internal SDK retrieval session, whose requests are captured through the
 * shared offline runtime. Responses and Anthropic are exercised with explicit
 * compat; no provider is contacted and no wire format is reimplemented here.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { clampOpenAIPromptCacheKey } from '@earendil-works/pi-ai/api/openai-prompt-cache';
import {
  fauxProvider, getCurrentTools, InMemoryCredentialStore,
  type Api, type AssistantMessage, type JsonObject, type Message, type Model,
} from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

import capabilityExtension from '../../src/capability/extension.ts';
import { CAPABILITY_STEP_TOOL_NAME } from '../../src/capability/contracts.ts';
import {
  CAPABILITY_TOOL_PERMISSION_RECORD, CAPABILITY_TOOL_PERMISSION_VERSION,
} from '../../src/capability/tool-permission.ts';
import { providerSessionPolicy } from '../../src/provider-session.ts';
import { appendPresetState, PRESET_STATE_VERSION } from '../../src/preset/state.ts';
import { CAPABILITY_DISCOVERY_RECORD } from '../../src/capability/discovery-record.ts';
import { waitFor } from '../../test-support/async.ts';

type ToolResult = Extract<Message, { role: 'toolResult' }>;

interface ObservedRequest {
  readonly messages: AgentMessage[];
  readonly reasoning: string | undefined;
}

type CacheOnPayload = (payload: unknown, model: unknown) => unknown | Promise<unknown>;

interface RetrievalCacheHook {
  readonly onPayload: CacheOnPayload | undefined;
  readonly sessionId: string | undefined;
  readonly model: Model<Api>;
}

interface Scenario {
  readonly parentRequests: ObservedRequest[];
  readonly retrievalRequests: ObservedRequest[];
  readonly retrievalHooks: RetrievalCacheHook[];
  readonly parentSessionId: string;
  readonly parentExecutions: number;
  readonly manualExecutions: number;
  readonly capabilityResult: ToolResult;
  readonly errors: unknown[];
}

function assistant(
  model: Model<Api>,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
}

function call(model: Model<Api>, id: string, name: string, arguments_: JsonObject): AssistantMessage {
  return assistant(model, [{ type: 'toolCall', id, name, arguments: arguments_ }], 'toolUse');
}

function latestResult(messages: readonly AgentMessage[], name: string): ToolResult {
  const result = messages.findLast((message): message is ToolResult =>
    message.role === 'toolResult' && message.toolName === name);
  assert.ok(result, `missing ${name} result`);
  return result;
}

function textOf(result: Pick<ToolResult, 'content'>): string {
  return result.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
}

function toolNames(messages: readonly AgentMessage[]): string[] {
  return getCurrentTools(messages).map((tool) => tool.name);
}

async function runScenario(api: 'openai-responses' | 'anthropic-messages'): Promise<Scenario> {
  const cwd = await mkdtemp(path.join(tmpdir(), `pi-capability-session-${api}-`));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir, { recursive: true });
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousSocketDir = process.env['PI_SUBAGENT_SOCKET_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(cwd, 'uds');
  let session: AgentSession | undefined;
  try {
    await writeFile(path.join(agentDir, 'harness.json'), JSON.stringify({
      capability: { manualTools: ['manual_parent'] },
    }));

    const faux = fauxProvider({ models: [{ id: 'capability-session-fixture', reasoning: true }] });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    const model = {
      ...faux.models[0]!,
      api,
      compat: api === 'openai-responses'
        ? { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true }
        : { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
    } as Model<Api>;

    const parentRequests: ObservedRequest[] = [];
    const retrievalRequests: ObservedRequest[] = [];
    const retrievalHooks: RetrievalCacheHook[] = [];
    let parentExecutions = 0;
    let manualExecutions = 0;

    runtime.streamSimple = (_requestModel, context, options) => {
      const internal = toolNames(context.messages).includes(CAPABILITY_STEP_TOOL_NAME);
      const observed: ObservedRequest = {
        messages: structuredClone(context.messages) as AgentMessage[],
        reasoning: options?.reasoning,
      };
      const stream = new AssistantMessageEventStream();
      let reply: AssistantMessage;
      if (internal) {
        retrievalRequests.push(observed);
        retrievalHooks.push({
          onPayload: options?.onPayload as CacheOnPayload | undefined,
          sessionId: options?.sessionId,
          model: _requestModel as Model<Api>,
        });
        const step = retrievalRequests.length;
        if (step === 1) {
          reply = call(model, 'retrieval-parent-attempt', 'parent_probe', {});
        } else if (step === 2) {
          reply = call(model, 'retrieval-search', CAPABILITY_STEP_TOOL_NAME, { queries: ['fixture_slides'] });
        } else if (step === 3) {
          reply = call(model, 'retrieval-finish', CAPABILITY_STEP_TOOL_NAME, {
            refs: ['tool://fixture_slides'], finish: true,
          });
        } else {
          reply = assistant(model, [{ type: 'text', text: 'retrieval done' }], 'stop');
        }
      } else {
        parentRequests.push(observed);
        reply = parentRequests.length === 1
          ? call(model, 'parent-capability', 'capability', {})
          : assistant(model, [{ type: 'text', text: 'parent done' }], 'stop');
      }
      stream.push({ type: 'done', reason: reply.stopReason as 'stop' | 'toolUse', message: reply });
      stream.end();
      return stream;
    };

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{
        name: 'capability-session-fixture',
        factory(pi: ExtensionAPI) {
          capabilityExtension(pi);
          pi.registerTool({
            name: 'parent_probe',
            label: 'Parent probe',
            description: 'A parent-only tool that retrieval must never execute.',
            parameters: { type: 'object', properties: {} },
            defaultActive: true,
            async execute() {
              parentExecutions += 1;
              return { content: [{ type: 'text' as const, text: 'PARENT_EXECUTED' }], details: {} };
            },
          });
          pi.registerTool({
            name: 'manual_parent',
            label: 'Manual parent',
            description: 'A user-authorized manual tool whose interface must not move into retrieval.',
            parameters: { type: 'object', properties: {} },
            defaultActive: true,
            async execute() {
              manualExecutions += 1;
              return { content: [{ type: 'text' as const, text: 'MANUAL_EXECUTED' }], details: {} };
            },
          });
          pi.registerTool({
            name: 'fixture_slides',
            label: 'Fixture slides',
            description: 'A selectable local fixture capability.',
            parameters: { type: 'object', properties: {} },
            defaultActive: false,
            async execute() {
              return { content: [{ type: 'text' as const, text: 'FIXTURE_EXECUTED' }], details: {} };
            },
          });
        },
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendCustomEntry(CAPABILITY_TOOL_PERMISSION_RECORD, {
      version: CAPABILITY_TOOL_PERMISSION_VERSION,
      set: [{ target: 'manual_parent', state: 'enabled' }],
    });
    appendPresetState({
      appendEntry: (customType, data) => sessionManager.appendCustomEntry(customType, data),
    }, {
      version: PRESET_STATE_VERSION,
      snapshot: { name: 'parent-preset', instructions: 'CURRENT_PARENT_PRESET' },
    });
    session = (await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader, sessionManager,
      thinkingLevel: 'medium',
    })).session;
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    await session.prompt('Find reusable capabilities for this task.');

    return {
      parentRequests,
      retrievalRequests,
      retrievalHooks,
      parentSessionId: session.sessionManager.getSessionId(),
      parentExecutions,
      manualExecutions,
      capabilityResult: latestResult(session.messages, 'capability'),
      errors,
    };
  } finally {
    try {
      await session?.dispose();
    } finally {
      if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
      if (previousSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
      else process.env['PI_SUBAGENT_SOCKET_DIR'] = previousSocketDir;
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

for (const api of ['openai-responses', 'anthropic-messages'] as const) {
  test(`real capability retrieval keeps ${api} parent context and blocks parent execution`, { timeout: 30_000 }, async () => {
    const scenario = await runScenario(api);
    assert.deepEqual(scenario.errors, []);
    assert.ok(scenario.parentRequests.length >= 2);
    assert.ok(scenario.retrievalRequests.length >= 3);

    const parentTools = toolNames(scenario.parentRequests[0]!.messages);
    assert.ok(parentTools.includes('parent_probe'), 'the parent declaration is present before retrieval');
    assert.ok(parentTools.includes('manual_parent'), 'the authorized manual tool is present in the parent request');

    const retrievalTools = toolNames(scenario.retrievalRequests[0]!.messages);
    const retrievalPresets = scenario.retrievalRequests[0]!.messages.flatMap((message) =>
      message.role === 'system' && message.sections?.['preset-instructions'] !== undefined
        ? [message.sections['preset-instructions']] : []);
    assert.deepEqual(retrievalPresets, ['<preset-instructions>\nCURRENT_PARENT_PRESET\n</preset-instructions>'],
      'real internal retrieval carries the current parent preset instruction snapshot');
    const parentNonManual = parentTools.filter((name) => name !== 'manual_parent');
    assert.deepEqual(
      retrievalTools.slice(0, parentNonManual.length),
      parentNonManual,
      'the inherited declaration prefix is preserved in order',
    );
    assert.equal(retrievalTools.at(-1), CAPABILITY_STEP_TOOL_NAME, 'capability_step is appended at the tail');

    for (const request of scenario.retrievalRequests) {
      assert.equal(request.reasoning, 'medium', 'the parent medium thinking level is inherited');
    }

    const parentAttempt = latestResult(scenario.retrievalRequests[1]!.messages, 'parent_probe');
    assert.equal(parentAttempt.isError, true);
    assert.match(textOf(parentAttempt), /unavailable in capability discovery|Only retrieval tools may execute/);
    assert.equal(scenario.parentExecutions, 0, 'the parent execute handle was never invoked');
    assert.equal(scenario.manualExecutions, 0, 'the manual execute handle was never invoked');

    assert.equal(scenario.capabilityResult.isError, false);
    const details = scenario.capabilityResult.details as { status?: string; endReason?: string } | undefined;
    assert.equal(details?.status, 'ok');
    assert.equal(details?.endReason, 'finished');

    assert.deepEqual(providerSessionPolicy({
      api,
      compat: api === 'openai-responses'
        ? { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true }
        : { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
    }), {
      transport: api === 'openai-responses' ? 'responses' : 'anthropic',
      midConversationSystemMessages: true,
      toolAdditions: true,
      toolSameNameUpdates: true,
      midConversationEffort: 'none',
    });

    const cacheHook = scenario.retrievalHooks[0];
    assert.ok(cacheHook);
    const onPayload = cacheHook.onPayload;
    assert.ok(onPayload, 'the retrieval cache installer must compose an onPayload hook');
    assert.notEqual(cacheHook.sessionId, scenario.parentSessionId, 'retrieval keeps its own local manager id');
    if (api === 'openai-responses') {
      const nativeKey = clampOpenAIPromptCacheKey(cacheHook.sessionId);
      assert.ok(nativeKey);
      const adapted = await onPayload(
        { prompt_cache_key: nativeKey },
        cacheHook.model,
      ) as Record<string, unknown>;
      assert.equal(adapted['prompt_cache_key'], scenario.parentSessionId, 'capability root defaults to the parent key');
    } else {
      const payload = { messages: [] };
      const adapted = await onPayload(payload, cacheHook.model);
      assert.deepEqual(adapted, payload, 'Anthropic payloads are never given OpenAI cache fields');
    }

    assert.ok(
      !retrievalTools.includes('manual_parent'),
      `manual tool interface is not transferred into retrieval: ${JSON.stringify({ parentTools, retrievalTools })}`,
    );
  });
}


async function runCapabilityLifecycleCase(mode: 'navigate' | 'shutdown' | 'cancel'): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-capability-lifecycle-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir, { recursive: true });
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousSocketDir = process.env['PI_SUBAGENT_SOCKET_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(cwd, 'uds');
  const originalInMemory = SessionManager.inMemory;
  const childManagers: SessionManager[] = [];
  let session: AgentSession | undefined;
  try {
    const faux = fauxProvider({ models: [{ id: 'capability-lifecycle-fixture', reasoning: true }] });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    const model = {
      ...faux.models[0]!, api: 'openai-responses',
      compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
    } as Model<Api>;

    let retrievalCalls = 0;
    let gateRetrieval = true;
    let releaseHeldRetrieval: (() => void) | undefined;
    runtime.streamSimple = (_requestModel, context, options) => {
      const stream = new AssistantMessageEventStream();
      if (!toolNames(context.messages).includes(CAPABILITY_STEP_TOOL_NAME)) {
        const reply = assistant(model, [{ type: 'text', text: 'parent done' }], 'stop');
        stream.push({ type: 'done', reason: 'stop', message: reply });
        stream.end();
        return stream;
      }
      retrievalCalls += 1;
      const finish = (aborted: boolean): void => {
        const reply = aborted
          ? assistant(model, [], 'error')
          : retrievalCalls === 1
            ? call(model, 'lifecycle-search', CAPABILITY_STEP_TOOL_NAME, { queries: ['fixture_slides'] })
            : call(model, 'lifecycle-finish', CAPABILITY_STEP_TOOL_NAME, {
              refs: ['tool://fixture_slides'], finish: true,
            });
        if (aborted) stream.push({ type: 'error', reason: 'error', error: reply });
        else stream.push({ type: 'done', reason: reply.stopReason as 'toolUse' | 'stop', message: reply });
        stream.end();
      };
      if (retrievalCalls === 2 && gateRetrieval) {
        let settled = false;
        releaseHeldRetrieval = () => { if (!settled) { settled = true; finish(false); } };
        options?.signal?.addEventListener('abort', () => { if (!settled) { settled = true; finish(true); } }, { once: true });
        return stream;
      }
      finish(false);
      return stream;
    };

    const settingsManager = SettingsManager.inMemory({
      packages: [], extensions: [], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
    });
    const entryPath = fileURLToPath(new URL('../../extensions/capability.ts', import.meta.url));
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [entryPath],
      extensionFactories: [{
        name: 'capability-lifecycle-tools',
        factory(pi) {
          pi.registerTool({
            name: 'fixture_slides', label: 'Fixture slides', description: 'A selectable local fixture capability.',
            parameters: { type: 'object', properties: {} }, defaultActive: false,
            async execute() { return { content: [{ type: 'text' as const, text: 'FIXTURE_EXECUTED' }], details: {} }; },
          });
        },
      }, {
        name: 'capability-lifecycle-cancel',
        factory(pi) {
          pi.on('session_before_tree', () => mode === 'cancel' ? { cancel: true } : undefined);
        },
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    session = (await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    })).session;
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    assert.deepEqual(errors, []);

    const anchor = session.sessionManager.appendMessage({ role: 'user', content: 'lifecycle anchor', timestamp: Date.now() });
    const later = session.sessionManager.appendMessage({ role: 'user', content: 'lifecycle later', timestamp: Date.now() + 1 });
    assert.equal(session.sessionManager.getLeafId(), later);
    const tool = session.getToolDefinition('capability');
    assert.ok(tool);
    const context = session.extensionRunner.createToolContext('lifecycle-capability', undefined);
    SessionManager.inMemory = (...args: Parameters<typeof originalInMemory>): SessionManager => {
      const manager = originalInMemory(...args);
      childManagers.push(manager);
      return manager;
    };
    const pending = tool.execute('lifecycle-capability', {}, undefined, undefined, context);
    await waitFor(() => retrievalCalls >= 2, { label: 'held retrieval model' });
    assert.equal(childManagers.length, 1, 'the real retrieval created one independent SessionManager (actual constructor identity)');
    const child = childManagers[0]!;
    if (mode === 'navigate') {
      await session.navigateTree(anchor);
    } else if (mode === 'cancel') {
      const navigation = await session.navigateTree(anchor);
      assert.equal(navigation.cancelled, true);
    } else {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    }
    releaseHeldRetrieval?.();
    const outcome = await pending;
    const details = outcome.details as { status?: string; endReason?: string } | undefined;
    assert.equal(details?.endReason, 'cancelled');
    assert.equal(outcome.isError, true);
    assert.equal(session.getActiveToolNames().includes('fixture_slides'), false,
      'the invalidated retrieval must not activate its old selection');
    assert.equal(session.sessionManager.getBranch().filter((entry) =>
      entry.type === 'custom' && entry.customType === CAPABILITY_DISCOVERY_RECORD).length, 0,
    'the invalidated retrieval must not publish a discovery record on the new branch');

    const parentBranch = session.sessionManager.getBranch().map((entry) => entry.id);
    child.appendMessage({ role: 'user', content: 'child-only append', timestamp: Date.now() + 2 });
    assert.deepEqual(session.sessionManager.getBranch().map((entry) => entry.id), parentBranch,
      'an independent retrieval SessionManager append must not mutate the parent branch');

    gateRetrieval = false;
    retrievalCalls = 0;
    const childManagersBeforeFresh = childManagers.length;
    const freshContext = session.extensionRunner.createToolContext('fresh-capability', undefined);
    const fresh = await tool.execute('fresh-capability', {}, undefined, undefined, freshContext);
    const freshDetails = fresh.details as { status?: string; endReason?: string } | undefined;
    if (mode === 'shutdown') {
      assert.equal(freshDetails?.endReason, 'cancelled');
      assert.equal(childManagers.length, childManagersBeforeFresh,
        'a disposed Capability manager must not open a fresh SDK retrieval session');
      assert.equal(retrievalCalls, 0, 'a disposed manager must not dispatch a retrieval model request');
      assert.equal(session.getActiveToolNames().includes('fixture_slides'), false);
      assert.equal(session.sessionManager.getBranch().filter((entry) =>
        entry.type === 'custom' && entry.customType === CAPABILITY_DISCOVERY_RECORD).length, 0,
      'a disposed manager must not publish or activate after shutdown');
    } else {
      assert.equal(freshDetails?.status, 'ok');
      assert.equal(freshDetails?.endReason, 'finished');
      assert.equal(childManagers.length, childManagersBeforeFresh + 1,
        'an invalidated manager must open a fresh retrieval session');
      assert.equal(retrievalCalls, 2, 'a fresh retrieval must dispatch its search and finish requests');
      assert.equal(session.getActiveToolNames().includes('fixture_slides'), true,
        'a successful or cancelled tree transition invalidates but does not dispose the Capability manager');
      assert.equal(session.sessionManager.getBranch().filter((entry) =>
        entry.type === 'custom' && entry.customType === CAPABILITY_DISCOVERY_RECORD).length, 1);
    }
    if (mode !== 'shutdown') await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  } finally {
    SessionManager.inMemory = originalInMemory;
    try { session?.dispose(); } finally {
      if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
      if (previousSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
      else process.env['PI_SUBAGENT_SOCKET_DIR'] = previousSocketDir;
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

test('SDK tree navigation vs shutdown: invalidate keeps retrieval usable; dispose blocks fresh publication', { timeout: 30_000 }, async () => {
  await runCapabilityLifecycleCase('navigate');
  await runCapabilityLifecycleCase('shutdown');
});

test('cancelled SDK tree navigation uses invalidation, not disposal, and allows a fresh retrieval', { timeout: 30_000 }, async () => {
  await runCapabilityLifecycleCase('cancel');
});
