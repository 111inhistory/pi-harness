/**
 * One-page hierarchical picker transitions against the real capability host.
 *
 * Input is driven through the returned component; assertions read emitted
 * targets and rendered tree rows rather than duplicating selection logic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { visibleWidth } from '@earendil-works/pi-tui';
import { createCapabilityPicker } from '../../src/tui/capability-picker.ts';
import { queryToolAccess } from '../../src/capability/tool-access-view.ts';
import { capabilityHost, type CapabilityTestTool } from './support/capability-host.ts';

const tools: readonly CapabilityTestTool[] = [
  { name: 'read', description: 'Read a file', exposure: 'direct' },
  { name: 'deck_pages', description: 'List deck pages', exposure: 'deferred' },
  { name: 'script_only', description: 'Script only', exposure: 'codemode' },
  { name: 'codemode', description: 'Run scripts', exposure: 'direct' },
  { name: 'mcp__git__status', description: 'Show repository status', exposure: 'deferred', namespace: { name: 'mcp__git', aliases: ['git'] } },
  { name: 'mcp__git__log', description: 'Show commit log', exposure: 'deferred', namespace: { name: 'mcp__git', aliases: ['git'] } },
  { name: 'msg_write', description: 'Send a message to a child', exposure: 'deferred', namespace: { name: 'subagent' } },
  { name: 'subagent_list', description: 'List child agents', exposure: 'deferred', namespace: { name: 'subagent' } },
  ...Array.from({ length: 10 }, (_, index): CapabilityTestTool => ({
    name: `subagent_member_${index}`,
    description: 'Child operation',
    exposure: 'deferred',
    namespace: { name: 'subagent' },
  })),
];

const KEYS = {
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  confirm: '\r', cancel: '\x1b', tab: '\t',
  pageUp: '\x1b[5~', pageDown: '\x1b[6~', home: '\x1b[H', end: '\x1b[F',
} as const;

function fakeOptions(rows = 24) {
  return {
    tui: { terminal: { rows }, requestRender() {} },
    theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    keybindings: { matches(data: string, action: string) {
      return action === 'tui.select.up' ? data === KEYS.up
        : action === 'tui.select.down' ? data === KEYS.down
          : action === 'tui.select.confirm' ? data === KEYS.confirm
            : action === 'tui.select.cancel' ? data === KEYS.cancel
              : action === 'tui.select.pageUp' ? data === KEYS.pageUp
                : action === 'tui.select.pageDown' ? data === KEYS.pageDown
                  : action === 'tui.input.tab' ? data === KEYS.tab
                    : action === 'tui.editor.cursorLeft' ? data === KEYS.left
                      : action === 'tui.editor.cursorRight' ? data === KEYS.right
                        : action === 'tui.editor.cursorLineStart' ? data === KEYS.home
                          : action === 'tui.editor.cursorLineEnd' ? data === KEYS.end
                            : false;
    } },
  };
}

function picker(active: readonly string[] = ['codemode'], schemaRefs: readonly string[] = [], rows = 24) {
  const fixture = capabilityHost(tools, active, 'all');
  fixture.api.appendEntry('capability-tool-base', { version: 1, baseline: [...active] });
  const entries = queryToolAccess(fixture.api, fixture.branch(), fixture.activeNames(), { includeActivatable: true, schemaRefs }).entries;
  let result: readonly string[] | null | undefined;
  const component = createCapabilityPicker({
    ...fakeOptions(rows),
    entries,
    mode: 'activate',
    done: (value: readonly string[] | null) => { result = value; },
  } as never);
  return { fixture, component, result: () => result };
}

function press(component: { handleInput(data: string): void }, ...keys: readonly string[]): void {
  for (const key of keys) component.handleInput(key);
}

test('root rows and tree children are one hierarchy without section headers', () => {
  const view = picker(['codemode'], [], 40);
  const top = view.component.render(100);
  assert.ok(top.some((line) => line.includes('deck_pages')));
  assert.ok(top.some((line) => line.includes('namespace://subagent')));
  assert.ok(top.some((line) => line.includes('mcp://git')));
  assert.ok(top.some((line) => line.includes('Confirm selection')));
  assert.ok(!top.some((line) => line.startsWith('Standalone tools')), 'no drilldown section headers');
  assert.ok(top.some((line) => line.includes('├─') || line.includes('└─')), 'children are tree rows');
  assert.ok(top.some((line) => line.includes('tools remain')), 'long member lists fold with a marker');
});

test('same-level navigation remembers the child cursor and Left/Right crosses hierarchy', () => {
  const view = picker();
  press(view.component, KEYS.down);
  assert.match(view.component.render(100).find((line) => line.startsWith('→')) ?? '', /deck_pages/);
  press(view.component, KEYS.down, KEYS.down, KEYS.down);
  assert.match(view.component.render(100).find((line) => line.startsWith('→')) ?? '', /namespace:\/\/subagent/);
  press(view.component, KEYS.right, KEYS.down);
  assert.match(view.component.render(100).find((line) => line.startsWith('→')) ?? '', /subagent_list/);
  press(view.component, KEYS.left);
  assert.match(view.component.render(100).find((line) => line.startsWith('→')) ?? '', /namespace:\/\/subagent/);
  press(view.component, KEYS.right);
  assert.match(view.component.render(100).find((line) => line.startsWith('→')) ?? '', /subagent_list/);
});

test('Page/Home/End stay level-local and a folded child range follows the cursor', () => {
  const view = picker(['codemode'], [], 24);
  press(view.component, KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.right);
  press(view.component, KEYS.end);
  const last = view.component.render(100);
  assert.ok(last.some((line) => line.startsWith('→') && line.includes('subagent_member_9')));
  assert.ok(last.some((line) => line.includes('tools earlier')), 'navigating past the fold exposes the range');

  press(view.component, KEYS.home);
  assert.ok(view.component.render(100).some((line) => line.startsWith('→') && line.includes('msg_write')));

  press(view.component, KEYS.pageDown);
  assert.ok(view.component.render(100).some((line) => line.startsWith('→')));

  press(view.component, KEYS.left);
  press(view.component, KEYS.end);
  assert.ok(view.component.render(100).some((line) => line.startsWith('→') && line.includes('Confirm selection')),
    'End moves to the last root sibling, never the last child');
});

test('render height stays within the terminal page and tiny terminals stay bounded', () => {
  const normal = picker(['codemode'], [], 12);
  assert.ok(normal.component.render(40).length <= 12);
  const tiny = picker(['codemode'], [], 2);
  assert.ok(tiny.component.render(20).length <= 2);
  assert.ok(tiny.component.render(20).every((line) => visibleWidth(line) <= 20));
});

test('Tab focuses capability fields and Space changes load or schema policy', () => {
  const view = picker();
  press(view.component, KEYS.tab, ' ');
  assert.match(view.component.render(100).find((line) => line.startsWith('→')) ?? '', /pending:lazy/);
  press(view.component, ' ');
  assert.match(view.component.render(100).find((line) => line.startsWith('→')) ?? '', /pending:no-lazy/);
  press(view.component, KEYS.tab, ' ');
  assert.match(view.component.render(100).find((line) => line.startsWith('→')) ?? '', /\[x\]/);

  press(view.component, KEYS.down, KEYS.down, KEYS.down, KEYS.down);
  press(view.component, KEYS.tab, ' ');
  assert.match(view.component.render(100).find((line) => line.startsWith('→')) ?? '', /schema:lazy/);
  press(view.component, KEYS.tab, ' ');
  assert.match(view.component.render(100).find((line) => line.startsWith('→')) ?? '', /load:all/);
});

test('mixed per-row modes emit suffix tokens in a single confirmation', () => {
  const view = picker();
  // deck_pages: lazy, read: no-lazy, both selected.
  press(view.component, KEYS.down, KEYS.tab, ' ', KEYS.tab, ' ');
  press(view.component, KEYS.down, KEYS.tab, ' ', ' ', KEYS.tab, ' ');
  for (let index = 0; index < 4; index += 1) press(view.component, KEYS.down);
  press(view.component, KEYS.confirm);
  assert.deepEqual(view.result(), ['deck_pages[lazy]', 'read[no-lazy]']);

  const subset = picker();
  press(subset.component, KEYS.down, KEYS.down, KEYS.down, KEYS.down);
  press(subset.component, KEYS.tab, ' ', KEYS.tab, KEYS.right);
  press(subset.component, ' ', KEYS.down, ' ');
  press(subset.component, KEYS.tab, ' ', ' ', KEYS.left);
  press(subset.component, KEYS.down, KEYS.down);
  press(subset.component, KEYS.confirm);
  assert.deepEqual(subset.result(), ['namespace://subagent[ns,lazy]', 'msg_write', 'subagent_list[no-lazy]']);
});

test('rows keep config default, branch override and applied withholding separate', () => {
  const view = picker(['codemode'], ['namespace://subagent'], 40);
  press(view.component, KEYS.down, KEYS.down, KEYS.down, KEYS.right);
  const members = view.component.render(200).join('\n');
  assert.match(members, /config:lazy/);
  assert.match(members, /override:none/);
  assert.match(members, /applied:schema|applied:not-active/);
});


test('already usable active members stay visible and editable without preselection', () => {
  const view = picker(['codemode']);
  const top = view.component.render(120).find((line) => line.startsWith('→')) ?? '';
  assert.match(top, /codemode/);
  assert.match(top, /\[ \]/, 'an active member is not silently preselected');
  press(view.component, KEYS.tab, ' ', KEYS.tab, ' ');
  for (let index = 0; index < 6; index += 1) press(view.component, KEYS.down);
  press(view.component, KEYS.confirm);
  assert.deepEqual(view.result(), ['codemode[lazy]'], 'active member schema policy can be updated explicitly');
});

test('full container always uses the displayed member snapshot instead of re-expanding', () => {
  const view = picker(['codemode'], [], 40);
  press(view.component, KEYS.down, KEYS.down, KEYS.down, KEYS.down, ' ');
  for (let index = 0; index < 2; index += 1) press(view.component, KEYS.down);
  press(view.component, KEYS.confirm);
  const targets = view.result() ?? [];
  assert.equal(targets[0], 'namespace://subagent[ns]');
  assert.ok(targets.includes('msg_write'));
  assert.ok(targets.includes('subagent_list'));
  assert.ok(!targets.includes('hidden_member'), 'no member outside the displayed snapshot is affected');
});


test('base override rows are selectable and show the retained ban separately from usability', () => {
  const fixture = capabilityHost(tools, ['codemode', 'deck_pages'], 'all');
  fixture.api.appendEntry('capability-tool-base', { version: 1, baseline: ['codemode'] });
  fixture.api.appendEntry('capability-tool-base', { version: 1, add: ['deck_pages'] });
  fixture.api.appendEntry('capability-tool-blacklist', { version: 1, add: ['deck_pages'] });
  const entries = queryToolAccess(fixture.api, fixture.branch(), fixture.activeNames(), { includeActivatable: true }).entries;
  let result: readonly string[] | null | undefined;
  const component = createCapabilityPicker({
    ...fakeOptions(30),
    entries,
    mode: 'activate',
    done: (value: readonly string[] | null) => { result = value; },
  } as never);
  const row = component.render(180).find((line) => line.includes('deck_pages')) ?? '';
  assert.match(row, /\[ \]/, 'a base-overridden active member is not silently preselected');
  assert.match(row, /ban:overridden-by-base/);
  for (let index = 0; index < 1; index += 1) component.handleInput(KEYS.down);
  component.handleInput(' ');
  for (let index = 0; index < 5; index += 1) component.handleInput(KEYS.down);
  component.handleInput(KEYS.confirm);
  assert.deepEqual(result, ['deck_pages']);
});
