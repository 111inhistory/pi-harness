/**
 * Capability Pi extension.
 *
 * Adds the no-argument `capability` tool to a session. A call runs an isolated
 * internal retrieval session through the shared Subagent execution entry point
 * (`openSubagentExecution`), the same session lifetime, abort and cleanup used by
 * public delegation. Only `capability_search` and `submit_result` may execute;
 * compatible Responses also retain blocked parent declarations, never parent
 * handles; the run has its own fixed budget. The session inherits the caller's
 * native conversation — raw session entries, system prompt, physical model — so
 * provider-returned blocks such as thinking with their signatures survive
 * verbatim. Compatible Responses keep the parent's thinking level and
 * declaration prefix; other models use thinking low. The tool returns full
 * grouped metadata in details, compact model-facing refs/guidance where native
 * incremental declarations supply the interfaces, and declares the selected
 * already-registered tools active in this session. It never installs, enables or
 * executes anything.
 *
 * The internal agent only searches local tools, MCP servers and skills. The
 * result always reports that remote was not searched, and no remote candidate
 * reaches Main, the branch memory or a summary.
 *
 * Each successful discovery is persisted as a `capability-discovery` branch
 * entry (see ../src/capability/discovery-record.ts) before this tool returns, so
 * a nested `ctx.executeTool("capability", ...)` keeps its memory even when the
 * outer tool drops the inner result details. The request projection reads those
 * records and applies the current tool permissions on every request.
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
} from "@earendil-works/pi-coding-agent";

import {
  CAPABILITY_PARAMETERS,
  CAPABILITY_TOOL_DESCRIPTION,
  CAPABILITY_TOOL_NAME,
  createCapabilityBroker,
} from "../src/capability-broker.mjs";
import {
  CAPABILITY_DISCOVERY_SYSTEM_PROMPT,
  capabilityBudgetWarning,
  capabilityFailureResult,
  createCapabilityDiscovery,
} from "../src/capability-agent.mjs";
import { promptText } from "../src/prompt-text.mjs";

const toolsPrompt = JSON.parse(promptText("capability-tools.json"));
const policyPrompt = JSON.parse(promptText("capability-policy.json"));
import { installModelCallBudget } from "../src/pi-job-budget.mjs";
import { captureInheritedContext } from "../src/inherited-context.mjs";
import { discoverSessionSkills } from "../src/capability-skills.mjs";
import { capabilityPublicResult } from "../src/capability-result.mjs";
import { capabilityPromptTranscript } from "../src/capability-prompt.mjs";
import { appendDiscoveryRecord } from "../src/capability/discovery-record.ts";
import { openSubagentExecution } from "../src/subagent/execution.ts";
import { parentModelRuntime } from "../src/subagent/model-runtime.ts";
import { installNativeDiscoveryBoundary } from "../src/capability/native-discovery.ts";
import { createEligibleToolCatalog, supplySelectedToolInterfaces } from "../src/capability/tool-catalog.ts";
import {
  additiveToolTranscript, capabilityModelResult, capabilityToolDelta, retrievalToolLoadout, supportsAdditiveResponses,
} from "../src/responses-tool-prefix.mjs";

/** `Model<Api>.api` of Pi virtual catalog entries (routed before a provider). */
const VIRTUAL_MODEL_API = "pi-virtual";

