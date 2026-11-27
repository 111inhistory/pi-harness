/**
 * Bounded, opt-in classifier state for Hook rules.
 *
 * The projection is a pure local function: callers own model calls, branch
 * snapshots and tool-directory snapshots. Only enum-like subject facts are sent
 * by default. Text bodies, recent inputs, recent tool metadata and the tool
 * directory are explicit includes, and every forced cut carries a `clipped`
 * marker. The final serialized state is kept within 16 KiB after JSON escaping.
 *
 * Recent tools come from the runtime's bounded observation ring; this module
 * never replays a branch to rebuild them. Tool previews are accepted only as an
 * adapter-allowlisted `inputPreview` string and are dropped for shell, Codemode
 * and MCP tools.
 */

import type { ClassifierContext } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { clipText } from '../text-output.ts';

export type HookClassifierTrigger = 'before_agent_start' | 'tool_result';
export type HookClassifierInclude =
  | 'prompt'
  | 'result'
  | 'recentInputs'
  | 'recentTools'
  | 'recentToolPreviews'
  | 'toolDirectory';
export type HookClassifierToolStatus = 'ok' | 'error' | 'cancelled' | 'unfinished';
export type HookClassifierToolSource = 'live' | 'branch';

export interface HookClassifierModelRef {
  readonly provider: string;
  readonly id: string;
}

export interface HookClassifierResultFacts {
  readonly isError?: boolean;
  readonly truncated?: boolean;
  readonly status?: HookClassifierToolStatus;
  readonly errorKind?: string;
  readonly outputChars?: number;
}

export interface HookClassifierTurnCounters {
  readonly modelCalls?: number;
  readonly toolCalls?: number;
  readonly nestedToolCalls?: number;
  readonly toolErrors?: number;
}

export interface HookClassifierSubject {
  readonly trigger: HookClassifierTrigger;
  readonly model?: HookClassifierModelRef;
  readonly preset?: string;
  readonly tool?: string;
  readonly nested?: boolean;
  readonly result?: HookClassifierResultFacts;
  readonly turn?: HookClassifierTurnCounters;
}

/** One tool fact from the runtime's recent-observation ring. */
export interface HookClassifierToolFact {
  readonly toolName: string;
  readonly status?: HookClassifierToolStatus;
  readonly isError?: boolean;
  readonly isNested?: boolean;
  readonly durationMs?: number;
  readonly source?: HookClassifierToolSource;
  /** Adapter-allowlisted argument preview; omitted when not safe to expose. */
  readonly inputPreview?: string;
  readonly inputPreviewClipped?: boolean;
}

export interface HookClassifierDirectoryTool {
  readonly name: string;
  readonly description?: string;
}

export interface HookClassifierToolDirectory {
  readonly active: readonly HookClassifierDirectoryTool[];
  readonly activatable: readonly HookClassifierDirectoryTool[];
}

type Lazy<T> = T | (() => T | undefined);

export interface HookClassifierSources {
  readonly prompt?: string | (() => string | undefined);
  /** The producer already cut the prompt before handing it over. */
  readonly promptClipped?: boolean;
  readonly result?: string | (() => string | undefined);
  /** The producer already cut the result before handing it over. */
  readonly resultClipped?: boolean;
  readonly branch?: readonly SessionEntry[] | (() => readonly SessionEntry[] | undefined);
  readonly recentTools?: readonly HookClassifierToolFact[] | (() => readonly HookClassifierToolFact[] | undefined);
  readonly recentToolsClipped?: boolean;
  readonly toolDirectory?: HookClassifierToolDirectory | (() => HookClassifierToolDirectory | undefined);
}

const MAX_STATE_BYTES = 16 * 1024;
const MAX_PROMPT_BYTES = 2 * 1024;
const MAX_RESULT_BYTES = 2 * 1024;
const MAX_RECENT_INPUTS = 3;
const MAX_RECENT_INPUT_BYTES = 1024;
const MAX_RECENT_TOOLS = 6;
const MAX_PREVIEW_BYTES = 256;
const MAX_DIRECTORY_ITEMS = 32;
const MAX_DIRECTORY_DESCRIPTION_BYTES = 160;
const MAX_IDENTIFIER_BYTES = 256;
const CLIP_LINES = 1_000_000;
const SENSITIVE_PREVIEW_TOOLS = new Set(['bash', 'powershell', 'codemode']);

