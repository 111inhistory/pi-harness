import assert from "node:assert/strict";
import test from "node:test";

import { truncateHead } from "@earendil-works/pi-coding-agent";

import { resultNeedsFile, terminalResultContent } from "../../src/subagent/result.ts";

/** Find the smallest input size at which the SDK truncator starts cutting. */
function firstTruncated(make: (size: number) => string): number {
  let high = 1;
  while (!truncateHead(make(high)).truncated) high *= 2;
  let low = 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (truncateHead(make(mid)).truncated) high = mid;
    else low = mid + 1;
  }
  return low;
}

const firstLineTruncation = firstTruncated((count) => Array.from({ length: count }, (_, index) => `line ${index}`).join("\n"));
const firstByteTruncation = firstTruncated((size) => "a".repeat(size));

function assertPreview(result: string, path: string | null): void {
  const preview = truncateHead(result);
  const content = terminalResultContent(result, path);
  if (!preview.truncated) {
    assert.equal(content, result);
    return;
  }
  const location = path === null ? "Full result file unavailable." : `Full result: ${path}`;
  const marker = `[Result truncated: showing ${preview.outputLines} of ${preview.totalLines} lines, ${preview.outputBytes} of ${preview.totalBytes} bytes. ${location}]`;
  assert.equal(content, preview.content === "" ? marker : `${preview.content}\n\n${marker}`);
}

test("short and unicode results are returned as the exact raw text", () => {
  const short = "done";
  const unicode = "héllo 世界\nsecond line ✓";
  for (const result of [short, unicode]) {
    const preview = truncateHead(result);
    assert.equal(preview.truncated, false);
    assert.equal(terminalResultContent(result, "/views/sub_01/result.txt"), result);
    assert.equal(resultNeedsFile(result), false);
  }
});

test("non-text results have no terminal content and need no file", () => {
  for (const result of [null, undefined, 42, { text: "done" }, ["done"]]) {
    assert.equal(terminalResultContent(result, "/views/sub_01/result.txt"), "");
  }
});

test("line-limit truncation appends an explicit marker with the full path", () => {
  const result = Array.from({ length: firstLineTruncation }, (_, index) => `line ${index}`).join("\n");
  const preview = truncateHead(result);
  assert.equal(preview.truncated, true);
  assert.equal(preview.totalLines, firstLineTruncation);
  assert.ok(preview.outputLines < preview.totalLines);

  const path = "/views/sub_01/result.txt";
  const content = terminalResultContent(result, path);
  assert.ok(content.startsWith(preview.content));
  assert.ok(content.includes(`[Result truncated: showing ${preview.outputLines} of ${preview.totalLines} lines`));
  assert.ok(content.includes(`Full result: ${path}`));
  assertPreview(result, path);
  assert.equal(resultNeedsFile(result), true);
});

test("an oversized single line truncates by bytes and names the full path", () => {
  const result = "a".repeat(firstByteTruncation);
  const preview = truncateHead(result);
  assert.equal(preview.truncated, true);
  assert.equal(preview.totalLines, 1);
  assert.ok(preview.outputBytes < preview.totalBytes);

  const path = "/views/sub_01/result.txt";
  const content = terminalResultContent(result, path);
  assert.ok(content.includes(`showing ${preview.outputLines} of 1 lines, ${preview.outputBytes} of ${preview.totalBytes} bytes.`));
  assert.ok(content.includes(`Full result: ${path}`));
  assertPreview(result, path);
  assert.equal(resultNeedsFile(result), true);
});

test("without a full path the truncation marker says the file is unavailable", () => {
  const result = "a".repeat(firstByteTruncation);
  const content = terminalResultContent(result, null);
  assert.ok(truncateHead(result).truncated);
  assert.ok(content.includes("Full result file unavailable."));
  assert.equal(content.includes("Full result:"), false);
  assertPreview(result, null);
});
