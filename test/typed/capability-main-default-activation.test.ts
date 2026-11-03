import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  fauxProvider, getCurrentTools, InMemoryCredentialStore, type AssistantMessage, type Message,
} from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';

import harnessExtension from '../../extensions/harness.ts';
import type { CapabilityDiscoveryResult } from '../../src/capability/agent.ts';
import { CAPABILITY_STEP_TOOL_NAME } from '../../src/capability/contracts.ts';

type ToolResult = Extract<Message, { role: 'toolResult' }>;
const SUBAGENT_TOOLS = ['msg_write', 'session_intent', 'session_list', 'subagent_create', 'subagent_list', 'subagent_stop'] as const;
const SUBAGENT_REF = 'namespace://subagent';

function latestResult(messages: readonly AgentMessage[], name: string): ToolResult {
  const message = messages.findLast((entry): entry is ToolResult => entry.role === 'toolResult' && entry.toolName === name);
  assert.ok(message, `missing ${name} result`);
  return message;
}

/**
 * Main must start without msg_write. It stays registered in the Subagent
 * namespace, and Capability activates the whole namespace when discovery selects
 * it. This runs the actual harness extension, not a reduced fixture.
 */
test('Main starts without msg_write and Capability activates the Subagent namespace', { timeout: 30_000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-capability-main-activation-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir);
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const previousSocketDir = process.env['PI_SUBAGENT_SOCKET_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(cwd, 'uds');
  const previousFetch = globalThis.fetch;
  const networkAttempts: string[] = [];
  const errors: unknown[] = [];
  let session: AgentSession | undefined;
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      networkAttempts.push(String(input));
      throw new Error('This SDK fixture must remain offline.');
    }) as typeof fetch;

    const faux = fauxProvider({ models: [{ id: 'main-activation-fixture', contextWindow: 1_048_576 }] });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    const model = faux.models[0]!;
    let rootCalls = 0;
    let internalCalls = 0;
    runtime.streamSimple = (_model, context) => {
      const internal = getCurrentTools(context.messages).some((tool) => tool.name === CAPABILITY_STEP_TOOL_NAME);
      const stream = new AssistantMessageEventStream();
      let content: AssistantMessage['content'];
      let stopReason: AssistantMessage['stopReason'];
      if (internal) {
        internalCalls += 1;
        const args = internalCalls === 1
          ? { queries: [SUBAGENT_REF] }
          : { refs: [SUBAGENT_REF], finish: true };
        content = [{ type: 'toolCall', id: `internal-${internalCalls}`, name: CAPABILITY_STEP_TOOL_NAME, arguments: args }];
        stopReason = 'toolUse';
      } else {
        rootCalls += 1;
        content = rootCalls === 1
          ? [{ type: 'toolCall', id: 'root-discovery', name: 'capability', arguments: {} }]
          : [{ type: 'text', text: 'Discovery completed.' }];
        stopReason = rootCalls === 1 ? 'toolUse' : 'stop';
      }
      const message: AssistantMessage = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content, stopReason, timestamp: Date.now(),
        usage: {
          input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
        },
      };
      stream.push({ type: 'done', reason: stopReason, message });
      stream.end();
      return stream;
    };

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{ name: 'harness-main-activation-fixture', factory: harnessExtension }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    session = (await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    })).session;
    await session.bindExtensions({ onError: (error) => errors.push(error) });

    const registered = session.getAllTools();
    const msgWrite = registered.find((tool) => tool.name === 'msg_write');
    assert.ok(msgWrite, 'msg_write must stay registered for Capability discovery');
    assert.equal(msgWrite.namespace?.name, 'subagent');
    assert.deepEqual(
      registered.filter((tool) => tool.namespace?.name === 'subagent').map((tool) => tool.name).sort(),
      [...SUBAGENT_TOOLS].sort(),
      'the Subagent namespace contains every group member',
    );
    const initialActive = session.getActiveToolNames();
    for (const name of SUBAGENT_TOOLS) {
      assert.ok(!initialActive.includes(name), `${name} must not be active on Main before discovery`);
    }

    await session.prompt('Select the Subagent tools.');

    assert.equal(rootCalls, 2);
    assert.equal(internalCalls, 2);
    const outcome = latestResult(session.messages, 'capability');
    assert.equal(outcome.isError, false);
    const details = outcome.details as unknown as CapabilityDiscoveryResult;
    const selected = details.tools.find((hit) => hit.ref === SUBAGENT_REF);
    assert.ok(selected, 'Capability must select the Subagent namespace');
    assert.equal(selected.kind, 'namespace');
    assert.deepEqual(selected.tools?.map((tool) => tool.name).sort(), [...SUBAGENT_TOOLS].sort());

    const activeAfter = session.getActiveToolNames();
    for (const name of SUBAGENT_TOOLS) {
      assert.ok(activeAfter.includes(name), `${name} must be activated together with the namespace`);
    }
    assert.deepEqual(networkAttempts, []);
    assert.deepEqual(errors, []);
  } finally {
    try { await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
    finally {
      session?.dispose();
      globalThis.fetch = previousFetch;
      if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
      if (previousSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
      else process.env['PI_SUBAGENT_SOCKET_DIR'] = previousSocketDir;
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
