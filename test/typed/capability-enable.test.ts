/**
 * `/capability enable`: the user's own path to a registered tool.
 *
 * These cases drive the command surface and the enable operation directly, with
 * a registry that can change between calls. The registry is deliberately
 * mutable: Pi's MCP extension re-registers a server's tools after `/mcp
 * reconnect`, and a re-registration can be hidden. The operation must therefore
 * resolve every target against the registry at execution time and refuse a
 * registration that is gone, instead of trusting a snapshot from a picker or a
 * session start.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from '@earendil-works/pi-coding-agent';

import { createToolAdmission } from '../../src/capability/admission.ts';
import { createCapabilityCatalog } from '../../src/capability/catalog.ts';
import {
  capabilityArgumentCompletions, installCapabilityCommand, parseCapabilityCommand,
} from '../../src/capability/command.ts';
import {
  CAPABILITY_DISCOVERY_RECORD, discoveryRecords, manualEnabledTools,
} from '../../src/capability/discovery-record.ts';
import { enableCapabilityTargets, resolveEnableTargets } from '../../src/capability/enable.ts';
import { manualToolMatcher } from '../../src/capability/manual-tools.ts';
import { setCapabilityParent, setCapabilityRootOnlyPolicy } from '../../src/capability/scope.ts';

interface FakeTool {
  name: string;
  description?: string;
  exposure?: string;
  namespace?: { name: string; aliases?: readonly string[] };
}

type Entry = { type: string; customType: string; timestamp?: string; data?: unknown };

/**
 * A host that behaves like the SDK's registry: `registerTool` replaces a
 * definition by name, hidden tools are never activated, and the branch keeps
 * the custom entries the command appends.
 */
function host(initial: readonly FakeTool[], active: readonly string[] = []) {
  const state = {
    tools: initial.map((tool) => ({ ...tool })),
    active: new Set(active),
    entries: [] as Entry[],
    failAppend: false,
  };
  const api = {
    getAllTools: () => state.tools,
    getActiveTools: () => [...state.active],
    setActiveTools(names: string[]) {
      state.active = new Set(names.filter((name) => state.tools.some(
        (tool) => tool.name === name && tool.exposure !== 'hidden')));
    },
    appendEntry(customType: string, data?: unknown) {
      if (state.failAppend) throw new Error('the session branch is read-only');
      state.entries.push({ type: 'custom', customType, timestamp: new Date().toISOString(), data });
    },
  };
  return {
    api: api as unknown as ExtensionAPI,
    register(tool: FakeTool) {
      const index = state.tools.findIndex((candidate) => candidate.name === tool.name);
      if (index < 0) state.tools.push({ ...tool });
      else state.tools[index] = { ...tool };
    },
    unregister(name: string) {
      state.tools = state.tools.filter((tool) => tool.name !== name);
    },
    branch: () => state.entries,
    entries: () => state.entries,
    activeNames: () => [...state.active],
    failAppend(value: boolean) { state.failAppend = value; },
  };
}

const tools: readonly FakeTool[] = [
  { name: 'read', description: 'Read a file', exposure: 'direct' },
  { name: 'deck_pages', description: 'List deck pages', exposure: 'deferred' },
  { name: 'secret', description: 'Internal', exposure: 'hidden' },
  { name: 'mcp__git__status', description: 'Show repository status', exposure: 'deferred', namespace: { name: 'mcp__git', aliases: ['git'] } },
  { name: 'mcp__git__log', description: 'Show commit log', exposure: 'deferred', namespace: { name: 'mcp__git', aliases: ['git'] } },
  { name: 'msg_write', description: 'Send a message', exposure: 'deferred', namespace: { name: 'subagent' } },
];

function manualHost(initial: readonly FakeTool[] = tools, active: readonly string[] = []) {
  const fixture = host(initial, active);
  setCapabilityRootOnlyPolicy(fixture.api, manualToolMatcher(['deck_pages', 'secret']));
  return fixture;
}

