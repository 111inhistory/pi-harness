/** Tools independently registered by Harness surfaces; depth policy lives in Subagent. */
export const HARNESS_TOOLS = ["subagent_create", "subagent_list", "subagent_stop", "capability", "msg_write"] as const;
const names: ReadonlySet<string> = new Set(HARNESS_TOOLS);

/** Independent registration is still subject to explicit permission denials. */
export function isHarnessTool(name: string): boolean {
  return names.has(name);
}
