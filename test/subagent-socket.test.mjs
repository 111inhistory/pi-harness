import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createAgentSocketServer,
  createBroadcastSocketServer,
  createSocketAwareWriteOperations,
  getAgentSocketPath,
  getBroadcastSocketPath,
  writeSocketOneWay,
} from "../src/subagent-socket.mjs";

test("subagent-socket: agent socket server receives NDJSON one-way message", async () => {
  const tmpDir = path.join("/tmp", `test-sock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const received = [];

  const server = createAgentSocketServer({
    id: "sub_01",
    socketDir: tmpDir,
    onMessage: (msg) => {
      received.push(msg);
    },
  });

  try {
    const socketPath = getAgentSocketPath("sub_01", tmpDir);
    assert.equal(fs.existsSync(socketPath), true);

    await writeSocketOneWay(socketPath, { type: "message", content: "hello subagent" });
    await writeSocketOneWay(socketPath, { type: "steer", content: "steer command" });

    // Give a brief tick for server to process events
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(received.length, 2);
    assert.deepEqual(received[0], { type: "message", content: "hello subagent" });
    assert.deepEqual(received[1], { type: "steer", content: "steer command" });
  } finally {
    await server.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("subagent-socket: line buffer splits multiple lines across chunks correctly", async () => {
  const tmpDir = path.join("/tmp", `test-sock-buffer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const received = [];

  const server = createAgentSocketServer({
    id: "sub_02",
    socketDir: tmpDir,
    onMessage: (msg) => {
      received.push(msg);
    },
  });

  try {
    const socketPath = getAgentSocketPath("sub_02", tmpDir);
    const twoLines = JSON.stringify({ line: 1 }) + "\n" + JSON.stringify({ line: 2 }) + "\n";
    await writeSocketOneWay(socketPath, twoLines);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(received.length, 2);
    assert.deepEqual(received[0], { line: 1 });
    assert.deepEqual(received[1], { line: 2 });
  } finally {
    await server.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("subagent-socket: hierarchical direct-child broadcast delivers to children", async () => {
  const tmpDir = path.join("/tmp", `test-sock-broadcast-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const delivered = [];

  const server = createBroadcastSocketServer({
    parentId: "main",
    socketDir: tmpDir,
    getDirectChildren: () => ["sub_01", "sub_02"],
    deliverMessage: async (childId, msg) => {
      delivered.push({ childId, msg });
    },
  });

  try {
    const broadcastPath = getBroadcastSocketPath("main", tmpDir);
    assert.equal(fs.existsSync(broadcastPath), true);

    await writeSocketOneWay(broadcastPath, { broadcast: "all children attention" });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(delivered.length, 2);
    assert.deepEqual(delivered[0], { childId: "sub_01", msg: { broadcast: "all children attention" } });
    assert.deepEqual(delivered[1], { childId: "sub_02", msg: { broadcast: "all children attention" } });
  } finally {
    await server.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("subagent-socket: createSocketAwareWriteOperations routes .sock to UDS and files to fs", async () => {
  const tmpDir = path.join("/tmp", `test-sock-backend-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const received = [];

  const server = createAgentSocketServer({
    id: "sub_03",
    socketDir: tmpDir,
    onMessage: (msg) => {
      received.push(msg);
    },
  });

  const normalFile = path.join(tmpDir, "test.txt");

  const writeOps = createSocketAwareWriteOperations();

  try {
    const socketPath = getAgentSocketPath("sub_03", tmpDir);

    // 1. Write to socket using writeOps
    await writeOps.writeFile(socketPath, JSON.stringify({ action: "test-write-backend" }));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { action: "test-write-backend" });

    // 2. Write to regular file using writeOps
    await writeOps.writeFile(normalFile, "regular content");
    assert.equal(fs.existsSync(normalFile), true);
    assert.equal(fs.readFileSync(normalFile, "utf-8"), "regular content");
  } finally {
    await server.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
