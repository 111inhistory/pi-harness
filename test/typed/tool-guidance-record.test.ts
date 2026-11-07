/**
 * Offline contract regressions for the tool-guidance journal.
 *
 * These use a real SessionManager so custom records are appended, read back and
 * survive reopen, branch rewind and inheritance exactly as in production. No
 * provider call is made: the projection is a pure request transform.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { fauxProvider, type Api, type Message, type Model } from '@earendil-works/pi-ai';
import { SessionManager, type ExtensionContext, type FileEntry } from '@earendil-works/pi-coding-agent';

import { captureInheritedContext } from '../../src/inherited-context.ts';
import { promptString } from '../../src/prompt-text.ts';
import {
  TOOL_GUIDANCE_RECORD,
  projectRecordedToolGuidance,
  projectToolGuidance,
  toolGuidanceSection,
  type ToolGuidance,
} from '../../src/tool-guidance.ts';
import { SUBAGENT_TOOL_GUIDANCE } from '../../src/subagent/tool-guidance.ts';
import type { TranscriptMessageLike } from '../../src/session-transcript.ts';

interface NativeMessage extends TranscriptMessageLike {
  readonly role: string;
  readonly content?: unknown;
  readonly sections?: Record<string, string | null>;
  readonly toolsAdded?: readonly { readonly name: string }[];
  readonly timestamp: number;
}

const physical: Model<Api> = fauxProvider({ models: [{ id: 'physical-fixture', reasoning: true }] }).models[0]!;

function declaration(...names: string[]): NativeMessage {
  return {
    role: 'system',
    content: '',
    sections: { preamble: 'base' },
    toolsAdded: names.map((name) => ({ name })),
    timestamp: 0,
  };
}

function user(text: string, timestamp = 1): NativeMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp };
}

function guide(id: string, tools: readonly string[], text: string): ToolGuidance {
  return { id, tools, text };
}

function managerWith(messages: readonly NativeMessage[]): SessionManager {
  const manager = SessionManager.inMemory('/test');
  for (const message of messages) manager.appendMessage(message as unknown as Message);
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

function project(
  manager: SessionManager,
  guidance: readonly ToolGuidance[],
  messages: readonly NativeMessage[] = nativeMessages(manager),
  checkpointId: string | null = latestBoundary(manager),
): readonly (NativeMessage | { readonly role: 'system'; readonly sections?: Record<string, string | null> })[] {
  return projectRecordedToolGuidance(messages, guidance, {
    branch: manager.getBranch(),
    checkpointId,
    appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); },
  }) as readonly (NativeMessage | { readonly role: 'system'; readonly sections?: Record<string, string | null> })[];
}

function sectionsOf(message: unknown): Record<string, string | null> {
  const value = (message as { readonly sections?: unknown }).sections;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, string | null>
    : {};
}

/** Guidance text actually projected for one id, in request order. */
function textsFor(messages: readonly unknown[], id: string): string[] {
  const section = toolGuidanceSection(id);
  return messages.flatMap((message) => {
    const text = sectionsOf(message)[section];
    return typeof text === 'string' ? [text] : [];
  });
}

/** Guidance sections in request order as [id, text|null], for cross-id ordering assertions. */
function guidanceOrder(messages: readonly unknown[]): Array<[string, string | null]> {
  return messages.flatMap((message) => Object.entries(sectionsOf(message)).flatMap(([key, text]) =>
    key.startsWith('harness-guidance:')
      ? [[key.slice('harness-guidance:'.length), text] as [string, string | null]]
      : []));
}

function storedRecords(manager: SessionManager): Array<Record<string, unknown>> {
  return manager.getBranch().flatMap((entry) => entry.type === 'custom' && entry.customType === TOOL_GUIDANCE_RECORD
    ? [{ ...(entry.data as Record<string, unknown>) }]
    : []);
}

