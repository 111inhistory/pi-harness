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
import {
  CAPABILITY_SECTION,
  capabilityPromptSections,
  composeCapabilitiesSnapshot,
} from "./prompt.ts";
import { projectedNamespaceRefs, registeredToolGuidance, toolNamespaceInstructions, withheldToolGuidance } from "./tool-instructions.ts";
import { capabilityPruneNoticeText } from './compaction-context.ts';
import { recordCompactionPruning } from './pruning.ts';
import { appendDiscoveryRecord, discoveryRecords } from "./discovery-record.ts";
import { installNativeDiscoveryBoundary } from "./native-discovery.ts";
import { createEligibleToolCatalog, retainSelectedToolMembers, retainReachableSelectedTools, supplySelectedToolInterfaces } from "./tool-catalog.ts";
import { activateToolNames, codemodeAvailable, toolReachability } from "./activation.ts";
import {
  activateToolTargets,
  activeToolsAfterCollections,
  blacklistedNoticeNames,
  ensureToolBase,
  sessionBaseNames,
  syncActiveToolsForBranch,
} from "./tool-access.ts";
import { clipText } from '../text-output.ts';
import { createToolAccessView, listBaseTools, listLoadedContainers } from "./tool-access-view.ts";
import type { ToolGuidance } from "../tool-guidance.ts";
import { argumentCompletionProvider } from "../autocomplete.ts";
import { installCapabilityCommand } from "./command.ts";
import { hasPresetBaseToolRemoval } from "../preset/state.ts";
import { createToolAdmission, isMcpExecutionTool } from "./admission.ts";
import { setCapabilityStartupBlacklist } from "./scope.ts";
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
import { lazySchemasActive, matchesLazySchemaRef, parseLazySchemaRefs, planNoSchema } from "./lazy-schemas.ts";

const toolsPrompt = readToolsPrompt();
const CAPABILITY_RULES_SECTION = 'capability-rules';

function guidanceSection(id: string): string {
  return /^(namespace|tool):[a-z0-9_-]+$/.test(id) || id === 'capability-blacklisted'
    ? `capability-guide-${id.replace(':', '-')}`
    : `capability-guide-encoded-${Buffer.from(id).toString('hex')}`;
}

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

export interface CapabilityHookPort {
  snapshot(ctx: Pick<ExtensionContext, 'sessionManager'>): {
    readonly branchEpoch: number;
    readonly active: ReturnType<ExtensionAPI['getAllTools']>;
    readonly activatable: ReturnType<ExtensionAPI['getAllTools']>;
  };
  /** A stale or unavailable operation has no effect and returns undefined. */
  activate(ctx: Pick<ExtensionContext, 'sessionManager'>, request: {
    readonly branchEpoch: number; readonly targets: readonly string[]; readonly signal?: AbortSignal;
  }): ReturnType<typeof activateToolTargets> | undefined;
  discover(ctx: ExtensionContext, request: {
    readonly branchEpoch: number; readonly seed: string; readonly signal?: AbortSignal;
  }): Promise<'published' | 'empty' | 'failed' | 'suppressed' | 'cancelled'>;
}

function readToolsPrompt(): CapabilityToolsPrompt {
  return { capability: {
    snippet: promptString("capability-tools.json", "capability", "snippet"),
    guidelines: promptStrings("capability-tools.json", "capability", "guidelines"),
  } };
}

