import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import capabilityExtension from "../../extensions/capability.ts";
import { CAPABILITY_STEP_TOOL_NAME } from "../../src/capability/contracts.ts";
import { CAPABILITY_DISCOVERY_RECORD } from "../../src/capability/discovery-record.ts";
import { CAPABILITY_SECTION } from "../../src/capability/prompt.ts";

/** A request as the fake runtime observes it (the projection is request-only). */
type ObservedRequest = {
  messages: ObservedMessage[];
};

type ObservedMessage = Message & {
  toolName?: string;
  sections?: Record<string, string>;
  toolsAdded?: { name: string }[];
};

/** The part of an `ctx.executeTool` outcome this test inspects. */
type NestedOutcome = {
  isError: boolean;
  result: { content: unknown; details?: unknown };
};

type BranchEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; toolName?: string };
};

type Scenario = {
  parentRequests: ObservedRequest[];
  childRequests: ObservedRequest[];
  fetchCalls: string[];
  nestedOutcome: NestedOutcome | undefined;
  branch: BranchEntry[];
  activeTools: string[];
  parentToolNames: string[];
  errors: unknown[];
};

function assistantMessage(model: { api: string; provider: string; id: string }, content: unknown, stopReason: string): AssistantMessage {
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
  } as unknown as AssistantMessage;
}

function toolCall(id: string, name: string, args: Record<string, unknown>): unknown[] {
  return [{ type: "toolCall", id, name, arguments: args }];
}

function sectionOf(request: ObservedRequest | undefined): string | undefined {
  for (const message of request?.messages ?? []) {
    const section = message.sections?.[CAPABILITY_SECTION];
    if (typeof section === "string" && section !== "") return section;
  }
  return undefined;
}

function recordsOn(branch: BranchEntry[]): BranchEntry[] {
  return branch.filter((entry) => entry.type === "custom" && entry.customType === CAPABILITY_DISCOVERY_RECORD);
}

/**
 * End-to-end Capability run through the shared Subagent execution:
 *
 * - the parent model calls a fixture tool, which calls `ctx.executeTool("capability")`;
 * - the internal retrieval session first asks for remote/all searches (must fail
 *   without any network request), then a local search and a submission;
 * - no public Subagent tool is registered anywhere.
 *
 * `failRecordWrite` patches the extension API's `appendEntry` so the canonical
 * `capability-discovery` write throws. Everything else (fixture tools, fake
 * runtime, session setup) stays identical between both runs.
 */
