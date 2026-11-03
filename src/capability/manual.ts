/**
 * Manual capability enablement.
 *
 * The model discovers capabilities through `capability`; the user can also
 * enable one directly with `/capability enable`. A tool classified as manual
 * (`capability.manualTools`) is invisible to discovery and can be enabled only
 * here; a discovered tool may be enabled here as well. Both paths converge on
 * the same append-only branch memory, and the record marks the resources as
 * user-enabled rather than model-discovered.
 *
 * Order is activate, then record: the user is present, and only the tools the
 * SDK reports active after the call enter memory. Recording first would let the
 * branch advertise a member that activation silently masked, which is the
 * unresolved allowlist discrepancy in `docs/known-issues.md`.
 *
 * There is no disable path. Capability memory only grows on a branch, and a
 * later request projection still re-checks the live tool permissions.
 */

import { appendManualRecord } from './discovery-record.ts';
import type { CapabilityHit } from './discovery-record.ts';
import { activateToolNames, type ActivationHost, type ActivationSkip } from './activation.ts';
import { capabilityRootOnlyPolicy } from './scope.ts';
import { toolRef } from './refs.ts';

/** A registered tool as manual enablement records it. */
export interface ManualTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly exposure?: string | undefined;
}

/** Activation plus branch persistence; an ExtensionAPI satisfies it. */
export interface ManualEnableHost extends ActivationHost {
  getAllTools(): readonly ManualTool[];
  appendEntry(customType: string, data?: unknown): void;
}

export interface ManualEnableResult {
  /**
   * Tools this call authorized: newly activated tools, plus manual tools that
   * were already active (for example `defaultActive`) and are now recorded as
   * user-enabled. Tools already in the branch record are not repeated.
   */
  readonly enabled: readonly string[];
  /** Requested tools that were already active before this call. */
  readonly alreadyActive: readonly string[];
  readonly skipped: readonly ActivationSkip[];
  /** Set when the branch record failed after activation. */
  readonly recordError: string | null;
}

/** Tools the branch already records as user-enabled; avoids duplicate records. */
export interface ManualEnableOptions {
  readonly recorded?: ReadonlySet<string>;
}

function manualHit(tool: ManualTool): CapabilityHit {
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
 * Enable the named tools in this session and remember them on the branch.
 *
 * Unknown, hidden and unqualified names are reported per name; they never fail
 * the whole request. A record write failure does not undo activation, so the
 * result reports it separately instead of claiming durable memory.
 */
export function enableManualTools(
  host: ManualEnableHost,
  names: readonly string[],
  options: ManualEnableOptions = {},
): ManualEnableResult {
  const requested = names.map((name) => name.trim()).filter((name) => name !== '');
  // The user command is the one path allowed to enable a manual tool.
  const outcome = activateToolNames(host, requested, { includeManual: true });
  const registered = new Map(host.getAllTools().map((tool) => [tool.name, tool]));
  const recorded = options.recorded ?? new Set<string>();
  const rootOnly = capabilityRootOnlyPolicy(host);
  // An already-active manual tool still needs the record: activation alone (a
  // `defaultActive` tool, a restored transcript or another extension) does not
  // authorize it. Non-manual tools that were already active need nothing.
  const authorized = [
    ...outcome.activated,
    ...outcome.alreadyActive.filter((name) => rootOnly !== null && rootOnly(name)),
  ].filter((name) => !recorded.has(name));
  const hits = authorized.flatMap((name) => {
    const tool = registered.get(name);
    return tool === undefined ? [] : [manualHit(tool)];
  });
  let recordError: string | null = null;
  if (hits.length > 0) {
    try {
      appendManualRecord(host, hits);
    } catch (error) {
      recordError = error instanceof Error ? error.message : String(error);
    }
  }
  return { enabled: authorized, alreadyActive: outcome.alreadyActive, skipped: outcome.skipped, recordError };
}
