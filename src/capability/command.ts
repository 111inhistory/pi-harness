/**
 * The `/capability` command: browse the three-state tool permissions and manage
 * them.
 *
 * `list <expr>` reads the derived four-state view (default `enabled+active`);
 * `enable`, `disable` and `reset` are the user control plane. The command only
 * renders the shared domain results; it never parses notifications or invents a
 * second permission model.
 *
 * Browsing is read-only. `enable` without targets opens a picker over the live
 * registry; every target is resolved against the registry at execution time.
 */
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

import { createCapabilityCatalog, type CapabilityCatalogEntry } from './catalog.ts';
import { describeEnableSkip, enableCapabilityTargets, type EnableResult } from './enable.ts';
import {
  parsePermissionQuery,
  queryToolPermissions,
  resetToolPermission,
  createToolPermissionResolver,
  setToolPermission,
  ToolPermissionQueryError,
  type ToolPermissionInfo,
  type ToolPermissionQueryResult,
  type ToolPermissionResetResult,
  type ToolPermissionSetResult,
  type ToolPermissionState,
} from './tool-permission.ts';

export type CapabilityCommand =
  | { readonly verb: 'list'; readonly expr: string }
  | { readonly verb: 'enable'; readonly targets: readonly string[] }
  | { readonly verb: 'disable'; readonly targets: readonly string[] }
  | { readonly verb: 'reset'; readonly targets: readonly string[] };

/** A refused command line; the handler reports it without touching any state. */
export class CapabilityCommandError extends Error {
  readonly code = 'invalid_command_args';

  constructor(message: string) {
    super(message);
    this.name = 'CapabilityCommandError';
  }
}

const VERBS = ['list', 'enable', 'disable', 'reset'] as const;
const TERMS = ['enabled', 'disabled', 'active', 'inactive', 'tool', 'namespace'] as const;
const COMPLETION_LIMIT = 50;
const DESCRIPTION_CHARS = 72;
const PICKER_TITLE = 'Choose a tool or group';
const NAMESPACE_SCHEME = 'namespace://';
const MCP_SCHEME = 'mcp://';

const STATE_MARK: Readonly<Record<ToolPermissionState, string>> = {
  enabled: '✔',
  disabled: '✖',
  active: '●',
  inactive: '○',
};

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= DESCRIPTION_CHARS ? flat : `${flat.slice(0, DESCRIPTION_CHARS - 1)}…`;
}

/** Parse the command line without touching tools or the branch. */
export function parseCapabilityCommand(raw: string): CapabilityCommand {
  const trimmed = raw.trim();
  if (trimmed === '') return { verb: 'list', expr: '' };
  const space = trimmed.search(/\s/);
  const verb = space < 0 ? trimmed : trimmed.slice(0, space);
  const rest = space < 0 ? '' : trimmed.slice(space + 1).trim();
  if (verb === 'list') return { verb: 'list', expr: rest };
  if (verb === 'enable' || verb === 'disable' || verb === 'reset') {
    return { verb, targets: rest === '' ? [] : rest.split(/\s+/).filter((token) => token !== '') };
  }
  throw new CapabilityCommandError(`Unknown subcommand: ${verb}. Expected one of: ${VERBS.join(', ')}.`);
}

const LIST_USAGE = 'Usage: /capability list [expr]  (expr terms: enabled, disabled, active, inactive, tool, namespace; default enabled+active)';
const TARGET_USAGE = 'Usage: /capability enable [targets] | disable <targets> | reset <targets>';

function renderList(result: ToolPermissionQueryResult): string {
  const lines = [`Capability · ${result.entries.length} tool${result.entries.length === 1 ? '' : 's'} · ${result.expression}`];
  if (result.entries.length === 0) {
    lines.push('', 'No tools match this expression.');
  } else {
    for (const entry of result.entries) {
      const category = entry.category === 'namespace' ? ' · namespace' : '';
      lines.push(`  ${STATE_MARK[entry.state]} ${entry.name}  [${entry.state}${category}]`);
    }
  }
  return lines.join('\n');
}

