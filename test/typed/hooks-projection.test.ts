import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  buildHookClassifierSlice,
  type HookClassifierInclude,
  type HookClassifierSlice,
  type HookClassifierSources,
  type HookClassifierSubject,
  type HookClassifierToolFact,
} from '../../src/hooks/projection.ts';

const timestamp = '2026-01-01T00:00:00.000Z';

function slice(
  subject: HookClassifierSubject,
  include: readonly HookClassifierInclude[],
  sources: HookClassifierSources = {},
): HookClassifierSlice {
  return buildHookClassifierSlice(subject, include, sources) as unknown as HookClassifierSlice;
}

function userEntry(id: string, text: string): SessionEntry {
  return {
    type: 'message', id, parentId: null, timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as SessionEntry;
}

function customEntry(id: string, customType: string, text: string): SessionEntry {
  return {
    type: 'custom_message', id, parentId: null, timestamp,
    customType, content: text, display: true,
  } as unknown as SessionEntry;
}

function compactionEntry(id: string): SessionEntry {
  return {
    type: 'compaction', id, parentId: null, timestamp,
    summary: 'older context', firstKeptEntryId: id, tokensBefore: 10,
  } as unknown as SessionEntry;
}

function toolFact(
  name: string,
  inputPreview?: string,
  overrides: Partial<HookClassifierToolFact> = {},
): HookClassifierToolFact {
  return {
    toolName: name, status: 'ok', isError: false, isNested: false, source: 'live',
    ...(inputPreview === undefined ? {} : { inputPreview }),
    ...overrides,
  };
}

test('default state carries subject facts only and never reads bodies', () => {
  let reads = 0;
  const sources: HookClassifierSources = {
    get prompt() { reads += 1; return 'PROMPT_BODY'; },
    get result() { reads += 1; return 'RESULT_BODY'; },
    branch: () => { reads += 1; return [userEntry('u1', 'RECENT_BODY')]; },
    recentTools: () => { reads += 1; return [toolFact('read', 'PREVIEW_BODY')]; },
    toolDirectory: () => { reads += 1; return { active: [], activatable: [] }; },
  };
  const state = slice({
    trigger: 'tool_result',
    model: { provider: 'fake-provider', id: 'fake-model' },
    preset: 'fast',
    tool: 'read',
    nested: false,
    result: { isError: false, truncated: true, status: 'error', errorKind: 'script', outputChars: 42 },
    turn: { modelCalls: 2, toolCalls: 3, nestedToolCalls: 1, toolErrors: 1 },
  }, [], sources);

  assert.equal(reads, 0, 'unrequested sources stay lazy');
  assert.deepEqual(state, {
    subject: {
      trigger: 'tool_result',
      model: { provider: 'fake-provider', id: 'fake-model' },
      preset: 'fast',
      tool: 'read',
      nested: false,
      result: { isError: false, truncated: true, status: 'error', errorKind: 'script', outputChars: 42 },
      turn: { modelCalls: 2, toolCalls: 3, nestedToolCalls: 1, toolErrors: 1 },
    },
  });
  assert.doesNotMatch(JSON.stringify(state), /BODY/);
});

test('prompt and result bodies clip to 2 KiB with head and tail retention', () => {
  const prompt = `PROMPT_HEAD\n${'"\\\n'.repeat(2000)}PROMPT_TAIL`;
  const result = `RESULT_HEAD\n${'x'.repeat(3000)}\nRESULT_TAIL`;
  const state = slice({ trigger: 'before_agent_start' }, ['prompt', 'result'], { prompt, result });

  assert.ok(state.prompt);
  assert.ok(state.result);
  assert.ok(Buffer.byteLength(state.prompt.text, 'utf8') <= 2048);
  assert.equal(state.prompt.clipped, true);
  assert.match(state.prompt.text, /^PROMPT_HEAD/);
  assert.ok(Buffer.byteLength(state.result.text, 'utf8') <= 2048);
  assert.equal(state.result.clipped, true);
  assert.match(state.result.text, /RESULT_TAIL$/);

  const small = slice({ trigger: 'before_agent_start' }, ['prompt', 'result'], { prompt: 'short', result: 'ok' });
  assert.deepEqual(small.prompt, { text: 'short' });
  assert.deepEqual(small.result, { text: 'ok' });

  const producerClipped = slice({ trigger: 'before_agent_start' }, ['prompt', 'result'], {
    prompt: 'already cut', promptClipped: true, result: 'already cut', resultClipped: true,
  });
  assert.deepEqual(producerClipped.prompt, { text: 'already cut', clipped: true });
  assert.deepEqual(producerClipped.result, { text: 'already cut', clipped: true });
});

test('recentInputs keeps the last three user and agent-delivery entries after compaction', () => {
  let branchReads = 0;
  const branch = [
    userEntry('u0', 'BEFORE_COMPACTION'),
    compactionEntry('c1'),
    userEntry('u1', 'first'),
    userEntry('u2', 'second'),
    customEntry('d1', 'agent-delivery', 'peer message'),
    customEntry('h1', 'hook-hint', 'HOOK_HINT_BODY'),
    customEntry('x1', 'capability-sync', 'SYNC_BODY'),
    userEntry('u3', 'third'),
    userEntry('u4', `fourth ${'z'.repeat(1500)}`),
  ];
  const state = slice({ trigger: 'before_agent_start' }, ['recentInputs'], {
    branch: () => { branchReads += 1; return branch; },
  });

  assert.equal(branchReads, 1, 'the branch source is lazy and read once');
  assert.ok(state.recentInputs);
  assert.equal(state.recentInputs.clipped, true, 'older eligible inputs are omitted');
  assert.deepEqual(state.recentInputs.items.map(item => item.role), ['agent-delivery', 'user', 'user']);
  assert.deepEqual(state.recentInputs.items.map(item => item.text.slice(0, 5)), ['peer ', 'third', 'fourt']);
  assert.equal(state.recentInputs.items[0]?.clipped, undefined);
  assert.equal(state.recentInputs.items[1]?.clipped, undefined);
  assert.equal(state.recentInputs.items[2]?.clipped, true);
  assert.ok(Buffer.byteLength(state.recentInputs.items[2]!.text, 'utf8') <= 1024);
  assert.doesNotMatch(JSON.stringify(state), /BEFORE_COMPACTION|HOOK_HINT_BODY|SYNC_BODY/);
});

test('recentTools keeps six metadata facts and only opt-in allowlisted input previews', () => {
  let reads = 0;
  const facts: HookClassifierToolFact[] = [
    toolFact('old-1'),
    toolFact('old-2'),
    toolFact('bash', 'BASH_SECRET'),
    toolFact('read', 'read-preview'),
    toolFact('codemode', 'CODEMODE_SECRET'),
    toolFact('mcp__server__tool', 'MCP_SECRET'),
    toolFact('powershell', 'POWERSHELL_SECRET'),
    toolFact('read', 'r'.repeat(300), { isNested: true, durationMs: 12, source: 'branch' }),
  ];
  // Extra adapter fields must never enter classifier state.
  const withExtras = facts.map(fact => ({ ...fact, content: 'OUTPUT_BODY', errorPreview: 'ERROR_BODY' }));
  const source = () => { reads += 1; return withExtras; };

  const metadataOnly = slice({ trigger: 'tool_result' }, ['recentTools'], { recentTools: source });
  assert.equal(reads, 1);
  assert.ok(metadataOnly.recentTools);
  assert.equal(metadataOnly.recentTools.clipped, true);
  assert.deepEqual(metadataOnly.recentTools.items.map(item => item.name),
    ['bash', 'read', 'codemode', 'mcp__server__tool', 'powershell', 'read']);
  assert.ok(metadataOnly.recentTools.items.every(item => item.inputPreview === undefined));
  assert.doesNotMatch(JSON.stringify(metadataOnly), /OUTPUT_BODY|ERROR_BODY/);

  const withPreviews = slice({ trigger: 'tool_result' }, ['recentToolPreviews'], { recentTools: source });
  assert.ok(withPreviews.recentTools, 'previews imply recent tool metadata');
  const previews = withPreviews.recentTools.items;
  assert.equal(previews[0]?.inputPreview, undefined, 'bash preview is refused');
  assert.equal(previews[1]?.inputPreview, 'read-preview');
  assert.equal(previews[2]?.inputPreview, undefined, 'codemode preview is refused');
  assert.equal(previews[3]?.inputPreview, undefined, 'MCP preview is refused');
  assert.equal(previews[4]?.inputPreview, undefined, 'powershell preview is refused');
  assert.equal(previews[5]?.nested, true);
  assert.equal(previews[5]?.durationMs, 12);
  assert.equal(previews[5]?.source, 'branch');
  assert.equal(previews[5]?.inputPreviewClipped, true);
  assert.ok(Buffer.byteLength(previews[5]!.inputPreview!, 'utf8') <= 256);
  assert.doesNotMatch(JSON.stringify(withPreviews), /SECRET/);
});

test('toolDirectory contains names and bounded descriptions but no schemas', () => {
  const active = Array.from({ length: 40 }, (_, index) => ({
    name: `active-${index}`,
    description: index === 0 ? 'short' : `"description ${index}" ${'d'.repeat(220)}`,
    parameters: { schema: 'SCHEMA_MARKER' },
    promptGuidelines: ['GUIDELINE_MARKER'],
  }));
  const activatable = Array.from({ length: 40 }, (_, index) => ({
    name: `activatable-${index}`,
    description: 'a'.repeat(200),
    parameters: { schema: 'SCHEMA_MARKER' },
  }));
  const state = slice({ trigger: 'before_agent_start' }, ['toolDirectory'], {
    toolDirectory: { active, activatable },
  });

  assert.ok(state.toolDirectory);
  assert.equal(state.toolDirectory.active.items.length, 32);
  assert.equal(state.toolDirectory.activatable.items.length, 32);
  assert.equal(state.toolDirectory.active.clipped, true);
  assert.equal(state.toolDirectory.activatable.clipped, true);
  assert.deepEqual(state.toolDirectory.active.items[0], { name: 'active-0', description: 'short' });
  assert.equal(state.toolDirectory.active.items[1]?.descriptionClipped, true);
  assert.ok(Buffer.byteLength(state.toolDirectory.active.items[1]!.description!, 'utf8') <= 160);
  assert.ok(Buffer.byteLength(state.toolDirectory.activatable.items[0]!.description!, 'utf8') <= 160);
  assert.equal(state.toolDirectory.activatable.items[0]?.descriptionClipped, true);
  assert.doesNotMatch(JSON.stringify(state), /SCHEMA_MARKER|parameters|promptGuidelines|GUIDELINE_MARKER/);
});

test('final serialization stays within 16 KiB including escaping and marks every forced cut', () => {
  const heavy = `"\\${'é'.repeat(4000)}`;
  const branch = [
    compactionEntry('c'),
    userEntry('u1', heavy),
    customEntry('d1', 'agent-delivery', heavy),
    userEntry('u2', heavy),
  ];
  const facts = Array.from({ length: 8 }, (_, index) =>
    toolFact(`read-${index}`, `"\\${'p'.repeat(300)}`));
  const directoryTools = Array.from({ length: 40 }, (_, index) => ({
    name: `tool-"${index}"-\\`,
    description: `"\\${'d'.repeat(220)}`,
  }));
  const state = slice({
    trigger: 'tool_result',
    model: { provider: 'fake-provider', id: 'fake-model' },
    preset: 'fast',
    tool: 'read',
    result: { isError: true, errorKind: 'script', outputChars: 999 },
    turn: { modelCalls: 2, toolCalls: 4, toolErrors: 1 },
  }, ['prompt', 'result', 'recentInputs', 'recentTools', 'recentToolPreviews', 'toolDirectory'], {
    prompt: heavy,
    result: heavy,
    branch,
    recentTools: facts,
    toolDirectory: { active: directoryTools, activatable: directoryTools },
  });

  const json = JSON.stringify(state);
  assert.ok(Buffer.byteLength(json, 'utf8') <= 16 * 1024);
  assert.equal(JSON.parse(json).clipped, true);
  assert.ok(state.toolDirectory?.active.clipped === true || state.toolDirectory === undefined,
    'directory item loss is marked');
});

test('oversized subject strings cannot break the 16 KiB serialization guarantee', () => {
  const state = slice({
    trigger: 'tool_result',
    preset: 'p'.repeat(20_000),
    tool: 't'.repeat(20_000),
    result: { errorKind: 'e'.repeat(20_000) },
  }, []);

  const json = JSON.stringify(state);
  assert.ok(Buffer.byteLength(json, 'utf8') <= 16 * 1024);
  assert.equal(JSON.parse(json).clipped, true);
});
