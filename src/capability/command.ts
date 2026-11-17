/**
 * The `/capability` command: inspect and manage the three independent tool
 * collections.
 *
 * Base membership is the explicit baseline, dynamic membership is what the
 * user or Capability discovery activated, and the blacklist denies a tool
 * regardless of either membership. The generated view keeps those facts
 * independent; this command only parses arguments, calls the shared domain
 * operations and renders their structured results. It never derives a second
 * four-state permission model.
 *
 * Browsing is read-only. `activate`/`deactivate` without targets open a picker
 * over the live registry; every target is resolved against the registry by the
 * domain operation at execution time.
 */
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

import { createCapabilityPicker } from '../tui/capability-picker.ts';

import {
  addBaseTools,
  addBlacklistTargets,
  activateToolTargets,
  deactivateToolTargets,
  removeBaseTools,
  removeBlacklistTargets,
  type ToolWriteResult,
} from './tool-access.ts';
import {
  createToolAccessView,
  listBaseTools,
  listBlacklist,
  queryToolAccess,
  type ToolAccessListing,
  type ToolAccessQueryResult,
  type ToolBlacklistTarget,
  type ToolCollectionTarget,
} from './tool-access-view.ts';

export type CapabilityCommand =
  | { readonly verb: 'help' }
  | { readonly verb: 'list'; readonly activatable: boolean; readonly usable: boolean; readonly filter: string | null }
  | { readonly verb: 'base'; readonly action: 'add' | 'remove' | 'list'; readonly targets: readonly string[] }
  | { readonly verb: 'activate'; readonly targets: readonly string[] }
  | { readonly verb: 'deactivate'; readonly targets: readonly string[] }
  | { readonly verb: 'blacklist'; readonly action: 'add' | 'remove' | 'list'; readonly targets: readonly string[] };

/** A refused command line; the handler reports it without touching any state. */
export class CapabilityCommandError extends Error {
  readonly code = 'invalid_command_args';

  constructor(message: string) {
    super(message);
    this.name = 'CapabilityCommandError';
  }
}

const VERBS = ['base', 'blacklist', 'activate', 'deactivate', 'help', 'list'] as const;
const COLLECTION_ACTIONS = ['add', 'remove', 'list'] as const;
const LIST_FLAGS = ['--activatable', '--usable'] as const;
const COMPLETION_LIMIT = 50;
const DESCRIPTION_CHARS = 72;
const NAMESPACE_SCHEME = 'namespace://';
const MCP_SCHEME = 'mcp://';

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= DESCRIPTION_CHARS ? flat : `${flat.slice(0, DESCRIPTION_CHARS - 1)}…`;
}

function targetsOf(rest: readonly string[]): readonly string[] {
  return rest.filter((token) => token !== '');
}


/** Parse the command line without touching tools or the branch. */
export function parseCapabilityCommand(raw: string): CapabilityCommand {
  const trimmed = raw.trim();
  if (trimmed === '') return { verb: 'list', activatable: false, usable: false, filter: null };
  const space = trimmed.search(/\s/);
  const verb = space < 0 ? trimmed : trimmed.slice(0, space);
  const rest = space < 0 ? '' : trimmed.slice(space + 1).trim();
  const tokens = rest === '' ? [] : rest.split(/\s+/);

  if (verb === 'help') {
    if (tokens.length > 0) throw new CapabilityCommandError('/capability help takes no arguments.');
    return { verb: 'help' };
  }

  if (verb === 'list') {
    let activatable = false;
    let usable = false;
    let filter: string | null = null;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token === '--activatable') { activatable = true; continue; }
      if (token === '--usable') { usable = true; continue; }
      if (token === '--filter') {
        if (index + 1 >= tokens.length) throw new CapabilityCommandError('The --filter flag needs a value.');
        filter = tokens[index + 1]!;
        index += 1;
        continue;
      }
      if (token.startsWith('--filter=')) { filter = token.slice('--filter='.length); continue; }
      if (token.startsWith('--')) {
        throw new CapabilityCommandError(`Unknown list flag: ${token}. Expected one of: ${LIST_FLAGS.join(', ')}, --filter=<text>.`);
      }
      throw new CapabilityCommandError(`Unexpected list argument: ${token}. Use --filter=<text> for text filtering.`);
    }
    return { verb: 'list', activatable, usable, filter };
  }

  if (verb === 'activate' || verb === 'deactivate') {
    for (const token of tokens) {
      if (token.startsWith('--')) throw new CapabilityCommandError(`Unexpected flag for ${verb}: ${token}.`);
    }
    return { verb, targets: targetsOf(tokens) };
  }

  if (verb === 'base' || verb === 'blacklist') {
    const action = tokens[0];
    if (action !== 'add' && action !== 'remove' && action !== 'list') {
      throw new CapabilityCommandError(`Usage: /capability ${verb} add <targets> | remove <targets> | list`);
    }
    const targets = targetsOf(tokens.slice(1));
    if (action === 'list' && targets.length > 0) {
      throw new CapabilityCommandError(`/capability ${verb} list takes no targets.`);
    }
    if (action !== 'list' && targets.length === 0) {
      throw new CapabilityCommandError(`Usage: /capability ${verb} ${action} <targets>`);
    }
    for (const target of targets) {
      if (target.startsWith('--')) throw new CapabilityCommandError(`Unexpected flag for ${verb} ${action}: ${target}.`);
    }
    return { verb, action, targets };
  }

  throw new CapabilityCommandError(`Unknown subcommand: ${verb}. Expected one of: ${VERBS.join(', ')}.`);
}

