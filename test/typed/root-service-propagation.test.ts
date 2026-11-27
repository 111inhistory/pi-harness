/**
 * Real RootService permission propagation into a grandchild loadout.
 *
 * The root child is created through the production `subagent_create` tool, a
 * canonical root blacklist entry is appended while that child is live, and the child
 * then creates a Fresh grandchild through its own tool. Assertions read the
 * prompted SDK AgentSession loadouts, so no filtered-root or refresh
 * simulation stands in for the production ancestor chain.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stringify } from 'smol-toml';
import {
  AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import subagentExtension from '../../extensions/harness.ts';
import { addBaseTools, addBlacklistTargets } from '../../src/capability/tool-access.ts';
import { deferred } from '../../test-support/async.ts';
import { restorePresetSnapshot } from '../../src/preset/state.ts';
import { effectiveCodemodeMode } from '../../src/capability/codemode-mode.ts';

function usage(): Usage {
  return {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** The last user text in one request context, ignoring captured earlier turns. */
function lastUserText(messages: readonly { role: string; content: unknown }[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) return '';
    return message.content
      .filter((part): part is { text: string } => typeof part === 'object' && part !== null
        && typeof (part as { text?: unknown }).text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

test('a live root denial reaches a grandchild loadout created after it', { timeout: 20000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'root-propagation-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir, { recursive: true });
  const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const oldSocketDir = process.env['PI_SUBAGENT_SOCKET_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(cwd, 'uds');

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: 'propagation-fixture', reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.models[0];
  assert.ok(model);
  runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
  runtime.hasConfiguredAuth = () => true;
  await writeFile(path.join(agentDir, 'harness.json'), JSON.stringify({
    classifier: { models: [{ provider: 'openrouter', id: '~typesafe/jev-latest' }] },
  }));
  await writeFile(path.join(agentDir, 'subagent-routing.toml'), stringify({
    version: 4,
    instructions: { role: 'Select the executor role.', model: 'Select the only configured model.' },
    roles: [{
      id: 'executor',
      instructions: 'Complete the delegated assignment.',
      candidates: { fixture: 'nested-worker' },
    }],
  }));
  await writeFile(path.join(agentDir, 'presets.toml'), stringify({
    'nested-worker': {
      model: { provider: faux.provider.id, id: model.id }, thinkingLevel: 'low',
      tools: ['-bash', '+msg_write'], codemode: { mode: 'only' }, instructions: 'PRESET_NESTED_GUIDANCE',
    },
  }));
  runtime.classify = async (classifier, context) => {
    const key = Object.keys(context.questions)[0];
    assert.ok(key, 'routing must ask a question');
    const question = context.questions[key];
    assert.ok(question?.type === 'choice', 'fixture routing asks a choice question');
    const selected = Object.keys(question.criteria)[0];
    assert.ok(selected, 'the fixture role/model has one criterion');
    return {
      api: classifier.api, provider: classifier.provider, model: classifier.id,
      answers: { [key]: { type: 'choice' as const, choice: selected, probabilities: { [selected]: 1 }, confidence: 1 } },
      usage: usage(), stopReason: 'stop' as const, timestamp: Date.now(),
    };
  };

  const answer = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content, stopReason, timestamp: Date.now(), usage: usage(),
  });
  const childReady = deferred();
  const releaseChild = deferred();
  const grandchildReady = deferred();
  const grandchildRequests: { text: string; thinking: unknown }[] = [];
  const scriptErrors: string[] = [];
  const turns = new Map<string, number>();
  const childSessions = new Set<string>();
  runtime.streamSimple = (_requestModel, context, streamOptions) => {
    const stream = new AssistantMessageEventStream();
    const sessionId = streamOptions?.sessionId ?? '';
    const turn = (turns.get(sessionId) ?? 0) + 1;
    turns.set(sessionId, turn);
    const text = lastUserText(context.messages as unknown as { role: string; content: unknown }[]);
    void (async () => {
      let message: AssistantMessage;
      if (text.includes('CHILD_MARKER')) {
        childSessions.add(sessionId);
        if (turn === 1) {
          childReady.resolve();
          await releaseChild.promise;
          message = answer([{ type: 'toolCall', id: 'grandchild-call', name: 'subagent_create',
            arguments: { agents: [{ goal: 'NESTED_MARKER' }] } }], 'toolUse');
        } else {
          message = answer([{ type: 'text', text: 'child completed' }], 'stop');
        }
      } else if (text.includes('NESTED_MARKER')) {
        grandchildRequests.push({ text: JSON.stringify(context.messages), thinking: streamOptions?.reasoning });
        grandchildReady.resolve();
        message = answer([{ type: 'text', text: 'grandchild completed' }], 'stop');
      } else if (childSessions.has(sessionId)) {
        // The parent-hold continuation control prompt after its child settled.
        message = answer([{ type: 'text', text: 'child continued' }], 'stop');
      } else {
        scriptErrors.push(text);
        message = answer([{ type: 'text', text: 'unexpected session' }], 'stop');
      }
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
      stream.end();
    })();
    return stream;
  };

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
  });
  const extensionErrors: unknown[] = [];
  let rootApi: ExtensionAPI | undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{
      name: 'real-subagent-propagation',
      factory(api) { rootApi = api; subagentExtension(api); },
    }],
  });
  const prompted: { text: string; tools: string[]; preset: string | undefined; mode: unknown; thinking: string }[] = [];
  const originalPrompt = AgentSession.prototype.prompt;
  let session: AgentSession | undefined;
  try {
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model,
      sessionManager: SessionManager.create(cwd, path.join(cwd, 'sessions')), settingsManager, resourceLoader,
    }));
    await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
    AgentSession.prototype.prompt = async function (...args: Parameters<AgentSession['prompt']>) {
      const branch = this.sessionManager.getBranch();
      prompted.push({ text: String(args[0]), tools: this.getActiveToolNames(),
        preset: restorePresetSnapshot(branch)?.name, mode: effectiveCodemodeMode(branch, 'on'), thinking: this.thinkingLevel });
      return originalPrompt.apply(this, args);
    };

    const create = session.getToolDefinition('subagent_create');
    assert.ok(create);
    assert.ok(rootApi);
    const messageGrant = addBaseTools(rootApi, rootApi, session.sessionManager.getBranch(), ['msg_write']);
    assert.equal(messageGrant.recordError, null);
    assert.deepEqual(messageGrant.activated, ['msg_write'], 'the root base addition makes the reply tool available');
    const created = await create.execute('create-child', { agents: [{ goal: 'CHILD_MARKER', inheritContext: true }] },
      undefined, undefined, session.extensionRunner.createToolContext('create-child', undefined));
    assert.ok((created.details as { items: unknown[] }).items[0]);
    await childReady.promise;

    // The live child started before the rule existed and keeps its loadout.
    const childPrompt = prompted.find((entry) => entry.text.includes('CHILD_MARKER'));
    assert.ok(childPrompt, 'the root tool created the child session');
    assert.ok(childPrompt.tools.includes('write'), 'the live child keeps the loadout it started with');
    assert.ok(childPrompt.tools.includes('edit'));
    assert.ok(childPrompt.tools.includes('msg_write'),
      'the inherited child keeps the independent Harness grant despite the root base addition');

    const mutation = addBlacklistTargets(rootApi, rootApi, session.sessionManager.getBranch(), ['write']);
    assert.deepEqual(mutation.changed.map((change) => change.target), ['write']);
    assert.equal(mutation.recordError, null);

    releaseChild.resolve();
    await grandchildReady.promise;

    const grandchildPrompt = prompted.find((entry) => entry.text.includes('NESTED_MARKER'));
    assert.ok(grandchildPrompt, 'the child created a Fresh grandchild through its own tool');
    assert.equal(grandchildPrompt.tools.includes('write'), false,
      'a root blacklist applies to the loadout of a grandchild created after it');
    assert.ok(grandchildPrompt.tools.includes('edit'), 'an unmanaged sibling tool stays available');
    assert.equal(grandchildPrompt.tools.includes('bash'), false, 'the named Preset removes bash from the real child');
    assert.ok(grandchildPrompt.tools.includes('msg_write'),
      'the local Preset +msg_write survives the root base addition');
    assert.equal(grandchildPrompt.preset, 'nested-worker');
    assert.equal(grandchildPrompt.mode, 'only', 'the child uses the Codemode mode from its Preset snapshot');
    assert.equal(grandchildPrompt.thinking, 'low');
    assert.match(grandchildRequests[0]!.text, /PRESET_NESTED_GUIDANCE/,
      'Preset instructions reach the actual child model request');
    assert.match(grandchildRequests[0]!.text, /Complete the delegated assignment\./,
      'role instructions remain separate from Preset instructions');
    assert.deepEqual(extensionErrors, []);
    assert.deepEqual(scriptErrors, []);
  } finally {
    releaseChild.resolve();
    AgentSession.prototype.prompt = originalPrompt;
    try { await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); } catch { /* retirement is best effort */ }
    session?.dispose();
    if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
    if (oldSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
    else process.env['PI_SUBAGENT_SOCKET_DIR'] = oldSocketDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('child-only tools are usable when not denied, while root prefix/namespace/startup blacklists still block them', { timeout: 20000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'root-child-only-'));
  const agentDir = path.join(cwd, 'agent');
  const extDir = path.join(agentDir, 'extensions');
  await mkdir(extDir, { recursive: true });
  const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const oldSocketDir = process.env['PI_SUBAGENT_SOCKET_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(cwd, 'uds');

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: 'child-only-fixture', reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.models[0];
  assert.ok(model);
  runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
  runtime.hasConfiguredAuth = () => true;

  await writeFile(path.join(agentDir, 'harness.json'), JSON.stringify({
    classifier: { models: [{ provider: 'openrouter', id: '~typesafe/jev-latest' }] },
    capability: { blacklist: ['startup_blocked_*'] },
  }));
  await writeFile(path.join(agentDir, 'subagent-routing.toml'), stringify({
    version: 4,
    instructions: { role: 'Select the executor role.', model: 'Select the only configured model.' },
    roles: [{
      id: 'executor',
      instructions: 'Complete the delegated assignment.',
      candidates: { fixture: 'worker' },
    }],
  }));
  await writeFile(path.join(agentDir, 'presets.toml'), stringify({
    worker: {
      model: { provider: faux.provider.id, id: model.id }, thinkingLevel: 'low',
    },
  }));
  // Register child-only tools in an extension loaded by the Fresh child (not on Main's noExtensions: true loader).
  await writeFile(path.join(extDir, 'child-only.ts'), `
export default function (pi) {
  const noop = async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} });
  pi.registerTool({ name: 'child_extra', label: 'Child Extra', description: 'Child Extra', parameters: { type: 'object', properties: {} }, execute: noop });
  pi.registerTool({ name: 'child_blocked_tool', label: 'Child Blocked', description: 'Child Blocked', parameters: { type: 'object', properties: {} }, execute: noop });
  pi.registerTool({ name: 'child_ns_tool', label: 'Child NS', description: 'Child NS', namespace: { name: 'child_ns' }, parameters: { type: 'object', properties: {} }, execute: noop });
  pi.registerTool({ name: 'shared_rebound_ns', label: 'Shared Rebound NS', description: 'Shared Rebound NS', namespace: { name: 'child_other_ns' }, parameters: { type: 'object', properties: {} }, execute: noop });
  pi.registerTool({ name: 'startup_blocked_tool', label: 'Startup Blocked', description: 'Startup Blocked', parameters: { type: 'object', properties: {} }, execute: noop });
  pi.registerTool({ name: 'startup_blocked_main', label: 'Startup Blocked Main', description: 'Startup Blocked Main', parameters: { type: 'object', properties: {} }, execute: noop });
}
`);

  runtime.classify = async (classifier, context) => {
    const key = Object.keys(context.questions)[0];
    assert.ok(key);
    const question = context.questions[key];
    assert.ok(question?.type === 'choice');
    const selected = Object.keys(question.criteria)[0];
    assert.ok(selected);
    return {
      api: classifier.api, provider: classifier.provider, model: classifier.id,
      answers: { [key]: { type: 'choice' as const, choice: selected, probabilities: { [selected]: 1 }, confidence: 1 } },
      usage: usage(), stopReason: 'stop' as const, timestamp: Date.now(),
    };
  };

  const childDone = deferred();
  runtime.streamSimple = () => {
    const stream = new AssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'text', text: 'child done' }], stopReason: 'stop', timestamp: Date.now(), usage: usage(),
    };
    childDone.resolve();
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end();
    return stream;
  };

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
  });
  let rootApi: ExtensionAPI | undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{
      name: 'real-root-child-only',
      factory(api) {
        rootApi = api;
        const noop = async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} });
        api.registerTool({ name: 'child_blocked_main', label: 'M', description: 'M', parameters: { type: 'object', properties: {} }, execute: noop });
        api.registerTool({ name: 'child_ns_main', label: 'N', description: 'N', namespace: { name: 'child_ns' }, parameters: { type: 'object', properties: {} }, execute: noop });
        api.registerTool({ name: 'shared_rebound_ns', label: 'S', description: 'S', namespace: { name: 'main_blocked_ns' }, parameters: { type: 'object', properties: {} }, execute: noop });
        api.registerTool({ name: 'startup_blocked_main', label: 'SM', description: 'SM', parameters: { type: 'object', properties: {} }, execute: noop });
        subagentExtension(api);
      },
    }],
  });
  const promptedTools: string[][] = [];
  const originalPrompt = AgentSession.prototype.prompt;
  let session: AgentSession | undefined;
  try {
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model,
      sessionManager: SessionManager.create(cwd, path.join(cwd, 'sessions')), settingsManager, resourceLoader,
    }));
    await session.bindExtensions({ onError: (error) => { throw error; } });
    AgentSession.prototype.prompt = async function (...args: Parameters<AgentSession['prompt']>) {
      promptedTools.push(this.getActiveToolNames());
      return originalPrompt.apply(this, args);
    };

    assert.ok(rootApi);
    assert.equal(rootApi.getAllTools().some((tool) => tool.name === 'child_extra'), false,
      'child_extra is not registered on Main');
    const mutation = addBlacklistTargets(rootApi, rootApi, session.sessionManager.getBranch(),
      ['child_blocked_*', 'namespace://child_ns', 'namespace://main_blocked_ns']);
    assert.equal(mutation.recordError, null);
    assert.equal(mutation.changed.length, 3, 'prefix and namespace targets resolve on Main');
    // Main locally overrides startup_blocked_main via base add; the child still
    // treats capability.blacklist as an external fence.
    const mainOverride = addBaseTools(rootApi, rootApi, session.sessionManager.getBranch(), ['startup_blocked_main']);
    assert.equal(mainOverride.recordError, null);
    assert.ok(session.getActiveToolNames().includes('startup_blocked_main'));

    const create = session.getToolDefinition('subagent_create');
    assert.ok(create);
    await create.execute('create-child', { agents: [{ goal: 'CHILD_ONLY_CHECK' }] },
      undefined, undefined, session.extensionRunner.createToolContext('create-child', undefined));
    await childDone.promise;

    const childTools = promptedTools[0];
    assert.ok(childTools, 'child session was prompted');
    assert.ok(childTools.includes('child_extra'), 'child-only tool absent from Main is allowed');
    assert.equal(childTools.includes('child_blocked_tool'), false,
      'Main branch prefix blacklist blocks matching child-only tool');
    assert.equal(childTools.includes('child_ns_tool'), false,
      'Main branch namespace blacklist blocks matching child-only tool');
    assert.equal(childTools.includes('shared_rebound_ns'), false,
      'a tool blacklisted under Main namespace stays blocked even if the child registers it under a different namespace');
    assert.equal(childTools.includes('startup_blocked_tool'), false,
      'configured capability.blacklist blocks matching child-only tool');
    assert.equal(childTools.includes('startup_blocked_main'), false,
      'Main local base override of capability.blacklist does not grant inheritance to the child');
  } finally {
    AgentSession.prototype.prompt = originalPrompt;
    try { await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); } catch { /* best effort */ }
    session?.dispose();
    if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
    if (oldSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
    else process.env['PI_SUBAGENT_SOCKET_DIR'] = oldSocketDir;
    await rm(cwd, { recursive: true, force: true });
  }
});