test('the command line parses browsing and enabling without touching state', () => {
  assert.deepEqual(parseCapabilityCommand(''), { verb: 'list', filter: '' });
  assert.deepEqual(parseCapabilityCommand('  list '), { verb: 'list', filter: '' });
  assert.deepEqual(parseCapabilityCommand('list mcp'), { verb: 'list', category: 'mcp', filter: '' });
  assert.deepEqual(parseCapabilityCommand('list tool git status'), { verb: 'list', category: 'tool', filter: 'git status' });
  assert.deepEqual(parseCapabilityCommand('list git status'), { verb: 'list', filter: 'git status' });
  assert.deepEqual(parseCapabilityCommand('enable'), { verb: 'enable', targets: [] });
  assert.deepEqual(parseCapabilityCommand(' enable  deck_pages   read '), { verb: 'enable', targets: ['deck_pages', 'read'] });
  assert.throws(() => parseCapabilityCommand('search git'), /Unknown subcommand: search/);
  assert.throws(() => parseCapabilityCommand('disable read'), /Unknown subcommand: disable/);
});

test('targets resolve against the live registry: names, servers and namespaces', () => {
  const fixture = manualHost();
  assert.deepEqual(resolveEnableTargets(fixture.api, ['deck_pages']),
    { names: ['deck_pages'], expansions: [], unresolved: [] });
  assert.deepEqual(resolveEnableTargets(fixture.api, ['mcp://git']), {
    names: ['mcp__git__status', 'mcp__git__log'],
    expansions: [{ target: 'mcp://git', tools: ['mcp__git__status', 'mcp__git__log'] }],
    unresolved: [],
  });
  assert.deepEqual(resolveEnableTargets(fixture.api, ['namespace://subagent']), {
    names: ['msg_write'],
    expansions: [{ target: 'namespace://subagent', tools: ['msg_write'] }],
    unresolved: [],
  });
  assert.deepEqual(resolveEnableTargets(fixture.api, ['subagent']).names, ['msg_write'],
    'a bare name that is no tool but a non-MCP namespace expands to its members');
  assert.deepEqual(resolveEnableTargets(fixture.api, ['nope', 'also_nope']),
    { names: [], expansions: [], unresolved: ['nope', 'also_nope'] });
  assert.deepEqual(resolveEnableTargets(fixture.api, ['read', 'read']).names, ['read'], 'a repeated target activates once');
});

test('enable activates, then records, and only records what the SDK activated', () => {
  const fixture = manualHost();
  const result = enableCapabilityTargets(fixture.api, ['deck_pages', 'secret']);
  assert.deepEqual(result.enabled, ['deck_pages']);
  assert.deepEqual(result.skipped, [{ name: 'secret', reason: 'hidden' }]);
  assert.equal(result.recordError, null);
  assert.deepEqual(fixture.activeNames(), ['deck_pages'], 'the hidden tool is not activated');
  assert.equal(fixture.entries().length, 1, 'one record for the operation');
  assert.equal(fixture.entries()[0]?.customType, CAPABILITY_DISCOVERY_RECORD);
  const branch = fixture.branch();
  assert.deepEqual([...manualEnabledTools(branch)], ['deck_pages'], 'the record is the authority');
  assert.equal(createToolAdmission(fixture.api, branch).admits('deck_pages'), true);
  const hit = discoveryRecords(branch)[0]?.result.manual?.[0];
  assert.equal(hit?.ref, 'tool://deck_pages');
  assert.equal(hit?.status, 'available');
});

test('a repeated enable is idempotent and writes no second record', () => {
  const fixture = manualHost();
  enableCapabilityTargets(fixture.api, ['deck_pages']);
  const again = enableCapabilityTargets(fixture.api, ['deck_pages'], { branch: fixture.branch() });
  assert.deepEqual(again.enabled, []);
  assert.deepEqual(again.alreadyEnabled, ['deck_pages']);
  assert.deepEqual(again.skipped, []);
  assert.equal(fixture.entries().length, 1, 'the branch memory does not grow on a repeat');
});

