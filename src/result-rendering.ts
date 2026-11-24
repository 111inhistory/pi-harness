import { stripVTControlCharacters } from 'node:util';
import { Box, Markdown, MouseRegion, Spacer, Text, getCapabilities, getImageDimensions, imageFallback, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { getMarkdownTheme, keyHint, type ExtensionAPI, type MessageRenderer, type Theme, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ShellResult } from './async-shell/protocol.ts';
import { describeShellResult, type ShellPresentation } from './async-shell/presentation.ts';
import { DELIVERY_CUSTOM_TYPE, type DeliveryCustomMessage } from './subagent/delivery.ts';

const PREVIEW_LINES = 10;

interface FoldedComponent extends Component {
  toggle(): boolean;
}

/** Limit rendered rows, so minified JSON and wide text cannot bypass folding. */
function fold(component: Component, expanded: boolean, theme: Theme, onToggle?: (expanded: boolean) => void, keepTail = false): FoldedComponent {
  let canFold = false;
  let cachedWidth: number | undefined;
  let cachedLines: readonly string[] | undefined;
  const clearCache = (): void => { cachedWidth = undefined; cachedLines = undefined; };
  return {
    render(width) {
      if (cachedWidth !== width || cachedLines === undefined) {
        const lines = component.render(width);
        canFold = lines.length > PREVIEW_LINES;
        if (expanded || !canFold) cachedLines = lines;
        else {
          const hint = truncateToWidth(theme.fg('muted', `… ${lines.length - PREVIEW_LINES} ${keepTail ? 'earlier' : 'more'} lines · click or `) + keyHint('app.tools.expand', 'to expand'), width);
          cachedLines = keepTail ? [hint, ...lines.slice(-PREVIEW_LINES)] : [...lines.slice(0, PREVIEW_LINES), hint];
        }
        cachedWidth = width;
      }
      return cachedLines;
    },
    toggle() {
      if (!canFold) return false;
      expanded = !expanded;
      onToggle?.(expanded);
      clearCache();
      return true;
    },
    invalidate() {
      component.invalidate();
      clearCache();
    },
  };
}

const renderResult: NonNullable<ToolDefinition['renderResult']> = (result, options, theme, context) => {
  const blocks = result.content.filter(part => part.type === 'text').map(part =>
    stripVTControlCharacters(part.text).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\r\uFFF9-\uFFFB]/g, ''));
  if (!getCapabilities().images || !context.showImages) {
    for (const image of result.content.filter(part => part.type === 'image')) {
      blocks.push(imageFallback(image.mimeType, getImageDimensions(image.data, image.mimeType) ?? undefined));
    }
  }
  return fold(new Text(theme.fg('toolOutput', blocks.join('\n')), 0, 0), options.expanded, theme);
};

/** Only the already bounded output body folds: status and recovery hints stay visible. */
export function renderShellPresentation(view: ShellPresentation, expanded: boolean, theme: Theme, onToggle?: (expanded: boolean) => void): Component {
  const box = new Box(0, 0);
  const safe = (text: string): string => stripVTControlCharacters(text).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\r\uFFF9-\uFFFB]/g, '');
  if (view.summary) box.addChild(new Text(theme.fg('toolTitle', safe(view.summary)), 0, 0));
  if (view.message) box.addChild(new Text(theme.fg('warning', safe(view.message)), 0, 0));
  const body = fold(new Text(theme.fg('toolOutput', safe(view.output)), 0, 0), expanded, theme, onToggle, view.terminal);
  if (view.output) box.addChild(body);
  if (view.footer) box.addChild(new Text(theme.fg('muted', safe(view.footer)), 0, 0));
  return new MouseRegion(box, event => {
    if (event.type !== 'click' || event.button !== 'left' || !body.toggle()) return undefined;
    return { handled: true, render: true };
  });
}

function createDeliveryRenderer(): MessageRenderer<DeliveryCustomMessage['details'] | { source: 'host'; result: ShellResult }> {
  // CustomMessageComponent rebuilds renderers on invalidation. Keep pointer state
  // per message across those rebuilds; a changed Ctrl+O state takes precedence.
  const states = new WeakMap<object, { expanded: boolean; globalExpanded: boolean }>();
  return (message, options, theme) => {
    let state = states.get(message);
    if (state === undefined || state.globalExpanded !== options.expanded) {
      state = { expanded: options.expanded, globalExpanded: options.expanded };
      states.set(message, state);
    }
    const current = state;
    const text = typeof message.content === 'string' ? message.content
      : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const details = message.details;
    const shell = details !== undefined && 'result' in details ? details.result : undefined;
    const box = new Box(options.outputPad ?? 1, 1, line => theme.bg('customMessageBg', line));
    if (shell !== undefined) {
      box.addChild(renderShellPresentation(describeShellResult(shell, 'terminal'), current.expanded, theme,
        expanded => { current.expanded = expanded; }));
      return box;
    }
    const title = !details || 'result' in details ? message.customType : `${details.sourceId} · round ${details.round}`;
    box.addChild(new Text(theme.fg('customMessageLabel', theme.bold(`[${title}]`)), 0, 0));
    box.addChild(new Spacer(1));
    const content = new Markdown(text, 0, 0, getMarkdownTheme(), { color: line => theme.fg('customMessageText', line) });
    const body = fold(content, current.expanded, theme, expanded => { current.expanded = expanded; });
    box.addChild(body);
    return new MouseRegion(box, event => {
      if (event.type !== 'click' || event.button !== 'left' || !body.toggle()) return undefined;
      return { handled: true, render: true };
    });
  };
}

/** Display only: tool content, details, and provider messages stay unchanged. */
export function installResultRendering(pi: Pick<ExtensionAPI, 'registerToolRenderer' | 'registerMessageRenderer'>): void {
  pi.registerToolRenderer((_name, next) => {
    const current = next();
    return current?.renderResult ? current : { ...current, renderResult };
  });
  pi.registerMessageRenderer(DELIVERY_CUSTOM_TYPE, createDeliveryRenderer());
  pi.registerMessageRenderer('async-shell-result', createDeliveryRenderer());
}