export default function capabilityExtension(
  pi: ExtensionAPI,
  { discovery = true, config }: { discovery?: boolean; config?: HarnessConfig } = {},
): CapabilityHookPort {
  const configFor = harnessConfigFor(pi, config);
  const manager = new CapabilityManager();
  let branchEpoch = 0;
  let closed = false;
  let background: AbortController | undefined;
  let explicitRuns = 0;
  const invalidateBranch = (): void => {
    branchEpoch += 1;
    manager.invalidate();
  };
  pi.on("session_before_switch", invalidateBranch);
  pi.on("session_before_fork", invalidateBranch);
  pi.on("session_before_tree", invalidateBranch);
  pi.on("session_shutdown", () => {
    closed = true;
    invalidateBranch();
    manager.dispose();
  });
  const declaredTools = installNativeDiscoveryBoundary(pi, configFor);
  /**
   * Publish the configured blacklist on this surface as the `startup` source.
   * The root sets it once per session; a child surface reads the root's policy
   * through the scope chain, so a configured prohibition never becomes usable
   * below Main.
   */
  const applyStartupBlacklist = (patterns: readonly string[]): void => {
    setCapabilityStartupBlacklist(pi, patterns);
  };
  if (config !== undefined) applyStartupBlacklist(config.capability.blacklist);
  installCapabilityCommand(pi, {
    prepare: (ctx) => applyStartupBlacklist(configFor(ctx).capability.blacklist),
    schemaRefs: (ctx) => configFor(ctx).capability.lazySchemas,
  });
  let autocompleteInstalled = false;
  const agentDir = getAgentDir();
  pi.on("session_start", (_event, ctx) => {
    invalidateBranch();
    applyStartupBlacklist(configFor(ctx).capability.blacklist);
    // Capture the availability baseline once. A resumed branch already records
    // it, so the historical base is never rebuilt from the current active set.
    // A failed append is reported, never treated as a captured baseline.
    try {
      ensureToolBase(pi, pi, ctx.sessionManager.getBranch());
    } catch (error) {
      ctx.ui.notify(`Capability: the tool baseline could not be recorded: ${error instanceof Error ? error.message : String(error)}. Base-list changes are unavailable until it can be written.`, "error");
    }
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
  let lastSyncedSections: Readonly<Record<string, string>> = {};
  let lastSyncedToolsKey = "";
  let lastCustomPrompt = false;
  const resetRunTracking = (): void => {
    inLoop = false;
    afterAgentEnd = false;
    generation += 1;
    lastSyncedSections = {};
    lastSyncedToolsKey = "";
    lastCustomPrompt = false;
  };

  const computeCurrentState = (
    branch: readonly SessionEntry[],
    ctx: ExtensionContext,
  ): {
    readonly sections: Record<string, string>;
    readonly toolsKey: string;
  } => {
    const access = createToolAccessView(pi, branch);
    const catalog = createEligibleToolCatalog(pi, {
      blocked: (tool) => access.blocked(tool.name),
    });
    const available = catalog.names;
    const admission = createToolAdmission(pi, branch, catalog);
    const active = pi.getActiveTools();
    const callable = new Set(active.filter(admission.admits));
    const plan = planNoSchema({
      host: pi,
      branch,
      refs: configFor(ctx).capability.lazySchemas,
      selection: { mode: (name) => access.schemaMode(name) },
      tools: catalog.tools,
      codemodeUsable: active.includes('codemode') && catalog.names.has('codemode'),
    });
    // Withheld declarations are not native declarations: dropping them here is
    // what lets the canonical namespace guide render exactly once.
    const declared = new Set([...declaredTools()].filter((name) => !plan.withheld.has(name)));
    const nativeRulesRendered = !lastCustomPrompt;
    const guidance: ToolGuidance[] = [
      ...registeredToolGuidance(catalog.tools, [], callable, declared, access.loadedContainers, plan.withheld, nativeRulesRendered),
      ...withheldToolGuidance(catalog.tools, plan.withheld),
    ];
    const blacklistGuidance = blacklistedGuidance(pi, branch);
    if (blacklistGuidance !== null) guidance.push(blacklistGuidance);
    const memory = capabilityPromptSections(branch, {
      allowsTool: (name) => available.has(name),
      instructions: toolNamespaceInstructions(catalog.tools),
      nativeGuidanceRefs: projectedNamespaceRefs(guidance, catalog.tools, declared, callable, nativeRulesRendered),
    });
    const pruneText = capabilityPruneNoticeText(branch);
    const snapshot = composeCapabilitiesSnapshot([memory[CAPABILITY_SECTION], pruneText]);
    const sections: Record<string, string> = {};
    for (const entry of guidance) {
      if (entry.eligible !== false && entry.tools.length > 0 && entry.text.trim().length > 0) {
        sections[guidanceSection(entry.id)] = entry.text;
      }
    }
    const snapshotText = snapshot[CAPABILITY_SECTION];
    if (typeof snapshotText === "string" && snapshotText.trim().length > 0) {
      sections[CAPABILITY_SECTION] = snapshotText;
    }
    const toolsKey = JSON.stringify({
      active: [...active],
      declared: [...declared].sort(),
    });
    return { sections, toolsKey };
  };

  pi.on("session_start", resetRunTracking);
  pi.on("session_before_switch", resetRunTracking);
  pi.on("session_tree", (_event, ctx) => {
    invalidateBranch();
    resetRunTracking();
    syncActiveToolsForBranch(pi, ctx.sessionManager.getBranch());
  });
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
    lastCustomPrompt = Boolean(event.systemPromptOptions.customPrompt);
    const branch = ctx.sessionManager.getBranch();
    const { sections, toolsKey } = computeCurrentState(branch, ctx);
    const target = event.systemPromptOptions.sections ??= {};
    applySystemPromptSections(target, sections, Object.keys(target).filter(key => key === CAPABILITY_SECTION || key.startsWith('capability-guide-')));
    if (discovery && !lastCustomPrompt) {
      // Keep general usage rules stable across reloads. Dynamic guides have
      // separate sections so Pi can append just the affected resources.
      const open = `<${CAPABILITY_RULES_SECTION}>\n`;
      const close = `\n</${CAPABILITY_RULES_SECTION}>`;
      let rules = toolsPrompt.capability.guidelines.map(line => `- ${line}`).join('\n');
      for (let i = branch.length - 1; i >= 0; i -= 1) {
        const entry = branch[i];
        if (entry?.type !== 'message' || entry.message.role !== 'system') continue;
        const previous = entry.message.sections?.[CAPABILITY_RULES_SECTION];
        if (previous?.startsWith(open) && previous.endsWith(close)) {
          // SDK options take the section body; the SDK adds its tags when persisting.
          rules = previous.slice(open.length, -close.length);
          break;
        }
      }
      target[CAPABILITY_RULES_SECTION] = rules;
    } else {
      delete target[CAPABILITY_RULES_SECTION];
    }
    lastSyncedSections = sections;
    lastSyncedToolsKey = toolsKey;
  });

  const emitMidRunBoundarySync = (ctx: ExtensionContext, options?: { force?: boolean }): void => {
    if (ctx.signal?.aborted) return;
    const expectedGeneration = generation;
    const { sections, toolsKey } = computeCurrentState(ctx.sessionManager.getBranch(), ctx);
    const changed = Object.fromEntries(Object.entries(sections).filter(([key, value]) => options?.force || lastSyncedSections[key] !== value));
    const removed = Object.keys(lastSyncedSections).filter(key => !(key in sections));
    const toolsChanged = toolsKey !== lastSyncedToolsKey;
    const summaryParts: string[] = [];
    if (toolsChanged) summaryParts.push("Active tool declarations updated for the current session state.");
    if (removed.includes(CAPABILITY_SECTION)) summaryParts.push("Dynamic capability context cleared for the current session state.");
    for (const key of removed) {
      if (key !== CAPABILITY_SECTION) summaryParts.push(`Tool guidance section "${key}" was removed and no longer applies.`);
    }
    const summary = summaryParts.length > 0 ? summaryParts.join(" ") : undefined;
    const content = renderCustomContextSync(changed, summary);
    if (content === null) return;
    if (generation !== expectedGeneration || ctx.signal?.aborted) return;
    lastSyncedSections = sections;
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
    // common rule (scope, MCP selection, blacklist).
    const tool = pi.getAllTools().find((entry) => entry.name === event.toolName);
    if (!tool || (!pi.getActiveTools().includes(event.toolName) && !["codemode", "deferred"].includes(tool.exposure ?? ""))) {
      return { block: true, reason: `Tool ${event.toolName} is unavailable in this session; retained declarations do not enable execution.` };
    }
    const admission = createToolAdmission(pi, ctx.sessionManager.getBranch());
    if (admission.blocked(event.toolName)) {
      return { block: true, reason: `Tool ${event.toolName} is blacklisted in this session.` };
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
    const kept = activeToolsAfterCollections(pi, branch, current);
    if (kept.length !== current.length) pi.setActiveTools(kept);
    // The active branch identifies the boundary even when summaries repeat.
    const checkpointId = branch.findLast(entry => entry.type === 'compaction')!.id;
    const baseline = sessionBaseNames(branch);
    if (configFor(ctx).capability.pruneOnCompaction || hasPresetBaseToolRemoval(branch, checkpointId, baseline)) {
      // Base membership is the session's availability choice and always
      // survives a prune; only dynamic discovery memory is prunable.
      const protectedTools = new Set<string>(baseline);
      for (const entry of listBaseTools(pi, branch)) {
        for (const name of entry.affectedTools) protectedTools.add(name);
      }
      for (const name of SettingsManager.inMemory(pi.getSettings()).getDefaultTools() ?? ['read', 'bash', 'edit', 'write']) {
        protectedTools.add(name);
      }
      // Keep discovery and its indirect execution path available for recovery.
      protectedTools.add('capability');
      protectedTools.add('codemode');
      const allTools = pi.getAllTools();
      const access = createToolAccessView(pi, branch);
      for (const tool of allTools) {
        if (access.base(tool.name)) protectedTools.add(tool.name);
      }
      // A blacklisted tool keeps its prohibition; pruning it back to
      // "rediscoverable" would contradict the blacklist notice.
      const excludedTools = allTools
        .filter((tool) => access.blocked(tool.name))
        .map((tool) => tool.name);
      // Discovery history is cumulative; only names that are still requested
      // now can be truthfully reported as removed at this boundary.
      const availableTools = new Set(allTools
        .filter((tool) => access.requested(tool.name))
        .map((tool) => tool.name));
      const pruning = recordCompactionPruning(pi, {
        branch, checkpointId, protectedTools, excludedTools, availableTools,
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

  const runDiscovery = async (
    ctx: ExtensionContext,
    signal: AbortSignal,
    expectedEpoch: number,
    invocation: { readonly toolCallId: string } | { readonly seed: string },
  ) => {
    const isCurrent = (): boolean => !closed && branchEpoch === expectedEpoch && !signal.aborted;
    let result: CapabilityDiscoveryResult;
    let previouslyActive = new Set<string>();
    let activation: Activation | undefined;
    let published = false;
    try {
      if (!isCurrent()) return { result: cancelledBeforePublication(capabilityFailureResult('Capability discovery cancelled.')), previouslyActive, activation, published };
      const config = configFor(ctx);
      const toolCallId = 'toolCallId' in invocation ? invocation.toolCallId : undefined;
      const { cwd, modelRegistry, sessionManager } = ctx;
      const branch = () => sessionManager.getBranch();
      const lazyNames = lazyGroupMemberNames(pi, config, branch());
      const snapshot = captureInheritedContext(pi, ctx, toolCallId);
      const runService = { agentDir, projectTrusted: ctx.isProjectTrusted() };
      const engine = createCapabilityDiscovery({
        broker: createCapabilityBroker(createProviders(pi, runService, branch), config.capability.search),
        openSession: (request) => openInternalSession(pi, runService, { cwd, modelRegistry, sessionManager }, request, snapshot, lazyNames),
        budget: config.capability.budget,
        noSelectionLimit: config.capability.noSelectionLimit,
      });
      const seed = 'seed' in invocation ? invocation.seed : undefined;
      result = await engine.discover({ cwd, signal, seed });
      if (!isCurrent()) return { result: cancelledBeforePublication(result), previouslyActive, activation, published };
      const currentBranch = branch();
      const access = createToolAccessView(pi, currentBranch);
      const eligible = createEligibleToolCatalog(pi, { blocked: tool => access.blocked(tool.name) }).names;
      result = retainReachableTools(pi, retainSelectedTools(pi, result, 'catalog', eligible));
      if (result.status !== 'failed') {
        previouslyActive = new Set(pi.getActiveTools());
        if (seed !== undefined) {
          const additions = new Set([...eligible].filter(name => !previouslyActive.has(name)));
          result = backgroundDiscoveryDelta(result, currentBranch, additions);
          if (result.tools.length + result.mcp.length + result.skills.length === 0) {
            return { result, previouslyActive, activation, published };
          }
        }
        // Persist before making selected tools visible. The epoch check and
        // these synchronous mutations share one event-loop boundary.
        try {
          appendDiscoveryRecord(pi as DiscoveryRecordWriter, toolCallId, result, result.coverage);
          published = true;
        } catch (error) {
          result = discoveryNotDurable(result, error);
        }
      }
      if (published) {
        try {
          activation = activateSelectedTools(pi, result, branch());
          result = retainSelectedTools(pi, result, 'activation', activation.active);
          if (activation.warnings.length > 0) result = withOuterWarnings(result, activation.warnings);
        } catch (error) {
          result = retainSelectedTools(pi, result, 'activation', new Set(pi.getActiveTools().filter(name => eligible.has(name))));
          result = withOuterWarnings(result, [`selected tools could not be activated: ${errorMessage(error)}`]);
        }
      }
    } catch (error) {
      result = capabilityFailureResult(`capability discovery failed: ${errorMessage(error)}.`);
    }
    return { result, previouslyActive, activation, published };
  };

  const port: CapabilityHookPort = {
    snapshot(ctx) {
      const branch = ctx.sessionManager.getBranch();
      const access = createToolAccessView(pi, branch);
      const catalog = createEligibleToolCatalog(pi, { blocked: tool => access.blocked(tool.name) });
      const active = new Set(pi.getActiveTools());
      const admission = createToolAdmission(pi, branch, catalog);
      const reachability = { codemodeAvailable: codemodeAvailable(pi) };
      return {
        branchEpoch,
        active: catalog.tools.filter(tool => active.has(tool.name) && admission.admits(tool.name)),
        activatable: catalog.tools.filter(tool => !active.has(tool.name) && toolReachability(tool.exposure, reachability) === null),
      };
    },
    activate(ctx, request) {
      if (closed || branchEpoch !== request.branchEpoch || request.signal?.aborted) return undefined;
      return activateToolTargets(pi, pi, ctx.sessionManager.getBranch(), request.targets);
    },
    async discover(ctx, request) {
      if (closed || branchEpoch !== request.branchEpoch || request.signal?.aborted) return 'cancelled';
      if (!discovery || background !== undefined || explicitRuns > 0) return 'suppressed';
      const controller = new AbortController();
      background = controller;
      try {
        const clipped = clipText(request.seed, { maxLines: 80, maxBytes: 4096 }, 'head-tail');
        const { result, published } = await manager.run([controller.signal, request.signal], signal =>
          runDiscovery(ctx, signal, request.branchEpoch, { seed: clipped.text }));
        if (result.endReason === 'cancelled') return 'cancelled';
        if (result.status === 'failed') return 'failed';
        return published ? 'published' : 'empty';
      } finally {
        background = undefined;
      }
    },
  };

  if (discovery) pi.registerTool({
    name: CAPABILITY_TOOL_NAME,
    label: "Capability",
    description: CAPABILITY_TOOL_DESCRIPTION,
    promptSnippet: toolsPrompt.capability.snippet,
    parameters: CAPABILITY_PARAMETERS,
    async execute(toolCallId, _params, callerSignal, _onUpdate, ctx) {
      background?.abort();
      explicitRuns += 1;
      try {
        return await manager.run([callerSignal, ctx.signal], async signal => {
          const run = await runDiscovery(ctx, signal, branchEpoch, { toolCallId });
          const config = configFor(ctx);
          const branch = ctx.sessionManager.getBranch();
          const result = appendLazyModelOnlyAdvisory(pi, config, run.result, branch);
          if (result.unavailable !== undefined && result.unavailable.length > 0
              && (result.status === 'partial' || result.status === 'failed')) {
            const names = result.unavailable.map(entry => entry.name);
            ctx.ui.notify(`Capability: ${names.length} selected tool${names.length === 1 ? '' : 's'} could not be enabled in this session: ${names.join(', ')}.`, 'warning');
          }
          const withInterfaces = supplySelectedToolInterfaces(capabilityToolDelta(result, run.previouslyActive), pi);
          const access = createToolAccessView(pi, branch);
          const projected = run.activation === undefined ? withInterfaces : capabilityModelResult(withInterfaces, capabilityInterfaceSources(
            run.activation.active, declaredTools,
            createEligibleToolCatalog(pi, { blocked: tool => access.blocked(tool.name) }).names.has('codemode'),
            lazySelectedNames(pi, config, run.activation.active, branch),
          ));
          return {
            content: [{ type: 'text', text: JSON.stringify(capabilityPublicResult(projected)) }],
            details: result,
            isError: result.status === 'failed',
          };
        });
      } finally {
        explicitRuns -= 1;
      }
    },
  });
  return port;
}

function backgroundDiscoveryDelta(
  result: CapabilityDiscoveryResult,
  branch: readonly SessionEntry[],
  additions: ReadonlySet<string>,
): CapabilityDiscoveryResult {
  const knownRefs = new Set<string>();
  for (const { result: memory } of discoveryRecords(branch)) {
    for (const hit of [...memory.skills, ...memory.tools, ...memory.mcp]) {
      if (hit.ref !== undefined) knownRefs.add(hit.ref);
    }
  }
  const delta = retainSelectedToolMembers(result, additions).result;
  const isNew = (hit: { readonly ref?: string }): boolean => hit.ref !== undefined && !knownRefs.has(hit.ref);
  return {
    ...delta,
    tools: delta.tools.filter(hit => hit.kind === 'tool' || hit.tools?.length || isNew(hit)),
    mcp: delta.mcp.filter(hit => hit.kind === 'tool' || hit.tools?.length || isNew(hit)),
    skills: result.skills.filter(isNew),
  };
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

/**
 * Model-facing reminder for tools a blacklist notice announced and that are
 * still prohibited. The notice is only guidance; the execution guard and the
 * discovery filter read the same blacklist.
 */
function blacklistedGuidance(host: ExtensionAPI, branch: readonly unknown[]): ToolGuidance | null {
  const noticed = blacklistedNoticeNames(branch);
  if (noticed.size === 0) return null;
  const access = createToolAccessView(host, branch);
  const names = [...noticed].filter((name) => access.blocked(name)).sort();
  if (names.length === 0) return null;
  const text = promptString('capability-policy.json', 'toolBlacklisted')
    .replace('{tools}', names.map((name) => `- ${name}`).join('\n'));
  return {
    id: 'capability-blacklisted',
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
    // A blacklisted tool never becomes a discovery candidate. The branch is
    // read now so a rule added after the picker opened is honoured.
    listTools: () => {
      const access = createToolAccessView(pi, branch());
      return createEligibleToolCatalog(pi, { blocked: (tool) => access.blocked(tool.name) }).tools;
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
  const access = createToolAccessView(pi, branch);
  const outcome = activateToolNames(pi, named.map((hit) => hit.name), {
    blocked: (name: string) => access.blocked(name),
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
    if (skip.reason === "blacklisted") warnings.push(`selected tool "${skip.name}" is blacklisted in this session`);
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
  const tools = pi.getAllTools();
  const view = createToolAccessView(pi, branch, tools);
  const plan = planNoSchema({
    host: pi, branch, refs: config.capability.lazySchemas,
    selection: { mode: (name) => view.schemaMode(name) }, tools,
  });
  const names = new Set([...plan.withheld].filter((name) => active.has(name)));
  return names.size === 0 ? undefined : names;
}

/** Every registered member of a configured lazy group while the projection is live. */
function lazyGroupMemberNames(
  pi: ExtensionAPI,
  config: HarnessConfig,
  branch: readonly unknown[] | null,
): ReadonlySet<string> {
  if (!lazySchemasActive(pi, branch)) return new Set();
  const tools = pi.getAllTools();
  const view = createToolAccessView(pi, branch, tools);
  const plan = planNoSchema({
    host: pi, branch, refs: config.capability.lazySchemas,
    selection: { mode: (name) => view.schemaMode(name) }, tools,
  });
  return plan.withheld;
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
