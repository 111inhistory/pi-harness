/**
 * Real-SDK acceptance for the internal `/btw` conversation.
 *
 * The parent is a real `createAgentSession` with a captured `ExtensionAPI` and
 * `ExtensionContext`. `/btw` opens a second real session through the same
 * offline `ModelRuntime`; only the model is scripted. The tests exercise the
 * inherited prompt/history/model/thinking/cache identity, the all-tools block,
 * parent immutability, isolated follow-ups, streaming text, cancel, abort and
 * disposal. No provider is contacted and no extension or package is loaded.
 */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  fauxProvider, getCurrentTools, InMemoryCredentialStore,
  type Api, type AssistantMessage, type JsonObject, type Message, type Model,
} from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { openBtwConversation, type BtwConversation } from '../../src/btw/session.ts';
import { captureInheritedContext, type InheritedSnapshot } from '../../src/inherited-context.ts';
import { promptString } from '../../src/prompt-text.ts';
import { limitSessionCacheKey } from '../../src/session-cache.ts';

type ToolResult = Extract<Message, { role: 'toolResult' }>;
type Phase = 'parent' | 'btw';

interface ObservedRequest {
  readonly phase: Phase;
  readonly step: number;
  readonly model: Model<Api>;
  readonly messages: AgentMessage[];
  readonly reasoning: string | undefined;
  readonly sessionId: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly onPayload: ((payload: unknown, model: unknown) => unknown | Promise<unknown>) | undefined;
}

type ScriptedReply = AssistantMessage | AssistantMessageEventStream;

interface HarnessOptions {
  readonly api: Api;
  readonly compat?: Record<string, boolean>;
  readonly btwReply: (step: number, request: ObservedRequest) => ScriptedReply;
}

interface Harness {
  readonly parent: AgentSession;
  readonly snapshot: InheritedSnapshot;
  readonly requests: ObservedRequest[];
  readonly parentExecutions: { count: number };
  readonly factoryLoads: { count: number };
  readonly extensionMarker: string;
  open(signal?: AbortSignal): Promise<BtwConversation>;
  cleanup(): Promise<void>;
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

function toolCall(
  model: Model<Api>,
  id: string,
  name: string,
  arguments_: JsonObject,
): AssistantMessage {
  return assistant(model, [{ type: 'toolCall', id, name, arguments: arguments_ }], 'toolUse');
}

function replyStream(message: AssistantMessage): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
  stream.end();
  return stream;
}

/** Streaming reply whose thinking block must never reach the cumulative text. */
function streamingAnswer(model: Model<Api>, thinking: string, text: string): AssistantMessageEventStream {
  const message = assistant(model, [
    { type: 'thinking', thinking, thinkingSignature: 'fixture-signature' },
    { type: 'text', text },
  ], 'stop');
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'start', partial: assistant(model, [], 'stop') });
  stream.push({ type: 'thinking_start', contentIndex: 0, partial: message });
  stream.push({ type: 'thinking_delta', contentIndex: 0, delta: thinking, partial: message });
  stream.push({ type: 'thinking_end', contentIndex: 0, content: thinking, partial: message });
  stream.push({ type: 'text_start', contentIndex: 1, partial: message });
  stream.push({ type: 'text_delta', contentIndex: 1, delta: text, partial: message });
  stream.push({ type: 'text_end', contentIndex: 1, content: text, partial: message });
  stream.push({ type: 'done', reason: 'stop', message });
  stream.end();
  return stream;
}

/** A reply that stays in flight until the SDK aborts the request. */
function pendingAnswer(
  model: Model<Api>,
  text: string,
  signal: AbortSignal | undefined,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const partial = assistant(model, [{ type: 'text', text }], 'stop');
  const finish = (): void => {
    stream.push({
      type: 'done',
      reason: 'stop',
      message: assistant(model, [{ type: 'text', text }], 'aborted'),
    });
    stream.end();
  };
  stream.push({ type: 'start', partial: assistant(model, [], 'stop') });
  stream.push({ type: 'text_start', contentIndex: 0, partial });
  stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
  if (signal?.aborted) finish();
  else signal?.addEventListener('abort', finish, { once: true });
  return stream;
}

function toolNames(messages: readonly AgentMessage[]): string[] {
  return getCurrentTools(messages).map((tool) => tool.name);
}

function systemText(messages: readonly AgentMessage[]): string {
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => JSON.stringify(message))
    .join('\n');
}

function textOf(result: Pick<ToolResult, 'content'>): string {
  return result.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
}

