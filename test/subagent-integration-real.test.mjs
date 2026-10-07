import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL("../test-support/subagent-sdk-scenario.mjs", import.meta.url));

// Child-process timeout also detects leaked handles AFTER assertions succeed;
// node:test's per-test timeout alone does not enforce worker quiescence.
async function scenario(t, name) {
  const cwd = await fsp.mkdtemp(path.join(tmpdir(), "pi-sdk-"));
  t.after(() => fsp.rm(cwd, { recursive: true, force: true }));
  try {
    const { stdout, stderr } = await execute(process.execPath, [fixture, name], {
      cwd, timeout: 8000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_CODING_AGENT_DIR: path.join(cwd, "agent"),
        PI_SUBAGENT_SOCKET_DIR: path.join(cwd, "uds"),
      },
    });
    assert.ok(stdout.includes(`SCENARIO_OK:${name}`), `scenario did not finish:\n${stdout}\n${stderr}`);
  } catch (error) {
    assert.fail(`SDK scenario ${name} failed${error.killed ? " (child process timed out / leaked handles)" : ""}:\n${error.stdout ?? ""}\n${error.stderr ?? error.message}`);
  }
}

for (const [name, description] of [
  ["surface", "real tool surface, atomic validation, native file/socket write and pre-session buffering"],
  ["external-socket", "native write to a non-Subagent socket preserves payload and cannot affect a same-named stopping Agent"],
  // These sender regressions exercise the newly revised contract, not a claimed implementation fix.
  ["sender-wire", "native child write identifies its owner in the outbound NDJSON"],
  ["sender-context", "the receiver preserves a native child sender rather than relabeling it as Main"],
  ["sender-reserved", "managed socket write rejects caller-supplied sender identity"],
  ["revive", "explicit revival retains the listener, appends both histories and does not reroute"],
  ["history", "real native tool execution retains complete clean history and the final summary"],
  ["steer", "a running actor consumes native steering exactly once in the same Job"],
  ["queued", "queued depth-2 sockets buffer messages and stop removes a queued task without executing it"],
  ["broadcast", "real hierarchical broadcast reaches only direct children, never ancestors or peers"],
  ["inherited", "Inherited captures signed native context, tools warnings, identity and thinking without routing"],
  ["stopping", "native socket write rejects stopping and only revives after actual model exit"],
  ["stop-history", "cancellation flushes readable history before reporting the native run as stopped"],
  ["failure", "native model failure writes a summary and notifies without waking the root"],
  ["reload", "durable reload restores socket listeners and continues the checkpointed conversation"],
]) {
  test(`offline SDK: ${description}`, { timeout: 10000 }, (t) => scenario(t, name));
}
