/**
 * User-only enablement of registered capability tools.
 *
 * The model reaches tools through `capability` discovery. The user has a
 * separate entry: `/capability enable`, which names a registered tool, an MCP
 * server or a namespace. Both forms resolve every target against the live
 * registry at execution time, then record the three-state permission as
 * `enabled` and activate the concrete members. There is no separate manual
 * authorization record: `enabled` is the user's own decision.
 *
 * Order is record, then activate: the permission record is the durability
 * contract, and only tools the SDK reports active after the call are reported
 * as enabled.
 *
 * There is no disable path here: `/capability disable` and `reset` live in the
 * permission module and command.
 */

import type { ActivationSkip, ActivationSkipReason } from './activation.ts';
import { explicitlyEnabled, setToolPermission } from './tool-permission.ts';

/** A registered tool as enablement needs to see it. */
export interface EnableTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly exposure?: string | undefined;
  readonly namespace?: { readonly name: string; readonly aliases?: readonly string[] } | undefined;
}

/** Permission record plus activation; an ExtensionAPI satisfies it. */
export interface EnableHost {
  getAllTools(): readonly EnableTool[];
  getActiveTools(): readonly string[];
  setActiveTools(toolNames: string[]): void;
  appendEntry(customType: string, data?: unknown): void;
}

/** One requested name that did not become usable, with the SDK's reason. */
export type EnableSkip = ActivationSkip;

export interface EnableResult {
  /** Tools this call made usable: newly recorded enabled. */
  readonly enabled: readonly string[];
  /** Requested tools that were already explicitly enabled. */
  readonly alreadyEnabled: readonly string[];
  /** Requested names that were not activated, with their reason. */
  readonly skipped: readonly EnableSkip[];
  /** Targets that named no registered tool, server or namespace. */
  readonly unresolved: readonly string[];
  /** Expanded namespace/MCP targets, with the members they contributed. */
  readonly expanded: readonly EnableExpansion[];
  /** Set when the permission record failed after activation. */
  readonly recordError: string | null;
}

export interface EnableExpansion {
  readonly target: string;
  readonly tools: readonly string[];
}

/** The branch this operation authorizes on. */
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
 * matches no tool but a namespace name or alias expands too. Hidden members are
 * left out of a group expansion.
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

/**
 * Enable the named targets in this session.
 *
 * The user's raw targets are recorded, so `namespace://x` and `mcp://server`
 * persist as group rules that also cover members registered later. Resolution
 * is only for activation and per-target reporting: unresolved and exact-hidden
 * targets are refused without writing a rule.
 */
export function enableCapabilityTargets(
  host: EnableHost,
  targets: readonly string[],
  options: EnableOptions = {},
): EnableResult {
  const resolved = resolveEnableTargets(host, targets);
  const hidden = new Set(host.getAllTools()
    .filter((tool) => tool.exposure === 'hidden')
    .map((tool) => tool.name));
  const unresolved = new Set(resolved.unresolved);
  const recordable = [...new Set(targets
    .map((target) => target.trim())
    .filter((target) => target !== '' && !hidden.has(target) && !unresolved.has(target)))];
  const already = new Set(resolved.names.filter((name) => explicitlyEnabled(host, options.branch, name)));
  const set = setToolPermission(host, host, options.branch ?? [], recordable, 'enabled');
  const recorded = new Set(set.changed.flatMap((change) => change.affectedTools));
  const refusedHidden: EnableSkip[] = resolved.names
    .filter((name) => hidden.has(name))
    .map((name) => ({ name, reason: 'hidden' }));
  return {
    enabled: resolved.names.filter((name) => recorded.has(name) && !already.has(name)),
    alreadyEnabled: resolved.names.filter((name) => already.has(name)),
    skipped: [
      ...refusedHidden,
      ...set.skipped
        .filter((skip): skip is { target: string; reason: ActivationSkipReason } =>
          isActivationSkipReason(skip.reason))
        .map((skip) => ({ name: skip.target, reason: skip.reason })),
    ],
    unresolved: set.unresolved.length > 0 ? set.unresolved : resolved.unresolved,
    expanded: resolved.expansions,
    recordError: set.recordError,
  };
}

/** One refused name, as the command renders it. */
export function describeEnableSkip(skip: EnableSkip): string {
  return `${skip.name} (${SKIP_TEXT[skip.reason] ?? skip.reason})`;
}

const SKIP_TEXT: Readonly<Record<ActivationSkipReason, string>> = {
  not_registered: 'not registered',
  hidden: 'hidden by its registration',
  disabled: 'disabled by the tool permission',
  not_permitted: 'not permitted in this scope',
  not_activated: 'the session did not activate it',
  unreachable: 'no usable call path: it needs an enabled Codemode entry in this session',
};

function isActivationSkipReason(reason: string): reason is ActivationSkipReason {
  return reason in SKIP_TEXT;
}
