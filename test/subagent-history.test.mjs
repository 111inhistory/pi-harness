import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendCleanJsonl,
  getSubagentHistoryPaths,
  writeCompactedSummary,
} from "../src/subagent-history.mjs";

async function historyDir(t) {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), "pi-hist-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function readEvents(file) {
  const text = await fsp.readFile(file, "utf8");
  assert.ok(text.endsWith("\n"), "every NDJSON record must be newline terminated");
  return text.slice(0, -1).split("\n").map((line) => JSON.parse(line));
}

test("clean history ignores invalid values and all supported streaming fragments without creating files", async (t) => {
  const baseDir = await historyDir(t);
  for (const event of [null, undefined, "text", 42, ...["stream_chunk", "delta", "token"].map((type) => ({ type, text: "partial" }))]) {
    await appendCleanJsonl("sub_01", event, { baseDir });
  }
  assert.deepEqual(await fsp.readdir(baseDir), []);
});

test("clean history preserves all four semantic records, structured content and supplied timestamps", async (t) => {
  const baseDir = await historyDir(t);
  const { cleanJsonl } = getSubagentHistoryPaths("sub_01", baseDir);
  const events = [
    { type: "message_start", role: "assistant", timestamp: 123 },
    { type: "tool_call", name: "bash", input: { command: "printf '中文\\n'" }, timestamp: 124 },
    { type: "tool_result", name: "bash", isError: true, content: [{ type: "text", text: "first\nsecond" }], timestamp: 125 },
    { type: "message_end", role: "assistant", content: "done\n困难度：low", usage: { output: 3 } },
  ];
  for (const event of events) await appendCleanJsonl("sub_01", event, { baseDir });
  const records = await readEvents(cleanJsonl);
  assert.equal(records.length, events.length);
  for (const [index, record] of records.entries()) {
    assert.deepEqual(record, { ...events[index], timestamp: events[index].timestamp ?? record.timestamp });
    assert.ok(record.timestamp > 0);
  }
  assert.equal(events[3].timestamp, undefined, "logging must not mutate the input event");
});

test("clean history appends without changing old bytes and isolates actor files", async (t) => {
  const baseDir = await historyDir(t);
  const first = getSubagentHistoryPaths("sub_01", baseDir);
  const child = getSubagentHistoryPaths("sub_01_01", baseDir);
  await appendCleanJsonl("sub_01", { type: "message_end", content: "original" }, { baseDir });
  const original = await fsp.readFile(first.cleanJsonl);
  await appendCleanJsonl("sub_01", { type: "message_end", content: "revived" }, { baseDir });
  await appendCleanJsonl("sub_01_01", { type: "message_end", content: "child only" }, { baseDir });
  const appended = await fsp.readFile(first.cleanJsonl);
  assert.deepEqual(appended.subarray(0, original.length), original);
  assert.deepEqual((await readEvents(first.cleanJsonl)).map((r) => r.content), ["original", "revived"]);
  assert.deepEqual((await readEvents(child.cleanJsonl)).map((r) => r.content), ["child only"]);
});

test("concurrent clean-history appends retain every complete record", async (t) => {
  const baseDir = await historyDir(t);
  await Promise.all(Array.from({ length: 40 }, (_, sequence) => appendCleanJsonl("sub_01", {
    type: "message_end", sequence, content: `record ${sequence}\n多行`,
  }, { baseDir })));
  const records = await readEvents(getSubagentHistoryPaths("sub_01", baseDir).cleanJsonl);
  assert.equal(records.length, 40);
  assert.deepEqual(records.map((r) => r.sequence).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i));
  for (const record of records) assert.equal(record.content, `record ${record.sequence}\n多行`);
});

test("summary preserves the original bytes across multiple revivals, failures and cancellation", async (t) => {
  const baseDir = await historyDir(t);
  const { summary } = getSubagentHistoryPaths("sub_01", baseDir);
  await writeCompactedSummary("sub_01", {
    name: "ParserAudit", task: "Check parser errors", role: "reviewer", model: "test-model",
    budget: { modelCalls: 5, activeTimeMs: 12000 },
    toolCalls: [{ tool: "bash", input: { command: "npm test" }, isError: false }],
    result: "Original findings", status: "completed", round: 1,
  }, { baseDir });
  let previous = await fsp.readFile(summary, "utf8");
  assert.match(previous, /Original Task[\s\S]*Check parser errors/);
  assert.match(previous, /`bash`: \{"command":"npm test"\}/);
  assert.match(previous, /5 model calls, 12s active/);

  for (const [round, status] of [[2, "cancelled"], [3, "failed"], [4, "completed"]]) {
    await writeCompactedSummary("sub_01", {
      status, round, result: `Round ${round} output`,
      error: status === "failed" ? "provider failure" : null,
      toolCalls: [{ name: "read", arguments: { path: "src/parser.mjs" }, isError: status === "failed" }],
    }, { baseDir, append: true });
    const current = await fsp.readFile(summary, "utf8");
    assert.ok(current.startsWith(previous), "revive must append, not rewrite earlier history");
    assert.match(current.slice(previous.length), new RegExp(`Continuation / Round ${round}`));
    assert.ok(current.slice(previous.length).includes(`\`${status}\``));
    assert.ok(current.includes(`Round ${round} output`));
    previous = current;
  }
  assert.match(previous, /Error \/ Warning[\s\S]*provider failure/);
  assert.match(previous, /`read` \[FAILED\]/);
  assert.deepEqual(await fsp.readdir(path.dirname(summary)), ["summary.md"]);
});

test("a revival without an earlier summary still creates a readable header", async (t) => {
  const baseDir = await historyDir(t);
  const summary = await writeCompactedSummary("sub_02", { round: 2, result: "first recorded output" }, { append: true, baseDir });
  const markdown = await fsp.readFile(summary, "utf8");
  assert.match(markdown, /^# Subagent Summary: sub_02 \(sub_02\)/);
  assert.match(markdown, /first recorded output/);
});

test("history writers reject filesystem failures rather than silently claiming success", async (t) => {
  const dir = await historyDir(t);
  const baseDir = path.join(dir, "not-a-directory");
  await fsp.writeFile(baseDir, "file");
  const filesystemError = (err) => ["ENOTDIR", "EEXIST"].includes(err.code);
  await assert.rejects(appendCleanJsonl("sub_01", { type: "message_end" }, { baseDir }), filesystemError);
  await assert.rejects(writeCompactedSummary("sub_01", { result: "output" }, { baseDir }), filesystemError);
});
