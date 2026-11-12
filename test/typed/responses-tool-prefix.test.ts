import assert from "node:assert/strict";
import test from "node:test";

import { capabilityPublicResult } from "../../src/capability/result.ts";
import { capabilityModelResult, capabilityToolDelta } from "../../src/capability/model-result.ts";
import { retrievalToolLoadout } from "../../src/capability/retrieval-tools.ts";

function tool(name: string, description = name) {
  return { name, description, parameters: { type: "object", properties: {} } };
}

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
  assert.equal(queried.tools[0]!.tools, undefined, "a plain Codemode-only group keeps names out of the compact result");
  assert.equal(queried.tools[0]!.toolCount, 2, "the member count survives the query-path compaction");
  assert.equal(queried.tools[0]!.parameters, undefined, "schemas still move behind describeTool");
  assert.match(String(queried.tools[0]!.interface), /describeTool/);

  const lazy = capabilityModelResult(result, { declared: new Set(), queryable: new Set(["create", "list"]), lazyNames: new Set(["create", "list"]) });
  assert.deepEqual(lazy.tools[0]!.tools?.map((member) => member.name), ["create", "list"], "a lazily projected group keeps the member names");
  assert.equal(lazy.tools[0]!.toolCount, 2, "the member count matches the retained names");
  assert.equal(lazy.tools[0]!.parameters, undefined, "lazy schemas still move behind describeTool");
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
