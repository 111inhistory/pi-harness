import { projectCapabilitySnapshot } from './support/capability-snapshot.ts';
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
import capabilityExtension from "../../src/capability/extension.ts";
import { convertResponsesMessages } from "../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
import {
  CAPABILITY_SECTION,

  type ProjectionMessage,
} from "../../src/capability/prompt.ts";
import {
  CAPABILITY_DISCOVERY_RECORD,
  appendDiscoveryRecord,
  type CapabilityHit,
  type CapabilitySearchCoverage,
} from "../../src/capability/discovery-record.ts";
import { renderGuidanceText } from "../../src/tool-guidance.ts";
import {
  nativelyGuidedNamespaces,
  projectedNamespaceRefs,
  registeredToolGuidance,
  withheldToolGuidance,
} from "../../src/capability/tool-instructions.ts";
import { createToolAccessView, listLoadedContainers } from "../../src/capability/tool-access-view.ts";
import { createEligibleToolCatalog } from "../../src/capability/tool-catalog.ts";
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

function projectedSessionMessages(messages: readonly unknown[]): readonly ProjectionMessage[] {
  return messages as unknown as readonly ProjectionMessage[];
}

function section(messages: readonly ProjectionMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index]?.sections?.[CAPABILITY_SECTION];
    if (typeof value === 'string') return value;
  }
  return undefined;
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

