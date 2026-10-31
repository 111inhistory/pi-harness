/**
 * Capability Pi extension.
 *
 * Adds the no-argument `capability` tool to a session. A call runs an isolated
 * internal retrieval session through the shared Subagent execution entry point
 * (`openSubagentExecution`), the same session lifetime, abort and cleanup used by
 * public delegation. Only `capability_step` may execute; compatible Responses
 * also retain blocked parent declarations, never parent handles; the run has its
 * own fixed budget. The session inherits the caller's native conversation — raw
 * session entries, system prompt, physical model — so provider-returned blocks
 * such as thinking with their signatures survive verbatim. Compatible Responses
 * keep the parent's thinking level and declaration prefix; other models use
 * thinking low. The tool returns full grouped metadata in details and a compact
 * model-facing selection where the next request supplies the interfaces through
 * native declarations or an active Codemode query path. It declares the selected
 * already-registered tools active in this session. It never installs, enables or
 * executes anything.
 *
 * The search sees only the tools registered at call time; it never waits for an
 * MCP backend or another asynchronous registration to become ready. Immediately
 * before persistence and activation the current eligible catalog is read again,
 * so a member that was unregistered, hidden or denied during retrieval is left
 * out of both the branch record and the published result.
 *
 * The internal agent only searches local tools, MCP servers and skills. The
 * result always reports that remote was not searched, and no remote candidate
 * reaches Main, the branch memory or a summary.
 *
 * Each completed discovery is persisted as one `capability-discovery` branch
 * entry (see ../src/capability/discovery-record.ts) before this tool activates
 * anything, so a nested `ctx.executeTool("capability", ...)` keeps its memory
 * even when the outer tool drops the inner result details. The request
 * projection reads those records and applies the current tool permissions on
 * every request.
 *
 * Skills return absolute entry paths for native read. Tool interfaces are
 * supplied by selected results or native declarations; no resource protocol
 * router or read/write override is installed.
 */

import { readFile } from "node:fs/promises";

import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import {
  CAPABILITY_PARAMETERS,
  CAPABILITY_TOOL_DESCRIPTION,
  CAPABILITY_TOOL_NAME,
} from "../src/capability/contracts.ts";
import { createCapabilityBroker, type CapabilityProviders } from "../src/capability/broker.ts";
import {
  CAPABILITY_DISCOVERY_SYSTEM_PROMPT,
  capabilityBudgetWarning,
  capabilityFailureResult,
  createCapabilityDiscovery,
  type CapabilityDiscoveryResult,
  type CapabilityOpenSessionRequest,
  type CapabilityRunSession,
} from "../src/capability/agent.ts";
import { promptString, promptStrings } from "../src/prompt-text.ts";

import { installModelCallBudget } from "../src/subagent/pi-job-budget.ts";
import { captureInheritedContext, type InheritedSnapshot } from "../src/inherited-context.ts";
import { discoverSessionSkills } from "../src/capability/skills.ts";
import { capabilityPublicResult } from "../src/capability/result.ts";
import { capabilityPromptTranscript, type ProjectionMessage } from "../src/capability/prompt.ts";
import { appendDiscoveryRecord } from "../src/capability/discovery-record.ts";
import { openSubagentExecution } from "../src/subagent/execution.ts";
import { parentModelRuntime } from "../src/subagent/model-runtime.ts";
import { installNativeDiscoveryBoundary } from "../src/capability/native-discovery.ts";
import { createEligibleToolCatalog, retainEligibleSelectedTools, supplySelectedToolInterfaces } from "../src/capability/tool-catalog.ts";
import {
  additiveToolTranscript, capabilityModelResult, capabilityToolDelta, retrievalToolLoadout, supportsAdditiveResponses,
  type CapabilityInterfaceSources,
} from "../src/responses-tool-prefix.ts";

const toolsPrompt = readToolsPrompt();
const policyPrompt = readPolicyPrompt();

interface CapabilityToolsPrompt {
  readonly capability: {
    readonly snippet: string;
    readonly guidelines: readonly string[];
  };
}

interface CapabilityPolicyPrompt {
  readonly additiveExecutionBlocked: string;
}

/** A hit selected for tool activation; skill hits are not activated. */
interface ActivationHit {
  readonly name?: unknown;
  readonly kind?: unknown;
  readonly tools?: readonly ActivationHit[] | undefined;
}


