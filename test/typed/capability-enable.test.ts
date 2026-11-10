/**
 * `/capability enable` (three-state model): the user's path to enable a tool.
 *
 * The enable operation records an `enabled` permission and activates the
 * concrete members; it never relies on a separate manual record. Targets are
 * resolved against the live registry at execution time.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from '@earendil-works/pi-coding-agent';

import { createToolAdmission } from '../../src/capability/admission.ts';
import {
  capabilityArgumentCompletions, installCapabilityCommand, parseCapabilityCommand,
} from '../../src/capability/command.ts';
import { enableCapabilityTargets, resolveEnableTargets } from '../../src/capability/enable.ts';
import { setCapabilityParent, setCapabilityPermissionDefaults } from '../../src/capability/scope.ts';
import { explicitlyEnabled, explicitlyDisabled } from '../../src/capability/tool-permission.ts';
import { queryToolPermissions } from '../../src/capability/tool-permission.ts';

interface FakeTool {
  name: string;
  description?: string;
  exposure?: string;
  namespace?: { name: string; aliases?: readonly string[] };
}

type Entry = { type: string; customType: string; timestamp?: string; data?: unknown };

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

function command(fixture: ReturnType<typeof host>, select?: (labels: readonly string[]) => string | undefined) {
  const notifications: { text: string; type: string }[] = [];
  let registered: RegisteredCommand | undefined;
  Object.assign(fixture.api as object, {
    registerCommand: (name: string, options: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) => {
      registered = { name, ...options } as RegisteredCommand;
    },
  });
  installCapabilityCommand(fixture.api);
  assert.ok(registered);
  const command = registered;
  const ctx = {
    ui: {
      notify: (text: string, type: string = 'info') => { notifications.push({ text, type }); },
      select: async (title: string, labels: string[]) => select === undefined ? undefined : select(labels),
    },
    sessionManager: { getBranch: () => fixture.branch() },
  } as unknown as ExtensionCommandContext;
  return {
    notifications,
    completions: async (prefix: string) => (await command.getArgumentCompletions?.(prefix)) ?? null,
    run: async (raw: string) => { await command.handler(raw, ctx); },
  };
}

test('the command line parses the permission verbs', () => {
  assert.deepEqual(parseCapabilityCommand('enable'), { verb: 'enable', targets: [] });
  assert.deepEqual(parseCapabilityCommand('enable deck_pages read'), { verb: 'enable', targets: ['deck_pages', 'read'] });
  assert.deepEqual(parseCapabilityCommand('disable read'), { verb: 'disable', targets: ['read'] });
  assert.deepEqual(parseCapabilityCommand('reset read'), { verb: 'reset', targets: ['read'] });
  assert.deepEqual(parseCapabilityCommand('list active'), { verb: 'list', expr: 'active' });
});

test('targets resolve against the live registry: names, servers and namespaces', () => {
  const fixture = host(tools);
  const resolved = resolveEnableTargets(fixture.api, ['deck_pages', 'mcp://git', 'namespace://subagent', 'missing']);
  assert.deepEqual(resolved.names, ['deck_pages', 'mcp__git__status', 'mcp__git__log', 'msg_write']);
  assert.deepEqual(resolved.unresolved, ['missing']);
  assert.deepEqual(resolved.expansions.map((entry) => entry.target).sort(), ['mcp://git', 'namespace://subagent']);
  assert.equal(resolveEnableTargets(fixture.api, ['secret']).names.includes('secret'), true,
    'an exact hidden target is reported instead of pretending it does not exist');
});

test('enable records an enabled permission and activates the members', () => {
  const fixture = host(tools, ['read']);
  setCapabilityPermissionDefaults(fixture.api, ['deck_pages']);
  const result = enableCapabilityTargets(fixture.api, ['deck_pages', 'mcp://git'], { branch: fixture.branch() });
  assert.deepEqual([...result.enabled].sort(), ['deck_pages', 'mcp__git__log', 'mcp__git__status']);
  assert.equal(explicitlyEnabled(fixture.api, fixture.branch(), 'deck_pages'), true);
  assert.equal(explicitlyDisabled(fixture.api, fixture.branch(), 'deck_pages'), false, 'the explicit enable overrides the seed');
  assert.ok(fixture.activeNames().includes('deck_pages'));
  assert.ok(fixture.activeNames().includes('mcp__git__status'));
  assert.equal(createToolAdmission(fixture.api, fixture.branch()).admits('deck_pages'), true);
});

test('a group target persists as a group rule and covers later members', () => {
  const fixture = host(tools);
  const result = enableCapabilityTargets(fixture.api, ['namespace://mcp__git'], { branch: fixture.branch() });
  assert.deepEqual([...result.enabled].sort(), ['mcp__git__log', 'mcp__git__status']);
  const record = fixture.entries()[0]!.data as { set: Array<{ target: string }> };
  assert.deepEqual(record.set.map((item) => item.target), ['namespace://mcp__git'],
    'the group target is recorded, not its current members');

  fixture.register({ name: 'mcp__git__push', exposure: 'deferred', namespace: { name: 'mcp__git' } });
  assert.equal(explicitlyEnabled(fixture.api, fixture.branch(), 'mcp__git__push'), true,
    'a member registered later is covered by the same group rule');
  const plain = queryToolPermissions(fixture.api, fixture.branch(), fixture.activeNames(), 'tool');
  assert.ok(!plain.entries.some((entry) => entry.name === 'mcp__git__push'),
    'a namespace member is not a plain tool entry');
  const namespaced = queryToolPermissions(fixture.api, fixture.branch(), fixture.activeNames(), 'namespace+enabled');
  assert.ok(namespaced.entries.some((entry) => entry.name === 'mcp__git__push'));
});

test('a repeated enable is idempotent and writes no second record', () => {
  const fixture = host(tools, []);
  const first = enableCapabilityTargets(fixture.api, ['read'], { branch: fixture.branch() });
  assert.equal(first.enabled.length, 1);
  const records = fixture.entries().length;
  const second = enableCapabilityTargets(fixture.api, ['read'], { branch: fixture.branch() });
  assert.deepEqual(second.enabled, []);
  assert.deepEqual(second.alreadyEnabled, ['read']);
  assert.equal(fixture.entries().length, records);
});

test('a record write failure leaves the tool disabled', () => {
  const fixture = host(tools, []);
  setCapabilityPermissionDefaults(fixture.api, ['deck_pages']);
  fixture.failAppend(true);
  const result = enableCapabilityTargets(fixture.api, ['deck_pages'], { branch: fixture.branch() });
  assert.equal(result.recordError, 'the session branch is read-only');
  assert.deepEqual(result.enabled, []);
  assert.equal(explicitlyEnabled(fixture.api, fixture.branch(), 'deck_pages'), false);
  assert.equal(fixture.activeNames().includes('deck_pages'), false);
});

test('a tool registered after startup is enableable; a withdrawn registration is not', () => {
  const fixture = host(tools, []);
  fixture.register({ name: 'late_tool', exposure: 'deferred' });
  assert.deepEqual(enableCapabilityTargets(fixture.api, ['late_tool'], { branch: fixture.branch() }).enabled, ['late_tool']);
  fixture.unregister('late_tool');
  assert.deepEqual(enableCapabilityTargets(fixture.api, ['late_tool'], { branch: fixture.branch() }).unresolved, ['late_tool']);
});

test('the enable command activates and reports; browsing stays read-only', async () => {
  const fixture = host(tools, ['read']);
  setCapabilityPermissionDefaults(fixture.api, ['deck_pages']);
  const ui = command(fixture);
  await ui.run('list');
  assert.deepEqual(fixture.activeNames(), ['read']);
  assert.deepEqual(fixture.entries(), []);
  await ui.run('enable deck_pages');
  assert.match(ui.notifications.at(-1)?.text ?? '', /Capability · enable deck_pages/);
  assert.deepEqual(fixture.activeNames(), ['read', 'deck_pages']);
});

test('the picker enables the chosen group and cancellation changes nothing', async () => {
  const chosen = host(tools, []);
  const offered: string[] = [];
  const picker = command(chosen, (labels) => {
    offered.push(...labels);
    return labels.find((label) => label.startsWith('mcp://git')) ?? labels[0];
  });
  await picker.run('enable');
  assert.match(picker.notifications.at(-1)?.text ?? '', /Capability · enable mcp:\/\/git/);
  assert.ok(chosen.activeNames().includes('mcp__git__status'));
  assert.ok(offered.some((label) => label.startsWith('mcp://git')), 'the MCP group is offered once');
  assert.ok(!offered.some((label) => label.startsWith('namespace://mcp__git')), 'the MCP group is not repeated as a namespace');
  assert.ok(offered.some((label) => label.startsWith('namespace://subagent')), 'non-MCP namespaces keep namespace://');

  const cancelled = host(Array.from({ length: 500 }, (_, index) => ({ name: `fixture_${index}`, exposure: 'direct' })), []);
  let catalogReads = 0;
  const allTools = cancelled.api.getAllTools;
  cancelled.api.getAllTools = () => { catalogReads++; return allTools(); };
  const noChoice = command(cancelled, labels => {
    assert.equal(labels.length, 500, 'every eligible tool is offered');
    return undefined;
  });
  await noChoice.run('enable');
  assert.ok(catalogReads <= 4, `picker catalog work must be independent of member count; saw ${catalogReads}`);
  assert.match(noChoice.notifications.at(-1)?.text ?? '', /Enable cancelled/);
  assert.deepEqual(cancelled.activeNames(), []);
  assert.deepEqual(cancelled.entries(), []);
});

test('a child scope never admits a tool enabled at the root', () => {
  const root = host(tools, []);
  setCapabilityPermissionDefaults(root.api, ['deck_pages']);
  enableCapabilityTargets(root.api, ['deck_pages'], { branch: root.branch() });
  const child = host(tools, []);
  setCapabilityParent(child.api, root.api);
  assert.equal(createToolAdmission(child.api, root.branch()).admits('deck_pages'), false, 'enabled is root-only');
});

test('completions cover verbs and target names/groups', async () => {
  const fixture = host(tools, []);
  const ui = command(fixture);
  assert.deepEqual((await ui.completions(''))?.map((item) => item.value), ['list ', 'enable ', 'disable ', 'reset ']);
  assert.deepEqual((await ui.completions('en'))?.map((item) => item.value), ['enable ']);
  assert.ok((await ui.completions('enable '))?.some((item) => item.value === 'enable deck_pages '));
  const enableValues = (await ui.completions('enable '))?.map((item) => item.value) ?? [];
  assert.ok(enableValues.some((value) => value.startsWith('enable mcp://git ')));
  assert.ok(!enableValues.some((value) => value.startsWith('enable namespace://mcp__git ')), 'the MCP group is not repeated as a namespace');
  assert.ok(enableValues.some((value) => value.startsWith('enable namespace://subagent ')), 'non-MCP namespaces keep namespace://');
  assert.ok(!(await ui.completions('enable '))?.some((item) => item.value === 'enable secret '), 'hidden tools are never offered');
});
