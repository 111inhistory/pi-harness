/**
 * Incremental guidance must cover ALL Harness tool guidance, not only Subagent.
 *
 * Tool guidance is request-only state: neither the emitted `harness-guidance:*`
 * sections nor the emitted `<capabilities>` section enter the native transcript,
 * so a resumed request has to rebuild both. Rebuilding from branch discovery alone
 * moves the capability section whenever a discovery is hidden (compacted,
 * inherited, nested inside another tool call) and rewrites the leading system
 * prompt, which invalidates the whole cached provider prefix. Registered namespace
 * prose has no historical version evidence at all: it can only be delivered as a
 * tail append.
 *
 * `projectRecordedCapabilityPrompt` therefore keeps the emitted capability history
 * in one invisible `harness-capability-memory` journal (the shared prompt-section
 * engine) and replays it. The pure `capabilityPromptTranscript` stays the bootstrap
 * and the current desired state: the first journaled request equals it exactly, and
 * every later addition, live instruction change, scope change or removal is one
 * appended delta at a recorded fixed position. Live namespace prose from
 * `src/capability/tool-instructions.ts` is deduplicated only for namespaces whose
 * native guidance producer actually emitted a marker.
 *
 * These are offline contract tests: synthetic `SessionManager` branches plus the
 * real native Responses and Anthropic serializers. No network, no model inference,
 * no user prompts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { fauxProvider, normalizeContext } from '@earendil-works/pi-ai';
import type { Api, Message, Model } from '@earendil-works/pi-ai';
import { stream as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { SessionManager, createSyntheticSourceInfo, type ToolInfo } from '@earendil-works/pi-coding-agent';

import { convertResponsesMessages } from '../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js';
import { getCurrentSystemMessage } from '../../node_modules/@earendil-works/pi-ai/dist/utils/transcript.js';
import {
  CAPABILITY_SECTION,
  capabilityPromptTranscript,
  projectRecordedCapabilityPrompt,
  type ProjectionMessage,
} from '../../src/capability/prompt.ts';
import {
  appendDiscoveryRecord,
  type CapabilityHit,
  type CapabilitySearchCoverage,
} from '../../src/capability/discovery-record.ts';
import {
  projectedNamespaceRefs,
  registeredToolGuidance,
  toolNamespaceInstructions,
} from '../../src/capability/tool-instructions.ts';
import { projectRecordedToolGuidance, toolGuidanceSection, type ToolGuidance } from '../../src/tool-guidance.ts';
import type { TranscriptMessageLike } from '../../src/session-transcript.ts';
import { SUBAGENT_TOOL_GUIDANCE } from '../../src/subagent/tool-guidance.ts';

const CWD = '/tmp/project';

/** The journal type this projection owns; tests read it off the branch by name. */
const MEMORY_RECORD = 'harness-capability-memory';

const BROWSER_REF = 'namespace://browser';
const DOCS_REF = 'mcp://docs';

const coverage: CapabilitySearchCoverage = { local: 'searched', remote: 'not_searched' };

const browserGroup: CapabilityHit = {
  ref: BROWSER_REF,
  name: 'browser',
  instructions: 'Use the current tab',
  tools: [
    { ref: 'tool://pages', name: 'pages', description: 'List pages', exposure: 'deferred' },
    { ref: 'tool://click', name: 'click', description: 'Click a page', exposure: 'codemode' },
  ],
};

const docsGroup: CapabilityHit = {
  ref: DOCS_REF,
  name: 'docs',
  instructions: 'Read the docs',
  tools: [{ ref: 'mcp://docs/search', name: 'docs_search', description: 'Search the docs' }],
};

const slidesSkill: CapabilityHit = {
  ref: 'skill://slides',
  name: 'slides',
  description: 'Make slides',
  filePath: '/skills/slides/SKILL.md',
};

const pdfSkill: CapabilityHit = {
  ref: 'skill://pdf',
  name: 'pdf',
  description: 'Fill PDF forms',
  filePath: '/skills/pdf/SKILL.md',
};

type TranscriptInput = Parameters<typeof getCurrentSystemMessage>[0];

