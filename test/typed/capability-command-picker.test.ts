/**
 * Compact hierarchical picker transitions against the real capability host.
 *
 * These tests drive the returned component. Assertions cover visible rows,
 * viewport/footer behavior and emitted targets rather than duplicating model
 * logic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { visibleWidth } from '@earendil-works/pi-tui';
import { createCapabilityPicker, requiredPickerTerminalRows, type PickerMode } from '../../src/tui/capability-picker.ts';
import { queryToolAccess } from '../../src/capability/tool-access-view.ts';
import { setCapabilityStartupBlacklist } from '../../src/capability/scope.ts';
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
    theme: {
      fg: (color: string, text: string) => color === 'borderMuted' ? `─${text}` : text,
      bold: (text: string) => text,
    },
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

function picker(
  active: readonly string[] = ['codemode'],
  schemaRefs: readonly string[] = [],
  rows = 24,
  mode: PickerMode = 'activate',
  dynamic: readonly string[] = [],
) {
  const fixture = capabilityHost(tools, active, 'all');
  fixture.api.appendEntry('capability-tool-base', { version: 1, baseline: [...active] });
  if (dynamic.length > 0) fixture.api.appendEntry('capability-tool-dynamic', { version: 1, activate: [...dynamic] });
  const entries = queryToolAccess(fixture.api, fixture.branch(), fixture.activeNames(), { includeActivatable: true, schemaRefs }).entries;
  let result: readonly string[] | null | undefined;
  const options = fakeOptions(rows);
  const component = createCapabilityPicker({
    ...options,
    entries,
    mode,
    done: (value: readonly string[] | null) => { result = value; },
  } as never);
  return { fixture, component, result: () => result, terminal: options.tui.terminal };
}

function press(component: { handleInput(data: string): void }, ...keys: readonly string[]): void {
  for (const key of keys) component.handleInput(key);
}

function focused(component: { render(width: number): string[] }): string {
  return component.render(160).find((line) => line.startsWith('→')) ?? '';
}

test('root previews every container while child focus shows only one full list', () => {
  const view = picker(['codemode'], [], 50);
  const top = view.component.render(160);
  assert.ok(top.some((line) => line.includes('codemode')));
  assert.ok(top.some((line) => line.includes('namespace://subagent')));
  assert.ok(top.some((line) => line.includes('mcp://git')));
  assert.ok(top.some((line) => line.includes('Enter confirm')));
  assert.ok(top.some((line) => line.startsWith('─')), 'top separator precedes the title');
  assert.ok(top.some((line) => line.includes('├─') && line.includes('msg_write')), 'container previews are visible at root');
  assert.ok(top.some((line) => line.includes('└─')), 'last preview row uses the terminal elbow');
  assert.ok(top.some((line) => line.includes('mcp__git__status')), 'every container previews members, not only the focused one');
  const summary = top.find((line) => line.includes('tools remain')) ?? '';
  assert.match(summary, /^ {5}… 5 tools remain$/, 'collapse summary aligns with the child checkbox column without a connector');
  assert.ok(!top.some((line) => line.includes('pending:') || line.includes('config:schema')), 'no verbose policy dump');

  press(view.component, KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.right);
  const child = view.component.render(160);
  assert.ok(child.some((line) => line.includes('├─') || line.includes('└─')));
  assert.ok(child.some((line) => line.includes('in namespace://subagent')));
  assert.ok(!child.some((line) => line.includes('mcp__git__status')), 'child focus hides other containers');
  assert.ok(!child.some((line) => line.includes('tools remain') || line.includes('tools earlier')));
});

test('same-level navigation remembers child cursor and Left/Right crosses hierarchy', () => {
  const view = picker();
  press(view.component, KEYS.down);
  assert.match(focused(view.component), /deck_pages/);
  press(view.component, KEYS.down, KEYS.down, KEYS.down);
  assert.match(focused(view.component), /namespace:\/\/subagent/);
  press(view.component, KEYS.right, KEYS.down);
  assert.match(focused(view.component), /subagent_list/);
  press(view.component, KEYS.left);
  assert.match(focused(view.component), /namespace:\/\/subagent/);
  press(view.component, KEYS.right);
  assert.match(focused(view.component), /subagent_list/);
});

test('Page/Home/End traverse the full child list while the viewport scrolls', () => {
  const view = picker(['codemode'], [], 24);
  press(view.component, KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.right);
  press(view.component, KEYS.end);
  assert.match(focused(view.component), /subagent_member_9/);
  assert.ok(!view.component.render(120).some((line) => line.includes('tools earlier') || line.includes('tools remain')));

  press(view.component, KEYS.home);
  assert.match(focused(view.component), /msg_write/);
  press(view.component, KEYS.pageDown);
  assert.ok(focused(view.component).startsWith('→'));
});

test('height floor admits twelve terminal rows and refuses below it', () => {
  assert.equal(requiredPickerTerminalRows(), 12);
  const normal = picker(['codemode'], [], 24);
  const normalLines = normal.component.render(80);
  assert.ok(normalLines.length <= 12, 'half of a 24-row terminal');
  assert.ok(normalLines.filter((line) => line.startsWith('─')).length >= 2, 'top and bottom separators');
  assert.ok(normalLines.join('\n').includes('Enter confirm'));
  assert.ok(normalLines.at(-1)?.includes('Tab select/bulk'));

  const floor = picker(['codemode'], [], 12);
  const floorLines = floor.component.render(80);
  assert.ok(floorLines.length <= 8, 'eight-row component floor plus four host rows');
  assert.ok(floorLines.join('\n').includes('Enter confirm'));

  const half = picker(['codemode'], [], 16);
  assert.ok(half.component.render(80).length <= 8);

  const refusal = picker(['codemode'], [], 11);
  const refusalLines = refusal.component.render(120);
  assert.equal(refusalLines.length, 1);
  assert.match(refusalLines[0] ?? '', /terminal too small · \/capability needs 12 rows \(8 picker\+4 host\) · esc closes/);
  assert.ok(!refusalLines[0]?.includes('→'));
  assert.ok(!refusalLines[0]?.includes('─'));
  refusal.component.handleInput(KEYS.down);
  assert.equal(refusal.result(), undefined, 'navigation is inert while too small');
  refusal.component.handleInput(KEYS.cancel);
  assert.equal(refusal.result(), null, 'Esc remains available');

  const resize = picker(['codemode'], [], 24);
  press(resize.component, KEYS.tab);
  resize.terminal.rows = 11;
  assert.match(resize.component.render(120)[0] ?? '', /terminal too small/);
  resize.terminal.rows = 12;
  assert.match(focused(resize.component), /\[x\] codemode/, 'selection survives a temporary refusal');
});

test('Tab selects or bulk-toggles and Space cycles container schema only', () => {
  const bulk = picker();
  press(bulk.component, KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.tab);
  assert.match(focused(bulk.component), /\[x\] namespace:\/\/subagent/);
  press(bulk.component, KEYS.confirm);
  const bulkTargets = bulk.result() ?? [];
  assert.equal(bulkTargets[0], 'namespace://subagent[ns]');
  assert.ok(bulkTargets.includes('msg_write'));
  assert.ok(bulkTargets.includes('subagent_list'));

  const schema = picker();
  press(schema.component, KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.tab);
  press(schema.component, ' ');
  assert.match(focused(schema.component), /ovr:lazy/);
  press(schema.component, KEYS.confirm);
  assert.equal((schema.result() ?? [])[0], 'namespace://subagent[ns,lazy]');

  const tool = picker();
  press(tool.component, KEYS.tab);
  assert.match(focused(tool.component), /\[x\] codemode/);
  press(tool.component, ' ');
  assert.match(focused(tool.component), /\[x\] codemode/, 'tool Space has no selection or schema effect');
  assert.doesNotMatch(focused(tool.component), /pending:|override:/, 'tool rows have no schema toggle');
  press(tool.component, KEYS.confirm);
  assert.deepEqual(tool.result(), ['codemode']);
});

test('member selection is an explicit snapshot and deactivation emits exact names only', () => {
  const subset = picker();
  press(subset.component, KEYS.down, KEYS.down, KEYS.down, KEYS.down, KEYS.right, KEYS.tab, KEYS.left);
  press(subset.component, KEYS.confirm);
  assert.deepEqual(subset.result(), ['namespace://subagent[ns]', 'msg_write']);

  const deactivate = picker(['codemode'], [], 24, 'deactivate', ['msg_write', 'subagent_list']);
  press(deactivate.component, KEYS.right, KEYS.tab, KEYS.left, KEYS.confirm);
  assert.deepEqual(deactivate.result(), ['msg_write']);
});

test('a hard-banned base member is not an activation candidate until the ban is removed', () => {
  const fixture = capabilityHost(tools, ['codemode', 'deck_pages'], 'all');
  fixture.api.appendEntry('capability-tool-base', { version: 1, baseline: ['codemode'] });
  fixture.api.appendEntry('capability-tool-base', { version: 1, add: ['deck_pages'] });
  fixture.api.appendEntry('capability-tool-blacklist', { version: 1, add: ['deck_pages'] });
  const banned = queryToolAccess(fixture.api, fixture.branch(), fixture.activeNames(), { includeActivatable: true }).entries;
  assert.equal(banned.some((entry) => entry.name === 'deck_pages'), false,
    'a manual ban is a hard fence, so the member is not selectable');

  fixture.api.appendEntry('capability-tool-blacklist', { version: 1, remove: ['deck_pages'] });
  const entries = queryToolAccess(fixture.api, fixture.branch(), fixture.activeNames(), { includeActivatable: true }).entries;
  let result: readonly string[] | null | undefined;
  const component = createCapabilityPicker({
    ...fakeOptions(30),
    entries,
    mode: 'activate',
    done: (value: readonly string[] | null) => { result = value; },
  } as never);
  const row = component.render(160).find((line) => line.includes('deck_pages')) ?? '';
  assert.match(row, /\[ \]/);
  press(component, KEYS.down, KEYS.tab, KEYS.confirm);
  assert.deepEqual(result, ['deck_pages']);
});

test('an explicit base member over a root startup ban renders as a selectable exception', () => {
  const fixture = capabilityHost(tools, ['codemode'], 'all');
  fixture.api.appendEntry('capability-tool-base', { version: 1, baseline: ['codemode'] });
  setCapabilityStartupBlacklist(fixture.api, ['deck_pages']);
  fixture.api.appendEntry('capability-tool-base', { version: 1, add: ['deck_pages'] });
  const entries = queryToolAccess(fixture.api, fixture.branch(), fixture.activeNames(), { includeActivatable: true }).entries;
  let result: readonly string[] | null | undefined;
  const component = createCapabilityPicker({
    ...fakeOptions(30),
    entries,
    mode: 'activate',
    done: (value: readonly string[] | null) => { result = value; },
  } as never);
  const row = component.render(160).find((line) => line.includes('deck_pages')) ?? '';
  assert.match(row, /\[ \]/);
  assert.match(row, /ban overridden/, 'the retained startup ban stays visible');
  press(component, KEYS.down, KEYS.tab, KEYS.confirm);
  assert.deepEqual(result, ['deck_pages']);
});

test('container row summarizes config and actual withholding compactly', () => {
  const view = picker(['codemode'], ['namespace://subagent'], 40);
  press(view.component, KEYS.down, KEYS.down, KEYS.down, KEYS.down);
  assert.match(focused(view.component), /cfg:lazy/);
  assert.doesNotMatch(focused(view.component), /ovr:|now:/);
});