type MutableSubject = {
  trigger: HookClassifierTrigger;
  model?: { provider: string; id: string };
  preset?: string;
  tool?: string;
  nested?: boolean;
  result?: {
    isError?: boolean; truncated?: boolean; status?: HookClassifierToolStatus;
    errorKind?: string; outputChars?: number;
  };
  turn?: { modelCalls?: number; toolCalls?: number; nestedToolCalls?: number; toolErrors?: number };
};

type MutableText = { text: string; clipped?: true };
type MutableRecentInput = { role: 'user' | 'agent-delivery'; text: string; clipped?: true };
type MutableRecentInputs = { items: MutableRecentInput[]; clipped?: true };
type MutableRecentTool = {
  name: string; status?: HookClassifierToolStatus; isError?: boolean; nested?: true;
  durationMs?: number; source?: HookClassifierToolSource; inputPreview?: string; inputPreviewClipped?: true;
};
type MutableRecentTools = { items: MutableRecentTool[]; clipped?: true };
type MutableDirectoryEntry = { name: string; description?: string; descriptionClipped?: true };
type MutableDirectoryList = { items: MutableDirectoryEntry[]; clipped?: true };
type MutableDirectory = { active: MutableDirectoryList; activatable: MutableDirectoryList };
type MutableSlice = {
  subject: MutableSubject;
  prompt?: MutableText;
  result?: MutableText;
  recentInputs?: MutableRecentInputs;
  recentTools?: MutableRecentTools;
  toolDirectory?: MutableDirectory;
  clipped?: true;
};
export type HookClassifierSlice = Readonly<MutableSlice>;

function readSource<T>(source: Lazy<T> | undefined): T | undefined {
  return typeof source === 'function' ? (source as () => T | undefined)() : source;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toolStatus(value: unknown): HookClassifierToolStatus | undefined {
  return value === 'ok' || value === 'error' || value === 'cancelled' || value === 'unfinished'
    ? value
    : undefined;
}

function toolSource(value: unknown): HookClassifierToolSource | undefined {
  return value === 'live' || value === 'branch' ? value : undefined;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const value = part as { readonly type?: unknown; readonly text?: unknown };
    if (value.type === 'text' && typeof value.text === 'string' && value.text !== '') parts.push(value.text);
  }
  return parts.join('\n');
}

function clipTextBody(text: string, maxBytes: number, keep: 'head' | 'tail'): MutableText {
  const clipped = clipText(text, { maxLines: CLIP_LINES, maxBytes }, keep);
  if (clipped.text !== '' || text === '') {
    return { text: clipped.text, ...(clipped.truncated ? { clipped: true as const } : {}) };
  }
  // Pi's head/tail helpers refuse to cut through one oversized line. Keep the
  // requested end from the both-ends form, then apply the same byte budget.
  const both = clipText(text, { maxLines: CLIP_LINES, maxBytes }, 'head-tail');
  const fallback = clipText(both.text, { maxLines: CLIP_LINES, maxBytes }, keep);
  return { text: fallback.text, clipped: true };
}

function copySubject(subject: HookClassifierSubject, identifier: (text: string) => string): MutableSubject {
  const out: MutableSubject = { trigger: subject.trigger };
  if (subject.model !== undefined
      && typeof subject.model.provider === 'string'
      && typeof subject.model.id === 'string') {
    out.model = { provider: identifier(subject.model.provider), id: identifier(subject.model.id) };
  }
  if (typeof subject.preset === 'string') out.preset = identifier(subject.preset);
  if (typeof subject.tool === 'string') out.tool = identifier(subject.tool);
  if (typeof subject.nested === 'boolean') out.nested = subject.nested;
  if (subject.result !== undefined) {
    const result: NonNullable<MutableSubject['result']> = {};
    if (typeof subject.result.isError === 'boolean') result.isError = subject.result.isError;
    if (typeof subject.result.truncated === 'boolean') result.truncated = subject.result.truncated;
    const status = toolStatus(subject.result.status);
    if (status !== undefined) result.status = status;
    if (typeof subject.result.errorKind === 'string') result.errorKind = identifier(subject.result.errorKind);
    const outputChars = finiteNumber(subject.result.outputChars);
    if (outputChars !== undefined) result.outputChars = outputChars;
    if (Object.keys(result).length > 0) out.result = result;
  }
  if (subject.turn !== undefined) {
    const turn: NonNullable<MutableSubject['turn']> = {};
    const modelCalls = finiteNumber(subject.turn.modelCalls);
    if (modelCalls !== undefined) turn.modelCalls = modelCalls;
    const toolCalls = finiteNumber(subject.turn.toolCalls);
    if (toolCalls !== undefined) turn.toolCalls = toolCalls;
    const nestedToolCalls = finiteNumber(subject.turn.nestedToolCalls);
    if (nestedToolCalls !== undefined) turn.nestedToolCalls = nestedToolCalls;
    const toolErrors = finiteNumber(subject.turn.toolErrors);
    if (toolErrors !== undefined) turn.toolErrors = toolErrors;
    if (Object.keys(turn).length > 0) out.turn = turn;
  }
  return out;
}

