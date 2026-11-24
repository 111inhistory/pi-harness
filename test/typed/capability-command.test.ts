/**
 * `/capability` command surface under the three-collection model.
 *
 * Base, dynamic and blacklist membership are independent. The command only
 * parses arguments, calls the shared tool-access domain and renders structured
 * results; it must never derive a second availability decision.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { capabilityHost, capabilityCommand, type CapabilityTestTool as FakeTool } from './support/capability-host.ts';
import { capabilityArgumentCompletions, parseCapabilityCommand } from '../../src/capability/command.ts';
import { createToolAccessView } from '../../src/capability/tool-access-view.ts';

const tools: readonly FakeTool[] = [
  { name: 'read', description: 'Read a file', exposure: 'direct' },
  { name: 'deck_pages', description: 'List deck pages', exposure: 'deferred' },
  { name: 'script_only', description: 'Script only', exposure: 'codemode' },
  { name: 'codemode', description: 'Run scripts', exposure: 'direct' },
  { name: 'secret', description: 'Internal', exposure: 'hidden' },
  { name: 'mcp__git__status', description: 'Show repository status', exposure: 'deferred', namespace: { name: 'mcp__git', aliases: ['git'] } },
  { name: 'mcp__git__log', description: 'Show commit log', exposure: 'deferred', namespace: { name: 'mcp__git', aliases: ['git'] } },
  { name: 'msg_write', description: 'Send a message to a child', exposure: 'deferred', namespace: { name: 'subagent' } },
  { name: 'subagent_list', description: 'List child agents', exposure: 'deferred', namespace: { name: 'subagent' } },
  { name: 'subagent_create', description: 'Create a child agent', exposure: 'deferred', namespace: { name: 'subagent' } },
];

function install(initial: readonly FakeTool[] = tools, active: string[] = []) {
  const fixture = capabilityHost(initial, active, 'all');
  // Real sessions capture the initial active loadout as the base baseline.
  fixture.api.appendEntry('capability-tool-base', { version: 1, baseline: [...active] });
  const command = capabilityCommand(fixture);
  return { fixture, command };
}

function records(fixture: ReturnType<typeof capabilityHost>, customType: string): unknown[] {
  return fixture.entries().filter((entry) => entry.customType === customType).map((entry) => entry.data);
}

/** Drive the production picker component with real key transitions. */
function drivePicker(steps: readonly string[]) {
  return async (
    factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => {
      handleInput(data: string): void;
    },
  ): Promise<unknown> => new Promise((resolve) => {
    const keys: Record<string, string> = {
      'tui.select.up': '\x1b[A', 'tui.select.down': '\x1b[B',
      'tui.select.confirm': '\r', 'tui.select.cancel': '\x1b',
      'tui.editor.cursorLeft': '\x1b[D', 'tui.editor.cursorRight': '\x1b[C',
      'tui.input.tab': '\t',
    };
    const component = factory(
      { requestRender() {} },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      { matches(data: string, action: string) { return keys[action] === data; } },
      resolve,
    );
    for (const step of steps) component.handleInput(step);
  });
}

