/**
 * Offline contract regressions for description-only tool-declaration updates.
 *
 * These project real native transcripts through the description-update helper
 * and the existing tool-guidance journal, then serialize the result with the
 * real Responses and Chat Completions converters. No provider call is made: the
 * projection is a pure request transform, and the journal is a real
 * SessionManager branch that is reopened from disk for the resume cases.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  fauxProvider,
  InMemoryCredentialStore,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type OpenAICompletionsCompat,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { convertResponsesMessages } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js';
import { resolveTranscriptTools } from '../../node_modules/@earendil-works/pi-ai/dist/utils/transcript.js';
import { stream as streamCompletions } from '@earendil-works/pi-ai/api/openai-completions';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

import capabilityExtension from '../../src/capability/extension.ts';

import { TOOL_GUIDANCE_RECORD, projectRecordedToolGuidance, toolGuidanceSection } from '../../src/tool-guidance.ts';
import { additiveToolTranscript } from '../../src/session-transcript.ts';
import {
  TOOL_DESCRIPTION_BASELINE_RECORD,
  projectToolPromptUpdates,
  toolDescriptionGuidanceId,
  type ToolPromptMetadata,
} from '../../src/tool-prompt-updates.ts';
import type { TranscriptMessageLike } from '../../src/session-transcript.ts';

type UnknownRecord = Record<string, unknown>;

interface ToolDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

interface NativeMessage extends TranscriptMessageLike {
  readonly role: string;
  readonly content?: unknown;
  readonly sections?: Record<string, string | null>;
  readonly toolsAdded?: readonly ToolDeclaration[];
  readonly toolsRemoved?: readonly { readonly name: string }[];
  readonly timestamp: number;
}

const emptySchema = (): UnknownRecord => ({ type: 'object', properties: {} });

function declaration(name: string, description: string, parameters: unknown = emptySchema()): ToolDeclaration {
  return { name, description, parameters };
}

function system(
  toolsAdded: readonly ToolDeclaration[],
  toolsRemoved: readonly { readonly name: string }[] = [],
  timestamp = 0,
): NativeMessage {
  return {
    role: 'system',
    content: '',
    ...(toolsAdded.length === 0 ? {} : { toolsAdded }),
    ...(toolsRemoved.length === 0 ? {} : { toolsRemoved }),
    timestamp,
  };
}

function user(text: string, timestamp = 1): NativeMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp };
}

function append(manager: SessionManager, message: NativeMessage): void {
  manager.appendMessage(message as unknown as Message);
}

function record(value: unknown): UnknownRecord {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as UnknownRecord;
}

function managerWith(messages: readonly NativeMessage[]): SessionManager {
  const manager = SessionManager.inMemory('/test');
  for (const message of messages) append(manager, message);
  return manager;
}

function nativeMessages(manager: SessionManager): readonly NativeMessage[] {
  return manager.buildSessionProjection().messages as unknown as readonly NativeMessage[];
}

function latestBoundary(manager: SessionManager): string | null {
  const boundary = manager.getBranch().findLast(
    (entry) => entry.type === 'compaction' || entry.type === 'context_edit',
  );
  return boundary?.type === 'compaction' || boundary?.type === 'context_edit' ? boundary.id : null;
}

interface Projection {
  readonly messages: readonly unknown[];
  readonly guidance: readonly string[];
}

/** The full Main-side order: description updates, then the shared guidance journal. */
function project(
  manager: SessionManager,
  active: readonly string[],
  tools: readonly ToolPromptMetadata[] = [],
): Projection {
  const updates = projectToolPromptUpdates({
    messages: nativeMessages(manager),
    tools,
    active: new Set(active),
    branch: manager.getBranch(),
    appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); },
  });
  // Main always runs the shared guidance journal, even when this projection
  // currently supplies no source, so a withdrawal is replayed faithfully.
  const messages = projectRecordedToolGuidance(updates.messages, updates.guidance, {
    branch: manager.getBranch(),
    checkpointId: latestBoundary(manager),
    appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); },
  });
  return { messages, guidance: updates.guidance.map((entry) => entry.id) };
}

function sectionsOf(message: unknown): Record<string, string | null> {
  const sections = (message as { readonly sections?: unknown }).sections;
  return typeof sections === 'object' && sections !== null && !Array.isArray(sections)
    ? sections as Record<string, string | null>
    : {};
}

