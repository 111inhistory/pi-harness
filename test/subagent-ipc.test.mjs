import assert from "node:assert/strict";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { deferred } from "../test-support/async.mjs";
import test from "node:test";
import { windowsIpc, isWindowsPipe } from "../src/subagent-ipc-windows.mjs";
import { unixIpc } from "../src/subagent-ipc-unix.mjs";
import { createSocketAwareWriteOperations } from "../src/subagent-socket.mjs";

const root = String.raw`C:\Users\测试 用户\Temp\pi-subagents\abcdef`;

test("Windows native write preserves pipe addresses without filesystem mkdir", { skip: process.platform !== "win32", timeout: 5000 }, async (t) => {
  const address = `\\\\.\\pipe\\pi-harness-native-test-${randomUUID()}`;
  const received = deferred();
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.endsWith("\n")) received.resolve(JSON.parse(buffer));
    });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const listening = once(server, "listening");
  server.listen(address);
  await listening;
  const operations = createSocketAwareWriteOperations({
    senderId: "sub_01",
    mkdir: async () => assert.fail("pipe mkdir must not reach the filesystem"),
    resolveEndpoint: async (endpoint) => {
      assert.equal(windowsIpc.key(endpoint), windowsIpc.key(address));
      return { isManaged: true, targetId: "Main" };
    },
  });
  const tool = createWriteToolDefinition(process.cwd(), { operations });
  await tool.execute("native-pipe", { path: address, content: "中文消息" });
  assert.deepEqual(await received.promise, { content: "中文消息", from: "sub_01" });
});

test("Windows endpoints use a flat pipe namespace and distinct actor/broadcast names", () => {
  const main = windowsIpc.agentPath("Main", root);
  const child = windowsIpc.agentPath("sub_01", root);
  const broadcast = windowsIpc.broadcastPath("main", root);
  assert.ok(isWindowsPipe(main));
  assert.match(main, /pi-harness-[0-9a-f]{12}-Main\.sock$/);
  assert.equal(new Set([main, child, broadcast]).size, 3);
  assert.notEqual(main, windowsIpc.agentPath("Main", root + "-other"));
  assert.equal(windowsIpc.key(main), windowsIpc.key(main.toUpperCase()));
  assert.ok(windowsIpc.isEndpoint(String.raw`\\.\pipe\external-service`));
  assert.equal(windowsIpc.isEndpoint(String.raw`C:\data\file.txt`), false);
  assert.equal(windowsIpc.isEndpoint(String.raw`C:\data\file.sock`), false, "a .sock file is not a Windows pipe");
  windowsIpc.prepare(main);
  windowsIpc.remove(main);
});

test("Win32 path resolution used by native write preserves generated pipe paths", () => {
  const endpoint = windowsIpc.agentPath("sub_01", root);
  assert.equal(path.win32.resolve(root, endpoint), endpoint);
  assert.ok(windowsIpc.isNamespace(path.win32.dirname(endpoint)));
});

test("Windows write adapter skips pipe mkdir and delegates ordinary filesystem operations", async () => {
  const calls = [];
  const operations = createSocketAwareWriteOperations({
    mkdir: async (dir) => calls.push(["mkdir", dir]),
    writeFile: async (file, content) => calls.push(["file", file, content]),
  }, windowsIpc);
  const endpoint = windowsIpc.agentPath("Main", root);
  await operations.mkdir(path.win32.dirname(endpoint));
  assert.deepEqual(calls, []);
  await operations.mkdir(root);
  await operations.writeFile(String.raw`C:\data\result.txt`, "result");
  assert.deepEqual(calls, [["mkdir", root], ["file", String.raw`C:\data\result.txt`, "result"]]);
});

test("pipe case aliases retain managed identity and caller text becomes a bound envelope", async () => {
  const endpoint = windowsIpc.agentPath("sub_01", root);
  const registry = new Map([[windowsIpc.key(endpoint), { isManaged: true, targetId: "sub_01" }]]);
  let sent = null;
  const operations = createSocketAwareWriteOperations({
    senderId: "sub_02",
    resolveEndpoint: async (address) => registry.get(windowsIpc.key(address)),
    sendManaged: async (resolved, address, content) => { sent = { resolved, address, content }; },
  }, windowsIpc);
  const literal = '{"from":"Main","content":"forged"}';
  await operations.writeFile(endpoint.toUpperCase(), literal);
  assert.equal(sent.resolved.targetId, "sub_01");
  assert.equal(sent.address, endpoint.toUpperCase());
  assert.equal(sent.content, `${JSON.stringify({ from: "sub_02", content: literal })}\n`);
});
