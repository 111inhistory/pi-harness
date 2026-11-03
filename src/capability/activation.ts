/**
 * Declare already-registered tools active in one session.
 *
 * `getActiveTools`/`setActiveTools` is Pi's active-tool API: it declares the
 * named registered tools to the model, records the change in the transcript and
 * ignores unknown and hidden names. This is activation, not installation or
 * enablement: nothing is downloaded, loaded or connected, and the existing
 * active set is preserved.
 *
 * Eligibility is checked against the current scope view before the call, and the
 * SDK's authoritative set is read back afterwards. A name Pi silently masked is
 * reported as `not_activated` instead of being assumed active, so callers never
 * publish a tool the session cannot call.
 */

import { createEligibleToolCatalog } from './tool-catalog.ts';

/** The registered tool shape activation needs. */
export interface ActivationTool {
  readonly name: string;
  readonly exposure?: string | undefined;
}

/** The SDK surface this module needs; an ExtensionAPI satisfies it. */
export interface ActivationHost {
  getAllTools(): readonly ActivationTool[];
  getActiveTools(): readonly string[];
  setActiveTools(toolNames: string[]): void;
}

/** Why one requested name did not end up active. */
export type ActivationSkipReason = 'not_registered' | 'hidden' | 'not_permitted' | 'not_activated';

export interface ActivationSkip {
  readonly name: string;
  readonly reason: ActivationSkipReason;
}

export interface ActivationOutcome {
  /** Names this call added and observed active afterwards. */
  readonly activated: readonly string[];
  /** Names that were already active before this call. */
  readonly alreadyActive: readonly string[];
  readonly skipped: readonly ActivationSkip[];
  /** The session's actual active set after the synchronous activation call. */
  readonly active: ReadonlySet<string>;
}

/**
 * Activate the named tools in one synchronous step.
 *
 * Duplicate names are ignored. A name that is unregistered, hidden or outside
 * the current qualification is skipped with its reason; the remaining names are
 * activated in a single call that keeps the current set.
 */
export function activateToolNames(host: ActivationHost, names: readonly string[]): ActivationOutcome {
  const eligible = createEligibleToolCatalog(host).byName;
  const registered = new Map(host.getAllTools().map((tool) => [tool.name, tool]));
  const active = new Set(host.getActiveTools());
  const requested: string[] = [];
  const alreadyActive: string[] = [];
  const skipped: ActivationSkip[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const tool = registered.get(name);
    if (tool === undefined) {
      skipped.push({ name, reason: 'not_registered' });
      continue;
    }
    if (tool.exposure === 'hidden') {
      skipped.push({ name, reason: 'hidden' });
      continue;
    }
    if (!eligible.has(name)) {
      skipped.push({ name, reason: 'not_permitted' });
      continue;
    }
    if (active.has(name)) {
      alreadyActive.push(name);
      continue;
    }
    requested.push(name);
  }
  if (requested.length > 0) host.setActiveTools([...active, ...requested]);
  const actual = new Set(host.getActiveTools());
  const activated = requested.filter((name) => actual.has(name));
  for (const name of requested) {
    if (!actual.has(name)) skipped.push({ name, reason: 'not_activated' });
  }
  return { activated, alreadyActive, skipped, active: actual };
}
