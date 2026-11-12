/**
 * Provider-boundary proof for the shared append-only transcript contract.
 *
 * Each case runs a real Pi provider adapter (`openai-responses`,
 * `anthropic-messages` or `openai-completions`) against an offline fixture.
 * `onPayload` captures the exact serialized request and throws before any HTTP
 * call, so nothing here depends on a provider or a network.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeContext,
  type AnthropicMessagesCompat,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type OpenAICompletionsCompat,
  type OpenAIResponsesCompat,
  type SystemMessage,
  type Tool,
} from '@earendil-works/pi-ai';
import { stream as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { stream as streamAzureResponses } from '@earendil-works/pi-ai/api/azure-openai-responses';
import { stream as streamChatCompletions } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as streamCodexResponses } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { stream as streamResponses } from '@earendil-works/pi-ai/api/openai-responses';

import { appendSessionTranscript } from '../../src/session-transcript.ts';

type UnknownRecord = Record<string, unknown>;

const offlineFetch: typeof globalThis.fetch = async () => {
  throw new Error('network access is forbidden in provider-session-sdk.test.ts');
};

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function records(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = record(item);
    return entry === undefined ? [] : [entry];
  });
}

function tool(name: string, description = name): Tool {
  return { name, description, parameters: { type: 'object', properties: {} } };
}

function system(content: string, tools: readonly Tool[] = []): SystemMessage {
  return {
    role: 'system',
    content,
    ...(tools.length === 0 ? {} : { toolsAdded: [...tools] }),
    timestamp: 0,
  };
}

function user(content: string): Message {
  return { role: 'user', content, timestamp: 1 };
}

function responsesModel(
  compat: OpenAIResponsesCompat,
  overrides: Partial<Model<'openai-responses'>> = {},
): Model<'openai-responses'> {
  return {
    id: 'offline-responses',
    name: 'Offline Responses',
    api: 'openai-responses',
    provider: 'offline-fixture',
    baseUrl: 'http://offline.invalid/v1',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 100_000,
    maxTokens: 4096,
    compat,
    ...overrides,
  };
}

function azureResponsesModel(compat: OpenAIResponsesCompat): Model<'azure-openai-responses'> {
  return {
    id: 'offline-azure-responses',
    name: 'Offline Azure Responses',
    api: 'azure-openai-responses',
    provider: 'azure',
    baseUrl: 'https://offline.invalid/openai/v1',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 100_000,
    maxTokens: 4096,
    compat,
  };
}

function codexResponsesModel(compat: OpenAIResponsesCompat): Model<'openai-codex-responses'> {
  return {
    id: 'offline-codex-responses',
    name: 'Offline Codex Responses',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://offline.invalid/backend-api',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 100_000,
    maxTokens: 4096,
    compat,
  };
}

function anthropicModel(
  compat: AnthropicMessagesCompat,
  overrides: Partial<Model<'anthropic-messages'>> = {},
): Model<'anthropic-messages'> {
  return {
    id: 'offline-anthropic',
    name: 'Offline Anthropic',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'http://offline.invalid',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 100_000,
    maxTokens: 4096,
    compat,
    ...overrides,
  };
}

function chatModel(
  compat: OpenAICompletionsCompat,
  overrides: Partial<Model<'openai-completions'>> = {},
): Model<'openai-completions'> {
  return {
    id: 'offline-chat',
    name: 'Offline Chat Completions',
    api: 'openai-completions',
    provider: 'offline-fixture',
    baseUrl: 'http://offline.invalid/v1',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 100_000,
    maxTokens: 4096,
    compat,
    ...overrides,
  };
}

async function capturePayload<T>(
  run: (onPayload: (payload: unknown) => never) => AssistantMessageEventStream,
): Promise<T> {
  let captured: unknown;
  const result = await run((payload) => {
    captured = payload;
    throw new Error('payload captured');
  }).result();
  assert.equal(result.stopReason, 'error');
  assert.notEqual(captured, undefined);
  return captured as T;
}

function context(messages: readonly (Message | SystemMessage)[]) {
  return normalizeContext({ messages: [...messages] });
}

interface ResponsesPayload {
  readonly input?: readonly unknown[];
  readonly tools?: readonly unknown[];
  readonly reasoning?: unknown;
}

interface AnthropicPayload {
  readonly system?: readonly unknown[];
  readonly messages?: readonly unknown[];
  readonly tools?: readonly unknown[];
  readonly betas?: readonly string[];
  readonly thinking?: unknown;
  readonly output_config?: unknown;
}

interface ChatPayload {
  readonly messages?: readonly unknown[];
  readonly tools?: readonly unknown[];
  readonly reasoning_effort?: unknown;
}

function configurationUpdates(payload: ResponsesPayload): UnknownRecord[] {
  return records(payload.input).filter((item) => item['type'] === 'configuration_update');
}

function configurationEfforts(payload: ResponsesPayload): unknown[] {
  return configurationUpdates(payload).map((item) => record(item['reasoning'])?.['effort']);
}

function responsesReasoningEffort(payload: ResponsesPayload): unknown {
  return record(payload.reasoning)?.['effort'];
}

function codexToken(): string {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'offline-account' },
  })).toString('base64');
  return `offline-header.${payload}.offline-signature`;
}

function names(value: unknown): string[] {
  return records(value).flatMap((entry) => {
    if (typeof entry['name'] === 'string') return [entry['name']];
    const fn = record(entry['function']);
    return typeof fn?.['name'] === 'string' ? [fn['name']] : [];
  });
}

function responsesAdditionalTools(payload: ResponsesPayload): UnknownRecord[] {
  return records(payload.input).flatMap((item) => {
    if (item['type'] !== 'additional_tools') return [];
    return records(item['tools']);
  });
}

function responsesToolSearchTools(payload: ResponsesPayload): UnknownRecord[] {
  return records(payload.input).flatMap((item) => {
    if (item['type'] !== 'tool_search_output') return [];
    return records(item['tools']);
  });
}

function responseTexts(payload: ResponsesPayload): string[] {
  return records(payload.input).flatMap((item) => typeof item['content'] === 'string' ? [item['content']] : []);
}

function anthropicBlocks(payload: AnthropicPayload, message: UnknownRecord): UnknownRecord[] {
  const index = records(payload.messages).indexOf(message);
  assert.notEqual(index, -1);
  return records(message['content']);
}

function anthropicAddedTools(blocks: readonly UnknownRecord[]): UnknownRecord[] {
  return blocks.flatMap((block) => {
    if (block['type'] !== 'tool_addition') return [];
    const definition = record(record(block['tool'])?.['definition']);
    return definition === undefined ? [] : [definition];
  });
}

function blockTypes(blocks: readonly UnknownRecord[]): string[] {
  return blocks.flatMap((block) => typeof block['type'] === 'string' ? [block['type']] : []);
}

function lastSystemMessage(payload: AnthropicPayload): UnknownRecord | undefined {
  return records(payload.messages).findLast((message) => message['role'] === 'system');
}

function anthropicEffortMarkers(payload: AnthropicPayload): unknown[] {
  return records(payload.messages).flatMap((message) => {
    if (message['role'] !== 'system') return [];
    const outputConfig = record(message['output_config']);
    return outputConfig === undefined ? [] : [outputConfig['effort']];
  });
}

test('Responses keeps the inherited prefix and appends instructions and same-name updates', async () => {
  const inherited: Message[] = [
    system('BASE', [tool('read', 'read v1')]),
    user('TASK'),
  ];
  const model = responsesModel({
    supportsMidConvoSystemMessages: true,
    supportsAdditionalTools: true,
  });
  const baseline = await capturePayload<ResponsesPayload>((onPayload) => streamResponses(
    model,
    context(inherited),
    { apiKey: 'offline-fixture', fetch: offlineFetch, onPayload },
  ));
  const appendedMessages = appendSessionTranscript(inherited, {
    instructions: { text: 'CHILD INSTRUCTIONS' },
    declarations: [tool('read', 'read v2'), tool('deck_pages')],
  });
  const appended = await capturePayload<ResponsesPayload>((onPayload) => streamResponses(
    model,
    context(appendedMessages.messages),
    { apiKey: 'offline-fixture', fetch: offlineFetch, onPayload },
  ));

  const baselineInput = baseline.input;
  assert.ok(Array.isArray(baselineInput));
  assert.deepEqual(appended.input?.slice(0, baselineInput.length), baselineInput);
  assert.deepEqual(names(baseline.tools), []);
  assert.deepEqual(responsesAdditionalTools(baseline).map((entry) => [entry['name'], entry['description']]), [
    ['read', 'read v1'],
  ]);
  assert.deepEqual(responsesAdditionalTools(appended).map((entry) => [entry['name'], entry['description']]), [
    ['read', 'read v1'],
    ['read', 'read v2'],
    ['deck_pages', 'deck_pages'],
  ]);
  assert.deepEqual(responseTexts(appended).filter((text) => text === 'BASE' || text === 'CHILD INSTRUCTIONS'), [
    'BASE',
    'CHILD INSTRUCTIONS',
  ]);
  assert.equal(responseTexts(appended)[0], 'BASE');
  assert.equal(responseTexts(appended).at(-1), 'CHILD INSTRUCTIONS');
  assert.doesNotMatch(JSON.stringify(appended), /tools_removed|tool_removal|toolsRemoved/);
});

test('Responses tool-search mode appends declarations without rewriting the top-level tools', async () => {
  const inherited: Message[] = [
    system('BASE', [tool('read', 'read v1')]),
    user('TASK'),
  ];
  const model = responsesModel({
    supportsMidConvoSystemMessages: true,
    supportsToolSearch: true,
  });
  const baseline = await capturePayload<ResponsesPayload>((onPayload) => streamResponses(
    model,
    context(inherited),
    { apiKey: 'offline-fixture', fetch: offlineFetch, onPayload },
  ));
  const appendedMessages = appendSessionTranscript(inherited, {
    instructions: { text: 'CHILD INSTRUCTIONS' },
    declarations: [tool('deck_pages')],
  });
  const appended = await capturePayload<ResponsesPayload>((onPayload) => streamResponses(
    model,
    context(appendedMessages.messages),
    { apiKey: 'offline-fixture', fetch: offlineFetch, onPayload },
  ));

  const baselineInput = baseline.input;
  assert.ok(Array.isArray(baselineInput));
  assert.deepEqual(appended.input?.slice(0, baselineInput.length), baselineInput);
  assert.deepEqual(names(baseline.tools), ['read']);
  assert.deepEqual(names(appended.tools), ['read']);
  assert.deepEqual(responsesAdditionalTools(appended), []);
  assert.deepEqual(names(responsesToolSearchTools(appended)), ['deck_pages']);
  assert.deepEqual(responseTexts(appended), ['BASE', 'CHILD INSTRUCTIONS']);
  assert.doesNotMatch(JSON.stringify(appended), /tools_removed|tool_removal|toolsRemoved/);
});

test('Anthropic keeps its initial tool anchor and emits inline tool additions and beta', async () => {
  const inherited: Message[] = [
    system('BASE', [tool('read', 'read v1')]),
    user('TASK'),
  ];
  const model = anthropicModel({
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
  });
  const baseline = await capturePayload<AnthropicPayload>((onPayload) => streamAnthropic(
    model,
    context(inherited),
    { apiKey: 'offline-fixture', cacheRetention: 'none', fetch: offlineFetch, onPayload },
  ));
  const appendedMessages = appendSessionTranscript(inherited, {
    instructions: { text: 'CHILD INSTRUCTIONS' },
    declarations: [tool('read', 'read v2'), tool('deck_pages')],
  });
  const appended = await capturePayload<AnthropicPayload>((onPayload) => streamAnthropic(
    model,
    context(appendedMessages.messages),
    { apiKey: 'offline-fixture', cacheRetention: 'none', fetch: offlineFetch, onPayload },
  ));

  const baselineMessages = records(baseline.messages);
  assert.deepEqual(appended.system, baseline.system);
  assert.deepEqual(appended.tools, baseline.tools);
  assert.deepEqual(appended.betas, baseline.betas);
  assert.ok(appended.betas?.includes('inline-tools-2026-09-15'));
  assert.deepEqual(names(appended.tools), ['read', '__pi_deferred_placeholder__']);
  assert.deepEqual(records(appended.messages).slice(0, baselineMessages.length), baselineMessages);

  const update = lastSystemMessage(appended);
  assert.ok(update);
  const blocks = anthropicBlocks(appended, update);
  assert.deepEqual(blockTypes(blocks), ['text', 'tool_addition', 'tool_addition']);
  assert.equal(blocks[0]?.['text'], 'CHILD INSTRUCTIONS');
  assert.deepEqual(anthropicAddedTools(blocks).map((entry) => [entry['name'], entry['description']]), [
    ['read', 'read v2'],
    ['deck_pages', 'deck_pages'],
  ]);
  assert.doesNotMatch(JSON.stringify(appended), /tool_removal|tools_removed|toolsRemoved/);
});

test('Anthropic without an initial tool anchor falls back to the current tool list', async () => {
  const inherited: Message[] = [system('BASE'), user('TASK')];
  const model = anthropicModel({
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
  });

  const baseline = await capturePayload<AnthropicPayload>((onPayload) => streamAnthropic(
    model,
    context(inherited),
    { apiKey: 'offline-fixture', cacheRetention: 'none', fetch: offlineFetch, onPayload },
  ));
  const appendedMessages = appendSessionTranscript(inherited, {
    instructions: { text: 'CHILD INSTRUCTIONS' },
    declarations: [tool('read', 'read v2'), tool('deck_pages')],
  });
  const appended = await capturePayload<AnthropicPayload>((onPayload) => streamAnthropic(
    model,
    context(appendedMessages.messages),
    { apiKey: 'offline-fixture', cacheRetention: 'none', fetch: offlineFetch, onPayload },
  ));

  assert.equal(baseline.tools, undefined);
  assert.deepEqual(names(appended.tools), ['read', 'deck_pages']);
  assert.ok(!names(appended.tools).includes('__pi_deferred_placeholder__'));
  assert.ok(!(appended.betas ?? []).includes('inline-tools-2026-09-15'));
  assert.deepEqual(appended.system, baseline.system);

  const update = lastSystemMessage(appended);
  assert.ok(update);
  const blocks = anthropicBlocks(appended, update);
  assert.deepEqual(blockTypes(blocks), ['text']);
  assert.equal(blocks[0]?.['text'], 'CHILD INSTRUCTIONS');
});

test('Chat Completions stays on Pi native behavior without compat mutation', async () => {
  const inherited: Message[] = [
    system('BASE', [tool('read', 'read v1')]),
    user('TASK'),
  ];
  const model = chatModel({
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolAdditions: true,
  });
  const compatBefore = structuredClone(model.compat);

  const baseline = await capturePayload<ChatPayload>((onPayload) => streamChatCompletions(
    model,
    context(inherited),
    { apiKey: 'offline-fixture', fetch: offlineFetch, onPayload },
  ));
  const appendedMessages = appendSessionTranscript(inherited, {
    instructions: { text: 'CHILD INSTRUCTIONS' },
    declarations: [tool('deck_pages')],
  });
  const appended = await capturePayload<ChatPayload>((onPayload) => streamChatCompletions(
    model,
    context(appendedMessages.messages),
    { apiKey: 'offline-fixture', fetch: offlineFetch, onPayload },
  ));

  assert.deepEqual(model.compat, compatBefore);
  const baselineMessages = records(baseline.messages);
  assert.deepEqual(records(appended.messages).slice(0, baselineMessages.length), baselineMessages);
  assert.deepEqual(names(baseline.tools), ['read']);
  assert.deepEqual(names(appended.tools), ['read']);

  const tail = records(appended.messages).slice(baselineMessages.length);
  assert.equal(tail[0]?.['role'], 'system');
  assert.deepEqual(names(tail[0]?.['tools']), ['deck_pages']);
  assert.equal(tail[1]?.['role'], 'system');
  assert.equal(tail[1]?.['content'], 'CHILD INSTRUCTIONS');
  assert.doesNotMatch(JSON.stringify(appended), /tools_removed|tool_removal|toolsRemoved/);
});

test('Responses managed effort fixes the request effort and updates only the tail configuration item', async () => {
  const model = responsesModel({ supportsMidConvoEffort: true }, { reasoning: true });
  const inherited: Message[] = [system('BASE'), user('TASK')];
  const capture = (reasoningEffort: 'low' | 'high') => capturePayload<ResponsesPayload>((onPayload) => streamResponses(
    model,
    context(inherited),
    { apiKey: 'offline-fixture', fetch: offlineFetch, onPayload, reasoningEffort },
  ));

  const low = await capture('low');
  const high = await capture('high');

  assert.equal(responsesReasoningEffort(low), 'medium');
  assert.equal(responsesReasoningEffort(high), 'medium');
  assert.deepEqual(configurationEfforts(low), ['low']);
  assert.deepEqual(configurationEfforts(high), ['high']);

  const lowInput = low.input;
  const highInput = high.input;
  assert.ok(Array.isArray(lowInput));
  assert.ok(Array.isArray(highInput));
  assert.deepEqual(lowInput.slice(0, -1), highInput.slice(0, -1));
  assert.deepEqual(lowInput.at(-1), {
    type: 'configuration_update',
    reasoning: { effort: 'low' },
  });
  assert.deepEqual(highInput.at(-1), {
    type: 'configuration_update',
    reasoning: { effort: 'high' },
  });
});

test('Responses direct sign-in suppresses the managed effort encoder', async () => {
  const model = responsesModel(
    { supportsMidConvoEffort: true },
    { provider: 'openai', baseUrl: 'https://api.openai.com/v1', reasoning: true },
  );
  const inherited: Message[] = [system('BASE'), user('TASK')];
  const capture = (reasoningEffort: 'low' | 'high') => capturePayload<ResponsesPayload>((onPayload) => streamResponses(
    model,
    context(inherited),
    { apiKey: 'offline-chatgpt-token', fetch: offlineFetch, onPayload, reasoningEffort },
  ));

  const low = await capture('low');
  const high = await capture('high');

  assert.deepEqual(configurationUpdates(low), []);
  assert.deepEqual(configurationUpdates(high), []);
  assert.equal(responsesReasoningEffort(low), 'low');
  assert.equal(responsesReasoningEffort(high), 'high');
  assert.deepEqual(low.input, high.input);
});

test('Azure Responses has no managed effort encoder and changes the top-level effort', async () => {
  const model = azureResponsesModel({ supportsMidConvoEffort: true });
  const inherited: Message[] = [system('BASE'), user('TASK')];
  const capture = (reasoningEffort: 'low' | 'high') => capturePayload<ResponsesPayload>((onPayload) => streamAzureResponses(
    model,
    context(inherited),
    { apiKey: 'offline-fixture', fetch: offlineFetch, onPayload, reasoningEffort },
  ));

  const low = await capture('low');
  const high = await capture('high');

  assert.deepEqual(configurationUpdates(low), []);
  assert.deepEqual(configurationUpdates(high), []);
  assert.equal(responsesReasoningEffort(low), 'low');
  assert.equal(responsesReasoningEffort(high), 'high');
  assert.deepEqual(low.input, high.input);
});

test('Codex Responses has no managed effort encoder and changes the top-level effort', async () => {
  const model = codexResponsesModel({ supportsMidConvoEffort: true });
  const inherited: Message[] = [system('BASE'), user('TASK')];
  const capture = (reasoningEffort: 'low' | 'high') => capturePayload<ResponsesPayload>((onPayload) => streamCodexResponses(
    model,
    context(inherited),
    { apiKey: codexToken(), fetch: offlineFetch, onPayload, reasoningEffort },
  ));

  const low = await capture('low');
  const high = await capture('high');

  assert.deepEqual(configurationUpdates(low), []);
  assert.deepEqual(configurationUpdates(high), []);
  assert.equal(responsesReasoningEffort(low), 'low');
  assert.equal(responsesReasoningEffort(high), 'high');
  assert.deepEqual(low.input, high.input);
});

test('Anthropic managed effort keeps its top-level effort and changes the tail marker', async () => {
  const model = anthropicModel(
    { supportsMidConvoEffort: true },
    { reasoning: true, thinkingLevelMap: { off: 'none' } },
  );
  const inherited: Message[] = [system('BASE'), user('TASK')];
  const capture = (effort: 'low' | 'high') => capturePayload<AnthropicPayload>((onPayload) => streamAnthropic(
    model,
    context(inherited),
    {
      apiKey: 'offline-fixture',
      cacheRetention: 'none',
      fetch: offlineFetch,
      onPayload,
      thinkingEnabled: true,
      effort,
    },
  ));

  const low = await capture('low');
  const high = await capture('high');

  assert.equal(record(low.output_config)?.['effort'], 'low');
  assert.equal(record(high.output_config)?.['effort'], 'low');
  assert.equal(record(low.thinking)?.['type'], 'adaptive');
  assert.equal(record(high.thinking)?.['type'], 'adaptive');
  assert.deepEqual(anthropicEffortMarkers(low), ['low']);
  assert.deepEqual(anthropicEffortMarkers(high), ['high']);

  const lowMessages = records(low.messages);
  const highMessages = records(high.messages);
  assert.deepEqual(lowMessages.slice(0, -1), highMessages.slice(0, -1));
  assert.notDeepEqual(lowMessages.at(-1), highMessages.at(-1));
});

test('Anthropic disabled thinking sends no effort markers', async () => {
  const model = anthropicModel(
    { supportsMidConvoEffort: true },
    { reasoning: true, thinkingLevelMap: { off: 'none' } },
  );
  const inherited: Message[] = [system('BASE'), user('TASK')];
  const payload = await capturePayload<AnthropicPayload>((onPayload) => streamAnthropic(
    model,
    context(inherited),
    {
      apiKey: 'offline-fixture',
      cacheRetention: 'none',
      fetch: offlineFetch,
      onPayload,
      thinkingEnabled: false,
      effort: 'low',
    },
  ));

  assert.deepEqual(record(payload.thinking), { type: 'disabled' });
  assert.equal(payload.output_config, undefined);
  assert.deepEqual(anthropicEffortMarkers(payload), []);
});

test('Chat Completions has no managed effort encoder and changes the top-level reasoning effort', async () => {
  const model = chatModel(
    { supportsReasoningEffort: true, thinkingFormat: 'openai' },
    { reasoning: true },
  );
  const inherited: Message[] = [system('BASE'), user('TASK')];
  const capture = (reasoningEffort: 'low' | 'high') => capturePayload<ChatPayload>((onPayload) => streamChatCompletions(
    model,
    context(inherited),
    { apiKey: 'offline-fixture', fetch: offlineFetch, onPayload, reasoningEffort },
  ));

  const low = await capture('low');
  const high = await capture('high');

  assert.equal(low.reasoning_effort, 'low');
  assert.equal(high.reasoning_effort, 'high');
  assert.doesNotMatch(JSON.stringify(low), /configuration_update/);
  assert.doesNotMatch(JSON.stringify(high), /configuration_update/);
  assert.deepEqual(low.messages, high.messages);
});