test('the command line parses the five subcommands and list flags', () => {
  assert.deepEqual(parseCapabilityCommand(''), { verb: 'list', activatable: false, usable: false, filter: null });
  assert.deepEqual(parseCapabilityCommand('list'), { verb: 'list', activatable: false, usable: false, filter: null });
  assert.deepEqual(parseCapabilityCommand('help'), { verb: 'help' });
  assert.deepEqual(parseCapabilityCommand('list --activatable --usable --filter=git'), {
    verb: 'list', activatable: true, usable: true, filter: 'git',
  });
  assert.deepEqual(parseCapabilityCommand('list --filter git'), {
    verb: 'list', activatable: false, usable: false, filter: 'git',
  });
  assert.deepEqual(parseCapabilityCommand('base add read mcp://git'), { verb: 'base', action: 'add', targets: ['read', 'mcp://git'] });
  assert.deepEqual(parseCapabilityCommand('base remove read'), { verb: 'base', action: 'remove', targets: ['read'] });
  assert.deepEqual(parseCapabilityCommand('base list'), { verb: 'base', action: 'list', targets: [] });
  assert.deepEqual(parseCapabilityCommand('activate'), { verb: 'activate', targets: [] });
  assert.deepEqual(parseCapabilityCommand('deactivate read'), { verb: 'deactivate', targets: ['read'] });
  assert.deepEqual(parseCapabilityCommand('blacklist add mcp://git'), { verb: 'blacklist', action: 'add', targets: ['mcp://git'] });
  assert.deepEqual(parseCapabilityCommand('blacklist remove read'), { verb: 'blacklist', action: 'remove', targets: ['read'] });
  assert.deepEqual(parseCapabilityCommand('blacklist list'), { verb: 'blacklist', action: 'list', targets: [] });
  assert.deepEqual(parseCapabilityCommand('activate namespace://subagent[ns] msg_write subagent_list'), {
    verb: 'activate', targets: ['namespace://subagent[ns]', 'msg_write', 'subagent_list'],
  });
  assert.deepEqual(parseCapabilityCommand('activate mcp://git[ns] mcp__git__status -mcp__git__log'), {
    verb: 'activate', targets: ['mcp://git[ns]', 'mcp__git__status', '-mcp__git__log'],
  });
  assert.deepEqual(parseCapabilityCommand('activate namespace://subagent[ns] msg_write mcp://git[ns] mcp__git__status read'), {
    verb: 'activate',
    targets: ['namespace://subagent[ns]', 'msg_write', 'mcp://git[ns]', 'mcp__git__status', 'read'],
  });
  assert.deepEqual(parseCapabilityCommand('base add namespace://subagent -subagent_create'), {
    verb: 'base', action: 'add', targets: ['namespace://subagent', '-subagent_create'],
  });
  assert.throws(() => parseCapabilityCommand('enable read'), /Unknown subcommand/);
  assert.throws(() => parseCapabilityCommand('help now'), /takes no arguments/);
  assert.throws(() => parseCapabilityCommand('activate --no-schema read'), /Unexpected flag/);
  assert.throws(() => parseCapabilityCommand('activate --schema read'), /Unexpected flag/);
  assert.throws(() => parseCapabilityCommand('list active'), /Unexpected list argument/);
  assert.throws(() => parseCapabilityCommand('list --all'), /Unknown list flag/);
  assert.throws(() => parseCapabilityCommand('base'), /Usage: \/capability base/);
  assert.throws(() => parseCapabilityCommand('blacklist add'), /Usage: \/capability blacklist add/);
  assert.throws(() => parseCapabilityCommand('base list read'), /takes no targets/);
});

test('list defaults to current base+dynamic members and keeps facts independent', async () => {
  const { fixture, command } = install(tools, ['read']);
  await command.run('base add deck_pages');
  await command.run('activate mcp__git__status');
  const beforeBrowsing = fixture.branch().length;
  await command.run('list');
  const text = command.notifications.at(-1)?.text ?? '';
  assert.match(text, /Capability · 3 tools · current/);
  assert.match(text, /deck_pages {2}\[base · usable\]/);
  assert.match(text, /mcp__git__status {2}\[dynamic · usable\]/);
  assert.doesNotMatch(text, /secret|Internal/, 'hidden tools stay out of the human view');
  await command.run('list enabled active');
  const retiredQuery = command.notifications.at(-1)?.text ?? '';
  assert.match(retiredQuery, /Unexpected list argument/, 'a retired bareword is rejected instead of mutating');
  assert.doesNotMatch(retiredQuery, /Internal/, 'browsing never exposes hidden tool descriptions');
  assert.equal(fixture.branch().length, beforeBrowsing, 'list and invalid list arguments write no records');
});

