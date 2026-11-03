/**
 * `/capability` command: the user-facing entry for capability memory.
 *
 * The command lists what this branch remembers and can enable a registered tool
 * by name. Enablement is append-only, matching the discovery rule: there is no
 * disable, remove or reset subcommand. It never runs retrieval, never writes to
 * a subagent and never asks the model for anything.
 *
 * Output is plain text through `ctx.ui.notify`, like `/subagent`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import { createEligibleToolCatalog } from './tool-catalog.ts';
import { discoveryRecords, manualEnabledTools, type CapabilityHit } from './discovery-record.ts';
import { enableManualTools } from './manual.ts';

export type CapabilityCommand =
  | { readonly verb: 'list' }
  | { readonly verb: 'search'; readonly query: string }
  | { readonly verb: 'enable'; readonly names: readonly string[] };

/** A refused command line; the handler reports it without touching any state. */
export class CapabilityCommandError extends Error {
  readonly code = 'invalid_command_args';

  constructor(message: string) {
    super(message);
    this.name = 'CapabilityCommandError';
  }
}

const VERBS = ['list', 'search', 'enable'] as const;
const SEARCH_LIMIT = 20;
const DESCRIPTION_CHARS = 72;

/** Parse the raw argument string without touching tools or the branch. */
export function parseCapabilityCommand(raw: string): CapabilityCommand {
  const tokens = raw.trim().split(/\s+/).filter((token) => token !== '');
  const [verb, ...rest] = tokens;
  if (verb === undefined || verb === 'list') {
    if (rest.length > 0) throw new CapabilityCommandError('list takes no arguments.');
    return { verb: 'list' };
  }
  if (verb === 'search') {
    const query = rest.join(' ');
    if (query === '') throw new CapabilityCommandError('search requires search text.');
    return { verb: 'search', query };
  }
  if (verb === 'enable') {
    if (rest.length === 0) throw new CapabilityCommandError('enable requires at least one tool name.');
    return { verb: 'enable', names: rest };
  }
  throw new CapabilityCommandError(`Unknown subcommand: ${verb}. Expected one of: ${VERBS.join(', ')}.`);
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= DESCRIPTION_CHARS ? flat : `${flat.slice(0, DESCRIPTION_CHARS - 1)}…`;
}

/** Manual entries already stored on this branch, in branch order. */
function manualEntries(branch: readonly unknown[] | null | undefined): CapabilityHit[] {
  return discoveryRecords(branch).flatMap((record) => record.result.manual ?? []);
}

function renderList(ctx: ExtensionCommandContext, pi: ExtensionAPI): string {
  const manual = manualEntries(ctx.sessionManager.getBranch());
  const active = pi.getActiveTools();
  const eligible = createEligibleToolCatalog(pi, { includeManual: true }).tools.length;
  const lines = [`Manual capabilities (${manual.length}):`];
  lines.push(...(manual.length === 0
    ? ['  none']
    : manual.map((hit) => `  ${hit.ref ?? hit.name ?? 'unknown'}${hit.name && hit.ref !== hit.name ? `  ${hit.name}` : ''}`)));
  lines.push(`Active tools (${active.length}): ${active.length === 0 ? 'none' : active.join(', ')}`);
  lines.push(`Registered eligible tools: ${eligible}`);
  lines.push('Use /capability search <text> to find a name, then /capability enable <name...>.');
  return lines.join('\n');
}

function renderSearch(query: string, pi: ExtensionAPI): string {
  const needle = query.toLowerCase();
  const active = new Set(pi.getActiveTools());
  const matches = createEligibleToolCatalog(pi, { includeManual: true }).tools.filter((tool) => {
    const description = typeof tool.description === 'string' ? tool.description : '';
    return tool.name.toLowerCase().includes(needle) || description.toLowerCase().includes(needle);
  });
  const shown = matches.slice(0, SEARCH_LIMIT);
  const lines = [`Matches for "${query}" (${matches.length}):`];
  lines.push(...(shown.length === 0
    ? ['  none']
    : shown.map((tool) => {
        const description = typeof tool.description === 'string' ? tool.description : '';
        const marker = active.has(tool.name) ? 'active  ' : '        ';
        return `  ${marker}${tool.name}${description === '' ? '' : `  ${truncate(description)}`}`;
      })));
  if (matches.length > shown.length) lines.push(`  … ${matches.length - shown.length} more; narrow the search text.`);
  return lines.join('\n');
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
    ctx.ui.notify(renderList(ctx, pi), 'info');
    return;
  }
  if (command.verb === 'search') {
    ctx.ui.notify(renderSearch(command.query, pi), 'info');
    return;
  }
  ctx.ui.notify(renderEnable(enableManualTools(pi, command.names, {
    recorded: manualEnabledTools(ctx.sessionManager.getBranch()),
  })), 'info');
}

function completions(prefix: string, pi: ExtensionAPI): { value: string; label: string; description?: string }[] | null {
  const trimmed = prefix.trimStart();
  const tokens = trimmed.split(/\s+/).filter((token) => token !== '');
  if (tokens.length <= 1) {
    const items = [
      { value: 'list', label: 'list', description: 'Show manual capabilities and active tools' },
      { value: 'search', label: 'search', description: 'Find a registered tool by name or description' },
      { value: 'enable', label: 'enable', description: 'Enable one or more registered tools' },
    ].filter((item) => item.value.startsWith(trimmed));
    return items.length === 0 ? null : items;
  }
  if (tokens[0] !== 'enable') return null;
  const last = tokens[tokens.length - 1]!;
  const head = trimmed.slice(0, trimmed.length - last.length);
  const items = createEligibleToolCatalog(pi, { includeManual: true }).tools
    .filter((tool) => tool.name.startsWith(last))
    .slice(0, SEARCH_LIMIT)
    .map((tool) => ({ value: `${head}${tool.name}`, label: tool.name }));
  return items.length === 0 ? null : items;
}

/** Register the command on one Pi extension API. */
export function installCapabilityCommand(
  pi: ExtensionAPI,
  options: { readonly prepare?: (ctx: ExtensionCommandContext) => void } = {},
): void {
  pi.registerCommand('capability', {
    description: 'List capability memory and enable registered tools (append-only)',
    getArgumentCompletions: (prefix) => completions(prefix, pi),
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
