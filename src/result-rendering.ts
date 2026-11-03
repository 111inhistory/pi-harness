import { stripVTControlCharacters } from 'node:util';
import { Box, Markdown, MouseRegion, Spacer, Text, getCapabilities, getImageDimensions, imageFallback, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { getMarkdownTheme, keyHint, type ExtensionAPI, type MessageRenderer, type Theme, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { DELIVERY_CUSTOM_TYPE, type DeliveryCustomMessage } from './subagent/delivery.ts';

const PREVIEW_LINES = 10;

interface FoldedComponent extends Component {
  toggle(): boolean;
}

/** Limit rendered rows, so minified JSON and wide text cannot bypass folding. */
function fold(component: Component, expanded: boolean, theme: Theme, onToggle?: (expanded: boolean) => void): FoldedComponent {
  let canFold = false;
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  const clearCache = (): void => { cachedWidth = undefined; cachedLines = undefined; };
  return {
    render(width) {
      if (cachedWidth !== width || cachedLines === undefined) {
        const lines = component.render(width);
        canFold = lines.length > PREVIEW_LINES;
        cachedLines = expanded || !canFold ? lines : [
          ...lines.slice(0, PREVIEW_LINES),
          truncateToWidth(theme.fg('muted', `… ${lines.length - PREVIEW_LINES} more lines · click or `) + keyHint('app.tools.expand', 'to expand'), width),
        ];
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

function createDeliveryRenderer(): MessageRenderer<DeliveryCustomMessage['details']> {
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
    const title = details === undefined ? message.customType
      : details.status === undefined
        ? details.sourceId
        : `${details.sourceId} · ${details.status} · round ${details.round}`;
    const box = new Box(options.outputPad ?? 1, 1, line => theme.bg('customMessageBg', line));
    box.addChild(new Text(theme.fg('customMessageLabel', theme.bold(`[${title}]`)), 0, 0));
    box.addChild(new Spacer(1));
    const body = fold(new Markdown(text, 0, 0, getMarkdownTheme(), {
      color: line => theme.fg('customMessageText', line),
    }), current.expanded, theme, expanded => { current.expanded = expanded; });
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
}