test('base add writes BASE and activates; base remove only removes BASE membership', async () => {
  const { fixture, command } = install(tools, ['codemode']);
  const before = records(fixture, 'capability-tool-base').length;
  await command.run('base add script_only');
  assert.match(command.notifications.at(-1)?.text ?? '', /Capability · base add script_only/);
  assert.ok(fixture.activeNames().includes('script_only'));
  assert.equal(records(fixture, 'capability-tool-base').length, before + 1);

  await command.run('base remove script_only');
  assert.match(command.notifications.at(-1)?.text ?? '', /Capability · base remove script_only/);
  assert.match(command.notifications.at(-1)?.text ?? '', /Recorded base removal intent/);
  assert.doesNotMatch(command.notifications.at(-1)?.text ?? '', /Changed/);
  assert.equal(fixture.activeNames().includes('script_only'), false);
  assert.equal(records(fixture, 'capability-tool-base').length, before + 2);
});

test('activate writes DYNAMIC and deactivate only removes DYNAMIC membership', async () => {
  const { fixture, command } = install(tools, ['codemode']);
  await command.run('activate script_only');
  assert.match(command.notifications.at(-1)?.text ?? '', /Capability · activate script_only/);
  assert.ok(fixture.activeNames().includes('script_only'));
  assert.equal(records(fixture, 'capability-tool-dynamic').length, 1);

  await command.run('deactivate script_only');
  assert.match(command.notifications.at(-1)?.text ?? '', /Capability · deactivate script_only/);
  assert.match(command.notifications.at(-1)?.text ?? '', /Recorded deactivation intent/);
  assert.equal(fixture.activeNames().includes('script_only'), false);
});

test('one activate command accepts multiple tool names and records the batch once', async () => {
  const { fixture, command } = install(tools, ['codemode']);
  await command.run('activate deck_pages mcp__git__status script_only');
  assert.deepEqual(new Set(fixture.activeNames()), new Set([
    'codemode', 'deck_pages', 'mcp__git__status', 'script_only',
  ]));
  assert.deepEqual(records(fixture, 'capability-tool-dynamic'), [{
    version: 1,
    load: ['mcp://git'],
    activate: ['deck_pages', 'mcp__git__status', 'script_only'],
  }]);
  const result = command.notifications.at(-1)?.text ?? '';
  assert.match(result, /Activated dynamically/);
  for (const name of ['deck_pages', 'mcp__git__status', 'script_only']) {
    assert.ok(result.includes(name), `the command reports the outcome for ${name}`);
  }
});

test('target-local schema modifiers stay one batch and report per-tool modes', async () => {
  const { fixture, command } = install(tools, ['codemode']);
  fixture.api.appendEntry('codemode-mode', { version: 1, mode: 'only' });
  await command.run('activate namespace://subagent[ns,lazy] msg_write subagent_list[no-lazy] -subagent_create');
  const text = command.notifications.at(-1)?.text ?? '';
  assert.match(text, /Activated dynamically/);
  assert.match(text, /Schema on demand requested \(lazy\)/);
  assert.match(text, /Schema-backed requested \(no-lazy\)/);
  assert.match(text, /Excluded from this selection/);
  assert.deepEqual(records(fixture, 'capability-tool-dynamic'), [{
    version: 1,
    load: ['namespace://subagent'],
    activate: ['msg_write', 'subagent_list'],
    noSchema: ['msg_write'],
    schema: ['subagent_list'],
  }]);
  assert.deepEqual(new Set(fixture.activeNames()), new Set(['codemode', 'msg_write', 'subagent_list']));

  const before = records(fixture, 'capability-tool-dynamic').length;
  await command.run('activate namespace://subagent[ns,lazy,no-lazy]');
  assert.match(command.notifications.at(-1)?.text ?? '', /Rejected the whole batch: invalid_selection/);
  assert.equal(records(fixture, 'capability-tool-dynamic').length, before);
});

