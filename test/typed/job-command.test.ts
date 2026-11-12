import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  extractJobCommands,
  PARSER_MODULE_URL,
} from "../../src/shell-approval/job-command.ts";

const submoduleAvailable = existsSync(PARSER_MODULE_URL);

function requireSubmodule(t: TestContext): boolean {
  if (!submoduleAvailable) {
    t.skip("submodule artifact absent at vendor/codex-command-policy");
    return false;
  }
  return true;
}

// Bash cases are POSIX parser tests: the shell resolves POSIX paths regardless
// of the host OS, so they state the platform instead of inheriting the host's.
test("quotes and spaces in arguments", async (t) => {
  if (!requireSubmodule(t)) return;

  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: 'pi-job create -- echo "hello world" "arg with space"',
    cwd: "/workspace",
  });

  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.equal(result.containsPiJob, true);
  assert.equal(result.actions.length, 1);
  const action = result.actions[0]!;
  assert.equal(action.isJob, true);
  assert.deepEqual(action.argv, ["echo", "hello world", "arg with space"]);
  assert.equal(action.cwd, "/workspace");
  assert.equal(action.jobOptions?.waitMs, 5000, "an omitted --wait records the default window");
  assert.equal(action.jobOptions?.timeoutMs, null);
});

test("executable paths with spaces", async (t) => {
  if (!requireSubmodule(t)) return;

  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: 'pi-job create -- "/opt/my tool/bin" "data file.txt"',
    cwd: "/workspace",
  });

  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.equal(result.containsPiJob, true);
  assert.equal(result.actions.length, 1);
  const action = result.actions[0]!;
  assert.equal(action.isJob, true);
  assert.deepEqual(action.argv, ["/opt/my tool/bin", "data file.txt"]);
  assert.equal(action.cwd, "/workspace");
});

test("--cwd resolution: relative, absolute, omitted, and ignoring --cwd after --", async (t) => {
  if (!requireSubmodule(t)) return;

  // Relative --cwd
  const resRel = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: "pi-job create --cwd subdir/nested -- ls -la",
    cwd: "/workspace/project",
  });
  assert.equal(resRel.kind, "extracted");
  if (resRel.kind !== "extracted") return;
  assert.equal(resRel.containsPiJob, true);
  assert.equal(resRel.actions[0]!.cwd, path.posix.resolve("/workspace/project", "subdir/nested"));

  // Absolute --cwd
  const resAbs = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: "pi-job create --cwd /tmp/scratch -- ls",
    cwd: "/workspace/project",
  });
  assert.equal(resAbs.kind, "extracted");
  if (resAbs.kind !== "extracted") return;
  assert.equal(resAbs.actions[0]!.cwd, "/tmp/scratch");

  // Omitted --cwd
  const resOmitted = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: "pi-job create -- ls",
    cwd: "/workspace/project",
  });
  assert.equal(resOmitted.kind, "extracted");
  if (resOmitted.kind !== "extracted") return;
  assert.equal(resOmitted.actions[0]!.cwd, "/workspace/project");

  // --cwd appearing after -- in child command arguments is not a pi-job create option
  const resAfterDash = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: "pi-job create -- my-tool --cwd other",
    cwd: "/workspace/project",
  });
  assert.equal(resAfterDash.kind, "extracted");
  if (resAfterDash.kind !== "extracted") return;
  assert.equal(resAfterDash.actions[0]!.cwd, "/workspace/project");
  assert.deepEqual(resAfterDash.actions[0]!.argv, ["my-tool", "--cwd", "other"]);
});

test("Windows platform resolution and retired wrapper rejection", async (t) => {
  if (!requireSubmodule(t)) return;

  // pi-job.exe with windows relative --cwd
  const resExe = await extractJobCommands({
    shell: "pwsh",
    command: "pi-job.exe create '--cwd' 'relative\\sub' '--' dir",
    cwd: "C:\\projects\\app",
    platform: "windows",
  });
  assert.equal(resExe.kind, "extracted");
  if (resExe.kind !== "extracted") return;
  assert.equal(resExe.containsPiJob, true);
  assert.equal(resExe.actions[0]!.cwd, path.win32.resolve("C:\\projects\\app", "relative\\sub"));
  assert.equal(resExe.actions[0]!.cwd, "C:\\projects\\app\\relative\\sub");
  assert.deepEqual(resExe.actions[0]!.argv, ["dir"]);

  // the retired node wrapper is not a pi-job invocation
  const resNode = await extractJobCommands({
    shell: "pwsh",
    command: "node dist/pi-job.mjs create '--cwd' 'sub' '--' Get-Process",
    cwd: "C:\\projects\\app",
    platform: "windows",
  });
  assert.equal(resNode.kind, "extracted");
  if (resNode.kind !== "extracted") return;
  assert.equal(resNode.containsPiJob, false);
  assert.equal(resNode.actions.length, 1);
  assert.equal(resNode.actions[0]!.isJob, false);
});