const CAPABILITY_HELP = `Capability help (read-only)

Collections
  /capability list [--activatable] [--usable] [--filter=<text>]
  /capability base add|remove <targets> | base list
  /capability activate|deactivate [targets]  (no targets opens the hierarchical picker)
  /capability blacklist add|remove <targets> | blacklist list

Targets
  tool_a tool_b                       multiple direct targets in one batch
  namespace://subagent                load the container and snapshot ALL current eligible members
  mcp://git                           same for one MCP server
  namespace://subagent[ns] msg_write  load the container but select ONLY explicit positive members; empty,
                                      foreign-only, blocked-only or fully excluded selections reject the whole batch
  namespace://subagent -subagent_create
                                      -tool excludes only this selection; it never blacklists or changes prior membership
  msg_write[lazy] subagent_list[no-lazy]
                                      lazy = schema on demand; no-lazy = schema-backed; individual members override
                                      the container selection default in the same single write
  namespace://subagent[ns,lazy] msg_write
                                      container default for explicit members; [no-lazy] forces schema
  namespace://subagent[lazy]          default-expand all current valid members with that lazy default

Schema policy
  Plain targets do not change policy: they follow configured defaults and any existing branch override.
  [lazy]/[no-lazy] set explicit per-tool overrides; [ns,...] selects the container mode for its members.
  [lazy] requires Codemode active and usable with effective mode "only"; otherwise the whole batch is
  rejected before any write. This command never changes the global mode. Model-only tools cannot be
  schema-withheld and reject that selection.

Priority
  base/whitelist > LOCAL blacklist > dynamic/discovery. A base member remains usable when a local
  blacklist rule also names it; the raw ban is retained and applies again after the base member is
  removed. Dynamic/discovery activation never overrides a local ban. A namespace ban's only local
  exception is exact base membership. Outer ancestor blacklist, scope, role, depth and SDK limits are
  never bypassed.

Scope
  base remove removes baseline membership; deactivate removes dynamic membership only; blacklist remove
  removes prohibition only. Removing one collection does not clear the other two.

Picker
  activate/deactivate with no targets opens a one-page hierarchical multi-select: standalone tools,
  namespaces and MCP servers. Root Up/Down moves among siblings; Right enters a container, Left returns
  and remembers its child cursor. PageUp/PageDown moves siblings, Home/End jumps to first/last sibling.
  Tab focuses a capability field and Space changes it: tool selection/schema, container load/schema.
  Rows show config defaults separately from explicit branch overrides and actual withholding; long
  member lists fold with "...N tools remain" and navigation reveals the range. Enter confirms once;
  browse/cancel never writes.`;
const LIST_USAGE = 'Usage: /capability list [--activatable] [--usable] [--filter=<text>]';
const TARGET_USAGE = 'Usage: /capability base add|remove <targets> | blacklist add|remove <targets> | activate|deactivate [targets]';

function sourceLabel(source: ToolBlacklistTarget['sources'][number]): string {
  return source;
}