interface Activation {
  readonly activated: readonly string[];
  readonly warnings: readonly string[];
  /** The session's actual active set after the synchronous activation call. */
  readonly active: ReadonlySet<string>;
}

type DiscoveryRecordWriter = Parameters<typeof appendDiscoveryRecord>[0];
type HarnessSettings = ReturnType<SettingsManager["getSettings"]>;

function readToolsPrompt(): CapabilityToolsPrompt {
  return { capability: {
    snippet: promptString("capability-tools.json", "capability", "snippet"),
    guidelines: promptStrings("capability-tools.json", "capability", "guidelines"),
  } };
}

function readPolicyPrompt(): CapabilityPolicyPrompt {
  return { additiveExecutionBlocked: promptString("capability-policy.json", "additiveExecutionBlocked") };
}

export default function capabilityExtension(pi: ExtensionAPI, { discovery = true }: { discovery?: boolean } = {}): void {
  const declaredTools = installNativeDiscoveryBoundary(pi);
  const service = {
    agentDir: getAgentDir(),
    projectTrusted: false,
  };
  const broker = createCapabilityBroker(createProviders(pi, service));
  pi.on("session_start", (_event, ctx) => { service.projectTrusted = ctx.isProjectTrusted(); });

  // Keep Pi's loaded Skill inventory for discovery, but do not advertise it
  // eagerly in the base prompt. Mutate the native section, not the full prompt.
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.skills = [];
  });

  // Discovery memory follows the branch, not the lossy summary. Append native
  // section updates at their original result anchors; only compaction checkpoints
  // receive the accumulated older discoveries. Exposure and execution stay separate.
  pi.on("context_with_system", (event, ctx) => {
    const available = createEligibleToolCatalog(pi).names;
    const messages = capabilityPromptTranscript(
      event.messages as unknown as readonly ProjectionMessage[],
      ctx.sessionManager.getBranch(),
      { allowsTool: (name) => available.has(name) },
    );
    return {
      messages: (supportsAdditiveResponses(ctx.model) ? additiveToolTranscript(messages) : messages) as unknown as AgentMessage[],
    };
  });
  pi.on("tool_call", (event) => {
    const tool = createEligibleToolCatalog(pi).tools.find((entry) => entry.name === event.toolName);
    if (!tool || (!pi.getActiveTools().includes(event.toolName) && !["codemode", "deferred"].includes(tool.exposure ?? ""))) {
      return { block: true, reason: `Tool ${event.toolName} is unavailable in this session; retained declarations do not enable execution.` };
    }
    return undefined;
  });

  if (!discovery) return;
  pi.registerTool({
    name: CAPABILITY_TOOL_NAME,
    label: "Capability",
    description: CAPABILITY_TOOL_DESCRIPTION,
    promptSnippet: toolsPrompt.capability.snippet,
    promptGuidelines: [...toolsPrompt.capability.guidelines],
    parameters: CAPABILITY_PARAMETERS,
    async execute(toolCallId, _params, signal, _onUpdate, ctx) {
      let result: CapabilityDiscoveryResult;
      let interfaceSources: CapabilityInterfaceSources | null = null;
      let previouslyActive = new Set<string>();
      try {
        service.projectTrusted = ctx.isProjectTrusted();
        const snapshot = captureInheritedContext(pi, ctx, toolCallId);
        const engine = createCapabilityDiscovery({
          broker,
          openSession: (request) => openInternalSession(pi, service, ctx, request, snapshot),
        });
        result = await engine.discover(signal === undefined ? { cwd: ctx.cwd } : { cwd: ctx.cwd, signal });
        if (cancelled(signal, ctx.signal)) {
          result = cancelledBeforePublication(result);
        } else {
          // The search result is a snapshot. Re-read the current registered,
          // permitted catalog before persisting or activating anything, so a
          // tool that was unregistered, hidden or denied during retrieval never
          // enters the branch record or the published selection.
          result = retainSelectedTools(pi, result, "catalog");
          if (result.status !== "failed") {
            // Persist before activation. Memory is the durability contract, so a
            // failed record write fails closed: nothing is advertised as selected
            // and nothing is activated, because the next request could not restore
            // it. The thrown detail stays in the internal warnings audit.
            try {
              appendDiscoveryRecord(pi as DiscoveryRecordWriter, toolCallId, result, result.coverage);
            } catch (error) {
              result = discoveryNotDurable(result, error);
            }
          }
        }
        if (result.status !== "failed" && !cancelled(signal, ctx.signal)) {
          try {
            previouslyActive = new Set(pi.getActiveTools());
            const activation = activateSelectedTools(pi, result);
            createEligibleToolCatalog(pi);
            // Publication follows what is actually active, not what the search
            // hoped to activate. This is a synchronous read of the SDK's state,
            // not a rollback path.
            result = retainSelectedTools(pi, result, "activation", activation.active);
            if (activation.warnings.length > 0) {
              result = withOuterWarnings(result, activation.warnings);
            }
            interfaceSources = capabilityInterfaceSources(activation.active, declaredTools);
          } catch (error) {
            result = withOuterWarnings(result, [`selected tools could not be activated: ${errorMessage(error)}`]);
          }
        } else if (result.status !== "failed") {
          result = cancelledBeforePublication(result);
        }
      } catch (error) {
        result = capabilityFailureResult(`capability discovery failed: ${errorMessage(error)}.`);
      }
      const delta = capabilityToolDelta(result, previouslyActive);
      const withInterfaces = supplySelectedToolInterfaces(delta, pi);
      const projected = interfaceSources === null ? withInterfaces : capabilityModelResult(withInterfaces, interfaceSources);
      const publicResult = capabilityPublicResult(projected);
      return {
        content: [{ type: "text", text: JSON.stringify(publicResult) }],
        details: result,
        isError: result.status === "failed",
      };
    },
  });
}

