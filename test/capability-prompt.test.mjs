import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import capabilityExtension from "../extensions/capability.mjs";
import { getCurrentSystemMessage } from "../node_modules/@earendil-works/pi-ai/dist/utils/transcript.js";
import { convertResponsesMessages } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
import { CAPABILITY_SECTION, capabilityPromptTranscript } from "../src/capability/prompt.ts";
import { CAPABILITY_DISCOVERY_RECORD, appendDiscoveryRecord } from "../src/capability/discovery-record.ts";

const head = { role: "system", content: "", sections: { preamble: "Unchanging base" }, timestamp: 0 };
const user = { role: "user", content: "task", timestamp: 1 };
const skill = { ref: "skill://slides", name: "slides", description: "Make slides", filePath: "/skills/slides/SKILL.md", body: "Large on-demand body", score: 100 };
const group = { ref: "namespace://browser", name: "browser", instructions: "Use the current tab", tools: [
  { ref: "tool://pages", name: "pages", description: "List pages", exposure: "deferred" },
  { ref: "tool://click", name: "click", description: "Click", exposure: "codemode" },
] };
const result = (id, details = {}) => ({ role: "toolResult", toolName: "capability", toolCallId: id, content: [{ type: "text", text: "discovery" }], details: { status: "ok", tools: [], mcp: [group], skills: [skill], remote: [{ ref: "npm://candidate", status: "needs_approval" }], ...details }, timestamp: 2 });
const coverage = { local: "searched", remote: "not_searched" };
const recordData = (id, details = {}) => {
  let stored = null;
  appendDiscoveryRecord({ appendEntry: (_customType, data) => { stored = data; } }, id,
    { status: "ok", tools: [], mcp: [group], skills: [skill], ...details }, coverage);
  return stored;
};
const recordEntry = (id, details) => {
  const data = recordData(id, details);
  return data === null ? null : { type: "custom", id: `record-${id}`, customType: CAPABILITY_DISCOVERY_RECORD, data };
};
// Real writes happen before the tool result message is appended, and nested calls
// produce only the custom record. Both shapes must project identically.
const entries = (...messages) => messages.flatMap((message, index) => {
  const entry = { type: "message", id: `e${index}`, message };
  if (message.role !== "toolResult" || message.toolName !== "capability" || message.isError) return [entry];
  const record = recordEntry(message.toolCallId, message.details);
  return record === null ? [entry] : [record, entry];
});
const appendDiscovery = (manager, message) => {
  manager.appendCustomEntry(CAPABILITY_DISCOVERY_RECORD, recordData(message.toolCallId, message.details));
  return manager.appendMessage(message);
};
const section = (messages) => getCurrentSystemMessage(messages)?.sections?.[CAPABILITY_SECTION];
const records = (messages) => JSON.parse(section(messages).split("\n")[2]);

