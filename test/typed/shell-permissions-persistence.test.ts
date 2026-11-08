/**
 * Shell permission mode persistence against a real, file-backed SessionManager.
 * The extension only appends its own custom entry through the public
 * ExtensionAPI; reopening the same manager file proves the choice is durable
 * rather than held in a fixture array.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { UserMessage } from '@earendil-works/pi-ai';
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { harnessConfigFor, resolveHarnessConfig } from '../../src/harness-config.ts';
import shellExtension from '../../src/shell-approval/extension.ts';

const CWD = '/tmp/shell-permissions-project';
const MODE_ENTRY = 'harness-shell-permission-mode';
const AUTO = 'Permissions: Auto Approve (manual fallback)';

type Command = Parameters<ExtensionAPI['registerCommand']>[1];
type Notification = { message: string; type: string | undefined };

function user(text: string): UserMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
}

interface Fixture {
  readonly command: Command;
  readonly context: ExtensionCommandContext;
  readonly notifications: Notification[];
  readonly statuses: (string | undefined)[];
  readonly pickers: string[][];
  start(reason?: 'startup' | 'reload' | 'new' | 'resume' | 'fork'): void;
  tree(): void;
  beforeSwitch(): void;
  beforeTree(): void;
  choose(index: number | undefined): void;
  deferSelect(): void;
  resolveSelect(choice: string | undefined): void;
}

/** Minimal registration surface; persistence goes through the public appendEntry call. */
function fixture(manager: SessionManager): Fixture {
  const handlers = new Map<string, ((event: unknown, context: ExtensionContext) => unknown)[]>();
  const bus = new EventEmitter();
  let command: Command | undefined;
  const api = {
    on(name: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    events: {
      on(name: string, handler: (data: unknown) => void) { bus.on(name, handler); return () => bus.off(name, handler); },
      emit(name: string, data: unknown) { bus.emit(name, data); },
    },
    appendEntry(customType: string, data?: unknown) { manager.appendCustomEntry(customType, data); },
    registerCommand(name: string, options: Command) { assert.equal(name, 'permissions'); command = options; },
  } as unknown as ExtensionAPI;
  harnessConfigFor(api, resolveHarnessConfig([{ source: 'fixture.json', value: {
    shell: { approval: { enabled: true, reviewer: { enabled: false } } },
  } }]));
  shellExtension(api);
  assert.ok(command, 'the permissions command is registered');

  const notifications: Notification[] = [];
  const statuses: (string | undefined)[] = [];
  const pickers: string[][] = [];
  let pick: number | undefined;
  let deferred = false;
  const selectResolvers: ((choice: string | undefined) => void)[] = [];
  const context = {
    cwd: CWD, hasUI: true, mode: 'tui', sessionManager: manager,
    isProjectTrusted: () => false,
    signal: undefined,
    ui: {
      addAutocompleteProvider() {},
      notify(message: string, type?: string) { notifications.push({ message, type }); },
      setStatus(_key: string, value: string | undefined) { statuses.push(value); },
      select(_title: string, options: string[]) {
        pickers.push(options);
        if (deferred) return new Promise<string | undefined>(resolve => { selectResolvers.push(resolve); });
        return Promise.resolve(pick === undefined ? undefined : options[pick]);
      },
    },
  } as unknown as ExtensionCommandContext;

  const dispatch = (name: string, event: unknown): void => {
    for (const handler of handlers.get(name) ?? []) handler(event, context);
  };
  return {
    command, context, notifications, statuses, pickers,
    start(reason = 'startup') { dispatch('session_start', { type: 'session_start', reason }); },
    tree() { dispatch('session_tree', { type: 'session_tree', newLeafId: manager.getLeafId(), oldLeafId: null }); },
    beforeSwitch() { dispatch('session_before_switch', { type: 'session_before_switch', reason: 'resume' }); },
    beforeTree() { dispatch('session_before_tree', { type: 'session_before_tree', preparation: {} }); },
    choose(index: number | undefined) { pick = index; },
    deferSelect() { deferred = true; },
    resolveSelect(choice: string | undefined) {
      const resolve = selectResolvers.shift();
      assert.ok(resolve, 'a picker is waiting');
      resolve(choice);
    },
  };
}

function persistedModes(manager: SessionManager): readonly unknown[] {
  return manager.getBranch()
    .filter((entry): entry is Extract<typeof entry, { type: 'custom' }> =>
      entry.type === 'custom' && entry.customType === MODE_ENTRY)
    .map(entry => entry.data);
}

function temporarySession(t: test.TestContext): { dir: string; manager: SessionManager; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shell-permission-mode-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(CWD, dir);
  manager.appendMessage(user('seed conversation'));
  const file = manager.getSessionFile();
  assert.ok(file, 'the seeded conversation is file-backed');
  return { dir, manager, file };
}

test('an explicit YOLO choice is written to disk and restored on resume and reload', async t => {
  const { dir, manager, file } = temporarySession(t);
  const first = fixture(manager);
  first.start('startup');
  assert.equal(first.statuses.at(-1), AUTO);
  assert.deepEqual(persistedModes(manager), []);

  await first.command.handler('yolo', first.context);
  assert.equal(first.statuses.at(-1), 'Permissions: YOLO');
  assert.match(first.notifications.at(-1)?.message ?? '', /Permissions set to YOLO/);
  assert.deepEqual(persistedModes(manager), [{ version: 1, mode: 'yolo' }]);
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
    type?: string; customType?: string; data?: unknown;
  });
  assert.ok(lines.some(line => line.type === 'custom' && line.customType === MODE_ENTRY
    && JSON.stringify(line.data) === JSON.stringify({ version: 1, mode: 'yolo' })), 'the choice is on disk');

  const reopened = SessionManager.open(file, dir);
  const resumed = fixture(reopened);
  resumed.start('resume');
  assert.equal(resumed.statuses.at(-1), 'Permissions: YOLO');

  const reloaded = fixture(reopened);
  reloaded.start('reload');
  assert.equal(reloaded.statuses.at(-1), 'Permissions: YOLO');
});

