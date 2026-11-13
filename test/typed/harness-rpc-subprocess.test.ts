/**
 * Bounded real-subprocess smoke test for the Harness RPC endpoint.
 *
 * This launches the real Pi CLI in RPC mode (loading the real
 * `extensions/harness.ts`) with an offline, model-free configuration, then
 * verifies the acceptance matrix at the process boundary:
 *
 * - an RPC host publishes a machine-readable discovery record and binds a
 *   distinct Harness endpoint in the same session namespace as Main;
 * - `harness.info` answers with the same protocol version, session and pid;
 * - a graceful shutdown removes the endpoint and its record;
 * - a non-RPC host (`--mode json`) never publishes the endpoint.
 *
 * The assertions are independent of internal function names: they read the
 * published record and speak the wire protocol. Platform address helpers keep
 * the same test usable for Unix sockets and Windows Named Pipes; Windows CI is
 * the actual Named Pipe exercise, not this local run.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Value } from "typebox/value";

import { deriveSessionUid, getAgentSocketPath } from "../../src/ipc/socket.ts";
import { HARNESS_RPC_PROTOCOL_VERSION } from "../../src/harness-rpc/protocol.ts";
import { harnessRpcSchemaRef } from "../../src/harness-rpc/schema.ts";

const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const cliPath = path.join(path.dirname(sdkEntry), "bundle", "cli.js");
const extensionPath = fileURLToPath(new URL("../../extensions/harness.ts", import.meta.url));

interface Fixture {
  readonly dir: string;
  readonly uds: string;
  readonly agent: string;
  readonly sessions: string;
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-harness-rpc-subprocess-"));
  const uds = path.join(dir, "uds");
  const agent = path.join(dir, "agent");
  const sessions = path.join(dir, "sessions");
  await fsp.mkdir(uds, { recursive: true, mode: 0o700 });
  await fsp.mkdir(agent, { recursive: true });
  await fsp.mkdir(sessions, { recursive: true });
  // The managed socket root must be private to the effective user on POSIX;
  // Windows has no Unix mode-bit prerequisite for Named Pipes.
  if (process.platform !== "win32") await fsp.chmod(uds, 0o700);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return { dir, uds, agent, sessions };
}

function childEnvironment(fx: Fixture): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The spawned CLI must not inherit this harness's live session wiring or a
  // TypeScript preload; the offline flag keeps startup off the network.
  for (const key of [
    "NODE_OPTIONS",
    "PI_AGENT_ID",
    "PI_AGENT_SOCKET",
    "PI_ASYNC_SHELL_ROOT",
    "PI_ASYNC_SHELL_TOKEN",
    "PI_SESSION_FILE",
    "PI_SESSION_ID",
  ]) {
    delete env[key];
  }
  env.PI_OFFLINE = "1";
  env.PI_SUBAGENT_SOCKET_DIR = fx.uds;
  env.PI_CODING_AGENT_DIR = fx.agent;
  return env;
}

function baseArgs(fx: Fixture, mode: string, sessionId: string, extra: readonly string[] = []): string[] {
  return [
    "--mode", mode,
    "--offline",
    "--no-extensions",
    "-e", extensionPath,
    "--session-id", sessionId,
    "--session-dir", fx.sessions,
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--approve",
    ...extra,
  ];
}

interface Child {
  readonly child: ChildProcess;
  logs(): string;
}

function spawnPi(fx: Fixture, mode: string, sessionId: string, extra: readonly string[] = []): Child {
  const child = spawn(process.execPath, [cliPath, ...baseArgs(fx, mode, sessionId, extra)], {
    cwd: fx.dir,
    env: childEnvironment(fx),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return { child, logs: () => `stdout:\n${stdout}\nstderr:\n${stderr}` };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, child: Child, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  assert.fail(`Timed out waiting for ${label}\n${child.logs()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), delay(2000)]);
  }
}

async function rpcCall(address: string, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for a response from ${address}`));
    }, 5000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test(
  "a real Pi RPC host publishes, serves and cleans up the Harness endpoint",
  { timeout: 30000 },
  async (t) => {
    const fx = await fixture(t);
    const running = spawnPi(fx, "rpc", "smoke");
    t.after(() => stopChild(running.child));

    const sessionDir = path.join(fx.uds, deriveSessionUid("smoke"));
    const recordPath = path.join(sessionDir, "harness-rpc.json");
    const address = getAgentSocketPath("harness-rpc", sessionDir);

    await waitFor(() => existsSync(recordPath), "harness-rpc.json", running);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    assert.equal(record.protocolVersion, HARNESS_RPC_PROTOCOL_VERSION);
    assert.equal(record.sessionId, "smoke");
    assert.equal(record.pid, running.child.pid);
    assert.equal(record.address, address);
    assert.notEqual(record.address, getAgentSocketPath("Main", sessionDir), "the endpoint is not the Main endpoint");
    assert.deepEqual([...Value.Errors(harnessRpcSchemaRef("HarnessRpcRecord"), record)], []);

    const response = (await rpcCall(address, { id: 1, method: "harness.info" })) as Record<string, unknown>;
    assert.deepEqual(response, {
      id: 1,
      ok: true,
      result: { protocolVersion: HARNESS_RPC_PROTOCOL_VERSION, sessionId: "smoke", pid: running.child.pid },
    });
    assert.deepEqual([...Value.Errors(harnessRpcSchemaRef("RpcSuccessResponse"), response)], []);
    assert.deepEqual([...Value.Errors(harnessRpcSchemaRef("HarnessInfoResult"), response.result)], []);

    await stopChild(running.child);
    await waitFor(() => !existsSync(recordPath), "discovery-record cleanup", running);
  },
);

test(
  "a real Pi non-RPC host never publishes the Harness endpoint",
  { timeout: 30000 },
  async (t) => {
    const fx = await fixture(t);
    // A print run makes the json host initialize a real session (and run the
    // extension lifecycle) even though no model is reachable offline. Closing
    // stdin keeps it non-interactive.
    const running = spawnPi(fx, "json", "neg", ["--print", "hello"]);
    running.child.stdin?.end();
    t.after(() => stopChild(running.child));

    const sessionDir = path.join(fx.uds, deriveSessionUid("neg"));
    // Bounded window: give the host a chance to initialize and run the extension
    // lifecycle. Whether or not the root binds its socket directory in this
    // offline json run, a non-RPC mode must never publish the endpoint, so the
    // assertion below does not depend on the directory appearing.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(sessionDir) || running.child.exitCode !== null) break;
      await delay(50);
    }
    await delay(250);

    assert.equal(existsSync(path.join(sessionDir, "harness-rpc.json")), false, "no discovery record in json mode");
    // Named Pipes have no portable filesystem existence check; record absence is
    // the portable assertion that this non-RPC host never published an endpoint.
  },
);
