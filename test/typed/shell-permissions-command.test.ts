import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import type { AutocompleteProviderFactory } from '@earendil-works/pi-coding-agent';
import { harnessConfigFor, resolveHarnessConfig } from '../../src/harness-config.ts';
import shellExtension from '../../src/shell-approval/extension.ts';

type Command = Parameters<ExtensionAPI['registerCommand']>[1];

function fixture(enabled = true) {
  let command: Command | undefined;
  const manager = SessionManager.inMemory('/tmp/project');
  const bus = new EventEmitter();
  const handlers = new Map<string, ((event: unknown, context: ExtensionCommandContext) => unknown)[]>();
  const wrappers: AutocompleteProviderFactory[] = [];
  const api = {
    on(name: string, handler: (event: unknown, context: ExtensionCommandContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    events: {
      on(name: string, handler: (data: unknown) => void) { bus.on(name, handler); return () => bus.off(name, handler); },
      emit(name: string, data: unknown) { bus.emit(name, data); },
    },
    appendEntry(kind: string, data: unknown) { manager.appendCustomEntry(kind, data); },
    registerCommand(name: string, options: Command) { assert.equal(name, 'permissions'); command = options; },
  } as unknown as ExtensionAPI;
  harnessConfigFor(api, resolveHarnessConfig([{ source: 'fixture.json', value: {
    shell: { approval: { enabled, reviewer: { enabled: false } } },
  } }]));
  shellExtension(api);
  assert.ok(command);
  const notifications: string[] = [];
  const statuses: (string | undefined)[] = [];
  const pickers: string[][] = [];
  let pick: number | undefined;
  const context = {
    hasUI: true, mode: 'tui', sessionManager: manager,
    ui: {
      addAutocompleteProvider(factory: AutocompleteProviderFactory) { wrappers.push(factory); },
      notify(message: string) { notifications.push(message); },
      setStatus(_key: string, value: string | undefined) { statuses.push(value); },
      async select(_title: string, options: string[]) { pickers.push(options); return pick === undefined ? undefined : options[pick]; },
    },
  } as unknown as ExtensionCommandContext;
  return {
    command, context, notifications, statuses, pickers, wrappers,
    start() { for (const handler of handlers.get('session_start') ?? []) handler({}, context); },
    choose(index: number | undefined) { pick = index; },
  };
}

test('/permissions completes modes, filters prefixes, and rejects extra arguments', async () => {
  const { command } = fixture();
  assert.ok(command.getArgumentCompletions);
  for (const [prefix, expected] of [
    ['', ['ask', 'auto', 'yolo']], ['a', ['ask', 'auto']], [' au', ['auto']], ['Y', ['yolo']],
    ['invalid', []], ['ask extra', []], ['auto ', []],
  ] as const) {
    const matches = await command.getArgumentCompletions(prefix);
    assert.deepEqual(matches?.map(item => item.value) ?? [], expected);
  }
  const matches = await command.getArgumentCompletions('');
  assert.deepEqual(matches?.map(item => item.label), ['Ask', 'Auto Approve', 'YOLO']);
  assert.ok(matches?.every(item => item.description));
});

test('/permissions Tab uses the native provider and inserts the full mode argument', async () => {
  const f = fixture();
  f.start();
  f.start();
  assert.equal(f.wrappers.length, 1, 'register one editor wrapper across session starts');
  const base = new CombinedAutocompleteProvider([{ name: 'permissions', ...f.command }], '/tmp');
  const provider = f.wrappers[0]!(base);
  const line = '/permissions a';
  const suggestions = await provider.getSuggestions([line], 0, line.length, {
    force: true, signal: new AbortController().signal,
  });
  assert.deepEqual(suggestions?.items.map(item => item.value), ['ask', 'auto']);
  assert.ok(suggestions);
  const chosen = suggestions.items.find(item => item.value === 'auto')!;
  const applied = provider.applyCompletion([line], 0, line.length, chosen, suggestions.prefix);
  assert.equal(applied.lines[0]?.trimEnd(), '/permissions auto');
});

test('/permissions picker changes the mode; cancelling keeps it; explicit modes use English status', async () => {
  const f = fixture();
  f.choose(0);
  await f.command.handler('', f.context);
  assert.match(f.pickers[0]![0]!, /Ask.*rule/);
  assert.equal(f.statuses.at(-1), 'Permissions: Ask');
  assert.match(f.notifications.at(-1)!, /Permissions set to Ask/);
  f.choose(undefined);
  await f.command.handler('', f.context);
  assert.equal(f.notifications.length, 1);
  await f.command.handler('yolo', f.context);
  assert.equal(f.statuses.at(-1), 'Permissions: YOLO');
  await f.command.handler('auto', f.context);
  assert.equal(f.statuses.at(-1), 'Permissions: Auto Approve (manual fallback)');
  await f.command.handler('invalid', f.context);
  assert.match(f.notifications.at(-1)!, /^Usage:/);
});

test('/permissions reports disabled approval and supports noninteractive status without a picker', async () => {
  const disabled = fixture(false);
  await disabled.command.handler('ask', disabled.context);
  assert.match(disabled.notifications[0]!, /Shell approval is disabled/);
  const f = fixture();
  f.context.hasUI = false;
  await f.command.handler('', f.context);
  assert.equal(f.pickers.length, 0);
  assert.match(f.notifications[0]!, /Permissions: Auto Approve/);
});
