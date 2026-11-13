/** Capability owns retrieval assembly; delegated Actor sessions are not involved. */
import { DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionToolContext, type SessionEntry, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { InheritedSnapshot } from '../inherited-context.ts';
import { openSubagentExecution } from '../subagent/execution.ts';
import { parentModelRuntime } from '../subagent/model-runtime.ts';
import { installModelCallBudget } from '../subagent/pi-job-budget.ts';
import { installSessionCacheIdentity } from '../session-cache-runtime.ts';
import { capabilityBudgetWarning, type CapabilityOpenSessionRequest, type CapabilityRunSession } from './agent.ts';
import { providerSessionPolicy } from '../provider-session.ts';
import { createToolPermissionResolver } from './tool-permission.ts';
import { createEligibleToolCatalog } from './tool-catalog.ts';
import { createToolAdmission } from './admission.ts';
import { registeredToolGuidance, projectedNamespaceRefs, toolNamespaceInstructions } from './tool-instructions.ts';
import { renderCurrentToolGuidance } from '../tool-guidance.ts';
import { CAPABILITY_SECTION, capabilityPromptSections, type ProjectionMessage } from './prompt.ts';
import { presetInstructionSections } from '../preset/instruction.ts';
import { capabilityPruneSections } from './compaction-context.ts';
import { applySystemPromptSections } from '../request-instructions.ts';
import { projectDiscoveryDeclarations } from './declarations.ts';
import { additiveToolTranscript } from '../session-transcript.ts';
import { retrievalToolLoadout } from './retrieval-tools.ts';
import { promptString } from '../prompt-text.ts';
type HarnessSettings = ReturnType<SettingsManager['getSettings']>;
const policyPrompt = { additiveExecutionBlocked: promptString('capability-policy.json', 'additiveExecutionBlocked') };
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
  let effective: Partial<HarnessSettings> | null;
  try { effective = pi.getSettings() ?? null; }
  catch { effective = null; }
  const base: Partial<HarnessSettings> = effective ?? {};
  return SettingsManager.inMemory(
    { ...base, packages: [], extensions: [], skills: [], prompts: [], themes: [] },
    { projectTrusted: trusted },
  );
}


/**
 * The internal session runs on the caller's inherited system context plus the
 * fixed retrieval addendum: same environment/conventions, fixed role and rules.
 */
function inheritedSystemPrompt(snapshot: InheritedSnapshot): string | null {
  const inherited = snapshot.systemPrompt.trim();
  return inherited === "" ? null : snapshot.systemPrompt;
}