function inheritedContext(manager: SessionManager) {
  return {
    cwd: '/test',
    sessionManager: manager,
    model: physical,
    thinkingLevel: 'low' as const,
    getSystemPrompt: () => 'PARENT_PROMPT',
    modelRegistry: {} as ExtensionContext['modelRegistry'],
  };
}

test('pure projection anchors missing guidance and only updates a changed marker at the tail', () => {
  const head = declaration('subagent_list');
  const messages = [head, user('GO')];
  const entries = [guide('subagent', ['subagent_list'], 'GUIDANCE A')];
  const first = projectToolGuidance(messages, entries);

  assert.equal(first[0], head);
  assert.equal(first[2], messages[1]);
  assert.deepEqual(textsFor(first, 'subagent'), ['GUIDANCE A']);

  const same = projectToolGuidance(first, entries);
  assert.deepEqual(same, first, 'the latest marker already carries the asset text');

  const changed = projectToolGuidance(first, [guide('subagent', ['subagent_list'], 'GUIDANCE B')]);
  assert.deepEqual(textsFor(changed, 'subagent'), ['GUIDANCE A', 'GUIDANCE B']);
  assert.equal(changed[changed.length - 1]?.role, 'system', 'the update is a later system message');

  const lookalike = projectToolGuidance(
    [head, { role: 'user', content: 'GUIDANCE A', timestamp: 2 }],
    entries,
  );
  assert.equal(textsFor(lookalike, 'subagent').length, 1, 'user text is not a guidance marker');
});

test('bootstrap persists the prompt asset placement and a new module value appends after the last native message', () => {
  const asset = promptString('subagent-tools.json', 'instructions');
  const common = SUBAGENT_TOOL_GUIDANCE.find((entry) => entry.id === 'subagent');
  assert.ok(common);
  assert.equal(common.text, asset);

  const manager = managerWith([declaration('subagent_list'), user('GO')]);
  const native = nativeMessages(manager);
  const messageEntries = manager.getBranch().filter((entry) => entry.type === 'message').length;
  const first = project(manager, SUBAGENT_TOOL_GUIDANCE, native);

  assert.equal(first[0], native[0]);
  assert.equal(first[2], native[1]);
  assert.deepEqual(textsFor(first, 'subagent'), [asset]);
  assert.deepEqual(storedRecords(manager), [{
    version: 1, checkpointId: null, id: 'subagent', text: asset, position: 0,
  }]);

  const changed = SUBAGENT_TOOL_GUIDANCE.map((entry) => entry.id === 'subagent'
    ? { ...entry, text: `${asset}\n\nNEW MODULE VALUE` }
    : entry);
  const updated = project(manager, changed, native);
  assert.deepEqual(textsFor(updated, 'subagent'), [asset, `${asset}\n\nNEW MODULE VALUE`]);
  assert.deepEqual(updated.slice(0, first.length), first, 'the anchored text and request prefix are unchanged');
  assert.deepEqual(storedRecords(manager)[1], {
    version: 1, checkpointId: null, id: 'subagent', text: `${asset}\n\nNEW MODULE VALUE`, position: 1,
  });

  const repeated = project(manager, changed, native);
  assert.deepEqual(repeated, updated);
  assert.equal(storedRecords(manager).length, 2, 'the same asset text writes no further record');
  assert.equal(manager.getBranch().filter((entry) => entry.type === 'message').length, messageEntries,
    'only invisible custom records were appended, no native message was rewritten');
});