test("discovery appends a native section immediately and preserves original messages", () => {
  const found = result("a");
  const messages = [head, user, found];
  const before = structuredClone(messages);
  const projected = capabilityPromptTranscript(messages, entries(...messages));
  assert.deepEqual(projected.slice(0, 3), messages);
  assert.equal(projected[3].role, "system");
  assert.doesNotMatch(section(projected), /skill:\/\//);
  assert.match(section(projected), /\/skills\/slides\/SKILL.md/);
  assert.match(section(projected), /Use the current tab/);
  assert.match(section(projected), /pages/);
  assert.doesNotMatch(section(projected), /Large on-demand body|score|npm:\/\/candidate/);
  assert.deepEqual(messages, before);
  assert.deepEqual(capabilityPromptTranscript(projected, entries(...messages)), projected);
});

test("repeated discoveries produce no redundant patches, later guidance preserves members", () => {
  const first = result("a");
  const second = result("b");
  const third = result("c", { mcp: [], skills: [], guidance: [{ ref: group.ref, name: group.name, instructions: "Updated shared guidance" }] });
  const messages = [head, user, first, second, third];
  const projected = capabilityPromptTranscript(messages, entries(...messages));
  assert.equal(projected.filter((message) => message.sections?.[CAPABILITY_SECTION]).length, 2);
  const remembered = records(projected).find((hit) => hit.ref === group.ref);
  assert.equal(remembered.instructions, "Updated shared guidance");
  assert.deepEqual(remembered.tools.map((tool) => tool.name), ["pages", "click"]);
});

test("native compaction and repeated compaction rehydrate from branch details, not summary", () => {
  const sm = SessionManager.inMemory("/test");
  sm.appendMessage(head);
  sm.appendMessage(user);
  appendDiscovery(sm, result("a"));
  const keep = sm.appendMessage({ ...user, content: "continue", timestamp: 3 });
  sm.appendCompaction("Summary deliberately forgets skills and browser", keep, 100);
  const branch = sm.getBranch();
  const projected = capabilityPromptTranscript(sm.buildSessionProjection().messages, branch);
  assert.match(projected[0].sections[CAPABILITY_SECTION], /\/skills\/slides\/SKILL.md/);
  assert.match(projected[0].sections[CAPABILITY_SECTION], /namespace:\/\/browser/);
  const next = result("b", { skills: [{ ...skill, ref: "/skills/analysis/SKILL.md", filePath: "/skills/analysis/SKILL.md", name: "analysis" }] });
  appendDiscovery(sm, next);
  const immediately = capabilityPromptTranscript(sm.buildSessionProjection().messages, sm.getBranch());
  assert.deepEqual(immediately[0], projected[0], "new discovery must not rewrite the compacted head");
  assert.match(section(immediately), /\/skills\/analysis\/SKILL.md/);
  const keepAgain = sm.appendMessage({ ...user, content: "continue again", timestamp: 4 });
  sm.appendCompaction("Still no discovery facts", keepAgain, 100);
  const twice = capabilityPromptTranscript(sm.buildSessionProjection().messages, sm.getBranch());
  assert.match(section(twice), /\/skills\/slides\/SKILL.md/);
  assert.match(section(twice), /\/skills\/analysis\/SKILL.md/);
  // Reconstructed manager models reload/inherited raw entries with no in-memory cache.
  const restored = SessionManager.inMemory("/test", {}, [sm.getHeader(), ...sm.getBranch()]);
  assert.deepEqual(capabilityPromptTranscript(restored.buildSessionProjection().messages, restored.getBranch()), twice);
});

test("branch selection, failures and tool scope are respected without changing permissions", () => {
  const first = result("a");
  const failed = { ...result("b", { skills: [{ ...skill, ref: "/skills/failed/SKILL.md", filePath: "/skills/failed/SKILL.md" }] }), isError: true };
  const partial = result("c", { status: "partial", mcp: [], tools: [{ ref: "tool://denied", name: "denied", kind: "tool" }], skills: [] });
  const branch = entries(first, failed, partial);
  const projected = capabilityPromptTranscript([head, user], branch, { allowsTool: (name) => name === "pages" });
  assert.deepEqual(records(projected).find((hit) => hit.ref === group.ref).tools.map((tool) => tool.name), ["pages"]);
  assert.doesNotMatch(section(projected), /\/skills\/failed|tool:\/\/denied|tool:\/\/click/);
  assert.deepEqual(capabilityPromptTranscript([head, user], []), [head, user], "another branch cannot retain these discoveries");
});

test("Responses wire prefix is unchanged on append; folding providers retain current memory", () => {
  const model = { api: "openai-codex-responses", provider: "openai-codex", id: "offline", reasoning: true, input: ["text"] };
  const options = { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true };
  const first = result("a");
  const initial = capabilityPromptTranscript([head, user, first], entries(first));
  const second = result("b", { skills: [{ ...skill, ref: "/skills/analysis/SKILL.md", filePath: "/skills/analysis/SKILL.md" }] });
  const appended = capabilityPromptTranscript([head, user, first, second], entries(first, second));
  const wire = (messages, opts = options) => convertResponsesMessages(model, { messages }, new Set([model.provider]), opts);
  const before = wire(initial);
  assert.deepEqual(wire(appended).slice(0, before.length), before);
  const collapsed = JSON.stringify(wire(appended, { supportsMidConvoSystemMessages: false }));
  assert.match(collapsed, /\/skills\/slides\/SKILL.md/);
  assert.match(collapsed, /\/skills\/analysis\/SKILL.md/);
});

test("real SDK extension exposes discovery on the next turn and after manual compaction", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-capability-prompt-"));
  let session;
  try {
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
    assert.ok(model);
    runtime.getAuth = async () => ({ auth: { apiKey: "offline-test-only" }, env: {} });
    runtime.hasConfiguredAuth = () => true;
    const requests = [];
    runtime.streamSimple = (_model, context) => {
      requests.push(structuredClone(context.messages));
      const first = requests.length === 1;
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: first ? [{ type: "toolCall", id: "sdk-discovery", name: "capability", arguments: {} }] : [{ type: "text", text: "done" }],
        stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    };
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0 }, cacheWarming: { mode: "off" } });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [{ name: "discovery-memory-test", factory(pi) {
        capabilityExtension(pi, { discovery: false });
        pi.registerTool({ name: "capability", label: "Fixture discovery", description: "Offline discovery result", parameters: { type: "object", properties: {} },
          execute: async (toolCallId) => {
            const details = result("sdk-discovery", { mcp: [] }).details;
            appendDiscoveryRecord(pi, toolCallId, details, coverage);
            return { content: [{ type: "text", text: "selected" }], details };
          },
        });
        pi.on("session_before_compact", (event) => ({ compaction: { summary: "Deliberately forget all discoveries", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
      } }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model, sessionManager: SessionManager.inMemory(cwd), settingsManager, resourceLoader }));
    const errors = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    await session.prompt("Discover capabilities");
    assert.equal(requests.length, 2);
    assert.equal(section(requests[0]), undefined);
    assert.match(section(requests[1]), /\/skills\/slides\/SKILL.md/);
    assert.deepEqual(requests[1].slice(0, requests[0].length), requests[0]);
    await session.compact();
    await session.prompt("Continue without rediscovery");
    assert.equal(requests.length, 3);
    assert.match(section(requests[2]), /\/skills\/slides\/SKILL.md/);
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