/** Guidance text actually projected for one tool, in request order. */
function descriptionTexts(messages: readonly unknown[], name: string): string[] {
  const section = toolGuidanceSection(toolDescriptionGuidanceId(name));
  return messages.flatMap((message) => {
    const text = sectionsOf(message)[section];
    return typeof text === 'string' ? [text] : [];
  });
}

function guidanceRecords(manager: SessionManager): UnknownRecord[] {
  return manager.getBranch().flatMap((entry) => entry.type === 'custom' && entry.customType === TOOL_GUIDANCE_RECORD
    ? [{ ...(entry.data as UnknownRecord) }]
    : []);
}

function baselineRecords(manager: SessionManager): UnknownRecord[] {
  return manager.getBranch().flatMap((entry) =>
    entry.type === 'custom' && entry.customType === TOOL_DESCRIPTION_BASELINE_RECORD
      ? [{ ...(entry.data as UnknownRecord) }]
      : []);
}

const responsesModel = {
  api: 'openai-codex-responses',
  compat: { supportsAdditionalTools: true, supportsMidConvoSystemMessages: true },
  provider: 'openai-codex',
  id: 'offline',
  reasoning: true,
  input: ['text'],
} as unknown as Model<'openai-codex-responses'>;

function wireWith(model: Model<Api>, messages: readonly unknown[]): readonly unknown[] {
  return convertResponsesMessages(
    model,
    { messages: messages as unknown as Message[] } as TranscriptContext,
    new Set([model.provider]),
    {
      includeSystemPrompt: true,
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools: true,
    },
  ) as unknown as readonly unknown[];
}

function responsesWire(messages: readonly unknown[]): readonly unknown[] {
  return wireWith(responsesModel, messages);
}

function wireTools(wire: readonly unknown[]): UnknownRecord[] {
  return wire.flatMap((item) => {
    const entry = record(item);
    if (entry['type'] !== 'additional_tools' || !Array.isArray(entry['tools'])) return [];
    return entry['tools'].map((tool) => record(tool));
  });
}

function wireTexts(wire: readonly unknown[]): string[] {
  return wire.flatMap((item) => {
    const entry = record(item);
    return typeof entry['content'] === 'string' ? [entry['content']] : [];
  });
}

