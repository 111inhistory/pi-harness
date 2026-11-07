import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { fauxProvider, InMemoryCredentialStore, normalizeContext, type AssistantMessage, type Message, type Model, type Api } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import capabilityExtension from '../../src/capability/extension.ts';
import { appendDiscoveryRecord, latestPruneRecord } from '../../src/capability/discovery-record.ts';
import { convertResponsesMessages } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js';

const USED = 'fixture_browser_open';
const UNUSED = 'fixture_browser_close';
const BASELINE = 'fixture_configured_baseline';
const coverage = { local: 'searched', remote: 'not_searched' } as const;

function answer(model: Model<Api>, step: string, nested: boolean): AssistantMessage {
  const name = step === 'discover' ? 'capability' : step === 'use' ? (nested ? 'codemode' : USED) : null;
  return {
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: name ? [{ type: 'toolCall', id: `call-${step}-${Date.now()}`, name,
      arguments: name === 'codemode' ? { code: `await tools.${USED}({});` } : {} }]
      : [{ type: 'text', text: 'Done' }],
    stopReason: step === 'overflow' ? 'error' : name ? 'toolUse' : 'stop', timestamp: Date.now(),
    ...(step === 'overflow' ? { errorMessage: 'maximum context length exceeded' } : {}),
    usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
  };
}

function wire(model: Model<Api>, messages: readonly Message[]): readonly unknown[] {
  return convertResponsesMessages(model, normalizeContext({ messages: [...messages] }), new Set([model.provider]), {
    includeSystemPrompt: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true,
  }) as unknown as readonly unknown[];
}