test('reopen from disk replays the recorded prefix and appends later edits after the last native message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-guidance-journal-'));
  try {
    const manager = SessionManager.create('/test', dir);
    for (const message of [declaration('subagent_list'), user('GO')]) manager.appendMessage(message as unknown as Message);
    const a = guide('subagent', ['subagent_list'], 'GUIDANCE A\nsecond line');
    const b = guide('subagent', ['subagent_list'], 'GUIDANCE B');

    const first = project(manager, [a]);
    const second = project(manager, [b], nativeMessages(manager));
    assert.deepEqual(textsFor(second, 'subagent'), ['GUIDANCE A\nsecond line', 'GUIDANCE B']);

    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile, 'a conversation session must be persisted');
    const reopened = SessionManager.open(sessionFile, dir);
    const replayNative = nativeMessages(reopened);
    assert.deepEqual(replayNative, nativeMessages(manager));

    const restarted = project(reopened, [b], replayNative);
    assert.deepEqual(restarted, second, 'restart with the same asset reproduces the same request');
    assert.deepEqual(restarted.slice(0, first.length), first, 'A -> B -> restart B keeps the A prefix');

    const c = guide('subagent', ['subagent_list'], 'GUIDANCE C');
    const updated = project(reopened, [c], replayNative);
    assert.deepEqual(textsFor(updated, 'subagent'), ['GUIDANCE A\nsecond line', 'GUIDANCE B', 'GUIDANCE C']);
    assert.deepEqual(updated.slice(0, second.length), second,
      'the old anchor and the recorded update never move when the asset changes again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a guidance id added after bootstrap appends at the tail once its tool is declared', () => {
  const manager = managerWith([declaration('subagent_list'), user('GO')]);
  const common = guide('subagent', ['subagent_list'], 'COMMON');
  project(manager, [common]);
  const write = guide('write', ['msg_write'], 'WRITE');

  const beforeDeclared = project(manager, [common, write], nativeMessages(manager));
  assert.deepEqual(textsFor(beforeDeclared, 'write'), []);
  assert.equal(storedRecords(manager).some((record) => record['id'] === 'write'), false);

  manager.appendMessage(declaration('msg_write') as unknown as Message);
  const native = nativeMessages(manager);
  const afterDeclared = project(manager, [common, write], native);
  assert.deepEqual(textsFor(afterDeclared, 'write'), ['WRITE']);
  assert.equal(textsFor(afterDeclared, 'subagent').length, 1, 'bootstrap guidance is not repeated');
  assert.equal(afterDeclared.length, native.length + 2, 'replayed anchor plus one appended update');
  assert.deepEqual(afterDeclared.slice(-1).map((message) => Object.keys(sectionsOf(message))), [
    [toolGuidanceSection('write')],
  ]);
  assert.deepEqual(storedRecords(manager).find((record) => record['id'] === 'write'), {
    version: 1, checkpointId: null, id: 'write', text: 'WRITE', position: 2,
  });
  assert.deepEqual(project(manager, [common, write], native), afterDeclared);
});

test('inherited markers keep their place and the last marker per id wins', () => {
  const firstMarker: NativeMessage = {
    role: 'system', content: '', sections: { [toolGuidanceSection('subagent')]: 'GUIDANCE A' }, timestamp: 2,
  };
  const lastMarker: NativeMessage = {
    role: 'system', content: '', sections: { [toolGuidanceSection('subagent')]: 'GUIDANCE B' }, timestamp: 3,
  };
  const manager = managerWith([declaration('subagent_list'), firstMarker, user('GO'), lastMarker]);
  const native = nativeMessages(manager);
  const first = project(manager, [guide('subagent', ['subagent_list'], 'GUIDANCE B')], native);

  assert.equal(first[0], native[0]);
  assert.equal(first[1], native[1], 'the inherited marker object is preserved');
  assert.equal(first[3], native[3]);
  assert.deepEqual(textsFor(first, 'subagent'), ['GUIDANCE A', 'GUIDANCE B'],
    'the last marker equals the asset, so no update is appended');
  assert.deepEqual(storedRecords(manager), [{
    version: 1, checkpointId: null, id: 'subagent', text: 'GUIDANCE B', position: 3,
  }], 'an inherited same-text marker is snapshotted as metadata');

  const changed = project(manager, [guide('subagent', ['subagent_list'], 'GUIDANCE C')], native);
  assert.deepEqual(textsFor(changed, 'subagent'), ['GUIDANCE A', 'GUIDANCE B', 'GUIDANCE C']);
  assert.equal(changed[1], native[1]);
  assert.equal(changed[3], native[3]);
  assert.deepEqual(storedRecords(manager).at(-1), {
    version: 1, checkpointId: null, id: 'subagent', text: 'GUIDANCE C', position: 3,
  });
  assert.deepEqual(project(manager, [guide('subagent', ['subagent_list'], 'GUIDANCE C')], native), changed,
    'replaying an inherited marker update is idempotent');

  const fromUser = projectToolGuidance(
    [declaration('subagent_list'), { role: 'user', content: 'GUIDANCE A', timestamp: 4 }],
    [guide('subagent', ['subagent_list'], 'GUIDANCE A')],
  );
  assert.equal(textsFor(fromUser, 'subagent').length, 1, 'user text never counts as a marker');
});

