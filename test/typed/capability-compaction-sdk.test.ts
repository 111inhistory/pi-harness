import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { fauxProvider, getCurrentTools, InMemoryCredentialStore, normalizeContext, type AssistantMessage, type Message, type Model, type Api } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import capabilityExtension from '../../src/capability/extension.ts';
import { appendDiscoveryRecord, appendPruneRecord, latestPruneRecord } from '../../src/capability/discovery-record.ts';
import { DEFAULT_HARNESS_CONFIG } from '../../src/harness-config.ts';
import { appendPresetState } from '../../src/preset/state.ts';
import { enableCapabilityTargets } from '../../src/capability/enable.ts';
import { createToolAdmission } from '../../src/capability/admission.ts';
import { appendToolPermissionNotice, setToolPermission } from '../../src/capability/tool-permission.ts';
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

test("compaction prunes when enabled or a preset removed baseline tools", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-capability-pruning-off-"));
  let session: AgentSession | undefined;
  t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ models: [{ id: "pruning-fixture" }] });
  let script = ["discover", "use", "done"];
  faux.provider.streamSimple = (model, context) => {
    const message = answer(model, script.shift() ?? "done", false);
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    stream.end();
    return stream;
  };
  runtime.registerNativeProvider(faux.provider);
  const model = { ...faux.models[0]!, api: "openai-responses", compat: {
    supportsMidConvoSystemMessages: true, supportsAdditionalTools: true,
  } } as Model<Api>;
  const settings = SettingsManager.inMemory({ packages: [], extensions: [],
    defaultTools: ["read", "bash", "edit", "write", "capability", BASELINE], retry: { enabled: false },
    cacheWarming: "off", compaction: { enabled: false, keepRecentTokens: 0 } });
  const errors: unknown[] = [];
  let fixtureApi: ExtensionAPI | undefined;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{ name: "capability-pruning-fixture", factory(api) {
      fixtureApi = api;
      capabilityExtension(api, {
        discovery: false,
        config: {
          ...DEFAULT_HARNESS_CONFIG,
          capability: {
            ...DEFAULT_HARNESS_CONFIG.capability,
            pruneOnCompaction: false,
          },
        },
      });
      api.registerTool({ name: BASELINE, label: BASELINE, description: "Configured baseline",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "Baseline" }], details: {} }),
      });
      for (const name of [USED, UNUSED, "previously_pruned", "fixture_manual"]) api.registerTool({
        name, label: name, description: name, defaultActive: false,
        ...(name === "fixture_manual" ? { exposure: "deferred" as const } : {}),
        namespace: { name: "browser-fixture", instructions: "Use the browser fixture" },
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "Executed" }], details: {} }),
      });
      api.registerTool({ name: "capability", label: "Discover", description: "Offline discovery",
        parameters: { type: "object", properties: {} }, async execute(toolCallId) {
          appendDiscoveryRecord(api, toolCallId, { status: "ok", tools: [{ ref: "tool://" + BASELINE, name: BASELINE }], skills: [], mcp: [{
            ref: "namespace://browser-fixture", name: "browser-fixture", instructions: "Use the browser fixture",
            tools: [USED, UNUSED].map(name => ({ ref: "tool://" + name, name })),
          }] }, coverage);
          api.setActiveTools([...new Set([...api.getActiveTools(), USED, UNUSED])]);
          return { content: [{ type: "text", text: "Selected browser fixture" }], details: {} };
        } });
      api.on("session_before_compact", event => ({ compaction: {
        summary: "Historical browser tools: " + USED + ", " + UNUSED,
        firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
      } }));
    } }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  session = (await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model,
    settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root) })).session;
  await session.bindExtensions({ onError: error => { errors.push(error); } });

  // Pre-seed a historical prune record on the branch
  appendPruneRecord({ appendEntry: (k, d) => session!.sessionManager.appendCustomEntry(k, d) }, "prior-checkpoint", ["previously_pruned"], []);

  await session.prompt("Discover and use one browser member.");
  assert.ok(session.getActiveToolNames().includes(UNUSED));
  assert.ok(session.getActiveToolNames().includes(USED));
  assert.ok(!session.getActiveToolNames().includes("previously_pruned"));

  assert.ok(fixtureApi);
  assert.deepEqual(enableCapabilityTargets(fixtureApi, ["fixture_manual"], {
    branch: session.sessionManager.getBranch(),
  }).enabled, ["fixture_manual"]);

  // Merely having a preset does not enable pruning. No previous preset base
  // was reduced; this compaction must still honor the disabled global policy.
  appendPresetState({ appendEntry: (kind, data) => session!.sessionManager.appendCustomEntry(kind, data) }, {
    version: 1, snapshot: { name: 'fixture-preset', tools: [USED], instructions: null },
  });
  const pruneCount = session.sessionManager.getBranch().filter(entry =>
    entry.type === 'custom' && entry.customType === 'capability-prune').length;

  await session.compact();

  // With pruneOnCompaction false:
  // 1. UNUSED was not pruned
  assert.ok(session.getActiveToolNames().includes(UNUSED));
  assert.ok(session.getActiveToolNames().includes(USED));
  // 2. Previously pruned tool is not auto-restored
  assert.ok(!session.getActiveToolNames().includes("previously_pruned"));
  // 3. Historical prune record is preserved, no new record appended
  const latest = latestPruneRecord(session.sessionManager.getBranch());
  assert.equal(latest?.checkpointId, "prior-checkpoint");
  assert.deepEqual(latest?.removedTools, ["previously_pruned"]);
  assert.equal(session.sessionManager.getBranch().filter(entry =>
    entry.type === 'custom' && entry.customType === 'capability-prune').length, pruneCount,
    'a preset baseline alone cannot cause a new prune record while pruning is disabled');

  const writer = { appendEntry: (kind: string, data: unknown) => session!.sessionManager.appendCustomEntry(kind, data) };
  appendPresetState(writer, {
    version: 1, snapshot: { name: 'expanded', tools: [USED, UNUSED], instructions: null },
  });
  await session.prompt('A preset only added a baseline tool.');
  await session.compact();
  assert.ok(session.getActiveToolNames().includes(UNUSED), 'adding tools alone does not request pruning');
  assert.equal(latestPruneRecord(session.sessionManager.getBranch())?.checkpointId, 'prior-checkpoint');

  appendPresetState(writer, {
    version: 1, snapshot: { name: 'reduced', tools: [USED], instructions: null },
  });
  await session.prompt('A preset removed a baseline tool.');
  await session.compact();
  assert.ok(!session.getActiveToolNames().includes(UNUSED),
    'a baseline removal requests compaction pruning even when the global setting is false');
  assert.ok(session.getActiveToolNames().includes(USED), 'the current preset baseline is protected');
  assert.ok(session.getActiveToolNames().includes('fixture_manual'),
    'the independent manual set survives pruning requested by a preset removal');
  assert.ok(!latestPruneRecord(session.sessionManager.getBranch())?.removedTools.includes('fixture_manual'));
  const removalCheckpoint = latestPruneRecord(session.sessionManager.getBranch())?.checkpointId;
  assert.notEqual(removalCheckpoint, 'prior-checkpoint');

  script = ['discover', 'done'];
  await session.prompt('Rediscover tools after the requested pruning has completed.');
  assert.ok(session.getActiveToolNames().includes(UNUSED));
  await session.compact();
  assert.ok(session.getActiveToolNames().includes(UNUSED),
    'the baseline removal only requests pruning through the next successful compaction');
  assert.equal(latestPruneRecord(session.sessionManager.getBranch())?.checkpointId, removalCheckpoint,
    'an old preset removal does not keep overriding the disabled global setting');
  assert.deepEqual(errors, []);
});