function entryFacts(entry: ToolAccessListing): string {
  const facts: string[] = [];
  if (entry.base) facts.push('base');
  if (entry.dynamic) facts.push('dynamic');
  if (entry.blacklisted) facts.push(`blacklisted: ${entry.blacklistSources.map(sourceLabel).join(', ') || 'yes'}`);
  if (entry.banOverridden) facts.push('ban overridden by base');
  else if (entry.blocked) facts.push('blocked');
  if (entry.activatable) facts.push('activatable');
  if (entry.usable) facts.push('usable');
  if (entry.category === 'namespace') facts.push('namespace');
  return facts.join(' · ');
}

function entryMark(entry: ToolAccessListing): string {
  if (entry.blocked) return '✖';
  if (entry.usable) return '●';
  if (entry.activatable) return '○';
  return '·';
}

function renderList(result: ToolAccessQueryResult, activatable: boolean, usable: boolean, filter: string | null): string {
  const flags = [activatable ? 'activatable' : null, usable ? 'usable' : null].filter((flag) => flag !== null);
  const describe = `${flags.length === 0 ? 'current' : flags.join('+')}${filter === null ? '' : ` · filter "${filter}"`}`;
  const lines = [`Capability · ${result.entries.length} tool${result.entries.length === 1 ? '' : 's'} · ${describe}`];
  if (result.entries.length === 0) lines.push('', 'No tools match this view.');
  for (const entry of result.entries) {
    const facts = entryFacts(entry);
    lines.push(`  ${entryMark(entry)} ${entry.name}${facts === '' ? '' : `  [${facts}]`}`);
  }
  return lines.join('\n');
}

function renderBaseList(entries: readonly ToolCollectionTarget[]): string {
  const lines = [`Capability · base · ${entries.length} target${entries.length === 1 ? '' : 's'}`];
  if (entries.length === 0) lines.push('', 'No base targets are recorded.');
  for (const entry of entries) {
    const members = entry.affectedTools.length === 0 ? 'no registered member' : `${entry.affectedTools.length} tool${entry.affectedTools.length === 1 ? '' : 's'}`;
    lines.push(`  · ${entry.target.target}  (${members}${entry.sources.length === 0 ? '' : ` · ${entry.sources.join(', ')}`})`);
  }
  return lines.join('\n');
}

function renderBlacklistList(entries: readonly ToolBlacklistTarget[]): string {
  const lines = [`Capability · blacklist · ${entries.length} target${entries.length === 1 ? '' : 's'}`];
  if (entries.length === 0) lines.push('', 'No blacklist targets are effective.');
  for (const entry of entries) {
    const members = entry.affectedTools.length === 0 ? 'no registered member' : `${entry.affectedTools.length} tool${entry.affectedTools.length === 1 ? '' : 's'}`;
    const sources = entry.sources.map(sourceLabel).join(', ');
    lines.push(`  ✖ ${entry.target.target}  (${members}${sources === '' ? '' : ` · ${sources}`})`);
  }
  if (entries.length > 0) {
    lines.push('', 'Removing a target clears the branch contribution and any matching config override; the current preset -tool remains until preset switch/clear, and SDK --exclude-tools/--tools restrictions are unchanged.');
  }
  return lines.join('\n');
}

function pushSection(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push('', title, ...items);
}

const ACTION_TITLE: Readonly<Record<ToolWriteResult['action'], string>> = {
  'base-add': 'base add',
  'base-remove': 'base remove',
  activate: 'activate',
  deactivate: 'deactivate',
  'blacklist-add': 'blacklist add',
  'blacklist-remove': 'blacklist remove',
};

const CHANGED_TITLE: Readonly<Record<ToolWriteResult['action'], string>> = {
  'base-add': 'Added to base',
  'base-remove': 'Recorded base removal intent',
  activate: 'Activated dynamically',
  deactivate: 'Recorded deactivation intent',
  'blacklist-add': 'Blacklisted',
  'blacklist-remove': 'Recorded blacklist removal intent',
};

const RECORDED_ACTION: Readonly<Record<ToolWriteResult['action'], boolean>> = {
  'base-add': false,
  'base-remove': true,
  activate: false,
  deactivate: true,
  'blacklist-add': false,
  'blacklist-remove': true,
};