test('branch rewind drops later updates and inheritance keeps recorded placements', () => {
  const manager = managerWith([declaration('subagent_list'), user('GO')]);
  const a = guide('subagent', ['subagent_list'], 'A');
  const bootstrap = project(manager, [a]);
  const anchor = manager.getLeafId();
  assert.ok(anchor);

  const b = guide('subagent', ['subagent_list'], 'B');
  const updated = project(manager, [b], nativeMessages(manager));
  assert.deepEqual(textsFor(updated, 'subagent'), ['A', 'B']);

  manager.branch(anchor);
  assert.deepEqual(storedRecords(manager).map((record) => record['position']), [0],
    'the abandoned update record is gone after the rewind');
  const c = guide('subagent', ['subagent_list'], 'C');
  const rewound = project(manager, [c], nativeMessages(manager));
  assert.deepEqual(textsFor(rewound, 'subagent'), ['A', 'C'], 'the abandoned B update does not come back');
  assert.deepEqual(rewound.slice(0, bootstrap.length), bootstrap);

  const snapshot = captureInheritedContext({ getActiveTools: () => ['subagent_list'] }, inheritedContext(manager));
  assert.ok(snapshot.entries.some((entry) => entry.type === 'custom' && entry.customType === TOOL_GUIDANCE_RECORD),
    'the journal survives inheritance filtering');
  const child = SessionManager.inMemory('/tmp/child', {}, snapshot.entries as FileEntry[]);
  const childNative = nativeMessages(child);
  assert.deepEqual(textsFor(project(child, [c], childNative), 'subagent'), ['A', 'C']);

  const d = guide('subagent', ['subagent_list'], 'D');
  const childUpdated = project(child, [d], childNative);
  assert.deepEqual(textsFor(childUpdated, 'subagent'), ['A', 'C', 'D'],
    'the inherited anchor keeps A and the replayed C while the child asset change is appended');
  assert.equal(childUpdated[0], childNative[0]);
  assert.equal(sectionsOf(childUpdated[1])[toolGuidanceSection('subagent')], 'A',
    'the inherited anchor text never moves');
});

