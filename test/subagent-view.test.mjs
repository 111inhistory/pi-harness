import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { hasJobView, jobViewPaths, writeJobView } from "../src/subagent-view.mjs";

async function viewsFixture(t) {
  const cwd = await fsp.mkdtemp(path.join(tmpdir(), "pi-views-"));
  t.after(() => fsp.rm(cwd, { recursive: true, force: true }));
  return { cwd, viewsDir: path.join(cwd, "subagent-sessions", "session-01", "views") };
}

function jobView(overrides = {}) {
  return {
    jobId: "sub_01",
    agentId: "sub_01",
    name: "ParserAudit",
    round: 1,
    task: "Check parser errors",
    roleId: "reviewer",
    model: "test-model",
    status: "completed",
    error: null,
    result: "Original findings",
    budget: { modelCalls: 5, activeTimeMs: 12000 },
    previousJobId: null,
    transcript: [
      { role: "user", content: [{ type: "text", text: "first\nsecond" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
    ...overrides,
  };
}

test("Job views are written under the supplied session views directory as newline-terminated JSONL and Markdown", async (t) => {
  const { viewsDir } = await viewsFixture(t);
  const paths = jobViewPaths(viewsDir, "sub_01");
  assert.equal(paths.summary, path.join(viewsDir, "sub_01", "summary.md"));
  assert.equal(paths.transcript, path.join(viewsDir, "sub_01", "transcript.jsonl"));

  const view = jobView();
  assert.deepEqual(writeJobView(viewsDir, view), paths);
  assert.equal(hasJobView(viewsDir, "sub_01"), true);

  const transcript = await fsp.readFile(paths.transcript, "utf8");
  assert.ok(transcript.endsWith("\n"), "every NDJSON record must be newline terminated");
  assert.deepEqual(transcript.slice(0, -1).split("\n").map((line) => JSON.parse(line)), view.transcript);

  const summary = await fsp.readFile(paths.summary, "utf8");
  assert.match(summary, /# Subagent sub_01 \(ParserAudit\) — Job sub_01, round 1/);
  assert.match(summary, /Check parser errors/);
  assert.match(summary, /Original findings/);
  assert.match(summary, /5 model calls, 12s active/);
  assert.deepEqual((await fsp.readdir(path.dirname(paths.summary))).sort(), ["summary.md", "transcript.jsonl"]);
});

test("Job view writes reject filesystem failures rather than claiming success", async (t) => {
  const { cwd } = await viewsFixture(t);
  const blocker = path.join(cwd, "not-a-directory");
  await fsp.writeFile(blocker, "file");
  assert.throws(() => writeJobView(blocker, jobView()), (err) => ["ENOTDIR", "EEXIST"].includes(err.code));
  assert.equal(fs.existsSync(jobViewPaths(blocker, "sub_01").summary), false);
});
