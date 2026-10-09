/**
 * Capability Pi extension.
 *
 * Adds the no-argument `capability` tool to a session. A call starts an
 * isolated internal Pi retrieval session (only `capability_search` and
 * `submit_result` may execute; compatible Responses also retain blocked parent
 * declarations, never parent handles; its own fixed budget) that
 * inherits the caller's native conversation — raw session entries, system
 * prompt, model — so provider-returned blocks such as thinking with their
 * signatures survive verbatim. Compatible Responses keep the parent's thinking
 * level and declaration prefix; other models use thinking low. The tool returns
 * full grouped metadata in details, compact model-facing refs/guidance where
 * native incremental declarations supply the interfaces, and
 * declares the selected already-registered tools active in this session. It
 * never installs, enables or executes anything.
 *
 * The same extension registers the capability-owned read protocols
 * (`tool://`, `namespace://`, `mcp://`, `skill://`, `npm://`) through read-only installProtocolIO using
 * the broker's `read()`. It registers no protocol writer.
 */

import { readFile } from "node:fs/promises";

import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import { installProtocolIO } from "./protocol-io.mjs";
import {
  CAPABILITY_PARAMETERS,
  CAPABILITY_TOOL_DESCRIPTION,
  CAPABILITY_TOOL_NAME,
  createCapabilityBroker,
} from "../src/capability-broker.mjs";
import { createNpmMarketplace } from "../src/capability-marketplace.mjs";
import {
  CAPABILITY_DISCOVERY_SYSTEM_PROMPT,
  capabilityBudgetWarning,
  capabilityFailureResult,
  createCapabilityDiscovery,
} from "../src/capability-agent.mjs";
import { installModelCallBudget } from "../src/pi-job-budget.mjs";
import { captureInheritedContext } from "../src/inherited-context.mjs";
import { discoverSessionSkills } from "../src/capability-skills.mjs";
import { capabilityPublicResult } from "../src/capability-result.mjs";
import { capabilityAllowsTool, capabilityAvailableTools } from "../src/capability-scope.mjs";
import {
  additiveToolTranscript, capabilityModelResult, capabilityToolDelta, retrievalToolLoadout, supportsAdditiveResponses,
} from "../src/responses-tool-prefix.mjs";

/** `Model<Api>.api` of Pi virtual catalog entries (routed before a provider). */
const VIRTUAL_MODEL_API = "pi-virtual";

