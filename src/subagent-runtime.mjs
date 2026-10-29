/**
 * Compatibility entry for the typed Subagent domain runtime.
 *
 * The implementation and its domain types live in `src/subagent/runtime.ts`.
 * This module only re-exports the public surface so existing `.mjs` callers
 * and tests keep their import paths during the migration.
 */

export {
  MAX_AGENT_DEPTH,
  SubagentError,
  SubagentRuntime,
  canonicalActorId,
  copyInheritedEntries,
  createSubagentRuntime,
} from "./subagent/runtime.ts";
