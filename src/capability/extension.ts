/**
 * Capability Pi extension.
 *
 * Adds the no-argument `capability` tool to a session. A call runs an isolated
 * internal retrieval session owned by CapabilityManager. SDK execution cleanup
 * and budget primitives are shared with public delegation. Only
 * `capability_step` may execute; supported Responses
 * and Anthropic transports, and explicitly enabled Completions endpoints, retain
 * blocked parent declarations, never parent handles;
 * the run has its own fixed budget. The session inherits the caller's native
 * conversation, system prompt, physical model and thinking level, so returned
 * content such as thinking signatures survives verbatim. The tool returns full
 * grouped metadata in details and a compact
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
 * entry (see ./discovery-record.ts) before this tool activates
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
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  CAPABILITY_PARAMETERS,
  CAPABILITY_TOOL_DESCRIPTION,
  CAPABILITY_TOOL_NAME,
} from "./contracts.ts";
import { createCapabilityBroker, type CapabilityProviders, type CapabilitySearchHit } from "./broker.ts";
import { harnessConfigFor, type HarnessConfig } from "../harness-config.ts";
import {
  capabilityFailureResult,
  createCapabilityDiscovery,
  type CapabilityDiscoveryResult,
} from "./agent.ts";
import { promptString, promptStrings } from "../prompt-text.ts";

import { captureInheritedContext } from "../inherited-context.ts";
import { discoverSessionSkills } from "./skills.ts";
import { capabilityPublicResult } from "./result.ts";
import { capabilityPromptSections } from "./prompt.ts";
import { projectedNamespaceRefs, registeredToolGuidance, toolNamespaceInstructions } from "./tool-instructions.ts";
import { capabilityPruneSections } from './compaction-context.ts';
import { recordCompactionPruning } from './pruning.ts';
import { appendDiscoveryRecord } from "./discovery-record.ts";
import { installNativeDiscoveryBoundary } from "./native-discovery.ts";
import { createEligibleToolCatalog, retainSelectedToolMembers, retainReachableSelectedTools, supplySelectedToolInterfaces } from "./tool-catalog.ts";
import { activateToolNames, codemodeAvailable, toolReachability } from "./activation.ts";
import { activeToolsAfterDisabled, createToolPermissionResolver, noticedToolPermissionNames } from "./tool-permission.ts";
import type { ToolGuidance } from "../tool-guidance.ts";
import { argumentCompletionProvider } from "../autocomplete.ts";
import { installCapabilityCommand } from "./command.ts";
import { hasPresetBaseToolRemoval, restorePresetSnapshot } from "../preset/state.ts";
import { createToolAdmission, isMcpExecutionTool } from "./admission.ts";
import { setCapabilityPermissionDefaults } from "./scope.ts";
import { renderCurrentToolGuidance } from "../tool-guidance.ts";
import {
  applySystemPromptSections,
  HARNESS_CONTEXT_SYNC_CUSTOM_TYPE,
  renderCustomContextSync,
} from "../request-instructions.ts";
import { appendSessionTranscript } from "../session-transcript.ts";
import {
  capabilityModelResult, capabilityToolDelta, type CapabilityInterfaceSources,
} from "./model-result.ts";
import { openInternalSession } from "./session.ts";
import { CapabilityManager } from "./manager.ts";
import { lazySchemasActive, matchesLazySchemaRef, parseLazySchemaRefs } from "./lazy-schemas.ts";

const toolsPrompt = readToolsPrompt();

interface CapabilityToolsPrompt {
  readonly capability: {
    readonly snippet: string;
    readonly guidelines: readonly string[];
  };
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

function readToolsPrompt(): CapabilityToolsPrompt {
  return { capability: {
    snippet: promptString("capability-tools.json", "capability", "snippet"),
    guidelines: promptStrings("capability-tools.json", "capability", "guidelines"),
  } };
}

export default function capabilityExtension(
  pi: ExtensionAPI,
  { discovery = true, config }: { discovery?: boolean; config?: HarnessConfig } = {},
): void {
  const configFor = harnessConfigFor(pi, config);
  const manager = new CapabilityManager();
  pi.on("session_before_switch", () => manager.invalidate());
  pi.on("session_before_fork", () => manager.invalidate());
  pi.on("session_before_tree", () => manager.invalidate());
  pi.on("session_shutdown", () => manager.dispose());
  const declaredTools = installNativeDiscoveryBoundary(pi, configFor);
  /**
   * Publish the configured manual-tool policy on this surface. The root sets it
   * once per session; a child surface reads the root's policy through the scope
   * chain, so a manual tool never becomes eligible below Main.
   */
  const applyPermissionDefaults = (patterns: readonly string[]): void => {
    setCapabilityPermissionDefaults(pi, patterns);
  };
  if (config !== undefined) applyPermissionDefaults(config.capability.manualTools);
  installCapabilityCommand(pi, { prepare: (ctx) => applyPermissionDefaults(configFor(ctx).capability.manualTools) });
  let autocompleteInstalled = false;
  const service = {
    agentDir: getAgentDir(),
    projectTrusted: false,
  };
  pi.on("session_start", (_event, ctx) => {
    service.projectTrusted = ctx.isProjectTrusted();
    applyPermissionDefaults(configFor(ctx).capability.manualTools);
    // The editor's Tab request skips slash-command arguments; this wrapper only
    // restores them for /capability (see argumentCompletionProvider).
    if (!autocompleteInstalled) {
      autocompleteInstalled = true;
      ctx.ui.addAutocompleteProvider((base) => argumentCompletionProvider(base, "capability"));
    }
  });

  // Keep Pi's loaded Skill inventory for discovery, but do not advertise it
  // eagerly in the base prompt. Dynamic Harness sections are written onto
  // `event.systemPromptOptions.sections` so the SDK diffs and persists them
  // before the user message (no trailing developer message).
  let inLoop = false;
  let afterAgentEnd = false;
  let generation = 0;
  let lastSyncedSectionsKey = "";
  let lastSyncedToolsKey = "";
  const ownedSectionKeys = new Set<string>();

  const resetRunTracking = (): void => {
    inLoop = false;
    afterAgentEnd = false;
    generation += 1;
    lastSyncedSectionsKey = "";
    lastSyncedToolsKey = "";
  };

  const computeCurrentState = (
    branch: readonly SessionEntry[],
  ): {
    readonly sections: Record<string, string>;
    readonly sectionsKey: string;
    readonly toolsKey: string;
  } => {
    const permission = createToolPermissionResolver(pi, null, branch);
    const catalog = createEligibleToolCatalog(pi, {
      blocked: (tool) => permission.disabledFor(tool),
    });
    const available = catalog.names;
    const admission = createToolAdmission(pi, branch, catalog);
    const active = pi.getActiveTools();
    const callable = new Set(active.filter(admission.admits));
    const declared = declaredTools();
    const guidance: ToolGuidance[] = [...registeredToolGuidance(catalog.tools, [], callable, declared)];
    const permissionDisabled = permissionDisabledGuidance(pi, branch);
    if (permissionDisabled !== null) guidance.push(permissionDisabled);
    const guidanceSections = renderCurrentToolGuidance(guidance);
    const memory = capabilityPromptSections(branch, {
      allowsTool: (name) => available.has(name),
      instructions: toolNamespaceInstructions(catalog.tools),
      nativeGuidanceRefs: projectedNamespaceRefs(guidance, catalog.tools, guidanceSections, declared, callable),
    });
    const prune = capabilityPruneSections(branch);
    const sections: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...guidanceSections, ...memory, ...prune })) {
      if (typeof value === "string" && value.trim().length > 0) sections[key] = value;
    }
    const sectionsKey = JSON.stringify(
      Object.entries(sections).sort(([left], [right]) => left.localeCompare(right)),
    );
    const toolsKey = JSON.stringify({
      active: [...active],
      declared: [...declared].sort(),
    });
    return { sections, sectionsKey, toolsKey };
  };

  pi.on("session_start", resetRunTracking);
  pi.on("session_before_switch", resetRunTracking);
  pi.on("session_tree", resetRunTracking);
  pi.on("session_shutdown", resetRunTracking);

  pi.on("agent_start", () => {
    inLoop = true;
    afterAgentEnd = false;
  });
  pi.on("agent_end", () => {
    inLoop = false;
    afterAgentEnd = true;
  });
  pi.on("agent_settled", () => {
    inLoop = false;
    afterAgentEnd = false;
    generation += 1;
  });

  pi.on("before_agent_start", (event, ctx) => {
    event.systemPromptOptions.skills = [];
    const { sections, sectionsKey, toolsKey } = computeCurrentState(ctx.sessionManager.getBranch());
    applySystemPromptSections(event.systemPromptOptions.sections ??= {}, sections, ownedSectionKeys);
    ownedSectionKeys.clear();
    for (const key of Object.keys(sections)) ownedSectionKeys.add(key);
    lastSyncedSectionsKey = sectionsKey;
    lastSyncedToolsKey = toolsKey;
  });

  const emitMidRunBoundarySync = (ctx: ExtensionContext, options?: { force?: boolean }): void => {
    if (ctx.signal?.aborted) return;
    const expectedGeneration = generation;
    const { sections, sectionsKey, toolsKey } = computeCurrentState(ctx.sessionManager.getBranch());
    const stateChanged = sectionsKey !== lastSyncedSectionsKey || toolsKey !== lastSyncedToolsKey;
    if (!options?.force && !stateChanged) return;
    if (options?.force && Object.keys(sections).length === 0 && toolsKey === lastSyncedToolsKey) return;
    const summary = toolsKey !== lastSyncedToolsKey
      ? "Active tool declarations updated for the current session state."
      : undefined;
    const content = renderCustomContextSync(sections, summary);
    if (content === null) return;
    if (generation !== expectedGeneration || ctx.signal?.aborted) return;
    lastSyncedSectionsKey = sectionsKey;
    lastSyncedToolsKey = toolsKey;
    // During an active streaming turn, steer queues the sync cleanly before the
    // next model call; when idle (overflow/queued-continuation post-run compaction),
    // append without triggerTurn because AgentSession.continue() follows immediately.
    if (!ctx.isIdle()) {
      pi.sendMessage(
        { customType: HARNESS_CONTEXT_SYNC_CUSTOM_TYPE, content, display: false },
        { triggerTurn: true, deliverAs: "steer" },
      );
    } else if (options?.force) {
      pi.sendMessage(
        { customType: HARNESS_CONTEXT_SYNC_CUSTOM_TYPE, content, display: false },
        { triggerTurn: false },
      );
    }
  };

  pi.on("tool_result", (event, ctx) => {
    // Coalesce nested `ctx.executeTool("capability", ...)` calls onto the
    // outer top-level tool boundary so one tool execution emits at most one
    // persisted user sync message even when multiple inner discoveries run.
    if (event.parentToolCallId !== undefined) return;
    if (!inLoop || ctx.isIdle() || ctx.signal?.aborted) return;
    emitMidRunBoundarySync(ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    // This entry owns declaration/activation; the shared admission view owns the
    // common rule (scope, MCP selection, three-state permission).
    const tool = pi.getAllTools().find((entry) => entry.name === event.toolName);
    if (!tool || (!pi.getActiveTools().includes(event.toolName) && !["codemode", "deferred"].includes(tool.exposure ?? ""))) {
      return { block: true, reason: `Tool ${event.toolName} is unavailable in this session; retained declarations do not enable execution.` };
    }
    const admission = createToolAdmission(pi, ctx.sessionManager.getBranch());
    if (admission.disabled(event.toolName)) {
      return { block: true, reason: `Tool ${event.toolName} is disabled by the tool permission.` };
    }
    // MCP execution keeps its dedicated selection/server check in
    // native-discovery.ts; every other tool also has to pass current scope
    // qualification on this call.
    if (!isMcpExecutionTool(event.toolName) && !admission.admits(event.toolName)) {
      return { block: true, reason: `Tool ${event.toolName} is not permitted in this session scope.` };
    }
    return undefined;
  });

  pi.on('session_compact', (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    // Directed disabled removal at a successful compaction is independent of
    // `pruneOnCompaction`: a still-disabled tool loses its active slot here,
    // whether or not it was used in the window. This is the deferred half of an
    // independent declaration; a Codemode-only member was removed when the
    // permission was set.
    const current = pi.getActiveTools();
    const kept = activeToolsAfterDisabled(pi, branch, current);
    if (kept.length !== current.length) pi.setActiveTools(kept);
    // The active branch identifies the boundary even when summaries repeat.
    const checkpointId = branch.findLast(entry => entry.type === 'compaction')!.id;
    if (configFor(ctx).capability.pruneOnCompaction || hasPresetBaseToolRemoval(branch, checkpointId)) {
      // A preset's stable selection replaces the Settings baseline. Dynamic
      // Capability tools retained during a switch remain eligible for pruning.
      const protectedTools = new Set(restorePresetSnapshot(branch)?.tools
        ?? SettingsManager.inMemory(pi.getSettings()).getDefaultTools()
        ?? ['read', 'bash', 'edit', 'write']);
      // Keep discovery and its indirect execution path available for recovery.
      protectedTools.add('capability');
      protectedTools.add('codemode');
      // An explicit enable is a user decision and outranks the prune heuristic;
      // the old manual protection contract carries over to the unified record.
      const allTools = pi.getAllTools();
      const permission = createToolPermissionResolver(pi, allTools, branch);
      for (const tool of allTools) {
        if (permission.enabled(tool.name)) protectedTools.add(tool.name);
      }
      // A tool whose current permission is disabled must keep that prohibition;
      // pruning it back to "rediscoverable" would contradict the disabled notice.
      const excludedTools = allTools
        .filter((tool) => permission.disabled(tool.name))
        .map((tool) => tool.name);
      const pruning = recordCompactionPruning(pi, {
        branch, checkpointId, protectedTools, excludedTools,
      });
      if (pruning?.removedTools.length) {
        const removed = new Set(pruning.removedTools);
        pi.setActiveTools(pi.getActiveTools().filter(name => !removed.has(name)));
      }
    }
    if ((inLoop && event.reason !== "manual") || (afterAgentEnd && (event.willRetry === true || ctx.hasPendingMessages()))) {
      // Mid-run / continuation auto-compaction can evict earlier mid-run
      // `harness-context-sync` messages while `systemPromptOptions.sections` still
      // holds pre-run sections and state/tools did not change at compaction time.
      // Force resynchronization of current non-empty state for the upcoming turn.
      emitMidRunBoundarySync(ctx, { force: true });
    }
  });

  if (!discovery) return;
  pi.registerTool({
    name: CAPABILITY_TOOL_NAME,
    label: "Capability",
    description: CAPABILITY_TOOL_DESCRIPTION,
    promptSnippet: toolsPrompt.capability.snippet,
    promptGuidelines: [...toolsPrompt.capability.guidelines],
    parameters: CAPABILITY_PARAMETERS,
    async execute(toolCallId, _params, callerSignal, _onUpdate, ctx) {
      return manager.run([callerSignal, ctx.signal], async signal => {
        let result: CapabilityDiscoveryResult;
        let interfaceSources: CapabilityInterfaceSources | null = null;
        let previouslyActive = new Set<string>();
        try {
          service.projectTrusted = ctx.isProjectTrusted();
          const config = configFor(ctx);
          const lazyNames = lazyGroupMemberNames(pi, config, ctx.sessionManager.getBranch());
          const snapshot = captureInheritedContext(pi, ctx, toolCallId);
          const engine = createCapabilityDiscovery({
            broker: createCapabilityBroker(createProviders(pi, service, () => ctx.sessionManager.getBranch()), config.capability.search),
            openSession: (request) => openInternalSession(pi, service, ctx, request, snapshot, lazyNames),
            budget: config.capability.budget,
            noSelectionLimit: config.capability.noSelectionLimit,
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
            // Reachability is judged against the live session before the record is
            // written, so a selected tool whose only call path is Codemode is never
            // recorded as available while Codemode is disabled.
            if (result.status !== "failed") {
              result = retainReachableTools(pi, result);
            }
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
              const branch = ctx.sessionManager.getBranch();
              const activation = activateSelectedTools(pi, result, branch);
              const permission = createToolPermissionResolver(pi, pi.getAllTools(), branch);
              const eligible = createEligibleToolCatalog(pi, {
                disabled: (name) => permission.disabled(name),
              }).names;
              // Publication follows what is actually active, not what the search
              // hoped to activate. This is a synchronous read of the SDK's state,
              // not a rollback path.
              result = retainSelectedTools(pi, result, "activation", activation.active);
              if (activation.warnings.length > 0) {
                result = withOuterWarnings(result, activation.warnings);
              }
              interfaceSources = capabilityInterfaceSources(
                activation.active, declaredTools, eligible.has("codemode"),
                lazySelectedNames(pi, config, activation.active, ctx.sessionManager.getBranch()),
              );
            } catch (error) {
              const active = new Set(pi.getActiveTools());
              const eligible = createEligibleToolCatalog(pi).names;
              result = retainSelectedTools(pi, result, "activation", new Set([...active].filter(name => eligible.has(name))));
              result = withOuterWarnings(result, [`selected tools could not be activated: ${errorMessage(error)}`]);
            }
          } else if (result.status !== "failed") {
            result = cancelledBeforePublication(result);
          }
        } catch (error) {
          result = capabilityFailureResult(`capability discovery failed: ${errorMessage(error)}.`);
        }
        result = appendLazyModelOnlyAdvisory(pi, configFor(ctx), result, ctx.sessionManager.getBranch());
        if (result.unavailable !== undefined && result.unavailable.length > 0
            && (result.status === "partial" || result.status === "failed")) {
          const names = result.unavailable.map((entry) => entry.name);
          ctx.ui.notify(
            `Capability: ${names.length} selected tool${names.length === 1 ? "" : "s"} could not be enabled in this session: ${names.join(", ")}.`,
            "warning",
          );
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
      });
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

function permissionDisabledGuidance(host: ExtensionAPI, branch: readonly unknown[]): ToolGuidance | null {
  const noticed = noticedToolPermissionNames(branch);
  if (noticed.size === 0) return null;
  const permission = createToolPermissionResolver(host, host.getAllTools(), branch);
  const names = [...noticed].filter((name) => permission.disabled(name)).sort();
  if (names.length === 0) return null;
  const text = promptString('capability-policy.json', 'toolPermissionDisabled')
    .replace('{tools}', names.map((name) => `- ${name}`).join('\n'));
  return {
    id: 'tool-permission:disabled',
    tools: names,
    text,
    eligible: true,
  };
}

function createProviders(
  pi: ExtensionAPI,
  service: { readonly agentDir: string; readonly projectTrusted: boolean },
  branch: () => readonly unknown[] | null,
): CapabilityProviders {
  return {
    // A disabled tool never becomes a discovery candidate. The branch is read
    // now so a rule added after the picker opened is honoured.
    listTools: () => {
      const permission = createToolPermissionResolver(pi, null, branch());
      return createEligibleToolCatalog(pi).tools.filter((tool) => !permission.disabledFor(tool));
    },
    listActiveTools: () => pi.getActiveTools(),
    discoverSkills: (cwd: string) => discoverSessionSkills(pi, {
      cwd,
      agentDir: service.agentDir,
      projectTrusted: service.projectTrusted,
    }),
    readSkillFile: (filePath: string) => readFile(filePath, "utf8"),
  };
}

/**
 * Declare the selected, already-registered tools active in this session.
 *
 * The per-name activation is shared with cross-session reply-tool loading
 * (`activation.ts`); this function only maps the discovery selection onto tool
 * names and turns the skipped names into discovery warnings. A server-level
 * `mcp://<server>` ref names no single registered tool, so only a tool ref that
 * lost its registration is reported.
 */
function activateSelectedTools(pi: ExtensionAPI, result: CapabilityDiscoveryResult, branch: readonly unknown[]): Activation {
  const selected: ActivationHit[] = [];
  for (const hit of [...result.tools, ...result.mcp]) {
    if (Array.isArray(hit.tools)) selected.push(...hit.tools);
    else selected.push(hit);
  }
  const named = selected.flatMap((hit) => typeof hit.name === "string" && hit.name !== "" ? [{ name: hit.name, kind: hit.kind }] : []);
  const permission = createToolPermissionResolver(pi, pi.getAllTools(), branch);
  const outcome = activateToolNames(pi, named.map((hit) => hit.name), {
    disabled: (name: string) => permission.disabled(name),
  });
  const kindOf = new Map(named.map((hit) => [hit.name, hit.kind]));
  const warnings: string[] = [];
  // Reuse activation's decisions, including a rejected name that was already
  // active. The SDK active set alone does not grant current scope eligibility.
  const active = new Set(outcome.active);
  for (const skip of outcome.skipped) {
    active.delete(skip.name);
    if (skip.reason === "not_registered" && kindOf.get(skip.name) === "tool") {
      warnings.push(`selected tool "${skip.name}" is not registered in this session`);
    }
    if (skip.reason === "hidden") warnings.push(`selected tool "${skip.name}" is hidden and cannot be activated`);
    if (skip.reason === "disabled") warnings.push(`selected tool "${skip.name}" is disabled by the tool permission`);
    if (skip.reason === "unreachable") warnings.push(`selected tool "${skip.name}" has no usable call path because Codemode is not enabled in this session`);
  }
  return { activated: outcome.activated, warnings, active };
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
  const retained = retainSelectedToolMembers(
    result,
    active ?? createEligibleToolCatalog(pi).names,
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

/**
 * Drop selected tool members this session has no execution entry for.
 *
 * A deferred/direct tool becomes callable when activated, but a `codemode`
 * -exposure tool can only be reached from a script. If Codemode is disabled or
 * ineligible, activating such a member would publish a tool the model cannot
 * call. The rejection happens before the discovery record is written, so an
 * unreachable member is never remembered as available. Successful Skills are
 * independent and stay published; losing every tool while keeping no Skill
 * fails closed.
 */
function retainReachableTools(pi: ExtensionAPI, result: CapabilityDiscoveryResult): CapabilityDiscoveryResult {
  if (result.status === "failed") return result;
  const context = { codemodeAvailable: codemodeAvailable(pi) };
  const retained = retainReachableSelectedTools(
    result, pi, (tool) => toolReachability(tool.exposure, context) === null,
  );
  const names = [...new Set(retained.dropped)];
  if (names.length === 0) return result;
  const unavailable = names.map((name) => ({ name, reason: "it needs an enabled Codemode entry in this session, but Codemode is not enabled" }));
  const detail = names.map((name) =>
    `selected tool "${name}" has no usable call path because Codemode is not enabled in this session; it was not published.`);
  const keptTools = countToolMembers(retained.result.tools) + countToolMembers(retained.result.mcp);
  if (keptTools === 0 && result.skills.length === 0) {
    const reason = names.length === 1
      ? `capability discovery failed: the selected tool "${names[0]}" has no usable call path because Codemode is not enabled in this session.`
      : `capability discovery failed: none of the ${names.length} selected tools has a usable call path because Codemode is not enabled in this session.`;
    const failed = capabilityFailureResult(reason, [...result.warnings, ...detail], result.coverage);
    return result.endReason === undefined ? { ...failed, unavailable } : { ...failed, endReason: result.endReason, unavailable };
  }
  const count = names.length;
  return {
    ...retained.result,
    status: "partial",
    warnings: [...result.warnings, ...detail,
      `capability discovery is partial: ${count} selected tool${count === 1 ? " has" : "s have"} no usable call path in this session.`],
    unavailable,
  };
}

/** Count selected tool members across hits; a nameless identity does not count. */
function countToolMembers(hits: readonly CapabilitySearchHit[]): number {
  let total = 0;
  for (const hit of hits) {
    if (Array.isArray(hit.tools)) total += hit.tools.length;
    else total += 1;
  }
  return total;
}

/**
 * Report lazySchemas groups whose selected member is model-only.
 *
 * A model-only tool is declared to the model and called directly, but it can
 * never be nested through Codemode. Lazy projection must not hide its
 * declaration, so the member keeps its native declaration and the detail record
 * says the lazy interface does not apply. Advisory only: the result status and
 * the published members are unchanged.
 */
function appendLazyModelOnlyAdvisory(
  pi: ExtensionAPI,
  config: HarnessConfig,
  result: CapabilityDiscoveryResult,
  branch: readonly unknown[] | null,
): CapabilityDiscoveryResult {
  if (result.status === "failed") return result;
  const refs = parseLazySchemaRefs(config.capability.lazySchemas);
  if (refs.empty || !lazySchemasActive(pi, branch)) return result;
  const all = pi.getAllTools();
  const names = new Set<string>();
  for (const hit of [...result.tools, ...result.mcp]) {
    if (Array.isArray(hit.tools)) {
      for (const member of hit.tools) if (typeof member.name === "string") names.add(member.name);
    } else if (typeof hit.name === "string") {
      names.add(hit.name);
    }
  }
  const blocked = [...names].filter((name) => {
    const tool = all.find((entry) => entry.name === name);
    if (tool === undefined) return false;
    return tool.exposure === "model-only" && matchesLazySchemaRef(refs, name, tool.namespace);
  });
  if (blocked.length === 0) return result;
  return {
    ...result,
    warnings: [...result.warnings,
      `lazySchemas matches model-only tool(s) ${blocked.join(", ")} that cannot be called through Codemode; their declarations are kept.`],
  };
}

/** Interfaces the next request can supply without repeating them in this result. */
function capabilityInterfaceSources(
  active: ReadonlySet<string>,
  declaredTools: () => ReadonlySet<string>,
  codemodeAllowed: boolean,
  lazyNames?: ReadonlySet<string> | undefined,
): CapabilityInterfaceSources {
  return {
    declared: declaredTools(),
    ...(active.has("codemode") && codemodeAllowed
      ? { queryable: new Set([...active].filter((name) => name !== "codemode")) }
      : {}),
    ...(lazyNames === undefined ? {} : { lazyNames }),
  };
}

/**
 * Selected, active members of a configured lazy group while the lazy projection
 * is live. Their names stay in the compact model result because the schemas are
 * withheld from every declaration.
 */
function lazySelectedNames(
  pi: ExtensionAPI,
  config: HarnessConfig,
  active: ReadonlySet<string>,
  branch: readonly unknown[] | null,
): ReadonlySet<string> | undefined {
  if (!lazySchemasActive(pi, branch)) return undefined;
  const refs = parseLazySchemaRefs(config.capability.lazySchemas);
  if (refs.empty) return undefined;
  const names = new Set<string>();
  for (const tool of pi.getAllTools()) {
    if (active.has(tool.name) && matchesLazySchemaRef(refs, tool.name, tool.namespace)) names.add(tool.name);
  }
  return names.size === 0 ? undefined : names;
}

/** Every registered member of a configured lazy group while the projection is live. */
function lazyGroupMemberNames(
  pi: ExtensionAPI,
  config: HarnessConfig,
  branch: readonly unknown[] | null,
): ReadonlySet<string> {
  if (!lazySchemasActive(pi, branch)) return new Set();
  const refs = parseLazySchemaRefs(config.capability.lazySchemas);
  if (refs.empty) return new Set();
  const names = new Set<string>();
  for (const tool of pi.getAllTools()) {
    if (matchesLazySchemaRef(refs, tool.name, tool.namespace)) names.add(tool.name);
  }
  return names;
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
