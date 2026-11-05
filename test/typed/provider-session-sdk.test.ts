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
import { stream as streamChatCompletions } from '@earendil-works/pi-ai/api/openai-completions';
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

function responsesModel(compat: OpenAIResponsesCompat): Model<'openai-responses'> {
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
  };
}

function anthropicModel(compat: AnthropicMessagesCompat): Model<'anthropic-messages'> {
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
  };
}

function chatModel(compat: OpenAICompletionsCompat): Model<'openai-completions'> {
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
}

interface AnthropicPayload {
  readonly system?: readonly unknown[];
  readonly messages?: readonly unknown[];
  readonly tools?: readonly unknown[];
  readonly betas?: readonly string[];
}

interface ChatPayload {
  readonly messages?: readonly unknown[];
  readonly tools?: readonly unknown[];
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
