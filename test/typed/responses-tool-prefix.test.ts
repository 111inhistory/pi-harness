import assert from "node:assert/strict";
import test from "node:test";

import type { Message, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
import { resolveTranscriptTools } from "../../node_modules/@earendil-works/pi-ai/dist/utils/transcript.js";

import { capabilityPublicResult } from "../../src/capability/result.ts";
import type { ProjectionMessage } from "../../src/capability/prompt.ts";
import { capabilityModelResult, capabilityToolDelta } from "../../src/capability/model-result.ts";
import { retrievalToolLoadout } from "../../src/capability/retrieval-tools.ts";
import { providerSessionPolicy } from "../../src/provider-session.ts";
import { additiveToolTranscript } from "../../src/session-transcript.ts";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as UnknownRecord;
}

function tool(name: string, description = name) {
  return { name, description, parameters: { type: "object", properties: {} } };
}

const model = {
  api: "openai-codex-responses",
  compat: { supportsAdditionalTools: true, supportsMidConvoSystemMessages: true },
  provider: "openai-codex",
  id: "offline",
  reasoning: true,
  input: ["text"],
} as unknown as Model<"openai-codex-responses">;

function messageAt(messages: readonly ProjectionMessage[], index: number): ProjectionMessage {
  const message = messages[index];
  assert.ok(message);
  return message;
}

function responsesWire(messages: readonly ProjectionMessage[]): readonly unknown[] {
  return convertResponsesMessages(
    model,
    { messages: messages as unknown as Message[] } as TranscriptContext,
    new Set([model.provider]),
    {
      includeSystemPrompt: false,
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools: true,
    },
  ) as unknown as readonly unknown[];
}

function wireTools(wire: readonly unknown[]): UnknownRecord[] {
  return wire.flatMap((item) => {
    const entry = record(item);
    if (entry["type"] !== "additional_tools" || !Array.isArray(entry["tools"])) return [];
    return entry["tools"].map((tool) => record(tool));
  });
}

test("additive Responses requires both transport and model compatibility", () => {
  assert.equal(providerSessionPolicy(model).toolSupport, "changes");
  assert.equal(providerSessionPolicy({ ...model, api: "anthropic-messages" }).transport, "anthropic");
  assert.equal(providerSessionPolicy({ ...model, compat: { supportsAdditionalTools: true } }).toolSupport, "none");
  assert.equal(providerSessionPolicy({ ...model, compat: { supportsToolSearch: true, supportsMidConvoSystemMessages: true } }).toolSupport, "additions");
});

test("disable, re-enable and description changes preserve the original declaration prefix", () => {
  const initial = { role: "system", content: "original", toolsAdded: [tool("read"), tool("codemode")], timestamp: 0 };
  const messages: ProjectionMessage[] = [
    initial,
    { role: "user", content: "task", timestamp: 1 },
    { role: "system", content: "", toolsRemoved: [{ name: "read" }], timestamp: 2 },
    { role: "system", content: "", toolsAdded: [tool("subagent_create")], timestamp: 3 },
    { role: "system", content: "", toolsAdded: [tool("read"), tool("codemode", "new inline tools")], toolsRemoved: [{ name: "codemode" }], timestamp: 4 },
  ];
  const before = structuredClone(messages);
  const projected = additiveToolTranscript(messages);
  assert.equal(projected[0], initial);
  assert.equal(projected[1], messages[1]);
  assert.match(String(messageAt(projected, 2).content), /read is unavailable.*Do not call/);
  assert.match(String(messageAt(projected, 4).content), /read is available again/);
  assert.match(String(messageAt(projected, 4).content), /codemode has updated interface/);
  assert.ok(projected.every((message) => !message.toolsRemoved));
  // Pi 1.4 native declarations: the transport supports in-place changes, so no tool is
  // folded into the top-level request field and every system message keeps its changes.
  const resolution = resolveTranscriptTools(projected as unknown as readonly { role: string }[], "changes");
  assert.deepEqual(resolution.requestTools, []);
  assert.equal(resolution.foldedSystemMessages, 0);
  const declared = wireTools(responsesWire(projected));
  assert.deepEqual(declared.map((entry) => entry["name"]), ["read", "codemode", "subagent_create", "codemode"]);
  // The same-name redeclaration reaches the request; the latest definition replaces the earlier one.
  assert.equal(declared.at(-1)?.["description"], "new inline tools");
  assert.deepEqual(declared.at(-1)?.["parameters"], { type: "object", properties: {} });
  assert.deepEqual(messages, before, "projection cannot mutate stored history or permission state");
  assert.deepEqual(additiveToolTranscript(projected), projected, "projection is idempotent");
});

test("a same-name schema change is replayed as a replacement declaration, not dropped", () => {
  const oldSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  const newSchema = { type: "object", properties: { uri: { type: "string" }, limit: { type: "number" } }, required: ["uri"] };
  const messages: ProjectionMessage[] = [
    { role: "system", content: "base", toolsAdded: [{ name: "read", description: "Read", parameters: oldSchema }], timestamp: 0 },
    { role: "user", content: "task", timestamp: 1 },
    { role: "system", content: "", toolsAdded: [{ name: "read", description: "Read a URI", parameters: newSchema }], timestamp: 2 },
  ];
  const projected = additiveToolTranscript(messages);
  const readDeclarations = wireTools(responsesWire(projected)).filter((entry) => entry["name"] === "read");
  assert.equal(readDeclarations.length, 2, "the change is declared to the model, not merely noted");
  assert.equal(readDeclarations.at(-1)?.["description"], "Read a URI");
  assert.deepEqual(readDeclarations.at(-1)?.["parameters"], newSchema);
  assert.match(String(messageAt(projected, 2).content), /read has updated interface/);
  assert.deepEqual(additiveToolTranscript(projected), projected, "a projected replacement must not be lost or duplicated");
});