test('an already active but unrecorded manual tool is authorized, not re-activated', () => {
  // `defaultActive`, a restored transcript or another extension can leave a
  // manual tool active without the user's record; activation is not authority.
  const fixture = manualHost(tools, ['deck_pages']);
  assert.equal(createToolAdmission(fixture.api, []).admits('deck_pages'), false);
  const result = enableCapabilityTargets(fixture.api, ['deck_pages']);
  assert.deepEqual(result.enabled, ['deck_pages']);
  assert.equal(createToolAdmission(fixture.api, fixture.branch()).admits('deck_pages'), true);
});

test('a discovery selection is not user authorization', () => {
  // The model discovered the tool before the user classified it as manual. The
  // discovery record selects it for the model; it says nothing about the user's
  // decision, so the command still owes the tool its own authorization record.
  const fixture = manualHost();
  const discovery = {
    type: 'custom', customType: CAPABILITY_DISCOVERY_RECORD,
    data: {
      version: 1, toolCallId: 'call-1', result: {
        status: 'ok', mcp: [], skills: [],
        tools: [{ ref: 'tool://deck_pages', name: 'deck_pages', kind: 'tool', status: 'available' }],
        coverage: { local: 'searched', remote: 'not_searched' },
      },
    },
  };
  const branch = [discovery];
  assert.equal(createToolAdmission(fixture.api, branch).admitsManual('deck_pages'), false,
    'the discovery record does not authorize the manual tool');
  assert.equal(createToolAdmission(fixture.api, branch).admits('deck_pages'), false);

  const result = enableCapabilityTargets(fixture.api, ['deck_pages'], { branch });
  assert.deepEqual(result.enabled, ['deck_pages'], 'the enable is not mistaken for a repeat');
  assert.deepEqual(result.alreadyEnabled, []);
  assert.equal(fixture.entries().length, 1, 'the user authorization record is written');
  const authorized = [...branch, ...fixture.branch()];
  assert.deepEqual([...manualEnabledTools(authorized)], ['deck_pages']);
  assert.equal(createToolAdmission(fixture.api, authorized).admits('deck_pages'), true,
    'the next request admits the tool instead of pruning it again');
});

test('a record write failure is reported and leaves no durable authorization', () => {
  const fixture = manualHost();
  fixture.failAppend(true);
  const result = enableCapabilityTargets(fixture.api, ['deck_pages']);
  assert.match(result.recordError ?? '', /read-only/);
  assert.deepEqual(result.enabled, ['deck_pages'], 'the activation itself is reported honestly');
  assert.deepEqual([...manualEnabledTools(fixture.branch())], [], 'nothing was remembered');
  assert.equal(createToolAdmission(fixture.api, fixture.branch()).admits('deck_pages'), false,
    'without the record the next request prunes the declaration');
});

test('a tool registered after the fact is enableable without a restart', () => {
  const fixture = manualHost([{ name: 'read', description: 'Read a file', exposure: 'direct' }]);
  // The equivalent of Pi's MCP extension registering a tool after `/mcp reconnect`.
  fixture.register({ name: 'mcp__late__deploy', description: 'Deploy late', exposure: 'deferred', namespace: { name: 'mcp__late', aliases: ['late'] } });
  assert.ok(createCapabilityCatalog(fixture.api).entries.some((entry) => entry.name === 'mcp__late__deploy'),
    'browsing reads the live registry');
  const result = enableCapabilityTargets(fixture.api, ['mcp://late']);
  assert.deepEqual(result.enabled, ['mcp__late__deploy']);
  assert.equal(createToolAdmission(fixture.api, fixture.branch()).admits('mcp__late__deploy'), true);
});

test('a registration withdrawn by a reconnect cannot be activated from a stale choice', () => {
  const fixture = manualHost();
  // A picker captured the tool before the reconnect; Pi then re-registers it hidden.
  const chosen = createCapabilityCatalog(fixture.api).entries.map((entry) => entry.name);
  assert.ok(chosen.includes('mcp__git__status'));
  fixture.register({ name: 'mcp__git__status', description: 'Show repository status', exposure: 'hidden', namespace: { name: 'mcp__git', aliases: ['git'] } });
  const result = enableCapabilityTargets(fixture.api, ['mcp__git__status']);
  assert.deepEqual(result.enabled, []);
  assert.deepEqual(result.skipped, [{ name: 'mcp__git__status', reason: 'hidden' }]);
  assert.deepEqual(fixture.entries(), [], 'a refused registration writes no record');
  fixture.unregister('mcp__git__status');
  assert.deepEqual(enableCapabilityTargets(fixture.api, ['mcp__git__status']).unresolved, ['mcp__git__status'],
    'an unregistered tool is an unknown target, not a silent success');
});