function completionsModel(compat: OpenAICompletionsCompat): Model<'openai-completions'> {
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

interface ChatPayload {
  readonly messages: readonly UnknownRecord[];
  readonly tools?: readonly UnknownRecord[];
}

async function chatPayload(
  model: Model<'openai-completions'>,
  messages: readonly unknown[],
): Promise<ChatPayload> {
  let captured: ChatPayload | undefined;
  await streamCompletions(model, normalizeContext({ messages: messages as Message[] }), {
    apiKey: 'offline',
    fetch: async () => { throw new Error('Offline: network access is prohibited in tests'); },
    onPayload: (payload) => {
      captured = payload as unknown as ChatPayload;
      throw new Error('Payload captured');
    },
  }).result();
  assert.ok(captured, 'the request payload must be captured before the transport call');
  return captured;
}

test('Responses: a description-only redeclaration keeps the first declaration and becomes tail guidance', () => {
  const manager = managerWith([
    { ...system([declaration('read', 'Read files'), declaration('codemode', 'Inline tools A')]), content: 'base' },
    user('task', 1),
  ]);
  const first = project(manager, ['read', 'codemode']);
  const wireA = responsesWire(first.messages);
  assert.deepEqual(wireTools(wireA).map((tool) => [tool['name'], tool['description']]), [
    ['read', 'Read files'],
    ['codemode', 'Inline tools A'],
  ]);
  assert.deepEqual(descriptionTexts(first.messages, 'codemode'), []);

  // Pi records a changed definition as a removal plus an addition of the same name.
  append(manager, system([declaration('codemode', 'Inline tools B')], [{ name: 'codemode' }], 4));
  const second = project(manager, ['read', 'codemode']);
  const wireB = responsesWire(second.messages);

  assert.deepEqual(wireTools(wireB).map((tool) => tool['name']), ['read', 'codemode'],
    'the redundant re-declaration is not sent as a second tool item');
  assert.equal(wireTools(wireB).at(-1)?.['description'], 'Inline tools A',
    'the historical first declaration stays model-visible');
  assert.deepEqual(descriptionTexts(second.messages, 'codemode'), [
    'Updated description for tool codemode:\n\nInline tools B',
  ]);
  assert.match(wireTexts(wireB).join('\n'), /Updated description for tool codemode:\n\nInline tools B/);
  assert.deepEqual(wireB.slice(0, wireA.length), wireA,
    'the previous request is an exact serialized prefix of the new request');
  assert.equal(
    resolveTranscriptTools(second.messages as readonly { role: string }[], 'additions').foldedSystemMessages,
    1,
    'no transport has to fold its leading tool inventory',
  );

  // The removed-and-readded pair never reaches the wire as a removal notice.
  assert.doesNotMatch(wireTexts(wireB).join('\n'), /no longer available/);
});

test('Responses: A -> B -> C and revert keep every earlier placement and end on the reverted description', () => {
  const manager = managerWith([
    { ...system([declaration('codemode', 'Inline tools A')]), content: 'base' },
    user('task', 1),
  ]);
  const a = project(manager, ['codemode']);
  append(manager, system([declaration('codemode', 'Inline tools B')], [{ name: 'codemode' }], 4));
  const b = project(manager, ['codemode']);
  append(manager, user('second turn', 5));
  append(manager, system([declaration('codemode', 'Inline tools C')], [{ name: 'codemode' }], 6));
  const c = project(manager, ['codemode']);

  assert.deepEqual(descriptionTexts(b.messages, 'codemode'), ['Updated description for tool codemode:\n\nInline tools B']);
  assert.deepEqual(descriptionTexts(c.messages, 'codemode'), [
    'Updated description for tool codemode:\n\nInline tools B',
    'Updated description for tool codemode:\n\nInline tools C',
  ]);
  const wireC = responsesWire(c.messages);
  assert.deepEqual(wireTools(wireC).map((tool) => tool['description']), ['Inline tools A'],
    'only the first declaration is ever declared');
  assert.deepEqual(wireC.slice(0, responsesWire(b.messages).length), responsesWire(b.messages),
    'the B request prefix survives the C change');

  // Revert to A: the journal appends A again, because the model last read C.
  append(manager, user('third turn', 7));
  append(manager, system([declaration('codemode', 'Inline tools A')], [{ name: 'codemode' }], 8));
  const reverted = project(manager, ['codemode']);
  const texts = descriptionTexts(reverted.messages, 'codemode');
  assert.deepEqual(texts, [
    'Updated description for tool codemode:\n\nInline tools B',
    'Updated description for tool codemode:\n\nInline tools C',
    'Updated description for tool codemode:\n\nInline tools A',
  ]);
  assert.deepEqual(descriptionTexts(reverted.messages, 'codemode').at(-1),
    'Updated description for tool codemode:\n\nInline tools A');
  assert.deepEqual(responsesWire(reverted.messages).slice(0, responsesWire(c.messages).length),
    responsesWire(c.messages), 'the revert only appends');
  assert.deepEqual(guidanceRecords(manager).map((entry) => [entry['text'], entry['position']]), [
    ['Updated description for tool codemode:\n\nInline tools B', 2],
    ['Updated description for tool codemode:\n\nInline tools C', 4],
    ['Updated description for tool codemode:\n\nInline tools A', 6],
  ]);
});

test('a repeated request and a disk resume replay the same prefix without new records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tool-description-'));
  try {
    const manager = SessionManager.create('/test', dir);
    for (const message of [
      system([declaration('codemode', 'Inline tools A')]),
      user('task', 1),
      system([declaration('codemode', 'Inline tools B')], [{ name: 'codemode' }], 2),
    ]) manager.appendMessage(message as unknown as Message);

    const first = project(manager, ['codemode']);
    const native = nativeMessages(manager);
    assert.deepEqual(native.map((message) => message.toolsAdded?.length ?? 0), [1, 0, 1],
      'the stored transcript still records the redefinition');

    const repeat = project(manager, ['codemode']);
    assert.deepEqual(repeat.messages, first.messages, 'a stable repeat reproduces the request exactly');
    const records = guidanceRecords(manager).length;
    assert.equal(records, 1);

    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile, 'a conversation session must be persisted');
    const reopened = SessionManager.open(sessionFile, dir);
    const resumed = project(reopened, ['codemode']);
    assert.deepEqual(resumed.messages, first.messages, 'resume replays the recorded revision at its ordinal');
    assert.equal(guidanceRecords(reopened).length, records, 'resume writes no new record');

    // A resumed, appended turn already contains the new revision and adds C.
    reopened.appendMessage(user('later', 3) as unknown as Message);
    reopened.appendMessage(system([declaration('codemode', 'Inline tools C')], [{ name: 'codemode' }], 4) as unknown as Message);
    const extended = project(reopened, ['codemode']);
    assert.deepEqual(descriptionTexts(extended.messages, 'codemode').at(-1),
      'Updated description for tool codemode:\n\nInline tools C');
    assert.deepEqual(extended.messages.slice(0, first.messages.length), first.messages,
      'appended turns never move an earlier placement');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real schema change keeps its declaration and is allowed to rebase', () => {
  const oldSchema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const newSchema = { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] };
  const manager = managerWith([
    system([declaration('read', 'Read a path', oldSchema)]),
    user('task', 1),
  ]);
  project(manager, ['read']);
  append(manager, system([declaration('read', 'Read a URI', newSchema)], [{ name: 'read' }], 2));

  const projected = project(manager, ['read']);
  assert.deepEqual(projected.guidance, [], 'a schema change is not prose');
  assert.deepEqual(descriptionTexts(projected.messages, 'read'), []);
  assert.equal(projected.messages.length, nativeMessages(manager).length,
    'the declaration is neither stripped nor explained');

  const native = nativeMessages(manager);
  const additive = resolveTranscriptTools(native as readonly { role: string }[], 'additions');
  assert.equal(additive.foldedSystemMessages, 2, 'the native SDK rebases to express the new schema');
  assert.deepEqual(additive.requestTools.map((tool) => tool.name), ['read']);
  assert.deepEqual(record(additive.requestTools[0])['parameters'], newSchema);

  const wire = responsesWire(projected.messages);
  const readDeclarations = wireTools(wire).filter((tool) => tool['name'] === 'read');
  assert.equal(readDeclarations.length, 2, 'the replacement declaration reaches the request');
  assert.equal(readDeclarations.at(-1)?.['description'], 'Read a URI');
  assert.deepEqual(readDeclarations.at(-1)?.['parameters'], newSchema,
    'execution never validates arguments against the stale schema');
});