export default function capabilityExtension(pi, { discovery = true } = {}) {
  const service = {
    agentDir: getAgentDir(),
    marketplace: null,
    projectTrusted: false,
  };
  const broker = createCapabilityBroker(createProviders(pi, service));
  pi.on?.("session_start", (_event, ctx) => { service.projectTrusted = ctx.isProjectTrusted(); });

  // Keep Pi's loaded Skill inventory for discovery, but do not advertise it
  // eagerly in the base prompt. Mutate the native section, not the full prompt.
  pi.on?.("before_agent_start", (event) => {
    event.systemPromptOptions.skills = [];
  });

  // Keep the request's declaration prefix stable without granting execution rights.
  pi.on?.("context_with_system", (event, ctx) => {
    if (supportsAdditiveResponses(ctx.model)) return { messages: additiveToolTranscript(event.messages) };
  });
  pi.on?.("tool_call", (event) => {
    const tool = pi.getAllTools().find((entry) => entry.name === event.toolName);
    if (!capabilityAllowsTool(pi, event.toolName) || !tool || tool.exposure === "hidden" ||
        (!pi.getActiveTools().includes(event.toolName) && !["codemode", "deferred"].includes(tool.exposure))) {
      return { block: true, reason: `Tool ${event.toolName} is unavailable in this session; retained declarations do not enable execution.` };
    }
  });

  // Subagent owns the Socket-aware native write backend; Capability only adds readers.
  installProtocolIO(pi, { readers: capabilityReaders(broker), readOnly: true });

  if (!discovery) return;
  pi.registerTool({
    name: CAPABILITY_TOOL_NAME,
    label: "Capability",
    description: CAPABILITY_TOOL_DESCRIPTION,
    promptSnippet: "Find reusable guidance and capabilities for the current task",
    promptGuidelines: [
      "Use capability to find missing capabilities or reuse established guidance and specialized tools before inventing a workflow or building a replacement, for example for Word editing or PPT creation.",
      "Use capability for task-level discovery of guidance and tool names. For unfamiliar tools used through codemode, inspect the interface with describeTool or describeNamespace before calling it. Do not use searchTools as a separate discovery workflow.",
      "Discover Skills through capability. Unless the user explicitly requests filesystem or web searches for Skills, do not search local directories, installed repositories, other agent profiles, or the web for them. A general request to find Skills does not authorize bypassing Capability's configured selection; report gaps or ask about configuration instead. Reading a returned Skill ref or its linked instructions is not a new discovery search.",
      "Skills may contain workflows, rules, preferences, fixed background, or descriptions. Read relevant guidance and use it alongside tool interfaces; a generic tool description may not fit the current task.",
      "Reuse relevant findings throughout the task. Search again when requirements change or a new capability gap appears, not before every tool call.",
      "A needs_approval result is a candidate, not permission to install or execute it.",
    ],
    parameters: CAPABILITY_PARAMETERS,
    async execute(toolCallId, _params, signal, _onUpdate, ctx) {
      let result;
      let compactNames = null;
      let previouslyActive = new Set();
      try {
        const subagentTools = pi.getAllTools().filter((tool) => tool.namespace?.name === "subagent");
        if (!["subagent_list", "subagent_stop"].every((name) => subagentTools.some((tool) => tool.name === name && tool.exposure !== "hidden"))) {
          throw new Error("Capability requires the Subagent extension to be loaded; its tools need not be active.");
        }
        service.projectTrusted = ctx.isProjectTrusted();
        const snapshot = captureInheritedContext(pi, ctx);
        const physicalModel = inheritedModel(snapshot, ctx, parentModelRuntime(ctx.modelRegistry), toolCallId);
        const discovery = createCapabilityDiscovery({
          broker,
          openSession: (request) => openInternalSession(pi, service, ctx, request, snapshot, toolCallId),
        });
        result = await discovery.discover({ cwd: ctx.cwd, signal });
        if (result.status !== "failed") {
          try {
            previouslyActive = new Set(pi.getActiveTools());
            const activation = activateSelectedTools(pi, result);
            capabilityAvailableTools(pi);
            if (supportsAdditiveResponses(physicalModel) && safeSettings(pi)?.codemode?.mode !== "only") {
              compactNames = new Set(pi.getActiveTools());
            }
            if (activation.warnings.length > 0) {
              result = { ...result, warnings: [...result.warnings, ...activation.warnings] };
            }
          } catch (error) {
            result = {
              ...result,
              warnings: [...result.warnings, `selected tools could not be activated: ${errorMessage(error)}`],
            };
          }
        }
      } catch (error) {
        result = capabilityFailureResult(`capability discovery failed: ${errorMessage(error)}.`);
      }
      const delta = capabilityToolDelta(result, previouslyActive);
      return {
        content: [{ type: "text", text: JSON.stringify(capabilityPublicResult(compactNames ? capabilityModelResult(delta, compactNames) : delta)) }],
        details: result,
        isError: result.status === "failed",
      };
    },
  });
}

function createProviders(pi, service) {
  return {
    listTools: () => pi.getAllTools().filter((tool) => capabilityAllowsTool(pi, tool.name)),
    listActiveTools: () => pi.getActiveTools(),
    discoverSkills: (cwd) => discoverSessionSkills(pi, { cwd, agentDir: service.agentDir, projectTrusted: service.projectTrusted }),
    readSkillFile: (filePath) => readFile(filePath, "utf8"),
    searchRemote: (query, options) => marketplace(pi, service).searchRemote(query, options),
    readRemote: (ref, options) => marketplace(pi, service).readRemote(ref, options),
    listInstalledPackages: () => installedPackageSources(pi),
  };
}