test('a recorded update keeps its fixed ordinal when later turns are appended and the session restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-guidance-append-'));
  try {
    const manager = SessionManager.create('/test', dir);
    for (const message of [declaration('subagent_list'), user('GO')]) manager.appendMessage(message as unknown as Message);
    const a = guide('subagent', ['subagent_list'], 'A');
    const b = guide('subagent', ['subagent_list'], 'B');
    project(manager, [a]);
    const second = project(manager, [b], nativeMessages(manager));
    assert.deepEqual(textsFor(second, 'subagent'), ['A', 'B']);
    assert.deepEqual(storedRecords(manager).map((record) => record['position']), [0, 1]);

    manager.appendMessage(user('LATER', 5) as unknown as Message);
    manager.appendMessage(user('LATER AGAIN', 6) as unknown as Message);
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    const reopened = SessionManager.open(sessionFile, dir);
    const native = nativeMessages(reopened);
    const restarted = project(reopened, [b], native);

    assert.deepEqual(restarted.slice(0, second.length), second,
      'the entire earlier provider-wire prefix, including the B update, is identical');
    assert.equal(restarted[second.length - 1]?.role, 'system');
    assert.equal(sectionsOf(restarted[second.length - 1])[toolGuidanceSection('subagent')], 'B');
    assert.equal(restarted[second.length], native[2], 'B still sits between its original neighbors');
    assert.deepEqual(textsFor(restarted, 'subagent'), ['A', 'B'], 'no duplicate update is appended');
    assert.deepEqual(storedRecords(reopened).map((record) => record['position']), [0, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a marker keeps its place while recorded updates stay at their ordinals', () => {
  const marker: NativeMessage = {
    role: 'system', content: '', sections: { [toolGuidanceSection('subagent')]: 'M' }, timestamp: 2,
  };
  const manager = managerWith([declaration('subagent_list'), marker, user('GO')]);
  const native = nativeMessages(manager);
  project(manager, [guide('subagent', ['subagent_list'], 'M')], native);
  assert.deepEqual(storedRecords(manager).map((record) => record['position']), [1],
    'the same-text marker is a metadata snapshot at its own ordinal');

  const updated = project(manager, [guide('subagent', ['subagent_list'], 'B')], native);
  assert.deepEqual(textsFor(updated, 'subagent'), ['M', 'B']);
  assert.equal(updated[1], native[1], 'the marker object is never rewritten');

  const reverted = project(manager, [guide('subagent', ['subagent_list'], 'M')], native);
  assert.deepEqual(textsFor(reverted, 'subagent'), ['M', 'B', 'M'],
    'the later recorded update is not resurrected over a reverted asset');
  assert.deepEqual(project(manager, [guide('subagent', ['subagent_list'], 'M')], native), reverted);
});

test('shared ordinals replay in journal append order and table reordering cannot change the prefix', () => {
  const common = (text: string) => guide('subagent', ['subagent_list'], text);
  const write = (text: string) => guide('write', ['msg_write'], text);
  const manager = managerWith([declaration('subagent_list', 'msg_write'), user('GO')]);
  const native = nativeMessages(manager);

  const bootstrapped = project(manager, [common('C1'), write('W1')], native);
  assert.deepEqual(guidanceOrder(bootstrapped), [['subagent', 'C1'], ['write', 'W1']],
    'both declarations share ordinal 0 and keep table order at bootstrap');

  const writeUpdated = project(manager, [common('C1'), write('W2')], native);
  assert.deepEqual(guidanceOrder(writeUpdated), [
    ['subagent', 'C1'], ['write', 'W1'], ['write', 'W2'],
  ]);
  const commonUpdated = project(manager, [common('C2'), write('W2')], native);
  assert.deepEqual(guidanceOrder(commonUpdated), [
    ['subagent', 'C1'], ['write', 'W1'], ['write', 'W2'], ['subagent', 'C2'],
  ], 'two updates at the same later ordinal replay in journal append order');

  const reordered = project(manager, [write('W2'), common('C2')], native);
  assert.deepEqual(guidanceOrder(reordered), guidanceOrder(commonUpdated),
    'reordering the table does not reorder already recorded placements');
  assert.deepEqual(reordered.slice(0, commonUpdated.length), commonUpdated);
});

test('a numeric placement at ordinal zero survives a leading-boundary merge', () => {
  const manager = managerWith([declaration('subagent_list')]);
  manager.appendCustomEntry(TOOL_GUIDANCE_RECORD, {
    version: 1, checkpointId: 'cp', id: 'subagent', text: 'HEAD', position: 'head',
  });
  manager.appendCustomEntry(TOOL_GUIDANCE_RECORD, {
    version: 1, checkpointId: 'cp', id: 'subagent', text: 'ZERO', position: 0,
  });
  const native = nativeMessages(manager);
  const projected = project(manager, [guide('subagent', ['subagent_list'], 'ZERO')], native, 'cp');

  assert.equal(sectionsOf(projected[0])[toolGuidanceSection('subagent')], 'HEAD');
  assert.equal(sectionsOf(projected[0])['preamble'], 'base');
  assert.equal(projected[1]?.role, 'system');
  assert.equal(sectionsOf(projected[1])[toolGuidanceSection('subagent')], 'ZERO');
  assert.equal(projected.length, 2, 'the merged head replaces native ordinal 0 without dropping the placement');
});

test('removing a guidance asset appends one null section update and keeps the old prefix', () => {
  const manager = managerWith([declaration('subagent_list'), user('GO')]);
  const a = guide('subagent', ['subagent_list'], 'A');
  const first = project(manager, [a]);
  assert.deepEqual(guidanceOrder(first), [['subagent', 'A']]);

  const blank = guide('subagent', ['subagent_list'], '   ');
  const removed = project(manager, [blank], nativeMessages(manager));
  assert.deepEqual(guidanceOrder(removed), [['subagent', 'A'], ['subagent', null]]);
  assert.deepEqual(removed.slice(0, first.length), first, 'the A anchor text is untouched');
  assert.equal(sectionsOf(removed.at(-1))[toolGuidanceSection('subagent')], null,
    'the update is a native section removal, not a rewritten message');
  assert.deepEqual(storedRecords(manager).at(-1), {
    version: 1, checkpointId: null, id: 'subagent', text: null, position: 1,
  });

  manager.appendMessage(user('LATER', 5) as unknown as Message);
  const native = nativeMessages(manager);
  const resumed = project(manager, [blank], native);
  assert.deepEqual(resumed.slice(0, removed.length), removed,
    'the whole earlier prefix, including A and the removal update, is retained');
  assert.deepEqual(guidanceOrder(resumed), [['subagent', 'A'], ['subagent', null]]);
  assert.equal(storedRecords(manager).filter((record) => record['text'] === null).length, 1,
    'resume does not repeat the removal');

  const dropped = project(manager, [], native);
  assert.deepEqual(guidanceOrder(dropped), guidanceOrder(resumed),
    'dropping the id from the table is the same removal, not a history rewrite');
  assert.deepEqual(dropped.slice(0, removed.length), removed);
});

test('a native context edit starts a rebased boundary for recorded placements', () => {
  const manager = managerWith([declaration('subagent_list'), user('GO')]);
  const a = guide('subagent', ['subagent_list'], 'A');
  const b = guide('subagent', ['subagent_list'], 'B');
  project(manager, [a]);
  const updated = project(manager, [b], nativeMessages(manager));
  assert.deepEqual(guidanceOrder(updated), [['subagent', 'A'], ['subagent', 'B']]);

  const target = manager.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'user');
  assert.ok(target);
  manager.appendContextEdit(target.id, { content: 'edited' });
  const boundary = latestBoundary(manager);
  assert.equal(boundary, manager.getBranch().at(-1)?.id, 'the latest context edit is the caller supplied boundary');

  const native = nativeMessages(manager);
  const rebased = project(manager, [b], native);
  assert.equal(sectionsOf(rebased[0])[toolGuidanceSection('subagent')], 'B',
    'the last recorded text moves once into the rebuilt leading boundary');
  assert.deepEqual(guidanceOrder(rebased), [['subagent', 'B']]);
  assert.deepEqual(storedRecords(manager).filter((record) => record['checkpointId'] === boundary), [{
    version: 1, checkpointId: boundary, id: 'subagent', text: 'B', position: 'head',
  }]);
  assert.deepEqual(project(manager, [b], nativeMessages(manager)), rebased,
    'the same boundary replays the pinned head without another write');
});

