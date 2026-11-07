import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import { CustomMessageComponent, ToolExecutionComponent, initTheme, type MessageRenderer, type ToolRendererResolver, type ToolRenderers } from '@earendil-works/pi-coding-agent';
import { Text, visibleWidth, type Component, type TUI, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { installResultRendering } from '../../src/result-rendering.ts';
import { deliveryMessage } from '../../src/subagent/delivery.ts';

function renderers() {
  let resolver: ToolRendererResolver | undefined;
  let delivery: MessageRenderer | undefined;
  let shell: MessageRenderer | undefined;
  installResultRendering({
    registerToolRenderer(value) { resolver = value; },
    registerMessageRenderer(type, value) {
      if (type === 'agent-delivery') delivery = value as MessageRenderer;
      else if (type === 'async-shell-result') shell = value as MessageRenderer;
      else assert.fail(`Unexpected message renderer ${type}`);
    },
  });
  assert.ok(resolver && delivery && shell);
  return { resolver, delivery, shell };
}

function tool(definition: ToolRenderers, result: { content: Array<{ type: 'text'; text: string }>; details: unknown }, isError = false) {
  const ui = { requestRender() {} } as TUI;
  const component = new ToolExecutionComponent('capability', 'ui-result', {}, { showImages: false }, definition, ui, '/tmp');
  component.updateResult({ ...result, isError });
  return component;
}
const plain = (lines: string[]) => lines.map(stripVTControlCharacters).join('\n');
const compact = (lines: string[]) => plain(lines).replace(/\s/g, '');

for (const name of ['capability', 'subagent_list', 'mcp__example__lookup']) {
  test(`${name}: long single-line results fold by visual rows and expand fully`, () => {
    initTheme('dark');
    const { resolver } = renderers();
    const definition = resolver(name, () => undefined);
    assert.ok(definition?.renderResult);
    const result = { content: [{ type: 'text' as const, text: JSON.stringify({ text: '界面测试 '.repeat(300), tail: 'FINAL_VISIBLE_MARKER' }) }], details: { secretDiagnostic: 'INTERNAL_ONLY' } };
    const before = structuredClone(result);
    const component = tool(definition, result);
    for (const width of [24, 80, 40]) {
      const collapsed = component.render(width);
      assert.ok(collapsed.length < 20, 'one logical line cannot occupy unlimited terminal rows');
      assert.ok(!plain(collapsed).includes('FINAL_VISIBLE_MARKER'));
      assert.ok(!plain(collapsed).includes('INTERNAL_ONLY'));
      assert.ok(collapsed.every(line => visibleWidth(line) <= width));
      component.setExpanded(true);
      const expanded = compact(component.render(width));
      assert.ok(expanded.includes('FINAL_VISIBLE_MARKER'));
      assert.ok(!expanded.includes('INTERNAL_ONLY'));
      component.setExpanded(false);
    }
    assert.deepEqual(result, before, 'rendering does not truncate the model-facing result');
  });
}

test('short results stay visible; partial/error and invalidation remain renderable', () => {
  initTheme('dark');
  const definition = renderers().resolver('subagent_create', () => undefined);
  assert.ok(definition);
  const component = tool(definition, { content: [{ type: 'text', text: 'SHORT_RESULT' }], details: undefined }, true);
  assert.ok(plain(component.render(40)).includes('SHORT_RESULT'));
  component.updateResult({ content: [{ type: 'text', text: 'PARTIAL_UPDATE' }], details: undefined, isError: false }, true);
  assert.ok(plain(component.render(40)).includes('PARTIAL_UPDATE'));
  component.invalidate();
  assert.ok(plain(component.render(40)).includes('PARTIAL_UPDATE'));
});

test('existing native or extension result renderers are preserved', () => {
  const native = { renderResult: () => new Text('NATIVE_RENDERING', 0, 0) };
  assert.equal(renderers().resolver('bash', () => native), native);
});

test('Subagent completion messages fold with sender and round visible, and expand fully', () => {
  initTheme('dark');
  const message = deliveryMessage({ sourceId: 'sub_01', round: 3, jobId: 'sub_01_r3',
    content: `${'result detail\n'.repeat(80)}FINAL_HANDOFF`, terminal: { status: 'completed' } });
  const before = structuredClone(message);
  const component = new CustomMessageComponent(message, renderers().delivery);
  for (const width of [30, 80]) {
    const collapsed = component.render(width);
    const text = plain(collapsed);
    assert.ok(collapsed.length < 20);
    assert.ok(text.includes('sub_01') && /round\s+3/.test(text) && text.includes('completed'));
    assert.ok(!text.includes('FINAL_HANDOFF'));
    assert.ok(collapsed.every(line => visibleWidth(line) <= width));
    component.setExpanded(true);
    assert.ok(plain(component.render(width)).includes('FINAL_HANDOFF'));
    component.setExpanded(false);
  }
  assert.deepEqual(message, before);
});

test('async shell completion folds output with its task status and preserves result data', () => {
  initTheme('dark');
  const result = { id: 'job_11111111', status: 'completed', exitCode: 0, output: `${'build output\n'.repeat(50)}FINAL_SHELL_OUTPUT`, cursor: 1000, logPath: '/tmp/project/output.log', truncated: false };
  const message = { role: 'custom' as const, customType: 'async-shell-result', content: JSON.stringify(result), display: true, details: { source: 'host', result }, timestamp: 0 };
  const before = structuredClone(message);
  const component = new CustomMessageComponent(message, renderers().shell);
  const collapsed = component.render(80);
  assert.ok(collapsed.length < 20);
  assert.match(plain(collapsed), /job_11111111.*completed/);
  assert.doesNotMatch(plain(collapsed), /FINAL_SHELL_OUTPUT/);
  component.setExpanded(true);
  assert.match(plain(component.render(80)), /FINAL_SHELL_OUTPUT/);
  assert.deepEqual(message, before);
});

function pointer(component: Component, y: number, overrides: Partial<TuiMouseEvent> = {}) {
  const width = 80;
  const height = component.render(width).length;
  return component.handleMouse?.({
    type: 'click', button: 'left', x: 2, y, screenX: 2, screenY: y,
    width, height, shift: false, alt: false, ctrl: false, ...overrides,
  });
}

for (const shell of ['default', 'self'] as const) {
  test(`tool ${shell} shell: native mouse click expands and collapses the result`, () => {
    initTheme('dark');
    const definition = renderers().resolver('capability', () => undefined);
    assert.ok(definition);
    const result = { content: [{ type: 'text' as const, text: `${'DETAIL_ROW\n'.repeat(50)}POINTER_TAIL` }], details: undefined };
    const before = structuredClone(result);
    const component = tool({ ...definition, renderShell: shell }, result);
    const collapsed = component.render(80);
    const hint = collapsed.findIndex(line => plain([line]).includes('more lines'));
    assert.ok(hint >= 0);
    assert.match(plain(collapsed), /click or/);
    for (const event of [{ type: 'wheel' as const, wheelDelta: 1 }, { type: 'drag' as const }, { button: 'right' as const }]) {
      assert.equal(pointer(component, hint, event), undefined);
      assert.doesNotMatch(plain(component.render(80)), /POINTER_TAIL/);
    }
    assert.equal(pointer(component, hint)?.handled, true);
    assert.match(plain(component.render(80)), /POINTER_TAIL/);
    component.invalidate();
    assert.match(plain(component.render(30)), /POINTER_TAIL/, 'pointer expansion survives redraw and resizing');
    const body = component.render(80).findIndex(line => plain([line]).includes('DETAIL_ROW'));
    assert.equal(pointer(component, body)?.handled, true);
    assert.doesNotMatch(plain(component.render(80)), /POINTER_TAIL/);
    component.setExpanded(true);
    assert.match(plain(component.render(80)), /POINTER_TAIL/, 'keyboard/global expansion still works');
    component.setExpanded(false);
    assert.doesNotMatch(plain(component.render(80)), /POINTER_TAIL/);
    assert.deepEqual(result, before);
  });
}

test('Subagent message mouse toggle survives rebuilds and cooperates with global expansion', () => {
  initTheme('dark');
  const { delivery } = renderers();
  const message = deliveryMessage({ sourceId: 'sub_02', round: 2, jobId: 'sub_02_r2',
    content: `${'DELIVERY_DETAIL\n'.repeat(50)}POINTER_HANDOFF`, terminal: { status: 'completed' } });
  const before = structuredClone(message);
  const component = new CustomMessageComponent(message, delivery);
  const other = new CustomMessageComponent(structuredClone(message), delivery);
  const title = component.render(80).findIndex(line => plain([line]).includes('sub_02'));
  for (const event of [{ type: 'wheel' as const, wheelDelta: 1 }, { type: 'drag' as const }, { button: 'right' as const }]) {
    assert.equal(pointer(component, title, event), undefined);
  }
  const click = pointer(component, title);
  assert.equal(click?.handled, true);
  assert.equal(click?.render, true, 'mouse toggle requests a TUI repaint');
  assert.match(plain(component.render(80)), /POINTER_HANDOFF/);
  assert.doesNotMatch(plain(other.render(80)), /POINTER_HANDOFF/, 'another message stays collapsed');
  component.invalidate();
  component.setOutputPad(2);
  assert.match(plain(component.render(30)), /POINTER_HANDOFF/, 'local expansion survives renderer reconstruction');
  const body = component.render(80).findIndex(line => plain([line]).includes('DELIVERY_DETAIL'));
  assert.equal(pointer(component, body)?.handled, true);
  assert.doesNotMatch(plain(component.render(80)), /POINTER_HANDOFF/);
  component.setExpanded(true);
  assert.match(plain(component.render(80)), /POINTER_HANDOFF/);
  assert.equal(pointer(component, title)?.handled, true);
  assert.doesNotMatch(plain(component.render(80)), /POINTER_HANDOFF/, 'a globally expanded message can be collapsed locally');
  component.setExpanded(false);
  component.setExpanded(true);
  assert.match(plain(component.render(80)), /POINTER_HANDOFF/, 'next global toggle overrides the local choice');
  assert.deepEqual(message, before);
});

test('short Subagent messages do not consume mouse clicks', () => {
  initTheme('dark');
  const message = deliveryMessage({ sourceId: 'sub_03', round: 1, jobId: 'sub_03_r1',
    content: 'SHORT_HANDOFF', terminal: { status: 'completed' } });
  const component = new CustomMessageComponent(message, renderers().delivery);
  const body = component.render(80).findIndex(line => plain([line]).includes('SHORT_HANDOFF'));
  assert.equal(pointer(component, body), undefined);
});

test('terminal control codes stay out of tool display without modifying the result', () => {
  initTheme('dark');
  const definition = renderers().resolver('external', () => undefined);
  assert.ok(definition);
  const text = '\x1b[31mTEXT\x1b[0m\x00\r';
  const result = { content: [{ type: 'text' as const, text }], details: undefined };
  const displayed = plain(tool(definition, result).render(40));
  assert.ok(displayed.includes('TEXT'));
  assert.ok(!displayed.includes('\x00') && !displayed.includes('\r'));
  assert.equal(result.content[0]!.text, text);
});
