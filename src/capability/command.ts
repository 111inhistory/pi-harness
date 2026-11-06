/**
 * The `/capability` command: browse the catalog, and enable a tool for the user.
 *
 * `list` is read-only: one eligible-tool read, one classification, one filter
 * and one stable order. It grants nothing and never starts retrieval.
 *
 * `enable` is the user's own path to a tool. `enable <target...>` enables the
 * named targets; a bare `enable` opens a picker over the same catalog view. Both
 * forms resolve every target against the live registry inside the operation
 * (`./enable.ts`), so a tool that Pi's MCP extension registered after a
 * reconnect is enableable without a restart or a model-driven discovery run.
 * Browsing and cancellation have no activation and no record side effect.
 *
 * Every completion and picker option comes from the current catalog read, never
 * from a snapshot: a stale entry can be chosen, but execution re-resolves it and
 * refuses a registration that is gone.
 */
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

import {
  CATEGORY_LABEL, CATEGORY_ORDER, createCapabilityCatalog,
  type CapabilityCategory, type CapabilityCatalogEntry, type CapabilityCatalogView,
} from './catalog.ts';
import { describeEnableSkip, enableCapabilityTargets, type EnableResult } from './enable.ts';

export type CapabilityCommand =
  | { readonly verb: 'list'; readonly category?: CapabilityCategory; readonly filter: string }
  | { readonly verb: 'enable'; readonly targets: readonly string[] };

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
const COMPLETION_LIMIT = 50;
const PICKER_TITLE = 'Enable a capability tool';
const NAMESPACE_SCHEME = 'namespace://';
const MCP_SCHEME = 'mcp://';

function isCategory(value: string): value is CapabilityCategory {
  return (CATEGORY_ORDER as readonly string[]).includes(value);
}

/** Parse the command line without touching tools or the branch. */
export function parseCapabilityCommand(raw: string): CapabilityCommand {
  const trimmed = raw.trim();
  if (trimmed === '') return { verb: 'list', filter: '' };
  const space = trimmed.search(/\s/);
  const verb = space < 0 ? trimmed : trimmed.slice(0, space);
  const rest = space < 0 ? '' : trimmed.slice(space + 1).trim();
  if (verb === 'enable') {
    return { verb: 'enable', targets: rest === '' ? [] : rest.split(/\s+/).filter((token) => token !== '') };
  }
  if (verb !== 'list') {
    throw new CapabilityCommandError(`Unknown subcommand: ${verb}. Expected one of: ${VERBS.join(', ')}.`);
  }
  const tokens = rest === '' ? [] : rest.split(/\s+/);
  const head = tokens[0]?.toLowerCase();
  if (head !== undefined && isCategory(head)) {
    return { verb: 'list', category: head, filter: tokens.slice(1).join(' ') };
  }
  return { verb: 'list', filter: rest };
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= DESCRIPTION_CHARS ? flat : `${flat.slice(0, DESCRIPTION_CHARS - 1)}…`;
}

