import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, mkdtemp } from "node:fs/promises";
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

test("top-level/default durable list projects per-Job history paths without the storage directory", async () => {
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

    // Drive the real domain events and v3 fold instead of hand-written v2
    // restore literals: a finishing Job writes its actor/job-start/job-end
    // records and its view through the production paths.
    service.runner.start = request => {
      request.recordStart(null);
      return { ready: Promise.resolve(),
        done: Promise.resolve({ status: "completed", result: "investigation finished successfully" }), cancel() {} };
    };
    const actor = service.runtime.create({ agents: [{ goal: "initial investigation" }] }).items[0]!;
    await service.runtime.jobDone(actor.id);

    const jobs = service.runtime.jobs.bind(service.runtime);
    let jobProjections = 0;
    service.runtime.jobs = (...args) => { jobProjections++; return jobs(...args); };
    const root = await service.list({}, "main");
    assert.equal(jobProjections, 1, "list shares one historical Job projection instead of rebuilding it per row");
    assert.ok(root, "Root service list should return a root tree item");
    assert.equal(root.id, "main");
    assert.equal("historyDir" in root, false, "the list never publishes the internal views directory");

    const expectedHistoryDir = path.join(agentDir, SUBAGENT_SESSIONS_DIR, sessionId, "views");

    assert.equal(root.children.length, 1);
    const child = root.children[0]!;
    assert.equal(child.id, actor.id);
    assert.equal("historyDir" in child, false, "no node advertises historyDir");

    assert.ok(child.history, "Child item should retain per-Job history paths");
    assert.equal("jobId" in child.history, false, "the list node never repeats the Job id");
    assert.equal(child.history.summary, path.join(expectedHistoryDir, actor.id, "summary.md"));
    assert.equal(child.history.cleanJsonl, path.join(expectedHistoryDir, actor.id, "transcript.jsonl"));

    assert.ok(existsSync(child.history.summary), "summary.md should exist in views");
    assert.ok(existsSync(child.history.cleanJsonl), "transcript.jsonl should exist in views");

    const summaryContent = await readFile(child.history.summary, "utf-8");
    assert.ok(summaryContent.includes("investigation finished successfully"));
  } finally {
    await service.retire();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("id-selected subtree covers the current round without publishing historyDir or jobId", async () => {
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

    let result = "round 1 result";
    service.runner.start = request => {
      request.recordStart(null);
      return { ready: Promise.resolve(), done: Promise.resolve({ status: "completed", result }), cancel() {} };
    };
    const actor = service.runtime.create({ agents: [{ goal: "round 1 task" }] }).items[0]!;
    await service.runtime.jobDone(actor.id);
    result = "round 2 result";
    const wake = await service.runtime.sendMessage({ from: "main", to: actor.address, content: "round 2 task" });
    assert.ok("jobId" in wake && wake.jobId);
    await service.runtime.jobDone(wake.jobId);

    const expectedHistoryDir = path.join(agentDir, SUBAGENT_SESSIONS_DIR, sessionId, "views");
    const subtree = await service.list({ id: actor.id }, "main");
    assert.ok(subtree, "Subtree should be returned for existing agent id");
    assert.equal(subtree.id, actor.id);
    assert.equal("historyDir" in subtree, false, "a subtree root never advertises historyDir");

    assert.ok(subtree.history, "Agent should carry latest history paths");
    assert.equal("jobId" in subtree.history, false, "the caller infers the round from the path, not a Job id field");
    assert.equal(subtree.history.summary, path.join(expectedHistoryDir, wake.jobId, "summary.md"));

    // The current round is the one whose canonical expected path was used.
    assert.ok((await readFile(subtree.history.summary, "utf-8")).includes("round 2 result"));
    // Both previous and current round folders exist in the internal views dir.
    assert.ok(existsSync(path.join(expectedHistoryDir, actor.id, "summary.md")), "Previous round view exists");
    assert.ok(existsSync(path.join(expectedHistoryDir, wake.jobId, "summary.md")), "Latest round view exists");
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

    service.runner.start = request => {
      request.recordStart(null);
      return { ready: Promise.resolve(), done: Promise.resolve({ status: "completed", result: "memory result" }), cancel() {} };
    };
    const actor = service.runtime.create({ agents: [{ goal: "memory task" }] }).items[0]!;
    await service.runtime.jobDone(actor.id);

    const root = await service.list({}, "main");
    assert.ok(root);
    assert.equal(root.id, "main");
    assert.equal("historyDir" in root, false, "Root item must not advertise historyDir in memory-only mode");

    assert.equal(root.children.length, 1);
    assert.equal("historyDir" in root.children[0]!, false);

    const subtree = await service.list({ id: actor.id }, "main");
    assert.ok(subtree);
    assert.equal(subtree.id, actor.id);
    assert.equal("historyDir" in subtree, false, "Subtree root must not advertise historyDir in memory-only mode");

    const missing = await service.list({ id: "nonexistent" }, "main");
    assert.equal(missing, null);
  } finally {
    await service.retire();
    await rm(cwd, { recursive: true, force: true });
  }
});