function cancelled(signal: AbortSignal | undefined, contextSignal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || contextSignal?.aborted === true;
}

function cancelledBeforePublication(result: CapabilityDiscoveryResult): CapabilityDiscoveryResult {
  return {
    ...capabilityFailureResult(
      "capability discovery cancelled: the caller aborted before the selected capabilities were published.",
      result.warnings,
      result.coverage,
    ),
    endReason: "cancelled",
  };
}

function withOuterWarnings(result: CapabilityDiscoveryResult, warnings: readonly string[]): CapabilityDiscoveryResult {
  return {
    ...result,
    status: result.status === "ok" ? "partial" : result.status,
    warnings: [...result.warnings, ...warnings],
  };
}

/**
 * A discovery that could not be written to the branch is not durable, so it must
 * not be presented as a successful selection or activated. The public failure
 * reason says why; the internal warnings keep the full write error for audit.
 */
function discoveryNotDurable(result: CapabilityDiscoveryResult, error: unknown): CapabilityDiscoveryResult {
  const detail = errorMessage(error);
  const reason =
    "capability discovery failed: the selected resources could not be saved in this session branch, " +
    `so they are not durable: ${detail}.`;
  const failed = capabilityFailureResult(
    reason,
    [...result.warnings, `capability record write failed: ${detail}`],
    result.coverage,
  );
  return result.endReason === undefined ? failed : { ...failed, endReason: result.endReason };
}

function createProviders(
  pi: ExtensionAPI,
  service: { readonly agentDir: string; readonly projectTrusted: boolean },
): CapabilityProviders {
  return {
    listTools: () => createEligibleToolCatalog(pi).tools,
    listActiveTools: () => pi.getActiveTools(),
    discoverSkills: (cwd: string) => discoverSessionSkills(pi, {
      cwd,
      agentDir: service.agentDir,
      projectTrusted: service.projectTrusted,
    }),
    readSkillFile: (filePath: string) => readFile(filePath, "utf8"),
  };
}

function safeSettings(pi: ExtensionAPI): HarnessSettings | null {
  try {
    return pi.getSettings() ?? null;
  } catch {
    return null;
  }
}

/**
 * The internal session's settings: a snapshot of the caller's effective settings
 * in an in-memory manager.
 *
 * In-memory on purpose — no code path inside the child can persist a model,
 * thinking level or any other preference back to the caller's or the user's
 * settings files, because the child's manager has no file storage at all. The
 * resource-source lists are emptied because the child disables every loader
 * (no extensions, skills, prompt templates, themes, context files): resource
 * resolution for the disabled loaders can otherwise install configured npm/git
 * packages as a side effect (`DefaultResourceLoader.reload()` resolves the
 * `packages` setting), which capability discovery must never trigger.
 */
function internalSettings(pi: ExtensionAPI, trusted: boolean): SettingsManager {
  const effective = safeSettings(pi);
  const base: Partial<HarnessSettings> = effective ?? {};
  return SettingsManager.inMemory(
    { ...base, packages: [], extensions: [], skills: [], prompts: [], themes: [] },
    { projectTrusted: trusted },
  );
}

