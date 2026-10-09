import assert from "node:assert/strict";
import test from "node:test";
import { capabilityPublicResult } from "../src/capability-result.mjs";
import { SUBMIT_RESULT_PARAMETERS } from "../src/capability-broker.mjs";

const ranking = { match: "token", score: 10, reason: "matched body" };

test("Main receives selected resources without ranking or warning diagnostics", () => {
  const result = {
    status: "partial", warnings: ["search degraded"], missingCapabilities: ["gap"],
    tools: [{ ref: "namespace://sample", ...ranking, instructions: "Keep guidance", tools: [{ name: "sample", ...ranking, parameters: { properties: { reason: { type: "string" } } } }] }],
    mcp: [{ ref: "mcp://sample", ...ranking }],
    skills: [{ ref: "skill://sample", ...ranking, bindsTo: [], caveats: [], body: "Original score/reason words remain intact" }],
    remote: [{ ref: "npm://sample", status: "needs_approval", ...ranking }],
  };
  const original = structuredClone(result);
  const output = capabilityPublicResult(result);
  assert.equal(output.warnings, undefined);
  for (const hit of [...output.tools, ...output.tools[0].tools, ...output.mcp, ...output.skills, ...output.remote]) {
    for (const field of ["match", "score", "reason", "warnings"]) assert.equal(hit[field], undefined);
  }
  assert.equal(output.skills[0].bindsTo, undefined);
  assert.equal(output.skills[0].caveats, undefined);
  assert.equal(output.tools[0].instructions, "Keep guidance");
  assert.deepEqual(output.tools[0].tools[0].parameters.properties.reason, { type: "string" });
  assert.equal(output.skills[0].body, original.skills[0].body);
  assert.equal(output.remote[0].status, "needs_approval");
  assert.deepEqual(output.missingCapabilities, ["gap"]);
  assert.equal(output.status, "partial");
  assert.deepEqual(result, original, "details and internal ranking cannot be mutated");
});

test("non-empty Skill associations and caveats remain task guidance", () => {
  const skill = { ref: "skill://rules", ...ranking, bindsTo: ["namespace://sample"], caveats: [{ summary: "Wait for initialization", sources: [{ section: "Lifecycle" }] }] };
  const output = capabilityPublicResult({ skills: [skill], warnings: [] });
  assert.deepEqual(output.skills[0].bindsTo, skill.bindsTo);
  assert.deepEqual(output.skills[0].caveats, skill.caveats);
});

test("retrieval submission is refs-only, not agent-written ranking or explanations", () => {
  assert.deepEqual(Object.keys(SUBMIT_RESULT_PARAMETERS.properties), ["refs"]);
  assert.deepEqual(SUBMIT_RESULT_PARAMETERS.required, ["refs"]);
  assert.equal(SUBMIT_RESULT_PARAMETERS.additionalProperties, false);
});