test('base remove, deactivate and blacklist remove accept multiple tool names', async () => {
  const { fixture, command } = install(tools, ['codemode']);
  const members = ['deck_pages', 'mcp__git__status', 'script_only'];
  await command.run(`base add ${members.join(' ')}`);
  await command.run('base remove deck_pages mcp__git__status');
  let view = createToolAccessView(fixture.api, fixture.branch());
  assert.equal(view.base('deck_pages'), false);
  assert.equal(view.base('mcp__git__status'), false);
  assert.equal(view.base('script_only'), true, 'unmentioned baseline member survives');

  await command.run(`activate ${members.join(' ')}`);
  await command.run('deactivate deck_pages mcp__git__status');
  view = createToolAccessView(fixture.api, fixture.branch());
  assert.equal(view.dynamic('deck_pages'), false);
  assert.equal(view.dynamic('mcp__git__status'), false);
  assert.equal(view.dynamic('script_only'), true, 'unmentioned dynamic member survives');

  await command.run(`blacklist add ${members.join(' ')}`);
  await command.run('blacklist remove deck_pages mcp__git__status');
  view = createToolAccessView(fixture.api, fixture.branch());
  assert.equal(view.blacklisted('deck_pages'), false);
  assert.equal(view.blacklisted('mcp__git__status'), false);
  assert.equal(view.blacklisted('script_only'), true, 'unmentioned blacklist member survives');
});

test('a tool in both collections survives removing either membership', async () => {
  const { fixture, command } = install(tools, ['codemode']);
  await command.run('base add script_only');
  await command.run('activate script_only');

  await command.run('base remove script_only');
  assert.ok(fixture.activeNames().includes('script_only'), 'dynamic membership preserves the tool');

  await command.run('base add script_only');
  await command.run('deactivate script_only');
  assert.ok(fixture.activeNames().includes('script_only'), 'base membership preserves the tool');

  await command.run('base remove script_only');
  assert.equal(fixture.activeNames().includes('script_only'), false);
});

test('a hard-banned base member leaves the availability list while base keeps the record', async () => {
  const { fixture, command } = install(tools, ['read', 'codemode']);
  await command.run('base add read deck_pages');
  await command.run('blacklist add deck_pages');

  await command.run('list --activatable');
  const activatable = command.notifications.at(-1)?.text ?? '';
  assert.match(activatable, /read {2}\[base · usable\]/);
  assert.doesNotMatch(activatable, /deck_pages/, 'a hard-banned member is not an activation candidate');
  assert.match(activatable, /script_only {2}\[activatable\]/);

  await command.run('list --usable');
  const usable = command.notifications.at(-1)?.text ?? '';
  assert.match(usable, /read {2}\[base · usable\]/);
  assert.doesNotMatch(usable, /deck_pages/);

  await command.run('base list');
  assert.match(command.notifications.at(-1)?.text ?? '', /deck_pages {2}\(1 tool · branch\)/,
    'the membership record is retained');
  assert.equal(createToolAccessView(fixture.api, fixture.branch()).blocked('deck_pages'), true,
    'the manual ban stays effective');
  await command.run('blacklist remove deck_pages');
  assert.equal(createToolAccessView(fixture.api, fixture.branch()).blocked('deck_pages'), false,
    'only an explicit blacklist removal reopens it');
});

test('dynamic activation never overrides a local blacklist', async () => {
  const { fixture, command } = install(tools, ['codemode']);
  await command.run('blacklist add deck_pages');
  await command.run('activate deck_pages');
  const view = createToolAccessView(fixture.api, fixture.branch());
  assert.equal(view.dynamic('deck_pages'), true);
  assert.equal(view.blacklisted('deck_pages'), true);
  assert.equal(view.blocked('deck_pages'), true);
  assert.equal(view.requested('deck_pages'), false);
  assert.equal(fixture.activeNames().includes('deck_pages'), false);
});

