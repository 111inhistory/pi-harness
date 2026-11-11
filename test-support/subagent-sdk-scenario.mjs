// Executed in a disposable child process: short IDs, sockets and relative history
// paths must never touch the developer's live session or workspace.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createWriteToolDefinition, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";
import { promptString, promptStrings } from "../src/prompt-text.ts";
import { getAgentSocketPath, getBroadcastSocketPath } from "../src/ipc/socket.ts";
import { waitFor } from "./async.ts";
import { treeNodes } from "../test/typed/support/agent-tree.ts";
import {
  isStoppingRefusal, deliverToActor,
} from "../test/typed/support/subagent-sdk-fixture.ts";
import {
  runExternalSocketScenario, runListenerCacheScenario, runPeerSenderScenario,
  runRestoreInvalidScenario,
} from "../test/typed/support/subagent-sdk-scenarios.ts";
import { runAsyncShellScenario } from "../test/typed/support/async-shell-sdk-scenario.ts";
import {
  runPackageSkillsScenario,
  runResponsesOnlyScenario,
  runResponsesPrefixScenario,
  runCapabilityMissingScenario,
  runNamespaceScenario,
} from "../test/typed/support/capability-batch-scenarios.ts";

import { createSdkFixture } from "./subagent-sdk-fixture.ts";

