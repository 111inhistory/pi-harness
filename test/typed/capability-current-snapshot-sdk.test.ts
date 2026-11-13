/**
 * Real SDK boundary for Capability's current request snapshot.
 *
 * Two discoveries happen in one run. The provider request after each tool result
 * must carry exactly one latest `capabilities` section at the actual request tail;
 * the earlier request snapshot is not replayed and no placement custom entry is
 * written.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fauxProvider, InMemoryCredentialStore, type AssistantMessage, type Api, type Model } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

import capabilityExtension from '../../src/capability/extension.ts';
import { DEFAULT_HARNESS_CONFIG } from '../../src/harness-config.ts';
import { installPresetInstruction } from '../../src/preset/instruction.ts';
import { appendPresetState } from '../../src/preset/state.ts';
import {
  CAPABILITY_DISCOVERY_RECORD,
  appendDiscoveryRecord,
} from '../../src/capability/discovery-record.ts';
import { convertResponsesMessages } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js';
import { HARNESS_CONTEXT_SYNC_CUSTOM_TYPE } from '../../src/request-instructions.ts';
import { CAPABILITY_SECTION, type ProjectionMessage } from '../../src/capability/prompt.ts';

const coverage = { local: 'searched' as const, remote: 'not_searched' as const };

function assistant(model: Model<Api>, content: AssistantMessage['content'], stopReason: 'toolUse' | 'stop'): AssistantMessage {
  return {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason,
    timestamp: Date.now(),
    usage: {
      input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
}

function toolCall(model: Model<Api>, id: string): AssistantMessage {
  return assistant(model, [{ type: 'toolCall', id, name: 'capability', arguments: {} }], 'toolUse');
}

function currentUserSync(messages: readonly ProjectionMessage[]): string | undefined {
  const last = messages.at(-1);
  if (last?.role !== 'user') return undefined;
  return JSON.stringify(last.content);
}

test('same-run tool results refresh one current snapshot as a persisted user boundary (no developer_tail)', { timeout: 30_000 }, async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: 'snapshot-model' }] });
  runtime.registerNativeProvider(faux.provider);
  const model: Model<Api> = {
    ...faux.models[0]!, api: 'openai-responses',
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  };
  const settings = SettingsManager.inMemory({
    packages: [], extensions: [], defaultTools: ['read', 'capability'],
    retry: { enabled: false }, cacheWarming: 'off', compaction: { enabled: false, keepRecentTokens: 0 },
  });
  const requests: ProjectionMessage[][] = [];
  let discoveries = 0;
  let session: AgentSession | undefined;
  let api: ExtensionAPI | undefined;

  faux.provider.streamSimple = (_model, context) => {
    requests.push(structuredClone(context.messages) as unknown as ProjectionMessage[]);
    const reply = requests.length <= 2
      ? toolCall(model, `snapshot-call-${requests.length}`)
      : assistant(model, [{ type: 'text', text: 'done' }], 'stop');
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: reply.stopReason as 'toolUse' | 'stop', message: reply });
    stream.end();
    return stream;
  };

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(), agentDir: process.cwd(), settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{
      name: 'capability-current-snapshot',
      factory(pi) {
        api = pi;
        capabilityExtension(pi, { discovery: false });
        pi.registerTool({
          name: 'capability', label: 'Capability fixture', description: 'Offline discovery',
          parameters: { type: 'object', properties: {} },
          async execute(toolCallId) {
            discoveries += 1;
            const ref = `skill://snapshot-${discoveries}`;
            const details = {
              status: 'ok' as const, tools: [], mcp: [],
              skills: [{ ref, name: `snapshot-${discoveries}`, filePath: `/skills/snapshot-${discoveries}/SKILL.md` }],
            };
            appendDiscoveryRecord(pi, toolCallId, details, coverage);
            return { content: [{ type: 'text' as const, text: `selected ${discoveries}` }], details };
          },
        });
      },
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  try {
    session = (await createAgentSession({
      cwd: process.cwd(), agentDir: process.cwd(), modelRuntime: runtime, model,
      settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(process.cwd()),
    })).session;
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    await session.prompt('Discover twice');

    assert.equal(requests.length, 3);
    assert.equal(currentUserSync(requests[0]!)?.includes('snapshot-'), false);
    const first = currentUserSync(requests[1]!);
    const second = currentUserSync(requests[2]!);
    assert.ok(first);
    assert.ok(second);
    assert.match(first, /snapshot-1/);
    assert.doesNotMatch(first, /snapshot-2/);
    assert.match(second, /snapshot-1/);
    assert.match(second, /snapshot-2/);
    assert.equal(requests[1]!.at(-1)?.role, 'user');
    assert.equal(requests[2]!.at(-1)?.role, 'user');
    assert.equal(requests[1]!.some((m, i) => i > 0 && m.role === 'system'), false);
    assert.equal(requests[2]!.some((m, i) => i > 0 && m.role === 'system'), false);

    // Verify encoded Responses wire order ends on user (no developer_tail).
    const wire2 = convertResponsesMessages(
      model,
      { messages: requests[2] as never } as never,
      new Set([model.provider]),
      { includeSystemPrompt: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
    ) as Array<{ role?: string; type?: string }>;
    assert.equal(wire2.at(-1)?.role, 'user');
    assert.equal(wire2.some((item, index) => index > 0 && item.role === 'developer'), false);
    assert.deepEqual(errors, []);

    const syncEntries = session.sessionManager.getBranch().filter((entry) =>
      entry.type === 'custom_message' && entry.customType === HARNESS_CONTEXT_SYNC_CUSTOM_TYPE);
    assert.equal(syncEntries.length, 2, 'mid-run discovery boundaries persist custom_message entries');

    const placementRecords = session.sessionManager.getBranch().filter((entry) =>
      entry.type === 'custom' &&
      (entry.customType === 'harness-capability-memory' || entry.customType === 'harness-tool-guidance'));
    assert.deepEqual(placementRecords, [], 'the snapshot is request-only');
    assert.equal(session.sessionManager.getBranch().filter((entry) =>
      entry.type === 'custom' && entry.customType === CAPABILITY_DISCOVERY_RECORD).length, 2);
    assert.ok(api);
    assert.equal(CAPABILITY_SECTION, 'capabilities');
  } finally {
    try {
      await session?.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
      session?.dispose();
    } finally {
      // The in-memory session owns the loader lifecycle here.
    }
  }
});

function responsesWire(model: Model<Api>, messages: readonly ProjectionMessage[]): Array<{ role?: string; type?: string }> {
  return convertResponsesMessages(
    model,
    { messages: messages as never } as never,
    new Set([model.provider]),
    { includeSystemPrompt: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  ) as Array<{ role?: string; type?: string }>;
}

test('unchanged tool loop ends on function_call_output; mid-run static tool activation seals updateMessage with user sync', { timeout: 30_000 }, async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: 'static-activation-model' }] });
  runtime.registerNativeProvider(faux.provider);
  const model: Model<Api> = {
    ...faux.models[0]!, api: 'openai-responses',
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  };
  const settings = SettingsManager.inMemory({
    packages: [], extensions: [], defaultTools: ['read', 'capability'],
    retry: { enabled: false }, cacheWarming: 'off', compaction: { enabled: false, keepRecentTokens: 0 },
  });
  const requests: ProjectionMessage[][] = [];
  let session: AgentSession | undefined;
  let extApi!: ExtensionAPI;

  faux.provider.streamSimple = (_model, context) => {
    requests.push(structuredClone(context.messages) as unknown as ProjectionMessage[]);
    const step = requests.length;
    let reply: AssistantMessage;
    if (step === 1) {
      reply = assistant(model, [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'ignored' } }], 'toolUse');
    } else if (step === 2) {
      reply = assistant(model, [{ type: 'toolCall', id: 'c2', name: 'capability', arguments: {} }], 'toolUse');
    } else if (step === 3) {
      reply = assistant(model, [{ type: 'toolCall', id: 'c3', name: 'read', arguments: { path: 'ignored-2' } }], 'toolUse');
    } else {
      reply = assistant(model, [{ type: 'text', text: 'all done' }], 'stop');
    }
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: reply.stopReason as 'toolUse' | 'stop', message: reply });
    stream.end();
    return stream;
  };

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(), agentDir: process.cwd(), settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{
      name: 'static-activation-fixture',
      factory(pi) {
        extApi = pi;
        installPresetInstruction(pi);
        capabilityExtension(pi, { discovery: false });
        pi.registerTool({
          name: 'read', label: 'Read fixture', description: 'Read fixture',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
          async execute(_id, params) {
            return { content: [{ type: 'text' as const, text: `read:${String((params as { path?: string }).path)}` }], details: {} };
          },
        });
        pi.registerTool({
          name: 'subagent_create', label: 'Subagent create', description: 'Create subagent',
          defaultActive: false,
          namespace: { name: 'subagent', description: 'Subagent', instructions: 'NATIVE_SUBAGENT_NAMESPACE_RULE' },
          promptGuidelines: ['NATIVE_SUBAGENT_NAMESPACE_RULE', 'NATIVE_SUBAGENT_CREATE_GUIDELINE'],
          parameters: { type: 'object', properties: {} },
          async execute() {
            return { content: [{ type: 'text' as const, text: 'created' }], details: {} };
          },
        });
        pi.registerTool({
          name: 'capability', label: 'Capability fixture', description: 'Offline discovery',
          parameters: { type: 'object', properties: {} },
          async execute(toolCallId) {
            const details = {
              status: 'ok' as const,
              tools: [{
                ref: 'namespace://subagent',
                name: 'subagent',
                instructions: 'NATIVE_SUBAGENT_NAMESPACE_RULE',
                tools: [{ ref: 'tool://subagent_create', name: 'subagent_create', description: 'Create subagent', exposure: 'direct' as const }],
              }],
              mcp: [],
              skills: [],
            };
            appendDiscoveryRecord(pi, toolCallId, details, coverage);
            pi.setActiveTools([...pi.getActiveTools(), 'subagent_create']);
            return { content: [{ type: 'text' as const, text: 'selected subagent' }], details };
          },
        });
      },
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  try {
    session = (await createAgentSession({
      cwd: process.cwd(), agentDir: process.cwd(), modelRuntime: runtime, model,
      settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(process.cwd()),
    })).session;
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    appendPresetState(extApi, { version: 1, snapshot: { name: 'fast', instructions: 'INITIAL_PRESET_BODY' } });
    await session.prompt('Run loop');

    assert.equal(requests.length, 4);
    assert.match(JSON.stringify(requests[0]![0]?.sections?.['preset-instructions'] ?? ''), /INITIAL_PRESET_BODY/);
    const wire0 = responsesWire(model, requests[0]!);
    const wire1 = responsesWire(model, requests[1]!);
    const wire2 = responsesWire(model, requests[2]!);
    const wire3 = responsesWire(model, requests[3]!);

    assert.equal(wire0.at(-1)?.role, 'user', 'initial request ends on user');
    assert.equal(wire1.at(-1)?.type, 'function_call_output', 'unchanged tool step ends on function_call_output');
    assert.equal(wire2.at(-1)?.role, 'user', 'mid-run static tool activation seals updateMessage with user sync');
    assert.ok(wire2.some((item, index) => index > 0 && item.role === 'developer'),
      'SDK emitted updateMessage for activated subagent_create + promptGuidelines');
    const syncBody = JSON.stringify(requests[2]!.at(-1));
    assert.match(syncBody, /subagent_create/);
    assert.doesNotMatch(syncBody, /NATIVE_SUBAGENT_NAMESPACE_RULE/,
      'capabilities sync omits namespace prose already emitted natively via promptGuidelines');
    assert.equal(wire3.at(-1)?.type, 'function_call_output',
      'subsequent unchanged tool step after activation ends on function_call_output');
    assert.deepEqual(errors, []);
  } finally {
    await session?.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
    session?.dispose();
  }
});

test('nested swallowed capability calls coalesce into one persisted user sync message', { timeout: 30_000 }, async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: 'nested-discovery-model' }] });
  runtime.registerNativeProvider(faux.provider);
  const model: Model<Api> = {
    ...faux.models[0]!, api: 'openai-responses',
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  };
  const settings = SettingsManager.inMemory({
    packages: [], extensions: [], defaultTools: ['codemode', 'capability'],
    retry: { enabled: false }, cacheWarming: 'off', compaction: { enabled: false, keepRecentTokens: 0 },
  });
  const requests: ProjectionMessage[][] = [];
  let discoveries = 0;
  let session: AgentSession | undefined;

  faux.provider.streamSimple = (_model, context) => {
    requests.push(structuredClone(context.messages) as unknown as ProjectionMessage[]);
    const reply = requests.length === 1
      ? assistant(model, [{ type: 'toolCall', id: 'outer-codemode', name: 'codemode', arguments: {} }], 'toolUse')
      : assistant(model, [{ type: 'text', text: 'after nested' }], 'stop');
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: reply.stopReason as 'toolUse' | 'stop', message: reply });
    stream.end();
    return stream;
  };

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(), agentDir: process.cwd(), settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{
      name: 'nested-swallow-fixture',
      factory(pi) {
        capabilityExtension(pi, { discovery: false });
        pi.registerTool({
          name: 'capability', label: 'Capability fixture', description: 'Offline discovery',
          parameters: { type: 'object', properties: {} },
          async execute(toolCallId) {
            discoveries += 1;
            const details = {
              status: 'ok' as const, tools: [], mcp: [],
              skills: [{ ref: `skill://nested-${discoveries}`, name: `nested-${discoveries}`, filePath: `/skills/nested-${discoveries}/SKILL.md` }],
            };
            appendDiscoveryRecord(pi, toolCallId, details, coverage);
            return { content: [{ type: 'text' as const, text: `inner-${discoveries}` }], details };
          },
        });
        pi.registerTool({
          name: 'codemode', label: 'Codemode fixture', description: 'Outer caller',
          parameters: { type: 'object', properties: {} },
          async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
            await ctx.executeTool('capability', {});
            await ctx.executeTool('capability', {});
            return { content: [{ type: 'text' as const, text: 'SWALLOWED_OUTER_RESULT' }], details: {} };
          },
        });
      },
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  try {
    session = (await createAgentSession({
      cwd: process.cwd(), agentDir: process.cwd(), modelRuntime: runtime, model,
      settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(process.cwd()),
    })).session;
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    await session.prompt('Run nested discovery');

    assert.equal(requests.length, 2);
    const wire1 = responsesWire(model, requests[1]!);
    assert.equal(wire1.at(-1)?.role, 'user', 'outer tool boundary ends on persisted user sync message');
    const syncEntries = session.sessionManager.getBranch().filter((entry) =>
      entry.type === 'custom_message' && entry.customType === HARNESS_CONTEXT_SYNC_CUSTOM_TYPE);
    assert.equal(syncEntries.length, 1, 'two nested capability calls coalesce into one persisted custom_message');
    const syncText = JSON.stringify(syncEntries[0]);
    assert.match(syncText, /nested-1/);
    assert.match(syncText, /nested-2/);
    assert.deepEqual(errors, []);
  } finally {
    await session?.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
    session?.dispose();
  }
});

test('mid-run auto-compaction persists user boundary carrying capability-availability and survives reopen + forced prompt', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-midrun-compact-'));
  const sessionDir = path.join(dir, 'sessions');
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: 'compact-model', contextWindow: 1000 }] });
  runtime.registerNativeProvider(faux.provider);
  const model: Model<Api> = {
    ...faux.models[0]!, api: 'openai-responses', contextWindow: 1000,
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  };
  const settings = SettingsManager.inMemory({
    packages: [], extensions: [], defaultTools: ['read', 'capability', 'codemode'],
    retry: { enabled: false }, cacheWarming: 'off',
    compaction: { enabled: true, reserveTokens: 900, keepRecentTokens: 1 },
  });
  const requests: ProjectionMessage[][] = [];
  let forced = false;
  let session: AgentSession | undefined;
  let extApi!: ExtensionAPI;

  faux.provider.streamSimple = (_model, context) => {
    requests.push(structuredClone(context.messages) as unknown as ProjectionMessage[]);
    const step = requests.length;
    const reply = step === 1
      ? assistant(model, [{ type: 'toolCall', id: 'compact-read-1', name: 'read', arguments: { path: 'a' } }], 'toolUse')
      : step === 2
        ? assistant(model, [{ type: 'toolCall', id: 'compact-read-2', name: 'read', arguments: { path: 'b' } }], 'toolUse')
        : assistant(model, [{ type: 'text', text: 'done' }], 'stop');
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: reply.stopReason as 'toolUse' | 'stop', message: reply });
    stream.end();
    return stream;
  };

  const openSession = async (manager: SessionManager) => {
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [{
        name: 'midrun-compact-fixture',
        factory(pi) {
          extApi = pi;
          pi.on('before_agent_start', () => forced ? { systemPrompt: 'FORCED_SYSTEM_BASE' } : undefined);
          installPresetInstruction(pi);
          capabilityExtension(pi, {
            discovery: false,
            config: { ...DEFAULT_HARNESS_CONFIG, capability: { ...DEFAULT_HARNESS_CONFIG.capability, pruneOnCompaction: true } },
          });
          pi.registerTool({
            name: 'read', label: 'Read fixture', description: 'Read fixture',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
            async execute(_id, params) {
              const p = String((params as { path?: string }).path);
              return { content: [{ type: 'text' as const, text: p === 'a' ? `read:${p}:${'x'.repeat(2000)}` : `read:${p}:short` }], details: {} };
            },
          });
          pi.registerTool({
            name: 'prunable_tool', label: 'Prunable tool', description: 'Unused discovered tool',
            defaultActive: false,
            parameters: { type: 'object', properties: {} },
            async execute() { return { content: [{ type: 'text' as const, text: 'ok' }], details: {} }; },
          });
          pi.on('session_before_compact', (event) => ({
            compaction: {
              summary: 'Mid-run summary',
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          }));
        },
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const created = (await createAgentSession({
      cwd: dir, agentDir: dir, modelRuntime: runtime, model,
      settingsManager: settings, resourceLoader: loader, sessionManager: manager,
    })).session;
    await created.bindExtensions({ onError: (error) => { throw error; } });
    return created;
  };

  try {
    session = await openSession(SessionManager.create(dir, sessionDir));
    appendPresetState(extApi, { version: 1, snapshot: { name: 'compact', instructions: 'PRESET_SURVIVES_REOPEN' } });
    appendDiscoveryRecord(extApi as never, 'seed-discovery', {
      status: 'ok',
      tools: [{ ref: 'tool://prunable_tool', name: 'prunable_tool', kind: 'tool', exposure: 'direct' }],
      mcp: [],
      skills: [{ ref: 'skill://kept', name: 'kept', filePath: '/skills/kept/SKILL.md' }],
    }, coverage);
    extApi.setActiveTools([...extApi.getActiveTools(), 'prunable_tool']);

    await session.prompt('Trigger mid-run compaction');
    assert.equal(requests.length, 3);

    const wire2 = responsesWire(model, requests[1]!);
    assert.equal(wire2.at(-1)?.role, 'user',
      'mid-run auto-compaction emits a persisted user sync message after toolsRemoved updateMessage');
    const syncText = JSON.stringify(requests[1]!.at(-1));
    assert.match(syncText, /capability-availability/);
    assert.match(syncText, /prunable_tool/);
    assert.match(syncText, /\/skills\/kept\/SKILL\.md/);

    const wire3 = responsesWire(model, requests[2]!);
    assert.equal(wire3.at(-1)?.type, 'function_call_output',
      'subsequent unchanged tool step after mid-run compaction ends on function_call_output');

    const sessionFile = session.sessionManager.getSessionFile();
    assert.ok(sessionFile);
    await session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();

    session = await openSession(SessionManager.open(sessionFile));
    await session.prompt('After reopen');
    const reopened = requests.at(-1)!;
    const reopenedWire = responsesWire(model, reopened);
    assert.equal(reopenedWire.at(-1)?.role, 'user');
    assert.equal(reopenedWire.some((item, idx) => idx > 0 && item.role === 'developer'), false);
    assert.match(JSON.stringify(reopened), /PRESET_SURVIVES_REOPEN/);
    assert.match(JSON.stringify(reopened), /\/skills\/kept\/SKILL\.md/);

    forced = true;
    await session.prompt('Forced turn');
    const forcedReq = requests.at(-1)!;
    assert.equal(forcedReq[0]?.role, 'system');
    assert.equal(forcedReq[0]?.content, 'FORCED_SYSTEM_BASE');
    assert.equal(responsesWire(model, forcedReq).some((item, idx) => idx > 0 && item.role === 'developer'), false);
  } finally {
    try {
      await session?.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
      session?.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
