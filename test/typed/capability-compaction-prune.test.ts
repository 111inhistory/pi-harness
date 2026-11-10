/**
 * Focused unit and integration tests for Capability compaction pruning:
 * - Direct tool execution and detectable admission failure handling
 * - Nested Codemode execution (durationMs completion criterion)
 * - Structural window interval extraction (index-based, no clock)
 * - Group/member pruning semantics (partial keeps members, full drops prose and guidance)
 * - Manual grants and baseline tools protection
 * - Chronological folding & rediscovery without permanent tombstones
 * - Unavailable hits do not restore pruned status
 * - Admission declares() gating for ordinary non-MCP tools
 * - Real SessionManager disk persistence and reload
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  appendDiscoveryRecord,
  appendPruneRecord,
  discoveryRecords,
  latestPruneRecord,
  prunedToolNames,
} from "../../src/capability/discovery-record.ts";
import {
  computePrunableCapabilities,
  extractUsedToolsFromWindow,
  extractWindowEntries,
  recordCompactionPruning,
} from "../../src/capability/pruning.ts";
import { createToolAdmission } from "../../src/capability/admission.ts";

const coverage = { local: "searched" as const, remote: "not_searched" as const };

function memoryWriter() {
  const entries: { customType: string; data?: unknown }[] = [];
  return {
    entries,
    pi: {
      appendEntry: (customType: string, data?: unknown) => {
        entries.push({ customType, data });
      },
    },
  };
}

function sessionWriter(manager: SessionManager) {
  return {
    appendEntry: (customType: string, data?: unknown) => {
      manager.appendCustomEntry(customType, data);
    },
  };
}

function userMessage(text: string) {
  return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1000 };
}

function assistantToolCall(name: string, callId: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "toolCall" as const, id: callId, name, arguments: {} }],
    api: "test-api" as const,
    provider: "test-provider",
    model: "test-model",
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
    stopReason: "toolUse" as const,
    timestamp: 1010,
  };
}

function toolResultMessage(toolName: string, callId: string, text: string, isError = false, durationMs?: number) {
  return {
    role: "toolResult" as const,
    toolCallId: callId,
    toolName,
    content: [{ type: "text" as const, text }],
    isError,
    ...(durationMs !== undefined ? { durationMs } : {}),
    timestamp: 1020,
  };
}

function nestedToolResultMessage(
  parentToolName: string,
  callId: string,
  nestedCalls: { name: string; durationMs?: number }[],
) {
  return {
    role: "toolResult" as const,
    toolCallId: callId,
    toolName: parentToolName,
    content: [{ type: "text" as const, text: "codemode result" }],
    isError: false,
    nestedCalls: { calls: nestedCalls.map((c, i) => ({ id: `${callId}/${i}`, ...c })) },
    timestamp: 1030,
  };
}

test("extractWindowEntries extracts entries strictly between compactions without timestamps", () => {
  const branch = [
    { id: "e1", type: "message", message: userMessage("start") },
    { id: "c1", type: "compaction", summary: "first compaction" },
    { id: "e2", type: "message", message: userMessage("turn 2") },
    { id: "e3", type: "message", message: userMessage("turn 3") },
    { id: "c2", type: "compaction", summary: "second compaction" },
    { id: "e4", type: "message", message: userMessage("turn 4") },
  ];

  // Window before c1: only e1
  const w1 = extractWindowEntries(branch, "c1");
  assert.deepEqual(w1.map((e: any) => e.id), ["e1"]);

  // Window before c2: strictly between c1 and c2 (e2, e3)
  const w2 = extractWindowEntries(branch, "c2");
  assert.deepEqual(w2.map((e: any) => e.id), ["e2", "e3"]);

  // Window with no compactionId passed uses tail (after c2)
  const wTail = extractWindowEntries(branch, null);
  assert.deepEqual(wTail.map((e: any) => e.id), ["e4"]);
});

test("extractUsedToolsFromWindow counts completed direct executions and filters admission failures", () => {
  const windowEntries = [
    {
      type: "message",
      message: toolResultMessage("tool_success", "call_1", "ok executed", false),
    },
    {
      type: "message",
      message: toolResultMessage("tool_exec_err_with_dur", "call_2", "Command failed", true, 45),
    },
    {
      type: "message",
      message: toolResultMessage("tool_old_undecidable_err", "call_3", "Unexpected syntax error in input", true),
    },
    {
      type: "message",
      message: toolResultMessage(
        "tool_blocked_unavail",
        "call_4",
        "Tool tool_blocked_unavail is unavailable in this session; retained declarations do not enable execution.",
        true,
      ),
    },
    {
      type: "message",
      message: toolResultMessage(
        "tool_blocked_manual",
        "call_5",
        "Tool tool_blocked_manual is manual and requires explicit user authorization in this session.",
        true,
      ),
    },
  ];

  const used = extractUsedToolsFromWindow(windowEntries);
  assert.equal(used.has("tool_success"), true, "successful direct call counted");
  assert.equal(used.has("tool_exec_err_with_dur"), true, "actual execution error with durationMs counted");
  assert.equal(used.has("tool_old_undecidable_err"), true, "undecidable non-admission error conservatively counted");
  assert.equal(used.has("tool_blocked_unavail"), false, "unavailable admission block not counted");
  assert.equal(used.has("tool_blocked_manual"), false, "manual admission block not counted");
});

test("extractUsedToolsFromWindow counts nested Codemode calls only with valid durationMs", () => {
  const windowEntries = [
    {
      type: "message",
      message: nestedToolResultMessage("codemode", "call_cm", [
        { name: "nested_finished", durationMs: 125 },
        { name: "nested_zero_ms", durationMs: 0 },
        { name: "nested_unfinished" }, // undefined durationMs
      ]),
    },
  ];

  const used = extractUsedToolsFromWindow(windowEntries);
  assert.equal(used.has("codemode"), true, "outer tool is counted");
  assert.equal(used.has("nested_finished"), true, "completed nested call counted");
  assert.equal(used.has("nested_zero_ms"), true, "0ms completed call counted");
  assert.equal(used.has("nested_unfinished"), false, "unfinished nested call without durationMs dropped");
});

test("computePrunableCapabilities computes partial group pruning and full group removal", () => {
  const { pi, entries } = memoryWriter();

  // Discovery:
  // - namespace group "namespace://docker" with members [docker_ps, docker_build]
  // - MCP server "mcp://github" with members [gh_issue]
  // - standalone tool "tool://metrics"
  appendDiscoveryRecord(
    pi,
    "call_disc",
    {
      status: "ok",
      tools: [
        {
          ref: "namespace://docker",
          name: "docker",
          description: "Docker containers",
          instructions: "Use docker safely",
          tools: [
            { ref: "tool://docker_ps", name: "docker_ps", description: "List containers" },
            { ref: "tool://docker_build", name: "docker_build", description: "Build image" },
          ],
        },
        {
          ref: "tool://metrics",
          name: "metrics",
          description: "Inspect metrics",
        },
      ],
      mcp: [
        {
          ref: "mcp://github",
          name: "github",
          description: "GitHub MCP",
          instructions: "GitHub server",
          tools: [{ ref: "tool://gh_issue", name: "gh_issue", description: "GitHub issue" }],
        },
      ],
      skills: [{ ref: "/skill/lint", name: "lint", filePath: "/skill/lint/SKILL.md" }],
    },
    coverage,
  );

  const discoveryCustomEntry = { id: "d1", type: "custom", customType: "capability-discovery", data: entries[0]!.data };

  // Only docker_ps was used in window
  const branch = [
    discoveryCustomEntry,
    { type: "message", message: toolResultMessage("docker_ps", "call_p", "container list") },
    { id: "comp_1", type: "compaction", summary: "Compacted conversation" },
  ];

  const result = computePrunableCapabilities({
    branch,
    checkpointId: "comp_1",
    protectedTools: ["read", "bash"],
  });

  assert.equal(result.checkpointId, "comp_1");
  assert.deepEqual([...result.removedTools].sort(), ["docker_build", "gh_issue", "metrics"]);
  assert.deepEqual(result.removedGroups, ["mcp://github"]);
});

test("discoveryRecords drops fully removed group guidance and prose entirely", () => {
  const branch: any[] = [];
  const writer = {
    appendEntry: (customType: string, data?: unknown) => {
      branch.push({ id: `entry_${branch.length + 1}`, type: "custom", customType, data });
    },
  };

  // Group with guidance
  appendDiscoveryRecord(
    writer,
    "call_init",
    {
      status: "ok",
      tools: [
        {
          ref: "namespace://docker",
          name: "docker",
          instructions: "Docker guidance text",
          tools: [{ ref: "tool://docker_run", name: "docker_run" }],
        },
      ],
      mcp: [],
      skills: [],
      guidance: [{ ref: "namespace://docker", name: "docker", instructions: "Docker guidance text" }],
    },
    coverage,
  );

  // Prune docker_run and namespace://docker
  branch.push({ id: "comp_1", type: "compaction", summary: "compaction summary" });
  appendPruneRecord(writer, "comp_1", ["docker_run"], ["namespace://docker"]);

  const folded = discoveryRecords(branch);
  assert.equal(folded.length, 1);
  assert.equal(folded[0]?.result.tools.length, 0, "group hit dropped");
  assert.equal(folded[0]?.result.guidance, undefined, "guidance for fully pruned group is completely omitted");
});

test("successive member pruning removes old guidance without reviving metadata on rediscovery", () => {
  const branch: unknown[] = [];
  const writer = {
    appendEntry(customType: string, data?: unknown) {
      branch.push({ type: "custom", customType, data });
    },
  };
  appendDiscoveryRecord(writer, "old", {
    status: "ok",
    tools: [{ ref: "namespace://fixture", name: "fixture", tools: [
      { ref: "tool://fixture_a", name: "fixture_a" },
      { ref: "tool://fixture_b", name: "fixture_b" },
    ] }],
    mcp: [], skills: [],
    guidance: [{ ref: "namespace://fixture", instructions: "Old group guidance", tools: [
      { ref: "tool://fixture_a", name: "fixture_a" },
      { ref: "tool://fixture_b", name: "fixture_b" },
    ] }],
  }, coverage);
  appendPruneRecord(writer, "checkpoint_a", ["fixture_a"]);
  appendDiscoveryRecord(writer, "new_a", {
    status: "ok", tools: [{ ref: "tool://fixture_a", name: "fixture_a", description: "New A metadata" }],
    mcp: [], skills: [],
  }, coverage);
  appendPruneRecord(writer, "checkpoint_b", ["fixture_b"]);
  appendDiscoveryRecord(writer, "new_b", {
    status: "ok", tools: [{ ref: "tool://fixture_b", name: "fixture_b", description: "New B metadata" }],
    mcp: [], skills: [],
  }, coverage);

  const records = discoveryRecords(branch);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0]?.result.tools, []);
  assert.equal(records[0]?.result.guidance, undefined, "separate removals exhaust the old group's members");
  assert.equal(records[1]?.result.tools[0]?.name, "fixture_a");
  assert.equal(records[1]?.result.tools[0]?.description, "New A metadata");
  assert.equal(records[2]?.result.tools[0]?.name, "fixture_b");
  assert.equal(records[2]?.result.tools[0]?.description, "New B metadata");
});

test("discoveryRecords folds prune records chronologically and preserves skills", () => {
  const branch: any[] = [];
  const writer = {
    appendEntry: (customType: string, data?: unknown) => {
      branch.push({ id: `entry_${branch.length + 1}`, type: "custom", customType, data });
    },
  };

  // 1. Initial discovery
  appendDiscoveryRecord(
    writer,
    "call_init",
    {
      status: "ok",
      tools: [
        {
          ref: "namespace://docker",
          name: "docker",
          instructions: "Docker guidance",
          tools: [
            { ref: "tool://docker_ps", name: "docker_ps" },
            { ref: "tool://docker_build", name: "docker_build" },
          ],
        },
        { ref: "tool://standalone", name: "standalone" },
      ],
      mcp: [
        {
          ref: "mcp://github",
          name: "github",
          instructions: "GitHub guidance",
          tools: [{ ref: "tool://gh_issue", name: "gh_issue" }],
        },
      ],
      skills: [{ ref: "/skills/test/SKILL.md", name: "test", filePath: "/skills/test/SKILL.md" }],
    },
    coverage,
  );

  // 2. Compaction and prune record
  branch.push({ id: "comp_1", type: "compaction", summary: "compaction summary" });
  appendPruneRecord(writer, "comp_1", ["docker_build", "standalone", "gh_issue"], ["mcp://github"]);

  // Inspect folded discovery records
  const folded = discoveryRecords(branch);
  assert.equal(folded.length, 1, "keeps discovery records");

  const disc = folded[0]!;
  // docker namespace survived with only docker_ps
  assert.equal(disc.result.tools.length, 1);
  assert.equal(disc.result.tools[0]?.ref, "namespace://docker");
  assert.deepEqual(disc.result.tools[0]?.tools?.map((t) => t.name), ["docker_ps"]);

  // mcp://github had 0 tools left and was in removedGroups -> completely dropped with its guidance
  assert.equal(disc.result.mcp.length, 0);

  // skills are preserved
  assert.equal(disc.result.skills.length, 1);
  assert.equal(disc.result.skills[0]?.filePath, "/skills/test/SKILL.md");

  // Pruned set check
  const pruned = prunedToolNames(branch);
  assert.equal(pruned.has("docker_build"), true);
  assert.equal(pruned.has("standalone"), true);
  assert.equal(pruned.has("gh_issue"), true);
  assert.equal(pruned.has("docker_ps"), false);

  const latest = latestPruneRecord(branch);
  assert.equal(latest?.checkpointId, "comp_1");
  assert.deepEqual(latest?.removedTools, ["docker_build", "standalone", "gh_issue"]);
});

test("rediscovery after compaction clears pruned status without permanent tombstone", () => {
  const branch: any[] = [];
  const writer = {
    appendEntry: (customType: string, data?: unknown) => {
      branch.push({ id: `entry_${branch.length + 1}`, type: "custom", customType, data });
    },
  };

  // Discovery 1
  appendDiscoveryRecord(
    writer,
    "call_1",
    {
      status: "ok",
      tools: [{ ref: "tool://docker_build", name: "docker_build" }],
      mcp: [],
      skills: [],
    },
    coverage,
  );

  // Compaction 1 prunes docker_build
  branch.push({ id: "comp_1", type: "compaction", summary: "c1" });
  appendPruneRecord(writer, "comp_1", ["docker_build"]);

  // Verify pruned
  assert.equal(prunedToolNames(branch).has("docker_build"), true);
  const folded1 = discoveryRecords(branch);
  assert.equal(folded1[0]?.result.tools.length, 0);

  // Later Discovery 2 re-discovers docker_build after comp_1
  appendDiscoveryRecord(
    writer,
    "call_2",
    {
      status: "ok",
      tools: [{ ref: "tool://docker_build", name: "docker_build" }],
      mcp: [],
      skills: [],
    },
    coverage,
  );

  // Verify restored naturally
  assert.equal(prunedToolNames(branch).has("docker_build"), false, "pruned status cleared by newer discovery");
  const folded2 = discoveryRecords(branch);
  assert.equal(folded2.length, 2);
  assert.equal(folded2[0]?.result.tools.length, 0, "first discovery stays pruned");
  assert.equal(folded2[1]?.result.tools.length, 1, "second discovery has docker_build");
  assert.equal(folded2[1]?.result.tools[0]?.name, "docker_build");
});

test("prunedToolNames does not clear removals on a later unavailable hit", () => {
  const branch: any[] = [];
  const writer = {
    appendEntry: (customType: string, data?: unknown) => {
      branch.push({ id: `entry_${branch.length + 1}`, type: "custom", customType, data });
    },
  };

  // Initial discovery and prune
  appendDiscoveryRecord(writer, "c1", {
    status: "ok",
    tools: [{ ref: "tool://flake", name: "flake" }],
    mcp: [],
    skills: [],
  }, coverage);
  branch.push({ id: "comp_1", type: "compaction", summary: "c1" });
  appendPruneRecord(writer, "comp_1", ["flake"]);

  assert.equal(prunedToolNames(branch).has("flake"), true);

  // Subsequent discovery returns hit with status: "unavailable"
  appendDiscoveryRecord(writer, "c2", {
    status: "partial",
    tools: [{ ref: "tool://flake", name: "flake", status: "unavailable" }],
    mcp: [],
    skills: [],
  }, coverage);

  assert.equal(prunedToolNames(branch).has("flake"), true, "unavailable hit does not clear pruned status");
});

test("createToolAdmission gates declares() against derived pruned set and restores on rediscovery", () => {
  const branch: any[] = [];
  const writer = {
    appendEntry: (customType: string, data?: unknown) => {
      branch.push({ id: `entry_${branch.length + 1}`, type: "custom", customType, data });
    },
  };

  const host = {
    getAllTools: () => [
      { name: "docker_build" },
      { name: "mcp__gh__issue", namespace: { name: "mcp__gh", aliases: ["gh"] } },
      { name: "manual_edit" },
    ],
    getActiveTools: () => ["docker_build", "mcp__gh__issue", "manual_edit"],
  };

  // Discover ordinary tool docker_build and MCP tool mcp__gh__issue
  appendDiscoveryRecord(
    writer,
    "call_1",
    {
      status: "ok",
      tools: [{ ref: "tool://docker_build", name: "docker_build" }],
      mcp: [
        {
          ref: "mcp://gh",
          name: "gh",
          tools: [{ ref: "tool://mcp__gh__issue", name: "mcp__gh__issue" }],
        },
      ],
      skills: [],
    },
    coverage,
  );

  // Canonical enable for manual_edit
  writer.appendEntry("capability-tool-permission", {
    version: 1,
    set: [{ target: "manual_edit", state: "enabled" }],
  });

  // Before compaction: admission declares all three
  const admissionBefore = createToolAdmission(host as any, branch);
  assert.equal(admissionBefore.declares("docker_build"), true);
  assert.equal(admissionBefore.declares("mcp__gh__issue"), true);
  assert.equal(admissionBefore.declares("manual_edit"), true);

  // Compaction 1: prunes docker_build and mcp__gh__issue
  branch.push({ id: "comp_1", type: "compaction", summary: "c1" });
  appendPruneRecord(writer, "comp_1", ["docker_build", "mcp__gh__issue"], ["mcp://gh"]);

  // After compaction: admission rejects pruned tools while canonical enable survives
  const admissionAfter = createToolAdmission(host as any, branch);
  assert.equal(admissionAfter.declares("docker_build"), false, "ordinary non-MCP tool gated when pruned");
  assert.equal(admissionAfter.declares("mcp__gh__issue"), false, "pruned MCP tool not declared");
  assert.equal(admissionAfter.declares("manual_edit"), true, "explicitly enabled tool still declared");

  // Re-discovery of docker_build
  appendDiscoveryRecord(
    writer,
    "call_2",
    {
      status: "ok",
      tools: [{ ref: "tool://docker_build", name: "docker_build" }],
      mcp: [],
      skills: [],
    },
    coverage,
  );

  const admissionRestored = createToolAdmission(host as any, branch);
  assert.equal(admissionRestored.declares("docker_build"), true, "re-discovered ordinary tool declared again");
  assert.equal(admissionRestored.declares("mcp__gh__issue"), false, "still pruned MCP tool remains undeclared");
});

test("real SessionManager persists compaction pruning and survives disk reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-prune-test-"));
  try {
    const manager = SessionManager.create("/tmp/work", dir);
    const writer = sessionWriter(manager);
    manager.appendMessage(userMessage("discover tools"));

    appendDiscoveryRecord(
      writer,
      "call_d",
      {
        status: "ok",
        tools: [
          { ref: "tool://active_tool", name: "active_tool" },
          { ref: "tool://unused_tool", name: "unused_tool" },
        ],
        mcp: [],
        skills: [],
      },
      coverage,
    );

    // Call active_tool
    manager.appendMessage(assistantToolCall("active_tool", "call_act"));
    manager.appendMessage(toolResultMessage("active_tool", "call_act", "result ok"));

    // Compact
    const compId = manager.appendCompaction("Compacted state", null, 500, undefined, true);

    // Record pruning
    const prune = recordCompactionPruning(writer, {
      branch: manager.getBranch(),
      checkpointId: compId,
      protectedTools: ["read"],
    });

    assert.notEqual(prune, null);
    assert.deepEqual(prune?.removedTools, ["unused_tool"]);

    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile && sessionFile.length > 0);

    // Reopen session from JSONL on disk
    const reopened = SessionManager.open(sessionFile, dir);
    const reopenedBranch = reopened.getBranch();

    // Verify pruned status survived on disk reload
    const pruned = prunedToolNames(reopenedBranch);
    assert.equal(pruned.has("unused_tool"), true, "unused_tool pruned on reloaded branch");
    assert.equal(pruned.has("active_tool"), false, "active_tool preserved on reloaded branch");

    const records = discoveryRecords(reopenedBranch);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0]?.result.tools.map((t) => t.name), ["active_tool"]);

    const latest = latestPruneRecord(reopenedBranch);
    assert.equal(latest?.checkpointId, compId);
    assert.deepEqual(latest?.removedTools, ["unused_tool"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated compaction windows prune successively across independent intervals", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-prune-repeat-"));
  try {
    const manager = SessionManager.create("/tmp/work", dir);
    const writer = sessionWriter(manager);

    // Initial discovery: toolA, toolB, toolC
    appendDiscoveryRecord(
      writer,
      "call_init",
      {
        status: "ok",
        tools: [
          { ref: "tool://toolA", name: "toolA" },
          { ref: "tool://toolB", name: "toolB" },
          { ref: "tool://toolC", name: "toolC" },
        ],
        mcp: [],
        skills: [],
      },
      coverage,
    );

    // Window 1: only toolA and toolB are used
    manager.appendMessage(toolResultMessage("toolA", "c1", "res A"));
    manager.appendMessage(toolResultMessage("toolB", "c2", "res B"));

    // Compaction 1: toolC should be pruned
    const comp1Id = manager.appendCompaction("Summary 1", null, 100, undefined, true);
    const prune1 = recordCompactionPruning(writer, {
      branch: manager.getBranch(),
      checkpointId: comp1Id,
    });

    assert.notEqual(prune1, null);
    assert.deepEqual(prune1?.removedTools, ["toolC"]);
    assert.equal(prunedToolNames(manager.getBranch()).has("toolC"), true);
    assert.equal(prunedToolNames(manager.getBranch()).has("toolA"), false);
    assert.equal(prunedToolNames(manager.getBranch()).has("toolB"), false);

    // Window 2: only toolA is used; toolB is NOT used in Window 2
    manager.appendMessage(toolResultMessage("toolA", "c3", "res A turn 2"));

    // Compaction 2: toolB should now be pruned!
    const comp2Id = manager.appendCompaction("Summary 2", null, 200, undefined, true);
    const prune2 = recordCompactionPruning(writer, {
      branch: manager.getBranch(),
      checkpointId: comp2Id,
    });

    assert.notEqual(prune2, null);
    assert.deepEqual(prune2?.removedTools, ["toolB"]);

    // Effective state after Compaction 2
    const prunedAfter2 = prunedToolNames(manager.getBranch());
    assert.equal(prunedAfter2.has("toolB"), true, "toolB pruned at Compaction 2");
    assert.equal(prunedAfter2.has("toolC"), true, "toolC still pruned from Compaction 1");
    assert.equal(prunedAfter2.has("toolA"), false, "toolA used in both windows remains active");

    const effective = discoveryRecords(manager.getBranch());
    assert.equal(effective.length, 1);
    assert.deepEqual(effective[0]?.result.tools.map((t) => t.name), ["toolA"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("branch tree forking isolates pruning to downstream branch only", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-prune-fork-"));
  try {
    const manager = SessionManager.create("/tmp/work", dir);
    const writer = sessionWriter(manager);
    manager.appendMessage(userMessage("root message"));

    appendDiscoveryRecord(
      writer,
      "call_d",
      {
        status: "ok",
        tools: [{ ref: "tool://feature_x", name: "feature_x" }],
        mcp: [],
        skills: [],
      },
      coverage,
    );

    const forkPointId = manager.getLeafId()!;

    // Continue on main branch: feature_x not used, compact, and prune
    const compId = manager.appendCompaction("Compacted main", null, 300, undefined, true);
    recordCompactionPruning(writer, {
      branch: manager.getBranch(),
      checkpointId: compId,
    });

    assert.equal(prunedToolNames(manager.getBranch()).has("feature_x"), true);

    // Create a branched session from forkPointId (before compaction)
    const sessionFile = manager.getSessionFile()!;
    const branched = SessionManager.open(sessionFile, dir);
    assert.ok(branched.createBranchedSession(forkPointId));

    // The branched session does not see the compaction or prune record
    const branchedBranch = branched.getBranch();
    assert.equal(prunedToolNames(branchedBranch).has("feature_x"), false, "fork before compaction preserves tool");
    const branchedRecords = discoveryRecords(branchedBranch);
    assert.equal(branchedRecords.length, 1);
    assert.deepEqual(branchedRecords[0]?.result.tools.map((t) => t.name), ["feature_x"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("protectedTools preserves an unused discovered tool that unprotected candidate pruning removes", () => {
  const { pi, entries } = memoryWriter();

  // Two discovered tools in the same candidate source
  appendDiscoveryRecord(
    pi,
    "call_d",
    {
      status: "ok",
      tools: [
        { ref: "tool://disc_tool", name: "disc_tool" },
        { ref: "tool://protected_tool", name: "protected_tool" },
      ],
      mcp: [],
      skills: [],
    },
    coverage,
  );

  const branch = [
    { id: "e1", type: "custom", customType: "capability-discovery", data: entries[0]!.data },
    { id: "comp_1", type: "compaction", summary: "c1" },
  ];

  // 1. Unprotected control: both unused discovered tools are prunable
  const unpruned = computePrunableCapabilities({
    branch,
    checkpointId: "comp_1",
  });
  assert.deepEqual([...unpruned.removedTools].sort(), ["disc_tool", "protected_tool"]);

  // 2. Protected test: protectedTools preserves protected_tool while disc_tool is still removed
  const prunable = computePrunableCapabilities({
    branch,
    checkpointId: "comp_1",
    protectedTools: ["protected_tool"],
  });
  assert.deepEqual(prunable.removedTools, ["disc_tool"]);
  assert.equal(prunable.removedTools.includes("protected_tool"), false);
});