function inputOfEntry(entry: SessionEntry): MutableRecentInput | undefined {
  if (entry.type === 'message' && entry.message.role === 'user') {
    const text = textOfContent(entry.message.content);
    return text === '' ? undefined : { role: 'user', text };
  }
  // Only the explicit agent-delivery custom type is an input; hint, sync and
  // arbitrary extension messages never enter classifier state.
  if (entry.type === 'custom_message' && entry.customType === 'agent-delivery') {
    const text = textOfContent(entry.content);
    return text === '' ? undefined : { role: 'agent-delivery', text };
  }
  return undefined;
}

function recentInputsSlice(branch: readonly SessionEntry[] | undefined): MutableRecentInputs {
  const items: MutableRecentInput[] = [];
  if (branch === undefined) return { items };
  let clipped = false;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]!;
    if (entry.type === 'compaction') break;
    const input = inputOfEntry(entry);
    if (input === undefined) continue;
    if (items.length === MAX_RECENT_INPUTS) {
      clipped = true;
      break;
    }
    const text = clipTextBody(input.text, MAX_RECENT_INPUT_BYTES, 'head');
    items.push({ role: input.role, text: text.text, ...(text.clipped === true ? { clipped: true as const } : {}) });
  }
  items.reverse();
  return { items, ...(clipped ? { clipped: true as const } : {}) };
}

function sensitivePreviewTool(name: string): boolean {
  return SENSITIVE_PREVIEW_TOOLS.has(name) || name.startsWith('mcp__');
}

function recentToolSlice(fact: HookClassifierToolFact, previews: boolean, name: string): MutableRecentTool {
  const out: MutableRecentTool = { name };
  const status = toolStatus(fact.status);
  if (status !== undefined) out.status = status;
  if (typeof fact.isError === 'boolean') out.isError = fact.isError;
  if (fact.isNested === true) out.nested = true;
  const durationMs = finiteNumber(fact.durationMs);
  if (durationMs !== undefined) out.durationMs = durationMs;
  const source = toolSource(fact.source);
  if (source !== undefined) out.source = source;
  if (previews && !sensitivePreviewTool(fact.toolName) && typeof fact.inputPreview === 'string') {
    const preview = clipTextBody(fact.inputPreview, MAX_PREVIEW_BYTES, 'head');
    out.inputPreview = preview.text;
    if (preview.clipped === true || fact.inputPreviewClipped === true) out.inputPreviewClipped = true;
  }
  return out;
}

function recentToolsSlice(facts: readonly HookClassifierToolFact[], previews: boolean, clipped = false): MutableRecentTools {
  const start = Math.max(0, facts.length - MAX_RECENT_TOOLS);
  const items = facts.slice(start).map(fact => {
    const name = clipTextBody(fact.toolName, MAX_IDENTIFIER_BYTES, 'head');
    clipped ||= name.clipped === true;
    return recentToolSlice(fact, previews, name.text);
  });
  return { items, ...(clipped || start > 0 ? { clipped: true as const } : {}) };
}

function directoryList(tools: readonly HookClassifierDirectoryTool[]): MutableDirectoryList {
  const items: MutableDirectoryEntry[] = [];
  let clipped = false;
  for (const tool of tools) {
    if (items.length === MAX_DIRECTORY_ITEMS) {
      clipped = true;
      break;
    }
    if (typeof tool.name !== 'string') continue;
    const name = clipTextBody(tool.name, MAX_IDENTIFIER_BYTES, 'head');
    clipped ||= name.clipped === true;
    const entry: MutableDirectoryEntry = { name: name.text };
    if (typeof tool.description === 'string' && tool.description !== '') {
      const description = clipTextBody(tool.description, MAX_DIRECTORY_DESCRIPTION_BYTES, 'head');
      entry.description = description.text;
      if (description.clipped === true) entry.descriptionClipped = true;
    }
    items.push(entry);
  }
  return { items, ...(clipped ? { clipped: true as const } : {}) };
}

