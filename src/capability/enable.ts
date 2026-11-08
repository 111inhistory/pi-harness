/**
 * User-only enablement of registered capability tools.
 *
 * The model reaches tools through `capability` discovery. The user has one
 * separate entry: `/capability enable`, which names a registered tool, an MCP
 * server or a namespace. Both paths converge on the same append-only branch
 * memory; a record written here marks resources as user-enabled instead of
 * model-discovered.
 *
 * Order is activate, then record. The user is present, and only the tools the
 * SDK reports active after the call enter memory. Recording first would let the
 * branch advertise a member that activation silently masked.
 *
 * Every target is resolved against the *live* registry at execution time, never
 * against a snapshot taken when a picker opened or when a session started. Pi's
 * MCP extension re-registers a server's tools through `pi.registerTool` after a
 * reconnect, so a tool that did not exist at startup is resolvable here, and a
 * registration that was withdrawn (re-registered as `hidden`) is refused instead
 * of being activated from a stale capture.
 *
 * There is no disable path. Capability memory only grows on a branch, and a
 * later request projection still re-checks the live tool permissions.
 */

import { activateToolNames, type ActivationHost, type ActivationSkip, type ActivationSkipReason } from './activation.ts';
import { appendManualRecord, manualEnabledTools, type CapabilityHit } from './discovery-record.ts';
import { toolRef } from './refs.ts';

/** A registered tool as enablement needs to see it. */
export interface EnableTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly exposure?: string | undefined;
  readonly namespace?: { readonly name: string; readonly aliases?: readonly string[] } | undefined;
}

/** Activation plus branch persistence; an ExtensionAPI satisfies it. */
export interface EnableHost extends ActivationHost {
  getAllTools(): readonly EnableTool[];
  appendEntry(customType: string, data?: unknown): void;
}

/** One requested name that did not become usable, with the SDK's reason. */
export type EnableSkip = ActivationSkip;

export interface EnableResult {
  /** Tools this call made usable: newly activated, or active but not yet recorded. */
  readonly enabled: readonly string[];
  /** Requested tools that were already active and already recorded. */
  readonly alreadyEnabled: readonly string[];
  /** Requested names that were not activated, with their reason. */
  readonly skipped: readonly EnableSkip[];
  /** Targets that named no registered tool, server or namespace. */
  readonly unresolved: readonly string[];
  /** Expanded namespace/MCP targets, with the members they contributed. */
  readonly expanded: readonly EnableExpansion[];
  /** Set when the branch record failed after activation. */
  readonly recordError: string | null;
}

export interface EnableExpansion {
  readonly target: string;
  readonly tools: readonly string[];
}

/**
 * The branch this operation authorizes on.
 *
 * Only the branch's `manual` records count as existing user authorization. A
 * discovery record selects a tool for the model; it is not a user decision, so
 * it must not suppress the authorization this command owes the tool. Passing the
 * branch rather than a precomputed name set keeps the two apart by construction:
 * a tool discovered first and classified as manual later still gets its record.
 */
export interface EnableOptions {
  readonly branch?: readonly unknown[] | null;
}

const MCP_SCHEME = 'mcp://';
const NAMESPACE_SCHEME = 'namespace://';

/** A server or namespace target expands to the members registered right now. */
interface TargetExpansion {
  readonly target: string;
  readonly members: readonly string[];
}

function decodeTarget(raw: string, scheme: string): string | null {
  try {
    return decodeURIComponent(raw.slice(scheme.length));
  } catch {
    return null;
  }
}

function serverMatches(tool: EnableTool, server: string): boolean {
  const namespace = tool.namespace;
  if (namespace === undefined) return false;
  if (namespace.name === server || namespace.name === `mcp__${server}`) return true;
  if (namespace.aliases?.includes(server) === true) return true;
  return namespace.name.startsWith('mcp__') && tool.name.startsWith(`mcp__${server}__`);
}

/**
 * Expand one target to concrete tool names.
 *
 * An exact registered tool name always wins, including a hidden one, so the
 * refusal names the real reason instead of pretending the tool does not exist.
 * `mcp://<server>` and `namespace://<name>` expand explicitly; a bare name that
 * matches no tool but a namespace name or alias expands too. This includes
 * the SDK's MCP namespaces; `mcp://` also accepts their server aliases.
 * Hidden members are left out of a group expansion.
 */