test('a live namespace source appends after old turns instead of at its old declaration', () => {
  const manager = managerWith([declaration('browser_pages', 'subagent_list'), user('T1', 2), user('T2', 3)]);
  const native = nativeMessages(manager);
  const asset = guide('subagent', ['subagent_list'], 'STATIC');
  const live: ToolGuidance = {
    id: 'namespace:browser',
    namespace: 'browser',
    tools: ['browser_pages'],
    text: 'LIVE BROWSER',
    initialPlacement: 'tail',
  };

  const pure = projectToolGuidance(native, [asset, live]);
  assert.deepEqual(guidanceOrder(pure), [['subagent', 'STATIC'], ['namespace:browser', 'LIVE BROWSER']],
    'live registry prose is not invented at the old declaration');
  assert.equal(sectionsOf(pure.at(-1))[toolGuidanceSection('namespace:browser')], 'LIVE BROWSER');

  const fresh = managerWith([declaration('browser_pages', 'subagent_list'), user('T1', 2), user('T2', 3)]);
  const bootstrapped = project(fresh, [asset, live], nativeMessages(fresh));
  assert.deepEqual(guidanceOrder(bootstrapped), [['subagent', 'STATIC'], ['namespace:browser', 'LIVE BROWSER']]);
  assert.deepEqual(storedRecords(fresh).find((record) => record['id'] === 'namespace:browser'), {
    version: 1, checkpointId: null, id: 'namespace:browser', text: 'LIVE BROWSER', position: 2,
  }, 'bootstrap preserves the tail placement as a fixed native ordinal');

  project(manager, [asset], native);
  assert.equal(storedRecords(manager).some((record) => record['id'] === 'namespace:browser'), false,
    'the static asset bootstraps the journal first');

  const withLive = project(manager, [asset, live], native);
  assert.deepEqual(guidanceOrder(withLive), [['subagent', 'STATIC'], ['namespace:browser', 'LIVE BROWSER']]);
  assert.equal(withLive.at(-2), native.at(-1), 'the live section follows every old turn');
  assert.deepEqual(storedRecords(manager).find((record) => record['id'] === 'namespace:browser'), {
    version: 1, checkpointId: null, id: 'namespace:browser', text: 'LIVE BROWSER', position: 2,
  });

  manager.appendMessage(user('T3', 5) as unknown as Message);
  const resumed = project(manager, [asset, live], nativeMessages(manager));
  assert.deepEqual(resumed.slice(0, withLive.length), withLive,
    'the recorded live placement stays fixed when later turns append');
});

