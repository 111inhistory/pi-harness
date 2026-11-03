/**
 * `/capability` command: the human entry for the capability catalog.
 *
 * Two subcommands only:
 * - `list [tool|mcp|namespace] [filter]` prints the current eligible catalog,
 *   grouped by category and, where it applies, by MCP server or namespace.
 *   The filter is plain text over the registered catalog; no model and no
 *   retrieval run.
 * - `enable` opens a native filterable picker; `enable <name...>` keeps the
 *   name shortcut. Both go through the same activation and `manual` record path.
 *
 * Enablement is append-only: there is no disable, remove or reset subcommand.
 * The picker lists manual tools so the user can browse them, but browsing grants
 * nothing; only the explicit selection enables and records.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem, KeybindingsManager } from '@earendil-works/pi-tui';

import {
  CATEGORY_LABEL, CATEGORY_ORDER, createCapabilityCatalog, type CapabilityCategory, type CapabilityCatalogView,
} from './catalog.ts';
import { manualEnabledTools } from './discovery-record.ts';
import { enableManualTools } from './manual.ts';
import { createCapabilitySelector } from './selector.ts';

export type CapabilityCommand =
  | { readonly verb: 'list'; readonly category?: CapabilityCategory; readonly filter: string }
  | { readonly verb: 'enable'; readonly names: readonly string[] };

/** A refused command line; the handler reports it without touching any state. */
export class CapabilityCommandError extends Error {
  readonly code = 'invalid_command_args';

  constructor(message: string) {
    super(message);
    this.name = 'CapabilityCommandError';
  }
}

const VERBS = ['list', 'enable'] as const;
const DESCRIPTION_CHARS = 72;
const COMPLETION_LIMIT = 20;

function isCategory(value: string): value is CapabilityCategory {
  return (CATEGORY_ORDER as readonly string[]).includes(value);
}

/**
 * Parse the raw argument string without touching tools or the branch.
 *
 * `list` reads `[category] [filter]`: the first word is a category only when it
 * is exactly one of the three names, so the filter never competes with it.
 */
export function parseCapabilityCommand(raw: string): CapabilityCommand {
  const trimmed = raw.trim();
  if (trimmed === '') return { verb: 'list', filter: '' };
  const space = trimmed.search(/\s/);
  const verb = space < 0 ? trimmed : trimmed.slice(0, space);
  const rest = space < 0 ? '' : trimmed.slice(space + 1).trim();
  if (verb === 'list') {
    const tokens = rest === '' ? [] : rest.split(/\s+/);
    const head = tokens[0]?.toLowerCase();
    if (head !== undefined && isCategory(head)) {
      return { verb: 'list', category: head, filter: tokens.slice(1).join(' ') };
    }
    return { verb: 'list', filter: rest };
  }
  if (verb === 'enable') {
    return { verb: 'enable', names: rest === '' ? [] : rest.split(/\s+/) };
  }
  throw new CapabilityCommandError(`Unknown subcommand: ${verb}. Expected one of: ${VERBS.join(', ')}.`);
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= DESCRIPTION_CHARS ? flat : `${flat.slice(0, DESCRIPTION_CHARS - 1)}…`;
}

function renderList(view: CapabilityCatalogView, command: Extract<CapabilityCommand, { verb: 'list' }>): string {
  const scope = command.category === undefined ? 'all categories' : CATEGORY_LABEL[command.category];
  const header = command.filter === ''
    ? `Capability · ${view.entries.length} tools · ${scope}`
    : `Capability · ${view.entries.length} matches for "${command.filter}" · ${scope}`;
  if (view.entries.length === 0) {
    return `${header}\n\nNo tools match. Try /capability list for the full catalog, or another word.`;
  }
  const lines = [header, ''];
  for (const section of view.sections) {
    for (const group of section.groups) {
      lines.push(`${CATEGORY_LABEL[section.category]} · ${group.group}`);
      for (const entry of group.entries) {
        const tags = [entry.active ? 'active' : undefined, entry.manual ? 'manual' : undefined]
          .filter((tag): tag is string => tag !== undefined);
        lines.push(`  ${entry.active ? '✔' : '○'} ${entry.display}${tags.length === 0 ? '' : `  [${tags.join(', ')}]`}`);
        if (entry.description !== '') lines.push(`      ${truncate(entry.description)}`);
      }
      lines.push('');
    }
  }
  lines.push('Enable with /capability enable (opens a picker) or /capability enable <name>.');
  return lines.join('\n').trimEnd();
}

function renderEnable(result: ReturnType<typeof enableManualTools>): string {
  const lines: string[] = [];
  lines.push(result.enabled.length === 0 ? 'Enabled: none' : `Enabled: ${result.enabled.join(', ')}`);
  if (result.alreadyActive.length > 0) lines.push(`Already active: ${result.alreadyActive.join(', ')}`);
  const reasons: ReadonlyArray<[string, (reason: string) => boolean]> = [
    ['Not registered', (reason) => reason === 'not_registered'],
    ['Hidden', (reason) => reason === 'hidden'],
    ['Not permitted', (reason) => reason === 'not_permitted'],
    ['Not activated', (reason) => reason === 'not_activated'],
  ];
  for (const [label, match] of reasons) {
    const names = result.skipped.filter((skip) => match(skip.reason)).map((skip) => skip.name);
    if (names.length > 0) lines.push(`${label}: ${names.join(', ')}`);
  }
  if (result.recordError !== null) {
    lines.push(`Warning: the tools are active in this session, but the branch record could not be saved: ${result.recordError}`);
  }
  return lines.join('\n');
}