test('an explicitly disabled discovered tool is excluded from compaction pruning', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-capability-pruning-disabled-'));
  let session: AgentSession | undefined;
  t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ models: [{ id: 'pruning-disabled-fixture' }] });
  const requests: Message[][] = [];
  let script = ['discover'];
  faux.provider.streamSimple = (model, context) => {
    requests.push(structuredClone(context.messages));
    const message = answer(model, script.shift() ?? 'done', false);
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    stream.end();
    return stream;
  };
  runtime.registerNativeProvider(faux.provider);
  const model = { ...faux.models[0]!, api: 'openai-responses', compat: {
    supportsMidConvoSystemMessages: true, supportsAdditionalTools: true,
  } } as Model<Api>;
  const settings = SettingsManager.inMemory({ packages: [], extensions: [],
    defaultTools: ['read', 'capability'], retry: { enabled: false },
    cacheWarming: 'off', compaction: { enabled: false, keepRecentTokens: 0 } });
  const errors: unknown[] = [];
  let fixtureApi: ExtensionAPI | undefined;
  const disabled = 'fixture_probe_disabled';
  const prunable = 'fixture_probe_prunable';
  const enabledProbe = 'fixture_probe_enabled';
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{ name: 'capability-pruning-disabled-fixture', factory(api) {
      fixtureApi = api;
      capabilityExtension(api, {
        discovery: false,
        config: {
          ...DEFAULT_HARNESS_CONFIG,
          capability: { ...DEFAULT_HARNESS_CONFIG.capability, pruneOnCompaction: true },
        },
      });
      for (const name of [disabled, prunable, enabledProbe]) api.registerTool({
        name, label: name, description: name, defaultActive: false,
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'Executed' }], details: {} }),
      });
      api.registerTool({ name: 'capability', label: 'Discover', description: 'Offline discovery',
        parameters: { type: 'object', properties: {} }, async execute(toolCallId) {
          appendDiscoveryRecord(api, toolCallId, { status: 'ok', skills: [], mcp: [],
            tools: [disabled, prunable, enabledProbe].map(name => ({ ref: `tool://${name}`, name })) }, coverage);
          api.setActiveTools([...new Set([...api.getActiveTools(), disabled, prunable, enabledProbe])]);
          return { content: [{ type: 'text', text: 'Selected all probes' }], details: {} };
        } });
      api.on('session_before_compact', event => ({ compaction: {
        summary: `Historical probes: ${disabled}, ${prunable}, ${enabledProbe}`,
        firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
      } }));
    } }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  session = (await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model,
    settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root) })).session;
  await session.bindExtensions({ onError: error => { errors.push(error); } });

  await session.prompt('Discover all probes without using them.');
  assert.ok(session.getActiveToolNames().includes(disabled));
  assert.ok(session.getActiveToolNames().includes(prunable));
  assert.ok(session.getActiveToolNames().includes(enabledProbe));
  assert.ok(fixtureApi);
  const writer = { appendEntry: (kind: string, data?: unknown) => session!.sessionManager.appendCustomEntry(kind, data) };
  setToolPermission(fixtureApi, writer, session.sessionManager.getBranch(), [disabled], 'disabled');
  appendToolPermissionNotice(writer, [disabled]);
  assert.deepEqual([...enableCapabilityTargets(fixtureApi, [enabledProbe], {
    branch: session.sessionManager.getBranch(),
  }).enabled], [enabledProbe]);

  await session.compact();
  const prune = latestPruneRecord(session.sessionManager.getBranch());
  assert.deepEqual(prune?.removedTools, [prunable],
    'the disabled probe keeps its prohibition and the enabled probe is protected');
  assert.ok(!session.getActiveToolNames().includes(disabled));
  assert.ok(!session.getActiveToolNames().includes(prunable));
  assert.ok(session.getActiveToolNames().includes(enabledProbe),
    'an explicitly enabled probe survives the unused-window prune');

  // An old prune record must not outrank an explicit enable for admission.
  const oldPruneBranch: unknown[] = [...session.sessionManager.getBranch()];
  appendPruneRecord({ appendEntry: (kind, data) => oldPruneBranch.push({ type: 'custom', customType: kind, data }) },
    'synthetic-old-prune', [enabledProbe], []);
  const admission = createToolAdmission(fixtureApi, oldPruneBranch);
  assert.equal(admission.declares(enabledProbe), true, 'enabled wins over a stale prune record');
  assert.equal(admission.admits(enabledProbe), true);

  // A repeated enable reactivates a tool that lost its active slot.
  fixtureApi.setActiveTools(session.getActiveToolNames().filter(name => name !== enabledProbe));
  assert.ok(!session.getActiveToolNames().includes(enabledProbe));
  const again = enableCapabilityTargets(fixtureApi, [enabledProbe], {
    branch: session.sessionManager.getBranch(),
  });
  assert.deepEqual([...again.alreadyEnabled], [enabledProbe]);
  assert.deepEqual([...again.enabled], []);
  assert.ok(session.getActiveToolNames().includes(enabledProbe), 'a repeated enable restores activation');

  script = ['done'];
  await session.prompt('After the compaction.');
  const systemText = requests.at(-1)!.filter(message => message.role === 'system')
    .map(message => JSON.stringify({ content: message.content, sections: message.sections })).join('\n');
  assert.match(systemText, /The user has disabled these tools/);
  assert.ok(systemText.includes(disabled), 'the disabled guidance keeps naming the tool');
  assert.match(systemText, /unused capabilities were removed/);
  assert.deepEqual(errors, []);
});