test('an inactive or excluded tool is never stripped, described or baselined', () => {
  const manager = managerWith([
    system([declaration('read', 'Read files'), declaration('codemode', 'Inline tools A')]),
    user('task', 1),
  ]);
  project(manager, ['read', 'codemode']);
  append(manager, system([declaration('codemode', 'Inline tools B')], [{ name: 'codemode' }], 2));

  const excluded = project(manager, ['read'], [{ name: 'codemode', description: 'Inline tools B' }]);
  assert.deepEqual(excluded.guidance, []);
  assert.deepEqual(descriptionTexts(excluded.messages, 'codemode'), []);
  const wire = responsesWire(excluded.messages);
  assert.deepEqual(wireTools(wire).map((tool) => [tool['name'], tool['description']]), [
    ['read', 'Read files'],
    ['codemode', 'Inline tools A'],
    ['codemode', 'Inline tools B'],
  ], 'an out-of-scope re-declaration stays a real delta');
  assert.deepEqual(baselineRecords(manager), [], 'no authority evidence is written for an excluded name');
});

test('Chat Completions additions keep the initial tool inventory and append the description as prose', async () => {
  const model = completionsModel({ supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true });
  const manager = managerWith([
    { ...system([declaration('read', 'Read files'), declaration('codemode', 'Inline tools A')]), content: 'Base instructions' },
    user('task', 1),
  ]);
  const first = project(manager, ['read', 'codemode']);
  const payloadA = await chatPayload(model, first.messages);
  assert.deepEqual(payloadA.tools?.map((tool) => record(tool['function'])['name']), ['read', 'codemode']);

  append(manager, system([declaration('codemode', 'Inline tools B')], [{ name: 'codemode' }], 2));
  const native = nativeMessages(manager);
  const second = project(manager, ['read', 'codemode']);
  const payloadB = await chatPayload(model, second.messages);

  assert.deepEqual(payloadB.tools?.map((tool) => record(tool['function'])['description']), [
    'Read files',
    'Inline tools A',
  ], 'the top-level inventory is the historical first declaration');
  assert.deepEqual(payloadB.messages.slice(0, payloadA.messages.length), payloadA.messages,
    'the cached Chat prefix is unchanged');
  assert.match(JSON.stringify(payloadB.messages), /Updated description for tool codemode:\\n\\nInline tools B/);
  assert.ok(payloadB.messages.every((message) => !('tools' in message)),
    'no in-message tool inventory item is emitted for a description-only change');

  // Without the projection the same transcript really does need a rebase.
  const raw = resolveTranscriptTools(native as readonly { role: string }[], 'additions');
  assert.equal(raw.foldedSystemMessages, 2);
});