function renderWrite(targets: readonly string[], result: ToolWriteResult): string {
  const lines = [`Capability · ${ACTION_TITLE[result.action]} ${targets.join(' ')}`];
  const recorded = RECORDED_ACTION[result.action];
  if (result.rejected !== null) {
    const reason = result.rejected.reason === undefined ? '' : ` (${result.rejected.reason})`;
    lines.push('', `Rejected the whole batch: ${result.rejected.code}${reason}. No membership record was written and no runtime effect was applied.`);
    pushSection(lines, 'Rejected targets', result.rejected.targets.map((target) => `  ! ${target}`));
    pushSection(lines, 'Members considered', result.rejected.members.map((member) => `  · ${member}`));
    return lines.join('\n');
  }
  pushSection(lines, CHANGED_TITLE[result.action], result.changed.map((change) =>
    `  ${recorded ? '·' : '✔'} ${change.target}  (${change.affectedTools.length} tool${change.affectedTools.length === 1 ? '' : 's'})`));
  pushSection(lines, 'Selected members', result.selected.map((name) => `  · ${name}`));
  pushSection(lines, 'Loaded containers', result.containers.map((container) => {
    const members = container.members.length === 0 ? 'no selected member' : container.members.join(', ');
    return `  ◇ ${container.target}${container.explicit ? ' (explicit selection)' : ' (all current members)'}: ${members}`;
  }));
  pushSection(lines, 'Excluded from this selection', result.excluded.map((name) => `  – ${name}`));
  pushSection(lines, 'Schema on demand requested (lazy)', result.noSchema.map((name) => `  · ${name}`));
  pushSection(lines, 'Schema-backed requested (no-lazy)', result.schema.map((name) => `  · ${name}`));
  pushSection(lines, 'Schema withheld now (describeTool on demand)', result.schemaWithheld.map((name) => `  ◌ ${name}`));
  pushSection(lines, 'Activated', result.activated.map((name) => `  ● ${name}`));
  pushSection(lines, 'Already active', result.alreadyActive.map((name) => `  · ${name}`));
  pushSection(lines, recorded ? 'Already recorded' : 'Already set', result.alreadySet.map((target) => `  · ${target}`));
  pushSection(lines, 'Not requested after removal', result.notRequested.map((name) => `  · ${name}`));
  pushSection(lines, 'Still blacklisted (raw)', result.stillBlacklisted.map((name) => `  ✖ ${name}`));
  pushSection(lines, 'Ban overridden by base', result.banOverridden.map((name) => `  · ${name}`));
  pushSection(lines, 'Remaining blacklist sources', result.remainingSources.map((source) => `  · ${source}`));
  pushSection(lines, 'Removed from the active set now (Codemode-only)', result.removedActive.map((name) => `  – ${name}`));
  pushSection(lines, 'Blocked now; declaration removed at next compaction', result.pendingCompaction.map((name) => `  ⏳ ${name}`));
  pushSection(lines, 'Model notified of used tools', result.noticed.map((name) => `  ✎ ${name}`));
  pushSection(lines, 'Refused', result.skipped.map((skip) => `  ! ${skip.target}: ${skip.reason}`));
  pushSection(lines, 'Unknown targets', result.unresolved.map((target) => `  ? ${target}`));
  if (result.recordError !== null) {
    lines.push('', `The membership record could not be written: ${result.recordError}. Nothing changed.`);
  }
  if (result.effectError !== null) {
    lines.push('', `The membership record was written, but applying the runtime effect failed: ${result.effectError}. Nothing was rolled back.`);
  }
  if (result.removedActive.length > 0 || result.pendingCompaction.length > 0) {
    lines.push('', 'Removed tools cannot be called now; a declared tool keeps its declaration until the next successful compaction.');
  }
  if (recorded) {
    lines.push('', 'This records an explicit removal intent; it also applies when a later group or default source introduces the target.');
  }
  if (result.action === 'deactivate') {
    lines.push('', 'Deactivation only removes dynamic membership; base membership and blacklist entries are preserved.');
  }
  if (result.action === 'blacklist-add') {
    if (result.banOverridden.length > 0) {
      lines.push('', 'Base membership overrides the local ban for these tools; the raw blacklist is retained and applies again after base removal.');
    }
    if (result.stillBlacklisted.some((name) => !result.banOverridden.includes(name))) {
      lines.push('', 'Blacklisted tools without a base exception cannot be called now; a declared tool keeps its declaration until the next successful compaction.');
    }
  }
  if (result.action === 'blacklist-remove') {
    lines.push('', 'This removes the branch contribution and any matching config override; the current preset -tool remains until preset switch/clear, and SDK --exclude-tools/--tools restrictions are unchanged.');
  }
  return lines.join('\n');
}