test("compound command preserves unrelated dangerous sibling commands", async (t) => {
  if (!requireSubmodule(t)) return;

  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: "rm -rf /dangerous && pi-job create --wait 2s -- echo safe",
    cwd: "/workspace",
  });

  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.equal(result.containsPiJob, true);
  assert.equal(result.actions.length, 2);

  const sibling = result.actions[0]!;
  assert.equal(sibling.isJob, false);
  assert.deepEqual(sibling.argv, ["rm", "-rf", "/dangerous"]);
  assert.equal(sibling.cwd, "/workspace");

  const job = result.actions[1]!;
  assert.equal(job.isJob, true);
  assert.deepEqual(job.argv, ["echo", "safe"]);
  assert.equal(job.jobOptions?.waitMs, 2000);
});

test("send, key, and poll invocations are excluded from inspection and mark containsPiJob", async (t) => {
  if (!requireSubmodule(t)) return;

  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: 'pi-job create -- npm test && pi-job send job_1 "line" && pi-job key job_1 Enter && pi-job poll job_1',
    cwd: "/workspace",
  });

  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.equal(result.containsPiJob, true);
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0]!.argv, ["npm", "test"]);
  assert.equal(result.actions[0]!.isJob, true);
});

test("send-only pi-job command returns empty actions with containsPiJob: true", async (t) => {
  if (!requireSubmodule(t)) return;

  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: 'pi-job send job_1 "line"',
    cwd: "/workspace",
  });

  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.equal(result.containsPiJob, true);
  assert.equal(result.actions.length, 0);
});

test("non-pi-job commands return containsPiJob: false", async (t) => {
  if (!requireSubmodule(t)) return;

  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: "git status && npm test",
    cwd: "/workspace",
  });

  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.equal(result.containsPiJob, false);
  assert.equal(result.actions.length, 2);
});

test("unknown pi-job subcommand falls back to original review", async (t) => {
  if (!requireSubmodule(t)) return;

  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: "pi-job unrecognized_command foo",
    cwd: "/workspace",
  });

  assert.deepEqual(result, { kind: "original" });
});

test("pi-job send with quoted heredoc skips opaque body and extracts cleanly", async (t) => {
  if (!requireSubmodule(t)) return;

  const command = "pi-job send job_deadbeef --enter <<'EOF'\nrm -rf /somewhere\nEOF";
  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command,
    cwd: "/workspace",
  });

  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.equal(result.containsPiJob, true);
  assert.equal(result.actions.length, 0);
});

test("pi-job send with unquoted heredoc falls back to original review", async (t) => {
  if (!requireSubmodule(t)) return;

  const command = "pi-job send job_deadbeef --enter <<EOF\nrm -rf /somewhere\nEOF";
  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command,
    cwd: "/workspace",
  });

  assert.deepEqual(result, { kind: "original" });
});

test("non-pi-job command with heredoc falls back to original review", async (t) => {
  if (!requireSubmodule(t)) return;

  const command = "cat <<'EOF'\nhello\nEOF";
  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command,
    cwd: "/workspace",
  });

  assert.deepEqual(result, { kind: "original" });
});

test("argv shell wrappers (bash -lc) are preserved intact", async (t) => {
  if (!requireSubmodule(t)) return;

  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: 'pi-job create -- bash -lc "echo 1 && rm -rf /foo"',
    cwd: "/workspace",
  });

  assert.equal(result.kind, "extracted");
  if (result.kind !== "extracted") return;
  assert.equal(result.containsPiJob, true);
  assert.equal(result.actions.length, 1);
  const action = result.actions[0]!;
  assert.equal(action.isJob, true);
  assert.deepEqual(action.argv, ["bash", "-lc", "echo 1 && rm -rf /foo"]);
});

test("dynamic expansions or unknown tokens fall back to original review", async (t) => {
  if (!requireSubmodule(t)) return;

  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: "pi-job create -- echo $(cat file)",
    cwd: "/workspace",
  });

  assert.deepEqual(result, { kind: "original" });
});

test("malformed pi-job options fall back to original review", async (t) => {
  if (!requireSubmodule(t)) return;

  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: "pi-job create --unknown-flag -- echo 1",
    cwd: "/workspace",
  });

  assert.deepEqual(result, { kind: "original" });
});

test("compound command with cd side effect falls back to original review", async (t) => {
  if (!requireSubmodule(t)) return;

  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: "cd /other && pi-job create -- rm -rf relative",
    cwd: "/workspace",
  });

  assert.deepEqual(result, { kind: "original" });
});

test("compound command with export side effect falls back to original review", async (t) => {
  if (!requireSubmodule(t)) return;

  const result = await extractJobCommands({
    shell: "bash",
    platform: "posix",
    command: "export TARGET=/other && pi-job create -- rm -rf relative",
    cwd: "/workspace",
  });

  assert.deepEqual(result, { kind: "original" });
});

test("PowerShell compound command with Set-Location falls back to original review", async (t) => {
  if (!requireSubmodule(t)) return;

  const result = await extractJobCommands({
    shell: "pwsh",
    command: "Set-Location C:\\other; pi-job create '--' Get-ChildItem",
    cwd: "C:\\workspace",
    platform: "windows",
  });

  assert.deepEqual(result, { kind: "original" });
});

test("default parser falls back to original review when submodule artifact is absent", async (t) => {
  if (submoduleAvailable) {
    t.skip('requires a checkout without the optional submodule');
    return;
  }
  const result = await extractJobCommands({
    shell: 'bash', command: 'pi-job create -- ls', cwd: '/tmp/project',
  });
  assert.deepEqual(result, { kind: 'original' });
});
