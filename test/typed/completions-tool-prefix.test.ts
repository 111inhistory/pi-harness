import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeContext,
  type AssistantMessage,
  type Message,
  type Model,
  type OpenAICompletionsCompat,
  type SystemMessage,
  type Tool,
  type UserMessage,
} from '@earendil-works/pi-ai';
import { stream as streamCompletions } from '@earendil-works/pi-ai/api/openai-completions';

import { providerSessionPolicy } from '../../src/provider-session.ts';
import { additiveToolTranscript } from '../../src/session-transcript.ts';
import { retrievalToolLoadout } from '../../src/capability/retrieval-tools.ts';

interface WireFunctionTool {
  readonly type: string;
  readonly function?: {
    readonly name?: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
  };
}

interface WireMessage {
  readonly role: string;
  readonly content?: string | unknown[];
  readonly tools?: readonly WireFunctionTool[];
}

interface WireChatCompletionPayload {
  readonly model: string;
  readonly messages: readonly WireMessage[];
  readonly tools?: readonly WireFunctionTool[];
  readonly stream?: boolean;
}

function fixtureModel(compat: OpenAICompletionsCompat): Model<'openai-completions'> {
  return {
    id: 'fixture-completions-model',
    name: 'Fixture Completions Model',
    api: 'openai-completions',
    provider: 'fixture-provider',
    baseUrl: 'https://fixture.example.com/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 32768,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat,
  };
}

const tool = (name: string, description = name, properties: Record<string, unknown> = {}): Tool => ({
  name,
  description,
  parameters: { type: 'object', properties },
});

function assistantMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fixture-provider',
    model: 'fixture-completions-model',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
  };
}

async function captureCompletionsWire(
  model: Model<'openai-completions'>,
  messages: readonly Message[],
): Promise<WireChatCompletionPayload> {
  let captured: WireChatCompletionPayload | undefined;
  const runner = streamCompletions(model, normalizeContext({ messages: messages as Message[] }), {
    apiKey: 'offline',
    fetch: async () => {
      throw new Error('Offline: network access is prohibited in tests');
    },
    onPayload: (payload) => {
      captured = payload as WireChatCompletionPayload;
      throw new Error('Payload captured');
    },
  });
  const result = await runner.result();
  assert.equal(result.stopReason, 'error');
  assert.ok(captured, 'Request payload must be captured by onPayload hook');
  return captured;
}

test('standard mode: all tools are folded to top-level request.tools and messages never contain nested tools', async () => {
  const model = fixtureModel({
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolAdditions: false,
  });

  assert.deepEqual(providerSessionPolicy(model), {
    transport: 'completions',
    midConversationSystemMessages: true,
    toolAdditions: false,
    toolSameNameUpdates: false,
    midConversationEffort: 'none',
  });

  const toolRead = tool('read', 'Read file');
  const toolBash = tool('bash', 'Run command');

  const messages: Message[] = [
    { role: 'system', content: 'Base prompt', toolsAdded: [toolRead], timestamp: 1 },
    { role: 'user', content: 'Turn 1', timestamp: 2 },
    assistantMessage('Turn 1 reply', 3),
    { role: 'system', content: 'Activating bash', toolsAdded: [toolBash], timestamp: 4 },
    { role: 'user', content: 'Turn 2', timestamp: 5 },
  ];

  const payload = await captureCompletionsWire(model, messages);

  // All tools folded to top-level
  const topToolNames = payload.tools?.map((t) => t.function?.name);
  assert.deepEqual(topToolNames, ['read', 'bash']);

  // Messages never contain nested tools field
  for (const message of payload.messages) {
    assert.equal('tools' in message, false, 'Standard Completions messages must not contain tools property');
  }
});

