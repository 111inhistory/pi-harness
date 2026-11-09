/**
 * The CLI output shape: one metadata line, a blank line, `output:`, then the
 * text this call carried. Nothing on stdout is JSON, so the cases read the shape
 * a caller sees instead of a parsed object.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatError, formatResult } from "../../src/async-shell/render.ts";
import type { ShellResult } from "../../src/async-shell/protocol.ts";

const result = (overrides: Partial<ShellResult> = {}): ShellResult => ({
  id: "job_3f8a1c2d",
  status: "completed",
  exitCode: 0,
  output: "hello\nworld\n",
  cursor: 12,
  logPath: "/tmp/pi-async-shell-1000/job_3f8a1c2d/output.log",
  truncated: false,
  ...overrides,
});

test("a result is a metadata line, a blank line, the output marker, then the text", () => {
  assert.equal(
    formatResult(result()),
    "job_3f8a1c2d  completed  exit 0  cursor 12  log /tmp/pi-async-shell-1000/job_3f8a1c2d/output.log\n"
    + "\n"
    + "output:\n"
    + "hello\nworld\n",
  );
});

test("a call that carried no text still states the marker and every field", () => {
  assert.equal(
    formatResult(result({ status: "running", exitCode: null, output: "", cursor: 40, truncated: true })),
    "job_3f8a1c2d  running  cursor 40  more output pending  log /tmp/pi-async-shell-1000/job_3f8a1c2d/output.log\n"
    + "\n"
    + "output:\n",
  );
});

test("the text is written exactly as the result carries it", () => {
  const text = formatResult(result({ status: "failed", exitCode: 3, output: "boom\n\n" }));
  assert.match(text, /job_3f8a1c2d {2}failed {2}exit 3 {2}cursor 12/);
  assert.equal(text.endsWith("output:\nboom\n\n"), true);
  assert.equal(formatResult(result({ output: "no newline" })).endsWith("output:\nno newline"), true,
    "a chunk cut mid-line is passed on unaltered, so a bounded response stays within its byte budget");
});

test("an error is one plain line, with usage only where the CLI refused the call", () => {
  assert.equal(
    formatError("No async-shell task at /tmp/pi-async-shell-1000/job_00000000.", null),
    "pi-job: No async-shell task at /tmp/pi-async-shell-1000/job_00000000.\n",
  );
  assert.equal(
    formatError("usage", "pi-job create -- COMMAND"),
    "pi-job: usage\n\npi-job create -- COMMAND\n",
  );
});