/** Open the native picker and enable exactly the selected tool. */
async function pickAndEnable(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const view = createCapabilityCatalog(pi);
  if (view.entries.length === 0) {
    ctx.ui.notify('No eligible tools are registered. Nothing to enable.', 'info');
    return;
  }
  // `custom` is a terminal UI: RPC and print modes report instead of guessing.
  if (ctx.mode !== 'tui') {
    ctx.ui.notify('The enable picker needs the terminal UI. Use /capability enable <name>.', 'info');
    return;
  }
  const chosen = await ctx.ui.custom<string | undefined>((_tui, theme: Theme, keybindings: KeybindingsManager, done) =>
    createCapabilitySelector(view.entries, theme, keybindings, done));
  if (chosen === undefined) {
    ctx.ui.notify('Cancelled. Nothing was enabled.', 'info');
    return;
  }
  ctx.ui.notify(renderEnable(enableManualTools(pi, [chosen], {
    recorded: manualEnabledTools(ctx.sessionManager.getBranch()),
  })), 'info');
}

async function run(
  raw: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  prepare: ((ctx: ExtensionCommandContext) => void) | undefined,
): Promise<void> {
  const command = parseCapabilityCommand(raw);
  // Refresh the manual-tool policy before any catalog read: the command may run
  // before the first turn of a session.
  prepare?.(ctx);
  if (command.verb === 'list') {
    ctx.ui.notify(renderList(createCapabilityCatalog(pi, {
      ...(command.category === undefined ? {} : { category: command.category }),
      filter: command.filter,
    }), command), 'info');
    return;
  }
  if (command.names.length === 0) {
    await pickAndEnable(ctx, pi);
    return;
  }
  ctx.ui.notify(renderEnable(enableManualTools(pi, command.names, {
    recorded: manualEnabledTools(ctx.sessionManager.getBranch()),
  })), 'info');
}

/** Full-text argument completions: verbs, list categories, enable tool names. */
export function capabilityArgumentCompletions(prefix: string, pi: ExtensionAPI): AutocompleteItem[] | null {
  const text = prefix.trimStart();
  const trailingSpace = /\s$/.test(text);
  const tokens = text.split(/\s+/).filter((token) => token !== '');
  if (tokens.length === 0) {
    return VERBS.map((verb) => ({
      // A trailing space puts the cursor at the next argument; the editor inserts
      // the value verbatim for arguments.
      value: `${verb} `,
      label: verb,
      description: verb === 'list' ? 'Browse the catalog (optional category and filter)' : 'Pick tools to enable',
    }));
  }
  const [verb, ...rest] = tokens;
  if (rest.length === 0 && !trailingSpace) {
    const items = VERBS.filter((candidate) => candidate.startsWith(tokens[0]!))
      .map((candidate) => ({
        value: `${candidate} `,
        label: candidate,
        description: candidate === 'list' ? 'Browse the catalog (optional category and filter)' : 'Pick tools to enable',
      }));
    return items.length === 0 ? null : items;
  }
  if (verb === 'list') {
    // After the verb a category is the only positional completion; once a
    // category or free text is present, the rest is the filter.
    if (rest.length === 0) {
      return CATEGORY_ORDER.map((category) => ({
        value: `list ${category} `, label: category, description: `${CATEGORY_LABEL[category]} only`,
      }));
    }
    if (rest.length === 1 && !trailingSpace) {
      const items = CATEGORY_ORDER.filter((category) => category.startsWith(rest[0]!.toLowerCase()))
        .map((category) => ({
          value: `list ${category} `, label: category, description: `${CATEGORY_LABEL[category]} only`,
        }));
      return items.length === 0 ? null : items;
    }
    return null;
  }
  if (verb === 'enable') {
    const fragment = trailingSpace ? '' : rest.at(-1) ?? '';
    const chosen = new Set(trailingSpace ? rest : rest.slice(0, -1));
    const head = text.slice(0, text.length - fragment.length);
    const items = createCapabilityCatalog(pi).entries
      .filter((entry) => !chosen.has(entry.name) && entry.name.toLowerCase().startsWith(fragment.toLowerCase()))
      .slice(0, COMPLETION_LIMIT)
      .map((entry) => ({
        value: `${head}${entry.name} `,
        label: entry.name,
        description: `${entry.group} · ${truncate(entry.description)}`,
      }));
    return items.length === 0 ? null : items;
  }
  return null;
}

/** Register the command on one Pi extension API. */
export function installCapabilityCommand(
  pi: ExtensionAPI,
  options: { readonly prepare?: (ctx: ExtensionCommandContext) => void } = {},
): void {
  pi.registerCommand('capability', {
    description: 'Browse the capability catalog and enable tools (append-only)',
    getArgumentCompletions: (prefix) => capabilityArgumentCompletions(prefix, pi),
    handler: async (raw, ctx) => {
      try {
        await run(raw, ctx, pi, options.prepare);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(error instanceof CapabilityCommandError ? `${error.code}: ${message}` : message, 'error');
      }
    },
  });
}
