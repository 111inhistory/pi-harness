/** Tools independently registered by Harness surfaces; depth policy lives in Subagent. */
export const JOB_TOOLS = ["job_stop", "job_send", "job_key"] as const;
export const HARNESS_TOOLS = ["subagent_create", "subagent_list", "subagent_signal", "capability", "msg_write", ...JOB_TOOLS] as const;
const names: ReadonlySet<string> = new Set(HARNESS_TOOLS);

/** Independent registration is still subject to explicit permission denials. */
export function isHarnessTool(name: string): boolean {
  return names.has(name);
}