function renderSet(verb: 'enable' | 'disable', targets: readonly string[], result: ToolPermissionSetResult): string {
  const lines = [`Capability · ${verb} ${targets.join(' ')}`];
  const section = (title: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push('', title, ...items);
  };
  section('Changed', result.changed.map((change) => `  ${result.state === 'enabled' ? '✔' : '✖'} ${change.target}`));
  section('Activated', result.activated.map((name) => `  ● ${name}`));
  section('Removed from the active set now (Codemode-only)', result.removedActive.map((name) => `  – ${name}`));
  section('Blocked now; declaration removed at next compaction', result.pendingCompaction.map((name) => `  ⏳ ${name}`));
  section('Already set', result.alreadySet.map((target) => `  · ${target}`));
  section('Refused', result.skipped.map((skip) => `  ! ${skip.target}: ${skip.reason}`));
  section('Unknown targets', result.unresolved.map((target) => `  ? ${target}`));
  if (result.recordError !== null) {
    lines.push('', `The permission record could not be written: ${result.recordError}. Nothing changed.`);
  }
  if (result.state === 'disabled' && (result.removedActive.length > 0 || result.pendingCompaction.length > 0)) {
    lines.push('', 'Disabled tools cannot be called now; a declared tool keeps its declaration until the next successful compaction.');
  }
  return lines.join('\n');
}

function renderReset(result: ToolPermissionResetResult): string {
  const lines = ['Capability · reset'];
  const section = (title: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push('', title, ...items);
  };
  section('Reset', result.reset.map((change) => `  · ${change.target}`));
  section('Not managed', result.notManaged.map((target) => `  · ${target}`));
  section('Still managed', result.stillManaged.map((entry) => `  ${entry.state === 'enabled' ? '✔' : '✖'} ${entry.name} → ${entry.state}`));
  if (result.recordError !== null) {
    lines.push('', `The permission record could not be written: ${result.recordError}. Nothing was reset.`);
  }
  if (result.reset.length > 0) {
    lines.push('', 'Reset removes the explicit rule only; it never activates the tool or grants another limit.');
  }
  return lines.join('\n');
}

function pickerLabel(entry: CapabilityCatalogEntry, info: ToolPermissionInfo): string {
  const detail = entry.description === '' ? entry.group : `${entry.group} · ${truncate(entry.description)}`;
  return `${STATE_MARK[info.state]} ${entry.name}  (${info.state}${detail === '' ? '' : ` · ${detail}`})`;
}

/**
 * Open the terminal picker over registered groups and individual tools.
 * Returns null when the user cancels or the mode has no terminal UI.
 */