test('an indirect Codemode tool keeps a hidden baseline, then revises and reverts it across resume', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tool-description-baseline-'));
  try {
    const manager = SessionManager.create('/test', dir);
    manager.appendMessage(system([declaration('read', 'Read files')]) as unknown as Message);
    manager.appendMessage(user('task', 1) as unknown as Message);
    const active = ['read', 'mcp__deferred'];
    const v1: ToolPromptMetadata[] = [
      { name: 'read', description: 'Read files' },
      { name: 'mcp__deferred', description: 'Deferred v1' },
    ];

    const first = project(manager, active, v1);
    assert.deepEqual(first.guidance, [], 'the first observation is a baseline, not a revision');
    assert.deepEqual(baselineRecords(manager), [
      { version: 1, name: 'mcp__deferred', description: 'Deferred v1' },
    ]);
    assert.deepEqual(nativeMessages(manager).map((message) => message.role), ['system', 'user'],
      'the baseline is branch-only and never a model-visible message');

    const repeat = project(manager, active, v1);
    assert.equal(baselineRecords(manager).length, 1, 'the baseline is written once');
    assert.deepEqual(repeat.messages, first.messages);

    const v2: ToolPromptMetadata[] = [
      { name: 'read', description: 'Read files' },
      { name: 'mcp__deferred', description: 'Deferred v2' },
    ];
    const second = project(manager, active, v2);
    assert.deepEqual(second.guidance, [`tool-description:mcp__deferred`]);
    assert.deepEqual(descriptionTexts(second.messages, 'mcp__deferred'), [
      'Updated description for tool mcp__deferred:\n\nDeferred v2',
    ]);
    assert.deepEqual(wireTools(responsesWire(second.messages)).map((tool) => tool['name']), ['read'],
      'an indirect tool gains no declaration');

    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    const reopened = SessionManager.open(sessionFile, dir);
    const resumed = project(reopened, active, v2);
    assert.deepEqual(resumed.messages, second.messages, 'resume replays the recorded revision');
    assert.equal(baselineRecords(reopened).length, 1);

    const reverted = project(reopened, active, v1);
    assert.deepEqual(descriptionTexts(reverted.messages, 'mcp__deferred'), [
      'Updated description for tool mcp__deferred:\n\nDeferred v2',
      'Updated description for tool mcp__deferred:\n\nDeferred v1',
    ], 'the journal appends the reverted description instead of dropping the section');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a baseline writer an indirect tool gets no invented revision', () => {
  const manager = managerWith([system([declaration('read', 'Read files')]), user('task', 1)]);
  const projected = projectToolPromptUpdates({
    messages: nativeMessages(manager),
    tools: [{ name: 'mcp__deferred', description: 'Deferred v2' }],
    active: new Set(['read', 'mcp__deferred']),
    branch: manager.getBranch(),
  });
  assert.deepEqual(projected.guidance, []);
  assert.deepEqual(baselineRecords(manager), []);
  assert.deepEqual(projected.messages, nativeMessages(manager));
});

