import assert from "node:assert/strict";
import test from "node:test";
import { resolveTranscriptTools } from "../node_modules/@earendil-works/pi-ai/dist/utils/transcript.js";
import { convertResponsesMessages } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
import { additiveToolTranscript, capabilityModelResult, capabilityToolDelta, retrievalToolLoadout, supportsAdditiveResponses } from "../src/responses-tool-prefix.mjs";

const tool = (name, description = name) => ({ name, description, parameters: { type: "object", properties: {} } });
const model = { api: "openai-codex-responses", compat: { supportsAdditionalTools: true, supportsMidConvoSystemMessages: true }, provider: "openai-codex", id: "offline", reasoning: true, input: ["text"] };

test("additive Responses requires both transport and model compatibility", () => {
  assert.equal(supportsAdditiveResponses(model), true);
  assert.equal(supportsAdditiveResponses({ ...model, api: "anthropic-messages" }), false);
  assert.equal(supportsAdditiveResponses({ ...model, compat: { supportsAdditionalTools: true } }), false);
  assert.equal(supportsAdditiveResponses({ ...model, compat: { supportsToolSearch: true, supportsMidConvoSystemMessages: true } }), true);
});

test("disable, re-enable and description changes preserve the original declaration prefix", () => {
  const initial = { role: "system", content: "original", toolsAdded: [tool("read"), tool("codemode")], timestamp: 0 };
  const messages = [initial,
    { role: "user", content: "task", timestamp: 1 },
    { role: "system", content: "", toolsRemoved: [{ name: "read" }], timestamp: 2 },
    { role: "system", content: "", toolsAdded: [tool("subagent_create")], timestamp: 3 },
    { role: "system", content: "", toolsAdded: [tool("read"), tool("codemode", "new inline tools")], toolsRemoved: [{ name: "codemode" }], timestamp: 4 },
  ];
  const before = structuredClone(messages);
  const projected = additiveToolTranscript(messages);
  assert.equal(projected[0], initial);
  assert.equal(projected[1], messages[1]);
  assert.match(projected[2].content, /read is unavailable.*Do not call/);
  assert.match(projected[4].content, /read is available again/);
  assert.match(projected[4].content, /codemode has updated interface/);
  assert.ok(projected.every((message) => !message.toolsRemoved));
  // Pi 1.4 native declarations: the transport supports in-place changes, so no tool is
  // folded into the top-level request field and every system message keeps its changes.
  const resolution = resolveTranscriptTools(projected, "changes");
  assert.deepEqual(resolution.requestTools, []);
  assert.equal(resolution.foldedSystemMessages, 0);
  const wire = convertResponsesMessages(model, { messages: projected }, new Set([model.provider]), {
    includeSystemPrompt: false, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true,
  });
  const declared = wire.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools);
  assert.deepEqual(declared.map((entry) => entry.name), ["read", "codemode", "subagent_create", "codemode"]);
  // The same-name redeclaration reaches the request; the latest definition replaces the earlier one.
  assert.equal(declared.at(-1).description, "new inline tools");
  assert.deepEqual(declared.at(-1).parameters, { type: "object", properties: {} });
  assert.deepEqual(messages, before, "projection cannot mutate stored history or permission state");
  assert.deepEqual(additiveToolTranscript(projected), projected, "projection is idempotent");
});

test("a same-name schema change is replayed as a replacement declaration, not dropped", () => {
  const oldSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  const newSchema = { type: "object", properties: { uri: { type: "string" }, limit: { type: "number" } }, required: ["uri"] };
  const messages = [
    { role: "system", content: "base", toolsAdded: [{ name: "read", description: "Read", parameters: oldSchema }], timestamp: 0 },
    { role: "user", content: "task", timestamp: 1 },
    { role: "system", content: "", toolsAdded: [{ name: "read", description: "Read a URI", parameters: newSchema }], timestamp: 2 },
  ];
  const projected = additiveToolTranscript(messages);
  const wire = convertResponsesMessages(model, { messages: projected }, new Set([model.provider]), {
    includeSystemPrompt: false, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true,
  });
  const readDeclarations = wire.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools).filter((entry) => entry.name === "read");
  assert.equal(readDeclarations.length, 2, "the change is declared to the model, not merely noted");
  assert.equal(readDeclarations.at(-1).description, "Read a URI");
  assert.deepEqual(readDeclarations.at(-1).parameters, newSchema);
  assert.match(projected[2].content, /read has updated interface/);
  assert.deepEqual(additiveToolTranscript(projected), projected, "a projected replacement must not be lost or duplicated");
});

test("retrieval placeholders reject execution without obtaining parent handles", async () => {
  const allowed = { ...tool("capability_search"), label: "Search", execute: async () => "searched" };
  const loadout = retrievalToolLoadout([{ role: "system", toolsAdded: [tool("write"), tool("codemode")] }], [allowed]);
  assert.deepEqual(loadout.map((entry) => entry.name), ["write", "codemode", "capability_search"]);
  await assert.rejects(loadout[0].execute(), /unavailable in capability discovery/);
  await assert.rejects(loadout[1].execute(), /Only capability_search and submit_result/);
  assert.equal(await loadout[2].execute(), "searched");
});

test("Capability emits only new tool interfaces, preserving existing namespace guidance", () => {
  const group = { ref: "namespace://subagent", name: "subagent", instructions: "Keep shared rules", toolCount: 2, tools: [tool("create"), tool("list")] };
  const result = { status: "ok", tools: [tool("read"), tool("write"), tool("codemode"), group, tool("deferred_entry")], mcp: [], skills: [{ ref: "skill://ppt-master" }], warnings: [] };
  const original = structuredClone(result);
  const delta = capabilityToolDelta(result, new Set(["read", "write", "codemode", "list"]));
  assert.deepEqual(delta.tools.map((hit) => hit.name), ["subagent", "deferred_entry"]);
  assert.deepEqual(delta.tools[0].tools.map((hit) => hit.name), ["create"]);
  assert.equal(delta.tools[0].toolCount, 1);
  assert.deepEqual(delta.skills, result.skills);
  const repeated = capabilityToolDelta(result, new Set(["read", "write", "codemode", "list", "create", "deferred_entry"]));
  assert.deepEqual(repeated.tools, []);
  assert.deepEqual(repeated.guidance, [{ ref: group.ref, name: group.name, instructions: group.instructions }]);
  assert.deepEqual(result, original, "full details remain unchanged");
});

test("compact only actually declared interfaces; retain guidance, deferred refs and errors", () => {
  const group = { ref: "namespace://subagent", name: "subagent", kind: "namespace", status: "available", description: "generic", instructions: "Task guidance", toolCount: 2, tools: [tool("create"), tool("list")] };
  const deferred = { ...group, ref: "namespace://deferred", tools: [tool("deferred")] };
  const result = { status: "partial", tools: [group, deferred], mcp: [], skills: [{ ref: "/skills/rules/SKILL.md", filePath: "/skills/rules/SKILL.md" }], warnings: ["warning"], missingCapabilities: ["gap"] };
  const original = structuredClone(result);
  const compact = capabilityModelResult(result, new Set(["create", "list"]));
  assert.equal(compact.tools[0].tools, undefined);
  assert.equal(compact.tools[0].description, undefined);
  assert.equal(compact.tools[0].instructions, "Task guidance");
  assert.match(compact.tools[0].interface, /tool loadout/);
  assert.deepEqual(compact.tools[1], deferred);
  for (const field of ["skills", "warnings", "missingCapabilities", "status"]) assert.deepEqual(compact[field], result[field]);
  assert.deepEqual(result, original);
});