export default function capabilityExtension(pi, { discovery = true } = {}) {
  installNativeDiscoveryBoundary(pi);
  const service = {
    agentDir: getAgentDir(),
    projectTrusted: false,
  };
  const broker = createCapabilityBroker(createProviders(pi, service));
  pi.on?.("session_start", (_event, ctx) => { service.projectTrusted = ctx.isProjectTrusted(); });

  // Keep Pi's loaded Skill inventory for discovery, but do not advertise it
  // eagerly in the base prompt. Mutate the native section, not the full prompt.
  pi.on?.("before_agent_start", (event) => {
    event.systemPromptOptions.skills = [];
  });

  // Discovery memory follows the branch, not the lossy summary. Append native
  // section updates at their original result anchors; only compaction checkpoints
  // receive the accumulated older discoveries. Exposure and execution stay separate.
  pi.on?.("context_with_system", (event, ctx) => {
    const available = createEligibleToolCatalog(pi).names;
    const messages = capabilityPromptTranscript(event.messages, ctx.sessionManager.getBranch(), {
      allowsTool: (name) => available.has(name),
    });
    return { messages: supportsAdditiveResponses(ctx.model) ? additiveToolTranscript(messages) : messages };
  });
  pi.on?.("tool_call", (event) => {
    const tool = createEligibleToolCatalog(pi).tools.find((entry) => entry.name === event.toolName);
    if (!tool || (!pi.getActiveTools().includes(event.toolName) && !["codemode", "deferred"].includes(tool.exposure))) {
      return { block: true, reason: `Tool ${event.toolName} is unavailable in this session; retained declarations do not enable execution.` };
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
    reachesTools: () => "all",
    async execute(toolCallId, _params, signal, _onUpdate, ctx) {
      let result;
      let compactNames = null;
      let previouslyActive = new Set();
      try {
        // The shared execution entry point is an import, not a public Subagent
        // tool: discovery does not depend on subagent_create/list/stop being
        // registered or active.
        service.projectTrusted = ctx.isProjectTrusted();
        const snapshot = captureInheritedContext(pi, ctx);
        const physicalModel = inheritedModel(snapshot, ctx, parentModelRuntime(ctx.modelRegistry, "capability discovery"), toolCallId);
        const discovery = createCapabilityDiscovery({
          broker,
          openSession: (request) => openInternalSession(pi, service, ctx, request, snapshot, toolCallId),
        });
        result = await discovery.discover({ cwd: ctx.cwd, signal });
        if (result.status !== "failed") {
          // Persist before activation. Memory is the durability contract, so a
          // failed record write fails closed: nothing is advertised as selected
          // and nothing is activated, because the next request could not restore
          // it. The thrown detail stays in the internal warnings audit.
          try {
            appendDiscoveryRecord(pi, toolCallId, result, result.coverage);
          } catch (error) {
            result = discoveryNotDurable(result, error);
          }
        }
        if (result.status !== "failed") {
          try {
            previouslyActive = new Set(pi.getActiveTools());
            const activation = activateSelectedTools(pi, result);
            createEligibleToolCatalog(pi);
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
      const delta = supplySelectedToolInterfaces(capabilityToolDelta(result, previouslyActive), pi);
      return {
        content: [{ type: "text", text: JSON.stringify(capabilityPublicResult(compactNames ? capabilityModelResult(delta, compactNames) : delta)) }],
        details: result,
        isError: result.status === "failed",
      };
    },
  });
}

/**
 * A discovery that could not be written to the branch is not durable, so it must
 * not be presented as a successful selection or activated. The public failure
 * reason says why; the internal warnings keep the full write error for audit.
 */
function discoveryNotDurable(result, error) {
  const detail = errorMessage(error);
  const reason =
    "capability discovery failed: the selected resources could not be saved in this session branch, " +
    `so they are not durable: ${detail}.`;
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  return capabilityFailureResult(reason, [...warnings, `capability record write failed: ${detail}`], result.coverage);
}

function createProviders(pi, service) {
  return {
    listTools: () => createEligibleToolCatalog(pi, { includeHidden: true }).tools,
    listActiveTools: () => pi.getActiveTools(),
    discoverSkills: (cwd) => discoverSessionSkills(pi, { cwd, agentDir: service.agentDir, projectTrusted: service.projectTrusted }),
    readSkillFile: (filePath) => readFile(filePath, "utf8"),
    // No remote provider: approval is not implemented.
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
    if (active.has(name)) continue;
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
  const modelRuntime = parentModelRuntime(ctx.modelRegistry, "capability discovery");
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
  // The shared Subagent execution owns session creation, caller-abort handling,
  // budget cleanup ordering and the final session.dispose().
  const execution = await openSubagentExecution({
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
  }, { signal: request.signal });
  try {
    const session = execution.session;
    // The blocked placeholders retain interfaces only; they never call parent tools.
    const previousTransform = session.agent.transformContext;
    const available = createEligibleToolCatalog(pi).names;
    session.agent.transformContext = async (messages, signal) => {
      const transformed = previousTransform ? await previousTransform(messages, signal) : messages;
      const remembered = capabilityPromptTranscript(transformed, snapshot.entries, {
        allowsTool: (name) => available.has(name),
      });
      return additive ? [...additiveToolTranscript(remembered), {
        role: "system", content: policyPrompt.additiveExecutionBlocked, timestamp: 0,
      }] : remembered;
    };
    const cleanupBudget = installModelCallBudget(session, request.budget, {
      beforeRequest: request.beforeRequest,
      warningText: capabilityBudgetWarning,
    });
    // Registered with the shared lifetime, so the budget hook is restored even
    // when a later step fails and the execution is disposed by this function.
    execution.addCleanup(cleanupBudget);
    // Messages the inherited context already carried never count as this run's
    // output; only what the run appends from here does.
    const inheritedMessageSet = new Set(session.state?.messages ?? []);
    return {
      async prompt(text) {
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
