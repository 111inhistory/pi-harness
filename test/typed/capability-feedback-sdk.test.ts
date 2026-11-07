import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fauxProvider, getCurrentTools, getSystemMessageText, InMemoryCredentialStore, type AssistantMessage, type Message } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';

import capabilityExtension from '../../src/capability/extension.ts';
import type { CapabilityDiscoveryResult } from '../../src/capability/agent.ts';
import { CAPABILITY_STEP_TOOL_NAME } from '../../src/capability/contracts.ts';

const GROUP = 'mcp__payload_probe';
const REF = `namespace://${GROUP}`;
const MEMBER_COUNT = 32;
const HOST_GUIDANCE = 'HOST_GUIDANCE_PAYLOAD '.repeat(2000);

type ToolResult = Extract<Message, { role: 'toolResult' }>;

function latestResult(messages: readonly AgentMessage[], name: string): ToolResult {
  const message = messages.findLast((entry): entry is ToolResult => entry.role === 'toolResult' && entry.toolName === name);
  assert.ok(message, `missing ${name} result`);
  return message;
}

function textOf(result: Pick<ToolResult, 'content'>): string {
  return result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

/** Inspect the real SDK's model-bound requests, rather than a UI-rendered result. */
test('large step feedback reaches the next SDK request intact and repeated hits retain selectable refs', { timeout: 30_000 }, async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-capability-feedback-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir);
  const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  const previousFetch = globalThis.fetch;
  const networkAttempts: string[] = [];
  const errors: unknown[] = [];
  let session: AgentSession | undefined;
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      networkAttempts.push(String(input));
      throw new Error('This SDK fixture must remain offline.');
    }) as typeof fetch;
    const faux = fauxProvider({ models: [{ id: 'feedback-fixture', contextWindow: 1_048_576 }] });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    const model = faux.models[0]!;
    let parentCalls = 0;
    let internalCalls = 0;
    const stepBodies: string[] = [];
    const parentBodies: string[] = [];
    runtime.streamSimple = (_model, context) => {
      const internal = getCurrentTools(context.messages).some((tool) => tool.name === CAPABILITY_STEP_TOOL_NAME);
      const stream = new AssistantMessageEventStream();
      let content: AssistantMessage['content'];
      let stopReason: AssistantMessage['stopReason'];
      if (internal) {
        internalCalls++;
        if (internalCalls > 1) stepBodies.push(textOf(latestResult(context.messages, CAPABILITY_STEP_TOOL_NAME)));
        const args = internalCalls < 3 ? { queries: ['payload probe'] } : { refs: [REF], finish: true };
        content = [{ type: 'toolCall', id: `internal-${internalCalls}`, name: CAPABILITY_STEP_TOOL_NAME, arguments: args }];
        stopReason = 'toolUse';
      } else {
        parentCalls++;
        parentBodies.push(context.messages.map((entry) => {
          if (entry.role === 'system') return getSystemMessageText(entry);
          if (typeof entry.content === 'string') return entry.content;
          return entry.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        }).join('\n'));
        content = parentCalls === 1
          ? [{ type: 'toolCall', id: 'parent-discovery', name: 'capability', arguments: {} }]
          : [{ type: 'text', text: 'Discovery completed.' }];
        stopReason = parentCalls === 1 ? 'toolUse' : 'stop';
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
      extensionFactories: [{
        name: 'feedback-fixture',
        factory(pi) {
          capabilityExtension(pi);
          for (let index = 0; index < MEMBER_COUNT; index++) {
            pi.registerTool({
              name: `${GROUP}__operation_${index}`, label: `Operation ${index}`,
              description: `Payload probe operation ${index}. ` + 'MEMBER_DESCRIPTION '.repeat(80),
              namespace: { name: GROUP, description: 'Payload probe fixture namespace.', instructions: HOST_GUIDANCE },
              exposure: 'deferred', defaultActive: false,
              parameters: {
                type: 'object', properties: { payload: { type: 'string', description: 'FULL_PARAMETER_SCHEMA '.repeat(100) } },
              },
              async execute() { throw new Error('Discovery must not execute a selected business tool.'); },
            });
          }
        },
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    session = (await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
    })).session;
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    await session.prompt('Find the payload probe namespace.');

    assert.equal(parentCalls, 2);
    assert.equal(internalCalls, 3);
    assert.equal(stepBodies.length, 2);
    for (const body of stepBodies) {
      assert.doesNotThrow(() => JSON.parse(body), 'the model must receive complete JSON');
      assert.ok(body.length < 8000, `step feedback must stay compact, got ${body.length} characters`);
      assert.ok(body.includes(REF), 'new and repeated feedback must preserve the selectable ref');
      assert.doesNotMatch(body, /HOST_GUIDANCE_PAYLOAD|MEMBER_DESCRIPTION|FULL_PARAMETER_SCHEMA|output truncated/);
    }
    t.diagnostic(`Model-bound step feedback: first ${stepBodies[0]!.length} characters, repeated ${stepBodies[1]!.length} characters.`);
    assert.ok(stepBodies[0]!.includes('Payload probe fixture namespace.'));
    assert.ok(!stepBodies[1]!.includes('Payload probe fixture namespace.'), 'repeat feedback must not resend candidate prose');

    const outcome = latestResult(session.messages, 'capability');
    assert.equal(outcome.isError, false);
    assert.doesNotMatch(textOf(outcome), /HOST_GUIDANCE_PAYLOAD/, 'public content does not duplicate canonical guidance');
    assert.equal(parentBodies[1]!.split(HOST_GUIDANCE).length - 1, 1, 'the next model request retains one complete guidance copy');
    const details = outcome.details as unknown as CapabilityDiscoveryResult;
    assert.equal(details.mcp.length, 1);
    assert.equal(details.mcp[0]?.toolCount, MEMBER_COUNT);
    assert.equal(details.mcp[0]?.tools?.length, MEMBER_COUNT, 'compact feedback must not narrow namespace selection');
    assert.equal(details.mcp[0]?.instructions, HOST_GUIDANCE, 'host diagnostics retain complete guidance');
    for (let index = 0; index < MEMBER_COUNT; index++) {
      assert.ok(session.getActiveToolNames().includes(`${GROUP}__operation_${index}`));
    }
    assert.deepEqual(networkAttempts, []);
    assert.deepEqual(errors, []);
  } finally {
    try { await session?.dispose(); }
    finally {
      globalThis.fetch = previousFetch;
      if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
