/**
 * A native session rename reaches the shared directory.
 *
 * The SDK reports `session_info_changed`; the owning root mirrors the native
 * name into its record, so this session, another live session and the
 * user-facing `/subagent sessions` all read the new name without a restart.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

import { installSubagentCommand } from "../../src/subagent/command.ts";
import subagentExtension from "../../src/subagent/extension.ts";
import { RootService } from "../../src/subagent/root-service.ts";

interface Harness {
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly commands: Map<string, RegisteredCommand>;
}

function harness(cwd: string, agentDir: string, sessionManager: SessionManager): Harness {
  const commands = new Map<string, RegisteredCommand>();
  const api = {
    appendEntry: () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
    sendMessage: () => {},
    registerTool: () => {},
    registerCommand: (name: string, command: RegisteredCommand) => { commands.set(name, command); },
  } as unknown as ExtensionAPI;
  const context = {
    modelRegistry: { find: () => undefined },
    sessionManager,
    cwd,
    isIdle: () => true,
    ui: { notify: () => {}, addAutocompleteProvider: () => {} },
  } as unknown as ExtensionContext;
  return { api, context, commands };
}

async function fixture(t: test.TestContext): Promise<{ cwd: string; agentDir: string; sessionDir: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "session-name-sync-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = path.join(cwd, "agent");
  const sessionDir = path.join(cwd, "sessions");
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  return { cwd, agentDir, sessionDir };
}

function service(harnessed: Harness, agentDir: string): RootService {
  return new RootService({
    api: harnessed.api,
    context: harnessed.context,
    agentDir,
    allocatedIds: new Set(),
    ownsContext: () => true,
  });
}

test("a native rename updates this session and another session's discovery view", async (t) => {
  const { cwd, agentDir, sessionDir } = await fixture(t);
  const managerA = SessionManager.create(cwd, sessionDir);
  const managerB = SessionManager.create(cwd, sessionDir);
  const a = service(harness(cwd, agentDir, managerA), agentDir);
  const b = service(harness(cwd, agentDir, managerB), agentDir);
  try {
    await a.initialize();
    await b.initialize();
    assert.equal((await a.listSessions()).find((session) => session.sessionId === a.sessionId)?.name, null);

    managerA.appendSessionInfo("renamed synthetic worker");
    await a.syncSessionName(managerA.getSessionName() ?? null);

    assert.equal(
      (await a.listSessions()).find((session) => session.sessionId === a.sessionId)?.name,
      "renamed synthetic worker",
    );
    assert.equal(
      (await b.listSessions()).find((session) => session.sessionId === a.sessionId)?.name,
      "renamed synthetic worker",
      "another live session reads the new name from the directory",
    );
  } finally {
    await a.retire();
    await b.retire();
  }
});

test("a session published with an initial name replaces it after a rename", async (t) => {
  const { cwd, agentDir, sessionDir } = await fixture(t);
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendSessionInfo("initial synthetic name");
  const root = service(harness(cwd, agentDir, manager), agentDir);
  try {
    await root.initialize();
    assert.equal((await root.listSessions()).find((session) => session.sessionId === root.sessionId)?.name, "initial synthetic name");

    manager.appendSessionInfo("second synthetic name");
    await root.syncSessionName(manager.getSessionName() ?? null);
    assert.equal((await root.listSessions()).find((session) => session.sessionId === root.sessionId)?.name, "second synthetic name");
  } finally {
    await root.retire();
  }
});

test("/subagent sessions shows the renamed session without a restart", async (t) => {
  const { cwd, agentDir, sessionDir } = await fixture(t);
  const manager = SessionManager.create(cwd, sessionDir);
  const harnessed = harness(cwd, agentDir, manager);
  const root = service(harnessed, agentDir);
  try {
    await root.initialize();
    installSubagentCommand(harnessed.api, async () => root);
    const command = harnessed.commands.get("subagent");
    assert.ok(command);
    const notifications: string[] = [];
    const ctx = {
      ui: { notify: (text: string) => { notifications.push(text); } },
      sessionManager: { getSessionId: () => root.sessionId },
    } as unknown as ExtensionCommandContext;

    manager.appendSessionInfo("renamed synthetic worker");
    await root.syncSessionName(manager.getSessionName() ?? null);
    await command.handler("sessions", ctx);
    assert.match(notifications[0] ?? "", /renamed synthetic worker/);
  } finally {
    await root.retire();
  }
});

test("the extension subscribes to the native session rename event", () => {
  const events: string[] = [];
  const api = {
    on: (event: string) => { events.push(event); return () => {}; },
    registerTool: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  subagentExtension(api);
  assert.ok(events.includes("session_info_changed"), "the rename lifecycle event is the update source");
});