interface PickerCandidate {
  readonly target: string;
  readonly label: string;
}

function groupCandidates(pi: ExtensionAPI, names: readonly string[]): PickerCandidate[] {
  const selected = new Set(names);
  const groups = new Map<string, { target: string; count: number; description: string }>();
  for (const tool of pi.getAllTools()) {
    if (!selected.has(tool.name)) continue;
    const namespace = tool.namespace?.name;
    if (namespace === undefined) continue;
    const target = namespace.startsWith('mcp__')
      ? `${MCP_SCHEME}${tool.namespace?.aliases?.[0] ?? namespace.slice('mcp__'.length)}`
      : `${NAMESPACE_SCHEME}${namespace}`;
    const existing = groups.get(target) ?? {
      target,
      count: 0,
      description: namespace.startsWith('mcp__')
        ? `MCP server · ${namespace.slice('mcp__'.length)}`
        : `Namespace · ${namespace}`,
    };
    existing.count += 1;
    groups.set(target, existing);
  }
  return [...groups.values()].map((group) => ({
    target: group.target,
    label: `${group.target}  (${group.description}; ${group.count} tool${group.count === 1 ? '' : 's'})`,
  }));
}

async function pickTargets(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  mode: 'activate' | 'deactivate',
  branch: readonly unknown[],
  schemaRefs: readonly string[],
): Promise<readonly string[] | null> {
  const result = queryToolAccess(pi, branch, pi.getActiveTools(),
    mode === 'activate' ? { includeActivatable: true, schemaRefs } : { schemaRefs });
  if (result.entries.every((entry) => mode === 'activate' ? !entry.activatable : !entry.dynamic)) {
    ctx.ui.notify(mode === 'activate'
      ? 'No activatable tools are registered in this scope.'
      : 'No dynamically activated tools are recorded on this branch.', 'info');
    return null;
  }
  let chosen: readonly string[] | null;
  try {
    chosen = await ctx.ui.custom<readonly string[] | null>((tui, theme, keybindings, done) =>
      createCapabilityPicker({ entries: result.entries, mode, tui, theme, keybindings, done }),
      { blocked: { kind: 'question', message: `Choose tools to ${mode}` } });
  } catch {
    ctx.ui.notify(`The picker needs the terminal UI. Use /capability ${mode} <target>.`, 'info');
    return null;
  }
  if (chosen === null || chosen.length === 0) {
    ctx.ui.notify(`${mode === 'activate' ? 'Activate' : 'Deactivate'} cancelled; nothing changed.`, 'info');
    return null;
  }
  return chosen;
}

async function runActivation(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  mode: 'activate' | 'deactivate',
  targets: readonly string[],
  schemaRefs: readonly string[] = [],
): Promise<void> {
  const branch = ctx.sessionManager.getBranch();
  const chosen = targets.length === 0 ? await pickTargets(pi, ctx, mode, branch, schemaRefs) : targets;
  if (chosen === null) return;
  const result = mode === 'activate'
    ? activateToolTargets(pi, pi, branch, chosen)
    : deactivateToolTargets(pi, pi, branch, chosen);
  const text = renderWrite(chosen, result);
  if (result.recordError !== null || result.effectError !== null) ctx.ui.notify(text, 'error');
  else if (result.rejected !== null || result.skipped.length > 0 || result.unresolved.length > 0 || result.notRequested.length > 0) ctx.ui.notify(text, 'warning');
  else ctx.ui.notify(text, 'info');
}

