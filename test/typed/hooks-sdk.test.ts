import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fauxProvider, getCurrentSystemMessage, InMemoryCredentialStore, type AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import harnessExtension from '../../extensions/harness.ts';
import shellPreflightExtension from '../../src/shell-approval/extension.ts';
import capabilityExtension from '../../src/capability/extension.ts';
import { installHookSurface } from '../../src/hooks/extension.ts';
import { normalizeHookRules } from '../../src/hooks/config.ts';
import { restoreHookOverrides } from '../../src/hooks/override.ts';
import { HOOK_HINT_MESSAGE, HOOK_REPEAT_RECORD } from '../../src/hooks/repeat.ts';
import { appendPresetState, buildPresetSnapshot, PRESET_STATE_VERSION } from '../../src/preset/state.ts';

const START = 'HOOK_START_SAFE';
const NESTED = 'HOOK_NESTED_SAFE';
const PRESET = 'HOOK_PRESET_SECTION';
const PRESET_SECTION = `<hook-section>\n${PRESET}\n</hook-section>`;
const PEER_WAKE = 'Peer wake';

const globalHooks = `
version = 1

[hooks.start]
on = 'before_agent_start'
actions = [{ type = 'injectHint', text = '${START}' }]
[hooks.start.repeat]
maxTriggers = 1

[hooks.override]
on = 'before_agent_start'
actions = [{ type = 'injectHint', text = 'GLOBAL_SHOULD_NOT_APPEAR' }]

[hooks.nested-result]
on = 'tool_result'
when = '''tool == 'command_probe' && nested && contains(input.command, 'read fixture') && turn.modelCalls >= 1'''
actions = [{ type = 'injectHint', text = '${NESTED}' }]
[hooks.nested-result.repeat]
maxTriggers = 1

[hooks.nested-duplicate]
on = 'tool_result'
when = '''tool == 'command_probe' && nested'''
actions = [{ type = 'injectHint', text = '${NESTED}', display = true }]
[hooks.nested-duplicate.repeat]
maxTriggers = 1
`;

