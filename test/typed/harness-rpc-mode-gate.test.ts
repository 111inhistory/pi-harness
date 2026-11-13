import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { harnessRpcEnabled, installHarnessRpc } from "../../src/harness-rpc/assembly.ts";
import { harnessRpcTarget } from "../../src/harness-rpc/discovery.ts";
import { getAgentSocketPath } from "../../src/ipc/socket.ts";
import type { RootService } from "../../src/subagent/root-service.ts";

async function fixture(t: test.TestContext): Promise<string> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-harness-rpc-gate-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

function contextWithMode(mode: string): ExtensionContext {
  return {
    mode,
    cwd: process.cwd(),
    ui: { notify() {} },
    sessionManager: { getSessionId: () => "session-xyz", getBranch: () => [] },
    isProjectTrusted: () => false,
  } as unknown as ExtensionContext;
}

function rootAt(directory: string): RootService {
  return { socketRoot: directory, sessionId: "session-xyz" } as unknown as RootService;
}

test("only the rpc run mode enables the endpoint", () => {
  assert.equal(harnessRpcEnabled("rpc"), true);
  assert.equal(harnessRpcEnabled("tui"), false);
  assert.equal(harnessRpcEnabled("print"), false);
  assert.equal(harnessRpcEnabled("json"), false);
  assert.equal(harnessRpcEnabled(undefined), false);
});

test("non-rpc modes install a disabled handle and never publish a record", async (t) => {
  const directory = await fixture(t);
  const handle = installHarnessRpc({} as unknown as ExtensionAPI, contextWithMode("tui"), rootAt(directory), () => {});
  await handle.ready();
  assert.equal(handle.enabled, false);
  assert.equal(handle.status().available, false);
  const target = harnessRpcTarget(directory, "session-xyz");
  await assert.rejects(fsp.access(target.recordPath));
});

test("rpc mode binds a distinct endpoint and publishes/removes its discovery record", async (t) => {
  const directory = await fixture(t);
  const handle = installHarnessRpc({} as unknown as ExtensionAPI, contextWithMode("rpc"), rootAt(directory), () => {});
  t.after(() => handle.close());
  await handle.ready();

  assert.equal(handle.enabled, true);
  assert.equal(handle.status().available, true);

  const target = harnessRpcTarget(directory, "session-xyz");
  // Each platform derives a distinct endpoint from the same session namespace.
  assert.equal(handle.address, getAgentSocketPath("harness-rpc", target.socketDir));
  assert.notEqual(handle.address, getAgentSocketPath("Main", target.socketDir));

  const record = JSON.parse(await fsp.readFile(target.recordPath, "utf8")) as Record<string, unknown>;
  assert.equal(record.address, handle.address);
  assert.equal(record.sessionId, "session-xyz");
  assert.equal(typeof record.protocolVersion, "number");

  await handle.close();
  await assert.rejects(fsp.access(target.recordPath), "the record is removed on close");
  await assert.rejects(async () => {
    const socket = net.connect(target.address);
    try { await once(socket, "connect"); }
    finally { socket.destroy(); }
  }, "the endpoint refuses connections after close");
});