test('compaction rebases stale placements into the leading boundary and pins the checkpoint', () => {
  const manager = managerWith([declaration('subagent_list'), user('GO')]);
  const a = guide('subagent', ['subagent_list'], 'A');
  project(manager, [a]);
  const b = guide('subagent', ['subagent_list'], 'B');
  project(manager, [b], nativeMessages(manager));

  const keep = manager.appendMessage(user('continue', 3) as unknown as Message);
  manager.appendCompaction('Summary', keep, 100);
  const boundary = latestBoundary(manager);
  assert.ok(boundary);
  const native = nativeMessages(manager);
  assert.equal(native[0]?.role, 'system', 'compaction captures the current leading system boundary');
  assert.equal(native[1]?.role, 'compactionSummary');

  const rebased = project(manager, [b], native);
  assert.equal(sectionsOf(rebased[0])[toolGuidanceSection('subagent')], 'B',
    'the last text per guidance is compacted into the leading boundary');
  assert.equal(sectionsOf(rebased[0])['preamble'], 'base', 'the native leading sections are retained');
  assert.equal(textsFor(rebased, 'subagent').filter((text) => text === 'B').length, 1);
  assert.equal(rebased.length, native.length, 'no extra update when the asset text is unchanged');
  assert.deepEqual(storedRecords(manager).filter((record) => record['checkpointId'] === boundary), [{
    version: 1, checkpointId: boundary, id: 'subagent', text: 'B', position: 'head',
  }]);

  const again = project(manager, [b], nativeMessages(manager));
  assert.deepEqual(again, rebased);
  assert.equal(storedRecords(manager).filter((record) => record['position'] === 'head').length, 1,
    'the boundary snapshot is written once');

  const c = guide('subagent', ['subagent_list'], 'C');
  const edited = project(manager, [c], nativeMessages(manager));
  assert.equal(sectionsOf(edited[0])[toolGuidanceSection('subagent')], 'B',
    'a later asset edit does not move the pinned boundary text');
  assert.deepEqual(textsFor(edited, 'subagent'), ['B', 'C']);
  assert.deepEqual(edited.slice(0, rebased.length), rebased, 'the compacted prefix stays stable');
});