test('Main Hook delivers coalesced nested hints in the next native request and restores branch-local repeat', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-hook-sdk-'));
  const agentDir = path.join(cwd, 'agent');
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousSocketDir = process.env['PI_SUBAGENT_SOCKET_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(cwd, 'uds');
  let session: AgentSession | undefined;
  try {
    await mkdir(agentDir);
    await mkdir(path.join(cwd, '.pi'));
    const hookFile = path.join(agentDir, 'hooks.toml');
    await writeFile(hookFile, 'version = 1\n');
    await writeFile(path.join(agentDir, 'harness.json'), JSON.stringify({ version: 1,
      shell: { approval: { enabled: false, ruleFiles: ['missing.rules'] } },
    }));
    await writeFile(path.join(cwd, '.pi', 'hooks.toml'), 'version = 1\n[hooks.override]\nenabled = false\n');
    const provider = fauxProvider({ models: [{ id: 'hook-fixture' }] });
    const model = provider.models[0]!;
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(provider.provider);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    // Request system messages carry section *diffs*, so the prompt a wake actually sees is
    // the SDK replay; capture that projection per request instead of the raw patches.
    const requests: { text: string; peerWake: boolean; sections: Readonly<Record<string, string | null>> }[] = [];
    runtime.streamSimple = (_model, context) => {
      requests.push({
        text: JSON.stringify(context),
        peerWake: context.messages.some(message => message.role === 'user'
          && JSON.stringify(message.content).includes(PEER_WAKE)),
        sections: getCurrentSystemMessage(context.messages)?.sections ?? {},
      });
      const first = requests.length % 2 === 1;
      const reply: AssistantMessage = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: first ? [{ type: 'toolCall', id: `wrapper-${requests.length}`, name: 'wrapper', arguments: {} }]
          : [{ type: 'text', text: 'Done' }],
        stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message: reply });
      stream.end();
      return stream;
    };
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } }, { projectTrusted: true });
    let probes = 0;
    let beforeOuterResult: (() => Promise<void>) | undefined;
    let cancelNavigation = false;
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{ name: 'shell-fixture', factory: shellPreflightExtension }, { name: 'hooks-fixture', factory(pi) {
        installHookSurface(pi, capabilityExtension(pi));
        pi.registerTool({ name: 'command_probe', label: 'Probe', description: 'Record a mock command', defaultActive: true,
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } as never,
          async execute() { probes += 1; return { content: [{ type: 'text', text: 'recorded' }], details: {} }; },
        });
        pi.registerTool({ name: 'wrapper', label: 'Wrapper', description: 'Run nested commands', defaultActive: true,
          parameters: { type: 'object', properties: {} } as never,
          async execute(_id, _params, _signal, _update, ctx) {
            for (let i = 0; i < 2; i++) await ctx.executeTool('command_probe', { command: 'read fixture' });
            await beforeOuterResult?.();
            return { content: [{ type: 'text', text: 'wrapped' }], details: {} };
          },
        });
      } }, { name: 'harness-fixture', factory: harnessExtension }, { name: 'navigation-fixture', factory(pi) {
        pi.on('session_before_tree', () => cancelNavigation ? { cancel: true } : undefined);
      } }],
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(cwd);
    appendPresetState({ appendEntry: (kind, data) => sessionManager.appendCustomEntry(kind, data) }, {
      version: PRESET_STATE_VERSION,
      snapshot: buildPresetSnapshot({ name: 'hooked', instructions: null, hooks: normalizeHookRules({
        section: { on: 'before_agent_start', actions: [{ type: 'injectSection', text: PRESET }] },
        override: { on: 'before_agent_start', actions: [{ type: 'injectHint', text: 'PRESET_SHOULD_NOT_APPEAR' }] },
      }) }),
    });
    session = (await createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, settingsManager, resourceLoader, sessionManager })).session;
    const errors: unknown[] = [];
    const notices: string[] = [];
    await session.bindExtensions({
      onError: error => errors.push(error),
      uiContext: { ...session.extensionRunner.createContext().ui, notify: message => notices.push(message) },
    });
    const before = session.sessionManager.getLeafId();
    await writeFile(hookFile, globalHooks);
    await session.prompt('/config reload');
    assert.ok(notices.includes('hooks.toml: updated.'));
    assert.ok(notices.includes('shell approval rules: skipped.'));
    assert.equal(session.sessionManager.getLeafId(), before);
    assert.equal(requests.length, 0);
    await writeFile(hookFile, 'version = 1\n[bad');
    await session.prompt('/config reload');
    assert.ok(notices.some(message => message.startsWith('hooks.toml: failed (previous snapshot retained).')));
    session.setActiveToolsByName(['wrapper', 'command_probe']);
    await session.prompt('Turn one');
    assert.equal(requests.length, 2);
    assert.match(requests[0]!.text, new RegExp(START));
    assert.match(requests[0]!.text, new RegExp(PRESET));
    assert.doesNotMatch(requests[0]!.text, /SHOULD_NOT_APPEAR/);
    assert.doesNotMatch(requests[0]!.text, new RegExp(NESTED));
    assert.match(requests[1]!.text, new RegExp(NESTED));
    const branch = session.sessionManager.getBranch();
    const firstUser = branch.find(e => e.type === 'message' && e.message.role === 'user');
    assert.ok(firstUser);
    const hints = branch.filter(e => e.type === 'custom_message' && e.customType === HOOK_HINT_MESSAGE);
    assert.equal(hints.length, 2, 'two nested results share one outer hint');
    const nestedHint = hints.at(-1);
    assert.equal(nestedHint?.type, 'custom_message');
    assert.equal(nestedHint.content, NESTED);
    assert.equal(nestedHint.display, true);
    const details = nestedHint.details as { repeat: { key: string }[] };
    assert.deepEqual(details.repeat.map(receipt => receipt.key.split(':')[0]), ['nested-duplicate', 'nested-result']);
    assert.equal(branch.filter(e => e.type === 'custom' && e.customType === HOOK_REPEAT_RECORD).length, 0, 'hint receipts live on the native messages');
    await session.prompt('Turn two');
    assert.equal(session.sessionManager.getBranch().filter(e => e.type === 'custom_message' && e.customType === HOOK_HINT_MESSAGE).length, 2);
    await session.sendCustomMessage({ customType: 'agent-delivery', content: PEER_WAKE, display: false }, { triggerTurn: true });
    const wakeRequests = requests.filter(request => request.peerWake);
    assert.ok(wakeRequests.length > 0, 'the peer wake reaches the provider as its own request');
    for (const wake of wakeRequests) {
      assert.equal(wake.sections['hook-section'], PRESET_SECTION,
        'a peer wake request replays the unchanged static section instead of re-sending it');
    }
    assert.equal(session.sessionManager.getBranch().filter(e => e.type === 'custom_message' && e.customType === HOOK_HINT_MESSAGE).length, 2);
    await session.navigateTree(firstUser.id);
    await session.prompt('Turn on an earlier branch');
    assert.equal(session.sessionManager.getBranch().filter(e => e.type === 'custom_message' && e.customType === HOOK_HINT_MESSAGE).length, 2);
    assert.equal(probes, 8);
    await session.navigateTree(firstUser.id);
    beforeOuterResult = async () => {
      await writeFile(hookFile, `${globalHooks.split('[hooks.nested-result]')[0]}[hooks.nested-result]\nenabled = false\n`
        + globalHooks.slice(globalHooks.indexOf('[hooks.nested-duplicate]')));
      await session!.prompt('/config reload');
      await writeFile(hookFile, globalHooks);
      await session!.prompt('/config reload');
    };
    const initialNotices = notices.length;
    await session.prompt('Refresh while nested hints wait for the outer result');
    assert.equal(notices.slice(initialNotices).filter(message => message === 'hooks.toml: updated.').length, 2);
    const last = session.sessionManager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === HOOK_HINT_MESSAGE).at(-1);
    assert.ok(last?.type === 'custom_message');
    const currentReceipts = last.details as { repeat: Array<{ key: string }> };
    assert.deepEqual(currentReceipts.repeat.map(receipt => receipt.key.split(':')[0]), ['nested-duplicate'],
      'restoring a removed rule cannot revive its queued hint; the unrelated rule still commits');
    await session.prompt('/hooks mute nested-result');
    const mutedLeaf = session.sessionManager.getLeafId();
    assert.ok(mutedLeaf);
    cancelNavigation = true;
    assert.equal((await session.navigateTree(firstUser.id)).cancelled, true);
    await session.prompt('/hooks mute nested-duplicate');
    assert.deepEqual([...restoreHookOverrides(session.sessionManager.getBranch())], ['nested-result', 'nested-duplicate']);
    cancelNavigation = false;
    await session.navigateTree(firstUser.id);
    assert.equal(restoreHookOverrides(session.sessionManager.getBranch()).size, 0);
    await session.navigateTree(mutedLeaf);
    assert.deepEqual([...restoreHookOverrides(session.sessionManager.getBranch())], ['nested-result']);
    await session.prompt('/hooks reset');
    assert.equal(restoreHookOverrides(session.sessionManager.getBranch()).size, 0);
    assert.deepEqual(errors, []);
  } finally {
    try {
      await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    } finally {
      session?.dispose();
      if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
      if (previousSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
      else process.env['PI_SUBAGENT_SOCKET_DIR'] = previousSocketDir;
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
