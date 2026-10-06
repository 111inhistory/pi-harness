import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  appendCleanJsonl,
  getSubagentHistoryPaths,
  writeCompactedSummary,
} from "../src/subagent-history.mjs";

test("subagent-history: appendCleanJsonl strips streaming chunks and logs semantic lines", async () => {
  const tmpDir = path.join("/tmp", `test-hist-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  try {
    const id = "sub_01";
    const { cleanJsonl } = getSubagentHistoryPaths(id, tmpDir);

    // Stream chunk should be ignored
    await appendCleanJsonl(id, { type: "stream_chunk", text: "partial" }, { baseDir: tmpDir });
    assert.equal(fs.existsSync(cleanJsonl), false);

    // Semantic events should be appended
    await appendCleanJsonl(id, { type: "message_start", role: "assistant" }, { baseDir: tmpDir });
    await appendCleanJsonl(id, { type: "tool_call", name: "bash", input: { command: "ls" } }, { baseDir: tmpDir });
    await appendCleanJsonl(id, { type: "tool_result", name: "bash", isError: false }, { baseDir: tmpDir });
    await appendCleanJsonl(id, { type: "message_end", role: "assistant", content: "done" }, { baseDir: tmpDir });

    assert.equal(fs.existsSync(cleanJsonl), true);
    const lines = fs.readFileSync(cleanJsonl, "utf-8").trim().split("\n");
    assert.equal(lines.length, 4);

    const first = JSON.parse(lines[0]);
    assert.equal(first.type, "message_start");
    assert.equal(first.role, "assistant");
    assert.ok(first.timestamp > 0);

    const second = JSON.parse(lines[1]);
    assert.equal(second.type, "tool_call");
    assert.equal(second.name, "bash");
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("subagent-history: writeCompactedSummary generates OMP-style markdown and appends on revive", async () => {
  const tmpDir = path.join("/tmp", `test-hist-summary-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  try {
    const id = "sub_01";
    const { summary } = getSubagentHistoryPaths(id, tmpDir);

    // Round 1
    await writeCompactedSummary(
      id,
      {
        name: "ParserAudit",
        task: "Check parser errors",
        role: "reviewer",
        model: "gemini-pro",
        budget: { modelCalls: 5, activeTimeMs: 12000 },
        toolCalls: [{ tool: "bash", input: { command: "npm test" }, isError: false }],
        result: "Found no syntax issues in recovery paths.",
        status: "completed",
        round: 1,
      },
      { baseDir: tmpDir },
    );

    assert.equal(fs.existsSync(summary), true);
    let md = fs.readFileSync(summary, "utf-8");
    assert.ok(md.includes("# Subagent Summary: ParserAudit (sub_01)"));
    assert.ok(md.includes("Found no syntax issues in recovery paths."));
    assert.ok(md.includes("`bash`: {\"command\":\"npm test\"}"));

    // Round 2 (Revive Continuation)
    await writeCompactedSummary(
      id,
      {
        name: "ParserAudit",
        task: "Check parser errors",
        budget: { modelCalls: 8, activeTimeMs: 18000 },
        toolCalls: [{ tool: "bash", input: { command: "git diff" }, isError: false }],
        result: "Verified diff is clean.",
        status: "completed",
        round: 2,
      },
      { append: true, baseDir: tmpDir },
    );

    md = fs.readFileSync(summary, "utf-8");
    assert.ok(md.includes("## Continuation / Round 2"));
    assert.ok(md.includes("Verified diff is clean."));
    assert.ok(md.includes("`bash`: {\"command\":\"git diff\"}"));
    // Ensure the original round 1 text is still present (Append-Only)
    assert.ok(md.includes("# Subagent Summary: ParserAudit (sub_01)"));
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
