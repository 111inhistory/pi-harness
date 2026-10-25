/**
 * Durable discovery memory, projected as native system sections.
 * Successful discoveries are persisted by the Capability tool as
 * `capability-discovery` branch entries (see ./capability/discovery-record.ts),
 * not from the model's summary: a nested ctx.executeTool call keeps its memory
 * even when the outer tool drops the inner result. Branch entries are canonical.
 * A tool result that has no matching record (a session written before records
 * existed) is still read from its details, so upgrading does not drop already
 * discovered resources; a record always supersedes its own tool call id, so the
 * same discovery is never counted twice. Uncompacted discoveries anchor updates
 * immediately after their visible result; discoveries no longer present in
 * context are folded into the leading checkpoint. Nothing rewrites an
 * uncompressed prefix, installs a resource, or grants tool authority: the
 * current tool registry and parent scope are applied on every projection.
 */
import { CAPABILITY_DISCOVERY_RECORD, discoveryRecords } from "./capability/discovery-record.ts";
import { promptText } from "./prompt-text.mjs";

const policyPrompt = JSON.parse(promptText("capability-policy.json"));

export const CAPABILITY_SECTION = "capabilities";

function selected(result, allowsTool) {
  const hits = [];
  for (const category of ["tools", "mcp", "skills", "guidance"]) {
    for (const hit of result[category] ?? []) {
      if (!hit?.ref || (hit.status && hit.status !== "available")) continue;
      const members = Array.isArray(hit.tools) ? hit.tools : null;
      if (members && !members.some((tool) => allowsTool(tool.name))) continue;
      if (!members && ["tools", "mcp"].includes(category) && (hit.kind === "tool" || hit.tool) && !allowsTool(hit.name)) continue;
      const keep = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
      hits.push({
        category,
        ...keep(hit, ["ref", "name", "description", "instructions", "filePath", "caveats", "bindsTo"]),
        ...(category === "skills" && hit.filePath ? { ref: hit.filePath } : {}),
        ...(members ? { tools: members.filter((tool) => allowsTool(tool.name)).map((tool) => keep(tool, ["ref", "name", "description", "exposure"])) } : {}),
        ...(!members && ["tools", "mcp"].includes(category) ? keep(hit, ["exposure", "tool", "server"]) : {}),
      });
    }
  }
  return hits;
}

function merge(state, hits) {
  for (const hit of hits) {
    const previous = state.get(hit.ref);
    // A later guidance-only hit must not erase the group's known members.
    const tools = previous?.tools || hit.tools
      ? [...new Map([...(previous?.tools ?? []), ...(hit.tools ?? [])].map((tool) => [tool.name, tool])).values()]
      : undefined;
    state.set(hit.ref, { ...previous, ...hit, ...(tools ? { tools } : {}) });
  }
}

function render(state) {
  if (!state.size) return null;
  return `<${CAPABILITY_SECTION}>\n${policyPrompt.memoryHeader}\n${JSON.stringify([...state.values()])}\n</${CAPABILITY_SECTION}>`;
}

/** Pure request projection. Works after compaction, reload, branching and inheritance. */
export function capabilityPromptTranscript(messages, branch, { allowsTool = () => true } = {}) {
  // Strip only our own earlier projection, making repeated transformations idempotent.
  const clean = messages.flatMap((message) => {
    if (message.role !== "system" || !(CAPABILITY_SECTION in (message.sections ?? {}))) return [message];
    const { [CAPABILITY_SECTION]: _owned, ...sections } = message.sections;
    const copy = { ...message, sections };
    return !Object.keys(sections).length && !message.content && !message.toolsAdded?.length && !message.toolsRemoved?.length ? [] : [copy];
  });
  const visible = new Set(clean.filter((message) => message.role === "toolResult" && message.toolName === "capability").map((message) => message.toolCallId));
  const entries = branch ?? [];
  // Record ids are canonical even when the matching tool result predates the record.
  const recordedCalls = new Set(discoveryRecords(entries).flatMap((record) => record.toolCallId === undefined ? [] : [record.toolCallId]));
  const baseline = new Map();
  const anchored = new Map();
  // Branch order preserves later-guidance-wins semantics across records and legacy results.
  for (const entry of entries) {
    if (entry?.type === "custom" && entry.customType === CAPABILITY_DISCOVERY_RECORD) {
      const [record] = discoveryRecords([entry]);
      if (record === undefined) continue;
      const hits = selected(record.result, allowsTool);
      if (record.toolCallId !== undefined && visible.has(record.toolCallId)) anchored.set(record.toolCallId, hits);
      else merge(baseline, hits);
      continue;
    }
    const message = entry?.type === "message" ? entry.message : null;
    if (message?.role !== "toolResult" || message.toolName !== "capability" || message.isError) continue;
    // The canonical record for this call already supplied the memory.
    if (message.toolCallId && recordedCalls.has(message.toolCallId)) continue;
    const legacy = message.details;
    if (!legacy || !["ok", "partial"].includes(legacy.status)) continue;
    const hits = selected(legacy, allowsTool);
    if (message.toolCallId && visible.has(message.toolCallId)) anchored.set(message.toolCallId, hits);
    else merge(baseline, hits);
  }
  const state = new Map(baseline);
  let previous = render(state);
  const output = [];
  if (previous && clean[0]?.role !== "system") {
    output.push({ role: "system", content: "", sections: { [CAPABILITY_SECTION]: previous }, timestamp: 0 });
  }
  for (const [index, message] of clean.entries()) {
    output.push(index === 0 && message.role === "system" && previous
      ? { ...message, sections: { ...message.sections, [CAPABILITY_SECTION]: previous } }
      : message);
    if (message.role !== "toolResult" || !anchored.has(message.toolCallId)) continue;
    merge(state, anchored.get(message.toolCallId));
    const current = render(state);
    if (current !== previous) {
      output.push({ role: "system", content: "", sections: { [CAPABILITY_SECTION]: current }, timestamp: message.timestamp });
      previous = current;
    }
  }
  return output;
}
