/**
 * Real RootService permission propagation into a grandchild loadout.
 *
 * The root child is created through the production `subagent_create` tool, a
 * canonical root disable is appended while that child is live, and the child
 * then creates a Fresh grandchild through its own tool. Assertions read the
 * prompted SDK AgentSession loadouts, so no filtered-root or refresh
 * simulation stands in for the production ancestor chain.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import subagentExtension from '../../src/subagent/extension.ts';
import { setToolPermission } from '../../src/capability/tool-permission.ts';
import { deferred } from '../../test-support/async.ts';
import { restorePresetSnapshot } from '../../src/preset/state.ts';
import { readCodemodeModeOverride } from '../../src/capability/codemode-mode.ts';

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
  await writeFile(path.join(agentDir, 'subagent-routing.json'), JSON.stringify({
    version: 3,
    classifier: { provider: 'openrouter', id: '~typesafe/jev-latest' },
    instructions: { role: 'Select the executor role.', model: 'Select the only configured model.' },
    roles: [{
      id: 'executor',
      instructions: 'Complete the delegated assignment.',
      candidates: { fixture: 'nested-worker' },
    }],
  }));
  await writeFile(path.join(agentDir, 'presets.json'), JSON.stringify({
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
            arguments: { tasks: [{ task: 'NESTED_MARKER' }] } }], 'toolUse');
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
        preset: restorePresetSnapshot(branch)?.name, mode: readCodemodeModeOverride(branch), thinking: this.thinkingLevel });
      return originalPrompt.apply(this, args);
    };

    const create = session.getToolDefinition('subagent_create');
    assert.ok(create);
    assert.ok(rootApi);
    const messageGrant = setToolPermission(rootApi, rootApi, session.sessionManager.getBranch(), ['msg_write'], 'enabled');
    assert.equal(messageGrant.recordError, null);
    const created = await create.execute('create-child', { tasks: [{ task: 'CHILD_MARKER', inheritContext: true }] },
      undefined, undefined, session.extensionRunner.createToolContext('create-child', undefined));
    assert.ok((created.details as { items: unknown[] }).items[0]);
    await childReady.promise;

    // The live child started before the rule existed and keeps its loadout.
    const childPrompt = prompted.find((entry) => entry.text.includes('CHILD_MARKER'));
    assert.ok(childPrompt, 'the root tool created the child session');
    assert.ok(childPrompt.tools.includes('write'), 'the live child keeps the loadout it started with');
    assert.ok(childPrompt.tools.includes('edit'));
    assert.ok(childPrompt.tools.includes('msg_write'),
      'the inherited child keeps the independent Harness grant despite the root enable');

    const mutation = setToolPermission(rootApi, rootApi, session.sessionManager.getBranch(), ['write'], 'disabled');
    assert.deepEqual(mutation.changed.map((change) => change.target), ['write']);
    assert.equal(mutation.recordError, null);

    releaseChild.resolve();
    await grandchildReady.promise;

    const grandchildPrompt = prompted.find((entry) => entry.text.includes('NESTED_MARKER'));
    assert.ok(grandchildPrompt, 'the child created a Fresh grandchild through its own tool');
    assert.equal(grandchildPrompt.tools.includes('write'), false,
      'a root denial applies to the loadout of a grandchild created after it');
    assert.ok(grandchildPrompt.tools.includes('edit'), 'an unmanaged sibling tool stays available');
    assert.equal(grandchildPrompt.tools.includes('bash'), false, 'the named Preset removes bash from the real child');
    assert.ok(grandchildPrompt.tools.includes('msg_write'),
      'the local Preset +msg_write survives the root explicit enable');
    assert.equal(grandchildPrompt.preset, 'nested-worker');
    assert.equal(grandchildPrompt.mode, 'only', 'the shared Preset application writes the child Codemode override');
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
