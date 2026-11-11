import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
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
    const { stdout, stderr } = await execute(process.execPath, [...(name === "memory-owners" ? ["--expose-gc"] : []), fixture, name], {
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

describe("offline SDK scenarios", { concurrency: 2 }, () => {
  for (const [name, description] of [
  ["reviewer-sol", "role-local singleton reviewer pool selects native Sol with high effort and only one Jev classification"],
  ["package-skills", "Capability searches and reads native package and CLI Skills while respecting filters and invocation flags"],
  ["package-skills-cold", "Capability finds installed package Skills without symlinks, loaded Skills or command entries"],
  ["responses-prefix", "Responses Capability retains its declaration prefix, blocks inherited execution and returns compact interfaces"],
  ["responses-only", "Codemode-only Responses retain Capability interfaces when direct declarations are hidden"],
  ["surface", "inactive Subagent surface, explicit activation, atomic validation and native file/socket write"],
  ["listener-cache", "every registered actor endpoint stays reachable across the visible list window and a durable reload, with reserved IPC directories"],
  ["namespace", "Capability discovers one Subagent namespace and activates all members while preserving native write prompts and Socket backend"],
  ["namespace-reverse", "Subagent and Capability compose in the reverse extension load order"],
  ["namespace-leaf", "Depth 2 Capability accepts the loaded two-tool Subagent namespace"],
  ["capability-missing", "Capability internal execution does not require public Subagent tools"],
  ["external-socket", "a host write refuses an unmanaged external socket without connecting while a genuine external client preserves its payload and a same-named Agent keeps stopping"],
  // These scenarios check native write results, host delivery and native queue semantics through the loaded extensions.
  ["upstream-main", "native child write reaches Main's receiving socket and wakes Main with the real sender"],
  ["upstream-main-steer", "child-to-Main delivery steers a busy root without starting a concurrent turn"],
  ["upstream-main-clear", "clearing an ordinary native steer cannot swallow the later host terminal notification"],
  ["upstream-main-clear-terminal", "explicitly clearing a queued terminal notice does not cause replay or retry"],
  ["upstream-main-esc", "after native abort and queue restoration the later terminal notification can wake Main"],
  ["upstream-main-reload", "Main receiving endpoint is rebuilt after reload and a revived child can deliver upstream"],
  ["upstream-parent", "Depth 2 write reaches and revives only its direct parent, preserving the leaf sender"],
  ["upstream-parent-steer", "a busy Subagent parent receives independent progress and terminal events through native steering"],
  ["sender-wire", "plain-text child write uses native write output and reaches the peer with the actual sender attributed by the host"],
  ["sender-reserved", "JSON literal message text cannot impersonate another sender"],
  ["history", "real native tool execution retains complete clean history and the final summary"],
  ["parallel", "four parents and sixteen children execute concurrently without a global Job cap"],
  ["broadcast", "real hierarchical broadcast reaches only direct children, never ancestors or peers"],
  ["failure", "native model failure writes a summary and wakes Main through a typed steer notice"],
  ["memory-owners", "terminal persistent native managers are collectible, views rebuild and revival reopens without rerouting"],
  ["memory-only", "memory-only actors preserve their sole history across revival without writing subagent files"],
  ["restore-invalid", "invalid restored ownership fails closed without writing recovery events or executing work"],
]) {
    test(`offline SDK: ${description}`, { timeout: 10000 }, (t) => scenario(t, name));
  }
});