export async function openInternalSession(
  pi: ExtensionAPI,
  service: { readonly agentDir: string },
  ctx: ExtensionToolContext,
  request: CapabilityOpenSessionRequest,
  snapshot: InheritedSnapshot,
  lazyNames: ReadonlySet<string>,
): Promise<CapabilityRunSession> {
  const cwd = ctx.cwd;
  const settings = internalSettings(pi, ctx.isProjectTrusted());
  const modelRuntime = parentModelRuntime(ctx.modelRegistry, "capability discovery");
  const inheritedPrompt = inheritedSystemPrompt(snapshot);
  const retrievalNames = new Set(request.customTools.map(tool => tool.name));
  const model = snapshot.model;
  const branch = ctx.sessionManager.getBranch();
  const permission = createToolPermissionResolver(pi, pi.getAllTools(), branch);
  // Managed tools and lazily-projected members must not travel to the retrieval
  // model: a disabled tool cannot be inherited, an explicitly enabled tool is
  // root-only, and a lazily projected member would re-send the large schema.
  const keepInherited = (name: string): boolean => !lazyNames.has(name)
    && !permission.disabled(name) && !permission.enabled(name);
  const inheritedEntries = snapshot.entries.map(entry => {
    if (entry.type !== "message" || entry.message.role !== "system") return entry;
    const message = entry.message;
    if (message.toolsAdded === undefined && message.toolsRemoved === undefined) return entry;
    return { ...entry, message: {
      ...message,
      ...(message.toolsAdded === undefined ? {} : { toolsAdded: message.toolsAdded.filter(tool => keepInherited(tool.name)) }),
      ...(message.toolsRemoved === undefined ? {} : { toolsRemoved: message.toolsRemoved.filter(tool => keepInherited(tool.name)) }),
    } };
  });
  const policy = providerSessionPolicy(model);
  const additive = policy.midConversationSystemMessages && policy.toolAdditions;
  const inheritedMessages: readonly ProjectionMessage[] = inheritedEntries.flatMap((entry) =>
    entry.type === "message" ? [entry.message as unknown as ProjectionMessage] : []);
  // Pi's ToolDefinition render callbacks are invariant in their parameter type;
  // the retrieval helper returns Pi-ai Tool records plus the engine's step tool.
  const customTools = (additive
    ? retrievalToolLoadout(inheritedMessages, request.customTools)
    : request.customTools) as unknown as ToolDefinition[];

  let internalOwnedKeys = new Set<string>();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: service.agentDir,
    settingsManager: settings,
    noExtensions: true,
    extensionFactories: [{
      name: "capability-retrieval-admission",
      factory(api) {
        api.on("tool_call", event => retrievalNames.has(event.toolName)
          ? undefined
          : { block: true, reason: `Tool ${event.toolName} is unavailable in capability discovery. Only retrieval tools may execute.` });
        api.on("before_agent_start", (event, extensionCtx) => {
          const currentBranch = extensionCtx.sessionManager.getBranch();
          const currentPermission = createToolPermissionResolver(pi, pi.getAllTools(), currentBranch);
          const catalog = createEligibleToolCatalog(pi, {
            disabled: (name) => currentPermission.disabled(name),
          });
          const admission = createToolAdmission(pi, currentBranch, catalog);
          const callable = new Set(pi.getActiveTools().filter((name) => admission.admits(name) && !lazyNames.has(name)));
          const declared = new Set([...callable].filter((name) => !lazyNames.has(name)));
          const guidance = registeredToolGuidance(catalog.tools, [], callable, declared);
          const guidanceSections = renderCurrentToolGuidance(guidance);
          const memory = capabilityPromptSections(currentBranch, {
            allowsTool: (name) => catalog.names.has(name),
            instructions: toolNamespaceInstructions(catalog.tools),
            nativeGuidanceRefs: projectedNamespaceRefs(guidance, catalog.tools, guidanceSections, declared, callable),
          });
          const sections: Record<string, string | null> = {
            ...guidanceSections,
            ...(memory[CAPABILITY_SECTION] === null ? {} : memory),
            ...presetInstructionSections(currentBranch),
            ...capabilityPruneSections(currentBranch),
            ...(additive ? { "capability-retrieval-policy": policyPrompt.additiveExecutionBlocked } : {}),
          };
          applySystemPromptSections(event.systemPromptOptions.sections ??= {}, sections, internalOwnedKeys);
          internalOwnedKeys = new Set(
            Object.entries(sections)
              .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
              .map(([key]) => key),
          );
        });
        api.on("context_with_system", (event, extensionCtx) => ({
          messages: composeInternalMessages(event.messages, extensionCtx.sessionManager.getBranch()),
        }));
      },
    }],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(inheritedPrompt === null
      ? { systemPrompt: request.instructions }
      : { systemPrompt: inheritedPrompt, appendSystemPrompt: [request.instructions] }),
  });
  await resourceLoader.reload();
  /** Current retrieval declarations through the public context hook (no trailing system injection). */
  function composeInternalMessages(
    input: readonly AgentMessage[],
    branch: readonly SessionEntry[],
  ): AgentMessage[] {
    const permission = createToolPermissionResolver(pi, pi.getAllTools(), branch);
    const catalog = createEligibleToolCatalog(pi, {
      disabled: (name) => permission.disabled(name),
    });
    const admission = createToolAdmission(pi, branch, catalog);
    const declarations = projectDiscoveryDeclarations(input,
      name => (retrievalNames.has(name) || admission.declares(name)) && !lazyNames.has(name),
      () => pi.getAllTools().find(tool => tool.name === "codemode")?.description);
    return (additive ? additiveToolTranscript(declarations) : declarations) as AgentMessage[];
  }

  // The shared Subagent execution owns session creation, caller-abort handling,
  // budget cleanup ordering and the final session.dispose().
  const execution = await openSubagentExecution({
    cwd,
    agentDir: service.agentDir,
    settingsManager: settings,
    modelRuntime,
    ...(model ? { model } : {}),
    thinkingLevel: snapshot.thinkingLevel ?? "low",
    sessionManager: SessionManager.inMemory(cwd, {}, inheritedEntries),
    resourceLoader,
    customTools,
    tools: customTools.map((tool) => tool.name),
  }, request.signal === undefined ? {} : { signal: request.signal });
  try {
    const session = execution.session;
    execution.addCleanup(installSessionCacheIdentity(session, snapshot.cacheKey));
    await session.bindExtensions({});
    execution.addCleanup(async () => {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    });
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
