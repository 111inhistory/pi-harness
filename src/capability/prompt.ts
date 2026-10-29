/** Project durable discovery records into permission-filtered system sections. */
import { discoveryRecords, type CapabilityHit, type DiscoveryMemory } from './discovery-record.ts';
import { promptString } from '../prompt-text.mjs';

const memoryHeader: string = promptString('capability-policy.json', 'memoryHeader');
export const CAPABILITY_SECTION = 'capabilities';

/** Messages are copied without interpreting their model-specific content. */
export interface ProjectionMessage {
  role?: string;
  content?: unknown;
  sections?: Record<string, string>;
  toolName?: string;
  toolCallId?: string;
  toolsAdded?: readonly unknown[];
  toolsRemoved?: readonly unknown[];
  timestamp?: number | undefined;
  [field: string]: unknown;
}

const categories = ['tools', 'mcp', 'skills', 'guidance'] as const;
interface SelectedHit extends CapabilityHit {
  ref: string;
  category: typeof categories[number];
}
type State = Map<string, SelectedHit>;

function keep(value: CapabilityHit, keys: readonly string[]): CapabilityHit {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function selected(result: DiscoveryMemory, allowsTool: (name: string) => boolean): SelectedHit[] {
  const hits: SelectedHit[] = [];
  const allowed = (hit: CapabilityHit): boolean => typeof hit.name === 'string' && allowsTool(hit.name);
  for (const category of categories) {
    for (const hit of result[category] ?? []) {
      if (!hit.ref || (hit.status && hit.status !== 'available')) continue;
      const members = hit.tools;
      if (members && !members.some(allowed)) continue;
      if (!members && ['tools', 'mcp'].includes(category) && (hit.kind === 'tool' || hit.tool) && !allowed(hit)) continue;
      hits.push({
        category,
        ...keep(hit, ['name', 'description', 'instructions', 'filePath']),
        ref: category === 'skills' && hit.filePath ? hit.filePath : hit.ref,
        ...(members ? { tools: members.filter(allowed).map((tool) => keep(tool, ['ref', 'name', 'description', 'exposure'])) } : {}),
        ...(!members && ['tools', 'mcp'].includes(category) ? keep(hit, ['exposure', 'tool', 'server']) : {}),
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

/** Rebuilt from branch records after compaction, reload, branching or inheritance. */
export function capabilityPromptTranscript(
  messages: readonly ProjectionMessage[],
  branch: readonly unknown[] | null | undefined,
  { allowsTool = () => true }: { allowsTool?: (name: string) => boolean } = {},
): ProjectionMessage[] {
  const clean = messages.flatMap((message) => {
    if (message.role !== 'system' || !(CAPABILITY_SECTION in (message.sections ?? {}))) return [message];
    const { [CAPABILITY_SECTION]: _owned, ...sections } = message.sections!;
    const copy = { ...message, sections };
    return !Object.keys(sections).length && !message.content && !message.toolsAdded?.length && !message.toolsRemoved?.length ? [] : [copy];
  });
  const visible = new Set(clean.filter((message) => message.role === 'toolResult' && message.toolName === 'capability').map((message) => message.toolCallId));
  const baseline: State = new Map();
  const anchored = new Map<string, SelectedHit[]>();
  for (const record of discoveryRecords(branch)) {
    const hits = selected(record.result, allowsTool);
    if (record.toolCallId !== undefined && visible.has(record.toolCallId)) anchored.set(record.toolCallId, hits);
    else merge(baseline, hits);
  }
  const state = new Map(baseline);
  let previous = render(state);
  const output: ProjectionMessage[] = [];
  if (previous && clean[0]?.role !== 'system') {
    output.push({ role: 'system', content: '', sections: { [CAPABILITY_SECTION]: previous }, timestamp: 0 });
  }
  for (const [index, message] of clean.entries()) {
    output.push(index === 0 && message.role === 'system' && previous
      ? { ...message, sections: { ...message.sections, [CAPABILITY_SECTION]: previous } }
      : message);
    if (message.role !== 'toolResult' || message.toolCallId === undefined) continue;
    const update = anchored.get(message.toolCallId);
    if (!update) continue;
    merge(state, update);
    const current = render(state);
    if (current !== previous) {
      output.push({ role: 'system', content: '', sections: { [CAPABILITY_SECTION]: current! }, timestamp: message.timestamp });
      previous = current;
    }
  }
  return output;
}