test('list --usable filters callable tools while --activatable expands candidates', async () => {
  const { fixture, command } = install(tools, ['read', 'codemode']);
  await command.run('base add deck_pages');
  // Simulate a requested base member that the SDK has not left active.
  fixture.api.setActiveTools(['read', 'codemode']);

  await command.run('list --usable');
  const usable = command.notifications.at(-1)?.text ?? '';
  assert.match(usable, /read {2}\[base · usable\]/);
  assert.match(usable, /codemode {2}\[base · usable\]/);
  assert.doesNotMatch(usable, /deck_pages/, 'usable is a filter, not the requested baseline');

  await command.run('list --activatable');
  const activatable = command.notifications.at(-1)?.text ?? '';
  assert.match(activatable, /read {2}\[base · usable\]/, 'activatable expands the current membership');
  assert.match(activatable, /deck_pages {2}\[base · activatable\]/, 'base membership does not guarantee SDK active');
  assert.match(activatable, /script_only {2}\[activatable\]/);

  await command.run('list --usable --activatable');
  const both = command.notifications.at(-1)?.text ?? '';
  assert.match(both, /read {2}\[base · usable\]/);
  assert.match(both, /deck_pages {2}\[base · activatable\]/, 'an inactive requested member can still be activatable');
  assert.match(both, /script_only {2}\[activatable\]/);
});

test('a durable record with an SDK effect failure is reported separately', async () => {
  const { fixture, command } = install(tools, ['codemode']);
  fixture.api.setActiveTools = () => { throw new Error('sdk effect failed'); };

  await command.run('base add script_only');
  const text = command.notifications.at(-1)?.text ?? '';
  assert.equal(command.notifications.at(-1)?.type, 'error');
  assert.match(text, /membership record was written/);
  assert.match(text, /runtime effect failed: sdk effect failed/);
  assert.match(text, /Nothing was rolled back/);
  assert.deepEqual(records(fixture, 'capability-tool-base').filter((data) =>
    typeof data === 'object' && data !== null && Array.isArray((data as { add?: unknown }).add)), [{ version: 1, add: ['script_only'] }]);
});

test('a manual blacklist blocks a base member immediately and survives a base removal', async () => {
  const { fixture, command } = install(tools, ['codemode']);
  await command.run('base add script_only');
  await command.run('blacklist add script_only');
  const added = command.notifications.at(-1)?.text ?? '';
  assert.match(added, /Still blacklisted \(raw\)/);
  assert.doesNotMatch(added, /Ban overridden by base/, 'a manual ban is a hard fence, not an exception');
  assert.match(added, /Remaining blacklist sources/);
  assert.equal(fixture.activeNames().includes('script_only'), false,
    'a Codemode-only member loses its declaration now');

  await command.run('list');
  assert.doesNotMatch(command.notifications.at(-1)?.text ?? '', /script_only/,
    'a hard-banned member is not requested and not listed as available');

  await command.run('base list');
  assert.match(command.notifications.at(-1)?.text ?? '', /script_only {2}\(1 tool · branch\)/,
    'the base record still reports the membership');

  await command.run('blacklist list');
  assert.match(command.notifications.at(-1)?.text ?? '', /Capability · blacklist · 1 target/);
  assert.match(command.notifications.at(-1)?.text ?? '', /script_only/);
  assert.match(command.notifications.at(-1)?.text ?? '', /preset -tool/);

  await command.run('base remove script_only');
  assert.equal(createToolAccessView(fixture.api, fixture.branch()).blocked('script_only'), true,
    'removing base does not lift the manual ban');

  await command.run('blacklist remove script_only');
  const text = command.notifications.at(-1)?.text ?? '';
  assert.match(text, /Capability · blacklist remove script_only/);
  assert.match(text, /Recorded blacklist removal intent/);
  assert.equal(fixture.activeNames().includes('script_only'), false);
});

