/** Blacklist configuration, independent collections, command parsing and editor completion. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CombinedAutocompleteProvider, type AutocompleteProvider } from '@earendil-works/pi-tui';
import { capabilityHost, capabilityCommand, type CapabilityTestTool } from './support/capability-host.ts';
import { createToolAdmission } from '../../src/capability/admission.ts';
import { capabilityArgumentCompletions, parseCapabilityCommand } from '../../src/capability/command.ts';
import { argumentCompletionProvider } from '../../src/autocomplete.ts';
import { setCapabilityParent, setCapabilityStartupBlacklist } from '../../src/capability/scope.ts';
import { ensureToolBase } from '../../src/capability/tool-access.ts';
import { createToolAccessView } from '../../src/capability/tool-access-view.ts';
import { resolveHarnessConfig } from '../../src/harness-config.ts';

const tools: CapabilityTestTool[] = [
  { name: 'read', description: 'Read a file', exposure: 'direct' },
  { name: 'deck_pages', description: 'List deck pages', exposure: 'deferred' },
  { name: 'secret', description: 'Internal', exposure: 'hidden' },
  { name: 'mcp__git__status', description: 'Repository status', exposure: 'deferred', namespace: { name: 'mcp__git', aliases: ['git'] } },
];
function fixture(active: string[] = ['read']) {
  const host = capabilityHost(tools, active);
  ensureToolBase(host.api, host.api, host.branch());
  return { ...host, ...capabilityCommand(host) };
}

test('the five commands parse independently and retired permission expressions are rejected', () => {
  assert.deepEqual(parseCapabilityCommand(''), { verb: 'list', activatable: false, usable: false, filter: null });
  assert.deepEqual(parseCapabilityCommand('list --activatable --usable --filter=deck'), {
    verb: 'list', activatable: true, usable: true, filter: 'deck',
  });
  for (const verb of ['base', 'blacklist']) {
    for (const action of ['add', 'remove', 'list']) {
      const targets = action === 'list' ? [] : ['deck_pages'];
      assert.deepEqual(parseCapabilityCommand([verb, action, ...targets].join(' ')), { verb, action, targets });
    }
  }
  for (const verb of ['activate', 'deactivate']) {
    assert.deepEqual(parseCapabilityCommand(`${verb} deck_pages read`), { verb, targets: ['deck_pages', 'read'] });
  }
  for (const invalid of ['enable read', 'disable read', 'reset read', 'list enabled+active', 'search git']) {
    assert.throws(() => parseCapabilityCommand(invalid));
  }
});

test('a root startup blacklist is local: base overrides it, dynamic cannot, and children keep the ancestor fence', async () => {
  const root = fixture();
  setCapabilityStartupBlacklist(root.api, ['deck_pages']);
  // Dynamic activation alone cannot lift a local ban.
  await root.run('activate deck_pages');
  let view = createToolAccessView(root.api, root.branch());
  assert.equal(view.dynamic('deck_pages'), true);
  assert.equal(view.blacklisted('deck_pages'), true, 'the raw ban stays stored');
  assert.equal(view.requested('deck_pages'), false);
  assert.equal(root.activeNames().includes('deck_pages'), false);

  // Explicit base membership overrides the local startup ban.
  await root.run('base add deck_pages');
  view = createToolAccessView(root.api, root.branch());
  assert.equal(view.base('deck_pages'), true);
  assert.equal(view.banOverridden('deck_pages'), true);
  assert.equal(view.requested('deck_pages'), true);
  assert.equal(root.activeNames().includes('deck_pages'), true);

  // In a child the same startup source is an ancestor fence: no child base or
  // dynamic membership can lift it.
  const child = capabilityHost(tools, []);
  setCapabilityParent(child.api, root.api, ['deck_pages']);
  assert.equal(createToolAdmission(child.api, root.branch()).admits('deck_pages'), false);

  // Removing the stored source ends the ban; preserved base membership remains.
  await root.run('blacklist remove deck_pages');
  view = createToolAccessView(root.api, root.branch());
  assert.equal(view.blacklisted('deck_pages'), false);
  assert.equal(view.requested('deck_pages'), true);
  assert.equal(root.activeNames().includes('deck_pages'), true, 'preserved base membership remains usable');
});

test('completions expose collection verbs, list flags and live group references', async () => {
  const f = fixture();
  assert.deepEqual((await f.completions(''))?.map(x => x.value), ['base ', 'blacklist ', 'activate ', 'deactivate ', 'help ', 'list ']);
  assert.deepEqual((await f.completions('base '))?.map(x => x.label), ['add', 'remove', 'list']);
  assert.ok((await f.completions('list '))?.some(x => x.value === 'list --activatable'));
  assert.ok((await f.completions('activate '))?.some(x => x.value.includes('mcp://git')));
  assert.equal(await f.completions('enable '), null);
});

test('forced editor Tab reaches argument completions through the wrapper', async () => {
  const f = fixture();
  const provider: AutocompleteProvider = new CombinedAutocompleteProvider([{
    name: 'capability', description: 'Tool collections',
    getArgumentCompletions: (prefix: string) => capabilityArgumentCompletions(prefix, f.api, f.branch()),
  }], process.cwd());
  const wrapped = argumentCompletionProvider(provider, 'capability');
  const signal = new AbortController().signal;
  const names = await provider.getSuggestions(['/capab'], 0, 6, { signal, force: false });
  assert.ok(names);
  const applied = provider.applyCompletion(['/capab'], 0, 6, names.items[0]!, names.prefix);
  assert.equal(applied.lines[0], '/capability ');
  const verbs = await wrapped.getSuggestions(applied.lines, 0, applied.cursorCol, { signal, force: true });
  assert.ok(verbs);
  assert.deepEqual(verbs.items.map(x => x.value), ['base ', 'blacklist ', 'activate ', 'deactivate ', 'help ', 'list ']);
});

test('blacklist configuration replaces by layer and validates patterns', () => {
  const config = resolveHarnessConfig([
    { source: 'global', value: { capability: { blacklist: ['deploy_prod', 'mcp__prod__*'] } } },
    { source: 'project', value: { capability: { blacklist: ['other'] } } },
  ]);
  assert.deepEqual(config.capability.blacklist, ['other']);
  for (const value of [[1], [''], 'deploy_prod', { tool: 'x' }]) {
    assert.throws(() => resolveHarnessConfig([{ source: 'global', value: { capability: { blacklist: value } } }]));
  }
  assert.throws(() => resolveHarnessConfig([{ source: 'global', value: { capability: { manualTools: ['x'] } } }]),
    'retired configuration is not silently interpreted');
});
