import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getCurrentTools, type AssistantMessage, type JsonObject, type Message } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import capabilityExtension from "../../extensions/capability.ts";
import { CAPABILITY_STEP_TOOL_NAME } from "../../src/capability/contracts.ts";
import type { CapabilityStepDetails } from "../../src/capability/agent.ts";
import { discoveryRecords, type StoredDiscovery } from "../../src/capability/discovery-record.ts";
import type { CapabilityPublicResult } from "../../src/capability/result.ts";

type ToolResultMessage = Extract<Message, { role: "toolResult" }>;
type ScenarioMode = "provider_error" | "cancelled";

interface ObservedOutcome {
  readonly isError: boolean;
  readonly content: unknown;
  readonly details: unknown;
}

interface Scenario {
  readonly mode: ScenarioMode;
  readonly rootCalls: number;
  readonly internalCalls: number;
  readonly fetchCalls: readonly string[];
  readonly errors: readonly unknown[];
  readonly outcome: ObservedOutcome;
  readonly persisted: readonly StoredDiscovery[];
  readonly activeTools: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantMessage(
  model: { readonly api: string; readonly provider: string; readonly id: string },
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason,
    timestamp: Date.now(),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    usage: {
      input: 1,
      output: 1,
      totalTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function toolCall(id: string, name: string, args: JsonObject): AssistantMessage["content"] {
  return [{ type: "toolCall", id, name, arguments: args }];
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
  return isRecord(value) &&
    value["role"] === "toolResult" &&
    typeof value["toolCallId"] === "string" &&
    typeof value["toolName"] === "string" &&
    Array.isArray(value["content"]) &&
    typeof value["isError"] === "boolean";
}

function toolResult(messages: readonly unknown[], name: string): ToolResultMessage {
  const result = messages.findLast((message): message is ToolResultMessage =>
    isToolResultMessage(message) && message.toolName === name);
  assert.ok(result, `expected a ${name} tool result`);
  return result;
}

function stepDetails(message: ToolResultMessage): CapabilityStepDetails {
  const body = message.content.find((part) => part.type === "text");
  assert.ok(body?.type === "text", "capability_step must return text details");
  const parsed: unknown = JSON.parse(body.text);
  assert.ok(isRecord(parsed) && Array.isArray(parsed["searches"]), "capability_step details must carry search results");
  return parsed as unknown as CapabilityStepDetails;
}

function contentText(content: unknown): string {
  assert.ok(Array.isArray(content), "tool result content must be an array");
  const body = content.find((part): part is { readonly type: "text"; readonly text: string } =>
    isRecord(part) && part["type"] === "text" && typeof part["text"] === "string");
  assert.ok(body, "expected model-facing text content");
  return body.text;
}

function publicResult(content: unknown): CapabilityPublicResult {
  const parsed: unknown = JSON.parse(contentText(content));
  assert.ok(isRecord(parsed), "public capability result must be a JSON object");
  return parsed as unknown as CapabilityPublicResult;
}

async function runScenario(mode: ScenarioMode): Promise<Scenario> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-capability-partial-"));
  const agentDir = path.join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  const originalFetch = globalThis.fetch;
  const originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;

  const fetchCalls: string[] = [];
  const controller = new AbortController();
  let session: AgentSession | undefined;
  let pi: ExtensionAPI | undefined;
  let nestedOutcome: ObservedOutcome | undefined;
  let rootCalls = 0;
  let internalCalls = 0;
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(cwd, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
    assert.ok(model);
    runtime.getAuth = async () => ({ auth: { apiKey: "offline-test-only" }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCalls.push(String(input));
      throw new Error("network is disabled in this test");
    }) as typeof fetch;

    runtime.streamSimple = (_model, context) => {
      const stream = new AssistantMessageEventStream();
      const internal = getCurrentTools(context.messages).some((tool) => tool.name === CAPABILITY_STEP_TOOL_NAME);

      if (internal) {
        internalCalls += 1;
        if (internalCalls === 1) {
          const message = assistantMessage(
            model,
            toolCall("internal-search", CAPABILITY_STEP_TOOL_NAME, { queries: ["fixture_partial"], refs: [] }),
            "toolUse",
          );
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end();
          return stream;
        }
        if (internalCalls === 2) {
          const firstSearch = stepDetails(toolResult(context.messages, CAPABILITY_STEP_TOOL_NAME)).searches[0];
          assert.ok(firstSearch);
          assert.ok(
            firstSearch.tools.some((hit) => hit.ref === "tool://fixture_partial"),
            "the selected fixture must be returned by the local search",
          );
          const message = assistantMessage(
            model,
            toolCall("internal-continue", CAPABILITY_STEP_TOOL_NAME, {
              queries: ["second_pass"],
              refs: ["tool://fixture_partial"],
            }),
            "toolUse",
          );
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end();
          return stream;
        }

        // Selection and the continuing search are already committed internally.
        // They are not published yet: the parent tool stays inactive and no
        // canonical branch record exists until the outer capability call returns.
        assert.ok(pi);
        assert.ok(session);
        assert.ok(!pi.getActiveTools().includes("fixture_partial"),
          "internal selection must not activate the fixture before outer publication");
        assert.deepEqual(discoveryRecords(session.sessionManager.getBranch()), [],
          "internal selection must not persist before outer publication");
        const continuedSearch = stepDetails(toolResult(context.messages, CAPABILITY_STEP_TOOL_NAME)).searches[0];
        assert.equal(continuedSearch?.query, "second_pass");

        if (mode === "cancelled") {
          controller.abort();
          const message = assistantMessage(model, [{ type: "text", text: "after caller abort" }], "stop");
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
          return stream;
        }

        const error = assistantMessage(model, [], "error", "scripted internal provider failure");
        stream.push({ type: "error", reason: "error", error });
        stream.end();
        return stream;
      }

      rootCalls += 1;
      const message = rootCalls === 1
        ? assistantMessage(
            model,
            toolCall("root-discovery", mode === "cancelled" ? "invoke_capability" : "capability", {}),
            "toolUse",
          )
        : assistantMessage(model, [{ type: "text", text: "parent finished" }], "stop");
      stream.push({ type: "done", reason: rootCalls === 1 ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    };

    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false, keepRecentTokens: 0 },
      cacheWarming: "off",
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [{
        name: "capability-partial-test",
        factory(extension) {
          pi = extension;
          capabilityExtension(extension);
          extension.registerTool({
            name: "fixture_partial",
            label: "Fixture partial",
            description: "Selected fixture for partial publication.",
            parameters: { type: "object", properties: {} },
            defaultActive: false,
            async execute() {
              return { content: [{ type: "text", text: "fixture executed" }], details: {} };
            },
          });
          extension.registerTool({
            name: "fixture_unrelated",
            label: "Fixture unrelated",
            description: "Private unrelated operation that must never be selected or activated.",
            parameters: { type: "object", properties: {} },
            defaultActive: false,
            async execute() {
              return { content: [{ type: "text", text: "unexpected execution" }], details: {} };
            },
          });
          if (mode === "cancelled") {
            extension.registerTool({
              name: "invoke_capability",
              label: "Invoke capability",
              description: "Call Capability through the nested tool context with caller cancellation.",
              parameters: { type: "object", properties: {} },
              async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
                const outcome = await ctx.executeTool("capability", {}, { signal: controller.signal });
                nestedOutcome = {
                  isError: outcome.isError,
                  content: outcome.result.content,
                  details: outcome.result.details,
                };
                return { content: [{ type: "text", text: "nested capability observed" }], details: {} };
              },
            });
          }
        },
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    session = (await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      resourceLoader,
    })).session;
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    await session.prompt("Find the partial fixture capability");

    assert.equal(rootCalls, 2, "the parent turn itself must complete in both modes");
    assert.equal(internalCalls, 3, "the internal run stops after publication is resolved; no extra model calls");
    assert.deepEqual(fetchCalls, [], "discovery must remain local and offline");
    assert.deepEqual(errors, []);

    const outcome = mode === "cancelled"
      ? nestedOutcome
      : (() => {
          const result = toolResult(session!.messages, "capability");
          return { isError: result.isError, content: result.content, details: result.details };
        })();
    assert.ok(outcome);
    assert.ok(pi);

    return {
      mode,
      rootCalls,
      internalCalls,
      fetchCalls: [...fetchCalls],
      errors: [...errors],
      outcome,
      persisted: discoveryRecords(session.sessionManager.getBranch()),
      activeTools: [...pi.getActiveTools()],
    };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("provider failure after selection publishes a partial result and activates the saved fixture", async () => {
  const scenario = await runScenario("provider_error");
  const visible = publicResult(scenario.outcome.content);
  assert.equal(scenario.outcome.isError, false, "a partial result with selected resources remains publishable");
  assert.equal(visible.status, "partial");
  assert.equal(visible.endReason, "provider_error");
  assert.deepEqual(visible.tools?.map((hit) => hit.ref), ["tool://fixture_partial"]);
  assert.doesNotMatch(JSON.stringify(visible), /fixture_unrelated|Private unrelated operation/);

  assert.ok(isRecord(scenario.outcome.details));
  assert.equal(scenario.outcome.details["status"], "partial");
  assert.equal(scenario.outcome.details["endReason"], "provider_error");

  assert.equal(scenario.persisted.length, 1, "the partial selection is written to the canonical branch record");
  const stored = scenario.persisted[0];
  assert.ok(stored);
  assert.equal(stored.result.status, "partial");
  assert.deepEqual(stored.result.tools.map((hit) => hit.ref), ["tool://fixture_partial"]);
  assert.doesNotMatch(JSON.stringify(stored), /fixture_unrelated|Private unrelated operation/);

  assert.ok(scenario.activeTools.includes("fixture_partial"), "the persisted selection is activated after publication");
  assert.ok(!scenario.activeTools.includes("fixture_unrelated"), "an unselected candidate is never activated");
});

test("caller abort before publication fails closed without persisting or activating the internal selection", async () => {
  const scenario = await runScenario("cancelled");
  const visible = publicResult(scenario.outcome.content);
  assert.equal(scenario.outcome.isError, true);
  assert.equal(visible.status, "failed");
  assert.equal(visible.endReason, "cancelled");
  assert.deepEqual(visible.tools ?? [], [], "an aborted call publishes no new selection");
  assert.doesNotMatch(JSON.stringify(visible), /fixture_partial|fixture_unrelated/);

  assert.ok(isRecord(scenario.outcome.details));
  assert.equal(scenario.outcome.details["status"], "failed");
  assert.equal(scenario.outcome.details["endReason"], "cancelled");
  assert.deepEqual(scenario.persisted, [], "caller cancellation must not write the canonical branch record");
  assert.ok(!scenario.activeTools.includes("fixture_partial"), "caller cancellation must not activate the fixture");
  assert.ok(!scenario.activeTools.includes("fixture_unrelated"), "an unselected candidate is never activated");
});
