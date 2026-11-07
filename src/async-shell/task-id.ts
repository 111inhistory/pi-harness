/** Public task handles are compact names; execution authority is a separate token. */
export function isTaskId(value: string): boolean {
  return /^job_[0-9a-f]{8}$/.test(value);
}