function runCollectionWrite(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  verb: 'base' | 'blacklist',
  action: 'add' | 'remove',
  targets: readonly string[],
): void {
  if (targets.length === 0) { ctx.ui.notify(TARGET_USAGE, 'info'); return; }
  const branch = ctx.sessionManager.getBranch();
  const result = verb === 'base'
    ? (action === 'add' ? addBaseTools(pi, pi, branch, targets) : removeBaseTools(pi, pi, branch, targets))
    : (action === 'add' ? addBlacklistTargets(pi, pi, branch, targets) : removeBlacklistTargets(pi, pi, branch, targets));
  const text = renderWrite(targets, result);
  const warning = result.rejected !== null || result.skipped.length > 0 || result.unresolved.length > 0 || result.notRequested.length > 0;
  if (result.recordError !== null || result.effectError !== null) ctx.ui.notify(text, 'error');
  else if (warning) ctx.ui.notify(text, 'warning');
  else ctx.ui.notify(text, 'info');
}

/** Full-text argument completions: verbs, actions, list flags, and live targets. */
export function capabilityArgumentCompletions(prefix: string, pi: ExtensionAPI, branch?: readonly unknown[]): AutocompleteItem[] | null {
  const text = prefix.trimStart();
  const trailingSpace = /\s$/.test(text);
  const tokens = text.split(/\s+/).filter((token) => token !== '');
  const describe = (verb: (typeof VERBS)[number]): string => {
    if (verb === 'base') return 'Manage baseline tool membership';
    if (verb === 'blacklist') return 'Manage blacklisted tools';
    if (verb === 'activate') return 'Activate tools as dynamic membership';
    if (verb === 'deactivate') return 'Remove dynamic membership';
    if (verb === 'help') return 'Show collections, target modifiers and picker controls';
    return 'List current, activatable or usable tools';
  };
  const verbCompletions = (needle: string): AutocompleteItem[] => VERBS
    .filter((candidate) => candidate.startsWith(needle))
    .map((candidate) => ({ value: `${candidate} `, label: candidate, description: describe(candidate) }));
  if (tokens.length === 0) return verbCompletions('');
  const [verb, ...rest] = tokens;
  if (rest.length === 0 && !trailingSpace) {
    const items = verbCompletions(tokens[0]!.toLowerCase());
    return items.length === 0 ? null : items;
  }
  if (verb === 'help') return null;

  if (verb === 'list') {
    const fragment = trailingSpace ? '' : rest.at(-1) ?? '';
    const head = text.slice(0, text.length - fragment.length);
    const items = [...LIST_FLAGS, '--filter=']
      .filter((flag) => flag.startsWith(fragment))
      .map((flag) => ({ value: `${head}${flag}`, label: flag, description: flag === '--filter=' ? 'Filter by name, description or group' : 'Expand the list with this fact' }));
    return items.length === 0 ? null : items;
  }
  if (verb === 'base' || verb === 'blacklist') {
    if (rest.length === 0 || (rest.length === 1 && !trailingSpace)) {
      const needle = rest[0]?.toLowerCase() ?? '';
      const items = COLLECTION_ACTIONS
        .filter((action) => action.startsWith(needle))
        .map((action) => ({ value: `${verb} ${action} `, label: action, description: `${action} ${verb} targets` }));
      return items.length === 0 ? null : items;
    }
    const action = rest[0];
    if (action !== 'add' && action !== 'remove') return null;
    const fragment = trailingSpace ? '' : rest.at(-1) ?? '';
    return targetCompletions(pi, branch, text, trailingSpace ? rest.slice(1) : rest.slice(1, -1), fragment, verb, action);
  }
  if (verb === 'activate' || verb === 'deactivate') {
    const fragment = trailingSpace ? '' : rest.at(-1) ?? '';
    return targetCompletions(pi, branch, text, trailingSpace ? rest : rest.slice(0, -1), fragment, 'dynamic', verb);
  }
  return null;
}