type DiscoveryHits = {
  readonly mcp?: readonly CapabilityHit[];
  readonly skills?: readonly CapabilityHit[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function appendHead(manager: SessionManager): void {
  manager.appendMessage({
    role: 'system',
    content: '',
    sections: { preamble: 'Unchanging base' },
    timestamp: 0,
  } as unknown as Message);
}

/** A native tool declaration, which is also the anchor of static guidance. */
function appendDeclaration(manager: SessionManager, ...names: string[]): void {
  manager.appendMessage({
    role: 'system',
    content: `anchor ${names.join(',')}`,
    toolsAdded: names.map((name) => ({ name, description: `${name} fixture`, parameters: { type: 'object', properties: {} } })),
    timestamp: 0,
  } as unknown as Message);
}

function appendUser(manager: SessionManager, text: string, timestamp: number): void {
  manager.appendMessage({ role: 'user', content: text, timestamp } as unknown as Message);
}

function appendAssistant(manager: SessionManager, text: string, timestamp: number): void {
  manager.appendMessage({
    role: 'assistant',
    api: 'openai-responses',
    provider: 'offline-responses',
    model: 'offline',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    timestamp,
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as unknown as Message);
}

/** One successful discovery on the branch, optionally without a visible result. */
function discover(manager: SessionManager, toolCallId: string | undefined, hits: DiscoveryHits = {}): void {
  const memory = appendDiscoveryRecord(
    { appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); } },
    toolCallId,
    {
      status: 'ok',
      tools: [],
      mcp: hits.mcp ?? [browserGroup],
      skills: hits.skills ?? [slidesSkill],
    },
    coverage,
  );
  assert.ok(memory, 'the offline fixture discovery must be stored');
}

/**
 * A discovery whose `capability` tool result is visible in the transcript, so the
 * pure projection anchors its update immediately after that result.
 */
function visibleDiscovery(
  manager: SessionManager,
  toolCallId: string,
  timestamp: number,
  hits: DiscoveryHits = {},
): void {
  discover(manager, toolCallId, hits);
  manager.appendMessage({
    role: 'toolResult',
    toolName: 'capability',
    toolCallId,
    content: [{ type: 'text', text: 'discovery' }],
    details: { status: 'ok' },
    timestamp,
  } as unknown as Message);
}

/** A registered namespace tool, as `getAllTools()` reports it. */
function toolFixture(
  name: string,
  options: { readonly namespace: string; readonly instructions?: string; readonly path?: string },
): ToolInfo {
  return {
    name,
    description: `${name} fixture`,
    parameters: { type: 'object', properties: {} },
    exposure: 'direct',
    namespace: {
      name: options.namespace,
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    },
    sourceInfo: createSyntheticSourceInfo(options.path ?? `<inline:${name}>`, { source: 'inline' }),
  };
}

interface ProjectOptions {
  readonly allowsTool?: (name: string) => boolean;
  readonly instructions?: ReadonlyMap<string, string | null>;
  readonly nativeGuidanceRefs?: ReadonlySet<string>;
  readonly checkpointId?: string | null;
}

function projectOptionSet(target: SessionManager, options: ProjectOptions) {
  return {
    checkpointId: options.checkpointId ?? null,
    appendEntry: (customType: string, data: unknown) => { target.appendCustomEntry(customType, data); },
    ...(options.allowsTool === undefined ? {} : { allowsTool: options.allowsTool }),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    ...(options.nativeGuidanceRefs === undefined ? {} : { nativeGuidanceRefs: options.nativeGuidanceRefs }),
  };
}

/**
 * The recorded projection over the manager's own native transcript. The `messages`
 * argument is native, before Capability adds anything, exactly like
 * `projectRecordedToolGuidance`.
 */
function project(target: SessionManager, options: ProjectOptions = {}): readonly ProjectionMessage[] {
  return projectRecordedCapabilityPrompt(
    target.buildSessionProjection().messages as unknown as readonly ProjectionMessage[],
    target.getBranch(),
    projectOptionSet(target, options),
  );
}

function nativeMessages(manager: SessionManager): readonly ProjectionMessage[] {
  return manager.buildSessionProjection().messages as unknown as readonly ProjectionMessage[];
}

/** Journal payloads on the branch, in append order. */
function memoryEntries(manager: SessionManager): Array<Record<string, unknown>> {
  return manager.getBranch().flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (entry['type'] !== 'custom' || entry['customType'] !== MEMORY_RECORD) return [];
    return isRecord(entry['data']) ? [entry['data']] : [];
  });
}

/** Emitted capability texts in request order; a metadata-only entry carries none. */
function recordedTexts(manager: SessionManager): unknown[] {
  return memoryEntries(manager).map((entry) => entry['text']).filter((text) => text !== null);
}

/** Section values for one native section name, in request order, including nulls. */
function sectionValues(messages: readonly ProjectionMessage[], name = CAPABILITY_SECTION): Array<string | null> {
  return messages.flatMap((message) => {
    const sections = message.sections;
    if (!isRecord(sections)) return [];
    const value = sections[name];
    return typeof value === 'string' || value === null ? [value] : [];
  });
}

/** Emitted section texts only; the journal may also replay inert `null` markers. */
function capabilityTexts(messages: readonly ProjectionMessage[], name = CAPABILITY_SECTION): string[] {
  return sectionValues(messages, name).flatMap((value) => (typeof value === 'string' ? [value] : []));
}

/** Emitted texts of one namespace guidance entry. */
function guidanceTexts(messages: readonly ProjectionMessage[], namespace: string): string[] {
  return capabilityTexts(messages, toolGuidanceSection(`namespace:${namespace}`));
}

/** Resources of the rendered capability section, in projection order. */
function renderedResources(text: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(text.split('\n')[2] ?? '[]');
  assert.ok(Array.isArray(parsed), 'the capability section carries one JSON resource array');
  return parsed.filter(isRecord);
}

function resource(text: string, ref: string): Record<string, unknown> {
  const found = renderedResources(text).find((hit) => hit['ref'] === ref);
  assert.ok(found, `expected ${ref} in the rendered capability section`);
  return found;
}

function memberNames(hit: Record<string, unknown>): Array<unknown> {
  const tools = hit['tools'];
  return Array.isArray(tools) ? tools.flatMap((tool) => (isRecord(tool) ? [tool['name']] : [])) : [];
}

function occurrences(text: string, needle: string): number {
  return needle === '' ? 0 : text.split(needle).length - 1;
}

/** Occurrences of a phrase anywhere in the projected section text. */
function sectionOccurrences(messages: readonly ProjectionMessage[], needle: string): number {
  const text = messages.flatMap((message) => {
    const sections = message.sections;
    return isRecord(sections) ? Object.values(sections).map((value) => value ?? '') : [];
  }).join('\n');
  return occurrences(text, needle);
}

