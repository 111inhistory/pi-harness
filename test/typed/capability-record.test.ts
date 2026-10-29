import assert from "node:assert/strict";
import test from "node:test";

import {
  appendDiscoveryRecord,
  CAPABILITY_DISCOVERY_RECORD,
  discoveryRecords,
  normalizeDiscoveryMemory,
} from "../../src/capability/discovery-record.ts";
import { CAPABILITY_SECTION, capabilityPromptTranscript } from "../../src/capability/prompt.ts";

const coverage = { local: "searched", remote: "not_searched" };
const tool = {
  ref: "tool://slides",
  name: "slides",
  description: "Render slides",
  kind: "tool",
  status: "available",
  exposure: "direct",
  match: "name",
  score: 9,
  reason: "matched the name",
  path: "/internal/index",
};
const remote = {
  ref: "npm:@example/pi-slides@1.2.3",
  name: "@example/pi-slides",
  kind: "package",
  status: "needs_approval",
  match: "name",
  score: 4,
};
const group = {
  ref: "namespace://deck",
  name: "deck",
  instructions: "Use the active deck",
  tools: [{ ref: "tool://deck_pages", name: "deck_pages", description: "List pages", exposure: "deferred", score: 2 }],
};

function writer() {
  const entries: { customType: string; data?: unknown }[] = [];
  return {
    entries,
    pi: { appendEntry: (customType: string, data?: unknown) => { entries.push({ customType, data }); } },
  };
}

test("the persisted memory keeps canonical local hits and excludes remote artifacts and diagnostics", () => {
  const memory = normalizeDiscoveryMemory({
    status: "partial",
    tools: [tool, group],
    mcp: [],
    skills: [{ ref: "/skills/rules/SKILL.md", name: "rules", filePath: "/skills/rules/SKILL.md" }],
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
  const records = discoveryRecords(branch);
  assert.deepEqual(records.map((record) => record.toolCallId), ["nested", "nested-old"]);
  const projected = capabilityPromptTranscript(
    [{ role: "system", content: "base", sections: { preamble: "Base" }, timestamp: 0 }, { role: "user", content: "task", timestamp: 1 }],
    branch,
  );
  const section = projected[0]?.sections?.[CAPABILITY_SECTION];
  assert.ok(section);
  assert.match(section, /tool:\/\/slides/);
  assert.doesNotMatch(section, /npm:|needs_approval/);

  // A different branch has no memory at all.
  assert.equal(discoveryRecords([]).length, 0);
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


type Sectioned = {
  role?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  details?: unknown;
  timestamp?: number;
  sections?: Record<string, string>;
};

/** The last projected `<capabilities>` section, anchored or folded. */
function projectedSection(messages: Sectioned[]): string | undefined {
  let section: string | undefined;
  for (const message of messages) {
    const value = message.sections?.[CAPABILITY_SECTION];
    if (typeof value === "string") section = value;
  }
  return section;
}

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
  ) as unknown as Sectioned[];
  const section = projectedSection(projected);
  assert.ok(section);
  assert.match(section, /tool:\/\/slides/);
  assert.doesNotMatch(section, /skill:\/\/stale-details/, "tool-result details are never read");
  assert.equal(section.match(/tool:\/\/slides/g)?.length, 1, "the same discovery is not counted twice");

  // Nested canonical record only (no visible result) also projects.
  const nested = capabilityPromptTranscript(
    [{ role: "system", content: "base", sections: { preamble: "Base" }, timestamp: 0 }],
    branch,
  ) as unknown as Sectioned[];
  assert.match(projectedSection(nested) ?? "", /tool:\/\/slides/);
});