for (const nested of [false, true]) {
test(`real compaction prunes unused tools and rediscovery keeps the checkpoint prefix (nested: ${nested})`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-capability-pruning-'));
  let session: AgentSession | undefined;
  t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ models: [{ id: 'pruning-fixture' }] });
  const requests: Message[][] = [];
  let script = ['discover', 'use', 'done'];
  faux.provider.streamSimple = (model, context) => {
    requests.push(structuredClone(context.messages));
    const message = answer(model, script.shift() ?? 'done', nested);
    const stream = new AssistantMessageEventStream();
    if (message.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message });
    else stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    stream.end();
    return stream;
  };
  runtime.registerNativeProvider(faux.provider);
  const model = { ...faux.models[0]!, api: 'openai-responses', compat: {
    supportsMidConvoSystemMessages: true, supportsAdditionalTools: true,
  } } as Model<Api>;
  const settings = SettingsManager.inMemory({ packages: [], extensions: [],
    defaultTools: ['read', 'bash', 'edit', 'write', 'capability', BASELINE], retry: { enabled: false },
    cacheWarming: 'off', compaction: { enabled: false, keepRecentTokens: 0 } });
  const errors: unknown[] = [];
  let pi: ExtensionAPI | undefined;
  let cancelCompaction = false;
  let rejectPruneWrite = false;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{ name: 'capability-pruning-fixture', factory(api) {
      pi = api;
      const appendEntry = api.appendEntry;
      api.appendEntry = (kind, data) => {
        if (kind === 'capability-prune' && rejectPruneWrite) throw new Error('Synthetic prune persistence failure');
        appendEntry(kind, data);
      };
      capabilityExtension(api, { discovery: false });
      api.registerTool({ name: BASELINE, label: BASELINE, description: 'Configured baseline',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'Baseline' }], details: {} }),
      });
      for (const name of [USED, UNUSED]) api.registerTool({
        name, label: name, description: name, defaultActive: false,
        namespace: { name: 'browser-fixture', instructions: 'Use the browser fixture' },
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'Executed' }], details: {} }),
      });
      api.registerTool({ name: 'capability', label: 'Discover', description: 'Offline discovery',
        parameters: { type: 'object', properties: {} }, async execute(toolCallId) {
          appendDiscoveryRecord(api, toolCallId, { status: 'ok', tools: [{ ref: `tool://${BASELINE}`, name: BASELINE }], skills: [], mcp: [{
            ref: 'namespace://browser-fixture', name: 'browser-fixture', instructions: 'Use the browser fixture',
            tools: [USED, UNUSED].map(name => ({ ref: `tool://${name}`, name })),
          }] }, coverage);
          api.setActiveTools([...new Set([...api.getActiveTools(), 'codemode', USED, UNUSED])]);
          return { content: [{ type: 'text', text: 'Selected browser fixture' }], details: {} };
        } });
      api.on('session_before_compact', event => cancelCompaction ? { cancel: true } : ({ compaction: {
        summary: `Historical browser tools: ${USED}, ${UNUSED}`,
        firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
      } }));
    } }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  session = (await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model,
    settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root) })).session;
  await session.bindExtensions({ onError: error => { errors.push(error); } });
  await session.prompt('Discover and use one browser member.');
  assert.ok(session.getActiveToolNames().includes(UNUSED));
  await session.compact();
  assert.ok(session.getActiveToolNames().includes(USED));
  assert.ok(!session.getActiveToolNames().includes(UNUSED));
  assert.deepEqual(latestPruneRecord(session.sessionManager.getBranch())?.removedTools, [UNUSED]);
  const count = requests.length;
  await session.prompt('Continue using the compacted context.');
  assert.equal(requests.length, count + 1, 'pruning and its notice create no additional model turn');
  const compacted = requests.at(-1)!;
  const summaryIndex = compacted.findIndex(message => message.role === 'user' &&
    JSON.stringify(message.content).includes('Historical browser tools'));
  assert.ok(summaryIndex >= 0);
  const notice = compacted[0];
  assert.equal(notice?.role, 'system');
  assert.match(JSON.stringify(notice), /References to them in the summary are historical/);
  assert.match(JSON.stringify(notice), new RegExp(UNUSED));
  const compactedWire = wire(model, compacted);
  const declarations = compacted.filter(message => message.role === 'system').flatMap(message => message.toolsAdded ?? []);
  assert.ok(!declarations.some(tool => tool.name === UNUSED), 'the new checkpoint has no unused declaration');
  script = ['discover', 'done'];
  await session.prompt('Rediscover the closed browser member.');
  const rediscovered = requests.at(-1)!;
  assert.ok(session.getActiveToolNames().includes(UNUSED));
  assert.deepEqual(wire(model, rediscovered).slice(0, compactedWire.length), compactedWire,
    'rediscovery appends a fresh tool declaration rather than restoring the old checkpoint version');
  assert.ok(pi);
  await session.compact();
  assert.deepEqual(errors, [], 'compaction lifecycle handlers complete');
  await session.prompt('No browser member was used during the last compaction window.');
  assert.ok(!session.getActiveToolNames().includes(USED));
  assert.ok(session.getActiveToolNames().includes(BASELINE), 'a configured baseline survives discovery and repeated compaction');
  assert.ok(!session.getActiveToolNames().includes(UNUSED));
  const prunedGroup = requests.at(-1)!;
  assert.ok(latestPruneRecord(session.sessionManager.getBranch())?.removedGroups?.includes('namespace://browser-fixture'));
  const systemText = prunedGroup.filter(message => message.role === 'system').map(message =>
    JSON.stringify({ content: message.content, sections: message.sections })).join('\n');
  assert.doesNotMatch(systemText, /Use the browser fixture/, 'a wholly unused namespace drops its common instructions');
  assert.deepEqual(errors, []);

  script = ['discover', 'done'];
  await session.prompt('Restore unused browser tools before an overflow retry.');
  session.setAutoCompactionEnabled(true);
  script = ['overflow', 'done'];
  const beforeOverflow = requests.length;
  await session.prompt('Recover this context overflow with compaction.');
  assert.equal(requests.length, beforeOverflow + 2, 'the native overflow retry needs no notification turn');
  assert.match(JSON.stringify(requests.at(-1)?.[0]), /References to them in the summary are historical/,
    'the first retry receives the compaction-head notice');
  assert.ok(!session.getActiveToolNames().includes(USED));
  assert.ok(!session.getActiveToolNames().includes(UNUSED));
  session.setAutoCompactionEnabled(false);

  script = ['discover', 'done'];
  await session.prompt('Restore the browser fixture for cancellation and persistence checks.');
  const beforeCancel = session.sessionManager.getBranch().length;
  cancelCompaction = true;
  await assert.rejects(session.compact(), /cancel/i);
  assert.equal(session.sessionManager.getBranch().length, beforeCancel);
  assert.ok(session.getActiveToolNames().includes(UNUSED));
  cancelCompaction = false;
  rejectPruneWrite = true;
  await session.compact();
  assert.ok(session.getActiveToolNames().includes(USED));
  assert.ok(session.getActiveToolNames().includes(UNUSED), 'a failed durable write cannot deactivate capabilities');
  assert.equal(errors.length, 1);
  assert.match(JSON.stringify(errors), /Synthetic prune persistence failure/);
});
}
