import assert from "node:assert/strict";
import test from "node:test";

import {
  FAILURE_REASON_LIMIT,
  capabilityPublicResult,
  type CapabilityPublicHit,
} from "../../src/capability/result.ts";

const ranking = { match: "bm25", score: 10, reason: "matched body" };

function failure(warnings: readonly string[], extra: Record<string, unknown> = {}) {
  return {
    status: "failed",
    tools: [],
    mcp: [],
    skills: [],
    remote: [{ ref: "npm:@example/pi-tools@1.2.3", status: "needs_approval", ...ranking }],
    coverage: { local: "searched", remote: "not_searched" },
    missingCapabilities: [],
    warnings,
    ...extra,
  };
}

function assertNoDiagnostics(hits: readonly CapabilityPublicHit[]): void {
  for (const hit of hits) {
    for (const field of ["match", "score", "reason", "warnings", "status", "available", "exposure", "source", "path"]) {
      assert.equal(field in hit, false, `hit exposes ${field}`);
    }
    if (hit.tools) assertNoDiagnostics(hit.tools);
  }
}

test("Main receives selected resources without ranking or warning diagnostics", () => {
  const result = {
    status: "partial",
    warnings: ["search degraded"],
    missingCapabilities: ["gap"],
    coverage: { local: "searched", remote: "not_searched" },
    tools: [
      {
        ref: "namespace://sample",
        ...ranking,
        instructions: "Keep guidance",
        tools: [
          {
            name: "sample",
            ...ranking,
            parameters: { properties: { reason: { type: "string" } } },
          },
        ],
      },
    ],
    mcp: [{ ref: "mcp://sample/server", ...ranking }],
    skills: [
      {
        ref: "/skills/sample/SKILL.md",
        filePath: "/skills/sample/SKILL.md",
        ...ranking,
        body: "Original score/reason words remain intact",
      },
    ],
    remote: [{ ref: "npm://sample", status: "needs_approval", ...ranking }],
  };
  const original = structuredClone(result);

  const output = capabilityPublicResult(result);
  assert.equal("warnings" in output, false);
  assertNoDiagnostics([...(output.tools ?? []), ...(output.mcp ?? []), ...(output.skills ?? [])]);

  const [namespace] = output.tools ?? [];
  assert.ok(namespace);
  assert.equal(namespace.instructions, "Keep guidance");
  const [member] = namespace.tools ?? [];
  assert.ok(member);
  assert.deepEqual(member.parameters, { properties: { reason: { type: "string" } } });

  const [skill] = output.skills ?? [];
  assert.ok(skill);
  assert.equal(skill.body, "Original score/reason words remain intact");
  assert.equal(skill.filePath, "/skills/sample/SKILL.md");

  assert.deepEqual(output.remote, [], "remote candidates never reach Main");
  assert.deepEqual(output.coverage, { local: "searched", remote: "not_searched" });
  assert.deepEqual(output.missingCapabilities, ["gap"]);
  assert.equal(output.status, "partial");
  assert.equal(output.failureReason, undefined, "only a failed discovery exposes a failure reason");
  assert.equal(output.partialReason, "search degraded", "a partial publication carries one short visible reason");
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
    assert.equal(output.partialReason, undefined, name);
    assert.equal("warnings" in output, false, name);
    assert.deepEqual(output.remote, [], name);
    assert.deepEqual([output.tools, output.mcp, output.skills], [[], [], []], name);
    assert.doesNotMatch(JSON.stringify(output), /internal ranking|needs_approval|npm:/, name);
  }
});

test("failure reasons are first-line, bounded and control-character free", () => {
  const debug = `capability discovery failed: boom.\nDEBUG CATALOG\n- tool://a\n- npm://b\n${"x".repeat(5000)}`;
  const multiline = capabilityPublicResult(failure(["diagnostic", debug]));
  assert.equal(multiline.failureReason, "capability discovery failed: boom.");
  assert.doesNotMatch(JSON.stringify(multiline), /DEBUG CATALOG|tool:\/\/a|npm:\/\/b/);

  const control = capabilityPublicResult(
    failure(["capability discovery failed:\u0000 bad\u001b[31m color\u0007\tnow\nignored"]),
  );
  assert.equal(control.failureReason, "capability discovery failed: bad color now");
  assert.doesNotMatch(control.failureReason ?? "", /[\u0000-\u001f\u007f-\u009f]/);

  const long = capabilityPublicResult(failure([`capability discovery failed: ${"y".repeat(400)}`]));
  assert.equal(long.failureReason?.length, FAILURE_REASON_LIMIT);
  assert.match(long.failureReason ?? "", /…$/);
  assert.match(long.failureReason ?? "", /^capability discovery failed: y/);
});

test("a failed discovery without warnings still has a public reason", () => {
  const output = capabilityPublicResult(failure([]));
  assert.equal(output.failureReason, "capability discovery failed.");
});

test("a partial discovery always carries a bounded visible reason", () => {
  const output = capabilityPublicResult({ status: "partial", tools: [], mcp: [], skills: [], warnings: [] });
  assert.equal(
    output.partialReason,
    "capability discovery is partial; some selected resources were not published.",
  );
  const long = capabilityPublicResult({
    status: "partial",
    tools: [],
    mcp: [],
    skills: [],
    warnings: [`capability discovery is partial: ${"z".repeat(500)}`],
  });
  assert.equal(long.partialReason?.length, FAILURE_REASON_LIMIT);
  assert.match(long.partialReason ?? "", /…$/);
});
