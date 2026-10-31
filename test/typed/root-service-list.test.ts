import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { RootService } from "../../src/subagent/root-service.ts";
import { SUBAGENT_SESSIONS_DIR } from "../../src/subagent/storage.ts";

function createHarnessContext(options: {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
}): { api: ExtensionAPI; context: ExtensionContext } {
  const api = {
    appendEntry: () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
    sendMessage: () => {},
    registerTool: () => {},
  } as unknown as ExtensionAPI;

  const context = {
    modelRegistry: { find: () => undefined },
    sessionManager: options.sessionManager,
    cwd: options.cwd,
    isIdle: () => true,
  } as unknown as ExtensionContext;

  return { api, context };
}

test("top-level/default list attaches historyDir to root when durable storage is enabled", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "root-list-top-"));
  const agentDir = path.join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  const sessionDir = path.join(cwd, "sessions");
  await mkdir(sessionDir, { recursive: true });
  const sessionManager = SessionManager.create(cwd, sessionDir);
  const sessionId = sessionManager.getSessionId();

  const { api, context } = createHarnessContext({ cwd, agentDir, sessionManager });
  const service = new RootService({
    api,
    context,
    agentDir,
    allocatedIds: new Set(),
    ownsContext: () => true,
  });

  try {
    await service.initialize();

    service.runtime.restoreState({
      actors: [
        { agentId: "sub_01", parentAgentId: null, depth: 1, name: "worker" },
      ],
      jobs: [
        {
          jobId: "sub_01",
          agentId: "sub_01",
          spec: { task: "initial investigation" },
          status: "completed",
          end: { status: "completed", result: "investigation finished successfully" },
        },
      ],
    });

    const root = await service.list({}, "Main");
    assert.ok(root, "Root service list should return a root tree item");
    assert.equal(root.id, "Main");

    const expectedHistoryDir = path.join(agentDir, SUBAGENT_SESSIONS_DIR, sessionId, "views");
    assert.equal(root.historyDir, expectedHistoryDir, "Root item should carry historyDir when durable");

    assert.equal(root.children.length, 1);
    const child = root.children[0]!;
    assert.equal(child.id, "sub_01");
    assert.equal(child.historyDir, undefined, "Child items should not attach historyDir");

    assert.ok(child.history, "Child item should retain per-agent history");
    assert.equal(child.history.jobId, "sub_01");
    assert.equal(child.history.summary, path.join(expectedHistoryDir, "sub_01", "summary.md"));
    assert.equal(child.history.cleanJsonl, path.join(expectedHistoryDir, "sub_01", "transcript.jsonl"));

    assert.ok(existsSync(child.history.summary), "summary.md should exist in views");
    assert.ok(existsSync(child.history.cleanJsonl), "transcript.jsonl should exist in views");

    const summaryContent = await readFile(child.history.summary, "utf-8");
    assert.ok(summaryContent.includes("investigation finished successfully"));
  } finally {
    await service.retire();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("id-selected subtree attaches historyDir to returned subtree root and covers multiple rounds", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "root-list-sub-"));
  const agentDir = path.join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  const sessionDir = path.join(cwd, "sessions");
  await mkdir(sessionDir, { recursive: true });
  const sessionManager = SessionManager.create(cwd, sessionDir);
  const sessionId = sessionManager.getSessionId();

  const { api, context } = createHarnessContext({ cwd, agentDir, sessionManager });
  const service = new RootService({
    api,
    context,
    agentDir,
    allocatedIds: new Set(),
    ownsContext: () => true,
  });

  try {
    await service.initialize();

    service.runtime.restoreState({
      actors: [
        { agentId: "sub_01", parentAgentId: null, depth: 1, name: "worker" },
      ],
      jobs: [
        {
          jobId: "sub_01",
          agentId: "sub_01",
          spec: { task: "round 1 task" },
          status: "completed",
          end: { status: "completed", result: "round 1 result" },
        },
        {
          jobId: "sub_01_r2",
          agentId: "sub_01",
          spec: { task: "round 2 task" },
          status: "completed",
          continuedFromJobId: "sub_01",
          end: { status: "completed", result: "round 2 result" },
        },
      ],
    });

    const expectedHistoryDir = path.join(agentDir, SUBAGENT_SESSIONS_DIR, sessionId, "views");

    // Simulate earlier round's view directory already written in previous round
    const round1Dir = path.join(expectedHistoryDir, "sub_01");
    await mkdir(round1Dir, { recursive: true });
    await writeFile(path.join(round1Dir, "summary.md"), "# Round 1 summary\n", "utf-8");
    await writeFile(path.join(round1Dir, "transcript.jsonl"), "", "utf-8");

    const subtree = await service.list({ id: "sub_01" }, "Main");
    assert.ok(subtree, "Subtree should be returned for existing agent id");
    assert.equal(subtree.id, "sub_01");
    assert.equal(subtree.historyDir, expectedHistoryDir, "Subtree root should carry historyDir when durable");

    assert.ok(subtree.history, "Agent should carry latest history");
    assert.equal(subtree.history.jobId, "sub_01_r2");
    assert.equal(subtree.history.summary, path.join(expectedHistoryDir, "sub_01_r2", "summary.md"));

    // Both previous and current round folders exist in historyDir
    assert.ok(existsSync(path.join(expectedHistoryDir, "sub_01", "summary.md")), "Previous round view exists");
    assert.ok(existsSync(path.join(expectedHistoryDir, "sub_01_r2", "summary.md")), "Latest round view exists");
  } finally {
    await service.retire();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory-only mode does not advertise nonexistent durable history", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "root-list-mem-"));
  const agentDir = path.join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  const sessionManager = SessionManager.inMemory();

  const { api, context } = createHarnessContext({ cwd, agentDir, sessionManager });
  const service = new RootService({
    api,
    context,
    agentDir,
    allocatedIds: new Set(),
    ownsContext: () => true,
  });

  try {
    await service.initialize();

    service.runtime.restoreState({
      actors: [
        { agentId: "sub_01", parentAgentId: null, depth: 1, name: "worker" },
      ],
      jobs: [
        {
          jobId: "sub_01",
          agentId: "sub_01",
          spec: { task: "memory task" },
          status: "completed",
          result: "memory result",
          end: { status: "completed" },
        },
      ],
    });

    const root = await service.list({}, "Main");
    assert.ok(root);
    assert.equal(root.id, "Main");
    assert.equal(root.historyDir, undefined, "Root item must not advertise historyDir in memory-only mode");
    assert.equal("historyDir" in root, false);

    assert.equal(root.children.length, 1);
    assert.equal(root.children[0]!.historyDir, undefined);
    assert.equal("historyDir" in root.children[0]!, false);

    const subtree = await service.list({ id: "sub_01" }, "Main");
    assert.ok(subtree);
    assert.equal(subtree.id, "sub_01");
    assert.equal(subtree.historyDir, undefined, "Subtree root must not advertise historyDir in memory-only mode");
    assert.equal("historyDir" in subtree, false);

    const missing = await service.list({ id: "nonexistent" }, "Main");
    assert.equal(missing, null);
  } finally {
    await service.retire();
    await rm(cwd, { recursive: true, force: true });
  }
});
