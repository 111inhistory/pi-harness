/**
 * Offline regressions for the generic prompt-section journal engine.
 *
 * Capability memory is the first non-tool domain: one source id whose section is
 * replayed at fixed native ordinals under its own custom entry type. These tests
 * exercise the shared engine directly, without provider calls.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Message } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';

import {
  appendPromptSectionRecord,
  promptSectionRecords,
  replayPromptSections,
  type PromptSectionRecord,
  type PromptSectionSource,
} from '../../src/prompt-section-journal.ts';
import { TOOL_GUIDANCE_RECORD } from '../../src/tool-guidance.ts';
import type { TranscriptMessageLike } from '../../src/session-transcript.ts';

const CAPABILITY_RECORD = 'harness-capability-memory';

interface NativeMessage extends TranscriptMessageLike {
  readonly role: string;
  readonly content?: unknown;
  readonly sections?: Record<string, string | null>;
  readonly timestamp: number;
}

function managerWith(sections: Record<string, string | null>, userText: string): SessionManager {
  const manager = SessionManager.inMemory('/test');
  manager.appendMessage({ role: 'system', content: '', sections, timestamp: 0 } as unknown as Message);
  manager.appendMessage({ role: 'user', content: userText, timestamp: 1 } as unknown as Message);
  return manager;
}

function nativeMessages(manager: SessionManager): readonly NativeMessage[] {
  return manager.buildSessionProjection().messages as unknown as readonly NativeMessage[];
}

function journal(manager: SessionManager, checkpointId: string | null = null) {
  return {
    checkpointId,
    recordType: CAPABILITY_RECORD,
    appendEntry: (customType: string, data: unknown) => { manager.appendCustomEntry(customType, data); },
    sectionName: (id: string) => id,
  };
}

function capabilitySource(text: string | null, eligible = true): PromptSectionSource[] {
  return [{ id: 'capabilities', text, eligible }];
}

function records(manager: SessionManager): PromptSectionRecord[] {
  return promptSectionRecords(manager.getBranch(), CAPABILITY_RECORD);
}

/** Section values for one native section name, in request order. */
function sectionValues(messages: readonly unknown[], name: string): Array<string | null> {
  return messages.flatMap((message) => {
    const sections = (message as { readonly sections?: unknown }).sections;
    if (typeof sections !== 'object' || sections === null || Array.isArray(sections)) return [];
    const value = (sections as Record<string, unknown>)[name];
    return typeof value === 'string' || value === null ? [value] : [];
  });
}

function occurrences(messages: readonly unknown[], name: string): number {
  return sectionValues(messages, name).length;
}

test('capability-style section replays at its native ordinal and appends changes and removals', () => {
  const manager = managerWith({ preamble: 'base' }, 'GO');
  const native = nativeMessages(manager);
  appendPromptSectionRecord({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, CAPABILITY_RECORD, {
    version: 1, checkpointId: null, id: 'capabilities', text: 'MEMORY A', position: 0,
  });

  const first = replayPromptSections(native, capabilitySource('MEMORY A'), records(manager), journal(manager));
  assert.deepEqual(first.map((message) => (message as NativeMessage).role), ['system', 'system', 'user']);
  assert.deepEqual(sectionValues(first, 'capabilities'), ['MEMORY A'], 'one anchored section after the leading system message');

  const changed = replayPromptSections(native, capabilitySource('MEMORY B'), records(manager), journal(manager));
  assert.deepEqual(sectionValues(changed, 'capabilities'), ['MEMORY A', 'MEMORY B']);
  assert.deepEqual(changed.slice(0, first.length), first, 'the earlier prefix is untouched');
  assert.deepEqual(records(manager).at(-1), {
    version: 1, checkpointId: null, id: 'capabilities', text: 'MEMORY B', position: 1,
  });

  const removed = replayPromptSections(native, capabilitySource(null), records(manager), journal(manager));
  assert.deepEqual(sectionValues(removed, 'capabilities'), ['MEMORY A', 'MEMORY B', null]);
  assert.equal(removed.at(-1)?.role, 'system');
  assert.deepEqual(records(manager).at(-1), {
    version: 1, checkpointId: null, id: 'capabilities', text: null, position: 1,
  });

  manager.appendMessage({ role: 'user', content: 'LATER', timestamp: 5 } as unknown as Message);
  const resumed = replayPromptSections(nativeMessages(manager), capabilitySource(null), records(manager), journal(manager));
  assert.deepEqual(resumed.slice(0, removed.length), removed,
    'resume keeps the whole recorded prefix, including the null removal');
  assert.deepEqual(sectionValues(resumed, 'capabilities'), ['MEMORY A', 'MEMORY B', null]);
  assert.equal(records(manager).filter((record) => record.text === null).length, 1,
    'resume does not repeat the removal');
});

test('one journal domain ignores the other domain history and record types', () => {
  const manager = managerWith({ preamble: 'base' }, 'GO');
  const native = nativeMessages(manager);
  const write = { appendEntry: (type: string, data: unknown) => { manager.appendCustomEntry(type, data); } };
  appendPromptSectionRecord(write, TOOL_GUIDANCE_RECORD, {
    version: 1, checkpointId: null, id: 'subagent', text: 'TOOL', position: 0,
  });
  appendPromptSectionRecord(write, CAPABILITY_RECORD, {
    version: 1, checkpointId: null, id: 'capabilities', text: 'MEMORY', position: 0,
  });

  assert.deepEqual(records(manager).map((record) => record.id), ['capabilities']);
  const projected = replayPromptSections(native, capabilitySource('MEMORY'), records(manager), journal(manager));
  assert.deepEqual(sectionValues(projected, 'capabilities'), ['MEMORY']);
  assert.equal(occurrences(projected, 'harness-guidance:subagent'), 0, 'tool history is not part of this domain');
  assert.equal(manager.getBranch().filter((entry) => entry.type === 'custom' && entry.customType === TOOL_GUIDANCE_RECORD).length, 1,
    'the other domain records are left alone');
});

test('a same-boundary ordinal outside the native transcript fails explicitly for any domain', () => {
  const manager = managerWith({ preamble: 'base' }, 'GO');
  appendPromptSectionRecord({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, CAPABILITY_RECORD, {
    version: 1, checkpointId: null, id: 'capabilities', text: 'MEMORY', position: 7,
  });
  assert.throws(
    () => replayPromptSections(nativeMessages(manager), capabilitySource('MEMORY'), records(manager), journal(manager)),
    /harness-capability-memory record for "capabilities" follows native message 7, but the request has 2 native messages/,
  );
});