test('a child scope cannot enable a manual tool', () => {
  const root = manualHost();
  const childApi = {
    getAllTools: () => tools,
    getActiveTools: () => [] as string[],
    setActiveTools: () => undefined,
    appendEntry: () => undefined,
  };
  setCapabilityParent(childApi, root.api);
  const result = enableCapabilityTargets(childApi as unknown as ExtensionAPI, ['deck_pages']);
  assert.deepEqual(result.enabled, []);
  assert.deepEqual(result.skipped, [{ name: 'deck_pages', reason: 'not_permitted' }]);
});

type Notice = { text: string; type: string };

function command(tools: readonly FakeTool[], active: readonly string[] = []) {
  const fixture = manualHost(tools, active);
  const notifications: Notice[] = [];
  let registered: RegisteredCommand | undefined;
  // The scope policy is stored per catalog object, so the command must run on
  // the same object the fixture configured, not on a copy.
  Object.assign(fixture.api as unknown as Record<string, unknown>, {
    registerCommand: (name: string, options: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) => {
      registered = { name, ...options } as RegisteredCommand;
    },
  });
  const pi = fixture.api;
  installCapabilityCommand(pi);
  assert.ok(registered);
  const branch = fixture.branch();
  const make = (select?: (title: string, options: readonly string[]) => Promise<string | undefined>): ExtensionCommandContext => ({
    ui: {
      notify: (text: string, type: string = 'info') => { notifications.push({ text, type }); },
      ...(select === undefined ? {} : { select }),
    },
    sessionManager: { getBranch: () => branch },
  }) as unknown as ExtensionCommandContext;
  return {
    fixture,
    notifications,
    run: async (raw: string, select?: (title: string, options: readonly string[]) => Promise<string | undefined>) => {
      await registered!.handler(raw, make(select));
    },
    completions: async (prefix: string) => (await registered!.getArgumentCompletions?.(prefix)) ?? null,
  };
}

test('enable reports per-target outcomes and keeps browsing read-only', async () => {
  const fixture = command(tools);
  await fixture.run('enable deck_pages secret ghost');
  const text = fixture.notifications[0]?.text ?? '';
  assert.match(text, /Capability · enable deck_pages secret ghost/);
  assert.match(text, /Enabled\n {2}✔ deck_pages/);
  assert.match(text, /Refused\n {2}✖ secret \(hidden by its registration\)/);
  assert.match(text, /Unknown targets\n {2}\? ghost/);
  assert.equal(fixture.notifications[0]?.type, 'warning', 'a partial result is a warning, not a success');
  assert.deepEqual(fixture.fixture.activeNames(), ['deck_pages']);

  await fixture.run('list deck');
  assert.equal(fixture.notifications[1]?.type, 'info');
  assert.match(fixture.notifications[1]?.text ?? '', /✔ deck_pages {2}\[active, manual\]/);
  assert.equal(fixture.fixture.entries().length, 1, 'list writes nothing');
});

test('a failed record is an error, and a repeat is reported as already enabled', async () => {
  const fixture = command(tools);
  fixture.fixture.failAppend(true);
  await fixture.run('enable deck_pages');
  assert.equal(fixture.notifications[0]?.type, 'error');
  assert.match(fixture.notifications[0]?.text ?? '', /could not be written/);
  fixture.fixture.failAppend(false);
  await fixture.run('enable deck_pages');
  assert.match(fixture.notifications[1]?.text ?? '', /Enabled\n {2}✔ deck_pages/);
  await fixture.run('enable deck_pages');
  assert.match(fixture.notifications[2]?.text ?? '', /Already enabled\n {2}· deck_pages/);
  assert.equal(fixture.fixture.entries().length, 1);
});

