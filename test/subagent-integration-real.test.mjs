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
      cwd, timeout: 30000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
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
  ["surface", "inactive Subagent surface, explicit activation, atomic validation and the one main endpoint"],
  ["listener-cache", "every registered actor stays reachable by logical address across the visible list window and a durable reload"],
  ["namespace", "Capability discovers one Subagent namespace and activates all members while preserving native write prompts and Socket backend"],
  ["namespace-reverse", "Subagent and Capability compose in the reverse extension load order"],
  ["namespace-leaf", "Depth 2 Capability accepts the loaded two-tool Subagent namespace"],
  ["capability-missing", "Capability internal execution does not require public Subagent tools"],
  ["external-socket", "a managed write refuses a filesystem path, an unknown address and a stopping Actor without reviving it"],
  // These scenarios check native write results, host delivery and native queue semantics through the loaded extensions.
  ["upstream-main", "an explicit child msg_write reaches Main as a message with the real sender address"],
  ["upstream-main-steer", "an explicit child msg_write steers a busy root without starting a concurrent turn"],
  ["upstream-main-reload", "a revived child can still send an explicit msg_write to Main after reload"],
  ["sender-wire", "plain-text child write uses native write output and reaches the peer with the actual sender attributed by the host"],
  ["sender-reserved", "JSON literal message text cannot impersonate another sender address"],
  ["history", "real native tool execution retains complete clean history and the final summary without a synthetic completion message"],
  ["parallel", "four parents and sixteen children execute concurrently without a global Job cap"],
  ["failure", "native model failure writes a failed summary without a synthetic parent result"],
  ["memory-owners", "terminal persistent native managers are collectible, views rebuild and revival reopens without rerouting"],
  ["memory-only", "memory-only actors preserve their sole history across revival without writing subagent files"],
  ["continuation-crash", "a continuation registered before its native start restores as an interrupted empty interval"],
  ["restore-invalid", "invalid restored ownership fails closed without writing recovery events or executing work"],
]) {
    test(`offline SDK: ${description}`, { timeout: 45000 }, (t) => scenario(t, name));
  }
});
