/**
 * Real-SDK smoke for the preset instruction channel.
 *
 * Boots a real `AgentSession` against an offline model and asserts that a
 * `preset-state` snapshot recorded on the branch projects its instruction text
 * into an actual outgoing request as a system section. This exercises the real
 * `context_with_system` → `prompt-section-journal` path, not just the pure
 * helper. No provider is contacted and no wire format is reimplemented.
 *
 * The `--preset`/`/preset` command path itself is covered deterministically by
 * `preset-extension.test.ts`, because the public `createAgentSession` options do
 * not expose extension flag injection.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';

import { appendDiscoveryRecord, latestPruneRecord } from '../../src/capability/discovery-record.ts';
import { enableCapabilityTargets } from '../../src/capability/enable.ts';
import { restorePresetSnapshot } from '../../src/preset/state.ts';

import presetExtension from '../../extensions/preset.ts';
import capabilityExtension from '../../src/capability/extension.ts';

test('a preset-state instruction reaches a real offline request as a system section', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'preset-sdk-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = path.join(cwd, 'agent');
  let session: AgentSession | undefined;
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
    assert.ok(model);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-only' }, env: {} });
    runtime.hasConfiguredAuth = () => true;

    const requests: unknown[] = [];
    runtime.streamSimple = (_model, context) => {
      requests.push(structuredClone(context.messages));
      const stream = new AssistantMessageEventStream();
      const message = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
      } as AssistantMessage;
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
      return stream;
    };

    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: process.env['PI_CODING_AGENT_DIR']!, settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [{ name: 'preset', factory: presetExtension }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendCustomEntry('preset-state', { version: 1, snapshot: { name: 'fast', instructions: 'PRESET_INSTRUCTION_MARKER' } });

    const created = await createAgentSession({
      cwd, agentDir: process.env['PI_CODING_AGENT_DIR']!, modelRuntime: runtime, model,
      settingsManager, resourceLoader, sessionManager,
    });
    session = created.session;
    await session.bindExtensions({ onError: (error) => { throw error; } });

    await session.prompt('hello');
    assert.ok(requests.length >= 1, 'the model was called at least once');
    assert.match(JSON.stringify(requests), /PRESET_INSTRUCTION_MARKER/, 'instruction text was projected into the request');
  } finally {
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('preset switching retains Capability tools and compaction protects the preset baseline (real session)', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'preset-base-sdk-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const agentDir = path.join(cwd, 'agent');
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  await mkdir(agentDir, { recursive: true });
  const pinned = 'fixture_preset_pinned';
  const dynamic = 'fixture_discovered';
  const manual = 'fixture_user_enabled';
  const oldDefault = 'fixture_old_default';
  const presetTools = ['+codemode', '+grep', `+${pinned}`, `-${oldDefault}`];
  await writeFile(path.join(agentDir, 'presets.json'), JSON.stringify({
    only: { tools: presetTools, codemode: { mode: 'only' } },
    next: { tools: ['+codemode', '+find', `+${pinned}`, `-${oldDefault}`] },
    exclude: { tools: ['+codemode', `-${dynamic}`, `-${manual}`] },
    exact: { tools: ['read', 'capability', 'codemode'] },
  }));
  let session: AgentSession | undefined;
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
    assert.ok(model);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-only' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    runtime.streamSimple = () => {
      const stream = new AssistantMessageEventStream();
      const message = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
      } as AssistantMessage;
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
      return stream;
    };
    const settingsManager = SettingsManager.inMemory({
      defaultTools: ['read', 'bash', 'edit', 'write', 'capability', oldDefault],
      retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0 }, cacheWarming: 'off',
    });
    let api: import('@earendil-works/pi-coding-agent').ExtensionAPI | undefined;
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [
        { name: 'capability', factory: capabilityExtension },
        { name: 'preset', factory: presetExtension },
        { name: 'preset-tools-fixture', factory(pi) {
          api = pi;
          for (const name of [pinned, dynamic, manual, oldDefault]) pi.registerTool({
            name, label: name, description: name, defaultActive: name === oldDefault,
            ...(name === manual ? { exposure: 'deferred' as const } : {}),
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
          });
          pi.on('session_before_compact', event => ({ compaction: {
            summary: 'Offline fixture summary', firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          } }));
        } },
      ],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const created = await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    session = created.session;
    await session.bindExtensions({ onError: (error) => { throw error; } });

    const before = session.getActiveToolNames();
    assert.ok(before.includes('capability'), 'Capability is default-active before applying a preset');

    const extensions = resourceLoader.getExtensions().extensions;
    const presetExt = extensions.find((extension) => [...extension.commands.keys()].includes('preset'));
    const command = presetExt?.commands.get('preset');
    assert.ok(command !== undefined, 'the preset command is registered');
    const ctx = {
      cwd,
      ui: { notify: () => {}, setStatus: () => {}, select: async () => undefined },
      modelRegistry: { find: () => undefined },
      sessionManager: session.sessionManager,
      isProjectTrusted: () => true,
      getSystemPrompt: () => session!.systemPrompt,
    };
    await command.handler('only', ctx as never);

    const after = session.getActiveToolNames();
    assert.ok(after.includes('capability'), 'a +codemode preset must not drop the default-active Capability tool');
    assert.ok(after.includes('codemode'), 'the codemode tool is added by the preset');
    assert.ok(api);
    appendDiscoveryRecord(api, undefined, {
      status: 'ok', tools: [pinned, dynamic, oldDefault].map(name => ({ ref: `tool://${name}`, name })),
      mcp: [], skills: [],
    }, { local: 'searched', remote: 'not_searched' });
    api.setActiveTools([...after, dynamic, oldDefault]);
    const enabled = enableCapabilityTargets(api, [manual], { branch: session.sessionManager.getBranch() });
    assert.deepEqual(enabled.enabled, [manual]);
    await command.handler('only', ctx as never);
    assert.ok(session.getActiveToolNames().includes(manual),
      'reapplying the same preset retains a dynamically enabled deferred tool');

    await command.handler('next', ctx as never);
    let active = session.getActiveToolNames();
    assert.ok(active.includes(dynamic), 'switching retains a currently discovered tool');
    assert.ok(active.includes(manual), 'switching retains a user-enabled tool');
    assert.ok(!active.includes('grep'), 'the previous preset does not contaminate the next baseline');
    assert.ok(active.includes('find'));
    assert.ok(!active.includes(oldDefault), 'an explicit minus excludes a discovered default tool');
    assert.deepEqual([...restorePresetSnapshot(session.sessionManager.getBranch())!.tools!].sort(),
      ['read', 'bash', 'edit', 'write', 'capability', 'codemode', 'find', pinned].sort(),
      'the snapshot contains the stable preset baseline, excluding retained dynamic tools');

    // Rediscover a tool excluded from the preset: its old Settings default must
    // no longer protect it from compaction. None of these fixture tools execute.
    api.setActiveTools([...active, oldDefault]);
    await session.prompt('Record the current tool loadout before compaction.');
    await session.compact();
    active = session.getActiveToolNames();
    assert.ok(active.includes(pinned), 'an unused preset baseline tool survives compaction');
    assert.ok(active.includes(manual), 'manual authorization still protects an unused tool');
    assert.ok(!active.includes(dynamic), 'an unused dynamic tool is pruned');
    assert.ok(!active.includes(oldDefault), 'the preset baseline replaces Settings protection');
    assert.deepEqual([...latestPruneRecord(session.sessionManager.getBranch())!.removedTools].sort(),
      [dynamic, oldDefault].sort());

    // Clearing returns pruning to Settings, without replaying the old loadout.
    await command.handler('clear', ctx as never);
    appendDiscoveryRecord(api, undefined, {
      status: 'ok', tools: [pinned, dynamic, oldDefault].map(name => ({ ref: `tool://${name}`, name })),
      mcp: [], skills: [],
    }, { local: 'searched', remote: 'not_searched' });
    api.setActiveTools([...active, dynamic, oldDefault]);
    await session.prompt('Record rediscovered tools after clearing the preset.');
    await session.compact();
    active = session.getActiveToolNames();
    assert.ok(active.includes(oldDefault), 'clear restores Settings baseline protection');
    assert.ok(!active.includes(pinned), 'the cleared preset no longer protects its old tool');
    assert.ok(active.includes(manual));

    appendDiscoveryRecord(api, undefined, {
      status: 'ok', tools: [{ ref: `tool://${dynamic}`, name: dynamic }], mcp: [], skills: [],
    }, { local: 'searched', remote: 'not_searched' });
    api.setActiveTools([...active, dynamic]);
    await command.handler('exclude', ctx as never);
    assert.ok(!session.getActiveToolNames().includes(dynamic), 'explicit minus removes a discovered tool');
    assert.ok(!session.getActiveToolNames().includes(manual), 'explicit minus removes a user-enabled tool');
    api.setActiveTools([...session.getActiveToolNames(), dynamic, manual]);
    await command.handler('exact', ctx as never);
    assert.deepEqual(session.getActiveToolNames(), ['read', 'capability', 'codemode'],
      'bare names replace the full selection');
  } finally {
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});
