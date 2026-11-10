/**
 * Manual seed and the `/capability` command surfaces under the three-state
 * permission model.
 *
 * `capability.manualTools` is now a default `disabled` seed. A seeded tool is
 * excluded from discovery and from child scopes; the user enables it explicitly,
 * which makes it root-only. Legacy manual records still migrate to `enabled`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { capabilityHost, capabilityCommand, type CapabilityTestTool as FakeTool } from './support/capability-host.ts';
import { CombinedAutocompleteProvider, type AutocompleteProvider } from '@earendil-works/pi-tui';

import {
  CAPABILITY_DISCOVERY_RECORD,
  discoveryRecords,
} from '../../src/capability/discovery-record.ts';
import { CAPABILITY_SECTION, capabilityPromptTranscript } from '../../src/capability/prompt.ts';
import { createToolAdmission } from '../../src/capability/admission.ts';
import {
  capabilityArgumentCompletions, parseCapabilityCommand,
} from '../../src/capability/command.ts';
import { argumentCompletionProvider } from '../../src/autocomplete.ts';
import { createCapabilityCatalog } from '../../src/capability/catalog.ts';
import { setCapabilityParent, setCapabilityPermissionDefaults } from '../../src/capability/scope.ts';
import { createEligibleToolCatalog } from '../../src/capability/tool-catalog.ts';
import { activateToolNames } from '../../src/capability/activation.ts';
import { explicitlyDisabled, explicitlyEnabled, setToolPermission } from '../../src/capability/tool-permission.ts';
import { resolveHarnessConfig } from '../../src/harness-config.ts';

const host = (tools: readonly FakeTool[], active: string[] = []) => capabilityHost(tools, active).api;

function branchOf(entries: readonly { customType?: string; data?: unknown }[]): unknown[] {
  return entries.map((entry) => ({ type: 'custom', customType: entry.customType, data: entry.data }));
}

const tools: FakeTool[] = [
  { name: 'read', description: 'Read a file', exposure: 'direct' },
  { name: 'deck_pages', description: 'List deck pages', exposure: 'deferred' },
  { name: 'secret', description: 'Internal', exposure: 'hidden' },
  { name: 'mcp__git__status', description: 'Show repository status', exposure: 'deferred', namespace: { name: 'mcp__git', aliases: ['git'] } },
  { name: 'mcp__git__log', description: 'Show commit log', exposure: 'deferred', namespace: { name: 'mcp__git', aliases: ['git'] } },
  { name: 'msg_write', description: 'Send a message to a child', exposure: 'deferred', namespace: { name: 'subagent' } },
];

function install(tools: FakeTool[], active: string[] = []) {
  const fixture = capabilityHost(tools, active, 'all');
  return {
    pi: fixture.api, entries: fixture.branch(), activeNames: fixture.activeNames,
    ...capabilityCommand(fixture, undefined, () => branchOf(fixture.branch())),
  };
}

test('the command line parses list and the permission verbs', () => {
  assert.deepEqual(parseCapabilityCommand(''), { verb: 'list', expr: '' });
  assert.deepEqual(parseCapabilityCommand('list'), { verb: 'list', expr: '' });
  assert.deepEqual(parseCapabilityCommand('list enabled+active'), { verb: 'list', expr: 'enabled+active' });
  assert.deepEqual(parseCapabilityCommand('enable'), { verb: 'enable', targets: [] });
  assert.deepEqual(parseCapabilityCommand('enable deck_pages read'), { verb: 'enable', targets: ['deck_pages', 'read'] });
  assert.deepEqual(parseCapabilityCommand('disable read'), { verb: 'disable', targets: ['read'] });
  assert.deepEqual(parseCapabilityCommand('reset read'), { verb: 'reset', targets: ['read'] });
  assert.throws(() => parseCapabilityCommand('blacklist'), /Unknown subcommand/);
  assert.throws(() => parseCapabilityCommand('search git'), /Unknown subcommand/);
});

test('a manualTools seed is disabled at the root and is not inherited', () => {
  const root = host(tools, []);
  setCapabilityPermissionDefaults(root, ['deck_pages']);
  assert.equal(createToolAdmission(root, []).disabled('deck_pages'), true, 'the seed is disabled');
  root.setActiveTools(['deck_pages']);
  assert.equal(createToolAdmission(root, []).admits('deck_pages'), false, 'a seeded active tool is not admitted');
  assert.equal(createToolAdmission(root, []).admits('read'), true, 'other tools are unaffected');

  setToolPermission(root, root, root.entries, ['deck_pages'], 'enabled');
  const branch = branchOf(root.entries);
  assert.equal(explicitlyEnabled(root, branch, 'deck_pages'), true);
  assert.equal(createToolAdmission(root, branch).admits('deck_pages'), true, 'the explicit enable admits it at the root');

  const child = host(tools, []);
  setCapabilityParent(child, root);
  assert.equal(createToolAdmission(child, branch).admits('deck_pages'), false, 'an enabled tool is root-only');
});

test('list shows the four-state view without rule/source diagnostics', async () => {
  const fixture = install(tools, ['read', 'deck_pages']);
  setCapabilityPermissionDefaults(fixture.pi, ['deck_pages']);
  await fixture.run('disable deck_pages');
  await fixture.run('list disabled');
  const text = fixture.notifications.at(-1)?.text ?? '';
  assert.match(text, /Capability · 1 tool · disabled/);
  assert.match(text, /✖ deck_pages {2}\[disabled\]/);
  assert.doesNotMatch(text, /Managed rules|→/, 'the view has no rule/source diagnostics');
  assert.doesNotMatch(text, /secret|Internal/, 'hidden tools stay out of the human view');
});

test('list defaults to enabled+active and filters by category and expression', async () => {
  const fixture = install(tools, ['read', 'mcp__git__status']);
  await fixture.run('list');
  const def = fixture.notifications.at(-1)?.text ?? '';
  assert.match(def, /Capability · 2 tools · enabled\+active/);
  assert.match(def, /● read {2}\[active\]/);
  assert.match(def, /● mcp__git__status {2}\[active · namespace\]/);
  await fixture.run('list namespace');
  assert.match(fixture.notifications.at(-1)?.text ?? '', /mcp__git__status/);
  await fixture.run('list tool+inactive');
  assert.match(fixture.notifications.at(-1)?.text ?? '', /deck_pages/);
});

test('list refuses an invalid expression without touching state', async () => {
  const fixture = install(tools, []);
  await fixture.run('list enabled active');
  const text = fixture.notifications.at(-1)?.text ?? '';
  assert.match(text, /invalid_permission_query/);
  assert.deepEqual(fixture.entries, []);
});

test('the enable command records and activates a seeded tool', async () => {
  const fixture = install(tools, ['read']);
  setCapabilityPermissionDefaults(fixture.pi, ['deck_pages']);
  await fixture.run('enable deck_pages');
  const text = fixture.notifications[0]?.text ?? '';
  assert.match(text, /Capability · enable deck_pages/);
  assert.match(text, /Enabled\n {2}✔ deck_pages/);
  assert.deepEqual(fixture.activeNames(), ['read', 'deck_pages']);
  assert.equal(fixture.entries.length, 1, 'one permission record');
  const branch = branchOf(fixture.entries);
  assert.equal(explicitlyEnabled(fixture.pi, branch, 'deck_pages'), true);
  assert.equal(createToolAdmission(fixture.pi, branch).admits('deck_pages'), true);
});

test('browsing grants nothing and writes no record', async () => {
  const fixture = install(tools, ['read']);
  setCapabilityPermissionDefaults(fixture.pi, ['deck_pages']);
  await fixture.run('list');
  await fixture.run('list disabled');
  assert.deepEqual(fixture.activeNames(), ['read'], 'no tool is activated');
  assert.deepEqual(fixture.entries, [], 'no permission record is written');
  assert.equal(createToolAdmission(fixture.pi, []).admits('deck_pages'), false);
});

test('disable reports the effect scope and reset removes the explicit rule', async () => {
  const fixture = install(tools, ['read', 'deck_pages']);
  setCapabilityPermissionDefaults(fixture.pi, ['deck_pages']);
  await fixture.run('disable deck_pages');
  const disableText = fixture.notifications.at(-1)?.text ?? '';
  assert.match(disableText, /Capability · disable deck_pages/);
  assert.match(disableText, /declaration removed at next compaction/);
  assert.equal(createToolAdmission(fixture.pi, branchOf(fixture.entries)).admits('deck_pages'), false);

  await fixture.run('reset deck_pages');
  const resetText = fixture.notifications.at(-1)?.text ?? '';
  assert.match(resetText, /Reset\n {2}· deck_pages/);
  assert.doesNotMatch(resetText, /Still managed|Not managed/);
});

test('completions cover verbs, list terms and target names/groups', async () => {
  const fixture = install(tools, []);
  assert.deepEqual((await fixture.completions(''))?.map((item) => item.value), ['list ', 'enable ', 'disable ', 'reset ']);
  assert.deepEqual((await fixture.completions('li'))?.map((item) => item.value), ['list ']);
  assert.deepEqual((await fixture.completions('en'))?.map((item) => item.value), ['enable ']);
  assert.deepEqual((await fixture.completions('di'))?.map((item) => item.value), ['disable ']);
  assert.deepEqual((await fixture.completions('re'))?.map((item) => item.value), ['reset ']);
  assert.equal(await fixture.completions('se'), null, 'search is not a verb');
  assert.deepEqual((await fixture.completions('list '))?.map((item) => item.value),
    ['list enabled', 'list disabled', 'list active', 'list inactive', 'list tool', 'list namespace']);
  assert.deepEqual((await fixture.completions('list en'))?.map((item) => item.value), ['list enabled']);
  assert.ok((await fixture.completions('enable '))?.some((item) => item.value === 'enable deck_pages '));
  assert.ok((await fixture.completions('disable '))?.some((item) => item.value.startsWith('disable mcp://git ')));
});

test('the editor forced Tab reaches the new argument completions through the wrapper', async () => {
  const fixture = install(tools, []);
  const provider: AutocompleteProvider = new CombinedAutocompleteProvider([{
    name: 'capability',
    description: 'Tool permissions',
    getArgumentCompletions: (prefix: string) => capabilityArgumentCompletions(prefix, fixture.pi),
  }], process.cwd());
  const wrapped = argumentCompletionProvider(provider, 'capability');
  const signal = new AbortController().signal;
  const names = await provider.getSuggestions(['/capab'], 0, 6, { signal, force: false });
  assert.ok(names);
  const applied = provider.applyCompletion(['/capab'], 0, 6, names.items[0]!, names.prefix);
  assert.equal(applied.lines[0], '/capability ');
  const verbs = await wrapped.getSuggestions(applied.lines, 0, applied.cursorCol, { signal, force: true });
  assert.ok(verbs);
  assert.deepEqual(verbs.items.map((item) => item.value), ['list ', 'enable ', 'disable ', 'reset ']);
});

test('a seeded tool is invisible to discovery and cannot be activated by it', () => {
  const api = host(tools, []);
  setCapabilityPermissionDefaults(api, ['deck_*']);
  const disabled = (name: string): boolean => explicitlyDisabled(api, [], name);
  assert.equal(createEligibleToolCatalog(api, { disabled }).names.has('deck_pages'), false, 'discovery never sees it');
  assert.equal(createCapabilityCatalog(api as unknown as ExtensionAPI).entries
    .some((entry) => entry.name === 'deck_pages'), true, 'the user view sees it');
  const refused = activateToolNames(api, ['deck_pages'], { disabled });
  assert.deepEqual(refused.skipped, [{ name: 'deck_pages', reason: 'disabled' }]);
  assert.deepEqual(api.activeNames(), []);
});

test("a child scope's discovery never offers seeded tools", () => {
  const rootHost = host(tools, []);
  setCapabilityPermissionDefaults(rootHost, ['deck_pages']);
  const child = { getAllTools: () => tools, getActiveTools: () => [] };
  setCapabilityParent(child, rootHost);
  const childCatalog = createEligibleToolCatalog(child as unknown as ExtensionAPI, {
    disabled: (name) => explicitlyDisabled(child as unknown as ExtensionAPI, [], name),
  });
  assert.equal(childCatalog.names.has('deck_pages'), false);
  assert.equal(createCapabilityCatalog(rootHost as unknown as ExtensionAPI).entries
    .some((entry) => entry.name === 'deck_pages'), true, 'Main keeps the config default browsable');
});

test('the manual tool list is configured per layer and validated', () => {
  const config = resolveHarnessConfig([
    { source: 'global', value: { capability: { manualTools: ['deploy_prod', 'mcp__prod__*'] } } },
  ]);
  assert.deepEqual(config.capability.manualTools, ['deploy_prod', 'mcp__prod__*']);

  const replaced = resolveHarnessConfig([
    { source: 'global', value: { capability: { manualTools: ['a'] } } },
    { source: 'project', value: { capability: { manualTools: ['b'] } } },
  ]);
  assert.deepEqual(replaced.capability.manualTools, ['b'], 'a later layer replaces the list');

  for (const value of [[1], [''], 'deploy_prod', { tool: 'x' }]) {
    assert.throws(
      () => resolveHarnessConfig([{ source: 'global', value: { capability: { manualTools: value } } }]),
      /manualTools must be an array of non-empty tool name patterns/,
      JSON.stringify(value),
    );
  }
});

test('projecting a legacy authorization produces no system section', () => {
  const entries: { customType: string; data?: unknown }[] = [];
  entries.push({
    customType: 'capability-discovery',
    data: {
      version: 1,
      result: {
        status: 'ok',
        tools: [],
        mcp: [],
        skills: [],
        manual: [{ ref: 'tool://deck_pages', name: 'deck_pages', description: 'List deck pages', exposure: 'deferred', kind: 'tool' }],
        coverage: { local: 'not_searched', remote: 'not_searched' },
      },
    },
  });
  const branch = entries.map((entry) => ({ type: 'custom', customType: entry.customType, data: entry.data }));
  assert.equal(discoveryRecords(branch)[0]?.result.tools.length, 0);
  const head = [{ role: 'system', content: 'base', sections: { preamble: 'Base' }, timestamp: 0 }];
  assert.deepEqual(capabilityPromptTranscript(head, branch, { allowsTool: () => true }), head);
  assert.deepEqual(capabilityPromptTranscript(head, branch, { allowsTool: () => false }), head);
});