const scenario = process.argv[2];
const fixture = await createSdkFixture({ scenario });
const { cwd, agentDir, sessionSocketDir, session, sessionManager, model, controls, chats, notificationChats, classifications, textAnswer, toolAnswer, assistant, call, create, item, stopped, listener, events, controlledGate, abortable, durable, childManagers } = fixture;
let scenarioError;
try {
  if (scenario === 'async-shell' || scenario === 'async-shell-powershell') {
    await runAsyncShellScenario(fixture, scenario === 'async-shell-powershell' ? 'powershell' : 'bash');
  } else if (scenario === "listener-cache") {
    await runListenerCacheScenario(fixture);
  } else if (scenario === "reviewer-sol") {
    controls.classify = (context) => {
      assert.deepEqual(Object.keys(context.questions), ["role"], "singleton reviewer pool must not ask for model selection");
    };
    controls.chat = (request) => {
      assert.equal(model.provider, "openai-codex");
      assert.equal(model.id, "gpt-6.1-sol");
      assert.equal(request.options.reasoning, "high", "high..high reaches the native SDK as high");
      const tools = getCurrentTools(request.context.messages).map((tool) => tool.name);
      assert.ok(tools.includes("msg_write"));
      assert.equal(tools.includes("write"), false);
      return textAnswer("Independent review complete");
    };
    const reviewer = await create("Independently assess this artifact; do not modify files");
    await stopped(reviewer.id);
    assert.equal(classifications.length, 1);
    assert.equal(chats.length, 1);
    assert.equal("budget" in (await stopped(reviewer.id)), false);
  } else if (scenario.startsWith("package-skills")) {
    await runPackageSkillsScenario(fixture, {
      cold: scenario === "package-skills-cold",
      expected: scenario === "package-skills-cold" ? ["ppt-master"] : ["cli-ppt", "ppt-master"],
    });
  } else if (scenario === "responses-only") {
    await runResponsesOnlyScenario(fixture);
  } else if (scenario === "responses-prefix") {
    await runResponsesPrefixScenario(fixture);
  } else if (scenario === "capability-missing") {
    await runCapabilityMissingScenario(fixture);
  } else if (scenario === "namespace-leaf") {
    let leafResult;
    controls.chat = (request) => {
      const tools = getCurrentTools(request.context.messages).map((tool) => tool.name);
      const resultOf = (name) => request.context.messages.findLast((message) => message.role === "toolResult" && message.toolName === name);
      if (request.text.includes("NAMESPACE_LEAF")) {
        for (const name of ["subagent_create", "subagent_stop", "capability"]) assert.equal(tools.includes(name), false);
        assert.ok(tools.includes("subagent_list"));
        assert.ok(tools.includes("write"));
        assert.equal(tools.includes("msg_write"), true);
        leafResult = true;
        return textAnswer("Leaf tools checked");
      }
      if (!resultOf("subagent_create")) return toolAnswer("subagent_create", { tasks: [{ task: "NAMESPACE_LEAF" }] });
      return textAnswer("Parent done");
    };
    const parent = await create("NAMESPACE_PARENT");
    await waitFor(() => leafResult, { label: "Depth 2 tool boundaries" });
    await stopped(parent.id);
    await stopped(parent.id + "_01");
    assert.equal(leafResult, true);
  } else if (scenario === "namespace" || scenario === "namespace-reverse") {
    await runNamespaceScenario(fixture);
  } else if (scenario === "surface") {
    const names = session.getActiveToolNames();
    const subagents = ["subagent_create", "subagent_list", "subagent_stop"];
    assert.ok(names.includes("write"));
    for (const name of subagents) {
      assert.equal(names.includes(name), false, "Subagent is registered but not active by default");
      const tool = session.getToolDefinition(name);
      assert.equal(tool.defaultActive, false);
      assert.equal(tool.namespace.name, "subagent");
      assert.equal(tool.promptSnippet, undefined);
      assert.equal(tool.promptGuidelines, undefined);
    }
    assert.doesNotMatch(session.systemPrompt, /subagent_create|one JSON object per line/);
    const nativeWrite = createWriteToolDefinition(cwd);
    for (const field of ["description", "promptSnippet", "promptGuidelines", "parameters"]) {
      assert.deepEqual(session.getToolDefinition("write")[field], nativeWrite[field]);
    }
    session.setActiveToolsByName([...names, ...subagents]);
    for (const name of ["create", "list", "stop", "task", "hub", "wait"]) assert.equal(names.includes(name), false);
    await assert.rejects(call("subagent_create", { tasks: [{ task: "valid" }, { task: "invalid", model: "override" }] }));
    assert.deepEqual(treeNodes((await call("subagent_list", {})).details).map((agent) => agent.id), ["Main"]);
    await listener(getAgentSocketPath("Main", sessionSocketDir));
    if (process.platform !== "win32") assert.deepEqual((await fsp.readdir(sessionSocketDir)).sort(), ["Main.sock", "main"], "invalid batches must not publish any child endpoint");
    else assert.deepEqual(process._getActiveHandles().filter((handle) => handle instanceof net.Server && handle.listening).map((handle) => handle.address()).sort(), [getAgentSocketPath("Main", sessionSocketDir), getBroadcastSocketPath("Main", sessionSocketDir)].sort());
    const gate = controlledGate();
    controls.classify = (_, options) => abortable(gate, options.signal);
    let returned = false;
    const creating = call("subagent_create", { context: "Explicit batch context", tasks: [{ task: "Initial assignment" }, { task: "Stopped during routing" }] });
    const outcome = creating.then((result) => { returned = true; return result; }, (error) => { returned = true; return error; });
    await waitFor(() => classifications.length > 0, { label: "create waits for initial routing" });
    const [first, second] = (await call("subagent_list", {})).details.children;
    assert.equal(returned, false, "registration cannot resolve create before the first model dispatch");
    assert.deepEqual([first.id, second.id], ["sub_01", "sub_02"]);
    for (const actor of [first, second]) {
      assert.equal(actor.socket, getAgentSocketPath(actor.id, sessionSocketDir));
      await listener(actor.socket);
    }
    await listener(getBroadcastSocketPath("Main", sessionSocketDir));
    await call("write", { path: "ordinary.txt", content: "Native filesystem write" });
    assert.equal(await fsp.readFile(path.join(cwd, "ordinary.txt"), "utf8"), "Native filesystem write");
    await deliverToActor(fixture, first, "Buffered during routing");
    assert.equal((await call("subagent_stop", { id: second.id })).details.status, "stopping");
    gate.resolve();
    const failedCreation = await outcome;
    assert.equal(failedCreation.code, "start_failed");
    assert.match(failedCreation.message, /sub_02/);
    await stopped(first.id);
    await stopped(second.id);
    assert.equal(chats.length, 1, "the stopped actor must not dispatch a chat request");
    assert.match(chats[0].text, /Explicit batch context/);
    assert.match(chats[0].text, /Initial assignment/);
    assert.match(chats[0].text, /Buffered during routing/);
    const childPrompt = chats[0].context.messages.filter((message) => message.role === "system").map(getSystemMessageText).join("\n");
    assert.ok(childPrompt.includes(first.id), "the child receives its actual actor identity");
    assert.ok(childPrompt.includes(getAgentSocketPath("Main", sessionSocketDir)), "the child receives its real parent endpoint");
    assert.ok(childPrompt.includes(promptString("subagent-tools.json", "instructions")), "models outside Responses/Anthropic still receive namespace usage rules");
    assert.ok(childPrompt.includes(promptString("subagent-tools.json", "create", "guideline")), "the child receives the create-specific rule with its declared tool");
    for (const rule of promptStrings("subagent-tools.json", "msg_write", "guidelines")) {
      assert.ok(childPrompt.includes(rule), "messaging rules survive the metadata migration on other APIs");
    }
    assert.equal("budget" in (await stopped(first.id)), false);
  } else if (scenario === "external-socket") {
    await runExternalSocketScenario(fixture);
  } else if (["upstream-main-clear", "upstream-main-clear-terminal", "upstream-main-esc"].includes(scenario)) {
    const clearTerminal = scenario === "upstream-main-clear-terminal";
    const escaping = scenario === "upstream-main-esc";
    const mainSocket = getAgentSocketPath("Main", sessionSocketDir);
    await listener(mainSocket);
    const mainStarted = controlledGate();
    const mainExit = controlledGate();
    const childExit = controlledGate();
    controls.chat = async (request) => {
      if (request.text.includes("UPSTREAM_CLEAR_CHILD")) {
        const wrote = request.context.messages.some((message) => message.role === "toolResult" && message.toolName === "msg_write");
        if (!wrote) return toolAnswer("msg_write", { path: mainSocket, content: "PROGRESS_EXPLICITLY_CLEARED" }, "clear-progress-write");
        await childExit.promise;
        return textAnswer("Child completed after the ordinary steer was cleared");
      }
      mainStarted.resolve();
      await abortable(mainExit, request.options.signal);
      return textAnswer("Root model turn completed");
    };
    const rootTurn = session.prompt("ROOT_CLEAR_BUSY");
    await mainStarted.promise;
    const actor = await create("UPSTREAM_CLEAR_CHILD: send progress, then finish");
    await waitFor(() => session.agent.hasQueuedMessages(), { label: "ordinary child steer queued" });
    if (escaping) {
      await session.abort();
      await rootTurn;
    }
    session.clearQueue();
    assert.equal(session.agent.hasQueuedMessages(), false);
    childExit.resolve();
    if (escaping) {
      await waitFor(() => notificationChats.length === 1, { label: "post-abort completion wakes Main through native steer" });
    } else {
      await waitFor(() => session.agent.hasQueuedMessages(), { label: "terminal notification queues after native clearQueue" });
      if (clearTerminal) session.clearQueue();
      mainExit.resolve();
      await rootTurn;
    }
    await stopped(actor.id);
    await session.waitForIdle();
    const received = session.messages.filter((message) => message.role === "custom" && message.customType === "agent-delivery");
    assert.equal(received.length, clearTerminal ? 0 : 1, "native queue clearing is respected without replay");
    if (!clearTerminal) {
      assert.equal(received[0].details.sourceId, actor.id);
      assert.equal(received[0].details.status, "completed");
      assert.doesNotMatch(JSON.stringify(received[0].content), /PROGRESS_EXPLICITLY_CLEARED/, "cleared ordinary steering is not replayed");
    }
    assert.equal(notificationChats.length, clearTerminal ? 0 : 1);
  } else if (["upstream-main", "upstream-main-steer", "upstream-main-reload"].includes(scenario)) {
    const mainSocket = getAgentSocketPath("Main", sessionSocketDir);
    await listener(mainSocket);
    assert.notEqual(mainSocket, getBroadcastSocketPath("Main", sessionSocketDir));
    const mainStarted = controlledGate();
    const mainExit = controlledGate();
    const delivered = controlledGate();
    const steering = scenario === "upstream-main-steer";
    const childExit = controlledGate();
    let armed = scenario !== "upstream-main-reload";
    let mainRequests = 0;
    controls.chat = async (request) => {
      if (request.text.includes("UPSTREAM_CHILD")) {
        const tools = getCurrentTools(request.context.messages).map((tool) => tool.name);
        assert.ok(tools.includes("msg_write"));
        assert.equal(tools.includes("write"), false);
        assert.match(request.text, /Your direct parent is Main/);
        assert.ok(request.text.includes(mainSocket), "child context exposes the real parent receiving endpoint");
        const wrote = request.context.messages.some((message) => message.role === "toolResult" && message.toolName === "msg_write");
        if (armed && !wrote) return toolAnswer("msg_write", { path: mainSocket, content: "UPSTREAM_MAIN_MARKER" }, "upstream-write");
        if (steering) await childExit.promise;
        return textAnswer("Child done");
      }
      mainRequests++;
      if (request.text.includes("UPSTREAM_MAIN_MARKER")) {
        assert.match(request.text, /\[Message from sub_01\]/);
        delivered.resolve();
      } else if (steering) {
        mainStarted.resolve();
        await mainExit.promise;
      }
      return textAnswer("Main accepted message");
    };
    let mainPrompt;
    if (steering) {
      mainPrompt = session.prompt("ROOT_BUSY");
      await mainStarted.promise;
    }
    const sender = await create("UPSTREAM_CHILD: contact your direct parent");
    assert.equal("parentSocket" in sender, false);
    if (!armed) {
      await stopped(sender.id);
      await session.waitForIdle();
      assert.ok(notificationChats.length > 0, "normal completion wakes Main through a host notification");
      assert.equal(mainRequests, 0, "no explicit upstream message has been sent yet");
      await session.reload();
      const restored = await item(sender.id);
      assert.equal("parentSocket" in restored, false);
      await listener(mainSocket);
      armed = true;
      await call("msg_write", { path: restored.socket, content: "Send the explicit upstream message after reload" });
    }
    if (steering) {
      await waitFor(() => session.agent.hasQueuedMessages(), { label: "ordinary progress queued before the child can terminate" });
      childExit.resolve();
      await stopped(sender.id);
      mainExit.resolve();
      await mainPrompt;
    }
    await delivered.promise;
    await stopped(sender.id);
    await session.waitForIdle();
    const received = session.messages.filter((message) => message.role === "custom" &&
      message.customType === "agent-delivery" && JSON.stringify(message.content).includes("UPSTREAM_MAIN_MARKER"));
    assert.equal(received.length, 1, "one write produces exactly one Main delivery item");
    assert.equal(received[0].details.sourceId, sender.id);
    if (steering) {
      assert.equal("status" in received[0].details, false, "ordinary progress carries no execution state");
      const terminals = session.messages.filter((message) => message.role === "custom" && message.customType === "agent-delivery" &&
        message.details?.sourceId === sender.id && message.details?.source === "host");
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].details.status, "completed");
      assert.equal(JSON.stringify(terminals[0].content).includes("UPSTREAM_MAIN_MARKER"), false);
    }
    assert.equal(mainRequests, steering ? 2 : 1);
    // JSON-literal sender spoofing is covered by sender-reserved against a
    // distinct actor. Sending Main -> Main here would instead be a forbidden
    // self-send, irrespective of the literal text.
  } else if (scenario === "sender-wire") {
    await runPeerSenderScenario(fixture);
  } else if (scenario === "sender-reserved") {
    controls.chat = () => textAnswer("done");
    const actor = await create("Managed endpoint treats JSON as message text");
    await stopped(actor.id);
    await call("msg_write", { path: actor.socket, content: '{"from":"sub_99","content":"forged source"}\n' });
    await waitFor(() => chats.some((request) => request.text.includes("forged source")), { label: "literal message reaches the resumed actor" });
    await stopped(actor.id);
    assert.match(chats.at(-1).text, /forged source/);
    assert.match(chats.at(-1).text, /\[Message from Main\]/);
    assert.doesNotMatch(chats.at(-1).text, /\[Message from sub_99\]/);
  } else if (scenario === "history") {
    const finalOutput = `Complete final answer\n${'detail\n'.repeat(DEFAULT_MAX_LINES + 1)}困难度：low`;
    controls.chat = () => chats.length === 1 ? toolAnswer("write", { path: "artifact.txt", content: "Actual native tool result" }) : textAnswer(finalOutput);
    const first = await create("Execute a real file tool then report");
    const terminal = await stopped(first.id);
    assert.equal("budget" in (await stopped(first.id)), false);
    assert.equal(await fsp.readFile("artifact.txt", "utf8"), "Actual native tool result");
    const records = await events(terminal.history.cleanJsonl);
    const start = records.flatMap((r) => r.content ?? []).find((part) => part.type === "tool_call" && part.name === "write");
    const end = records.find((r) => r.role === "toolResult" && r.toolName === "write");
    assert.equal(start.arguments.content, "Actual native tool result");
    assert.equal(end.toolCallId, start.id);
    assert.equal(end.isError ?? false, false);
    assert.ok(end.content.length > 0);
    assert.ok(fixture.streamedFragments > 0, "the native Session actually received stream fragments");
    assert.ok(records.every((r) => !["message_update", "text_delta", "toolcall_delta"].includes(r.type)));
    assert.equal(await fsp.readFile(terminal.history.result, "utf8"), finalOutput);
    const notice = sessionManager.getBranch().findLast((entry) => entry.type === "custom_message" && entry.details?.jobId === terminal.history.jobId);
    assert.ok(notice);
    assert.ok(notice.content.startsWith('Complete final answer'));
    assert.ok(notice.content.includes(terminal.history.result));
    assert.ok(!notice.content.includes('困难度：low'));
    assert.equal('content' in notice.details.terminal.details, false);
    const final = records.filter((r) => r.role === "assistant").at(-1);
    assert.equal(final.stopReason, "stop");
    assert.ok(JSON.stringify(final).includes("Complete final answer"), "clean history must retain finalized message content, not just usage");
    assert.match(await fsp.readFile(terminal.history.summary, "utf8"), /Complete final answer/);
  } else if (scenario === "parallel") {
    const exit = controlledGate();
    controls.chat = async (request) => {
      const spawned = request.context.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent_create");
      if (request.text.includes("PARALLEL_PARENT") && !spawned) {
        return toolAnswer("subagent_create", { tasks: [1, 2, 3, 4].map((index) => ({ task: `Parallel child assignment ${index}` })) });
      }
      if (request.text.includes("PARALLEL_PARENT")) {
        const resultOf = (name) => request.context.messages.findLast((message) => message.role === "toolResult" && message.toolName === name);
        const listed = resultOf("subagent_list");
        if (!listed) return toolAnswer("subagent_list", {});
        const parse = (message) => JSON.parse(message.content.find((part) => part.type === "text").text);
        const ownId = parse(resultOf("subagent_create")).items[0].id.replace(/_\d+$/, "");
        const view = parse(listed);
        assert.equal(treeNodes(view).length, 9, "Main, four peers including self, four own children");
        assert.equal(view.children.find((agent) => agent.id === ownId).children.length, 4);
        assert.ok(view.children.filter((agent) => agent.id !== ownId).every((agent) => agent.children.length === 0));
      }
      await exit.promise;
      return textAnswer("Parallel actor finished");
    };
    const roots = (await call("subagent_create", { tasks: [1, 2, 3, 4].map((index) => ({ task: `PARALLEL_PARENT ${index}` })) })).details.items;
    const actors = await waitFor(async () => {
      const all = treeNodes((await call("subagent_list", {})).details).filter((agent) => agent.id !== "Main");
      return all.length === 20 && all.every((actor) => actor.status === "running") && chats.length === 28 && all;
    }, { label: "four parents and sixteen native children running together" });
    const tree = (await call("subagent_list", {})).details;
    assert.equal(tree.children.length, 4);
    assert.equal(tree.children.flatMap((actor) => actor.children).length, 16);
    for (const parent of roots) assert.equal(tree.children.find((actor) => actor.id === parent.id).children.length, 4);
    for (const actor of actors) await listener(actor.socket);
    exit.resolve();
    await Promise.all(actors.map((actor) => stopped(actor.id)));
  } else if (scenario === "failure") {
    controls.chat = () => assistant([], "error", "Local provider failure");
    const first = await create("Fail a native model request");
    const terminal = await stopped(first.id);
    assert.equal("budget" in (await stopped(first.id)), false);
    assert.match(await fsp.readFile(terminal.history.summary, "utf8"), /`failed`[\s\S]*Local provider failure/);
    const notices = sessionManager.getBranch().filter((entry) => entry.type === "custom_message");
    assert.equal(notices.length, 1);
    await session.waitForIdle();
    assert.equal(chats.length, 1, "the failing child dispatched one request");
    assert.equal(notificationChats.length, 1, "failure notification wakes Main once");
    assert.equal(session.isStreaming, false);
    const notice = notices[0].details;
    assert.equal(notice.source, "host");
    assert.equal(notice.sourceId, first.id);
    assert.equal(notice.status, "failed");
    assert.deepEqual(notice.terminal.details.history, { summary: terminal.history.summary, cleanJsonl: terminal.history.cleanJsonl, result: terminal.history.result });
  } else if (scenario === "memory-owners") {
    assert.equal(typeof globalThis.gc, "function");
    const actor = await create("Retain actor identity but release its native manager", { inheritContext: true });
    const initial = await stopped(actor.id);
    await session.waitForIdle();
    // The fake provider records options for scheduler assertions. Those options
    // contain Pi's live stream callback, which itself owns the native manager.
    // A completed provider must release them before testing plugin ownership.
    for (const request of chats) request.options = null;
    for (let i = 0; i < 5; i++) { await new Promise((resolve) => setImmediate(resolve)); globalThis.gc(); }
    assert.ok(childManagers.length > 0);
    if (process.env.PI_HEAP_SNAPSHOT) (await import("node:v8")).writeHeapSnapshot(process.env.PI_HEAP_SNAPSHOT);
    assert.ok(childManagers.every((reference) => reference.deref() === undefined), "terminal persistent managers must not stay in plugin registries/caches");
    const original = await fsp.readFile(initial.history.summary, "utf8");
    await fsp.rm(initial.history.summary);
    const rebuilt = await item(actor.id);
    assert.equal(await fsp.readFile(rebuilt.history.summary, "utf8"), original);
    await session.reload();
    await call("msg_write", { path: actor.socket, content: "Resume with the original assignment still in context" });
    await waitFor(() => chats.length === 2, { label: "persistent actor reopened for continuation" });
    const continued = await stopped(actor.id);
    assert.notEqual(continued.history.jobId, initial.history.jobId);
    assert.equal(classifications.length, 0, "inherited identity must survive file reopen and reload without routing");
    assert.match(chats.at(-1).text, /Retain actor identity/);
    assert.ok(sessionManager.getBranch().filter((entry) => entry.customType === "subagent-job")
      .every((entry) => entry.data.spec.inheritedContext?.entries === undefined));
    await session.waitForIdle();
    for (const request of chats) request.options = null;
    for (let i = 0; i < 5; i++) { await new Promise((resolve) => setImmediate(resolve)); globalThis.gc(); }
    assert.ok(childManagers.every((reference) => reference.deref() === undefined), "reopened and temporary reader managers must be collectible too");
  } else if (scenario === "restore-invalid") {
    await runRestoreInvalidScenario(fixture);
  } else if (scenario === "memory-only") {
    assert.equal(durable, false);
    const actor = await create("PURE_MEMORY_ASSIGNMENT");
    assert.equal((await stopped(actor.id)).history, undefined);
    await call("msg_write", { path: actor.socket, content: "Continue the memory-only conversation" });
    await waitFor(() => chats.length === 2, { label: "memory-only continuation consumed" });
    assert.equal((await stopped(actor.id)).history, undefined);
    assert.match(chats.at(-1).text, /PURE_MEMORY_ASSIGNMENT/);
    assert.equal(classifications.length, 2);
    await assert.rejects(fsp.access(path.join(agentDir, "subagent-sessions")), { code: "ENOENT" });
  } else {
    throw new Error(`Unknown SDK test scenario: ${scenario}`);
  }
} catch (error) {
  scenarioError = error;
  throw error;
} finally {
  try {
    await fixture.close();
  } catch (cleanupError) {
    // Preserve the scenario failure while still reporting cleanup failures.
    if (scenarioError === undefined) throw cleanupError;
    throw new AggregateError([scenarioError, cleanupError], `SDK scenario ${scenario} failed before cleanup reported additional failures.`);
  }
}
console.log(`SCENARIO_OK:${scenario}`);
