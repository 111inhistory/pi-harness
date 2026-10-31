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
  assert.equal(paths.result, path.join(viewsDir, "sub_01", "result.txt"));

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
  assert.deepEqual((await fsp.readdir(path.dirname(paths.summary))).sort(), ["result.txt", "summary.md", "transcript.jsonl"]);
});

test("Result files keep the raw result bytes, including whitespace and trailing newlines", async (t) => {
  const { viewsDir } = await viewsFixture(t);
  const result = "  indented finding\nsecond line\n\n";
  const paths = jobViewPaths(viewsDir, "sub_01");
  writeJobView(viewsDir, jobView({ result }));
  assert.deepEqual(await fsp.readFile(paths.result), Buffer.from(result));

  writeJobView(viewsDir, jobView({ result: null }));
  assert.deepEqual(await fsp.readFile(paths.result), Buffer.alloc(0));
});

test("Each Job round has its own result file", async (t) => {
  const { viewsDir } = await viewsFixture(t);
  const first = jobView({ jobId: "sub_01", round: 1, result: "first round" });
  const second = jobView({ jobId: "sub_02", round: 2, result: "second round", previousJobId: "sub_01" });
  const firstPaths = writeJobView(viewsDir, first);
  const secondPaths = writeJobView(viewsDir, second);
  assert.notEqual(firstPaths.result, secondPaths.result);
  assert.equal(await fsp.readFile(firstPaths.result, "utf8"), "first round");
  assert.equal(await fsp.readFile(secondPaths.result, "utf8"), "second round");
});

test("A missing raw result file makes the Job view incomplete", async (t) => {
  const { viewsDir } = await viewsFixture(t);
  const paths = writeJobView(viewsDir, jobView());
  assert.equal(hasJobView(viewsDir, "sub_01"), true);
  await fsp.rm(paths.result);
  assert.equal(hasJobView(viewsDir, "sub_01"), false);

  writeJobView(viewsDir, jobView());
  await fsp.rm(paths.summary);
  assert.equal(hasJobView(viewsDir, "sub_01"), false);

  writeJobView(viewsDir, jobView());
  await fsp.rm(paths.transcript);
  assert.equal(hasJobView(viewsDir, "sub_01"), false);
});

test("Job view writes reject filesystem failures rather than claiming success", async (t) => {
  const { cwd } = await viewsFixture(t);
  const blocker = path.join(cwd, "not-a-directory");
  await fsp.writeFile(blocker, "file");
  assert.throws(() => writeJobView(blocker, jobView()), (err) => ["ENOTDIR", "EEXIST"].includes(err.code));
  assert.equal(fs.existsSync(jobViewPaths(blocker, "sub_01").summary), false);
});
