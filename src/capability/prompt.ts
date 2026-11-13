/**
 * Project durable discovery records into permission-filtered system sections.
 *
 * Only *discovery* is request state. A user enablement (`/capability enable`) is
 * branch authority and never enters the model request: the tool it authorizes is
 * declared by the native tool list, so projecting the authorization again would
 * add nothing the model can use while changing the leading system prompt.
 *
 * The projection is a current-state snapshot, not a history. Every request
 * recomputes the latest discovery memory from the branch and the live registry;
 * no emitted placement or ordinal is persisted. The request-side helper appends
 * the current snapshot at the actual request tail.
 */
import { discoveryRecords, type CapabilityHit, type DiscoveryMemory } from './discovery-record.ts';
import { promptString } from '../prompt-text.ts';

const memoryHeader: string = promptString('capability-policy.json', 'memoryHeader');
export const CAPABILITY_SECTION = 'capabilities';

export interface CapabilityPromptOptions {
  readonly allowsTool?: (name: string) => boolean;
  /** Live instructions for already-discovered resources; null withdraws the prose. */
  readonly instructions?: ReadonlyMap<string, string | null>;
  /** Shared instructions already emitted by another native section producer. */
  readonly nativeGuidanceRefs?: ReadonlySet<string>;
}

/** Minimal transcript shape for request-local projection and focused tests. */
export interface ProjectionMessage {
  role?: string;
  content?: unknown;
  sections?: Record<string, string | null>;
  toolName?: string;
  toolCallId?: string;
  toolsAdded?: readonly unknown[];
  toolsRemoved?: readonly unknown[];
  timestamp?: number | undefined;
  [field: string]: unknown;
}

/** Groups that carry tools, so their entries answer to the live tool permissions. */
const toolCategories: ReadonlySet<string> = new Set(['tools', 'mcp']);
const categories = ['tools', 'mcp', 'skills', 'guidance'] as const;
interface SelectedHit extends CapabilityHit {
  ref: string;
  category: typeof categories[number];
}
type State = Map<string, SelectedHit>;

function keep(value: CapabilityHit, keys: readonly string[]): CapabilityHit {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

/**
 * Fields kept per hit. Discovery hits carry their prose because they are the only
 * source the model has for a resource it has not selected; argument schemas stay
 * in the native declarations and are never duplicated here.
 */
const HIT_TEXT_FIELDS = ['name', 'description', 'instructions', 'filePath'] as const;

/** No omission is implied without an actual native guidance producer. */
const EMPTY_GUIDANCE_REFS: ReadonlySet<string> = new Set();

function textFields(hit: CapabilityHit, nativeGuidanceRefs: ReadonlySet<string>): readonly string[] {
  return hit.ref !== undefined && nativeGuidanceRefs.has(hit.ref)
    ? HIT_TEXT_FIELDS.filter((field) => field !== 'instructions')
    : HIT_TEXT_FIELDS;
}

function selected(
  result: DiscoveryMemory,
  allowsTool: (name: string) => boolean,
  instructions?: ReadonlyMap<string, string | null>,
  nativeGuidanceRefs: ReadonlySet<string> = EMPTY_GUIDANCE_REFS,
): SelectedHit[] {
  const hits: SelectedHit[] = [];
  const allowed = (hit: CapabilityHit): boolean => typeof hit.name === 'string' && allowsTool(hit.name);
  for (const category of categories) {
    for (const hit of result[category] ?? []) {
      if (!hit.ref || (hit.status && hit.status !== 'available')) continue;
      const members = hit.tools;
      const tools = toolCategories.has(category);
      if (members && !members.some(allowed)) continue;
      if (!members && tools && (hit.kind === 'tool' || hit.tool) && !allowed(hit)) continue;
      const fields = textFields(hit, nativeGuidanceRefs);
      const liveInstructions = fields.includes('instructions') && instructions?.has(hit.ref)
        ? { instructions: instructions.get(hit.ref) ?? '' }
        : {};
      hits.push({
        category,
        ...keep(hit, fields),
        ...liveInstructions,
        ref: category === 'skills' && hit.filePath ? hit.filePath : hit.ref,
        ...(members ? { tools: members.filter(allowed).map((tool) => keep(tool, ['ref', 'name', 'description', 'exposure'])) } : {}),
        ...(!members && tools ? keep(hit, ['exposure', 'tool', 'server']) : {}),
      });
    }
  }
  return hits;
}

function merge(state: State, hits: readonly SelectedHit[]): void {
  for (const hit of hits) {
    const previous = state.get(hit.ref);
    // Guidance-only updates do not erase a group's known members.
    const tools = previous?.tools || hit.tools
      ? [...new Map([...(previous?.tools ?? []), ...(hit.tools ?? [])].map((tool) => [tool.name, tool])).values()]
      : undefined;
    state.set(hit.ref, { ...previous, ...hit, ...(tools ? { tools } : {}) });
  }
}

function render(state: State): string | null {
  if (!state.size) return null;
  return `<${CAPABILITY_SECTION}>\n${memoryHeader}\n${JSON.stringify([...state.values()])}\n</${CAPABILITY_SECTION}>`;
}

/**
 * The current Capability memory section for one request.
 *
 * Records are merged in branch order; the final map is the current state. Live
 * instructions and the current tool-permission filter are applied here, not
 * stored on the branch, so a reopened or inherited session reconstructs the same
 * snapshot without placement metadata.
 */
export function capabilityPromptSections(
  branch: readonly unknown[] | null | undefined,
  { allowsTool = () => true, instructions, nativeGuidanceRefs }: CapabilityPromptOptions = {},
): Readonly<Record<string, string | null>> {
  const state: State = new Map();
  for (const record of discoveryRecords(branch)) {
    merge(state, selected(record.result, allowsTool, instructions, nativeGuidanceRefs));
  }
  return { [CAPABILITY_SECTION]: render(state) };
}