async function pickTarget(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string | null> {
  const view = createCapabilityCatalog(pi);
  if (view.entries.length === 0) {
    ctx.ui.notify('No eligible tools are registered. Nothing to enable.', 'info');
    return null;
  }
  const branch = ctx.sessionManager.getBranch();
  const active = new Set(pi.getActiveTools());
  const permission = createToolPermissionResolver(pi, pi.getAllTools(), branch);
  const eligible = new Set(view.entries.map((entry) => entry.name));
  const groups = enableGroups(pi, new Set(), eligible);
  const targets = [...groups.map((group) => group.label), ...view.entries.map((entry) => entry.name)];
  const labels = [
    ...groups.map((group) => `${group.label}  (${group.description})`),
    ...view.entries.map((entry) => pickerLabel(entry, permission.resolve(entry.name, active.has(entry.name)))),
  ];
  let choice: string | undefined;
  try {
    choice = await ctx.ui.select(PICKER_TITLE, labels);
  } catch {
    ctx.ui.notify('The picker needs the terminal UI. Use /capability enable <target>.', 'info');
    return null;
  }
  if (choice === undefined) {
    ctx.ui.notify('Enable cancelled; nothing changed.', 'info');
    return null;
  }
  const index = labels.indexOf(choice);
  return index < 0 ? null : targets[index]!;
}

function renderEnable(targets: readonly string[], result: EnableResult): string {
  const lines = [`Capability · enable ${targets.join(' ')}`];
  const section = (title: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push('', title, ...items);
  };
  section('Enabled', result.enabled.map((name) => `  ✔ ${name}`));
  section('Already enabled', result.alreadyEnabled.map((target) => `  · ${target}`));
  section('Skipped', result.skipped.map((skip) => `  ! ${describeEnableSkip(skip)}`));
  section('Unknown targets', result.unresolved.map((target) => `  ? ${target}`));
  if (result.recordError !== null) {
    lines.push('', `The permission record could not be written: ${result.recordError}. Nothing changed.`);
  }
  return lines.join('\n');
}

async function runEnable(pi: ExtensionAPI, targets: readonly string[], ctx: ExtensionCommandContext): Promise<void> {
  const chosen = targets.length === 0 ? await pickTarget(pi, ctx) : null;
  if (targets.length === 0 && chosen === null) return;
  const resolved = chosen === null ? targets : [chosen];
  const result = enableCapabilityTargets(pi, resolved, { branch: ctx.sessionManager.getBranch() });
  const text = renderEnable(resolved, result);
  if (result.recordError !== null) ctx.ui.notify(text, 'error');
  else if (result.skipped.length > 0 || result.unresolved.length > 0) ctx.ui.notify(text, 'warning');
  else ctx.ui.notify(text, 'info');
}

function runDisable(pi: ExtensionAPI, targets: readonly string[], ctx: ExtensionCommandContext): void {
  if (targets.length === 0) { ctx.ui.notify(TARGET_USAGE, 'info'); return; }
  const result = setToolPermission(pi, pi, ctx.sessionManager.getBranch(), targets, 'disabled');
  const text = renderSet('disable', targets, result);
  if (result.recordError !== null) ctx.ui.notify(text, 'error');
  else if (result.skipped.length > 0 || result.unresolved.length > 0) ctx.ui.notify(text, 'warning');
  else ctx.ui.notify(text, 'info');
}

function runReset(pi: ExtensionAPI, targets: readonly string[], ctx: ExtensionCommandContext): void {
  if (targets.length === 0) { ctx.ui.notify(TARGET_USAGE, 'info'); return; }
  const result = resetToolPermission(pi, pi, ctx.sessionManager.getBranch(), targets);
  const text = renderReset(result);
  if (result.recordError !== null) ctx.ui.notify(text, 'error');
  else if (result.notManaged.length > 0 || result.stillManaged.length > 0) ctx.ui.notify(text, 'warning');
  else ctx.ui.notify(text, 'info');
}

/** Full-text argument completions: verbs, list terms, and target names/groups. */
export function capabilityArgumentCompletions(prefix: string, pi: ExtensionAPI): AutocompleteItem[] | null {
  const text = prefix.trimStart();
  const trailingSpace = /\s$/.test(text);
  const tokens = text.split(/\s+/).filter((token) => token !== '');
  const describe = (verb: (typeof VERBS)[number]): string => {
    if (verb === 'list') return 'List tools by four-state expression (default enabled+active)';
    if (verb === 'enable') return 'Enable tools or groups for the user';
    if (verb === 'disable') return 'Disable tools or groups';
    return 'Reset explicit permission rules';
  };
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
    const fragment = trailingSpace ? '' : rest.at(-1) ?? '';
    const head = text.slice(0, text.length - fragment.length);
    const needle = fragment.toLowerCase();
    const items = TERMS.filter((term) => term.startsWith(needle))
      .map((term) => ({ value: `${head}${term}`, label: term, description: `List term: ${term}` }));
    return items.length === 0 ? null : items;
  }
  if (verb !== 'enable' && verb !== 'disable' && verb !== 'reset') return null;
  const fragment = trailingSpace ? '' : rest.at(-1) ?? '';
  const chosen = new Set(trailingSpace ? rest : rest.slice(0, -1));
  const head = text.slice(0, text.length - fragment.length);
  const needle = fragment.toLowerCase();
  const view = createCapabilityCatalog(pi);
  const items: { value: string; label: string; description: string }[] = view.entries
    .filter((entry) => !chosen.has(entry.name)
      && (entry.name.toLowerCase().startsWith(needle) || entry.display.toLowerCase().startsWith(needle)))
    .map((entry) => ({
      value: `${head}${entry.name} `,
      label: entry.name,
      description: `${entry.group} · ${truncate(entry.description)}`,
    }));
  const groups: typeof items = [];
  const groupNeedle = needle.replace(/^(?:namespace|mcp):\/\//, '');
  for (const group of enableGroups(pi, chosen, new Set(view.entries.map((entry) => entry.name)))) {
    if (needle.includes('://') && !group.label.startsWith(needle.slice(0, needle.indexOf('://') + 3))) continue;
    if (!group.label.toLowerCase().startsWith(needle)
      && !group.name.toLowerCase().startsWith(groupNeedle)
      && !group.aliases.some((alias) => alias.toLowerCase().startsWith(groupNeedle))) continue;
    groups.push({ value: `${head}${group.label} `, label: group.label, description: group.description });
  }
  const matches = [...groups, ...items];
  return matches.length === 0 ? null : matches.slice(0, COMPLETION_LIMIT);
}

/** Registered group refs, read from the live registry so a reconnect is visible. */
function enableGroups(pi: ExtensionAPI, chosen: ReadonlySet<string>, eligible: ReadonlySet<string>): {
  readonly label: string; readonly name: string; readonly aliases: readonly string[]; readonly description: string;
}[] {
  const servers = new Map<string, number>();
  const namespaces = new Map<string, { count: number; aliases: Set<string> }>();
  for (const tool of pi.getAllTools()) {
    if (!eligible.has(tool.name) || chosen.has(tool.name)) continue;
    const namespace = tool.namespace?.name;
    if (namespace === undefined) continue;
    if (namespace.startsWith('mcp__')) {
      const aliases = tool.namespace?.aliases;
      for (const alias of aliases?.length ? aliases : [namespace.replace(/^mcp__/, '')]) {
        servers.set(alias, (servers.get(alias) ?? 0) + 1);
      }
      // MCP groups are presented as `mcp://server`; do not repeat the same
      // namespace as `namespace://mcp__server` in the picker or completion.
      continue;
    }
    const group = namespaces.get(namespace) ?? { count: 0, aliases: new Set<string>() };
    group.count++;
    for (const alias of tool.namespace?.aliases ?? []) group.aliases.add(alias);
    namespaces.set(namespace, group);
  }
  return [
    ...[...servers].map(([name, count]) => ({
      label: `${MCP_SCHEME}${name}`, name, aliases: [],
      description: `MCP server · ${count} registered tool${count === 1 ? '' : 's'}`,
    })),
    ...[...namespaces].map(([name, group]) => ({
      label: `${NAMESPACE_SCHEME}${name}`, name, aliases: [...group.aliases],
      description: `Namespace · ${group.count} registered tool${group.count === 1 ? '' : 's'}`,
    })),
  ];
}

/** Register the command on one Pi extension API. */
export function installCapabilityCommand(
  pi: ExtensionAPI,
  options: { readonly prepare?: (ctx: ExtensionCommandContext) => void } = {},
): void {
  pi.registerCommand('capability', {
    description: 'Browse and manage three-state tool permissions',
    getArgumentCompletions: (prefix) => capabilityArgumentCompletions(prefix, pi),
    handler: async (raw, ctx) => {
      try {
        const command = parseCapabilityCommand(raw);
        // Re-read the configured manual seed before it is consulted.
        options.prepare?.(ctx);
        if (command.verb === 'list') {
          // Validate the expression here so an invalid one is reported without
          // touching any state.
          parsePermissionQuery(command.expr);
          const result = queryToolPermissions(
            pi, ctx.sessionManager.getBranch(), pi.getActiveTools(),
            command.expr === '' ? undefined : command.expr,
          );
          ctx.ui.notify(renderList(result), 'info');
          return;
        }
        if (command.verb === 'enable') { await runEnable(pi, command.targets, ctx); return; }
        if (command.verb === 'disable') { runDisable(pi, command.targets, ctx); return; }
        runReset(pi, command.targets, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ToolPermissionQueryError) ctx.ui.notify(`${error.code}: ${message}\n${LIST_USAGE}`, 'error');
        else if (error instanceof CapabilityCommandError) ctx.ui.notify(`${error.code}: ${message}`, 'error');
        else ctx.ui.notify(message, 'error');
      }
    },
  });
}