/** Replayed current value: how the provider actually sees the head plus updates. */
function currentText(messages: readonly ProjectionMessage[]): string {
  return getCurrentSystemMessage(messages as unknown as TranscriptInput)?.sections?.[CAPABILITY_SECTION] ?? '';
}

/** Text merged into the leading native system message, if any. */
function headSectionText(messages: readonly ProjectionMessage[]): string {
  const value: unknown = messages[0]?.sections?.[CAPABILITY_SECTION];
  return typeof value === 'string' ? value : '';
}

function declaredTools(messages: readonly ProjectionMessage[]): unknown[] {
  return messages.flatMap((message) => message.toolsAdded ?? []);
}

function responsesWire(messages: readonly ProjectionMessage[]): readonly unknown[] {
  const model = {
    ...fauxProvider().getModel(),
    api: 'openai-responses',
    provider: 'offline-responses',
    id: 'offline',
  } as Model<Api>;
  return convertResponsesMessages(
    model,
    normalizeContext({ messages: messages as unknown as Message[] }),
    new Set([model.provider]),
    { includeSystemPrompt: true, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  ) as unknown as readonly unknown[];
}

interface AnthropicPayload {
  readonly system: unknown;
  readonly messages: readonly unknown[];
}

async function anthropicWire(messages: readonly ProjectionMessage[]): Promise<AnthropicPayload> {
  const model = {
    ...fauxProvider().getModel(),
    api: 'anthropic-messages',
    provider: 'offline-anthropic',
    id: 'offline',
    compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
  } as Model<'anthropic-messages'>;
  let captured: unknown;
  const stream = streamAnthropic(model, normalizeContext({ messages: messages as unknown as Message[] }), {
    apiKey: 'offline-fixture',
    cacheRetention: 'none',
    fetch: async () => { throw new Error('network access is forbidden in capability-guidance-journal.test.ts'); },
    onPayload: (payload) => {
      captured = payload;
      throw new Error('payload captured');
    },
  });
  const result = await stream.result();
  assert.equal(result.stopReason, 'error');
  assert.ok(isRecord(captured), 'the Anthropic serializer must produce a payload');
  return captured as unknown as AnthropicPayload;
}

function assertAnthropicPrefix(later: AnthropicPayload, earlier: AnthropicPayload, label: string): void {
  assert.deepEqual(later.system, earlier.system, label);
  assert.deepEqual(later.messages.slice(0, earlier.messages.length), earlier.messages, label);
}

interface PipelineResult {
  /** The request the provider receives after both guidance producers ran. */
  readonly messages: readonly ProjectionMessage[];
  /** Native guidance input messages, before the capability section. */
  readonly guided: readonly ProjectionMessage[];
  readonly guidance: readonly ToolGuidance[];
}

/**
 * The production request pipeline of `extensions/capability.ts`: live namespace
 * guidance from the registry, then the recorded capability memory with the refs
 * whose native producer actually emitted a marker.
 */
function pipeline(target: SessionManager, tools: readonly ToolInfo[], callable?: ReadonlySet<string>): PipelineResult {
  const native = nativeMessages(target);
  const branch = target.getBranch();
  const guidance = registeredToolGuidance(tools, SUBAGENT_TOOL_GUIDANCE,
    branch.some(entry => entry.type === 'custom' && entry.customType === MEMORY_RECORD), callable);
  const guided = projectRecordedToolGuidance(
    native as unknown as readonly TranscriptMessageLike[],
    guidance,
    {
      branch,
      checkpointId: null,
      appendEntry: (customType, data) => { target.appendCustomEntry(customType, data); },
    },
  ) as unknown as readonly ProjectionMessage[];
  const messages = projectRecordedCapabilityPrompt(guided, branch, {
    allowsTool: () => true,
    instructions: toolNamespaceInstructions(tools),
    nativeGuidanceRefs: projectedNamespaceRefs(guided as unknown as readonly TranscriptMessageLike[], guidance, tools),
    checkpointId: null,
    appendEntry: (customType, data) => { target.appendCustomEntry(customType, data); },
  });
  return { messages, guided, guidance };
}

test('the empty first request is recorded, and a later hidden discovery appends', async () => {
  const manager = SessionManager.inMemory(CWD);
  appendHead(manager);
  appendUser(manager, 'First question', 1);

  const first = project(manager);
  assert.deepEqual(first, nativeMessages(manager), 'no discovery yet: the request is unchanged');
  assert.equal(capabilityTexts(first).length, 0);

  const empty = memoryEntries(manager);
  assert.equal(empty.length, 1, 'the empty state is recorded so later guidance appends instead of retrying head placement');
  assert.equal(empty[0]?.['id'], CAPABILITY_SECTION);
  assert.equal(empty[0]?.['text'], null, 'metadata only: nothing was emitted');
  assert.equal(empty[0]?.['position'], 'head');

  const firstWire = responsesWire(first);
  const firstAnthropic = await anthropicWire(first);

  // A nested call keeps its record but shows no `capability` result to the model.
  discover(manager, 'nested-call');
  appendUser(manager, 'Second question', 3);
  const later = project(manager);

  assert.equal(capabilityTexts(later).length, 1, 'the hidden discovery appends one section');
  assert.match(capabilityTexts(later)[0] ?? '', /namespace:\/\/browser/);
  assert.equal(headSectionText(later), '', 'the section never enters the leading system head');
  assert.deepEqual(later.slice(0, first.length), first, 'every earlier native message is unchanged');
  assert.deepEqual(responsesWire(later).slice(0, firstWire.length), firstWire,
    'the earlier Responses prefix is byte-identical');
  const laterAnthropic = await anthropicWire(later);
  assert.deepEqual(laterAnthropic.system, firstAnthropic.system,
    'the Anthropic system prompt keeps the earlier text');
  assert.deepEqual(laterAnthropic.messages.slice(0, firstAnthropic.messages.length), firstAnthropic.messages,
    'the earlier Anthropic messages are byte-identical');
  assert.equal(declaredTools(later).length, 0, 'projection memory never declares an executable tool');

  const repeat = project(manager);
  assert.deepEqual(repeat, later, 'a repeated projection appends nothing');
  assert.equal(memoryEntries(manager).length, 2, 'one bootstrap record plus one appended update');
});

test('visible discovery placements on the first request match the pure projection', () => {
  const manager = SessionManager.inMemory(CWD);
  appendHead(manager);
  appendUser(manager, 'Question', 1);
  visibleDiscovery(manager, 'call-1', 2);
  appendUser(manager, 'Follow-up', 3);

  const native = nativeMessages(manager);
  const pure = capabilityPromptTranscript(native, manager.getBranch(), { allowsTool: () => true });
  const journaled = project(manager);
  assert.deepEqual(journaled, pure, 'the first journaled request is exactly the pure placement');

  const texts = capabilityTexts(journaled);
  assert.equal(texts.length, 1);
  const ordinal = journaled.findIndex((message) => typeof message.sections?.[CAPABILITY_SECTION] === 'string');
  assert.equal(ordinal, 3, 'the section follows the visible result at native ordinal 2');
  assert.equal(journaled[ordinal - 1]?.toolCallId, 'call-1');
  assert.deepEqual(memoryEntries(manager).map((entry) => ({
    text: entry['text'], position: entry['position'], checkpointId: entry['checkpointId'],
  })), [
    { text: null, position: 'head', checkpointId: null },
    { text: texts[0], position: 2, checkpointId: null },
  ], 'the metadata-only bootstrap and the emitted placement are both pinned');

  // Later visible discovery: the historical placement is replayed, not recomputed.
  visibleDiscovery(manager, 'call-2', 4, { mcp: [docsGroup], skills: [slidesSkill, pdfSkill] });
  appendUser(manager, 'Third question', 5);
  const later = project(manager);

  assert.deepEqual(later.slice(0, journaled.length), journaled, 'the earlier request is an exact prefix');
  const laterTexts = capabilityTexts(later);
  assert.equal(laterTexts.length, 2, 'the new discovery appends one update');
  assert.equal(laterTexts[0], texts[0], 'the historical section text is unchanged');
  assert.match(laterTexts[1] ?? '', /pdf/);
  assert.equal(later[ordinal]?.sections?.[CAPABILITY_SECTION], texts[0],
    'the recorded placement does not move when later messages arrive');
});

test('a live instruction change for one namespace appends a fixed-position update', () => {
  const manager = SessionManager.inMemory(CWD);
  appendHead(manager);
  appendUser(manager, 'Question', 1);
  visibleDiscovery(manager, 'call-1', 2);
  appendUser(manager, 'Follow-up', 3);

  const live = (text: string | null) => new Map<string, string | null>([[BROWSER_REF, text]]);
  const first = project(manager, { instructions: live('Use the current tab') });
  assert.equal(capabilityTexts(first).length, 1);
  assert.match(currentText(first), /Use the current tab/);

  const nativeBefore = nativeMessages(manager).length;
  const changed = project(manager, { instructions: live('Use the pinned tab') });

  assert.deepEqual(changed.slice(0, first.length), first, 'the historical prefix is unchanged');
  const texts = capabilityTexts(changed);
  assert.equal(texts.length, 2, 'one update is appended for the same discovery record');
  assert.equal(texts[0], capabilityTexts(first)[0], 'history keeps the recorded text');
  assert.match(texts[1] ?? '', /Use the pinned tab/);
  assert.doesNotMatch(texts[1] ?? '', /Use the current tab/);
  assert.equal(headSectionText(changed), '', 'the update never rewrites the leading head');

  const update = memoryEntries(manager).at(-1);
  assert.deepEqual({
    id: update?.['id'], text: update?.['text'], position: update?.['position'], checkpointId: update?.['checkpointId'],
  }, {
    id: CAPABILITY_SECTION, text: texts[1], position: nativeBefore - 1, checkpointId: null,
  }, 'the update is pinned to the fixed native ordinal it followed');

  const updateOrdinal = changed.findIndex(
    (message, index) => index >= first.length && typeof message.sections?.[CAPABILITY_SECTION] === 'string',
  );
  assert.equal(updateOrdinal, first.length, 'the update follows the last native message of that request');

  // Later native messages never move the recorded update.
  appendAssistant(manager, 'Answer', 4);
  appendUser(manager, 'Third question', 5);
  const stable = project(manager, { instructions: live('Use the pinned tab') });
  assert.deepEqual(stable.slice(0, changed.length), changed);
  const stableOrdinal = stable.findIndex(
    (message, index) => index >= first.length && typeof message.sections?.[CAPABILITY_SECTION] === 'string',
  );
  assert.equal(stableOrdinal, updateOrdinal, 'the fixed position survives later appends');
  assert.equal(memoryEntries(manager).length, 3, 'an unchanged desired state appends nothing');
  assert.match(currentText(stable), /Use the pinned tab/);
});

test('an instructions deletion and its restore are appended deltas', () => {
  const manager = SessionManager.inMemory(CWD);
  appendHead(manager);
  appendUser(manager, 'Question', 1);
  visibleDiscovery(manager, 'call-1', 2);
  appendUser(manager, 'Follow-up', 3);

  const live = (text: string | null) => new Map<string, string | null>([[BROWSER_REF, text]]);
  const withInstructions = project(manager, { instructions: live('Use the current tab') });
  const original = capabilityTexts(withInstructions)[0];
  assert.ok(original);

  const deleted = project(manager, { instructions: live(null) });
  const afterDeletion = capabilityTexts(deleted);
  assert.equal(afterDeletion.length, 2);
  const withdrawn = afterDeletion[1]!;
  assert.doesNotMatch(withdrawn, /Use the current tab/,
    'a null live value withdraws the namespace instructions from the desired state');
  assert.equal(resource(withdrawn, BROWSER_REF)['name'], 'browser', 'the discovered group itself survives');
  assert.ok(!resource(withdrawn, BROWSER_REF)['instructions'],
    'withdrawn prose renders falsy, never the stored text');
  assert.deepEqual(deleted.slice(0, withInstructions.length), withInstructions, 'the earlier request is untouched');

  const restored = project(manager, { instructions: live('Use the current tab') });
  const afterRestore = capabilityTexts(restored);
  assert.equal(afterRestore.length, 3, 'the restore is a new delta, not a rewrite');
  assert.equal(afterRestore[2], original, 'the restored text equals the first emission');
  assert.deepEqual(restored.slice(0, deleted.length), deleted, 'the deletion request is a prefix');

  assert.deepEqual(recordedTexts(manager), [original, withdrawn, original],
    'every emitted text stays in the journal');

  const repeat = project(manager, { instructions: live('Use the current tab') });
  assert.equal(memoryEntries(manager).length, 4, 'a repeated desired state appends nothing');
  assert.equal(capabilityTexts(repeat).length, 3);
  assert.match(currentText(repeat), /Use the current tab/);
});

test('a nested discovery appends instead of moving the section into the leading head', () => {
  const manager = SessionManager.inMemory(CWD);
  appendHead(manager);
  appendUser(manager, 'Question', 1);
  visibleDiscovery(manager, 'call-1', 2);
  appendUser(manager, 'Follow-up', 3);

  const first = project(manager);
  assert.equal(capabilityTexts(first).length, 1);
  const firstWire = responsesWire(first);

  // A nested call whose outer tool dropped the details: only the record survives.
  discover(manager, 'nested-call', { mcp: [browserGroup, docsGroup], skills: [slidesSkill, pdfSkill] });
  appendUser(manager, 'After the nested call', 5);
  const later = project(manager);

  const texts = capabilityTexts(later);
  assert.equal(texts.length, 2);
  assert.equal(texts[0], capabilityTexts(first)[0], 'the historical section is replayed verbatim');
  assert.match(texts[1] ?? '', /pdf/, 'the nested-only discovery appears in the appended update');
  assert.equal(headSectionText(later), '', 'the nested discovery is not folded into the leading head');
  assert.equal(later.at(-1)?.sections?.[CAPABILITY_SECTION], texts[1],
    'the update is the appended tail message');
  assert.deepEqual(later.slice(0, first.length), first, 'the earlier request is an exact prefix');
  assert.deepEqual(responsesWire(later).slice(0, firstWire.length), firstWire,
    'the old provider prefix is byte-identical');
});

test('resuming a SessionManager from its entries replays the exact recorded wire', async () => {
  const manager = SessionManager.inMemory(CWD);
  appendHead(manager);
  appendUser(manager, 'Question', 1);
  visibleDiscovery(manager, 'call-1', 2);
  appendUser(manager, 'Follow-up', 3);

  const first = project(manager, { instructions: new Map([[BROWSER_REF, 'Use the current tab']]) });
  const firstResponses = responsesWire(first);
  const firstAnthropic = await anthropicWire(first);

  appendAssistant(manager, 'Answer', 4);
  appendUser(manager, 'Third question', 5);
  const second = project(manager, { instructions: new Map([[BROWSER_REF, 'Use the pinned tab']]) });
  const secondResponses = responsesWire(second);
  const secondAnthropic = await anthropicWire(second);
  assert.deepEqual(secondResponses.slice(0, firstResponses.length), firstResponses,
    'the update appends after the earlier request');
  assertAnthropicPrefix(secondAnthropic, firstAnthropic, 'the Anthropic prefix is unchanged');

  const restored = SessionManager.inMemory(CWD, {}, [manager.getHeader()!, ...manager.getEntries()]);
  assert.equal(restored.getBranch().length, manager.getBranch().length, 'resume keeps every branch entry');

  const resumed = project(restored, { instructions: new Map([[BROWSER_REF, 'Use the pinned tab']]) });
  assert.deepEqual(resumed, second, 'the recorded placements replay message-identically');
  assert.deepEqual(responsesWire(resumed), secondResponses, 'the Responses wire is byte-identical after resume');
  assert.deepEqual(await anthropicWire(resumed), secondAnthropic,
    'the Anthropic wire is byte-identical after resume');
  assert.equal(memoryEntries(restored).length, memoryEntries(manager).length,
    'resume appends nothing to the journal');
});

test('a narrowed tool scope drops a denied member without granting execution', () => {
  const manager = SessionManager.inMemory(CWD);
  appendHead(manager);
  appendUser(manager, 'Question', 1);
  visibleDiscovery(manager, 'call-1', 2);
  appendUser(manager, 'Follow-up', 3);

  const generous = project(manager, { allowsTool: () => true });
  const full = capabilityTexts(generous)[0]!;
  assert.deepEqual(memberNames(resource(full, BROWSER_REF)), ['pages', 'click']);

  const narrow = project(manager, { allowsTool: (name) => name !== 'click' });
  const texts = capabilityTexts(narrow);
  assert.equal(texts.length, 2, 'the unavailable member is one appended delta');
  assert.deepEqual(memberNames(resource(texts[1]!, BROWSER_REF)), ['pages'],
    'the denied member is absent from the current desired state');
  assert.equal(resource(texts[1]!, BROWSER_REF)['name'], 'browser', 'the group itself survives the member filter');
  assert.deepEqual(narrow.slice(0, generous.length), generous,
    'the historical authorization is not rewritten');

  assert.equal(declaredTools(narrow).length, 0, 'memory never declares the tool, so no execution is authorized');

  const repeat = project(manager, { allowsTool: (name) => name !== 'click' });
  assert.equal(memoryEntries(manager).length, 3, 'an unchanged scope appends nothing');
  assert.equal(capabilityTexts(repeat).length, 2);

  const widened = project(manager, { allowsTool: () => true });
  const restored = capabilityTexts(widened);
  assert.equal(restored.length, 3, 'restoring availability is another appended delta');
  assert.equal(restored[2], full, 'the restored desired state equals the first emission');
  assert.deepEqual(memberNames(resource(currentText(widened), BROWSER_REF)), ['pages', 'click']);
});

test('a new context checkpoint rebases recorded placements into the leading boundary', () => {
  const manager = SessionManager.inMemory(CWD);
  appendHead(manager);
  appendUser(manager, 'Question', 1);
  visibleDiscovery(manager, 'call-1', 2);
  appendUser(manager, 'Follow-up', 3);

  const before = project(manager);
  const text = capabilityTexts(before)[0];
  assert.ok(text);
  const recordedBefore = memoryEntries(manager);
  assert.equal(recordedBefore.length, 2);
  assert.equal(recordedBefore[0]?.['checkpointId'], null);
  assert.equal(recordedBefore[1]?.['checkpointId'], null);

  // Compaction or an explicit context edit rebuilds the native prefix; the request
  // the caller projects is the new, shorter native transcript.
  const compacted: readonly ProjectionMessage[] = [
    { role: 'system', content: '', sections: { preamble: 'Unchanging base' }, timestamp: 0 },
    { role: 'user', content: 'Summary of the compacted conversation', timestamp: 10 },
  ];
  const write = (customType: string, data: unknown) => { manager.appendCustomEntry(customType, data); };
  const rebased = projectRecordedCapabilityPrompt(compacted, manager.getBranch(), {
    checkpointId: 'compact-1',
    appendEntry: write,
  });

  assert.equal(rebased.length, 2, 'the recorded section is rebased into the rebuilt leading boundary');
  assert.equal(headSectionText(rebased), text, 'the latest recorded text is pinned at the head');
  const afterRebase = memoryEntries(manager);
  assert.equal(afterRebase.length, recordedBefore.length + 1);
  assert.deepEqual({
    id: afterRebase.at(-1)?.['id'],
    text: afterRebase.at(-1)?.['text'],
    position: afterRebase.at(-1)?.['position'],
    checkpointId: afterRebase.at(-1)?.['checkpointId'],
  }, { id: CAPABILITY_SECTION, text, position: 'head', checkpointId: 'compact-1' },
  'the rebased placement is pinned to the new checkpoint');

  const stable = projectRecordedCapabilityPrompt(compacted, manager.getBranch(), {
    checkpointId: 'compact-1',
    appendEntry: write,
  });
  assert.deepEqual(stable, rebased, 'the same checkpoint replays the same head');
  assert.equal(memoryEntries(manager).length, afterRebase.length, 'no repeated rebase record');

  // A change after the boundary appends above the new head instead of rewriting it.
  const continued: readonly ProjectionMessage[] = [
    ...compacted,
    { role: 'user', content: 'After compaction', timestamp: 11 },
  ];
  const changed = projectRecordedCapabilityPrompt(continued, manager.getBranch(), {
    checkpointId: 'compact-1',
    instructions: new Map<string, string | null>([[BROWSER_REF, 'Use the pinned tab']]),
    appendEntry: write,
  });
  assert.equal(changed.length, continued.length + 1, 'the change is one appended delta');
  assert.equal(headSectionText(changed), text, 'the rebased head text is never rewritten');
  const texts = capabilityTexts(changed);
  assert.equal(texts.length, 2);
  assert.match(texts[1] ?? '', /Use the pinned tab/);
  assert.equal(memoryEntries(manager).at(-1)?.['position'], continued.length - 1,
    'the post-boundary update is pinned after the last native message');
});

test('the first request keeps the stored prose and appends the live revision', () => {
  const manager = SessionManager.inMemory(CWD);
  appendHead(manager);
  appendUser(manager, 'Question', 1);
  visibleDiscovery(manager, 'call-1', 2);
  appendUser(manager, 'Follow-up', 3);

  const first = project(manager, { instructions: new Map([[BROWSER_REF, 'Use the pinned tab']]) });
  const texts = capabilityTexts(first);
  assert.equal(texts.length, 2, 'the immutable stored history and the live revision are both emitted');
  assert.equal(resource(texts[0]!, BROWSER_REF)['instructions'], 'Use the current tab',
    'the bootstrap history keeps the stored, non-live prose');
  assert.equal(resource(texts[1]!, BROWSER_REF)['instructions'], 'Use the pinned tab',
    'the live revision is appended as the current desired state');
  assert.match(currentText(first), /Use the pinned tab/);

  const pure = capabilityPromptTranscript(nativeMessages(manager), manager.getBranch(), { allowsTool: () => true });
  assert.equal(capabilityTexts(pure)[0], texts[0], 'the stored placement is the pure bootstrap');
  assert.equal(first[3]?.sections?.[CAPABILITY_SECTION], texts[0], 'and keeps its native ordinal');
  assert.equal(first.at(-1)?.sections?.[CAPABILITY_SECTION], texts[1], 'the live revision is the appended tail');

  const recorded = memoryEntries(manager);
  assert.deepEqual(recorded.map((entry) => ({ text: entry['text'], position: entry['position'] })), [
    { text: null, position: 'head' },
    { text: texts[0], position: 2 },
    { text: texts[1], position: 3 },
  ], 'stored history and live revision are separately pinned');

  const repeat = project(manager, { instructions: new Map([[BROWSER_REF, 'Use the pinned tab']]) });
  assert.deepEqual(repeat, first, 'an unchanged live revision appends nothing');
  assert.equal(memoryEntries(manager).length, 3);
});

test('declaration-only browser namespace guidance appends A then B without capability duplication', async () => {
  const manager = SessionManager.inMemory(CWD);
  appendDeclaration(manager, 'browser_open');
  appendUser(manager, 'Question', 1);

  const browser = (instructions: string) => toolFixture('browser_open', { namespace: 'browser', instructions });
  const firstTools = [browser('Use the current tab')];
  const first = pipeline(manager, firstTools);

  const entry = first.guidance.find((candidate) => candidate.namespace === 'browser');
  assert.equal(entry?.initialPlacement, 'tail', 'live registry prose has no historical anchor');
  assert.deepEqual(entry?.tools, ['browser_open']);
  assert.deepEqual(guidanceTexts(first.messages, 'browser'), ['Use the current tab']);
  assert.deepEqual(capabilityTexts(first.messages), [],
    'a declaration-only namespace adds no capability memory section');
  assert.deepEqual([...projectedNamespaceRefs(
    first.guided as unknown as readonly TranscriptMessageLike[], first.guidance, firstTools,
  )], [BROWSER_REF], 'the emitted marker names the browser namespace');
  assert.equal(declaredTools(first.messages).length, 1, 'the declaration is native, not projected memory');

  const firstResponses = responsesWire(first.messages);
  const firstAnthropic = await anthropicWire(first.messages);

  appendAssistant(manager, 'Answer', 2);
  appendUser(manager, 'Follow-up', 3);
  const secondTools = [browser('Use the pinned tab')];
  const second = pipeline(manager, secondTools);

  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages,
    'the first guidance placement is unchanged');
  assert.deepEqual(guidanceTexts(second.messages, 'browser'), ['Use the current tab', 'Use the pinned tab'],
    'the live revision is one appended tail delta');
  assert.deepEqual(capabilityTexts(second.messages), [],
    'the capability section never repeats namespace prose');

  const secondResponses = responsesWire(second.messages);
  const secondAnthropic = await anthropicWire(second.messages);
  assert.deepEqual(secondResponses.slice(0, firstResponses.length), firstResponses,
    'the Responses prefix is byte-identical');
  assertAnthropicPrefix(secondAnthropic, firstAnthropic, 'the Anthropic prefix is byte-identical');

  const restored = SessionManager.inMemory(CWD, {}, [manager.getHeader()!, ...manager.getEntries()]);
  const resumed = pipeline(restored, secondTools);
  assert.deepEqual(resumed.messages, second.messages, 'resume replays both recorded guidance placements');
  assert.deepEqual(responsesWire(resumed.messages), secondResponses,
    'the Responses wire is byte-identical after resume');
  assert.deepEqual(await anthropicWire(resumed.messages), secondAnthropic,
    'the Anthropic wire is byte-identical after resume');
  assert.equal(sectionOccurrences(resumed.messages, 'Use the current tab'), 1);
  assert.equal(sectionOccurrences(resumed.messages, 'Use the pinned tab'), 1);
});

