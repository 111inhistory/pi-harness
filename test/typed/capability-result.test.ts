/**
 * Projection of Capability discovery outcomes:
 * 1. Public result: Main receives selected resources without ranking diagnostics,
 *    internal status or shared guidance instructions, and gets bounded reasons on partial/failed.
 * 2. Branch memory: Canonical local hits are persisted in versioned discovery records,
 *    excluding remote artifacts and diagnostics. Stored records are non-authoritative
 *    and filtered by current tool permissions; tool-result details never supply memory.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_DISCOVERY_RECORD,
  appendDiscoveryRecord,
  discoveryRecords,
  normalizeDiscoveryMemory,
} from "../../src/capability/discovery-record.ts";
import { CAPABILITY_SECTION, capabilityPromptTranscript } from "../../src/capability/prompt.ts";
import {
  FAILURE_REASON_LIMIT,
  capabilityPublicResult,
  type CapabilityPublicHit,
} from "../../src/capability/result.ts";

const ranking = { match: "bm25", score: 10, reason: "matched body" };
const coverage = { local: "searched" as const, remote: "not_searched" as const };

const tool = {
  ref: "tool://slides",
  name: "slides",
  description: "Render slides",
  kind: "tool",
  status: "available",
  exposure: "direct",
  path: "/internal/index",
  ...ranking,
};

const remote = {
  ref: "npm:@example/pi-slides@1.2.3",
  name: "@example/pi-slides",
  kind: "package",
  status: "needs_approval",
  ...ranking,
};

const group = {
  ref: "namespace://deck",
  name: "deck",
  instructions: "Use the active deck",
  tools: [
    {
      ref: "tool://deck_pages",
      name: "deck_pages",
      description: "List pages",
      exposure: "deferred",
      parameters: { properties: { reason: { type: "string" } } },
      ...ranking,
    },
  ],
};

const skill = {
  ref: "/skills/rules/SKILL.md",
  name: "rules",
  filePath: "/skills/rules/SKILL.md",
  body: "Original score/reason words remain intact",
  ...ranking,
};

function assertNoDiagnostics(hits: readonly CapabilityPublicHit[]): void {
  for (const hit of hits) {
    for (const field of ["match", "score", "reason", "warnings", "status", "available", "exposure", "source", "path"]) {
      assert.equal(field in hit, false, `hit exposes ${field}`);
    }
    if (hit.tools) assertNoDiagnostics(hit.tools);
  }
}

function failure(warnings: readonly string[], extra: Record<string, unknown> = {}) {
  return {
    status: "failed",
    tools: [],
    mcp: [],
    skills: [],
    remote: [remote],
    coverage,
    missingCapabilities: [],
    warnings,
    ...extra,
  };
}

function writer() {
  const entries: { customType: string; data?: unknown }[] = [];
  return {
    entries,
    pi: { appendEntry: (customType: string, data?: unknown) => { entries.push({ customType, data }); } },
  };
}

// ---------------------------------------------------------------------------
// Public result projection (model-facing return value for Main)
// ---------------------------------------------------------------------------

test("Main receives selected resources without ranking or warning diagnostics", () => {
  const result = {
    status: "partial",
    warnings: ["search degraded"],
    missingCapabilities: ["gap"],
    coverage,
    tools: [group],
    mcp: [{ ref: "mcp://sample/server", ...ranking }],
    skills: [skill],
    remote: [remote],
  };
  const original = structuredClone(result);

  const output = capabilityPublicResult(result);
  assert.equal("warnings" in output, false);
  assertNoDiagnostics([...(output.tools ?? []), ...(output.mcp ?? []), ...(output.skills ?? [])]);

  const [namespace] = output.tools ?? [];
  assert.ok(namespace);
  assert.equal(namespace.instructions, undefined, "canonical request memory injects shared guidance once");
  const [member] = namespace.tools ?? [];
  assert.ok(member);
  assert.deepEqual(member.parameters, { properties: { reason: { type: "string" } } });

  const [pubSkill] = output.skills ?? [];
  assert.ok(pubSkill);
  assert.equal(pubSkill.body, "Original score/reason words remain intact");
  assert.equal(pubSkill.filePath, "/skills/rules/SKILL.md");

  assert.deepEqual(output.remote, [], "remote candidates never reach Main");
  assert.deepEqual(output.coverage, coverage);
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

// ---------------------------------------------------------------------------
// Canonical branch records & non-authoritative prompt memory
// ---------------------------------------------------------------------------

test("the persisted memory keeps canonical local hits and excludes remote artifacts and diagnostics", () => {
  const memory = normalizeDiscoveryMemory({
    status: "partial",
    tools: [tool, group],
    mcp: [],
    skills: [skill],
    guidance: [{ ref: group.ref, name: group.name, instructions: "Updated guidance" }],
    remote: [remote],
    warnings: ["skill body read failed"],
    missingCapabilities: ["nothing else"],
  }, coverage);

  assert.equal(memory.status, "partial");
  assert.deepEqual(memory.tools.map((hit) => hit.ref), [tool.ref, group.ref]);
  assert.deepEqual(memory.tools[1]?.tools?.map((hit) => hit.name), ["deck_pages"]);
  assert.equal(memory.tools[1]?.tools?.[0]?.description, "List pages");
  assert.equal(memory.skills[0]?.filePath, "/skills/rules/SKILL.md");
  assert.deepEqual(memory.guidance?.map((hit) => hit.ref), [group.ref]);
  assert.deepEqual(memory.coverage, coverage);
  assert.equal("remote" in memory, false, "no remote candidate is ever persisted");
  assert.equal("warnings" in memory, false, "diagnostics are not capability memory");
  assert.equal("missingCapabilities" in memory, false);
  for (const hit of memory.tools) {
    assert.equal("score" in hit, false);
    assert.equal("match" in hit, false);
    assert.equal("reason" in hit, false);
  }
});

test("only successful discoveries are written, in a versioned custom entry", () => {
  const failed = writer();
  assert.equal(appendDiscoveryRecord(failed.pi, "call-1", { status: "failed", tools: [], mcp: [], skills: [], remote: [] }, coverage), null);
  assert.deepEqual(failed.entries, [], "a failure must not be remembered as a completed discovery");

  const ok = writer();
  const memory = appendDiscoveryRecord(ok.pi, "call-2", { status: "ok", tools: [tool], mcp: [], skills: [], remote: [remote] }, coverage);
  assert.equal(ok.entries.length, 1);
  assert.equal(ok.entries[0]?.customType, CAPABILITY_DISCOVERY_RECORD);
  const record = ok.entries[0]?.data as { version: number; toolCallId: string; result: unknown };
  assert.equal(record.version, 1);
  assert.equal(record.toolCallId, "call-2");
  assert.deepEqual(record.result, memory);
  assert.equal(JSON.stringify(record).includes("npm:"), false);
});

test("branch records are the only source, and stored remote artifacts never reach the request", () => {
  const memory = normalizeDiscoveryMemory({ status: "ok", tools: [tool], mcp: [], skills: [] }, coverage);
  const branch = [
    { type: "custom", customType: CAPABILITY_DISCOVERY_RECORD, data: { version: 1, toolCallId: "nested", result: memory } },
    // A corrupted/hand-written record still cannot smuggle a remote candidate in.
    {
      type: "custom",
      customType: CAPABILITY_DISCOVERY_RECORD,
      data: {
        version: 1,
        toolCallId: "nested-old",
        result: { status: "ok", tools: [remote], mcp: [], skills: [], coverage, remote: [remote] },
      },
    },
    { type: "custom", customType: "something-else", data: { version: 1 } },
    { type: "custom", customType: CAPABILITY_DISCOVERY_RECORD, data: { version: 99, toolCallId: "future", result: memory } },
  ];
  assert.deepEqual(discoveryRecords(branch).map((r) => r.toolCallId), ["nested", "nested-old"]);
  assert.equal(discoveryRecords([]).length, 0);

  const projected = capabilityPromptTranscript(
    [{ role: "system", content: "base", sections: { preamble: "Base" }, timestamp: 0 }, { role: "user", content: "task", timestamp: 1 }],
    branch,
  );
  const section = projected[0]?.sections?.[CAPABILITY_SECTION];
  assert.ok(section);
  assert.match(section, /tool:\/\/slides/);
  assert.doesNotMatch(section, /npm:|needs_approval/);
});

test("the record does not decide execution: projection filters by current permissions", () => {
  const memory = normalizeDiscoveryMemory({ status: "ok", tools: [tool, group], mcp: [], skills: [] }, coverage);
  const branch = [{ type: "custom", customType: CAPABILITY_DISCOVERY_RECORD, data: { version: 1, result: memory } }];
  const head = [{ role: "system", content: "base", sections: { preamble: "Base" }, timestamp: 0 }];
  const allowed = capabilityPromptTranscript(head, branch, { allowsTool: () => true });
  const denied = capabilityPromptTranscript(head, branch, { allowsTool: () => false });
  assert.match(allowed[0]?.sections?.[CAPABILITY_SECTION] ?? "", /tool:\/\/slides/);
  assert.doesNotMatch(denied[0]?.sections?.[CAPABILITY_SECTION] ?? "", /tool:\/\/slides|namespace:\/\/deck/);
});

test("tool-result details never supply memory; records anchor visible and nested calls", () => {
  const memory = normalizeDiscoveryMemory({ status: "ok", tools: [tool], mcp: [], skills: [] }, coverage);
  const visibleMessage = {
    role: "toolResult",
    toolName: "capability",
    toolCallId: "call-7",
    content: [],
    details: {
      status: "ok",
      tools: [],
      mcp: [],
      skills: [{ ref: "skill://stale-details", name: "stale-details", description: "Must not be used" }],
    },
    timestamp: 2,
  };
  const branch = [
    // Real write order: the record is appended before the tool result message.
    { type: "custom", id: "r1", customType: CAPABILITY_DISCOVERY_RECORD, data: { version: 1, toolCallId: "call-7", result: memory } },
    { type: "message", id: "m1", message: visibleMessage },
    // A nested call has a record but no transcript result at all.
    { type: "custom", id: "r2", customType: CAPABILITY_DISCOVERY_RECORD, data: { version: 1, toolCallId: "parent-1/1", result: memory } },
  ];
  const projected = capabilityPromptTranscript(
    [{ role: "system", content: "base", sections: { preamble: "Base" }, timestamp: 0 }, visibleMessage],
    branch,
  );
  const section = projected.findLast((m) => m.sections?.[CAPABILITY_SECTION])?.sections?.[CAPABILITY_SECTION];
  assert.ok(section);
  assert.match(section, /tool:\/\/slides/);
  assert.doesNotMatch(section, /skill:\/\/stale-details/, "tool-result details are never read");
  assert.equal(section.match(/tool:\/\/slides/g)?.length, 1, "the same discovery is not counted twice");

  // Nested canonical record only (no visible result) also projects.
  const nested = capabilityPromptTranscript(
    [{ role: "system", content: "base", sections: { preamble: "Base" }, timestamp: 0 }],
    branch,
  );
  const nestedSection = nested.findLast((m) => m.sections?.[CAPABILITY_SECTION])?.sections?.[CAPABILITY_SECTION];
  assert.match(nestedSection ?? "", /tool:\/\/slides/);
});
