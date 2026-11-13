import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getCurrentTools,
  type AssistantMessage,
  type JsonObject,
  type Message,
} from "@earendil-works/pi-ai";
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

import capabilityExtension from "../../src/capability/extension.ts";
import { CAPABILITY_STEP_TOOL_NAME } from "../../src/capability/contracts.ts";
import type { CapabilityDiscoveryResult, CapabilityStepDetails } from "../../src/capability/agent.ts";
import { discoveryRecords } from "../../src/capability/discovery-record.ts";

type ToolResultMessage = Extract<Message, { role: "toolResult" }>;

interface CapabilityStepBody {
  readonly searches: readonly {
    readonly mcp: readonly { readonly ref: string }[];
  }[];
}

function assistantMessage(
  model: { readonly api: string; readonly provider: string; readonly id: string },
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason,
    timestamp: Date.now(),
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

function contentText(content: unknown): string {
  assert.ok(Array.isArray(content));
  const part = content.find((candidate): candidate is { type: "text"; text: string } =>
    typeof candidate === "object" && candidate !== null &&
    "type" in candidate && candidate.type === "text" &&
    "text" in candidate && typeof candidate.text === "string");
  assert.ok(part);
  return part.text;
}

function capabilitySections(messages: readonly Message[]): string {
  return messages.flatMap((message) => {
    if (message.role !== "system") return [];
    const sections = "sections" in message && typeof message.sections === "object" && message.sections !== null
      ? message.sections as Record<string, unknown>
      : {};
    return typeof sections["capabilities"] === "string" ? [sections["capabilities"]] : [];
  }).join("\n");
}

/**
 * Narrow SDK allowlist case:
 *
 * - a plain `--tools read,write,capability` allowlist keeps MCP tools registered
 *   (they are not filtered as MCP) but filters the Harness's hidden `tool_search`;
 * - `_isActivatable` therefore rejects the deferred MCP tool even though
 *   Capability can select it;
 * - `setActiveTools` silently ignores it.
 *
 * The test documents the current visible failure and the deliberate
 * persist-before-activate ordering: the branch record still contains the
 * selection. Main must report this as unresolved rather than claim that the
 * returned and persisted selections match.
 */
test("a plain CLI allowlist can leave a selected deferred MCP tool silently unactivatable", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-capability-allowlist-mask-"));
  const agentDir = path.join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  const originalFetch = globalThis.fetch;
  const originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  let session: AgentSession | undefined;
  let pi: ExtensionAPI | undefined;
  const rootRequests: { messages: readonly Message[] }[] = [];
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
    globalThis.fetch = (async () => {
      throw new Error("network is disabled in this test");
    }) as typeof fetch;

    runtime.streamSimple = (_model, context) => {
      const stream = new AssistantMessageEventStream();
      const internal = getCurrentTools(context.messages).some((tool) => tool.name === CAPABILITY_STEP_TOOL_NAME);
      let message: AssistantMessage;
      if (internal) {
        const previous = context.messages.findLast(
          (candidate): candidate is ToolResultMessage =>
            candidate.role === "toolResult" && candidate.toolName === CAPABILITY_STEP_TOOL_NAME,
        );
        if (!previous) {
          message = assistantMessage(
            model,
            toolCall("mask-search", CAPABILITY_STEP_TOOL_NAME, { queries: ["inspect"], refs: [] }),
            "toolUse",
          );
        } else {
          const body = JSON.parse(contentText(previous.content)) as CapabilityStepBody;
          const selected = body.searches[0]?.mcp[0]?.ref;
          assert.equal(selected, "mcp://fixture", "the deferred MCP tool is discoverable");
          message = assistantMessage(
            model,
            toolCall("mask-submit", CAPABILITY_STEP_TOOL_NAME, { queries: [], refs: [selected], finish: true }),
            "toolUse",
          );
        }
      } else {
        rootRequests.push({ messages: structuredClone(context.messages) });
        message = rootRequests.length === 1
          ? assistantMessage(model, toolCall("mask-capability", "capability", {}), "toolUse")
          : assistantMessage(model, [{ type: "text", text: "parent finished" }], "stop");
      }
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
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
        name: "capability-allowlist-mask-test",
        factory(extension) {
          pi = extension;
          capabilityExtension(extension);
          extension.registerTool({
            name: "mcp__fixture__inspect",
            label: "Fixture inspector",
            description: "Deferred MCP fixture kept registered by the plain allowlist.",
            parameters: { type: "object", properties: {} },
            exposure: "deferred",
            defaultActive: false,
            async execute() {
              return { content: [{ type: "text", text: "must not execute" }], details: {} };
            },
          });
        },
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      resourceLoader,
      // The SDK equivalent of `pi --tools read,write,capability`: no MCP entry,
      // so MCP tools stay registered while the Harness's hidden tool_search is
      // filtered out.
      tools: ["read", "write", "capability"],
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    await session.prompt("Select the deferred MCP fixture");

    assert.ok(pi);
    assert.ok(pi.getAllTools().some((tool) => tool.name === "mcp__fixture__inspect"));
    assert.equal(pi.getAllTools().some((tool) => tool.name === "tool_search"), false);
    assert.equal(pi.getActiveTools().includes("mcp__fixture__inspect"), false, "the SDK silently masked activation");
    assert.deepEqual(errors, []);

    const result = session.messages.findLast(
      (message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "capability",
    );
    assert.ok(result);
    assert.equal(result.isError, true);
    const visible = JSON.parse(contentText(result.content)) as {
      status?: string;
      failureReason?: string;
      tools?: unknown[];
      mcp?: unknown[];
    };
    assert.equal(visible.status, "failed");
    assert.match(visible.failureReason ?? "", /did not become active in this session/);
    assert.deepEqual([visible.tools, visible.mcp], [[], []], "the returned selection reflects the actual active set");

    const details = result.details as unknown as CapabilityDiscoveryResult;
    assert.equal(details.status, "failed");
    assert.deepEqual([details.tools, details.mcp], [[], []], "details also exclude the masked member");

    const records = discoveryRecords(session.sessionManager.getBranch());
    assert.equal(records.length, 1, "persist-before-activate still wrote the successful search snapshot");
    assert.deepEqual(
      records[0]?.result.mcp.flatMap((hit) => hit.tools ?? []).map((tool) => tool.name),
      ["mcp__fixture__inspect"],
      "the branch record retains the member that the SDK refused to activate",
    );

    const next = rootRequests[1];
    assert.ok(next, "the parent continued after the publication");
    assert.equal(getCurrentTools(next.messages).some((tool) => tool.name === "mcp__fixture__inspect"), false);
    const tail = next.messages.at(-1);
    assert.equal(tail?.role, "user", "mid-run boundary emits persisted user sync instead of developer_tail");
    assert.match(JSON.stringify(tail?.content ?? "") + capabilitySections(next.messages), /mcp__fixture__inspect/,
      "memory still advertises the recorded member");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
