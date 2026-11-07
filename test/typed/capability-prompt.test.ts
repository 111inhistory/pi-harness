import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import capabilityExtension from "../../extensions/capability.ts";
import { getCurrentSystemMessage } from "../../node_modules/@earendil-works/pi-ai/dist/utils/transcript.js";
import { convertResponsesMessages } from "../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
import {
  CAPABILITY_SECTION,
  capabilityPromptTranscript,
  type ProjectionMessage,
} from "../../src/capability/prompt.ts";
import {
  CAPABILITY_DISCOVERY_RECORD,
  appendDiscoveryRecord,
  type CapabilityHit,
  type CapabilitySearchCoverage,
} from "../../src/capability/discovery-record.ts";
import { projectToolGuidance, toolGuidanceSection } from "../../src/tool-guidance.ts";
import { SUBAGENT_TOOL_GUIDANCE } from "../../src/subagent/tool-guidance.ts";
import type { TranscriptMessageLike } from "../../src/session-transcript.ts";

interface DiscoveryDetails {
  readonly status: "ok" | "partial";
  readonly tools: readonly CapabilityHit[];
  readonly mcp: readonly CapabilityHit[];
  readonly skills: readonly CapabilityHit[];
  readonly guidance?: readonly CapabilityHit[];
  readonly remote?: readonly CapabilityHit[];
}

interface DiscoveryResultMessage extends ProjectionMessage {
  readonly role: "toolResult";
  readonly toolName: "capability";
  readonly toolCallId: string;
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: DiscoveryDetails;
  readonly timestamp: number;
  readonly isError?: boolean;
}

interface RememberedTool {
  readonly name?: string;
}

interface RememberedHit {
  readonly ref?: string;
  readonly instructions?: string;
  readonly tools?: readonly RememberedTool[];
}