test('disable removes a lazy-hidden deferred tool immediately in only mode', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-capability-only-disable-'));
  let session: AgentSession | undefined;
  t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ models: [{ id: 'only-mode-fixture' }] });
  const declared: string[][] = [];
  faux.provider.streamSimple = (model, context) => {
    declared.push(getCurrentTools(context.messages).map(tool => tool.name));
    const message = answer(model, 'done', false);
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end();
    return stream;
  };
  runtime.registerNativeProvider(faux.provider);
  const model = { ...faux.models[0]!, api: 'openai-responses', compat: {
    supportsMidConvoSystemMessages: true, supportsAdditionalTools: true,
  } } as Model<Api>;
  const probe = 'fixture_probe_deferred';
  const rpcProbe = 'fixture_probe_rpc';
  const settings = SettingsManager.inMemory({ packages: [], extensions: [],
    codemode: { mode: 'only' }, defaultTools: ['read', 'codemode', probe, rpcProbe],
    retry: { enabled: false }, cacheWarming: 'off', compaction: { enabled: false } });
  let fixtureApi: ExtensionAPI | undefined;
  let rpcApi: ExtensionAPI | undefined;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{ name: 'only-mode-fixture', factory(api) {
      fixtureApi = api;
      capabilityExtension(api, {
        discovery: false,
        config: {
          ...DEFAULT_HARNESS_CONFIG,
          capability: { ...DEFAULT_HARNESS_CONFIG.capability, lazySchemas: ['namespace://probe_tools'] },
        },
      });
      api.registerTool({ name: probe, label: probe, description: probe, defaultActive: true,
        exposure: 'deferred', namespace: { name: 'probe_tools' },
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'Executed' }], details: {} }) });
    } }, { name: 'rpc-tool-port-fixture', factory(api) {
      rpcApi = api;
      api.registerTool({ name: rpcProbe, label: rpcProbe, description: rpcProbe, defaultActive: true,
        exposure: 'deferred', namespace: { name: 'probe_tools' },
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'Executed' }], details: {} }) });
    } }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  session = (await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model,
    settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root) })).session;
  await session.bindExtensions({ onError: error => { throw error; } });
  assert.ok(fixtureApi);
  assert.ok(rpcApi);
  assert.notEqual(rpcApi, fixtureApi, 'Pi gives each extension its own API object');
  assert.ok(session.getActiveToolNames().includes('codemode'));
  assert.ok(session.getActiveToolNames().includes(probe));
  assert.ok(session.getActiveToolNames().includes(rpcProbe));

  await session.prompt('Show the current declaration loadout.');
  assert.deepEqual(declared.at(-1), ['codemode'], 'only+lazy leaves no independent declaration for the probes');

  const branch = session.sessionManager.getBranch();
  const result = setToolPermission(fixtureApi, fixtureApi, branch, [probe], 'disabled');
  assert.deepEqual(result.removedActive, [probe], 'a lazy-hidden deferred tool loses its active slot immediately');
  assert.deepEqual(result.pendingCompaction, []);
  assert.ok(!session.getActiveToolNames().includes(probe));
  assert.equal(createToolAdmission(fixtureApi, session.sessionManager.getBranch()).admits(probe), false);

  // The RPC/subagent extension has its own API object; it must read the same
  // declaration reader through the shared extension bus, not fall back to
  // exposure and defer removal to compaction.
  const rpcResult = setToolPermission(rpcApi, rpcApi, session.sessionManager.getBranch(), [rpcProbe], 'disabled');
  assert.deepEqual(rpcResult.removedActive, [rpcProbe], 'the second extension reads the shared declaration reader');
  assert.deepEqual(rpcResult.pendingCompaction, []);
  assert.ok(!session.getActiveToolNames().includes(rpcProbe));
  assert.equal(createToolAdmission(rpcApi, session.sessionManager.getBranch()).admits(rpcProbe), false);

  await session.prompt('After disabling the lazy-hidden probes.');
  assert.deepEqual(declared.at(-1), ['codemode'], 'the next request still declares only Codemode');
  assert.ok(!session.getActiveToolNames().includes(probe));
  assert.ok(!session.getActiveToolNames().includes(rpcProbe));
});
