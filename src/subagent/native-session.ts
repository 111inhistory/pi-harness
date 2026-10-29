/**
 * Concrete child-session factory for the native Job runner.
 *
 * This module owns the setup that used to live inside the host adapter's
 * `startPiJob`: the per-root SettingsManager cache, the child
 * DefaultResourceLoader, the child extension factory (capability parent,
 * capability extension, host-installed surface) and the shared execution
 * lifetime around `createAgentSession`.
 *
 * What it does not own:
 *
 * - Routing, model/thinking selection and tool-loadout decisions stay with the
 *   runner. The request already carries the complete identity and exclusions.
 * - The parent ModelRuntime is never created here. The bridge in
 *   `model-runtime.ts` resolves the root registry's exact runtime, so extension
 *   providers and runtime credentials stay available; an unavailable bridge is
 *   an explicit failure, never a fresh fallback.
 * - Child extension contents are a host callback. This factory only installs
 *   the capability parent and the capability extension, then hands the child
 *   Pi and its scope to the host so the adapter can install this depth's tools.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import capabilityExtension from "../../extensions/capability.mjs";
import { setCapabilityParent } from "../capability/scope.ts";
import type { CapabilityToolCatalog } from "../capability/scope.ts";
import { openSubagentExecution } from "./execution.ts";
import { parentModelRuntime } from "./model-runtime.ts";
import { MAX_AGENT_DEPTH, SubagentError } from "./runtime.ts";
import type {
  NativeChildSurfaceScope,
  NativeOpenedSession,
  NativeSessionFactory,
  NativeSessionRequest,
} from "./native-types.ts";

/**
 * Everything the concrete factory needs. All four dependencies have one owner
 * outside this module:
 *
 * - `agentDir` is the root installation directory; child settings and sessions
 *   resolve their global layer from it.
 * - `modelRegistry` returns the *current* root registry. The factory bridges it
 *   on every check/open so a refreshed root cannot leave a stale runtime behind.
 * - `parentCapabilityScope` resolves the spawning caller's live or retained
 *   catalog lazily, so a revived parent is looked up anew.
 * - `installChildSurface` installs the protocol/harness tools for this depth and
 *   records the child Pi as that Job's live surface. It is not called for any
 *   Job whose request is rejected before setup.
 */
export interface NativeSessionFactoryDeps {
  readonly agentDir: string;
  readonly modelRegistry: () => unknown;
  readonly installChildSurface: (api: ExtensionAPI, scope: NativeChildSurfaceScope) => void;
  readonly parentCapabilityScope: (originActor: string | null) => CapabilityToolCatalog;
}

/**
 * Narrow one recorded string to the SDK's ThinkingLevel union. The recorded
 * actor field is deliberately a plain string because it survives persistence;
 * an invalid value must fail explicitly instead of reaching the SDK through a
 * blanket cast.
 */
function narrowThinkingLevel(value: string | null): ThinkingLevel | undefined {
  if (value === null) return undefined;
  for (const level of MODEL_THINKING_LEVELS) {
    if (level === value) return level;
  }
  throw new SubagentError(
    "invalid_request",
    `The recorded thinking level "${value}" is not an SDK ThinkingLevel; refusing to run with an ambiguous value.`,
    { thinkingLevel: value },
  );
}

class ConcreteNativeSessionFactory implements NativeSessionFactory {
  readonly #deps: NativeSessionFactoryDeps;
  /** One settings layer per (cwd, project trust) pair, like the host adapter. */
  readonly #settings = new Map<string, SettingsManager>();

  constructor(deps: NativeSessionFactoryDeps) {
    this.#deps = deps;
  }

  assertModelRuntime(): void {
    this.#modelRuntime();
  }