test('a mixed message keeps its real declaration and only drops the description-only pair', () => {
  const head = system([declaration('codemode', 'Inline tools A')]);
  const mixed: NativeMessage = {
    role: 'system',
    content: 'Activating write',
    toolsAdded: [declaration('codemode', 'Inline tools B'), declaration('write', 'Write files')],
    toolsRemoved: [{ name: 'codemode' }],
    timestamp: 2,
  };
  const messages: NativeMessage[] = [head, user('task', 1), mixed];
  const update = projectToolPromptUpdates({
    messages,
    tools: [],
    active: new Set(['codemode', 'write']),
  });

  assert.equal(update.messages.length, messages.length, 'native message slots are preserved');
  assert.equal(update.messages[0], head, 'the first declaration keeps its object identity');
  assert.equal(update.messages[1], messages[1]);
  const projected = update.messages[2] as NativeMessage;
  assert.deepEqual(projected.toolsAdded?.map((tool) => [tool.name, tool.description]), [
    ['write', 'Write files'],
  ]);
  assert.equal(projected.toolsRemoved, undefined, 'the removal of the stripped name goes with it');
  assert.equal(projected.content, 'Activating write', 'a message keeps everything it also says');
  assert.deepEqual(update.guidance.map((entry) => entry.id), ['tool-description:codemode']);
});

test('a re-enabled tool is declared again instead of becoming prose', () => {
  const head = system([declaration('read', 'Read files')]);
  const messages: NativeMessage[] = [
    head,
    user('task', 1),
    system([], [{ name: 'read' }], 2),
    user('later', 3),
    system([declaration('read', 'Read files, now with URI support')], [], 4),
  ];
  const update = projectToolPromptUpdates({ messages, tools: [], active: new Set(['read']) });

  assert.equal(update.messages.length, messages.length);
  assert.deepEqual(update.guidance, [], 'a genuine re-add is never replaced by description prose');
  assert.equal(update.messages[2], messages[2], 'the removal stays a real removal');
  const last = update.messages[4] as NativeMessage;
  assert.deepEqual(last.toolsAdded?.map((tool) => tool.description), ['Read files, now with URI support']);
});

test('a description chain that ends where the model already reads stays prose-free', () => {
  const manager = managerWith([
    system([declaration('codemode', 'Inline tools A')]),
    user('task', 1),
    system([declaration('codemode', 'Inline tools B')], [{ name: 'codemode' }], 2),
    system([declaration('codemode', 'Inline tools A')], [{ name: 'codemode' }], 3),
  ]);
  const projected = project(manager, ['codemode']);

  assert.deepEqual(projected.guidance, [], 'B never became request-visible, so there is nothing to correct');
  assert.deepEqual(descriptionTexts(projected.messages, 'codemode'), []);
  assert.deepEqual(guidanceRecords(manager), []);
  assert.deepEqual(wireTools(responsesWire(projected.messages)).map((tool) => tool['description']), [
    'Inline tools A',
  ]);
});

const SDK_FIXTURE = 'fixture_tool_updates';

function fixtureTool(
  description: string,
  parameters: UnknownRecord = emptySchema(),
  promptGuidelines?: readonly string[],
) {
  return {
    name: SDK_FIXTURE,
    label: 'Fixture tool updates',
    description,
    defaultActive: true,
    ...(promptGuidelines === undefined ? {} : { promptGuidelines: [...promptGuidelines] }),
    parameters,
    execute: async () => ({ content: [{ type: 'text' as const, text: 'Executed' }], details: {} }),
  };
}

function textAnswer(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: 'text', text: 'Done' }],
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      totalTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
}