/** Remove or shorten the least critical optional state one step at a time. */
function reduceSlice(slice: MutableSlice): boolean {
  if (slice.toolDirectory !== undefined) {
    const directory = slice.toolDirectory;
    if (directory.activatable.items.length > 0) {
      directory.activatable.items.pop();
      directory.activatable.clipped = true;
      return true;
    }
    if (directory.active.items.length > 0) {
      directory.active.items.pop();
      directory.active.clipped = true;
      return true;
    }
    delete slice.toolDirectory;
    return true;
  }
  if (slice.recentTools !== undefined) {
    if (slice.recentTools.items.length > 0) {
      slice.recentTools.items.pop();
      slice.recentTools.clipped = true;
    } else {
      delete slice.recentTools;
    }
    return true;
  }
  if (slice.recentInputs !== undefined) {
    if (slice.recentInputs.items.length > 0) {
      slice.recentInputs.items.pop();
      slice.recentInputs.clipped = true;
    } else {
      delete slice.recentInputs;
    }
    return true;
  }
  if (slice.prompt !== undefined) {
    if (slice.prompt.text !== '') {
      slice.prompt.text = '';
      slice.prompt.clipped = true;
    } else {
      delete slice.prompt;
    }
    return true;
  }
  if (slice.result !== undefined) {
    if (slice.result.text !== '') {
      slice.result.text = '';
      slice.result.clipped = true;
    } else {
      delete slice.result;
    }
    return true;
  }
  return false;
}

function serializedBytes(slice: MutableSlice): number {
  return Buffer.byteLength(JSON.stringify(slice), 'utf8');
}

function fitSlice(slice: MutableSlice): HookClassifierSlice {
  if (serializedBytes(slice) <= MAX_STATE_BYTES) return slice;
  slice.clipped = true;
  while (serializedBytes(slice) > MAX_STATE_BYTES) {
    if (!reduceSlice(slice)) throw new Error('Hook classifier subject exceeded its bounded state size');
  }
  return slice;
}

/**
 * Build bounded classifier state from enum-like subject facts and opt-in bodies.
 *
 * Returns the typed classifier state object. The object is guaranteed to
 * serialize to at most 16 KiB UTF-8, including JSON escaping; `clipped` marks
 * every forced cut and the root marker covers final-budget reductions.
 */
export function buildHookClassifierSlice(
  subject: HookClassifierSubject,
  include: readonly HookClassifierInclude[],
  sources: HookClassifierSources = {},
): ClassifierContext['state'] {
  const requested = new Set(include);
  let metadataClipped = false;
  const slice: MutableSlice = { subject: copySubject(subject, text => {
    const identifier = clipTextBody(text, MAX_IDENTIFIER_BYTES, 'head');
    metadataClipped ||= identifier.clipped === true;
    return identifier.text;
  }) };
  if (metadataClipped) slice.clipped = true;

  if (requested.has('prompt')) {
    const prompt = readSource(sources.prompt);
    if (typeof prompt === 'string') {
      slice.prompt = clipTextBody(prompt, MAX_PROMPT_BYTES, 'head');
      if (sources.promptClipped === true) slice.prompt.clipped = true;
    }
  }
  if (requested.has('result')) {
    const result = readSource(sources.result);
    if (typeof result === 'string') {
      slice.result = clipTextBody(result, MAX_RESULT_BYTES, 'tail');
      if (sources.resultClipped === true) slice.result.clipped = true;
    }
  }
  if (requested.has('recentInputs')) {
    slice.recentInputs = recentInputsSlice(readSource(sources.branch));
  }
  if (requested.has('recentTools') || requested.has('recentToolPreviews')) {
    const facts = readSource(sources.recentTools) ?? [];
    slice.recentTools = recentToolsSlice(facts, requested.has('recentToolPreviews'), sources.recentToolsClipped);
  }
  if (requested.has('toolDirectory')) {
    const directory = readSource(sources.toolDirectory);
    if (directory !== undefined) {
      slice.toolDirectory = {
        active: directoryList(directory.active),
        activatable: directoryList(directory.activatable),
      };
    }
  }

  return fitSlice(slice) as unknown as ClassifierContext['state'];
}
