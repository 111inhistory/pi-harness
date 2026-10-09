/** Keep retrieval ranking and diagnostic warnings out of Main's tool content. */
export function capabilityPublicResult(result) {
  const hit = (candidate) => {
    const { match, score, reason, warnings, ...visible } = candidate;
    if (Array.isArray(visible.bindsTo) && visible.bindsTo.length === 0) delete visible.bindsTo;
    if (Array.isArray(visible.caveats) && visible.caveats.length === 0) delete visible.caveats;
    return { ...visible, ...(Array.isArray(visible.tools) ? { tools: visible.tools.map(hit) } : {}) };
  };
  const { warnings, ...visible } = result;
  return {
    ...visible,
    ...Object.fromEntries(["tools", "mcp", "skills", "remote", "guidance"].filter((key) => Array.isArray(visible[key])).map((key) => [key, visible[key].map(hit)])),
  };
}