test('the picker enables exactly the chosen tool and cancelling changes nothing', async () => {
  const fixture = command(tools, ['read']);
  let offered: readonly string[] = [];
  await fixture.run('enable', async (_title, options) => {
    offered = options;
    return options.find((option) => option.includes('deck_pages'));
  });
  assert.ok(offered.some((option) => option.includes('deck_pages  (Tools')), 'the picker lists the manual tool');
  assert.ok(!offered.some((option) => option.includes('secret')), 'hidden tools are never offered');
  assert.match(fixture.notifications.at(-1)?.text ?? '', /Enabled\n {2}✔ deck_pages/);
  assert.deepEqual(fixture.fixture.activeNames(), ['read', 'deck_pages']);

  await fixture.run('enable', async () => undefined);
  assert.match(fixture.notifications.at(-1)?.text ?? '', /cancelled; no tool was activated/);
  assert.equal(fixture.fixture.entries().length, 1, 'cancellation writes no record');
  assert.deepEqual(fixture.fixture.activeNames(), ['read', 'deck_pages']);
});

test('the picker falls back to a named target when the mode has no terminal UI', async () => {
  const fixture = command(tools);
  await fixture.run('enable', async () => { throw new Error('no tui'); });
  assert.match(fixture.notifications.at(-1)?.text ?? '', /Use \/capability enable <name>/);
  assert.deepEqual(fixture.fixture.activeNames(), []);
  assert.deepEqual(fixture.fixture.entries(), []);
});

test('completion covers both verbs, list categories and live enable targets', async () => {
  const fixture = command(tools);
  const values = async (prefix: string) => (await fixture.completions(prefix))?.map((item) => item.value) ?? null;
  assert.deepEqual(await values(''), ['list ', 'enable ']);
  assert.deepEqual(await values('en'), ['enable ']);
  assert.deepEqual(await values('list '), ['list tool ', 'list mcp ', 'list namespace ']);
  assert.deepEqual(await values('list to'), ['list tool ']);
  assert.equal(await fixture.completions('list tool '), null, 'the rest of a category line is a free filter');
  const enable = await fixture.completions('enable ');
  assert.ok(enable?.some((item) => item.value === 'enable deck_pages '), 'a manual tool is offered to the user');
  assert.ok(enable?.some((item) => item.value === 'enable mcp://git '), 'a server ref is offered');
  assert.ok(enable?.some((item) => item.value === 'enable namespace://subagent '), 'a namespace ref is offered');
  assert.ok(!enable?.some((item) => item.value.includes('secret')), 'hidden tools are never offered');
  const partial = await fixture.completions('enable deck_pages ');
  assert.ok(partial?.some((item) => item.value === 'enable deck_pages read '), 'the chosen tool is dropped from the next argument');
  assert.ok(!partial?.some((item) => item.value === 'enable deck_pages deck_pages '));
});

test('completion sees a tool registered after the session started', async () => {
  const fixture = command([{ name: 'read', description: 'Read a file', exposure: 'direct' }]);
  assert.equal(await fixture.completions('enable deploy'), null);
  fixture.fixture.register({ name: 'mcp__late__deploy', description: 'Deploy late', exposure: 'deferred', namespace: { name: 'mcp__late', aliases: ['late'] } });
  const items = await fixture.completions('enable deploy');
  assert.ok(items?.some((item) => item.value === 'enable mcp__late__deploy '), 'the member completes by its display name');
  const groups = await fixture.completions('enable late');
  assert.ok(groups?.some((item) => item.value === 'enable mcp://late '), 'the server ref completes by its alias');
});

test('an unknown subcommand is refused without touching tools or the branch', async () => {
  const fixture = command(tools, ['read']);
  await fixture.run('disable read');
  assert.equal(fixture.notifications[0]?.type, 'error');
  assert.match(fixture.notifications[0]?.text ?? '', /invalid_command_args/);
  assert.deepEqual(fixture.fixture.activeNames(), ['read']);
  assert.deepEqual(fixture.fixture.entries(), []);
});