test('a checkpoint without a leading system message gets one leading guidance boundary', () => {
  const manager = managerWith([user('after compaction')]);
  manager.appendCustomEntry(TOOL_GUIDANCE_RECORD, {
    version: 1, checkpointId: null, id: 'subagent', text: 'A', position: 0,
  });
  const native = nativeMessages(manager);
  const rebased = project(manager, [guide('subagent', ['subagent_list'], 'A')], native, 'checkpoint-1');

  assert.equal(rebased[0]?.role, 'system');
  assert.equal(sectionsOf(rebased[0])[toolGuidanceSection('subagent')], 'A');
  assert.equal(rebased[1], native[0], 'native messages follow the leading boundary untouched');
  assert.deepEqual(storedRecords(manager).at(-1), {
    version: 1, checkpointId: 'checkpoint-1', id: 'subagent', text: 'A', position: 'head',
  });
});

test('a malformed journal record fails explicitly with no schema fallback', () => {
  const broken = managerWith([declaration('subagent_list')]);
  const cases: unknown[] = [
    { version: 2, checkpointId: null, id: 'subagent', text: 'A', position: 0 },
    { version: 1, checkpointId: null, id: 'subagent', text: 'A', position: 'anchor' },
    { version: 1, checkpointId: null, id: 'subagent', text: 'A', position: 'tail' },
    { version: 1, checkpointId: null, id: 'subagent', text: 'A', position: -1 },
    { version: 1, checkpointId: null, id: 'subagent', text: 'A', position: 1.5 },
    { version: 1, checkpointId: 7, id: 'subagent', text: 'A', position: 0 },
    { version: 1, checkpointId: null, id: '', text: 'A', position: 0 },
    { version: 1, checkpointId: null, id: 'subagent', position: 0 },
    { version: 1, checkpointId: null, id: 'subagent', text: 3, position: 0 },
  ];
  for (const data of cases) {
    const manager = managerWith([declaration('subagent_list')]);
    manager.appendCustomEntry(TOOL_GUIDANCE_RECORD, data);
    assert.throws(
      () => project(manager, [guide('subagent', ['subagent_list'], 'A')]),
      /Malformed harness-tool-guidance entry on the session branch/,
    );
  }
  broken.appendCustomEntry(TOOL_GUIDANCE_RECORD, 'not-an-object');
  assert.throws(
    () => project(broken, [guide('subagent', ['subagent_list'], 'A')]),
    /Malformed harness-tool-guidance entry on the session branch/,
  );
});

test('a same-checkpoint ordinal beyond the native transcript fails instead of clamping', () => {
  const manager = managerWith([declaration('subagent_list'), user('GO')]);
  manager.appendCustomEntry(TOOL_GUIDANCE_RECORD, {
    version: 1, checkpointId: null, id: 'subagent', text: 'A', position: 5,
  });
  assert.throws(
    () => project(manager, [guide('subagent', ['subagent_list'], 'A')]),
    /follows native message 5, but the request has 2 native messages/,
  );
});