test('an activate picker selects through the hierarchical component and cancellation writes nothing', async () => {
  const fixture = capabilityHost(tools, [], 'all');
  const command = capabilityCommand(fixture, { custom: drivePicker(['\x1b[B', '\t', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\r']) });
  await command.run('activate');
  assert.ok(fixture.activeNames().includes('deck_pages'));

  const cancelled = capabilityHost(tools, [], 'all');
  const cancelCommand = capabilityCommand(cancelled, { custom: drivePicker(['\x1b']) });
  await cancelCommand.run('activate');
  assert.match(cancelCommand.notifications.at(-1)?.text ?? '', /Activate cancelled/);
  assert.deepEqual(cancelled.entries(), []);
  assert.deepEqual(cancelled.activeNames(), []);
});

test('a deactivate picker offers only dynamic members', async () => {
  const { fixture } = install(tools, ['codemode']);
  await capabilityCommand(fixture).run('activate script_only');
  const command = capabilityCommand(fixture, { custom: drivePicker(['\t', '\x1b[B', '\r']) });
  await command.run('deactivate');
  assert.equal(fixture.activeNames().includes('script_only'), false);
});

test('help is read-only and covers collections, target modifiers and picker behavior', async () => {
  const { fixture, command } = install(tools, ['read']);
  const before = fixture.entries().length;
  const active = fixture.activeNames();
  await command.run('help');
  const text = command.notifications.at(-1)?.text ?? '';
  assert.match(text, /Capability help \(read-only\)/);
  assert.match(text, /namespace:\/\/subagent\[ns\] msg_write/);
  assert.match(text, /namespace:\/\/subagent\[ns,lazy\]/);
  assert.match(text, /msg_write\[lazy\] subagent_list\[no-lazy\]/);
  assert.match(text, /-subagent_create/);
  assert.match(text, /base remove removes baseline membership/);
  assert.match(text, /Codemode active and usable/);
  assert.match(text, /hierarchical multi-select/);
  assert.equal(fixture.entries().length, before, 'help writes no records');
  assert.deepEqual(fixture.activeNames(), active, 'help changes no active tools');
});

test('deactivate picker emits exact selected names, never a namespace modifier', async () => {
  const { fixture } = install(tools, ['codemode']);
  await capabilityCommand(fixture).run('activate namespace://subagent[ns] msg_write subagent_list');
  const command = capabilityCommand(fixture, {
    custom: drivePicker(['\x1b[C', '\t', '\x1b[D', '\x1b[B', '\r']),
  });
  await command.run('deactivate');
  const text = command.notifications.at(-1)?.text ?? '';
  assert.match(text, /Capability · deactivate msg_write/);
  assert.doesNotMatch(text, /namespace:\/\//, 'deactivation never emits a group/modifier token');
  const view = createToolAccessView(fixture.api, fixture.branch());
  assert.equal(view.dynamic('msg_write'), false);
  assert.equal(view.dynamic('subagent_list'), true);
  assert.deepEqual(records(fixture, 'capability-tool-dynamic').at(-1), {
    version: 1,
    deactivate: ['msg_write'],
  });
});

test('a record write failure reports an error and applies no effect', async () => {
  const { fixture, command } = install(tools, []);
  fixture.failAppend(true);
  await command.run('base add read');
  assert.equal(command.notifications.at(-1)?.type, 'error');
  assert.match(command.notifications.at(-1)?.text ?? '', /could not be written/);
  assert.equal(fixture.activeNames().includes('read'), false);
});

test('completions cover verbs, actions, list flags and live targets', async () => {
  const { fixture } = install(tools, []);
  const complete = (prefix: string) => capabilityArgumentCompletions(prefix, fixture.api, fixture.branch());
  assert.deepEqual(complete('')?.map((item) => item.value), ['base ', 'blacklist ', 'activate ', 'deactivate ', 'help ', 'list ']);
  assert.deepEqual(complete('ba')?.map((item) => item.value), ['base ']);
  assert.deepEqual(complete('he')?.map((item) => item.value), ['help ']);
  assert.deepEqual(complete('base ')?.map((item) => item.value), ['base add ', 'base remove ', 'base list ']);
  assert.deepEqual(complete('blacklist ')?.map((item) => item.value), ['blacklist add ', 'blacklist remove ', 'blacklist list ']);
  assert.deepEqual(complete('list ')?.map((item) => item.value), ['list --activatable', 'list --usable', 'list --filter=']);
  assert.ok(complete('base add ')?.some((item) => item.value === 'base add deck_pages '));
  assert.ok(complete('base add ')?.some((item) => item.value.startsWith('base add mcp://git ')));
  assert.ok(complete('base add ')?.some((item) => item.value === 'base add namespace://subagent '));
  assert.ok(!complete('base add ')?.some((item) => item.value === 'base add secret '), 'hidden tools are never offered');
});
