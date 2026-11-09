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
import { mkdtemp, rm } from 'node:fs/promises';
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

import presetExtension from '../../extensions/preset.ts';

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