test('single compat flag is insufficient to enable in-message tool additions', async () => {
  const toolRead = tool('read');
  const toolBash = tool('bash');
  const messages: Message[] = [
    { role: 'system', content: 'Base', toolsAdded: [toolRead], timestamp: 1 },
    { role: 'user', content: 'Hello', timestamp: 2 },
    { role: 'system', content: 'Next', toolsAdded: [toolBash], timestamp: 3 },
  ];

  // Case 1: only supportsMidConvoSystemMessages: true
  const modelSystemOnly = fixtureModel({ supportsMidConvoSystemMessages: true });
  assert.equal(providerSessionPolicy(modelSystemOnly).toolAdditions, false);
  const payloadSystemOnly = await captureCompletionsWire(modelSystemOnly, messages);
  assert.deepEqual(payloadSystemOnly.tools?.map((t) => t.function?.name), ['read', 'bash']);
  assert.ok(payloadSystemOnly.messages.every((m) => !('tools' in m)));

  // Case 2: only supportsMidConvoToolAdditions: true (cannot anchor mid-convo without mid-convo system messages)
  const modelToolOnly = fixtureModel({ supportsMidConvoToolAdditions: true });
  assert.equal(providerSessionPolicy(modelToolOnly).toolAdditions, false);
  const payloadToolOnly = await captureCompletionsWire(modelToolOnly, messages);
  assert.deepEqual(payloadToolOnly.tools?.map((t) => t.function?.name), ['read', 'bash']);
  assert.ok(payloadToolOnly.messages.every((m) => !('tools' in m)));
});

test('enabled additions: preserves initial top-level tools and previous messages prefix', async () => {
  const model = fixtureModel({
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolAdditions: true,
  });

  assert.deepEqual(providerSessionPolicy(model), {
    transport: 'completions',
    midConversationSystemMessages: true,
    toolAdditions: true,
    toolSameNameUpdates: false,
    midConversationEffort: 'none',
  });

  const toolRead = tool('read', 'Read file');
  const toolBash = tool('bash', 'Run command');

  const turn1Messages: Message[] = [
    { role: 'system', content: 'Base instructions', toolsAdded: [toolRead], timestamp: 1 },
    { role: 'user', content: 'Query 1', timestamp: 2 },
  ];

  const payloadTurn1 = await captureCompletionsWire(model, turn1Messages);
  assert.deepEqual(payloadTurn1.tools?.map((t) => t.function?.name), ['read']);
  assert.equal(payloadTurn1.messages.length, 2);

  const turn2Messages: Message[] = [
    ...turn1Messages,
    assistantMessage('Answer 1', 3),
    { role: 'system', content: 'Adding tool bash', toolsAdded: [toolBash], timestamp: 4 },
    { role: 'user', content: 'Query 2', timestamp: 5 },
  ];

  const payloadTurn2 = await captureCompletionsWire(model, turn2Messages);

  // Top-level tools are preserved from initial declaration
  assert.deepEqual(payloadTurn2.tools?.map((t) => t.function?.name), ['read']);

  // Messages prefix before the addition is structurally preserved
  assert.deepEqual(payloadTurn2.messages.slice(0, 2), payloadTurn1.messages);
  assert.equal(payloadTurn2.messages[2]?.role, 'assistant');

  // The addition message carries the nested tools definition
  const toolAddMessage = payloadTurn2.messages[3];
  assert.ok(toolAddMessage);
  assert.equal(toolAddMessage.role, 'system');
  assert.deepEqual(toolAddMessage.tools?.map((t) => t.function?.name), ['bash']);

  // The accompanying text message carries the content
  const textMessage = payloadTurn2.messages[4];
  assert.ok(textMessage);
  assert.equal(textMessage.role, 'system');
  assert.equal(textMessage.content, 'Adding tool bash');
});

