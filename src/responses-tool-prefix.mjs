import { declarationsEqual } from "@earendil-works/pi-ai";

/** Only opt in when this concrete model supports in-place tools and prompt updates. */
export function supportsAdditiveResponses(model) {
  return ["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(model?.api) &&
    model.compat?.supportsMidConvoSystemMessages === true &&
    (model.compat?.supportsAdditionalTools === true || model.compat?.supportsToolSearch === true);
}

/** First declarations, in transcript order. No executable handles or session state. */
export function firstToolDeclarations(messages) {
  const tools = new Map();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) if (!tools.has(tool.name)) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

/**
 * Request-only projection: declarations are append-only, execution is NOT enabled.
 * Pi's executable registry still enforces the live loadout. Replay permission changes
 * where they originally happened, rather than patching the leading tools or prompt.
 */
export function additiveToolTranscript(messages) {
  const declared = new Map();
  const enabled = new Set();
  return messages.map((message) => {
    if (message.role !== "system") return message;
    const notes = [];
    for (const tool of message.toolsRemoved ?? []) {
      enabled.delete(tool.name);
      notes.push(`Tool ${tool.name} is unavailable in this session. Do not call it; execution is blocked.`);
    }
    const additions = [];
    for (const tool of message.toolsAdded ?? []) {
      const previous = declared.get(tool.name);
      if (!previous) {
        declared.set(tool.name, tool);
        additions.push(tool);
      } else if (!declarationsEqual(previous, tool)) {
        notes.push(`Tool ${tool.name} has updated interface or usage guidance. Inspect its current interface before calling it; execution validates current arguments.`);
      }
      if (previous && !enabled.has(tool.name)) notes.push(`Tool ${tool.name} is available again.`);
      enabled.add(tool.name);
    }
    if (!message.toolsRemoved?.length && additions.length === (message.toolsAdded?.length ?? 0)) return message;
    const { toolsAdded, toolsRemoved, ...rest } = message;
    const content = typeof message.content === "string" ? message.content :
      (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return {
      ...rest,
      content: [content, ...notes].filter(Boolean).join("\n\n"),
      ...(additions.length ? { toolsAdded: additions } : {}),
    };
  });
}

/** Inherited declarations remain visible, but carry no execution authority. */
export function retrievalToolLoadout(messages, retrievalTools) {
  const names = new Set(retrievalTools.map((tool) => tool.name));
  const blocked = firstToolDeclarations(messages).filter((tool) => !names.has(tool.name)).map((tool) => ({
    ...tool,
    label: tool.name,
    async execute() { throw new Error(`Tool ${tool.name} is unavailable in capability discovery. Only capability_search and submit_result may execute.`); },
  }));
  return [...blocked, ...retrievalTools];
}

/** Model-facing interfaces are a load delta, not a repeat of the caller's active tools. */
export function capabilityToolDelta(result, previouslyActive) {
  const guidance = [...(result.guidance ?? [])];
  const filter = (hits) => hits.flatMap((hit) => {
    if (Array.isArray(hit.tools)) {
      const added = hit.tools.filter((tool) => !previouslyActive.has(tool.name));
      if (added.length) return [{ ...hit, tools: added, toolCount: added.length }];
      if (hit.instructions) guidance.push({ ref: hit.ref, name: hit.name, instructions: hit.instructions });
      return [];
    }
    return previouslyActive.has(hit.name) ? [] : [hit];
  });
  const tools = filter(result.tools);
  const mcp = filter(result.mcp);
  return { ...result, tools, mcp, ...(guidance.length ? { guidance } : {}) };
}

/** Compact only interfaces actually enabled for direct declaration, not deferred refs. */
export function capabilityModelResult(result, declaredNames) {
  const compact = (hit) => {
    const members = Array.isArray(hit.tools) ? hit.tools : [hit];
    if (!members.length || !members.every((tool) => declaredNames.has(tool.name))) return hit;
    const { tools, toolCount, description, exposure, match, score, reason, source, path, ...guidance } = hit;
    return { ...guidance, interface: "Declared through the session's tool loadout; use the tool declaration for arguments." };
  };
  return { ...result, tools: result.tools.map(compact), mcp: result.mcp.map(compact) };
}