test('real SDK: a refreshed tool description updates prose once and a schema change still reaches the declaration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-tool-updates-sdk-'));
  let session: AgentSession | undefined;
  t.after(async () => {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: 'tool-updates-fixture' }] });
  const requests: Message[][] = [];
  faux.provider.streamSimple = (model, context) => {
    requests.push(structuredClone(context.messages));
    const message = textAnswer(model);
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end();
    return stream;
  };
  runtime.registerNativeProvider(faux.provider);
  const model = {
    ...faux.models[0]!,
    api: 'openai-responses',
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  } as Model<Api>;
  const settings = SettingsManager.inMemory({
    packages: [],
    extensions: [],
    retry: { enabled: false },
    cacheWarming: 'off',
    compaction: { enabled: false, keepRecentTokens: 0 },
  });
  const errors: unknown[] = [];
  let pi: ExtensionAPI | undefined;
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [{
      name: 'tool-updates-fixture',
      factory(api) {
        pi = api;
        capabilityExtension(api, { discovery: false });
        api.registerTool(fixtureTool('Fixture tool, first revision'));
      },
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  session = (await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    model,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
  })).session;
  await session.bindExtensions({ onError: (error) => { errors.push(error); } });

  const answer = async (text: string, index: number): Promise<readonly unknown[]> => {
    await session!.prompt(text);
    assert.equal(requests.length, index + 1, `one offline request for "${text}"`);
    return requests[index]!;
  };

  const first = await answer('first turn', 0);
  const firstWire = wireWith(model, first);
  assert.deepEqual(
    wireTools(firstWire).filter((tool) => tool['name'] === SDK_FIXTURE).map((tool) => tool['description']),
    ['Fixture tool, first revision'],
  );
  assert.deepEqual(descriptionTexts(first, SDK_FIXTURE), []);

  // Replace the same tool's description and promptGuidelines through the real
  // ExtensionAPI. The schema is untouched, so this is a description-only change.
  assert.ok(pi);
  pi.registerTool(fixtureTool('Fixture tool, second revision', emptySchema(), [
    'Use the fixture tool for offline acceptance only.',
  ]));
  const second = await answer('second turn', 1);
  const secondWire = wireWith(model, second);

  const stored = session.sessionManager.buildSessionProjection().messages as unknown as readonly NativeMessage[];
  const redefinitions = stored.filter((message) => message.role === 'system' &&
    (message.toolsAdded ?? []).some((tool) => tool.name === SDK_FIXTURE) &&
    (message.toolsRemoved ?? []).some((tool) => tool.name === SDK_FIXTURE));
  assert.equal(redefinitions.length, 1, 'the SDK records the refresh as a removal plus an addition');
  assert.equal(redefinitions[0]?.toolsAdded?.[0]?.description, 'Fixture tool, second revision');
  const request = second as readonly NativeMessage[];
  assert.deepEqual(request.filter((message) => (message.toolsRemoved ?? []).length > 0), [],
    'the paired removal of a description-only refresh never reaches the request');
  assert.equal(request.flatMap((message) => message.toolsAdded ?? [])
    .filter((tool) => tool.name === SDK_FIXTURE).length, 1,
  'only the historical declaration is requested');

  assert.deepEqual(secondWire.slice(0, firstWire.length), firstWire,
    'the previous request is an exact serialized prefix of the refreshed one');
  const declared = wireTools(secondWire).filter((tool) => tool['name'] === SDK_FIXTURE);
  assert.equal(declared.length, 1, 'a description refresh is not re-declared to the transport');
  assert.equal(declared[0]?.['description'], 'Fixture tool, first revision',
    'the historical first declaration stays model-visible');
  assert.deepEqual(descriptionTexts(second, SDK_FIXTURE), [
    'Updated description for tool fixture_tool_updates:\n\nFixture tool, second revision',
  ], 'exactly one current description update is projected');
  assert.equal(second.at(-1), second.findLast((message) =>
    sectionsOf(message)[toolGuidanceSection(toolDescriptionGuidanceId(SDK_FIXTURE))] !== undefined),
  'the update is the current request tail');
  assert.match(JSON.stringify(second), /Use the fixture tool for offline acceptance only\./,
    'the refreshed promptGuidelines reach the native system prompt');
  assert.equal(
    resolveTranscriptTools(second as readonly { role: string }[], 'additions').foldedSystemMessages,
    1,
    'an additions-only transport keeps its leading tool inventory',
  );

  // A real parameter change is not frozen: it keeps its declaration and reaches
  // the provider as the current interface.
  const changedSchema = {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  };
  pi.registerTool(fixtureTool('Fixture tool, second revision', changedSchema, [
    'Use the fixture tool for offline acceptance only.',
  ]));
  const third = await answer('third turn', 2);
  const thirdWire = wireWith(model, third);

  assert.deepEqual(thirdWire.slice(0, secondWire.length), secondWire,
    'the schema change only appends; the refreshed description request stays a prefix');
  const redeclared = wireTools(thirdWire).filter((tool) => tool['name'] === SDK_FIXTURE);
  assert.equal(redeclared.length, 2, 'the new interface is declared to the model, not noted as prose');
  assert.deepEqual(redeclared.at(-1)?.['parameters'], changedSchema,
    'the model never receives the frozen previous schema');
  assert.deepEqual(descriptionTexts(third, SDK_FIXTURE), [
    'Updated description for tool fixture_tool_updates:\n\nFixture tool, second revision',
  ], 'a schema change adds no description prose');
  assert.deepEqual(errors, []);
});

