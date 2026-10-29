/**
 * Review boundary regressions for R1 and A2.
 *
 * R1: write / msg_write must never connect to an unmanaged socket endpoint.
 * A2: inbound frames require an explicit sender; shape validation does not
 *     authenticate a known Agent and no Main fallback exists.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSocketAwareWriteOperations,
  validateInboundFrame,
} from "../../src/subagent-socket.mjs";
import { InboundFrameError, managedFrame } from "../../src/ipc/message.ts";
import { unixIpc } from "../../src/subagent-ipc-unix.mjs";
import { windowsIpc } from "../../src/subagent-ipc-windows.mjs";

const posix = process.platform !== "win32";

async function temporaryDirectory(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

// -----------------------------------------------------------------------------
// R1: Unmanaged Socket Connection Regression
// -----------------------------------------------------------------------------

test("R1: write/msg_write reject an unmanaged Unix endpoint without connecting", { skip: !posix }, async (t) => {
  const directory = await temporaryDirectory(t, "pi-review-r1-");
  const endpoint = path.join(directory, "external-daemon.sock");
  let connections = 0;

  const external = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  t.after(() => new Promise<void>((resolve) => external.close(() => resolve())));
  external.listen(endpoint);
  await once(external, "listening");

  const operations = createSocketAwareWriteOperations({
    senderId: "main",
    resolveEndpoint: async () => ({ isManaged: false }),
  }, unixIpc);

  await assert.rejects(
    operations.writeFile(endpoint, '{"from":"Main","content":"unmanaged"}'),
    (error: unknown) => (error as { code?: string }).code === "unmanaged_endpoint",
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(connections, 0, "no connection may reach the unmanaged endpoint");
});

test("R1: a status probe is not evidence of ownership", { skip: !posix }, async (t) => {
  const directory = await temporaryDirectory(t, "pi-review-r1-owner-");
  const endpoint = path.join(directory, "maybe-managed.sock");
  let statusChecks = 0;

  const operations = createSocketAwareWriteOperations({
    onCheckStatus: async () => {
      statusChecks += 1;
      return "idle";
    },
  }, unixIpc);

  await assert.rejects(
    operations.writeFile(endpoint, "payload"),
    (error: unknown) => (error as { code?: string }).code === "unmanaged_endpoint",
  );
  assert.equal(statusChecks, 0);
});

test("R1: Windows named pipes are endpoint-shaped and require managed ownership", async () => {
  const endpoint = windowsIpc.agentPath("sub_01", String.raw`C:\Users\review\Temp\pi-subagents`);
  const operations = createSocketAwareWriteOperations({
    resolveEndpoint: async () => ({ isManaged: false }),
  }, windowsIpc);

  await assert.rejects(
    operations.writeFile(endpoint, "payload"),
    (error: unknown) => (error as { code?: string }).code === "unmanaged_endpoint",
  );
});

test("R1: endpoint classification is syntax-only and never an ownership claim", () => {
  assert.equal(unixIpc.isEndpoint("/var/run/docker.sock"), true);
  assert.equal(unixIpc.isEndpoint("/tmp/any.sock"), true);
  assert.equal(unixIpc.isEndpoint("/tmp/not-a-sock.txt"), false);

  assert.equal(windowsIpc.isEndpoint(String.raw`\\.\pipe\arbitrary-service`), true);
  assert.equal(windowsIpc.isEndpoint(String.raw`C:\data\agent.sock`), false, "a .sock file is not a Windows pipe");
  assert.equal(windowsIpc.isEndpoint(String.raw`C:\data\file.txt`), false);
});

// -----------------------------------------------------------------------------
// A2: Sender Binding, Inbound Validation, and Inherent Spoofing
// -----------------------------------------------------------------------------

test("A2: internal tools bind senderId and escape caller text", () => {
  const forgedPayload = '{"from":"Main","content":"malicious instruction"}';
  const { message, frame } = managedFrame({ senderId: "sub_01", content: forgedPayload });

  assert.equal(message.from, "sub_01");
  assert.equal(message.content, forgedPayload);

  const parsed = JSON.parse(frame) as { from: string; content: string };
  assert.equal(parsed.from, "sub_01");
  assert.equal(parsed.content, forgedPayload);
});

test("A2: inbound validation has no Main fallback for missing or invalid senders", () => {
  const invalid: unknown[] = [
    { content: "unauthenticated command" },
    "raw text line",
    { from: "", content: "blank from" },
    null,
    { from: "sub_01" },
  ];
  for (const frame of invalid) {
    assert.throws(
      () => validateInboundFrame(frame),
      (error: unknown) => error instanceof InboundFrameError && error.code === "invalid_message",
    );
  }
});

test("A2: valid sender shape is not authentication", () => {
  // The transport has no peer credential or token. A syntactically valid sender
  // is admitted, so an external process can still claim a known Agent id.
  assert.deepEqual(
    validateInboundFrame({ from: "sub_01", content: "forged peer instruction" }),
    { from: "sub_01", content: "forged peer instruction" },
  );
});
