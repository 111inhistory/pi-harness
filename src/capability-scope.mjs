/**
 * Capability eligibility state and per-operation qualification views.
 *
 * The implementation lives in strict TypeScript (`./capability/scope.ts`).
 * This file only re-exports it so existing `.mjs` consumers keep their import
 * path and named exports. New filter loops should import
 * `createCapabilityScopeView` and ask the one view for every tool in an
 * operation; `capabilityAllowsTool` remains the single-name compatibility
 * function.
 */

export {
  capabilityAllowsTool,
  capabilityAvailableTools,
  createCapabilityScopeView,
  setCapabilityParent,
} from "./capability/scope.ts";