test("discovery appends one current section and preserves original messages", () => {
  const found = result("a");
  const messages = [head, user, found];
  const before = structuredClone(messages);
  const projected = projectCapabilitySnapshot(messages, entries(...messages));
  assert.deepEqual(projected.slice(0, 3), messages);
  assert.equal(projected[3]?.role, "system");
  assert.doesNotMatch(section(projected) ?? "", /skill:\/\//);
  assert.match(section(projected) ?? "", /\/skills\/slides\/SKILL.md/);
  assert.match(section(projected) ?? "", /Use the current tab/);
  assert.match(section(projected) ?? "", /pages/);
  assert.doesNotMatch(section(projected) ?? "", /Large on-demand body|score|npm:\/\/candidate/);
  assert.deepEqual(messages, before);
});

test("current guidance renderer supplies shared prose once while namespace memory keeps third-party instructions", () => {
  const common = "Common native subagent guideline";
  const subagentTools = [
    {
      name: "subagent_list",
      namespace: { name: "subagent", instructions: common },
      promptGuidelines: [common],
    },
  ];
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
  const declared = new Set(["subagent_list"]);
  assert.deepEqual([...nativelyGuidedNamespaces(subagentTools, declared, declared)], ["subagent"]);
  const guidance = registeredToolGuidance(subagentTools, [], declared, declared);
  assert.deepEqual(guidance, [], "namespaces covered by ToolDefinition.promptGuidelines do not emit duplicate custom sections");
  const rendered = renderGuidanceText([
    ...guidance,
    { id: "namespace:third-party", namespace: "third-party", tools: ["tp_tool"], text: "Third-party body", eligible: true },
  ]) ?? "";
  const projected = projectCapabilitySnapshot(messages, entries(...messages), {
    nativeGuidanceRefs: projectedNamespaceRefs(guidance, subagentTools, declared, declared),
  });
  const remembered = records(projected);
  assert.equal(remembered.find((hit) => hit.ref === subagent.ref)?.instructions, undefined,
    "the Subagent namespace leaves its common guidance to the native guidance path");
  assert.equal(remembered.find((hit) => hit.ref === group.ref)?.instructions, group.instructions,
    "a third-party namespace keeps its own instructions");
  assert.equal(remembered.find((hit) => hit.ref === guidanceHit.ref)?.instructions, guidanceHit.instructions,
    "third-party guidance text is untouched");
  assert.match(section(projected) ?? "", /\/skills\/slides\/SKILL\.md/);
  assert.equal(occurrences(rendered, "Third-party body"), 1,
    "non-SDK namespace guidance renders once");
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
  const projected = projectCapabilitySnapshot(messages, entries(...messages));
  assert.equal(projected.filter((message) => message.sections?.[CAPABILITY_SECTION]).length, 1);
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
  const projected = projectCapabilitySnapshot(projectedSessionMessages(sm.buildSessionProjection().messages), branch);
  const compacted = section(projected);
  assert.ok(compacted);
  assert.match(compacted, /\/skills\/slides\/SKILL.md/);
  assert.match(compacted, /namespace:\/\/browser/);
  const next = result("b", {
    skills: [{ ...skill, ref: "/skills/analysis/SKILL.md", filePath: "/skills/analysis/SKILL.md", name: "analysis" }],
  });
  appendDiscovery(sm, next);
  const immediately = projectCapabilitySnapshot(projectedSessionMessages(sm.buildSessionProjection().messages), sm.getBranch());
  assert.deepEqual(immediately.slice(0, projected.length - 1), projected.slice(0, -1), "new discovery must not rewrite native messages");
  assert.match(section(immediately) ?? "", /\/skills\/analysis\/SKILL.md/);
  const keepAgain = appendNativeMessage(sm, { ...user, content: "continue again", timestamp: 4 });
  sm.appendCompaction("Still no discovery facts", keepAgain, 100);
  const twice = projectCapabilitySnapshot(projectedSessionMessages(sm.buildSessionProjection().messages), sm.getBranch());
  assert.match(section(twice) ?? "", /\/skills\/slides\/SKILL.md/);
  assert.match(section(twice) ?? "", /\/skills\/analysis\/SKILL.md/);
  // Reconstructed manager models reload/inherited raw entries with no in-memory cache.
  const header = sm.getHeader();
  assert.ok(header);
  const restored = SessionManager.inMemory("/test", {}, [header, ...sm.getBranch()]);
  assert.deepEqual(
    projectCapabilitySnapshot(projectedSessionMessages(restored.buildSessionProjection().messages), restored.getBranch()),
    twice,
  );
});

test("branch selection, failures and tool scope are respected without changing membership or blacklist", () => {
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
  const projected = projectCapabilitySnapshot([head, user], branch, { allowsTool: (name) => name === "pages" });
  const remembered = records(projected).find((hit) => hit.ref === group.ref);
  assert.ok(remembered?.tools);
  assert.deepEqual(remembered.tools.map((tool) => tool.name), ["pages"]);
  assert.doesNotMatch(section(projected) ?? "", /\/skills\/failed|tool:\/\/denied|tool:\/\/click/);
  assert.deepEqual(projectCapabilitySnapshot([head, user], []), [head, user], "another branch cannot retain these discoveries");
});

test("Responses wire keeps the head; folding providers retain current memory", () => {
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
  const initial = projectCapabilitySnapshot([head, user, first], entries(first));
  const second = result("b", {
    skills: [{ ...skill, ref: "/skills/analysis/SKILL.md", filePath: "/skills/analysis/SKILL.md" }],
  });
  const appended = projectCapabilitySnapshot([head, user, first, second], entries(first, second));
  const wire = (messages: readonly ProjectionMessage[], opts: ResponsesOptions = options) =>
    convertResponsesMessages(
      model,
      { messages } as unknown as ResponsesContext,
      new Set([model.provider]),
      opts,
    );
  assert.deepEqual(wire(initial)[0], wire(appended)[0], "the leading system head is unchanged");
  const collapsed = JSON.stringify(wire(appended, { supportsMidConvoSystemMessages: false }));
  assert.match(collapsed, /\/skills\/slides\/SKILL.md/);
  assert.match(collapsed, /\/skills\/analysis\/SKILL.md/);
});

test("real SDK extension exposes discovery on the next turn and after manual compaction", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-capability-prompt-"));
  const originalAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = cwd;
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
    // Mid-run discovery persists a non-empty custom_message converted to role "user" (never developer_tail).
    assert.equal(section(rememberedRequest), undefined);
    const syncMessage = rememberedRequest.at(-1);
    assert.equal(syncMessage?.role, "user");
    assert.match(JSON.stringify(syncMessage), /\/skills\/slides\/SKILL\.md/);
    assert.deepEqual(rememberedRequest.slice(0, initialRequest.length), initialRequest);
    assert.match(JSON.stringify(rememberedRequest), /\/skills\/slides\/SKILL\.md/);
    await session.compact();
    await session.prompt("Continue without rediscovery");
    assert.equal(requests.length, 3);
    const compactedRequest = requests[2];
    assert.ok(compactedRequest);
    assert.match(section(compactedRequest) ?? "", /\/skills\/slides\/SKILL\.md/);
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    if (originalAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = originalAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("renderGuidanceText combines applicable guidance entries and omits empty or ineligible ones", () => {
  const rendered = renderGuidanceText([
    { id: "tool-disabled", tools: ["a"], text: "Alpha", eligible: true },
    { id: "namespace:browser", namespace: "browser", tools: ["b"], text: "Beta", eligible: true },
    { id: "skipped-ineligible", tools: ["c"], text: "Gamma", eligible: false },
    { id: "skipped-empty", tools: ["d"], text: "   ", eligible: true },
    { id: "skipped-notools", tools: [], text: "Delta", eligible: true },
  ]);
  assert.equal(rendered, "Alpha\n\nBeta");
  assert.equal(renderGuidanceText([{ id: "empty", tools: [], text: "None", eligible: true }]), null);
});

test("real loaded-container replay keeps one namespace guide and its alias refs in every state", () => {
  const shared = "Shared guidance from the registered namespace";
  const tools = [
    {
      name: "mcp__git__status",
      namespace: { name: "mcp__git", description: "Git server", instructions: shared, aliases: ["git"] },
    },
    {
      name: "mcp__git__log",
      namespace: { name: "mcp__git", description: "Git server", instructions: shared, aliases: ["git"] },
    },
  ];
  const host = { getAllTools: () => tools, getActiveTools: () => [] as string[] };
  const inactive = new Set<string>();
  const load = (container: string): readonly unknown[] => [{
    type: "custom",
    customType: "capability-tool-base",
    data: { version: 1, baseline: [], load: [container] },
  }];

  // The alias and namespace refs resolve to one real container; guidance joins
  // on its members, so the alias cannot duplicate it. A local container ban is
  // overridden per member by explicit base membership.
  const containers = listLoadedContainers(host, load("mcp://git"));
  assert.deepEqual(containers.map((container) => ({
    target: container.target,
    members: container.members,
    blocked: container.blocked,
    instructions: container.instructions,
  })), [{
    target: "mcp://git",
    members: ["mcp__git__status", "mcp__git__log"],
    blocked: false,
    instructions: shared,
  }]);
  const guidance = registeredToolGuidance(tools, [], inactive, inactive, containers);
  assert.deepEqual(guidance.map((entry) => entry.id), ["namespace:mcp__git"],
    "one real container yields one guidance entry");
  assert.equal(guidance[0]?.text, shared);
  assert.notEqual(guidance[0]?.eligible, false,
    "a loaded container stays guidance-eligible while every member is inactive");
  assert.deepEqual(guidance[0]?.tools, ["mcp__git__status", "mcp__git__log"]);
  const rendered = renderGuidanceText(guidance);
  assert.equal(rendered, shared, "the shared server text is rendered once");
  const refs = projectedNamespaceRefs(guidance, tools, inactive, inactive);
  assert.ok(refs.has("mcp://git"));
  assert.ok(refs.has("namespace://mcp__git"),
    "both alias refs are suppressed in request memory once guidance renders them");

  // A loaded container whose eligible catalog no longer holds any member has no
  // text source; it must not invent metadata.
  assert.deepEqual(registeredToolGuidance([], [], inactive, inactive, containers), []);

  // A local container ban is stored but an explicit base member overrides it:
  // the namespace guide remains for that member, while the banned peer never
  // enters the guide's tool list.
  const localBanBranch = [
    {
      type: "custom",
      customType: "capability-tool-base",
      data: { version: 1, baseline: [], load: ["mcp://git"], add: ["mcp__git__status"] },
    },
    { type: "custom", customType: "capability-tool-blacklist", data: { version: 1, add: ["mcp://git"] } },
  ];
  const localView = createToolAccessView(host, localBanBranch);
  assert.equal(localView.blacklisted("mcp__git__status"), true, "the raw ban stays stored");
  assert.equal(localView.banOverridden("mcp__git__status"), true, "base overrides the local ban");
  const localCatalog = createEligibleToolCatalog(host, { blocked: (tool) => localView.blocked(tool.name) });
  const localContainers = localView.loadedContainers;
  assert.equal(localContainers[0]?.blocked, false, "an allowed base member keeps the container unblocked");
  const localGuidance = registeredToolGuidance(localCatalog.tools, [], inactive, inactive, localContainers);
  assert.deepEqual(localGuidance.map((entry) => entry.id), ["namespace:mcp__git"]);
  assert.deepEqual(localGuidance[0]?.tools, ["mcp__git__status"],
    "the guide lists only the effective base member, never its locally banned peer");
  assert.equal(localCatalog.names.has("mcp__git__log"), false, "the banned peer is not in the eligible catalog");

  // Without any allowed member the same container ban hides the guide.
  const blockedBranch = [
    ...load("mcp://git"),
    { type: "custom", customType: "capability-tool-blacklist", data: { version: 1, add: ["mcp://git"] } },
  ];
  const blockedContainers = listLoadedContainers(host, blockedBranch);
  assert.equal(blockedContainers[0]?.blocked, true);
  assert.deepEqual(registeredToolGuidance(tools, [], inactive, inactive, blockedContainers), [],
    "a container-level ban with no allowed member hides the namespace guidance");
});

test("withheld declarations keep tool-specific guidance without repeating the namespace text", () => {
  const shared = "Shared namespace instructions";
  const tools = [
    {
      name: "browser_click",
      namespace: { name: "browser", description: "Browser", instructions: shared },
      promptGuidelines: [shared, "Click one element by ref."],
    },
    {
      name: "browser_type",
      namespace: { name: "browser", description: "Browser", instructions: shared },
      promptGuidelines: [shared, "Click one element by ref."],
    },
    {
      name: "browser_read",
      namespace: { name: "browser", description: "Browser", instructions: shared },
      promptGuidelines: [`${shared} Read a page before acting.`],
    },
  ];
  const withheld = new Set(["browser_click", "browser_type", "browser_read"]);
  const declared = new Set<string>();
  const guidance = [
    ...registeredToolGuidance(tools, [], new Set(), declared, [{ members: tools.map(tool => tool.name), blocked: false }], withheld),
    ...withheldToolGuidance(tools, withheld),
  ];
  const text = renderGuidanceText(guidance) ?? "";

  assert.equal(text.split(shared).length - 1, 2,
    "the namespace guide appears once and an opaque mixed third-party line is kept intact without substring surgery");
  assert.match(text, /Click one element by ref\./);
  assert.equal(text.split("Click one element by ref.").length - 1, 1,
    "identical per-tool lines are emitted once even across withheld tools");
  assert.match(text, /Read a page before acting\./,
    "opaque mixed third-party guidelines are preserved");

  const clickEntry = guidance.find(entry => entry.id === "tool:browser_click");
  assert.deepEqual(clickEntry, { id: "tool:browser_click", tools: ["browser_click"], text: "Click one element by ref." });
  const readEntry = guidance.find(entry => entry.id === "tool:browser_read");
  assert.equal(readEntry?.text, `${shared} Read a page before acting.`,
    "a mixed third-party line is preserved as opaque text instead of substring-split");

  const sharedOnly = [{ name: "plain", namespace: { name: "group", instructions: shared }, promptGuidelines: [shared] }];
  assert.deepEqual(withheldToolGuidance(sharedOnly, new Set(["plain"])), [],
    "a withheld tool with no specific instruction emits no extra section");
  assert.deepEqual(withheldToolGuidance(tools, new Set(["not_selected"])), [],
    "a tool outside the withheld set is not guessed from its absence");

  // Withheld declarations do not count as native coverage: the namespace guide
  // stays dynamic exactly once while their own lines are projected separately.
  assert.equal(guidance.filter(entry => entry.namespace === "browser").length, 1);
});

test("a withheld declaration keeps its per-tool guidance and one namespace guide in a real request", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-capability-noschema-"));
  const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = cwd;
  let session: AgentSession | undefined;
  const requests: ProjectionMessage[][] = [];
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
    assert.ok(model);
    runtime.getAuth = async () => ({ auth: { apiKey: "offline-only" }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    runtime.streamSimple = (_model, context) => {
      requests.push(structuredClone(context.messages) as unknown as ProjectionMessage[]);
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    };
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off",
      codemode: { mode: "only" }, defaultTools: ["+codemode"],
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [{
        name: "no-schema-guidance-fixture",
        factory(pi) {
          capabilityExtension(pi, { discovery: false });
          pi.registerTool({
            name: "fixture_guided",
            label: "Fixture guided",
            description: "A fixture whose schema is withheld",
            defaultActive: true,
            namespace: { name: "fixtures", description: "Fixture group", instructions: "SHARED_FIXTURE_RULE" },
            promptGuidelines: ["SHARED_FIXTURE_RULE", "SPECIFIC_FIXTURE_RULE"],
            parameters: { type: "object", properties: { value: { type: "string" } } },
            async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
          });
        },
      }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendCustomEntry("capability-tool-base", {
      version: 1,
      baseline: ["read", "bash", "edit", "write", "codemode", "fixture_guided"],
      noSchema: ["fixture_guided"],
    });
    session = (await createAgentSession({
      cwd, agentDir: cwd, modelRuntime: runtime, model, sessionManager, settingsManager, resourceLoader,
    })).session;
    await session.bindExtensions({ onError: (error) => { throw error; } });
    await session.prompt("Use the fixture");

    const sections = requests.flatMap((messages) => messages.flatMap((message) =>
      message.role === "system" && message.sections ? [message.sections] : []));
    const guide = (key: string) => sections.map(section => section[key] ?? "").join("\n");
    assert.match(guide("capability-guide-tool-fixture_guided"), /SPECIFIC_FIXTURE_RULE/,
      "the withheld declaration's tool-specific guideline is projected dynamically");
    assert.match(guide("capability-guide-namespace-fixtures"), /SHARED_FIXTURE_RULE/,
      "the canonical namespace guide renders once through its loaded container");
    const rules = sections.map(section => section["rules"] ?? "").join("\n");
    assert.doesNotMatch(rules, /SPECIFIC_FIXTURE_RULE|SHARED_FIXTURE_RULE/,
      "a withheld declaration contributes no native promptGuidelines to <rules>");
    assert.equal(JSON.stringify(requests).split("SPECIFIC_FIXTURE_RULE").length - 1, 1,
      "the tool-specific line is not duplicated");
    assert.equal(JSON.stringify(requests).split("SHARED_FIXTURE_RULE").length - 1, 1,
      "the namespace instructions are not duplicated per tool");
  } finally {
    session?.dispose();
    if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});