function expandTarget(host: EnableHost, target: string): TargetExpansion | null {
  const tools = host.getAllTools();
  if (tools.some((tool) => tool.name === target)) return { target, members: [target] };
  if (target.startsWith(MCP_SCHEME)) {
    const server = decodeTarget(target, MCP_SCHEME);
    if (server === null || server === '') return null;
    const members = tools
      .filter((tool) => tool.exposure !== 'hidden' && serverMatches(tool, server))
      .map((tool) => tool.name);
    return members.length === 0 ? null : { target, members };
  }
  const explicit = target.startsWith(NAMESPACE_SCHEME) ? decodeTarget(target, NAMESPACE_SCHEME) : target;
  if (explicit === null || explicit === '') return null;
  const members = tools
    .filter((tool) => tool.exposure !== 'hidden'
      && (tool.namespace?.name === explicit || tool.namespace?.aliases?.includes(explicit) === true))
    .map((tool) => tool.name);
  return members.length === 0 ? null : { target, members };
}

/** Expand every requested target against the live registry, in request order. */
export function resolveEnableTargets(host: EnableHost, targets: readonly string[]): {
  readonly names: readonly string[];
  readonly expansions: readonly EnableExpansion[];
  readonly unresolved: readonly string[];
} {
  const names: string[] = [];
  const expansions: EnableExpansion[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const target = raw.trim();
    if (target === '') continue;
    const expansion = expandTarget(host, target);
    if (expansion === null) {
      if (!unresolved.includes(target)) unresolved.push(target);
      continue;
    }
    if (expansion.members.length > 1 || expansion.members[0] !== target) {
      expansions.push({ target, tools: expansion.members });
    }
    for (const name of expansion.members) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return { names, expansions, unresolved };
}

function enableHit(tool: EnableTool): CapabilityHit {
  return {
    ref: toolRef(tool.name),
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.exposure === undefined ? {} : { exposure: tool.exposure }),
    kind: 'tool',
    status: 'available',
  };
}

/**
 * Enable the named targets in this session and remember them on the branch.
 *
 * Unknown, hidden and unqualified names are reported per name; they never fail
 * the whole request. A record write failure does not undo activation, so the
 * result reports it separately instead of claiming durable memory: without the
 * record a manual tool fails the admission check on the next request and is
 * pruned from the declarations, which is the fail-closed direction.
 */
export function enableCapabilityTargets(
  host: EnableHost,
  targets: readonly string[],
  options: EnableOptions = {},
): EnableResult {
  const resolved = resolveEnableTargets(host, targets);
  // The user command is the one path allowed to enable a manual tool.
  const outcome = activateToolNames(host, resolved.names, { includeManual: true });
  const authorized = manualEnabledTools(options.branch ?? []);
  const registered = new Map(host.getAllTools().map((tool) => [tool.name, tool]));
  const usable = [...new Set([...outcome.activated, ...outcome.alreadyActive])];
  const alreadyEnabled = usable.filter((name) => authorized.has(name));
  const enabled = usable.filter((name) => !authorized.has(name));
  const hits = enabled.flatMap((name) => {
    const tool = registered.get(name);
    return tool === undefined ? [] : [enableHit(tool)];
  });
  let recordError: string | null = null;
  if (hits.length > 0) {
    try {
      appendManualRecord(host, hits);
    } catch (error) {
      recordError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    enabled,
    alreadyEnabled,
    skipped: outcome.skipped,
    unresolved: resolved.unresolved,
    expanded: resolved.expansions,
    recordError,
  };
}

/** One refused name, as the command renders it. */
export function describeEnableSkip(skip: EnableSkip): string {
  return `${skip.name} (${SKIP_TEXT[skip.reason] ?? skip.reason})`;
}

const SKIP_TEXT: Readonly<Record<ActivationSkipReason, string>> = {
  not_registered: 'not registered',
  hidden: 'hidden by its registration',
  manual_only: 'manual, and only the user command may enable it',
  not_permitted: 'not permitted in this scope',
  not_activated: 'the session did not activate it',
};