test('an MCP namespace alias resolves through the broker identity for dedup', () => {
  const manager = SessionManager.inMemory(CWD);
  appendDeclaration(manager, 'mcp__alias__search', 'mcp__alias__fetch');
  appendUser(manager, 'Question', 1);
  const tools = [
    toolFixture('mcp__alias__search', {
      namespace: 'mcp__alias', instructions: 'Read the docs', path: 'mcp:actual-server',
    }),
    toolFixture('mcp__alias__fetch', {
      namespace: 'mcp__alias', instructions: 'Read the docs', path: 'mcp:actual-server',
    }),
  ];
  discover(manager, undefined, {
    mcp: [{
      ref: 'mcp://actual-server',
      name: 'actual-server',
      instructions: 'Read the docs',
      tools: [{ ref: 'mcp://actual-server/search', name: 'mcp__alias__search' }],
    }],
    skills: [],
  });

  const instructions = toolNamespaceInstructions(tools);
  assert.deepEqual([...instructions.keys()].sort(), ['mcp://actual-server', 'namespace://mcp__alias'],
    'the source-path server identity and the registered namespace both resolve');
  assert.equal(instructions.get('namespace://mcp__alias'), 'Read the docs');
  assert.equal(instructions.get('mcp://actual-server'), 'Read the docs');

  const result = pipeline(manager, tools);
  const entry = result.guidance.find((candidate) => candidate.namespace === 'mcp__alias');
  assert.deepEqual(entry?.tools, ['mcp__alias__search', 'mcp__alias__fetch'],
    'one guidance entry per emitted namespace identity, not per tool');
  assert.deepEqual([...projectedNamespaceRefs(
    result.guided as unknown as readonly TranscriptMessageLike[], result.guidance, tools,
  )].sort(), ['mcp://actual-server', 'namespace://mcp__alias'],
  'the emitted MCP marker resolves to the same refs as the live map');

  assert.deepEqual(guidanceTexts(result.messages, 'mcp__alias'), ['Read the docs']);
  const sections = capabilityTexts(result.messages);
  assert.equal(sections.length, 1);
  assert.ok(!resource(sections[0]!, 'mcp://actual-server')['instructions'],
    'the discovered MCP group does not repeat prose the native producer emitted');
  assert.equal(resource(sections[0]!, 'mcp://actual-server')['name'], 'actual-server');
  assert.equal(sectionOccurrences(result.messages, 'Read the docs'), 1,
    'the shared prose appears exactly once in the request');
});