function tags(entry: CapabilityCatalogEntry): string {
  const labels = [entry.active ? 'active' : undefined, entry.manual ? 'manual' : undefined]
    .filter((tag): tag is string => tag !== undefined);
  return labels.length === 0 ? '' : `  [${labels.join(', ')}]`;
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
        lines.push(`  ${entry.active ? '✔' : '○'} ${entry.display}${tags(entry)}`);
        if (entry.description !== '') lines.push(`      ${truncate(entry.description)}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd();
}

function renderEnable(targets: readonly string[], result: EnableResult): string {
  const lines = [`Capability · enable ${targets.join(' ')}`];
  const section = (title: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push('', title, ...items);
  };
  section('Enabled', result.enabled.map((name) => `  ✔ ${name}`));
  section('Already enabled', result.alreadyEnabled.map((name) => `  · ${name}`));
  section('Expanded', result.expanded.map((entry) => `  ${entry.target} → ${entry.tools.join(', ')}`));
  section('Refused', result.skipped.map((skip) => `  ✖ ${describeEnableSkip(skip)}`));
  section('Unknown targets', result.unresolved.map((target) => `  ? ${target}`));
  if (result.enabled.length === 0 && result.alreadyEnabled.length === 0 && result.skipped.length === 0
      && result.unresolved.length === 0) {
    lines.push('', 'Nothing to enable.');
  }
  if (result.recordError !== null) {
    lines.push('', `The enablement record could not be written: ${result.recordError}. `
      + 'The tool stays active only until the next request prunes it; run the command again.');
  }
  return lines.join('\n');
}

function pickerLabel(entry: CapabilityCatalogEntry): string {
  const detail = entry.description === '' ? entry.group : `${entry.group} · ${truncate(entry.description)}`;
  return `${entry.active ? '✔' : '○'} ${entry.name}  (${detail})`;
}

/**
 * Open the terminal picker over the current catalog and return the chosen tool.
 *
 * Returns null when the user cancels or the mode has no terminal UI; the caller
 * has already told the user what happened and must not touch any state.
 */
async function pickTarget(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string | null> {
  const view = createCapabilityCatalog(pi);
  if (view.entries.length === 0) {
    ctx.ui.notify('No eligible tools are registered. Nothing to enable.', 'info');
    return null;
  }
  const labels = view.entries.map(pickerLabel);
  let choice: string | undefined;
  try {
    choice = await ctx.ui.select(PICKER_TITLE, labels);
  } catch {
    ctx.ui.notify('The picker needs the terminal UI. Use /capability enable <name>.', 'info');
    return null;
  }
  if (choice === undefined) {
    ctx.ui.notify('Enable cancelled; no tool was activated.', 'info');
    return null;
  }
  const index = labels.indexOf(choice);
  return index < 0 ? null : view.entries[index]!.name;
}

async function runEnable(pi: ExtensionAPI, targets: readonly string[], ctx: ExtensionCommandContext): Promise<void> {
  const chosen = targets.length === 0 ? await pickTarget(pi, ctx) : null;
  if (targets.length === 0 && chosen === null) return;
  const resolved = chosen === null ? targets : [chosen];
  // The branch carries the user's own records; discovery selections in it are
  // not user authorization and must not suppress this operation's record.
  const result = enableCapabilityTargets(pi, resolved, { branch: ctx.sessionManager.getBranch() });
  const text = renderEnable(resolved, result);
  if (result.recordError !== null) ctx.ui.notify(text, 'error');
  else if (result.skipped.length > 0 || result.unresolved.length > 0) ctx.ui.notify(text, 'warning');
  else ctx.ui.notify(text, 'info');
}

/** Full-text argument completions: verbs, list categories, enable targets. */
export function capabilityArgumentCompletions(prefix: string, pi: ExtensionAPI): AutocompleteItem[] | null {
  const text = prefix.trimStart();
  const trailingSpace = /\s$/.test(text);
  const tokens = text.split(/\s+/).filter((token) => token !== '');
  const describe = (verb: typeof VERBS[number]): string =>
    verb === 'list' ? 'Browse the catalog (optional category and filter)' : 'Pick tools to enable';
  if (tokens.length === 0) {
    return VERBS.map((verb) => ({ value: `${verb} `, label: verb, description: describe(verb) }));
  }
  const [verb, ...rest] = tokens;
  if (rest.length === 0 && !trailingSpace) {
    const items = VERBS.filter((candidate) => candidate.startsWith(tokens[0]!.toLowerCase()))
      .map((candidate) => ({ value: `${candidate} `, label: candidate, description: describe(candidate) }));
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
    const needle = fragment.toLowerCase();
    const items: { value: string; label: string; description: string }[] = createCapabilityCatalog(pi).entries
      .filter((entry) => !chosen.has(entry.name)
        && (entry.name.toLowerCase().startsWith(needle) || entry.display.toLowerCase().startsWith(needle)))
      .map((entry) => ({
        value: `${head}${entry.name} `,
        label: entry.name,
        description: `${entry.group}${entry.manual ? ' · manual' : ''} · ${truncate(entry.description)}`,
      }));
    // A group expands to all of its registered members; the explicit scheme
    // keeps a group distinct from a tool with the same text.
    for (const group of enableGroups(pi, chosen)) {
      if (!group.label.toLowerCase().startsWith(needle) && !group.name.toLowerCase().startsWith(needle)) continue;
      items.push({ value: `${head}${group.label} `, label: group.label, description: group.description });
    }
    return items.length === 0 ? null : items.slice(0, COMPLETION_LIMIT);
  }
  return null;
}

/** Registered group refs, read from the live registry so a reconnect is visible. */
function enableGroups(pi: ExtensionAPI, chosen: ReadonlySet<string>): {
  readonly label: string; readonly name: string; readonly description: string;
}[] {
  const servers = new Map<string, number>();
  const namespaces = new Map<string, number>();
  for (const tool of pi.getAllTools()) {
    if (tool.exposure === 'hidden' || chosen.has(tool.name)) continue;
    const namespace = tool.namespace?.name;
    if (namespace === undefined) continue;
    if (namespace.startsWith('mcp__')) {
      for (const alias of tool.namespace?.aliases ?? [namespace.replace(/^mcp__/, '')]) {
        servers.set(alias, (servers.get(alias) ?? 0) + 1);
      }
      continue;
    }
    namespaces.set(namespace, (namespaces.get(namespace) ?? 0) + 1);
  }
  return [
    ...[...servers].map(([name, count]) => ({
      label: `${MCP_SCHEME}${name}`, name,
      description: `MCP server · ${count} registered tool${count === 1 ? '' : 's'}`,
    })),
    ...[...namespaces].map(([name, count]) => ({
      label: `${NAMESPACE_SCHEME}${name}`, name,
      description: `Namespace · ${count} registered tool${count === 1 ? '' : 's'}`,
    })),
  ];
}

/** Register the command on one Pi extension API. */
export function installCapabilityCommand(
  pi: ExtensionAPI,
  options: { readonly prepare?: (ctx: ExtensionCommandContext) => void } = {},
): void {
  pi.registerCommand('capability', {
    description: 'Browse the capability catalog and enable tools for the user',
    getArgumentCompletions: (prefix) => capabilityArgumentCompletions(prefix, pi),
    handler: async (raw, ctx) => {
      try {
        const command = parseCapabilityCommand(raw);
        // Re-read the configured manual policy before it is consulted, so a
        // project-level change applies to this operation.
        options.prepare?.(ctx);
        if (command.verb === 'list') {
          const view = createCapabilityCatalog(pi, {
            ...(command.category === undefined ? {} : { category: command.category }),
            filter: command.filter,
          });
          ctx.ui.notify(renderList(view, command), 'info');
          return;
        }
        await runEnable(pi, command.targets, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(error instanceof CapabilityCommandError ? `${error.code}: ${message}` : message, 'error');
      }
    },
  });
}
