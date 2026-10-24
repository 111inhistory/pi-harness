import assert from "node:assert/strict";
import test from "node:test";
import { FAILURE_REASON_LIMIT, capabilityPublicResult } from "../src/capability-result.mjs";
import { SUBMIT_RESULT_PARAMETERS } from "../src/capability-broker.mjs";

const ranking = { match: "token", score: 10, reason: "matched body" };
const failure = (warnings, extra = {}) => ({
  status: "failed",
  tools: [],
  mcp: [],
  skills: [],
  remote: [{ ref: "npm:@example/pi-tools@1.2.3", status: "needs_approval", ...ranking }],
  coverage: { local: "searched", remote: "not_searched" },
  missingCapabilities: [],
  warnings,
  ...extra,
});

test("Main receives selected resources without ranking or warning diagnostics", () => {
  const result = {
    status: "partial", warnings: ["search degraded"], missingCapabilities: ["gap"],
    coverage: { local: "searched", remote: "not_searched" },
    tools: [{ ref: "namespace://sample", ...ranking, instructions: "Keep guidance", tools: [{ name: "sample", ...ranking, parameters: { properties: { reason: { type: "string" } } } }] }],
    mcp: [{ ref: "mcp://sample", ...ranking }],
    skills: [{ ref: "skill://sample", ...ranking, bindsTo: [], caveats: [], body: "Original score/reason words remain intact" }],
    remote: [{ ref: "npm://sample", status: "needs_approval", ...ranking }],
  };
  const original = structuredClone(result);
  const output = capabilityPublicResult(result);
  assert.equal(output.warnings, undefined);
  for (const hit of [...output.tools, ...output.tools[0].tools, ...output.mcp, ...output.skills]) {
    for (const field of ["match", "score", "reason", "warnings"]) assert.equal(hit[field], undefined);
  }
  assert.equal(output.skills[0].bindsTo, undefined);
  assert.equal(output.skills[0].caveats, undefined);
  assert.equal(output.tools[0].instructions, "Keep guidance");
  assert.deepEqual(output.tools[0].tools[0].parameters.properties.reason, { type: "string" });
  assert.equal(output.skills[0].body, original.skills[0].body);
  assert.deepEqual(output.remote, [], "remote candidates never reach Main while approval is unsupported");
  assert.deepEqual(output.coverage, { local: "searched", remote: "not_searched" });
  assert.deepEqual(output.missingCapabilities, ["gap"]);
  assert.equal(output.status, "partial");
  assert.equal(output.failureReason, undefined, "only a failed discovery exposes a failure reason");
  assert.deepEqual(result, original, "details and internal ranking cannot be mutated");
});

test("a failed discovery explains itself with one compact reason, not the warning catalog", () => {
  const examples = {
    provider: "capability discovery failed: the internal retrieval model errored: Overloaded (529).",
    cancelled: "capability discovery cancelled: the caller aborted before a submission was accepted.",
    budget: "capability discovery failed: the internal discovery budget was exhausted (modelCalls).",
    notDurable:
      "capability discovery failed: the selected resources could not be saved in this session branch, " +
      "so they are not durable: simulated branch record write failure.",
  };
  for (const [name, reason] of Object.entries(examples)) {
    const output = capabilityPublicResult(failure([`${name} diagnostic: internal ranking follows`, reason]));
    assert.equal(output.status, "failed", name);
    assert.equal(output.failureReason, reason, name);
    assert.equal(output.warnings, undefined, name);
    assert.deepEqual(output.remote, [], name);
    assert.deepEqual([output.tools, output.mcp, output.skills], [[], [], []], name);
    const publicText = JSON.stringify(output);
    assert.doesNotMatch(publicText, /internal ranking|needs_approval|npm:/, name);
  }
});

test("failure reasons are first-line, bounded and control-character free", () => {
  const debug = `capability discovery failed: boom.\nDEBUG CATALOG\n- tool://a\n- npm://b\n${"x".repeat(5000)}`;
  const multiline = capabilityPublicResult(failure(["diagnostic", debug]));
  assert.equal(multiline.failureReason, "capability discovery failed: boom.");
  assert.doesNotMatch(JSON.stringify(multiline), /DEBUG CATALOG|tool:\/\/a|npm:\/\/b/);
  assert.equal(multiline.failureReason.includes("\n"), false);

  const control = capabilityPublicResult(failure(["capability discovery failed:\u0000 bad\u001b[31m color\u0007\tnow\nignored"]));
  assert.equal(control.failureReason, "capability discovery failed: bad color now");
  assert.doesNotMatch(control.failureReason, /[\u0000-\u001f\u007f-\u009f]/);

  const long = capabilityPublicResult(failure([`capability discovery failed: ${"y".repeat(400)}`]));
  assert.ok(long.failureReason.length <= FAILURE_REASON_LIMIT);
  assert.equal(long.failureReason.length, FAILURE_REASON_LIMIT);
  assert.match(long.failureReason, /…$/);
  assert.match(long.failureReason, /^capability discovery failed: y/);
});

test("a failed discovery without warnings still has a public reason", () => {
  const output = capabilityPublicResult(failure([]));
  assert.equal(output.failureReason, "capability discovery failed.");
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
