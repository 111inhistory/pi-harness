import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import subagentExtension from "../extensions/subagent.mjs";
import { writeSocketOneWay } from "../src/subagent-socket.mjs";

test("integration: real SDK extension load, short IDs, instant socket existence, and clean lifecycle", async () => {
  const tmpDir = path.join("/tmp", `test-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const testAgentDir = path.join(tmpDir, "agent-dir");
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(testAgentDir, { recursive: true });

  const sessionManager = SessionManager.inMemory(tmpDir);
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "mock",
    defaultModel: "mock-model",
  });

  const mockModelRuntime = {
    streamSimple: async () => {},
    getAuth: () => ({}),
    getRegisteredProviderIds: () => [],
    getModel: () => null,
    refresh: async () => {},
    hasConfiguredAuth: () => false,
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd: tmpDir,
    agentDir: testAgentDir,
    settingsManager,
    extensionFactories: [
      {
        name: "subagent",
        factory: (pi) => subagentExtension(pi),
      },
    ],
  });
  await resourceLoader.reload();

  const created = await createAgentSession({
    cwd: tmpDir,
    agentDir: testAgentDir,
    sessionManager,
    settingsManager,
    resourceLoader,
    modelRuntime: mockModelRuntime,
    model: { id: "mock-model", provider: "mock", name: "Mock Model", api: "mock", reasoning: false, inputPrice: 0, outputPrice: 0, contextWindow: 8192, maxTokens: 4096 },
  });

  try {
    const session = created.session;
    // 1. Verify registered tool surfaces in real active tool names
    const activeToolNames = session.getActiveToolNames();
    assert.ok(activeToolNames.includes("subagent_create"), "Must have 'subagent_create' tool");
    assert.ok(activeToolNames.includes("subagent_list"), "Must have 'subagent_list' tool");
    assert.ok(activeToolNames.includes("subagent_stop"), "Must have 'subagent_stop' tool");
    assert.ok(activeToolNames.includes("write"), "Must have socket-aware 'write' tool");
    assert.equal(activeToolNames.includes("task"), false, "Deprecated 'task' must NOT be registered");
    assert.equal(activeToolNames.includes("hub"), false, "Deprecated 'hub' must NOT be registered");

    // Retrieve tool definition from session
    const createTool = session._toolDefinitions?.get("subagent_create")?.definition;
    assert.ok(createTool, "subagent_create tool definition must be found");

    const dummyContext = {
      cwd: tmpDir,
      isProjectTrusted: () => true,
      sessionManager,
      modelRegistry: {
        runtime: {
          streamSimple: async () => {},
          getAuth: () => ({}),
          getRegisteredProviderIds: () => [],
        },
        getAvailableSnapshot: () => [],
        findModelByNameOrId: () => null,
      },
    };

    // 2. Call create tool to spawn subagents
    const result = await createTool.execute(
      "call_1",
      {
        context: "E2E Integration Test",
        tasks: [
          { name: "TaskA", task: "run unit verification" },
          { name: "TaskB", task: "run lint check" },
        ],
      },
      undefined,
      undefined,
      dummyContext,
    );

    const items = result.details.items;
    assert.equal(items.length, 2);
    const [first, second] = items;

    // 3. Verify Short Unified IDs
    assert.equal(first.id, "sub_01");
    assert.equal(second.id, "sub_02");

    // 4. Verify Sockets exist IMMEDIATELY upon return
    assert.equal(first.socket, "/tmp/pi-subagents/sub_01.sock");
    assert.equal(second.socket, "/tmp/pi-subagents/sub_02.sock");
    assert.equal(fs.existsSync(first.socket), true, "sub_01.sock must exist immediately");
    assert.equal(fs.existsSync(second.socket), true, "sub_02.sock must exist immediately");
    assert.equal(fs.existsSync("/tmp/pi-subagents/main/children.sock"), true, "Broadcast children.sock must exist");

    // 5. Verify writing to socket delivers one-way message
    await writeSocketOneWay(first.socket, { content: "Direct message to sub_01" });

    // 6. Verify list tool
    const listTool = session._toolDefinitions?.get("subagent_list")?.definition;
    const listResult = await listTool.execute("call_2", {}, undefined, undefined, dummyContext);
    assert.equal(listResult.details.items.length, 2);
    assert.equal(listResult.details.items[0].id, "sub_01");
    assert.equal(listResult.details.items[1].id, "sub_02");

    // 7. Verify stop tool
    const stopTool = session._toolDefinitions?.get("subagent_stop")?.definition;
    const stopResult = await stopTool.execute("call_3", { id: "sub_02" }, undefined, undefined, dummyContext);
    assert.equal(stopResult.details.ok, true);
    assert.equal(stopResult.details.id, "sub_02");
  } finally {
    try {
      await created.session._extensionRunner?.emit?.({ type: "session_shutdown" });
    } catch {}
    await created.session.dispose();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
