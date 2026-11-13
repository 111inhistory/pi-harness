/**
 * Real SDK boundary for Capability's current request snapshot.
 *
 * Two discoveries happen in one run. The provider request after each tool result
 * must carry exactly one latest `capabilities` section at the actual request tail;
 * the earlier request snapshot is not replayed and no placement custom entry is
 * written.
 */
import assert from 'node:assert/strict';
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
import {
  CAPABILITY_DISCOVERY_RECORD,
  appendDiscoveryRecord,
} from '../../src/capability/discovery-record.ts';
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

function current(messages: readonly ProjectionMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index]?.sections?.[CAPABILITY_SECTION];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

test('same-run tool results refresh one current snapshot at the request tail', { timeout: 30_000 }, async () => {
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
    assert.equal(current(requests[0]!), undefined);
    const first = current(requests[1]!);
    const second = current(requests[2]!);
    assert.ok(first);
    assert.ok(second);
    assert.match(first, /snapshot-1/);
    assert.doesNotMatch(first, /snapshot-2/);
    assert.match(second, /snapshot-1/);
    assert.match(second, /snapshot-2/);
    assert.equal(requests[1]!.at(-1)?.role, 'system');
    assert.equal(requests[2]!.at(-1)?.role, 'system');
    assert.deepEqual(errors, []);

    const placementRecords = session.sessionManager.getBranch().filter((entry) =>
      entry.type === 'custom' &&
      (entry.customType === 'harness-capability-memory' || entry.customType === 'harness-tool-guidance'));
    assert.deepEqual(placementRecords, [], 'the snapshot is request-only');
    assert.equal(session.sessionManager.getBranch().filter((entry) =>
      entry.type === 'custom' && entry.customType === CAPABILITY_DISCOVERY_RECORD).length, 2);
    assert.ok(api);
  } finally {
    try {
      await session?.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
      session?.dispose();
    } finally {
      // The in-memory session owns the loader lifecycle here.
    }
  }
});