const head: ProjectionMessage = {
  role: "system",
  content: "",
  sections: { preamble: "Unchanging base" },
  timestamp: 0,
};
const user: ProjectionMessage = { role: "user", content: "task", timestamp: 1 };
const skill: CapabilityHit = {
  ref: "skill://slides",
  name: "slides",
  description: "Make slides",
  filePath: "/skills/slides/SKILL.md",
  body: "Large on-demand body",
  score: 100,
};
const group: CapabilityHit = {
  ref: "namespace://browser",
  name: "browser",
  instructions: "Use the current tab",
  tools: [
    { ref: "tool://pages", name: "pages", description: "List pages", exposure: "deferred" },
    { ref: "tool://click", name: "click", description: "Click", exposure: "codemode" },
  ],
};
const coverage: CapabilitySearchCoverage = { local: "searched", remote: "not_searched" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapabilityHitArray(value: unknown): value is readonly CapabilityHit[] {
  return Array.isArray(value) && value.every(isRecord);
}

function isDiscoveryDetails(value: unknown): value is DiscoveryDetails {
  return isRecord(value) &&
    (value["status"] === "ok" || value["status"] === "partial") &&
    isCapabilityHitArray(value["tools"]) &&
    isCapabilityHitArray(value["mcp"]) &&
    isCapabilityHitArray(value["skills"]);
}

function isDiscoveryResultMessage(message: ProjectionMessage): message is DiscoveryResultMessage {
  return message.role === "toolResult" &&
    message.toolName === "capability" &&
    typeof message.toolCallId === "string" &&
    isDiscoveryDetails(message.details);
}

function result(id: string, details: Partial<DiscoveryDetails> = {}): DiscoveryResultMessage {
  return {
    role: "toolResult",
    toolName: "capability",
    toolCallId: id,
    content: [{ type: "text", text: "discovery" }],
    details: {
      status: "ok",
      tools: [],
      mcp: [group],
      skills: [skill],
      remote: [{ ref: "npm://candidate", status: "needs_approval" }],
      ...details,
    },
    timestamp: 2,
  };
}

function recordData(id: string, details: Partial<DiscoveryDetails> = {}): unknown {
  let stored: unknown = null;
  appendDiscoveryRecord({ appendEntry: (_customType, data) => { stored = data; } }, id,
    { status: "ok", tools: [], mcp: [group], skills: [skill], ...details }, coverage);
  return stored;
}

function recordEntry(id: string, details: Partial<DiscoveryDetails>): ProjectionMessage | null {
  const data = recordData(id, details);
  return data === null ? null : { type: "custom", id: `record-${id}`, customType: CAPABILITY_DISCOVERY_RECORD, data };
}

// Real writes happen before the tool result message is appended, and nested calls
// produce only the custom record. Both shapes must project identically.
function entries(...messages: readonly ProjectionMessage[]): unknown[] {
  return messages.flatMap((message, index) => {
    const entry = { type: "message", id: `e${index}`, message };
    if (!isDiscoveryResultMessage(message) || message.isError) return [entry];
    const record = recordEntry(message.toolCallId, message.details);
    return record === null ? [entry] : [record, entry];
  });
}

function appendNativeMessage(manager: SessionManager, message: ProjectionMessage): string {
  // Deliberately minimal transcript fixtures; the SDK only replays their fields.
  return manager.appendMessage(message as unknown as Message);
}

function appendDiscovery(manager: SessionManager, message: DiscoveryResultMessage): string {
  manager.appendCustomEntry(CAPABILITY_DISCOVERY_RECORD, recordData(message.toolCallId, message.details));
  return appendNativeMessage(manager, message);
}

type NativeTranscriptMessages = Parameters<typeof getCurrentSystemMessage>[0];

function nativeTranscriptMessages(messages: readonly ProjectionMessage[]): NativeTranscriptMessages {
  return messages as unknown as NativeTranscriptMessages;
}

function projectedSessionMessages(messages: readonly unknown[]): readonly ProjectionMessage[] {
  return messages as unknown as readonly ProjectionMessage[];
}

function section(messages: readonly ProjectionMessage[]): string | undefined {
  return getCurrentSystemMessage(nativeTranscriptMessages(messages))?.sections?.[CAPABILITY_SECTION] ?? undefined;
}

function isRememberedHit(value: unknown): value is RememberedHit {
  if (!isRecord(value)) return false;
  if (value["ref"] !== undefined && typeof value["ref"] !== "string") return false;
  if (value["instructions"] !== undefined && typeof value["instructions"] !== "string") return false;
  if (value["tools"] !== undefined) {
    if (!Array.isArray(value["tools"])) return false;
    if (!value["tools"].every((tool) => isRecord(tool) && (tool["name"] === undefined || typeof tool["name"] === "string"))) {
      return false;
    }
  }
  return true;
}

function records(messages: readonly ProjectionMessage[]): RememberedHit[] {
  const current = section(messages);
  assert.ok(current, "expected a current capability section");
  const parsed: unknown = JSON.parse(current.split("\n")[2] ?? "[]");
  assert.ok(Array.isArray(parsed), "capability memory must be a JSON array");
  return parsed.filter(isRememberedHit);
}

function occurrences(text: string, needle: string): number {
  return needle === "" ? 0 : text.split(needle).length - 1;
}

test("discovery appends a native section immediately and preserves original messages", () => {
  const found = result("a");
  const messages = [head, user, found];
  const before = structuredClone(messages);
  const projected = capabilityPromptTranscript(messages, entries(...messages));
  assert.deepEqual(projected.slice(0, 3), messages);
  assert.equal(projected[3]?.role, "system");
  assert.doesNotMatch(section(projected) ?? "", /skill:\/\//);
  assert.match(section(projected) ?? "", /\/skills\/slides\/SKILL.md/);
  assert.match(section(projected) ?? "", /Use the current tab/);
  assert.match(section(projected) ?? "", /pages/);
  assert.doesNotMatch(section(projected) ?? "", /Large on-demand body|score|npm:\/\/candidate/);
  assert.deepEqual(messages, before);
  assert.deepEqual(capabilityPromptTranscript(projected, entries(...messages)), projected);
});

test("native Subagent guidance is projected once while namespace memory keeps third-party instructions", () => {
  const common = SUBAGENT_TOOL_GUIDANCE.find((entry) => entry.id === "subagent")?.text;
  assert.ok(common && common.trim().length > 0);
  const subagent: CapabilityHit = {
    ref: "namespace://subagent",
    name: "subagent",
    instructions: common,
    tools: [{ ref: "tool://subagent_list", name: "subagent_list", description: "List agents", exposure: "direct" }],
  };
  const guidanceHit: CapabilityHit = {
    ref: "namespace://third-party-guidance",
    name: "third-party-guidance",
    instructions: "Third-party guidance stays in request memory",
  };
  const found = result("a", { mcp: [subagent, group], guidance: [guidanceHit] });
  const messages = [head, user, found];
  const projected = capabilityPromptTranscript(messages, entries(...messages), {
    nativeGuidanceRefs: new Set([subagent.ref!]),
  });
  const remembered = records(projected);
  assert.equal(remembered.find((hit) => hit.ref === subagent.ref)?.instructions, undefined,
    "the Subagent namespace leaves its common guidance to the native guidance path");
  assert.equal(remembered.find((hit) => hit.ref === group.ref)?.instructions, group.instructions,
    "a third-party namespace keeps its own instructions");
  assert.equal(remembered.find((hit) => hit.ref === guidanceHit.ref)?.instructions, guidanceHit.instructions,
    "third-party guidance text is untouched");
  assert.match(section(projected) ?? "", /\/skills\/slides\/SKILL.md/);

  const declaration: ProjectionMessage = {
    role: "system",
    content: "",
    sections: { preamble: "Unchanging base" },
    toolsAdded: [{ name: "subagent_list" }],
    timestamp: 0,
  };
  const composed = projectToolGuidance(
    [declaration, ...projected] as unknown as readonly TranscriptMessageLike[],
    SUBAGENT_TOOL_GUIDANCE,
  );
  const sections = (message: unknown): Record<string, string> => {
    const value = (message as { readonly sections?: unknown }).sections;
    return typeof value === "object" && value !== null ? value as Record<string, string> : {};
  };
  const native = composed.flatMap((message) =>
    message.role === "system" ? [sections(message)[toolGuidanceSection("subagent")] ?? ""] : []).join("\n");
  assert.equal(occurrences(native, common), 1, "the native guidance path still supplies the common text once");
  const systemText = composed.flatMap((message) =>
    message.role === "system" ? Object.values(sections(message)) : []).join("\n");
  assert.equal(occurrences(systemText, common), 1, "the composed request carries exactly one shared guidance copy");
});

test("repeated discoveries produce no redundant patches, later guidance preserves members", () => {
  const first = result("a");
  const second = result("b");
  const third = result("c", {
    mcp: [],
    skills: [],
    guidance: [{ ref: "namespace://browser", name: "browser", instructions: "Updated shared guidance" }],
  });
  const messages = [head, user, first, second, third];
  const projected = capabilityPromptTranscript(messages, entries(...messages));
  assert.equal(projected.filter((message) => message.sections?.[CAPABILITY_SECTION]).length, 2);
  const remembered = records(projected).find((hit) => hit.ref === group.ref);
  assert.ok(remembered);
  assert.equal(remembered.instructions, "Updated shared guidance");
  assert.ok(remembered.tools);
  assert.deepEqual(remembered.tools.map((tool) => tool.name), ["pages", "click"]);
});

test("native compaction and repeated compaction rehydrate from branch details, not summary", () => {
  const sm = SessionManager.inMemory("/test");
  appendNativeMessage(sm, head);
  appendNativeMessage(sm, user);
  appendDiscovery(sm, result("a"));
  const keep = appendNativeMessage(sm, { ...user, content: "continue", timestamp: 3 });
  sm.appendCompaction("Summary deliberately forgets skills and browser", keep, 100);
  const branch = sm.getBranch();
  const projected = capabilityPromptTranscript(projectedSessionMessages(sm.buildSessionProjection().messages), branch);
  const compactedHead = projected[0]?.sections?.[CAPABILITY_SECTION];
  assert.ok(compactedHead);
  assert.match(compactedHead, /\/skills\/slides\/SKILL.md/);
  assert.match(compactedHead, /namespace:\/\/browser/);
  const next = result("b", {
    skills: [{ ...skill, ref: "/skills/analysis/SKILL.md", filePath: "/skills/analysis/SKILL.md", name: "analysis" }],
  });
  appendDiscovery(sm, next);
  const immediately = capabilityPromptTranscript(projectedSessionMessages(sm.buildSessionProjection().messages), sm.getBranch());
  assert.deepEqual(immediately[0], projected[0], "new discovery must not rewrite the compacted head");
  assert.match(section(immediately) ?? "", /\/skills\/analysis\/SKILL.md/);
  const keepAgain = appendNativeMessage(sm, { ...user, content: "continue again", timestamp: 4 });
  sm.appendCompaction("Still no discovery facts", keepAgain, 100);
  const twice = capabilityPromptTranscript(projectedSessionMessages(sm.buildSessionProjection().messages), sm.getBranch());
  assert.match(section(twice) ?? "", /\/skills\/slides\/SKILL.md/);
  assert.match(section(twice) ?? "", /\/skills\/analysis\/SKILL.md/);
  // Reconstructed manager models reload/inherited raw entries with no in-memory cache.
  const header = sm.getHeader();
  assert.ok(header);
  const restored = SessionManager.inMemory("/test", {}, [header, ...sm.getBranch()]);
  assert.deepEqual(
    capabilityPromptTranscript(projectedSessionMessages(restored.buildSessionProjection().messages), restored.getBranch()),
    twice,
  );
});

test("branch selection, failures and tool scope are respected without changing permissions", () => {
  const first = result("a");
  const failed: DiscoveryResultMessage = {
    ...result("b", {
      skills: [{ ...skill, ref: "/skills/failed/SKILL.md", filePath: "/skills/failed/SKILL.md" }],
    }),
    isError: true,
  };
  const partial = result("c", {
    status: "partial",
    mcp: [],
    tools: [{ ref: "tool://denied", name: "denied", kind: "tool" }],
    skills: [],
  });
  const branch = entries(first, failed, partial);
  const projected = capabilityPromptTranscript([head, user], branch, { allowsTool: (name) => name === "pages" });
  const remembered = records(projected).find((hit) => hit.ref === group.ref);
  assert.ok(remembered?.tools);
  assert.deepEqual(remembered.tools.map((tool) => tool.name), ["pages"]);
  assert.doesNotMatch(section(projected) ?? "", /\/skills\/failed|tool:\/\/denied|tool:\/\/click/);
  assert.deepEqual(capabilityPromptTranscript([head, user], []), [head, user], "another branch cannot retain these discoveries");
});

test("Responses wire prefix is unchanged on append; folding providers retain current memory", () => {
  // The wire formatter reads only these model identity fields in this test.
  const model = {
    api: "openai-codex-responses",
    provider: "openai-codex",
    id: "offline",
    reasoning: true,
    input: ["text"],
  } as unknown as Model<Api>;
  type ResponsesContext = Parameters<typeof convertResponsesMessages>[1];
  type ResponsesOptions = NonNullable<Parameters<typeof convertResponsesMessages>[3]>;
  const options: ResponsesOptions = { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true };
  const first = result("a");
  const initial = capabilityPromptTranscript([head, user, first], entries(first));
  const second = result("b", {
    skills: [{ ...skill, ref: "/skills/analysis/SKILL.md", filePath: "/skills/analysis/SKILL.md" }],
  });
  const appended = capabilityPromptTranscript([head, user, first, second], entries(first, second));
  const wire = (messages: readonly ProjectionMessage[], opts: ResponsesOptions = options) =>
    convertResponsesMessages(
      model,
      { messages } as unknown as ResponsesContext,
      new Set([model.provider]),
      opts,
    );
  const before = wire(initial);
  assert.deepEqual(wire(appended).slice(0, before.length), before);
  const collapsed = JSON.stringify(wire(appended, { supportsMidConvoSystemMessages: false }));
  assert.match(collapsed, /\/skills\/slides\/SKILL.md/);
  assert.match(collapsed, /\/skills\/analysis\/SKILL.md/);
});

test("real SDK extension exposes discovery on the next turn and after manual compaction", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-capability-prompt-"));
  let session: AgentSession | undefined;
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
    assert.ok(model);
    runtime.getAuth = async () => ({ auth: { apiKey: "offline-test-only" }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    const requests: ProjectionMessage[][] = [];
    runtime.streamSimple = (_model, context) => {
      requests.push(structuredClone(context.messages) as unknown as ProjectionMessage[]);
      const first = requests.length === 1;
      const stopReason: "toolUse" | "stop" = first ? "toolUse" : "stop";
      const content: AssistantMessage["content"] = first
        ? [{ type: "toolCall", id: "sdk-discovery", name: "capability", arguments: {} }]
        : [{ type: "text", text: "done" }];
      const message: AssistantMessage = {
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
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: stopReason, message });
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
      agentDir: cwd,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [{
        name: "discovery-memory-test",
        factory(pi) {
          capabilityExtension(pi, { discovery: false });
          pi.registerTool({
            name: "capability",
            label: "Fixture discovery",
            description: "Offline discovery result",
            parameters: { type: "object", properties: {} },
            async execute(toolCallId) {
              const details = result("sdk-discovery", { mcp: [] }).details;
              appendDiscoveryRecord(pi, toolCallId, details, coverage);
              return { content: [{ type: "text", text: "selected" }], details };
            },
          });
          pi.on("session_before_compact", (event) => ({
            compaction: {
              summary: "Deliberately forget all discoveries",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          }));
        },
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    session = (await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime: runtime,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      resourceLoader,
    })).session;
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    await session.prompt("Discover capabilities");
    assert.equal(requests.length, 2);
    const initialRequest = requests[0];
    const rememberedRequest = requests[1];
    assert.ok(initialRequest && rememberedRequest);
    assert.equal(section(initialRequest), undefined);
    assert.match(section(rememberedRequest) ?? "", /\/skills\/slides\/SKILL.md/);
    assert.deepEqual(rememberedRequest.slice(0, initialRequest.length), initialRequest);
    await session.compact();
    await session.prompt("Continue without rediscovery");
    assert.equal(requests.length, 3);
    const compactedRequest = requests[2];
    assert.ok(compactedRequest);
    assert.match(section(compactedRequest) ?? "", /\/skills\/slides\/SKILL.md/);
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