test('an emitted description revision stays sanitized while the tool is disabled and re-enabled', () => {
  const manager = managerWith([
    system([declaration('read', 'Read files'), declaration('codemode', 'Inline tools A')]),
    user('task', 1),
  ]);
  const all = ['read', 'codemode'];
  project(manager, all);

  append(manager, system([declaration('codemode', 'Inline tools B')], [{ name: 'codemode' }], 2));
  const emitted = project(manager, all);
  assert.deepEqual(descriptionTexts(emitted.messages, 'codemode'), [
    'Updated description for tool codemode:\n\nInline tools B',
  ]);
  const emittedWire = responsesWire(emitted.messages);
  assert.deepEqual(guidanceRecords(manager).map((entry) => entry['text']), [
    'Updated description for tool codemode:\n\nInline tools B',
  ]);

  // Disable the tool. Its old description-only re-declaration is still stored,
  // so the request must keep sanitizing it without publishing new prose.
  append(manager, system([], [{ name: 'codemode' }], 3));
  const stored = nativeMessages(manager);
  assert.deepEqual(stored.filter((message) => (message.toolsAdded ?? [])
    .some((tool) => tool.description === 'Inline tools B')).length, 1,
  'the historical re-declaration stays in the stored transcript');

  const disabled = project(manager, ['read']);
  assert.deepEqual((disabled.messages as readonly NativeMessage[]).flatMap((message) => message.toolsAdded ?? [])
    .filter((tool) => tool.name === 'codemode').map((tool) => tool.description), ['Inline tools A'],
  'only the historical first declaration is requested, inactive or not');
  assert.deepEqual((disabled.messages as readonly NativeMessage[]).flatMap((message) => message.toolsRemoved ?? [])
    .map((tool) => tool.name), ['codemode'], 'the real removal survives');
  assert.deepEqual(descriptionTexts(disabled.messages, 'codemode'), [
    'Updated description for tool codemode:\n\nInline tools B',
  ], 'no new prose for an inactive tool');
  const withdrawal = sectionsOf(disabled.messages.at(-1))[toolGuidanceSection(toolDescriptionGuidanceId('codemode'))];
  assert.equal(withdrawal, null, 'the recorded revision is withdrawn at the tail instead of staying current');
  // The harness announces an unavailable tool as soft text on additions-only
  // transports; the old re-declaration must still not become a tool delta.
  const softRemoval = additiveToolTranscript(disabled.messages as readonly TranscriptMessageLike[]);
  assert.equal(resolveTranscriptTools(softRemoval as readonly { role: string }[], 'additions').foldedSystemMessages, 1,
    'no additions-only transport has to rebase to replay the old re-declaration');
  assert.match(JSON.stringify(softRemoval), /Tool codemode is unavailable in this session/);
  const disabledWire = responsesWire(disabled.messages);
  assert.deepEqual(disabledWire.slice(0, emittedWire.length), emittedWire,
    'disabling only appends to the already model-visible prefix');

  const repeat = project(manager, ['read']);
  assert.deepEqual(repeat.messages, disabled.messages, 'a disabled tool stays stable across requests');
  assert.equal(guidanceRecords(manager).length, 2, 'the withdrawal is recorded once');

  // Re-enabling declares the tool natively again; no stale prose is restated.
  append(manager, system([declaration('codemode', 'Inline tools C')], [], 4));
  const reenabled = project(manager, all);
  assert.deepEqual((reenabled.messages as readonly NativeMessage[]).flatMap((message) => message.toolsAdded ?? [])
    .filter((tool) => tool.name === 'codemode').map((tool) => tool.description),
  ['Inline tools A', 'Inline tools C'], 'a re-enabled tool is a native real declaration');
  assert.deepEqual(descriptionTexts(reenabled.messages, 'codemode'), [
    'Updated description for tool codemode:\n\nInline tools B',
  ], 'the superseded revision is not restated');
  assert.equal(guidanceRecords(manager).length, 2, 're-enabling adds no prose record');
  assert.deepEqual(responsesWire(reenabled.messages).slice(0, disabledWire.length), disabledWire,
    're-enabling only appends its declaration');
});