async function openHarness(options: HarnessOptions): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), `pi-btw-session-${options.api}-`));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir, { recursive: true });
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousSocketDir = process.env['PI_SUBAGENT_SOCKET_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(cwd, 'uds');

  const conversations: BtwConversation[] = [];
  let session: AgentSession | undefined;
  const restoreEnvironment = (): void => {
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    if (previousSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
    else process.env['PI_SUBAGENT_SOCKET_DIR'] = previousSocketDir;
  };
  const cleanup = async (): Promise<void> => {
    for (const conversation of conversations) {
      try { await conversation.dispose(); } catch { /* already closed */ }
    }
    if (session !== undefined) {
      try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); } catch { /* stale */ }
      try { session.dispose(); } catch { /* already disposed */ }
    }
    restoreEnvironment();
    await rm(cwd, { recursive: true, force: true });
  };

  try {
    const faux = fauxProvider({ models: [{ id: 'btw-session-fixture', reasoning: true }] });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    const model = {
      ...faux.models[0]!,
      api: options.api,
      ...(options.compat === undefined ? {} : { compat: options.compat }),
    } as Model<Api>;

    const requests: ObservedRequest[] = [];
    const parentExecutions = { count: 0 };
    const factoryLoads = { count: 0 };
    let phase: Phase = 'parent';
    let btwStep = 0;
    runtime.streamSimple = (requestModel, context, streamOptions) => {
      const request: ObservedRequest = {
        phase,
        step: phase === 'btw' ? btwStep++ : 0,
        model: requestModel as Model<Api>,
        messages: structuredClone(context.messages) as AgentMessage[],
        reasoning: streamOptions?.reasoning,
        sessionId: streamOptions?.sessionId,
        signal: streamOptions?.signal,
        onPayload: streamOptions?.onPayload as ObservedRequest['onPayload'],
      };
      requests.push(request);
      if (phase === 'parent') {
        return replyStream(assistant(model, [{ type: 'text', text: 'parent done' }], 'stop'));
      }
      const reply = options.btwReply(request.step, request);
      return reply instanceof AssistantMessageEventStream ? reply : replyStream(reply);
    };

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
    });
    const extensionMarker = path.join(cwd, 'extension-loaded.txt');
    const extensionDir = path.join(cwd, '.pi', 'extensions');
    await mkdir(extensionDir, { recursive: true });
    await writeFile(path.join(extensionDir, 'side-effect.js'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(extensionMarker)}, 'loaded');`,
      'export default function () {}',
      '',
    ].join('\n'));

    let parentApi: ExtensionAPI | undefined;
    let parentCtx: ExtensionContext | undefined;
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: 'PARENT_SYSTEM_MARKER',
      extensionFactories: [{
        name: 'btw-parent-fixture',
        factory(pi: ExtensionAPI) {
          factoryLoads.count++;
          parentApi = pi;
          pi.on('session_start', (_event, ctx) => { parentCtx = ctx; });
          pi.registerTool({
            name: 'parent_probe',
            label: 'Parent probe',
            description: 'A parent-only tool that /btw must never execute.',
            parameters: { type: 'object', properties: {} },
            defaultActive: true,
            async execute() {
              parentExecutions.count++;
              return { content: [{ type: 'text' as const, text: 'PARENT_EXECUTED' }], details: {} };
            },
          });
        },
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    session = (await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(cwd), thinkingLevel: 'medium',
      tools: ['read', 'parent_probe'],
    })).session;
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    assert.ok(parentApi, 'the parent extension factory ran');
    assert.ok(parentCtx, 'session_start captured the real ExtensionContext');
    await session.prompt('Parent task: keep this context.');
    session.sessionManager.appendCustomEntry('harness-tool-guidance', {
      version: 1, checkpointId: null, id: 'browser-fixture',
      text: 'RECORDED_BROWSER_GUIDANCE', position: 0,
    });
    session.sessionManager.appendCustomEntry('harness-capability-memory', {
      version: 1, checkpointId: null, id: 'capabilities',
      text: 'RECORDED_MCP_GUIDANCE', position: 'head',
    });
    const snapshot = captureInheritedContext(parentApi, parentCtx);
    phase = 'btw';

    const parent = session;
    return {
      parent,
      snapshot,
      requests,
      parentExecutions,
      factoryLoads,
      extensionMarker,
      async open(signal = new AbortController().signal) {
        const conversation = await openBtwConversation(parentApi!, parentCtx!, snapshot, signal);
        conversations.push(conversation);
        return conversation;
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

for (const scenario of [
  {
    api: 'openai-responses' as const,
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  },
  {
    api: 'anthropic-messages' as const,
    compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
  },
]) {
  test(`real /btw ${scenario.api} inherits context, blocks all tools, and isolates the parent`, { timeout: 30_000 }, async () => {
    const harness = await openHarness({
      api: scenario.api,
      compat: scenario.compat,
      btwReply(step, request) {
        if (step === 0) return toolCall(request.model, 'btw-parent-attempt', 'parent_probe', {});
        if (step === 1) return toolCall(request.model, 'btw-read-attempt', 'read', { path: 'fixture.txt' });
        if (step === 2) return streamingAnswer(request.model, 'SECRET_THINKING', 'Visible answer');
        return assistant(request.model, [{ type: 'text', text: 'follow-up answer' }], 'stop');
      },
    });
    try {
      const btw = await harness.open();
      const parentBranch = structuredClone(harness.parent.sessionManager.getBranch());
      const parentMessages = structuredClone(harness.parent.messages);
      const parentActive = [...harness.parent.getActiveToolNames()];
      const parentSessionId = harness.parent.sessionManager.getSessionId();
      const blockedReason = promptString('btw.json', 'toolsBlocked');

      await assert.rejects(btw.ask('first side question', () => {}), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(blockedReason), error.message);
        return true;
      });
      await assert.rejects(btw.ask('second side question', () => {}), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(blockedReason), error.message);
        return true;
      });
      assert.equal(harness.parentExecutions.count, 0, 'the parent tool handle never ran');

      const chunks: string[] = [];
      await btw.ask('third side question', (text) => chunks.push(text));
      const visible = chunks.filter((text) => text.length > 0);
      assert.ok(visible.length > 0, 'the answer streamed');
      assert.ok(visible.every((text) => text === 'Visible answer'), JSON.stringify(chunks));
      assert.ok(!chunks.some((text) => text.includes('SECRET_THINKING')), 'thinking never enters cumulative text');

      const first = harness.requests.find((request) => request.phase === 'btw' && request.step === 0);
      assert.ok(first);
      assert.deepEqual(toolNames(first.messages), ['read', 'parent_probe']);
      const inherited = systemText(first.messages);
      assert.ok(inherited.includes('RECORDED_BROWSER_GUIDANCE'));
      assert.ok(inherited.includes('RECORDED_MCP_GUIDANCE'));
      const btwInstruction = promptString('btw.json', 'system');
      assert.ok(inherited.includes('PARENT_SYSTEM_MARKER'), 'the parent system prompt is inherited');
      assert.ok(inherited.includes(btwInstruction), 'the /btw instruction is appended');
      assert.ok(
        inherited.indexOf('PARENT_SYSTEM_MARKER') < inherited.indexOf(btwInstruction),
        'the /btw instruction follows the inherited prompt instead of replacing it',
      );
      assert.equal(first.model.id, harness.snapshot.model!.id, 'the physical model is reused');
      assert.equal(first.model.api, scenario.api);
      assert.equal(first.reasoning, 'medium', 'the parent thinking level is inherited');
      assert.notEqual(first.sessionId, parentSessionId, 'the conversation keeps its own local session id');

      assert.ok(first.onPayload, 'the cache identity hook is installed');
      if (scenario.api === 'openai-responses') {
        const nativeKey = limitSessionCacheKey(first.sessionId);
        assert.ok(nativeKey);
        const adapted = await first.onPayload(
          { prompt_cache_key: nativeKey },
          first.model,
        ) as Record<string, unknown>;
        assert.equal(adapted['prompt_cache_key'], harness.snapshot.cacheKey);
      } else {
        const payload = { messages: [] };
        const adapted = await first.onPayload(payload, first.model);
        assert.deepEqual(adapted, payload, 'Anthropic payloads are not given an OpenAI cache key');
      }

      const third = harness.requests.find((request) => request.phase === 'btw' && request.step === 2);
      assert.ok(third);
      const followUps = JSON.stringify(third.messages);
      assert.ok(followUps.includes('first side question'), 'the /btw follow-up history is retained');
      assert.ok(followUps.includes('second side question'));

      assert.deepEqual(harness.parent.messages, parentMessages, 'the parent transcript is unchanged');
      assert.deepEqual(harness.parent.sessionManager.getBranch(), parentBranch, 'the parent branch is unchanged');
      assert.deepEqual(harness.parent.getActiveToolNames(), parentActive, 'the parent active tools are unchanged');
      assert.equal(harness.factoryLoads.count, 1, 'the parent extension factory did not run again');
      await assert.rejects(access(harness.extensionMarker), 'a project extension was loaded');

      await btw.dispose();
      await assert.rejects(btw.ask('after dispose', () => {}), /\/btw is closed\./);
    } finally {
      await harness.cleanup();
    }
  });
}

test('real /btw plain no-additive model inherits the prompt but exposes no tools', { timeout: 30_000 }, async () => {
  const harness = await openHarness({
    api: 'openai-completions',
    btwReply(step, request) {
      if (step === 0) return toolCall(request.model, 'plain-parent-attempt', 'parent_probe', {});
      return assistant(request.model, [{ type: 'text', text: 'after plain rejection' }], 'stop');
    },
  });
  try {
    const btw = await harness.open();
    const chunks: string[] = [];
    await btw.ask('plain side question', (text) => chunks.push(text));

    const first = harness.requests.find((request) => request.phase === 'btw' && request.step === 0);
    assert.ok(first);
    assert.deepEqual(toolNames(first.messages), [], 'a no-additive transport receives no tool declarations');
    const inherited = systemText(first.messages);
    assert.ok(inherited.includes('RECORDED_BROWSER_GUIDANCE'));
    assert.ok(inherited.includes('RECORDED_MCP_GUIDANCE'));
    assert.ok(inherited.includes('PARENT_SYSTEM_MARKER'));
    assert.ok(inherited.includes(promptString('btw.json', 'system')));
    assert.ok(!inherited.includes('unavailable in this session'), 'no additive blocked-tool notes are sent');
    assert.equal(first.reasoning, 'medium');
    assert.equal(first.model.id, harness.snapshot.model!.id);

    assert.ok(first.onPayload);
    const payload = { prompt_cache_key: 'fixture-cache-key' };
    assert.deepEqual(await first.onPayload(payload, first.model), payload,
      'a non-Responses transport keeps its payload unchanged');

    const second = harness.requests.find((request) => request.phase === 'btw' && request.step === 1);
    assert.ok(second);
    const rejection = second.messages.findLast((message): message is ToolResult =>
      message.role === 'toolResult' && message.toolName === 'parent_probe');
    assert.ok(rejection, 'the attempted parent tool is rejected');
    assert.equal(rejection.isError, true);
    assert.match(textOf(rejection), /not found|unavailable|blocked/i);
    assert.equal(harness.parentExecutions.count, 0, 'the parent tool handle never ran');
    assert.equal(chunks.filter(Boolean).at(-1), 'after plain rejection');
  } finally {
    await harness.cleanup();
  }
});

test('real /btw cancel aborts only the in-flight ask and keeps the conversation usable', { timeout: 30_000 }, async () => {
  const harness = await openHarness({
    api: 'openai-responses',
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
    btwReply(step, request) {
      if (step === 0) return pendingAnswer(request.model, 'partial cancel', request.signal);
      return assistant(request.model, [{ type: 'text', text: 'after cancel' }], 'stop');
    },
  });
  try {
    const btw = await harness.open();
    const chunks: string[] = [];
    let firstText: (() => void) | undefined;
    const first = new Promise<void>((resolve) => { firstText = resolve; });
    const pending = btw.ask('cancel this', (text) => {
      chunks.push(text);
      if (text.length > 0) firstText?.();
    });
    const settled = pending.then(() => 'resolved' as const, (error: unknown) => error);
    await first;
    await btw.cancel();
    const cancelled = await settled;
    assert.ok(
      cancelled === 'resolved' || (cancelled instanceof Error && cancelled.name === 'AbortError'),
      String(cancelled),
    );
    assert.ok(chunks.some((text) => text.includes('partial cancel')));

    await btw.ask('after cancel', () => {});
    const requests = harness.requests.filter((request) => request.phase === 'btw');
    assert.equal(requests.length, 2);
    assert.ok(JSON.stringify(requests[1]!.messages).includes('cancel this'));
    assert.equal(harness.parentExecutions.count, 0);
  } finally {
    await harness.cleanup();
  }
});

test('real /btw dispose and the external signal fence late work', { timeout: 30_000 }, async () => {
  const harness = await openHarness({
    api: 'anthropic-messages',
    compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
    btwReply(step, request) {
      if (step === 0) return pendingAnswer(request.model, 'partial dispose', request.signal);
      return assistant(request.model, [{ type: 'text', text: 'unexpected' }], 'stop');
    },
  });
  try {
    const btw = await harness.open();
    let firstText: (() => void) | undefined;
    const first = new Promise<void>((resolve) => { firstText = resolve; });
    const pending = btw.ask('dispose this', (text) => {
      if (text.length > 0) firstText?.();
    });
    const settled = pending.then(() => 'resolved' as const, (error: unknown) => error);
    await first;
    await btw.dispose();
    const disposed = await settled;
    assert.ok(
      disposed === 'resolved' || (disposed instanceof Error && disposed.name === 'AbortError'),
      String(disposed),
    );
    await assert.rejects(btw.ask('after dispose', () => {}), /\/btw is closed\./);

    const controller = new AbortController();
    const aborted = await harness.open(controller.signal);
    controller.abort();
    await assert.rejects(aborted.ask('after signal', () => {}), (error: unknown) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, 'AbortError');
      return true;
    });
    await aborted.dispose();
    assert.equal(harness.parentExecutions.count, 0);
  } finally {
    await harness.cleanup();
  }
});