function targetCompletions(
  pi: ExtensionAPI,
  branch: readonly unknown[] | undefined,
  text: string,
  chosenList: readonly string[],
  fragment: string,
  collection: 'base' | 'blacklist' | 'dynamic',
  action: 'add' | 'remove' | 'activate' | 'deactivate',
): AutocompleteItem[] | null {
  const chosen = new Set(chosenList);
  const head = text.slice(0, text.length - fragment.length);
  const needle = fragment.toLowerCase();
  const items: AutocompleteItem[] = [];
  const add = (target: string, description: string): void => {
    if (target === '' || chosen.has(target) || !target.toLowerCase().startsWith(needle)) return;
    items.push({ value: `${head}${target} `, label: target, description });
  };
  const addGroups = (names: readonly string[]): void => {
    for (const candidate of groupCandidates(pi, names)) add(candidate.target, 'Group target');
  };

  if (action === 'remove' && collection === 'base') {
    for (const entry of listBaseTools(pi, branch ?? null)) {
      add(entry.target.target, `Recorded base target · ${entry.affectedTools.length} tool${entry.affectedTools.length === 1 ? '' : 's'}`);
      for (const name of entry.affectedTools) add(name, 'Base member');
    }
  } else if (action === 'remove' && collection === 'blacklist') {
    for (const entry of listBlacklist(pi, branch ?? null)) {
      add(entry.target.target, `Recorded blacklist target · sources ${entry.sources.join(', ')}`);
      for (const name of entry.affectedTools) add(name, 'Blacklisted member');
    }
  } else if (action === 'deactivate') {
    for (const entry of createToolAccessView(pi, branch ?? null).dynamicTargets) {
      add(entry.target.target, `Recorded dynamic target · ${entry.affectedTools.length} tool${entry.affectedTools.length === 1 ? '' : 's'}`);
      for (const name of entry.affectedTools) add(name, 'Dynamic member');
    }
  } else {
    const view = queryToolAccess(pi, branch ?? null, pi.getActiveTools(), { includeActivatable: true });
    const names: string[] = [];
    for (const entry of view.entries) {
      if (collection === 'base' && action === 'add' && !entry.base) {
        add(entry.name, `${entry.group} · ${truncate(entry.description)}`);
        names.push(entry.name);
      } else if (collection === 'blacklist' && action === 'add' && !entry.blacklisted) {
        add(entry.name, `${entry.group} · ${truncate(entry.description)}`);
        names.push(entry.name);
      } else if (action === 'activate' && entry.activatable) {
        add(entry.name, `${entry.group} · ${truncate(entry.description)}`);
        names.push(entry.name);
      }
    }
    addGroups(names);
  }
  return items.length === 0 ? null : items.slice(0, COMPLETION_LIMIT);
}

/** Register the command on one Pi extension API. */
export function installCapabilityCommand(
  pi: ExtensionAPI,
  options: {
    readonly prepare?: (ctx: ExtensionCommandContext) => void;
    readonly schemaRefs?: (ctx: ExtensionCommandContext) => readonly string[];
  } = {},
): void {
  pi.registerCommand('capability', {
    description: 'Inspect and manage base, dynamic and blacklisted tools',
    getArgumentCompletions: (prefix) => capabilityArgumentCompletions(prefix, pi),
    handler: async (raw, ctx) => {
      try {
        const command = parseCapabilityCommand(raw);
        if (command.verb === 'help') {
          ctx.ui.notify(CAPABILITY_HELP, 'info');
          return;
        }
        // Re-read the configured blacklist sources before they are consulted.
        options.prepare?.(ctx);
        const branch = ctx.sessionManager.getBranch();
        if (command.verb === 'list') {
          const result = queryToolAccess(pi, branch, pi.getActiveTools(), {
            includeActivatable: command.activatable,
            includeUsable: command.usable,
            ...(command.filter === null ? {} : { filter: command.filter }),
          });
          ctx.ui.notify(renderList(result, command.activatable, command.usable, command.filter), 'info');
          return;
        }
        if (command.verb === 'base') {
          if (command.action === 'list') {
            ctx.ui.notify(renderBaseList(listBaseTools(pi, branch)), 'info');
            return;
          }
          runCollectionWrite(pi, ctx, 'base', command.action, command.targets);
          return;
        }
        if (command.verb === 'blacklist') {
          if (command.action === 'list') {
            ctx.ui.notify(renderBlacklistList(listBlacklist(pi, branch)), 'info');
            return;
          }
          runCollectionWrite(pi, ctx, 'blacklist', command.action, command.targets);
          return;
        }
        await runActivation(pi, ctx, command.verb, command.targets, options.schemaRefs?.(ctx) ?? []);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof CapabilityCommandError) ctx.ui.notify(`${error.code}: ${message}\n${TARGET_USAGE}`, 'error');
        else ctx.ui.notify(message, 'error');
      }
    },
  });
}