const browserTools: readonly FakeTool[] = [
  { name: 'open_page', exposure: 'deferred', namespace: { name: 'browser', aliases: ['web'] } },
  { name: 'get_tabs', exposure: 'deferred', namespace: { name: 'browser', aliases: ['web'] } },
  { name: 'browser_internal', exposure: 'hidden', namespace: { name: 'browser', aliases: ['web'] } },
];

test('enable resolves arbitrary namespaces and aliases without including hidden members', () => {
  for (const target of ['browser', 'namespace://browser', 'web', 'namespace://web']) {
    const fixture = manualHost(browserTools);
    const result = enableCapabilityTargets(fixture.api, [target]);
    assert.deepEqual(result.enabled, ['open_page', 'get_tabs'], target);
    assert.deepEqual(result.unresolved, [], target);
    assert.deepEqual([...manualEnabledTools(fixture.branch())], ['open_page', 'get_tabs'], target);
  }
});

test('enable accepts SDK MCP namespace names and aliases as well as server refs', () => {
  for (const target of ['mcp://git', 'namespace://mcp__git', 'mcp__git', 'namespace://git', 'git']) {
    const fixture = manualHost();
    const result = enableCapabilityTargets(fixture.api, [target]);
    assert.deepEqual(result.enabled, ['mcp__git__status', 'mcp__git__log'], target);
    assert.deepEqual(result.unresolved, [], target);
  }
});

test('an exact tool name wins over a namespace alias while an explicit namespace still expands', () => {
  const fixture = manualHost([...browserTools, { name: 'web', exposure: 'deferred' }]);
  assert.deepEqual(resolveEnableTargets(fixture.api, ['web']).names, ['web']);
  assert.deepEqual(resolveEnableTargets(fixture.api, ['namespace://web']).names, ['open_page', 'get_tabs']);
});

test('the picker offers generic and MCP namespace groups and records only the chosen members', async () => {
  for (const [target, expected] of [
    ['namespace://browser', ['open_page', 'get_tabs']],
    ['namespace://mcp__git', ['mcp__git__status', 'mcp__git__log']],
    ['mcp://git', ['mcp__git__status', 'mcp__git__log']],
  ] as const) {
    const fixture = command([...tools, ...browserTools]);
    await fixture.run('enable', async (_title, options) => {
      assert.ok(!options.some(option => option.includes('browser_internal')));
      const group = options.find(option => option.startsWith(`${target}  (`));
      assert.ok(group, `${target} is available without typing a target`);
      return group;
    });
    assert.deepEqual(fixture.fixture.activeNames(), expected, target);
    assert.deepEqual([...manualEnabledTools(fixture.fixture.branch())], expected, target);
    assert.equal(fixture.notifications.at(-1)?.type, 'info');
  }
});

test('group completions survive the tool limit and resolve namespace aliases', async () => {
  const many: FakeTool[] = Array.from({ length: 60 }, (_, i) => ({ name: `tool_${i}`, exposure: 'deferred' }));
  const fixture = command([...many, ...tools, ...browserTools]);
  const all = await fixture.completions('enable ');
  assert.equal(all?.length, 50);
  for (const target of ['namespace://browser', 'namespace://mcp__git', 'namespace://subagent', 'mcp://git']) {
    assert.ok(all?.some(item => item.value === `enable ${target} `), target);
  }
  for (const prefix of ['enable web', 'enable namespace://web']) {
    const items = await fixture.completions(prefix);
    assert.ok(items?.some(item => item.value === 'enable namespace://browser '), prefix);
  }
  const mcp = await fixture.completions('enable namespace://mcp__g');
  assert.deepEqual(mcp?.map(item => item.value), ['enable namespace://mcp__git ']);
});

test('argument completion keeps the same shape for the editor wrapper', () => {
  const fixture = manualHost();
  const items = capabilityArgumentCompletions('enable ', fixture.api);
  assert.ok(items?.length);
  assert.ok(items?.every((item) => typeof item.value === 'string' && typeof item.label === 'string'));
});