test('a brand-new session without a persisted choice uses the configured default mode', async t => {
  const { manager } = temporarySession(t);
  const f = fixture(manager);
  f.start('startup');
  await f.command.handler('yolo', f.context);
  assert.equal(f.statuses.at(-1), 'Permissions: YOLO');

  const fresh = SessionManager.inMemory(CWD);
  f.context.sessionManager = fresh;
  f.start('new');
  assert.equal(f.statuses.at(-1), AUTO, 'a new session does not inherit a stale in-memory mode');
  assert.deepEqual(persistedModes(fresh), [], 'restoring does not write a choice');
  assert.deepEqual(persistedModes(manager), [{ version: 1, mode: 'yolo' }], 'the previous session retains its choice');
});

test('re-selecting the choice restored from the session does not append a duplicate', async t => {
  const { dir, manager, file } = temporarySession(t);
  const first = fixture(manager);
  first.start('startup');
  await first.command.handler('yolo', first.context);
  await first.command.handler('yolo', first.context);
  assert.deepEqual(persistedModes(manager), [{ version: 1, mode: 'yolo' }], 'same choice is idempotent');

  const reopened = SessionManager.open(file, dir);
  const resumed = fixture(reopened);
  resumed.start('resume');
  assert.equal(resumed.statuses.at(-1), 'Permissions: YOLO');
  await resumed.command.handler('yolo', resumed.context);
  assert.deepEqual(persistedModes(reopened), [{ version: 1, mode: 'yolo' }], 'restored choice is not re-written');
  assert.equal(resumed.statuses.at(-1), 'Permissions: YOLO');
});

test('tree navigation restores the latest mode on the active branch', async t => {
  const { manager } = temporarySession(t);
  const base = manager.getLeafId();
  assert.ok(base);
  const f = fixture(manager);
  f.start('startup');

  await f.command.handler('ask', f.context);
  const ask = manager.getLeafId();
  assert.ok(ask);
  const between = manager.appendMessage(user('after ask'));
  await f.command.handler('yolo', f.context);
  const yolo = manager.getLeafId();
  assert.ok(yolo);

  for (const [target, expected] of [
    [base, AUTO],
    [ask, 'Permissions: Ask'],
    [between, 'Permissions: Ask'],
    [yolo, 'Permissions: YOLO'],
  ] as const) {
    manager.branch(target);
    f.tree();
    assert.equal(f.statuses.at(-1), expected, `branch leaf ${target}`);
  }
});

test('a failed append keeps the current mode and reports an error instead of success', async t => {
  const { manager, file } = temporarySession(t);
  const f = fixture(manager);
  f.start('startup');
  assert.equal(f.statuses.at(-1), AUTO);

  // Replace the append target with a directory so the real native write fails.
  unlinkSync(file);
  mkdirSync(file);

  await f.command.handler('yolo', f.context);
  assert.equal(f.statuses.at(-1), AUTO, 'the in-memory mode is unchanged');
  assert.equal(f.notifications.at(-1)?.type, 'error');
  assert.match(f.notifications.at(-1)?.message ?? '', /Could not save permissions/);
  assert.ok(!f.notifications.some(item => /Permissions set to/.test(item.message)));
  assert.deepEqual(persistedModes(manager), [], 'no entry is invented after the failed write');
});

test('a picker that resolves after session teardown neither persists nor changes mode', async t => {
  for (const cancellation of ['switch', 'tree'] as const) {
    const { manager } = temporarySession(t);
    const f = fixture(manager);
    f.start('startup');
    f.deferSelect();

    const pending = f.command.handler('', f.context);
    assert.equal(f.pickers.length, 1, `${cancellation}: picker opened`);
    if (cancellation === 'switch') f.beforeSwitch();
    else f.beforeTree();
    f.resolveSelect(f.pickers[0]![2]!);
    await pending;

    assert.equal(f.statuses.at(-1), AUTO, `${cancellation}: mode unchanged`);
    assert.ok(!f.notifications.some(item => /Permissions set to/.test(item.message)), `${cancellation}: no success`);
    assert.deepEqual(persistedModes(manager), [], `${cancellation}: no entry written to the new branch`);
  }
});

test('a native fork inherits the persisted choice but writes new choices only to its own branch', async t => {
  const { dir, manager, file } = temporarySession(t);
  const source = fixture(manager);
  source.start('startup');
  await source.command.handler('yolo', source.context);

  const forkDir = join(dir, 'forked');
  const fork = SessionManager.forkFrom(file, CWD, forkDir);
  const forked = fixture(fork);
  forked.start('fork');
  assert.equal(forked.statuses.at(-1), 'Permissions: YOLO');

  await forked.command.handler('ask', forked.context);
  assert.equal(forked.statuses.at(-1), 'Permissions: Ask');
  assert.deepEqual(persistedModes(fork), [{ version: 1, mode: 'yolo' }, { version: 1, mode: 'ask' }]);
  assert.deepEqual(persistedModes(manager), [{ version: 1, mode: 'yolo' }], 'the source branch is untouched');
});
