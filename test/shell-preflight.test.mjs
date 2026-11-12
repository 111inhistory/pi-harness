import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkShellSyntax, detectShellType } from "../src/shell-preflight.ts";

async function findExecutable(names) {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      for (const suffix of suffixes) {
        const candidate = path.join(directory, `${name}${suffix}`);
        try {
          await access(candidate, constants.X_OK);
          return candidate;
        } catch {}
      }
    }
  }
  return null;
}

const bashPath = await findExecutable(["bash"]);
const shPath = await findExecutable(["sh"]);
const powershellPath = await findExecutable(["pwsh", "powershell"]);

test("detects supported shell executable names", () => {
  assert.equal(detectShellType("/usr/bin/bash"), "bash");
  assert.equal(detectShellType("/bin/dash"), "dash");
  assert.equal(detectShellType("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "powershell");
  assert.equal(detectShellType("/usr/local/bin/fish"), "fish");
  assert.equal(detectShellType("/usr/bin/python3"), null);
});

test(
  "checks PowerShell through its AST parser when available",
  { skip: powershellPath === null },
  async () => {
    const valid = await checkShellSyntax({
      command: '$变量 = "中文"; Get-ChildItem',
      executable: powershellPath,
    });
    assert.equal(valid.ok, true, JSON.stringify({ platform: process.platform, node: process.version, ...valid }));

    const invalid = await checkShellSyntax({
      command: '$变量 = "中文"; if ($true) {',
      executable: powershellPath,
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, "syntax_error", JSON.stringify({ platform: process.platform, node: process.version, ...invalid }));
    assert.ok(invalid.diagnostic.length > 0);
  },
);

test("accepts valid Bash without executing it", { skip: bashPath === null }, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-shell-preflight-"));
  const marker = path.join(cwd, "executed");

  try {
    const result = await checkShellSyntax({
      command: "printf x > executed",
      executable: bashPath,
      cwd,
    });

    assert.equal(result.ok, true);
    await assert.rejects(access(marker));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects invalid Bash syntax with the parser diagnostic", { skip: bashPath === null }, async () => {
  const result = await checkShellSyntax({
    command: "if true; then\n  echo unfinished",
    executable: bashPath,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "syntax_error");
  assert.ok(result.diagnostic.length > 0);
});

test("checks POSIX sh syntax with sh itself", { skip: shPath === null }, async () => {
  const result = await checkShellSyntax({
    command: "case value in\n  value) echo ok ;;\nesac",
    executable: shPath,
  });

  assert.equal(result.ok, true);
  assert.equal(result.shellType, "sh");
});

test("fails closed for unsupported and unavailable parsers", async () => {
  const unsupported = await checkShellSyntax({
    command: "print('ok')",
    executable: "/usr/bin/python3",
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, "unsupported_shell");

  const unavailable = await checkShellSyntax({
    command: "echo ok",
    executable: "/definitely-missing/bash",
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, "checker_unavailable");
});
