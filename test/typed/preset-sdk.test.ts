/**
 * Real-SDK smoke for the preset tool-facing behavior.
 *
 * The first case boots a real `AgentSession` against an offline model and
 * asserts that a `preset-state` snapshot projects its instruction text into an
 * actual outgoing request as a system section. This exercises the real
 * `context_with_system` → current request-snapshot path, not just the pure
 * helper. No provider is contacted and no wire format is reimplemented.
 *
 * The remaining cases exercise the agreed BASE / DYNAMIC / BLACKLIST contract
 * through the real `/preset` command, real branch records and the real
 * tool-access recompute: a preset contributes a base selection plus a
 * current-preset blacklist, discovery activates dynamic members without
 * granting anything, and a base member overrides local bans while ancestor
 * fences still win. Removing the base membership reveals a retained ban.
 *
 * The `--preset` startup flag itself is covered deterministically by
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
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

import { appendDiscoveryRecord } from '../../src/capability/discovery-record.ts';
import { setCapabilityStartupBlacklist } from '../../src/capability/scope.ts';
import {
  addBaseTools,
  addBlacklistTargets,
  removeBaseTools,
  removeBlacklistTargets,
} from '../../src/capability/tool-access.ts';
import { createToolAccessView } from '../../src/capability/tool-access-view.ts';
import { createToolAdmission } from '../../src/capability/admission.ts';
import { restorePresetSnapshot } from '../../src/preset/state.ts';

import presetExtension from '../../extensions/preset.ts';
import capabilityExtension from '../../src/capability/extension.ts';

/** Offline model runtime shared by the real-session scenarios. */
async function offlineRuntime(cwd: string, requests?: unknown[]) {
  const runtime = await ModelRuntime.create({ authPath: path.join(cwd, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
  assert.ok(model);
  runtime.getAuth = async () => ({ auth: { apiKey: 'offline-only' }, env: {} });
  runtime.hasConfiguredAuth = () => true;
  runtime.streamSimple = (_model, context) => {
    requests?.push(structuredClone(context.messages));
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
  return { runtime, model };
}

test('a preset-state instruction reaches a real offline request as a system section', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'preset-sdk-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = path.join(cwd, 'agent');
  let session: AgentSession | undefined;
  try {
    const requests: unknown[] = [];
    const { runtime, model } = await offlineRuntime(cwd, requests);

    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: process.env['PI_CODING_AGENT_DIR']!, settingsManager,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [
        { name: 'preset', factory: presetExtension },
        { name: 'other-plugin', factory(api) {
          api.on('before_agent_start', (event) => {
            event.systemPromptOptions.sections['other-plugin'] = 'OTHER_PLUGIN_SECTION';
          });
        } },
      ],
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
    assert.match(JSON.stringify(requests), /OTHER_PLUGIN_SECTION/, 'an unrelated named section survives the preset projection');
  } finally {
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---- preset tool contributions through the real session ----

const pinned = 'fixture_preset_pinned';
const dynamicTool = 'fixture_discovered';
const manualTool = 'fixture_user_enabled';
const oldDefault = 'fixture_old_default';
const patch = 'fixture_apply_patch';
const fixtureTools = [pinned, dynamicTool, manualTool, oldDefault, patch];
const lateTool = 'fixture_late_registered';

interface PresetSession {
  readonly session: AgentSession;
  readonly api: ExtensionAPI;
  readonly apply: (name: string) => Promise<void>;
  readonly branch: () => readonly unknown[];
}

/**
 * Boot one real session with the capability and preset extensions, a fixture
 * tool registry and a private presets.json. Every tool is a local fixture; none
 * of them executes.
 */
async function bootPresetSession(
  cwd: string,
  agentDir: string,
  presets: Record<string, unknown>,
  options: { defaultTools?: string[]; withCapability?: boolean } = {},
): Promise<PresetSession> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, 'presets.json'), JSON.stringify(presets));
  const { runtime, model } = await offlineRuntime(cwd);
  const settingsManager = SettingsManager.inMemory({
    defaultTools: options.defaultTools ?? ['read', 'bash', 'edit', 'write', 'capability', oldDefault],
    retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0 }, cacheWarming: 'off',
  });
  let api: ExtensionAPI | undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [
      ...(options.withCapability === false ? [] : [{ name: 'capability', factory: capabilityExtension }]),
      { name: 'preset', factory: presetExtension },
      { name: 'preset-tools-fixture', factory(pi) {
        api = pi;
        for (const name of fixtureTools) pi.registerTool({
          name, label: name, description: name, defaultActive: name === oldDefault,
          ...([manualTool, patch].includes(name) ? { exposure: 'deferred' as const } : {}),
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
  await created.session.bindExtensions({ onError: (error) => { throw error; } });
  assert.ok(api);
  const presetExt = resourceLoader.getExtensions().extensions.find((extension) => [...extension.commands.keys()].includes('preset'));
  const command = presetExt?.commands.get('preset');
  assert.ok(command !== undefined, 'the preset command is registered');
  const ctx = {
    cwd,
    ui: { notify: () => {}, setStatus: () => {}, select: async () => undefined },
    modelRegistry: { find: () => undefined },
    sessionManager: created.session.sessionManager,
    isProjectTrusted: () => true,
    getSystemPrompt: () => created.session.systemPrompt,
  };
  const bound = api;
  return {
    session: created.session,
    api: bound,
    apply: async (name) => { await command.handler(name, ctx as never); },
    branch: () => created.session.sessionManager.getBranch(),
  };
}

function activeOf(session: AgentSession): string[] {
  return [...session.getActiveToolNames()];
}

test('preset base selection replaces on switch while dynamic activation survives', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'preset-base-sdk-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const agentDir = path.join(cwd, 'agent');
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  let booted: PresetSession | undefined;
  try {
    booted = await bootPresetSession(cwd, agentDir, {
      strong: { tools: [`+${patch}`] },
      weak: { tools: ['+edit'] },
    });
    const { session, api, apply, branch } = booted;
    assert.ok(activeOf(session).includes('capability'), 'Capability is default-active before applying a preset');

    await apply('strong');
    assert.ok(activeOf(session).includes(patch), 'the preset base selection adds the tool');
    assert.deepEqual([...restorePresetSnapshot(branch())!.tools!].sort(),
      ['read', 'bash', 'edit', 'write', 'capability', oldDefault, patch].sort(),
      'the snapshot holds the base selection computed from the session baseline');

    // Discovery activates a dynamic member. Late activation is enough: replay
    // treats a discovery selection as dynamic membership without a grant.
    appendDiscoveryRecord(api, undefined, {
      status: 'ok', tools: [{ ref: `tool://${dynamicTool}`, name: dynamicTool }],
      mcp: [], skills: [],
    }, { local: 'searched', remote: 'not_searched' });
    api.setActiveTools([...activeOf(session), dynamicTool]);

    await apply('weak');
    let active = activeOf(session);
    assert.ok(!active.includes(patch), 'switching replaces the previous preset base selection');
    assert.ok(active.includes(dynamicTool), 'a dynamically discovered tool survives the switch');
    assert.ok(active.includes(oldDefault), 'the stable session baseline is restored by the new selection');

    await apply('strong');
    active = activeOf(session);
    assert.ok(active.includes(patch), 'reapplying restores the preset base selection');
    assert.ok(active.includes(dynamicTool), 'dynamic membership is not overwritten by the preset base');

    // The base selection remains the compaction protection baseline.
    await session.prompt('Record the current loadout.');
    await session.compact();
    active = activeOf(session);
    assert.ok(!active.includes(pinned), 'pinned was never part of this preset selection');
    assert.ok(active.includes(patch), 'an unused preset base tool survives compaction');
  } finally {
    booted?.session.dispose();
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('preset blacklist blocks additions and its lifetime ends on switch or clear', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'preset-blacklist-sdk-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const agentDir = path.join(cwd, 'agent');
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  let booted: PresetSession | undefined;
  try {
    booted = await bootPresetSession(cwd, agentDir, {
      exclude: { tools: [`+${patch}`, `-${dynamicTool}`, `-${manualTool}`] },
      weak: { tools: ['+edit'] },
    });
    const { session, api, apply, branch } = booted;

    // A pre-existing base membership is removed by the preset minus, and a
    // branch ban on the plus target is overridden by the preset base.
    addBaseTools(api, api, branch(), [manualTool]);
    addBlacklistTargets(api, api, branch(), [patch]);
    await apply('exclude');
    const afterMinus = createToolAccessView(api, branch());
    assert.equal(afterMinus.base(manualTool), false, 'a preset minus removes prior base membership');
    assert.equal(afterMinus.blacklisted(patch), true, 'the branch ban is retained as a raw fact');
    assert.equal(afterMinus.banOverridden(patch), true, 'the preset plus contributes overriding base membership');
    let active = activeOf(session);
    assert.ok(active.includes(patch), 'the positive token contributes base membership');
    assert.ok(!active.includes(dynamicTool), 'the final minus cannot be active');
    assert.deepEqual([...restorePresetSnapshot(branch())!.disabledTools!].sort(), [dynamicTool, manualTool].sort(),
      'the snapshot holds the current-preset blacklist');

    // Discovery selects a blacklisted member: it becomes dynamic membership but
    // still cannot be requested or activated.
    appendDiscoveryRecord(api, undefined, {
      status: 'ok', tools: [dynamicTool, manualTool].map(name => ({ ref: `tool://${name}`, name })),
      mcp: [], skills: [],
    }, { local: 'searched', remote: 'not_searched' });
    api.setActiveTools([...activeOf(session), dynamicTool, manualTool]);
    await apply('exclude');
    active = activeOf(session);
    assert.ok(!active.includes(dynamicTool), 'a preset blacklist blocks discovery activation immediately');
    assert.ok(!active.includes(manualTool), 'a preset blacklist blocks even an explicitly activated member');

    // A branch blacklist removal keeps the current preset contribution.
    const removal = removeBlacklistTargets(api, api, branch(), [dynamicTool]);
    assert.deepEqual(removal.stillBlacklisted, [dynamicTool],
      'the current preset keeps its own lifetime against a branch removal');
    assert.ok(removal.remainingSources.includes('preset'));
    const view = createToolAccessView(api, branch());
    assert.equal(view.blacklisted(dynamicTool), true);
    assert.equal(view.dynamic(dynamicTool), true, 'the discovery membership is preserved while blocked');

    // Switching to a preset without a minus ends the previous blacklist; the
    // preserved dynamic membership makes the tool available again.
    await apply('weak');
    active = activeOf(session);
    assert.ok(active.includes(dynamicTool), 'a switch withdraws the previous preset blacklist, not the membership');
    assert.ok(active.includes(manualTool), 'the preserved dynamic membership restores both members');
    assert.ok(!active.includes(patch), 'the previous base selection is replaced by the new preset');

    // Clear ends the blacklist lifetime too and keeps the base membership.
    await apply('exclude');
    assert.ok(!activeOf(session).includes(dynamicTool));
    await apply('clear');
    active = activeOf(session);
    assert.ok(active.includes(dynamicTool), 'a cleared preset withdraws its blacklist, so the member returns');
    assert.equal(restorePresetSnapshot(branch()), null, 'clear records a null snapshot');
    assert.ok(active.includes(patch), 'the base selection established by the preset stays after clear');
  } finally {
    booted?.session.dispose();
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a root startup blacklist is local and a preset base member overrides it without erasing the source', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'preset-precedence-sdk-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const agentDir = path.join(cwd, 'agent');
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  let booted: PresetSession | undefined;
  try {
    booted = await bootPresetSession(cwd, agentDir, { strong: { tools: [`+${patch}`] } });
    const { session, api, apply, branch } = booted;

    // At a chain root the configured startup blacklist is local policy, so the
    // preset base member overrides it; the stored source is not deleted.
    setCapabilityStartupBlacklist(api, [patch]);
    await apply('strong');
    let view = createToolAccessView(api, branch());
    assert.ok(activeOf(session).includes(patch), 'preset base overrides the local startup ban');
    assert.equal(view.blacklisted(patch), true, 'the startup source stays stored');
    assert.equal(view.banOverridden(patch), true);
    assert.equal(view.blocked(patch), false);
    const added = addBaseTools(api, api, branch(), [patch]);
    assert.deepEqual(added.banOverridden, [patch], 'a later base add keeps the raw ban overridden');
    assert.ok(added.remainingSources.includes('startup'));

    // Removing the base membership reveals the retained ban immediately.
    removeBaseTools(api, api, branch(), [patch]);
    view = createToolAccessView(api, branch());
    assert.equal(view.base(patch), false);
    assert.equal(view.blocked(patch), true, 'removing base reasserts the stored startup ban');
    assert.equal(createToolAdmission(api, branch()).admits(patch), false, 'usage stops as soon as the base override ends');
  } finally {
    booted?.session.dispose();
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a late default-active registration is not silently adopted into the preset base', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'preset-late-sdk-'));
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const agentDir = path.join(cwd, 'agent');
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  let booted: PresetSession | undefined;
  try {
    booted = await bootPresetSession(cwd, agentDir, {
      add: { tools: ['+edit'] },
      adopt: { tools: [`+${lateTool}`] },
    });
    const { session, api, apply } = booted;

    // Registered after session_start, like a late MCP server or a deferred
    // extension load. The SDK activates it, but the tool baseline is frozen.
    api.registerTool({
      name: lateTool, label: lateTool, description: lateTool, defaultActive: true,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
    });
    assert.ok(activeOf(session).includes(lateTool), 'the SDK activates a late default-active registration');

    await apply('add');
    assert.ok(!activeOf(session).includes(lateTool),
      'a preset apply recomputes from the frozen startup baseline, so an unnamed late registration leaves the loadout');
    assert.ok(activeOf(session).includes('edit'), 'the preset selection itself still applies');

    // Naming it in the preset selection makes it base membership explicitly.
    await apply('adopt');
    assert.ok(activeOf(session).includes(lateTool), 'an explicit preset selection of the late tool keeps it available');
  } finally {
    booted?.session.dispose();
    if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});