  async open(request: NativeSessionRequest): Promise<NativeOpenedSession> {
    // Fail before any expensive setup (and before routing in the caller) when
    // the root runtime bridge is unavailable. The same runtime is then handed
    // to createAgentSession through openSubagentExecution.
    const modelRuntime = this.#modelRuntime();
    const thinkingLevel = narrowThinkingLevel(request.thinkingLevel);
    const settings = this.#settingsFor(request.cwd, request.trusted);

    // The child Pi exists while the resource loader runs; the host callback
    // installs this depth's tool surface into it. Only the first child is
    // expected: the loader is created for exactly this Job's extension factory.
    const childApis: ExtensionAPI[] = [];
    const surface = request.surface;
    const childFactory: InlineExtension = {
      name: `subagent:${request.agentId}`,
      factory: (childPi: ExtensionAPI): void => {
        childApis.push(childPi);
        // The parent is resolved lazily for a revived caller. Role denials and
        // this depth's harness exclusions are the request's complete list.
        setCapabilityParent(
          childPi,
          () => this.#deps.parentCapabilityScope(surface.capabilityParentId),
          request.excludedTools,
        );
        capabilityExtension(childPi, { discovery: surface.depth < MAX_AGENT_DEPTH });
        this.#deps.installChildSurface(childPi, surface);
      },
    };

    const resourceLoader = new DefaultResourceLoader({
      cwd: request.cwd,
      agentDir: this.#deps.agentDir,
      settingsManager: settings,
      noExtensions: true,
      extensionFactories: [childFactory],
      // An Inherited child keeps the parent's system prompt; a Fresh child keeps
      // Pi's own prompt and appends the routed role instructions supplied by
      // the runner. Never write a default prompt override here.
      ...(request.systemPrompt !== null ? { systemPrompt: request.systemPrompt } : {}),
      appendSystemPrompt: [...request.appendSystemPrompt],
    });
    await resourceLoader.reload();

    // The resource loader records inline-factory failures instead of throwing
    // them. A child without its complete surface must not run: report every
    // setup error and fail before creating the SDK session.
    const errors = resourceLoader.getExtensions().errors;
    if (errors.length > 0) {
      throw new SubagentError(
        "session_unavailable",
        `The child Pi surface for ${request.agentId} could not be installed: ${errors.map((entry) => `${entry.path}: ${entry.error}`).join("; ")}`,
        { agentId: request.agentId, errors },
      );
    }
    const childPi = childApis[0];
    if (childPi === undefined) {
      throw new SubagentError(
        "session_unavailable",
        `The child Pi surface for ${request.agentId} was not created.`,
        { agentId: request.agentId },
      );
    }

    // The shared wrapper owns abort-during-creation cleanup. Once returned,
    // ownership transfers directly to the runner; no second cleanup path.
    const execution = await openSubagentExecution(
      {
        cwd: request.cwd,
        agentDir: this.#deps.agentDir,
        settingsManager: settings,
        modelRuntime,
        ...(request.model !== null ? { model: request.model } : {}),
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        excludeTools: [...request.excludedTools],
        sessionManager: request.sessionManager,
        resourceLoader,
      },
      { signal: request.signal },
    );
    return { execution, capabilityScope: childPi };
  }

  #modelRuntime(): ReturnType<typeof parentModelRuntime> {
    return parentModelRuntime(this.#deps.modelRegistry(), "subagent sessions");
  }

  #settingsFor(cwd: string, trusted: boolean): SettingsManager {
    const key = `${cwd}\u0000${trusted}`;
    const cached = this.#settings.get(key);
    if (cached !== undefined) return cached;
    const settings = SettingsManager.create(cwd, this.#deps.agentDir, { projectTrusted: trusted });
    this.#settings.set(key, settings);
    return settings;
  }
}

/**
 * Build the production factory. The returned closure owns its settings cache
 * and reads the root runtime through the explicit supplier on each use.
 */
export function createNativeSessionFactory(deps: NativeSessionFactoryDeps): NativeSessionFactory {
  return new ConcreteNativeSessionFactory(deps);
}