test('same-name schema replacement triggers SDK rebase limitation', async () => {
  const model = fixtureModel({
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolAdditions: true,
  });

  const toolReadV1 = tool('read', 'Read file v1', { path: { type: 'string' } });
  const toolBash = tool('bash', 'Run command');
  const toolReadV2 = tool('read', 'Read file v2', { uri: { type: 'string' }, offset: { type: 'number' } });

  const messages: Message[] = [
    { role: 'system', content: 'Base', toolsAdded: [toolReadV1], timestamp: 1 },
    { role: 'user', content: 'Task 1', timestamp: 2 },
    assistantMessage('Done 1', 3),
    { role: 'system', content: '', toolsAdded: [toolBash], timestamp: 4 },
    { role: 'user', content: 'Task 2', timestamp: 5 },
    assistantMessage('Done 2', 6),
    // Same-name redeclaration with updated schema
    { role: 'system', content: 'Updated schema', toolsAdded: [toolReadV2], timestamp: 7 },
    { role: 'user', content: 'Task 3', timestamp: 8 },
  ];

  const payload = await captureCompletionsWire(model, messages);

  // SDK findLastNonAdditiveToolChange detects the duplicate tool name and rebases
  // all tools into top-level request.tools up to that system message
  const topToolNames = payload.tools?.map((t) => t.function?.name);
  assert.deepEqual(topToolNames, ['read', 'bash']);

  const updatedReadTool = payload.tools?.find((t) => t.function?.name === 'read');
  assert.equal(updatedReadTool?.function?.description, 'Read file v2');
  assert.deepEqual(updatedReadTool?.function?.parameters, {
    type: 'object',
    properties: { uri: { type: 'string' }, offset: { type: 'number' } },
  });

  // Previous incremental tool additions are collapsed out of messages
  assert.ok(payload.messages.every((m) => !('tools' in m)));
});

test('soft tool removal via additiveToolTranscript: notes unavailability without dropping historical declarations or granting execution authority', async () => {
  const model = fixtureModel({
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolAdditions: true,
  });

  const toolRead = tool('read');
  const toolBash = tool('bash');

  const rawMessages: Message[] = [
    { role: 'system', content: 'Base', toolsAdded: [toolRead, toolBash], timestamp: 1 },
    { role: 'user', content: 'Do something', timestamp: 2 },
    assistantMessage('Working on it', 3),
    { role: 'system', content: '', toolsRemoved: [{ name: 'bash' }], timestamp: 4 },
    { role: 'user', content: 'Next step', timestamp: 5 },
  ];

  const projected = additiveToolTranscript(rawMessages);

  // additiveToolTranscript removes toolsRemoved and appends soft blocking note
  assert.ok(projected.every((m) => m.role !== 'system' || !(m as SystemMessage).toolsRemoved?.length));
  const removalMessage = projected.find((m) => m.role === 'system' && String(m.content).includes('Tool bash is unavailable'));
  assert.ok(removalMessage, 'Must contain soft blocking note');
  assert.match(String(removalMessage.content), /execution is blocked/);

  // On wire, the tools remain declared historically (since additions-only transport cannot delete tools)
  const payload = await captureCompletionsWire(model, projected);
  assert.deepEqual(payload.tools?.map((t) => t.function?.name), ['read', 'bash']);

  // The soft blocking note is emitted in instruction content
  const wireRemovalMsg = payload.messages.find((m) => m.role === 'system' && String(m.content).includes('Tool bash is unavailable'));
  assert.ok(wireRemovalMsg, 'Blocking note must be present in serialized messages');
});

test('retrievalToolLoadout produces blocked execution placeholders while keeping declarations intact', async () => {
  const toolRead = { ...tool('read', 'Read a file'), label: 'read', execute: async () => 'read content' };
  const toolBash = { ...tool('bash', 'Run command'), label: 'bash', execute: async () => 'bash output' };
  const stepTool = { ...tool('capability_step', 'Step selector'), label: 'capability_step', execute: async () => 'step ok' };

  const inheritedMessages: Message[] = [
    { role: 'system', content: 'Preamble', toolsAdded: [toolRead, toolBash], timestamp: 1 },
    { role: 'user', content: 'Find tool', timestamp: 2 },
  ];

  const loadout = retrievalToolLoadout(inheritedMessages, [stepTool]);

  // Loadout preserves declaration order and metadata
  assert.deepEqual(loadout.map((t) => t.name), ['read', 'bash', 'capability_step']);
  assert.equal(loadout[0]?.description, 'Read a file');
  assert.equal(loadout[1]?.description, 'Run command');

  // Blocked tools reject execution
  await assert.rejects(loadout[0]!.execute(), /unavailable in capability discovery/);
  await assert.rejects(loadout[1]!.execute(), /unavailable in capability discovery/);

  // Explicitly admitted retrieval tool executes normally
  const stepResult = await loadout[2]!.execute();
  assert.equal(stepResult, 'step ok');
});