test('a hidden declaration without a native marker keeps namespace prose in capability memory', () => {
  const manager = SessionManager.inMemory(CWD);
  appendHead(manager);
  appendUser(manager, 'Question', 1);
  const tools = [toolFixture('browser_open', { namespace: 'browser', instructions: 'Use the current tab' })];
  // Without a declaration or reported callable scope, the producer has no
  // exposure evidence; discovery memory must retain the shared prose.
  discover(manager, 'hidden-call', { mcp: [browserGroup], skills: [] });

  const result = pipeline(manager, tools);
  assert.equal(projectedNamespaceRefs(
    result.guided as unknown as readonly TranscriptMessageLike[], result.guidance, tools,
  ).size, 0, 'no native producer emitted the namespace prose');
  assert.deepEqual(guidanceTexts(result.messages, 'browser'), [],
    'the declaration-only guidance has no anchor either');
  const sections = capabilityTexts(result.messages);
  assert.equal(sections.length, 1);
  assert.equal(resource(sections[0]!, BROWSER_REF)['instructions'], 'Use the current tab',
    'unemitted native prose stays in capability memory instead of being lost');
  assert.equal(sectionOccurrences(result.messages, 'Use the current tab'), 1);
});

test('a directly enabled namespace remains guided through Codemode without direct declarations', async () => {
  const manager = SessionManager.inMemory(CWD);
  appendDeclaration(manager, 'codemode');
  appendUser(manager, 'Question', 1);
  const callable = new Set(['browser_open']);
  const tools = (instructions: string) => [toolFixture('browser_open', { namespace: 'browser', instructions })];
  const first = pipeline(manager, tools('Use the current tab'), callable);
  assert.deepEqual(guidanceTexts(first.messages, 'browser'), ['Use the current tab']);
  assert.deepEqual(declaredTools(first.messages), declaredTools(nativeMessages(manager)));
  assert.equal(declaredTools(first.messages).length, 1, 'only Codemode is declared');
  assert.deepEqual(capabilityTexts(first.messages), [], 'direct enablement needs no discovery record');
  const firstResponses = responsesWire(first.messages);
  const firstAnthropic = await anthropicWire(first.messages);
  appendAssistant(manager, 'Answer', 2);
  appendUser(manager, 'Follow-up', 3);
  const second = pipeline(manager, tools('Use the pinned tab'), callable);
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.deepEqual(guidanceTexts(second.messages, 'browser'), ['Use the current tab', 'Use the pinned tab']);
  assert.deepEqual(declaredTools(second.messages), declaredTools(nativeMessages(manager)));
  assert.deepEqual(responsesWire(second.messages).slice(0, firstResponses.length), firstResponses);
  assertAnthropicPrefix(await anthropicWire(second.messages), firstAnthropic, 'Codemode-only prefix');
});

test('asset bootstrap cannot insert before an already frozen Capability projection', () => {
  const manager = SessionManager.inMemory(CWD);
  appendDeclaration(manager, 'subagent_list');
  appendUser(manager, 'Question', 1);
  const first = project(manager);
  appendAssistant(manager, 'Answer', 2);
  appendUser(manager, 'Follow-up', 3);
  const tools = [toolFixture('subagent_list', { namespace: 'subagent', instructions: 'Asset guidance' })];
  const second = pipeline(manager, tools, new Set(['subagent_list']));
  assert.deepEqual(second.messages.slice(0, first.length), first,
    'the upstream producer leaves the downstream projection and all its neighbors fixed');
  assert.ok(second.messages.length > nativeMessages(manager).length, 'new asset guidance is introduced');
  assert.equal(second.messages.at(-1)?.role, 'system', 'the introduction belongs at the current tail');
});
