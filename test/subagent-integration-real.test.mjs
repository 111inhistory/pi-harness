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
  ["reviewer-sol", "role-local singleton reviewer pool selects native Sol with high effort and only one Jev classification"],
  ["package-skills", "Capability searches and reads native package and CLI Skills while respecting filters and invocation flags"],
  ["package-skills-cold", "Capability finds installed package Skills without symlinks, loaded Skills or command entries"],
  ["responses-prefix", "Responses Capability retains its declaration prefix, blocks inherited execution and returns compact interfaces"],
  ["responses-only", "Codemode-only Responses retain Capability interfaces when direct declarations are hidden"],
  ["surface", "inactive Subagent surface, explicit activation, atomic validation and native file/socket write"],
  ["listener-cache", "bounded listener windows, historical fallback, lazy depth-2 restoration and reserved IPC directories"],
  ["namespace", "Capability discovers one Subagent namespace and activates all members while preserving native write prompts and Socket backend"],
  ["namespace-reverse", "Subagent and Capability compose in the reverse extension load order"],
  ["namespace-leaf", "Depth 2 Capability accepts the loaded two-tool Subagent namespace"],
  ["capability-missing", "missing Subagent dependency fails before any internal model request"],
  ["external-socket", "native write to a non-Subagent socket preserves payload and cannot affect a same-named stopping Agent"],
  // These sender regressions exercise the newly revised contract, not a claimed implementation fix.
  ["upstream-main", "native child write reaches Main's receiving socket and wakes Main with the real sender"],
  ["upstream-main-steer", "child-to-Main delivery steers a busy root without starting a concurrent turn"],
  ["upstream-main-reload", "Main receiving endpoint is rebuilt after reload and a revived child can deliver upstream"],
  ["upstream-parent", "Depth 2 write reaches and revives only its direct parent, preserving the leaf sender"],
  ["sender-wire", "native child write identifies its owner in the outbound NDJSON"],
  ["sender-context", "the receiver preserves a native child sender rather than relabeling it as Main"],
  ["sender-reserved", "managed socket write rejects caller-supplied sender identity"],
  ["revive", "explicit revival retains the listener, appends both histories and does not reroute"],
  ["history", "real native tool execution retains complete clean history and the final summary"],
  ["steer", "a running actor consumes native steering exactly once in the same Job"],
  ["parallel", "four parents and sixteen children execute concurrently without a global Job cap"],
  ["broadcast", "real hierarchical broadcast reaches only direct children, never ancestors or peers"],
  ["inherited", "Inherited captures signed native context, tools warnings, identity and thinking without routing"],
  ["stopping", "native socket write rejects stopping and only revives after actual model exit"],
  ["stop-history", "cancellation flushes readable history before reporting the native run as stopped"],
  ["failure", "native model failure writes a summary and notifies without waking the root"],
  ["reload", "durable reload restores socket listeners and continues the checkpointed conversation"],
]) {
  test(`offline SDK: ${description}`, { timeout: 10000 }, (t) => scenario(t, name));
}