async function runNestedCapability({ failRecordWrite = false } = {}): Promise<Scenario> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-capability-nested-"));
  const agentDir = path.join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  const originalFetch = globalThis.fetch;
  const originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
  // Capability reads Pi's agent dir for Skill discovery; point it at the empty
  // test dir so installed Skills from the developer's environment cannot leak in.
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  const fetchCalls: string[] = [];
  let session: AgentSession | undefined;
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(cwd, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
    assert.ok(model);
    const parentRequests: ObservedRequest[] = [];
    const childRequests: ObservedRequest[] = [];
    const toolCallIds = { parent: 0, child: 0 };
    let nestedOutcome: NestedOutcome | undefined;

    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCalls.push(String(input));
      throw new Error("network is disabled in this test");
    }) as typeof fetch;

    runtime.getAuth = async () => ({ auth: { apiKey: "offline-test-only" }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    runtime.streamSimple = (_model, context) => {
      // Pi 1.4 carries declarations in the transcript's system messages, so the
      // child session is identified by its own retrieval tool declarations.
      const declared = (context.messages as { toolsAdded?: { name: string }[] }[])
        .flatMap((message) => message.toolsAdded ?? [])
        .map((tool) => tool.name);
      const isInternal = declared.includes(CAPABILITY_STEP_TOOL_NAME);
      const stream = new AssistantMessageEventStream();
      let message: AssistantMessage;
      if (isInternal) {
        childRequests.push(structuredClone({ messages: context.messages as unknown as ObservedMessage[] }));
        const step = childRequests.length;
        toolCallIds.child += 1;
        const id = `child-${toolCallIds.child}`;
        if (step === 1) {
          message = assistantMessage(
            model,
            toolCall(id, CAPABILITY_STEP_TOOL_NAME, {
              queries: ["fixture_slides"],
            }),
            "toolUse",
          );
        } else if (step === 2) {
          message = assistantMessage(
            model,
            toolCall(id, CAPABILITY_STEP_TOOL_NAME, {
              refs: ["tool://fixture_slides"],
              finish: true,
            }),
            "toolUse",
          );
        } else {
          message = assistantMessage(model, [{ type: "text", text: "done" }], "stop");
        }
      } else {
        parentRequests.push(structuredClone({ messages: context.messages as unknown as ObservedMessage[] }));
        toolCallIds.parent += 1;
        if (parentRequests.length === 1) {
          message = assistantMessage(model, toolCall(`parent-${toolCallIds.parent}`, "nested_discovery", {}), "toolUse");
        } else {
          message = assistantMessage(model, [{ type: "text", text: "finished" }], "stop");
        }
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
    let parentPi: ExtensionAPI | undefined;
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
        name: "capability-nested-test",
        factory(pi) {
          parentPi = pi;
          if (failRecordWrite) {
            const append = pi.appendEntry.bind(pi);
            pi.appendEntry = ((customType: string, data?: unknown) => {
              if (customType === CAPABILITY_DISCOVERY_RECORD) throw new Error("simulated branch record write failure");
              append(customType, data);
            }) as ExtensionAPI["appendEntry"];
          }
          capabilityExtension(pi);
          pi.registerTool({
            name: "fixture_slides",
            label: "Fixture slides",
            description: "Create fixture slides locally.",
            parameters: { type: "object", properties: {} },
            defaultActive: false,
            execute: async () => ({ content: [{ type: "text", text: "fixture executed" }], details: {} }),
          });
          pi.registerTool({
            name: "nested_discovery",
            label: "Nested discovery",
            description: "Run Capability through ctx.executeTool.",
            parameters: { type: "object", properties: {} },
            execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
              nestedOutcome = (await ctx.executeTool("capability", {})) as unknown as NestedOutcome;
              return {
                content: [{ type: "text", text: JSON.stringify({ isError: nestedOutcome.isError }) }],
                details: {},
              };
            },
          });
        },
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.ok(parentPi);

    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      resourceLoader,
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    await session.prompt("Find reusable capabilities for this task");

    return {
      parentRequests,
      childRequests,
      fetchCalls,
      nestedOutcome,
      branch: structuredClone(session.sessionManager.getBranch()) as unknown as BranchEntry[],
      activeTools: [...parentPi.getActiveTools()],
      parentToolNames: parentPi.getAllTools().map((tool) => tool.name),
      errors,
    };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("nested Capability discovery persists branch memory without exposing remote candidates", async () => {
  const scenario = await runNestedCapability();
  assert.deepEqual(scenario.errors, []);
  assert.deepEqual(scenario.fetchCalls, [], "remote search must not touch the network");
  assert.equal(scenario.childRequests.length, 2, "one local search batch and the terminating finish step");

  const records = recordsOn(scenario.branch);
  assert.equal(records.length, 1, "exactly one successful discovery is persisted");
  const data = records[0]?.data as {
    version?: number;
    toolCallId?: string;
    result?: {
      tools?: { ref?: string }[];
      remote?: unknown;
      coverage?: unknown;
    };
  };
  assert.equal(data.version, 1);
  assert.match(String(data.toolCallId), /^parent-1\/1$/, "the record is bound to the nested tool call");
  assert.deepEqual(data.result?.tools?.map((hit) => hit.ref), ["tool://fixture_slides"]);
  assert.equal(data.result?.remote, undefined, "no remote artifact is stored in the branch memory");
  assert.deepEqual(data.result?.coverage, { local: "searched", remote: "not_searched" });

  const capabilityResults = scenario.branch.filter((entry) =>
    entry.type === "message"
    && entry.message?.role === "toolResult"
    && entry.message?.toolName === "capability");
  assert.deepEqual(capabilityResults, [], "a nested call does not appear in the transcript");
  assert.equal(scenario.nestedOutcome?.isError, false);

  const nestedDetails = scenario.nestedOutcome?.result.details as {
    remote?: unknown;
    coverage?: unknown;
    status?: string;
  } | undefined;
  assert.equal(nestedDetails?.status, "ok");
  assert.deepEqual(nestedDetails?.remote, [], "remote candidates never reach Main's tool result");
  assert.deepEqual(nestedDetails?.coverage, { local: "searched", remote: "not_searched" });
  const nestedText = JSON.stringify(scenario.nestedOutcome?.result.content);
  assert.doesNotMatch(nestedText, /npm:|"needs_approval"/);

  // Retrieval tools are internal to the child session: they never become
  // public parent tools, and no public Subagent tool had to be registered.
  assert.ok(!scenario.parentToolNames.includes(CAPABILITY_STEP_TOOL_NAME));
  assert.ok(!scenario.parentToolNames.includes("subagent_list"));
  assert.ok(!scenario.parentToolNames.includes("subagent_stop"));
  assert.ok(scenario.activeTools.includes("fixture_slides"), "a persisted discovery activates its selected tool");
  assert.equal(scenario.parentRequests.length, 2);

  const section = sectionOf(scenario.parentRequests[1]);
  assert.ok(section, "the next request carries the canonical discovery memory");
  assert.match(section, /tool:\/\/fixture_slides/);
  assert.doesNotMatch(section, /npm:|"needs_approval"/);
  assert.doesNotMatch(JSON.stringify(scenario.parentRequests[1]), /npm:|"needs_approval"/);
});

test("a branch-record write failure fails closed before activation and leaves no memory", async () => {
  const scenario = await runNestedCapability({ failRecordWrite: true });
  assert.deepEqual(scenario.errors, []);
  assert.deepEqual(scenario.fetchCalls, [], "remote search must not touch the network");
  assert.equal(scenario.childRequests.length, 2, "the retrieval itself still completed");

  assert.equal(scenario.nestedOutcome?.isError, true, "Main must not receive a successful-looking result");
  const details = scenario.nestedOutcome?.result.details as {
    status?: string;
    warnings?: string[];
    coverage?: unknown;
    tools?: unknown[];
    mcp?: unknown[];
    skills?: unknown[];
  } | undefined;
  assert.equal(details?.status, "failed");
  assert.deepEqual(details?.coverage, { local: "searched", remote: "not_searched" }, "actual search coverage is preserved");
  assert.deepEqual([details?.tools, details?.mcp, details?.skills], [[], [], []], "no selected resources are advertised");
  assert.ok(
    details?.warnings?.some((warning) => /capability record write failed: simulated branch record write failure/.test(warning)),
    "the full audit stays internal",
  );

  const content = scenario.nestedOutcome?.result.content as { type?: string; text?: string }[] | undefined;
  const publicResult = JSON.parse(String(content?.[0]?.text)) as {
    status?: string;
    failureReason?: string;
    warnings?: unknown;
    tools?: unknown[];
    mcp?: unknown[];
    skills?: unknown[];
    remote?: unknown;
    coverage?: unknown;
  };
  assert.equal(publicResult.status, "failed");
  assert.equal(publicResult.warnings, undefined, "diagnostic warnings stay out of Main's content");
  assert.match(publicResult.failureReason ?? "", /could not be saved in this session branch/);
  assert.match(publicResult.failureReason ?? "", /simulated branch record write failure/);
  assert.ok((publicResult.failureReason ?? "").length <= 240);
  assert.doesNotMatch(publicResult.failureReason ?? "", /[\r\n]/);
  assert.deepEqual([publicResult.tools, publicResult.mcp, publicResult.skills], [[], [], []], "no false selected resources");
  assert.deepEqual(publicResult.remote, []);
  assert.deepEqual(publicResult.coverage, { local: "searched", remote: "not_searched" });

  assert.deepEqual(recordsOn(scenario.branch), [], "a failed write leaves no canonical memory");
  assert.ok(!scenario.activeTools.includes("fixture_slides"), "a non-durable discovery must not activate tools");

  const lastRequest = scenario.parentRequests.at(-1);
  assert.equal(sectionOf(lastRequest), undefined, "the next request has no capability memory");
  assert.doesNotMatch(JSON.stringify(lastRequest?.messages ?? []), /tool:\/\/fixture_slides/);
});