test("retrieval placeholders reject execution and derive allowed names from the retrieval tools", async () => {
  const allowed = { ...tool("capability_step"), label: "Step", execute: async () => "stepped" };
  const parentWrite = async () => "parent write";
  const loadout = retrievalToolLoadout(
    [{ role: "system", toolsAdded: [{ ...tool("write"), execute: parentWrite }, tool("codemode")] }],
    [allowed],
  );
  assert.deepEqual(loadout.map((entry) => entry.name), ["write", "codemode", "capability_step"]);
  assert.notEqual(loadout[0]!.execute, parentWrite);
  await assert.rejects(loadout[0]!.execute(), /unavailable in capability discovery/);
  await assert.rejects(loadout[1]!.execute(), /Only capability_step may execute/);
  assert.equal(await loadout[2]!.execute(), "stepped");
});

test("Capability emits only new tool interfaces and leaves shared guidance to branch memory", () => {
  const group = { ref: "namespace://subagent", name: "subagent", instructions: "Keep shared rules", toolCount: 2, tools: [tool("create"), tool("list")] };
  const result = { status: "ok", tools: [tool("read"), tool("write"), tool("codemode"), group, tool("deferred_entry")], mcp: [], skills: [{ ref: "skill://ppt-master" }], warnings: [] };
  const original = structuredClone(result);
  const delta = capabilityToolDelta(result, new Set(["read", "write", "codemode", "list"]));
  assert.deepEqual(delta.tools.map((hit) => hit.name), ["subagent", "deferred_entry"]);
  assert.deepEqual(delta.tools[0]!.tools?.map((hit) => hit.name), ["create"]);
  assert.equal(delta.tools[0]!.toolCount, 1);
  assert.deepEqual(delta.skills, result.skills);
  const repeated = capabilityToolDelta(result, new Set(["read", "write", "codemode", "list", "create", "deferred_entry"]));
  assert.deepEqual(repeated.tools, []);
  assert.equal(repeated.guidance, undefined, "already-active groups do not synthesize a second guidance copy");
  assert.deepEqual(result, original, "full details remain unchanged");
});

test("compact only when a native declaration or Codemode query path supplies the interface; retain count and diagnostics", () => {
  const group = { ref: "namespace://subagent", name: "subagent", kind: "namespace", status: "available", description: "generic", instructions: "Task guidance", toolCount: 2, tools: [tool("create"), tool("list")] };
  const deferred = { ...group, ref: "namespace://deferred", tools: [tool("deferred")] };
  const result = { status: "partial", tools: [group, deferred], mcp: [], skills: [{ ref: "/skills/rules/SKILL.md", filePath: "/skills/rules/SKILL.md" }], warnings: ["warning"], missingCapabilities: ["gap"] };
  const original = structuredClone(result);
  const compact = capabilityModelResult(result, { declared: new Set(["create", "list"]) });
  assert.equal(compact.tools[0]!.tools, undefined);
  assert.equal(compact.tools[0]!.description, undefined);
  assert.equal(compact.tools[0]!.instructions, undefined, "request memory owns the shared guidance");
  assert.equal(compact.tools[0]!.ref, "namespace://subagent", "the stable group ref survives compaction");
  assert.equal(compact.tools[0]!.name, "subagent", "the stable group name survives compaction");
  assert.equal(compact.tools[0]!.toolCount, 2, "the selected member count survives compaction");
  assert.equal(compact.tools[0]!.status, undefined, "availability is implied and not repeated");
  assert.match(String(compact.tools[0]!.interface), /tool declaration/);
  assert.deepEqual(compact.tools[1], deferred, "a hit without a supplied interface stays fully expanded");

  const queried = capabilityModelResult(result, { declared: new Set(), queryable: new Set(["create", "list"]) });
  assert.deepEqual(queried.tools[0]!.tools?.map((member) => member.name), ["create", "list"], "the member names survive the Codemode query-path compaction");
  assert.equal(queried.tools[0]!.toolCount, 2, "the member count stays consistent with the retained names");
  assert.equal(queried.tools[0]!.parameters, undefined, "schemas still move behind describeTool");
  assert.match(String(queried.tools[0]!.interface), /describeTool/);
  assert.deepEqual(queried.tools[1], deferred, "an inactive or undiscoverable member keeps its definition");

  const fallback = capabilityModelResult(result, { declared: new Set() });
  assert.deepEqual(fallback.tools, result.tools, "without either interface source the full definitions remain");
  const fallbackPublic = capabilityPublicResult(fallback);
  assert.deepEqual(fallbackPublic.tools?.[0]?.parameters, undefined, "this fallback hit has no supplied schema to preserve");
  assert.equal(fallbackPublic.tools?.[0]?.instructions, undefined, "fallback also leaves guidance to request memory");
  const fallbackWithSchema = capabilityPublicResult({
    status: "partial",
    tools: [{ ...group, parameters: { type: "object", properties: { prompt: { type: "string" } } } }],
    mcp: [],
    skills: [],
  });
  assert.deepEqual(fallbackWithSchema.tools?.[0]?.parameters, { type: "object", properties: { prompt: { type: "string" } } }, "fallback schemas stay intact");
  assert.equal(fallbackWithSchema.tools?.[0]?.instructions, undefined);
  for (const field of ["skills", "warnings", "missingCapabilities", "status"] as const) assert.deepEqual(compact[field], result[field]);
  assert.deepEqual(result, original);
});
