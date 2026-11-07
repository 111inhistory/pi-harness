/**
 * The parent-session ModelRuntime bridge for Pi extensions.
 *
 * Session child processes must run on the parent session's exact ModelRuntime
 * so extension-registered providers, virtual-model routing and runtime
 * credentials stay available. Pi's synchronous `ModelRegistry` compatibility
 * facade stores that runtime in a TypeScript-`private` field; the compiled
 * 1.5.0 facade (``model-registry.js``) keeps it as the plain property
 * `runtime`, and there is no public accessor.
 *
 * This module is the ONE documented vendor compatibility boundary where an
 * unknown value is inspected structurally and narrowed to `ModelRuntime`.
 * Every other module consumes the typed result. The guard deliberately does
 * not use `instanceof`: a legitimate same-version copy loaded through another
 * package path still exposes the same members and must remain usable.
 *
 * The bridge never constructs a fallback runtime. A fresh runtime would lose
 * the parent's provider registrations, virtual models and credentials, so an
 * unavailable or incomplete bridge is always an explicit failure.
 */

import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * The private-SDK surface was audited against this package version. Bump only
 * together with a new audit of the compiled `ModelRegistry` facade.
 */
export const MODEL_RUNTIME_AUDITED_VERSION = "1.5.0";

/** Explicit bridge failure. The code matches the Subagent lifecycle error. */
export class ModelRuntimeBridgeError extends Error {
  readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = "ModelRuntimeBridgeError";
    this.code = "model_runtime_unavailable";
  }
}

/**
 * Audited structural guard for the 1.5.0 ModelRuntime members this harness
 * relies on. Kept narrow on purpose: the private facade property is the only
 * thing that needs an unknown-to-ModelRuntime bridge.
 */
function isModelRuntime(value: unknown): value is ModelRuntime {
  if (value === null || typeof value !== "object") return false;
  // The single assertion escape hatch in this module: `value` is an object and
  // the three audited members are checked immediately below.
  const candidate = value as Record<string, unknown>;
  return typeof candidate.streamSimple === "function"
    && typeof candidate.getAuth === "function"
    && typeof candidate.getRegisteredProviderIds === "function";
}

/**
 * The parent runtime, or null when the private facade property is absent or
 * incomplete. Never falls back to a fresh runtime.
 */
export function findParentModelRuntime(registry: unknown): ModelRuntime | null {
  if (registry === null || typeof registry !== "object") return null;
  if (!("runtime" in registry)) return null;
  const candidate: unknown = registry.runtime;
  return isModelRuntime(candidate) ? candidate : null;
}

/**
 * Throwing bridge for consumers whose failure class is a plain Error. The
 * message keeps the consumer's own domain subject while this module owns the
 * compatibility wording and the explicit no-fallback rule.
 */
export function parentModelRuntime(registry: unknown, subject = "this session"): ModelRuntime {
  const runtime = findParentModelRuntime(registry);
  if (runtime !== null) return runtime;
  throw new ModelRuntimeBridgeError(
    "this Pi build does not expose the session ModelRuntime through ModelRegistry.runtime, so " +
      `${subject} cannot reuse the parent session's provider registrations and virtual models; refusing to ` +
      "silently fall back to a fresh runtime",
  );
}

/** Pin a tool call to its producing response; commands inherit the latest response. */
export function physicalModelForCall(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager">,
  toolCallId?: string,
): Model<Api> | null {
  const selected = ctx.model ?? null;
  if (selected === null || selected.api !== "pi-virtual") return selected;
  const messages = ctx.sessionManager.buildSessionProjection().messages;
  const producing = messages.findLast(message => message.role === "assistant" &&
    (toolCallId === undefined || message.content.some(block => block.type === "toolCall" &&
      (block.id === toolCallId || toolCallId.startsWith(`${block.id}/`)))));
  const physical = producing?.role === "assistant"
    ? parentModelRuntime(ctx.modelRegistry, "inherited context").getPhysicalModel(producing.provider, producing.model)
    : undefined;
  if (physical !== undefined) return physical;
  throw new Error("The physical model that issued the inherited-context request is unavailable; refusing to reroute the conversation.");
}