/**
 * Declare the selected, already-registered tools active in this session.
 *
 * `getActiveTools`/`setActiveTools` is Pi's active-tool API: it declares the
 * named registered tools to the model, records the change in the transcript,
 * and ignores unknown and hidden names. This is tool activation — not
 * installation or enablement: nothing is downloaded, loaded or connected and
 * the current active set (read/write and everything else) is preserved. Every
 * registered, non-hidden tool is loadable this way, including `direct` and
 * `model-only` tools that were left inactive by the caller's tool allowlist or
 * by `defaultActive: false`; a `hidden` tool is unreachable and skipped.
 */
function activateSelectedTools(pi: ExtensionAPI, result: CapabilityDiscoveryResult): Activation {
  const registered = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  const active = new Set(pi.getActiveTools());
  const activate: string[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  const selected: ActivationHit[] = [];
  for (const hit of [...result.tools, ...result.mcp]) {
    if (Array.isArray(hit.tools)) selected.push(...hit.tools);
    else selected.push(hit);
  }
  for (const hit of selected) {
    const name = typeof hit.name === "string" ? hit.name : "";
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    const tool = registered.get(name);
    if (tool === undefined) {
      // A server-level `mcp://<server>` ref names no single registered tool;
      // only a tool ref that lost its registration is reported.
      if (hit.kind === "tool") warnings.push(`selected tool "${name}" is not registered in this session`);
      continue;
    }
    if (tool.exposure === "hidden") {
      warnings.push(`selected tool "${name}" is hidden and cannot be activated`);
      continue;
    }
    if (active.has(name)) continue;
    activate.push(name);
  }
  if (activate.length > 0) pi.setActiveTools([...active, ...activate]);
  // Read back the SDK's authoritative set instead of assuming the request took
  // effect; Pi ignores unknown/hidden names and can mask an activatable tool.
  const actual = new Set(pi.getActiveTools());
  return { activated: activate, warnings, active: actual };
}

/**
 * Drop selected tool members that are no longer in the current eligible
 * catalog (before persistence) or that did not become active (after the SDK
 * activation call). Successful Skill selections are independent of tool
 * eligibility and stay published; a selection that loses every tool while
 * keeping no other successful resource fails closed.
 */
function retainSelectedTools(
  pi: ExtensionAPI,
  result: CapabilityDiscoveryResult,
  stage: "catalog" | "activation",
  active?: ReadonlySet<string>,
): CapabilityDiscoveryResult {
  if (result.status === "failed") return result;
  const retained = retainEligibleSelectedTools(
    result,
    pi,
    active === undefined ? {} : { active },
  );
  if (retained.dropped.length === 0) return result;
  const names = [...new Set(retained.dropped)];
  const detail = names.map((name) => stage === "catalog"
    ? `selected tool "${name}" is no longer available in this session; it was not published.`
    : `selected tool "${name}" did not become active in this session; it was not published.`);
  if (retained.selected > 0 && retained.retained === 0 && result.skills.length === 0) {
    const reason = names.length === 1
      ? stage === "catalog"
        ? `capability discovery failed: the selected tool "${names[0]}" is no longer available in this session.`
        : `capability discovery failed: the selected tool "${names[0]}" did not become active in this session.`
      : stage === "catalog"
        ? `capability discovery failed: none of the ${names.length} selected tools are still available in this session.`
        : `capability discovery failed: none of the ${names.length} selected tools became active in this session.`;
    const failed = capabilityFailureResult(reason, [...result.warnings, ...detail], result.coverage);
    return result.endReason === undefined ? failed : { ...failed, endReason: result.endReason };
  }
  const count = names.length;
  const reason = stage === "catalog"
    ? `capability discovery is partial: ${count} selected tool${count === 1 ? " is" : "s are"} no longer available in this session.`
    : `capability discovery is partial: ${count} selected tool${count === 1 ? " did" : "s did"} not become active in this session.`;
  return {
    ...retained.result,
    status: "partial",
    warnings: [...result.warnings, ...detail, reason],
  };
}

/** Interfaces the next request can supply without repeating them in this result. */
function capabilityInterfaceSources(
  active: ReadonlySet<string>,
  declaredTools: () => ReadonlySet<string>,
): CapabilityInterfaceSources {
  return {
    declared: declaredTools(),
    ...(active.has("codemode")
      ? { queryable: new Set([...active].filter((name) => name !== "codemode")) }
      : {}),
  };
}

/**
 * The internal session runs on the caller's inherited system context plus the
 * fixed retrieval addendum: same environment/conventions, fixed role and rules.
 */
function inheritedSystemPrompt(snapshot: InheritedSnapshot): string | null {
  const inherited = snapshot.systemPrompt.trim();
  return inherited === "" ? null : snapshot.systemPrompt;
}

async function openInternalSession(
  pi: ExtensionAPI,
  service: { readonly agentDir: string },
  ctx: ExtensionToolContext,
  request: CapabilityOpenSessionRequest,
  snapshot: InheritedSnapshot,
): Promise<CapabilityRunSession> {
  const cwd = ctx.cwd;
  const settings = internalSettings(pi, ctx.isProjectTrusted());
  const modelRuntime = parentModelRuntime(ctx.modelRegistry, "capability discovery");
  const inheritedPrompt = inheritedSystemPrompt(snapshot);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: service.agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(inheritedPrompt === null
      ? { systemPrompt: request.instructions }
      : { systemPrompt: inheritedPrompt, appendSystemPrompt: [request.instructions] }),
  });
  await resourceLoader.reload();
  const model = snapshot.model;
  const additive = supportsAdditiveResponses(model);
  const inheritedMessages: readonly ProjectionMessage[] = snapshot.entries.flatMap((entry) =>
    entry.type === "message" ? [entry.message as unknown as ProjectionMessage] : []);
  // Pi's ToolDefinition render callbacks are invariant in their parameter type;
  // the retrieval helper returns Pi-ai Tool records plus the engine's step tool.
  const customTools = (additive
    ? retrievalToolLoadout(inheritedMessages, request.customTools)
    : request.customTools) as unknown as ToolDefinition[];
  // The shared Subagent execution owns session creation, caller-abort handling,
  // budget cleanup ordering and the final session.dispose().
  const execution = await openSubagentExecution({
    cwd,
    agentDir: service.agentDir,
    settingsManager: settings,
    modelRuntime,
    ...(model ? { model } : {}),
    thinkingLevel: additive ? (snapshot.thinkingLevel ?? "low") : "low",
    sessionManager: SessionManager.inMemory(cwd, {}, [...snapshot.entries]),
    resourceLoader,
    customTools,
    tools: customTools.map((tool) => tool.name),
  }, request.signal === undefined ? {} : { signal: request.signal });
  try {
    const session = execution.session;
    // The blocked placeholders retain interfaces only; they never call parent tools.
    const previousTransform = session.agent.transformContext;
    const available = createEligibleToolCatalog(pi).names;
    session.agent.transformContext = async (messages, signal) => {
      const transformed = previousTransform ? await previousTransform(messages, signal) : messages;
      const projectedInput = transformed as unknown as readonly ProjectionMessage[];
      const remembered = capabilityPromptTranscript(projectedInput, snapshot.entries, {
        allowsTool: (name) => available.has(name),
      });
      const withAddendum = additive
        ? [...additiveToolTranscript(remembered), {
            role: "system" as const,
            content: policyPrompt.additiveExecutionBlocked,
            timestamp: 0,
          }]
        : remembered;
      return withAddendum as unknown as AgentMessage[];
    };
    const cleanupBudget = installModelCallBudget(session, request.budget, {
      ...(request.beforeRequest === undefined ? {} : { beforeRequest: request.beforeRequest }),
      warningText: capabilityBudgetWarning,
    });
    // Registered with the shared lifetime, so the budget hook is restored even
    // when a later step fails and the execution is disposed by this function.
    execution.addCleanup(cleanupBudget);
    // Messages the inherited context already carried never count as this run's
    // output; only what the run appends from here does.
    const inheritedMessageSet = new Set(session.state?.messages ?? []);
    return {
      async prompt(text: string): Promise<readonly AgentMessage[]> {
        await execution.prompt(text, { expandPromptTemplates: false });
        return (session.state?.messages ?? []).filter((message) => !inheritedMessageSet.has(message));
      },
      abort: () => execution.abort(),
      dispose: () => execution.dispose(),
    };
  } catch (error) {
    // Creation succeeded, so this function owns the cleanup of the partially
    // assembled retrieval session; never leak it on a failed post-setup check.
    try {
      await execution.dispose();
    } catch {
      // Preserve the original failure; cleanup errors do not replace it.
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