function safeSettings(pi) {
  try {
    return pi.getSettings?.() ?? null;
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
function internalSettings(pi, trusted) {
  const effective = safeSettings(pi);
  const base = effective !== null && typeof effective === "object" ? effective : {};
  return SettingsManager.inMemory(
    { ...base, packages: [], extensions: [], skills: [], prompts: [], themes: [] },
    { projectTrusted: trusted === true },
  );
}

/** Pi's configured package sources; the installed identity check reads this. */
function installedPackageSources(pi) {
  const settings = safeSettings(pi);
  return Array.isArray(settings?.packages) ? settings.packages : [];
}

function marketplace(pi, service) {
  if (service.marketplace === null) {
    service.marketplace = createNpmMarketplace({
      // Installed packages never come back as installation requests; the
      // helper fails closed when this source list is unavailable.
      listInstalledPackages: () => installedPackageSources(pi),
    });
  }
  return service.marketplace;
}

/** The read protocols capability owns. The wrapper hands the full URI through. */
function capabilityReaders(broker) {
  const read = (uri, ctx, options) =>
    broker.read(String(uri), { cwd: ctx?.cwd, signal: options?.signal ?? ctx?.signal });
  return { tool: read, namespace: read, mcp: read, skill: read, npm: read };
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
function activateSelectedTools(pi, result) {
  const registered = new Map();
  for (const tool of pi.getAllTools()) registered.set(tool.name, tool);
  const active = new Set(pi.getActiveTools());
  const activate = [];
  const seen = new Set();
  const warnings = [];
  const selected = [...result.tools, ...result.mcp].flatMap((hit) => Array.isArray(hit.tools) ? hit.tools : [hit]);
  for (const hit of selected) {
    const name = typeof hit?.name === "string" ? hit.name : "";
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    const tool = registered.get(name);
    if (tool === undefined) {
      // A server-level `mcp://<server>` ref names no single registered tool;
      // only a tool ref that lost its registration is reported.
      if (hit?.kind === "tool") warnings.push(`selected tool "${name}" is not registered in this session`);
      continue;
    }
    if (tool.exposure === "hidden") {
      warnings.push(`selected tool "${name}" is hidden and cannot be activated`);
      continue;
    }
    if (active.has(name) || tool.exposure === "codemode" || tool.exposure === "deferred") continue;
    activate.push(name);
  }
  if (activate.length > 0) pi.setActiveTools([...active, ...activate]);
  return { activated: activate, warnings };
}

/**
 * The internal session runs on the caller's inherited system context plus the
 * fixed retrieval addendum: same environment/conventions, fixed role and rules.
 */
function inheritedSystemPrompt(snapshot) {
  const inherited = typeof snapshot?.systemPrompt === "string" ? snapshot.systemPrompt.trim() : "";
  return inherited === "" ? null : snapshot.systemPrompt;
}

/**
 * The caller's exact current model. A physical selection is used as-is. A
 * virtual selection must not be routed again for this conversation: the
 * physical model that produced the calling `capability` tool call is the model
 * whose thinking blocks and signatures are being inherited, so its identity is
 * read from that assistant message and resolved through the caller's own
 * runtime. When that identity cannot be proven, discovery fails explicitly
 * instead of silently rerouting to another provider or model.
 */
function inheritedModel(snapshot, ctx, modelRuntime, toolCallId) {
  const selected = snapshot?.model ?? ctx.model ?? null;
  if (selected === null || typeof selected !== "object") return undefined;
  if (selected.api !== VIRTUAL_MODEL_API) return selected;
  const messages = ctx.sessionManager.buildSessionProjection().messages;
  let producing = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (
      toolCallId === undefined ||
      message.content.some((block) => block?.type === "toolCall" && block.id === toolCallId)
    ) {
      producing = message;
      break;
    }
  }
  const physical =
    producing !== null && typeof producing.provider === "string" && typeof producing.model === "string"
      ? modelRuntime.getPhysicalModel(producing.provider, producing.model)
      : undefined;
  if (physical !== undefined) return physical;
  throw new Error(
    "the caller selected a virtual model and the physical model that produced the calling capability request cannot be " +
      "identified; refusing to reroute this conversation to another provider or model",
  );
}

async function openInternalSession(pi, service, ctx, request, snapshot, toolCallId) {
  const cwd = ctx.cwd;
  const settings = internalSettings(pi, ctx.isProjectTrusted());
  const modelRuntime = parentModelRuntime(ctx.modelRegistry);
  const instructions =
    typeof request.instructions === "string" && request.instructions !== ""
      ? request.instructions
      : CAPABILITY_DISCOVERY_SYSTEM_PROMPT;
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
      ? { systemPrompt: instructions }
      : { systemPrompt: inheritedPrompt, appendSystemPrompt: [instructions] }),
  });
  await resourceLoader.reload();
  const model = inheritedModel(snapshot, ctx, modelRuntime, toolCallId);
  const additive = supportsAdditiveResponses(model);
  const inheritedMessages = snapshot.entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
  const customTools = additive ? retrievalToolLoadout(inheritedMessages, request.customTools) : request.customTools;
  const { session } = await createAgentSession({
    cwd,
    agentDir: service.agentDir,
    settingsManager: settings,
    modelRuntime,
    ...(model ? { model } : {}),
    thinkingLevel: additive ? (snapshot.thinkingLevel ?? "low") : "low",
    sessionManager: SessionManager.inMemory(cwd, {}, snapshot.entries),
    resourceLoader,
    customTools,
    tools: customTools.map((tool) => tool.name),
  });
  // The blocked placeholders retain interfaces only; they never call parent tools.
  const previousTransform = session.agent.transformContext;
  if (additive) session.agent.transformContext = async (messages, signal) => {
    const transformed = previousTransform ? await previousTransform(messages, signal) : messages;
    return [...additiveToolTranscript(transformed), {
      role: "system", content: "Capability discovery may execute only capability_search and submit_result. All other retained tool declarations are unavailable; execution is blocked.", timestamp: 0,
    }];
  };
  const cleanupBudget = installModelCallBudget(session, request.budget, {
    beforeRequest: request.beforeRequest,
    warningText: capabilityBudgetWarning,
  });
  // Messages the inherited context already carried never count as this run's
  // output; only what the run appends from here does.
  const inheritedMessageSet = new Set(session.state?.messages ?? []);
  return {
    async prompt(text) {
      await session.prompt(text, { expandPromptTemplates: false });
      return (session.state?.messages ?? []).filter((message) => !inheritedMessageSet.has(message));
    },
    abort: () => session.abort(),
    dispose: () => {
      cleanupBudget();
      session.dispose();
    },
  };
}

/**
 * The internal session must run on the parent session's exact ModelRuntime so
 * extension-registered providers, virtual-model routing and runtime
 * credentials stay available. Pi 0.99 builds `new ModelRegistry(<session
 * runtime>)` (agent-session.js) and the compiled facade keeps that runtime as
 * the plain property `runtime`; there is no public accessor. This is the single
 * explicit compatibility boundary of this extension: when the bridge is
 * unavailable, discovery fails with an explicit error instead of silently
 * running on a runtime that lost those registrations.
 */
function parentModelRuntime(registry) {
  const candidate = registry?.runtime;
  const usable =
    candidate !== null &&
    typeof candidate === "object" &&
    typeof candidate.streamSimple === "function" &&
    typeof candidate.getAuth === "function" &&
    typeof candidate.getRegisteredProviderIds === "function";
  if (usable) return candidate;
  throw new Error(
    "this Pi build does not expose the session ModelRuntime through ModelRegistry.runtime, so capability discovery " +
      "cannot reuse the parent session's provider registrations and virtual models; refusing to silently fall back " +
      "to a fresh runtime",
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
