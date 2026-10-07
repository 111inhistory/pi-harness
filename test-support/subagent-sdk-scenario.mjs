// Executed in a disposable child process: short IDs, sockets and relative history
// paths must never touch the developer's live session or workspace.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import {
  createAgentSession, createWriteToolDefinition, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream, getSystemMessageText, getCurrentTools } from "@earendil-works/pi-ai";
import subagentExtension from "../extensions/subagent.mjs";
import capabilityExtension from "../extensions/capability.mjs";
import { deriveSessionUid } from "../src/subagent-socket.mjs";
import { deferred, waitFor } from "./async.mjs";

const scenario = process.argv[2];
const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
const socketDir = process.env.PI_SUBAGENT_SOCKET_DIR;
assert.ok(agentDir && socketDir && agentDir.startsWith(cwd) && socketDir.startsWith(cwd));
await fsp.mkdir(agentDir, { recursive: true });

// Fail closed if a supposedly offline test accidentally uses credentials/network.
const networkAttempts = [];
globalThis.fetch = async (url) => {
  networkAttempts.push(String(url));
  throw new Error(`Network forbidden in SDK test: ${url}`);
};
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (!(typeof target === "string" || (target && typeof target.path === "string"))) {
    networkAttempts.push("TCP connect");
    throw new Error("TCP network forbidden in SDK test");
  }
  return originalConnect.apply(this, args);
};

const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
const model = runtime.getModel("openrouter", "~google/gemini-pro-latest");
assert.ok(model, "the installed Pi catalog must contain the configured candidate");
const classifications = [];
const chats = [];
let streamedFragments = 0;
const controls = { classify: null, chat: null };
const gates = [];
const externalServers = [];
const externalConnections = [];
function controlledGate() {
  const gate = deferred();
  gates.push(gate);
  return gate;
}
runtime.getAuth = async () => ({ auth: { apiKey: "offline-test-only" }, env: {} });
runtime.hasConfiguredAuth = () => true;
runtime.classify = async (classifier, context, options) => {
  classifications.push({ context, options });
  if (controls.classify) await controls.classify(context, options);
  const key = Object.keys(context.questions)[0];
  const selected = key === "role" ? "executor" : "gemini";
  const probabilities = Object.fromEntries(Object.keys(context.questions[key].criteria).map((name) => [name, name === selected ? 1 : 0]));
  return { api: classifier.api, provider: classifier.provider, model: classifier.id, answers: {
    [key]: { type: "choice", choice: selected, probabilities, confidence: 1 },
  }, stopReason: "stop", timestamp: Date.now() };
};
function assistant(content, stopReason = "stop", errorMessage) {
  return {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(), ...(errorMessage ? { errorMessage } : {}),
  };
}
const textAnswer = (text) => assistant([{ type: "text", text }]);
const toolAnswer = (name, args, id = "local-tool-call") => assistant([{ type: "toolCall", id, name, arguments: args }], "toolUse");
function textOf(context) {
  return context.messages.map((message) => message.role === "system" ? getSystemMessageText(message) :
    typeof message.content === "string" ? message.content :
      (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n")).join("\n");
}
runtime.streamSimple = (actualModel, context, options) => {
  assert.equal(actualModel.id, model.id);
  const stream = new AssistantMessageEventStream();
  const call = { context, options, text: textOf(context) };
  chats.push(call);
  (async () => {
    try {
      const message = controls.chat ? await controls.chat(call) : textAnswer("Local result. Difficulty: low — scripted offline response.");
      const text = message.content.find((block) => block.type === "text");
      if (text) {
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        const split = Math.max(1, Math.floor(text.text.length / 2));
        for (const end of [split, text.text.length]) {
          const partial = { ...message, content: [{ type: "text", text: text.text.slice(0, end) }], stopReason: "pending" };
          stream.push({ type: "text_delta", contentIndex: 0, delta: text.text.slice(end === split ? 0 : split, end), partial });
          streamedFragments += 1;
        }
      }
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
    } catch (error) {
      stream.push({ type: "error", reason: options.signal?.aborted ? "aborted" : "error", error: assistant([], options.signal?.aborted ? "aborted" : "error", error.message) });
      stream.end();
    }
  })();
  return stream;
};
function abortable(gate, signal) {
  if (signal?.aborted) return Promise.reject(new Error("cancelled local request"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("cancelled local request"));
    signal?.addEventListener("abort", abort, { once: true });
    gate.promise.then(
      (value) => { signal?.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal?.removeEventListener("abort", abort); reject(error); },
    );
  });
}

const durable = scenario === "reload";
const sessionManager = durable ? SessionManager.create(cwd, path.join(cwd, "root-sessions")) : SessionManager.inMemory(cwd);
if (durable) {
  sessionManager.appendMessage({ role: "user", content: "Root seed", timestamp: Date.now() });
  sessionManager.appendMessage(textAnswer("Root seed acknowledged"));
}
const settings = { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { mode: "off" } };
await fsp.writeFile(path.join(agentDir, "settings.json"), JSON.stringify(settings));
const settingsManager = SettingsManager.inMemory(settings);
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  ...(scenario === "inherited" ? { systemPrompt: "Custom inherited system identity" } : {}),
  extensionFactories: [
    ...(["namespace", "namespace-leaf", "capability-missing"].includes(scenario) ? [{ name: "capability", factory: capabilityExtension }] : []),
    ...(scenario === "capability-missing" ? [] : [{ name: "subagent", factory: subagentExtension }]),
    ...(scenario === "namespace-reverse" ? [{ name: "capability", factory: capabilityExtension }] : []),
    { name: "external-test-tool", factory(pi) {
      pi.registerTool({ name: "external_test_tool", label: "External Test Tool", description: "A non-transplantable test extension tool.",
        parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "unused" }] }),
      });
    } },
  ],
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, [], "extension initialization must succeed in a real loader");
const { session } = await createAgentSession({ cwd, agentDir, sessionManager, settingsManager, resourceLoader, modelRuntime: runtime, model, thinkingLevel: "low" });
const extensionErrors = [];
await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
const sessionUid = deriveSessionUid(sessionManager.getSessionId());
const sessionSocketDir = path.join(socketDir, sessionUid);
let toolSequence = 0;
async function call(name, params) {
  const tool = session.getToolDefinition(name);
  assert.ok(tool, `missing native registered tool ${name}`);
  return tool.execute(`test-call-${++toolSequence}`, params, undefined, undefined, session.extensionRunner.createContext());
}
async function writeForDelivery(socketPath, content) {
  const server = process._getActiveHandles().find((handle) => handle instanceof net.Server && handle.address() === socketPath);
  assert.ok(server, "the host must be listening on the returned endpoint");
  const received = deferred();
  server.once("connection", (socket) => socket.once("data", received.resolve));
  await call("write", { path: socketPath, content });
  await received.promise;
}
async function create(task, extra = {}) {
  return (await call("subagent_create", { tasks: [{ name: "LocalTask", task, ...extra }] })).details.items[0];
}
async function item(id) {
  return (await call("subagent_list", { id })).details.items[0];
}
async function stopped(id) {
  return waitFor(async () => {
    const found = await item(id);
    return found?.status === "stopped" && found;
  }, { label: `terminal state of ${id}` });
}
async function events(file) {
  const content = await fsp.readFile(file, "utf8");
  assert.ok(content.endsWith("\n"));
  return content.trim().split("\n").map((line) => JSON.parse(line));
}

try {
  if (scenario === "capability-missing") {
    const result = await call("capability", {});
    assert.equal(result.isError, true);
    assert.equal(result.details.status, "failed");
    assert.match(result.details.warnings.join("\n"), /requires the Subagent extension/);
    assert.equal(chats.length, 0, "dependency failure must not spend a model call");
    assert.equal(classifications.length, 0);
  } else if (scenario === "namespace-leaf") {
    let leafResult;
    controls.chat = (request) => {
      const tools = getCurrentTools(request.context.messages).map((tool) => tool.name);
      const resultOf = (name) => request.context.messages.findLast((message) => message.role === "toolResult" && message.toolName === name);
      if (tools.includes("capability_search")) {
        assert.deepEqual(tools.sort(), ["capability_search", "submit_result"]);
        const search = resultOf("capability_search");
        if (!search) return toolAnswer("capability_search", { query: "namespace://subagent", src: "local" });
        const found = JSON.parse(search.content.find((part) => part.type === "text").text);
        assert.equal(found.tools.length, 1);
        assert.deepEqual(found.tools[0].tools.map((tool) => tool.name), ["subagent_list", "subagent_stop"]);
        return toolAnswer("submit_result", { refs: [found.tools[0].ref] });
      }
      if (request.text.includes("NAMESPACE_LEAF")) {
        assert.equal(tools.includes("subagent_create"), false);
        const result = resultOf("capability");
        if (!result) return toolAnswer("capability", {});
        leafResult = JSON.parse(result.content.find((part) => part.type === "text").text);
        assert.notEqual(leafResult.status, "failed", JSON.stringify(leafResult));
        return textAnswer("Leaf namespace discovery done");
      }
      if (!resultOf("subagent_create")) return toolAnswer("subagent_create", { tasks: [{ task: "NAMESPACE_LEAF" }] });
      return textAnswer("Parent done");
    };
    const parent = await create("NAMESPACE_PARENT");
    await waitFor(() => leafResult, { label: "Depth 2 capability discovery" });
    await stopped(parent.id);
    await stopped(parent.id + "_01");
    assert.deepEqual(leafResult.tools[0].tools.map((tool) => tool.name), ["subagent_list", "subagent_stop"]);
  } else if (scenario === "namespace" || scenario === "namespace-reverse") {
    const members = ["subagent_create", "subagent_list", "subagent_stop"];
    const initial = session.getActiveToolNames();
    assert.ok(members.every((name) => !initial.includes(name)));
    assert.doesNotMatch(session.systemPrompt, /subagent_create|one JSON object per line/);
    const nativeWrite = createWriteToolDefinition(cwd);
    assert.equal(session.getToolDefinition("write").description, nativeWrite.description);
    controls.chat = (request) => {
      assert.deepEqual(getCurrentTools(request.context.messages).map((tool) => tool.name).sort(), ["capability_search", "submit_result"]);
      const search = request.context.messages.findLast((message) => message.role === "toolResult" && message.toolName === "capability_search");
      if (!search) return toolAnswer("capability_search", { query: "subagent", src: "local" });
      const found = JSON.parse(search.content.find((part) => part.type === "text").text);
      const namespaces = found.tools.filter((hit) => hit.namespace === "subagent");
      assert.equal(namespaces.length, 1, "matching members must collapse to one namespace candidate");
      assert.equal(namespaces[0].ref, "namespace://subagent");
      assert.deepEqual(namespaces[0].tools.map((tool) => tool.name), members);
      return toolAnswer("submit_result", { refs: [namespaces[0].ref] });
    };
    const discovery = (await call("capability", {})).details;
    assert.equal(discovery.tools.length, 1, JSON.stringify(discovery));
    assert.equal(discovery.tools[0].kind, "namespace");
    assert.equal(discovery.tools[0].namespace, "subagent");
    assert.deepEqual(discovery.tools[0].tools.map((tool) => tool.name), members);
    assert.match(discovery.tools[0].instructions, /one JSON object per line/);
    assert.ok(members.every((name) => session.getActiveToolNames().includes(name)));
    assert.equal(session.getToolDefinition("write").description, nativeWrite.description);
    const metadata = await call("read", { path: discovery.tools[0].ref });
    assert.match(metadata.content[0].text, /subagent_stop/);
    assert.match(metadata.content[0].text, /one JSON object per line/);
    const gate = deferred();
    controls.classify = (_, options) => abortable(gate, options.signal);
    controls.chat = () => textAnswer("Namespace child done");
    const actor = await create("Namespace task");
    await writeForDelivery(actor.socket, '{"content":"Namespace buffered message"}\n');
    gate.resolve();
    await stopped(actor.id);
    assert.match(chats.at(-1).text, /Namespace buffered message/);
  } else if (scenario === "surface") {
    const names = session.getActiveToolNames();
    const subagents = ["subagent_create", "subagent_list", "subagent_stop"];
    assert.ok(names.includes("write"));
    for (const name of subagents) {
      assert.equal(names.includes(name), false, "Subagent is registered but not active by default");
      const tool = session.getToolDefinition(name);
      assert.equal(tool.defaultActive, false);
      assert.equal(tool.namespace.name, "subagent");
      assert.ok(tool.promptSnippet?.length > 0);
      assert.ok(tool.promptGuidelines?.length > 0);
    }
    assert.doesNotMatch(session.systemPrompt, /subagent_create|one JSON object per line/);
    const nativeWrite = createWriteToolDefinition(cwd);
    for (const field of ["description", "promptSnippet", "promptGuidelines", "parameters"]) {
      assert.deepEqual(session.getToolDefinition("write")[field], nativeWrite[field]);
    }
    session.setActiveToolsByName([...names, ...subagents]);
    const modelPrompt = session.systemPrompt;
    assert.match(modelPrompt, /Fresh agents need self-contained task\/context/);
    assert.match(modelPrompt, /The host binds the sender; omit from and to/);
    assert.match(modelPrompt, /stopped means ended, not necessarily succeeded/);
    assert.equal(modelPrompt.match(/Normal completion does not wake you/g).length, 1, "shared namespace rules are deduplicated");
    assert.match(session.getToolDefinition("subagent_stop").description, /does not wait for shutdown/);
    for (const name of ["create", "list", "stop", "task", "hub", "wait"]) assert.equal(names.includes(name), false);
    await assert.rejects(call("subagent_create", { tasks: [{ task: "valid" }, { task: "invalid", model: "override" }] }));
    assert.deepEqual((await call("subagent_list", {})).details.items, []);
    await assert.rejects(fsp.stat(sessionSocketDir), { code: "ENOENT" });
    const gate = controlledGate();
    controls.classify = (_, options) => abortable(gate, options.signal);
    const result = await call("subagent_create", { context: "Explicit batch context", tasks: [{ task: "Initial assignment" }, { task: "Stopped during routing" }] });
    const [first, second] = result.details.items;
    assert.deepEqual(result.details.items.map((r) => r.id), ["sub_01", "sub_02"]);
    for (const actor of [first, second]) {
      assert.equal(actor.socket, path.join(sessionSocketDir, `${actor.id}.sock`));
      assert.ok((await fsp.stat(actor.socket)).isSocket(), "socket is available before routing finishes");
    }
    assert.ok((await fsp.stat(path.join(sessionSocketDir, "main", "children.sock"))).isSocket());
    await call("write", { path: "ordinary.txt", content: "Native filesystem write" });
    assert.equal(await fsp.readFile(path.join(cwd, "ordinary.txt"), "utf8"), "Native filesystem write");
    await writeForDelivery(first.socket, '{"content":"Buffered during routing"}\n');
    assert.equal((await call("subagent_stop", { id: second.id })).details.status, "stopping");
    gate.resolve();
    await stopped(first.id);
    await stopped(second.id);
    assert.equal(chats.length, 1, "the stopped actor must not dispatch a chat request");
    assert.match(chats[0].text, /Explicit batch context/);
    assert.match(chats[0].text, /Initial assignment/);
    assert.match(chats[0].text, /Buffered during routing/);
    const childPrompt = chats[0].context.messages.filter((message) => message.role === "system").map(getSystemMessageText).join("\n");
    assert.match(childPrompt, /Normal completion does not wake you/);
    assert.match(childPrompt, /The host binds the sender; omit from and to/);
    assert.equal((await item(first.id)).budget.modelCalls, 3, "two classifiers plus one native chat");
  } else if (scenario === "external-socket") {
    const exit = controlledGate();
    controls.chat = async (request) => {
      await exit.promise;
      if (request.options.signal.aborted) throw new Error("cancelled local request");
      return textAnswer("native actor output");
    };
    const actor = await create("Actor with a same-named external socket");
    await waitFor(() => chats.length === 1, { label: "native actor request" });
    await call("subagent_stop", { id: actor.id });
    assert.equal((await item(actor.id)).status, "stopping");
    const dir = path.join(cwd, "external");
    await fsp.mkdir(dir);
    // Same basename as a stopping Agent, but NOT one of the registered endpoints.
    const externalPath = path.join(dir, `${actor.id}.sock`);
    const received = deferred();
    const server = net.createServer((socket) => {
      externalConnections.push(socket);
      let buffer = "";
      socket.on("error", () => {}); // A writer is allowed to close without reading our reply.
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.endsWith("\n")) {
          received.resolve(buffer);
          socket.end('{"external_reply":"not an Agent result"}\n');
        }
      });
    });
    externalServers.push(server);
    const listening = once(server, "listening");
    server.listen(externalPath);
    await listening;
    const payload = '{"from":"external-client","content":"Own protocol payload","sequence":7}';
    const result = await call("write", { path: externalPath, content: payload });
    assert.ok(result.content.some((block) => block.type === "text" && /Successfully wrote/i.test(block.text)));
    assert.equal(await received.promise, payload + "\n", "external payload must not acquire Subagent identity fields");
    assert.equal((await call("subagent_list", {})).details.items.length, 1, "writing an external socket must not create an actor");
    assert.equal((await item(actor.id)).status, "stopping", "an external socket must not revive a same-named actor");
    assert.equal(chats.length, 1);
    assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message").length, 0, "external responses must not become Agent messages");
    exit.resolve();
    await stopped(actor.id);
  } else if (scenario === "sender-wire" || scenario === "sender-context") {
    // The model of sub_01 executes native write to sub_02, rather than the root
    // impersonating a child with a dummy execution context.
    const routing = controlledGate();
    const receiverExit = controlledGate();
    controls.classify = (_, options) => abortable(routing, options.signal);
    controls.chat = async (request) => {
      const wrote = request.context.messages.some((message) => message.role === "toolResult" && message.toolName === "write");
      if (request.text.includes("SOCKET_SENDER_ACTOR") && !wrote) {
        return toolAnswer("write", { path: path.join(sessionSocketDir, "sub_02.sock"), content: '{"content":"PEER_SOURCE_MARKER"}\n' }, "peer-write");
      }
      if (request.text.includes("SOCKET_RECEIVER_ACTOR")) await receiverExit.promise;
      return textAnswer("actor done");
    };
    const [sender, receiver] = (await call("subagent_create", { tasks: [
      { task: "SOCKET_SENDER_ACTOR send to peer" }, { task: "SOCKET_RECEIVER_ACTOR receive from peer" },
    ] })).details.items;
    const endpoint = process._getActiveHandles().find((handle) => handle instanceof net.Server && handle.address() === receiver.socket);
    assert.ok(endpoint);
    const received = deferred();
    endpoint.once("connection", (socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) received.resolve(JSON.parse(buffer.split("\n")[0]));
      });
    });
    routing.resolve();
    const frame = await received.promise;
    receiverExit.resolve();
    await Promise.all([stopped(sender.id), stopped(receiver.id)]);
    if (scenario === "sender-wire") {
      assert.equal(frame.content, "PEER_SOURCE_MARKER");
      assert.equal(frame.from, sender.id, "the outbound NDJSON must identify the actual native write owner");
    } else {
      const receiverRequests = chats.filter((request) => request.text.includes("SOCKET_RECEIVER_ACTOR"));
      const text = receiverRequests.at(-1).text;
      assert.match(text, /PEER_SOURCE_MARKER/);
      assert.ok(text.includes(`[Message from ${sender.id}]`), "the listener must not relabel a child sender as Main");
      assert.equal(text.includes("[Message from Main]"), false);
    }
  } else if (scenario === "sender-reserved") {
    const exit = controlledGate();
    controls.chat = async () => { await exit.promise; return textAnswer("done"); };
    const actor = await create("Managed endpoint rejects caller-supplied identity");
    await waitFor(() => chats.length === 1, { label: "native actor request" });
    await assert.rejects(call("write", { path: actor.socket, content: '{"from":"sub_99","content":"forged source"}\n' }), (error) => error.code === "invalid_message");
    exit.resolve();
  } else if (scenario === "revive") {
    const first = await create("Original assignment marker");
    await stopped(first.id);
    const endpoint = await fsp.stat(first.socket);
    let previousMarkdown = await fsp.readFile(first.history.summary, "utf8");
    let previousJsonl = await fsp.readFile(first.history.cleanJsonl, "utf8");
    assert.match(previousMarkdown, /Local result/);
    assert.equal(classifications.length, 2);
    for (const round of [2, 3]) {
      await call("write", { path: first.socket, content: JSON.stringify({ content: `Explicit continuation ${round}` }) + "\n" });
      await waitFor(() => chats.length === round, { label: `revival ${round} native request` });
      const current = await stopped(first.id);
      assert.equal(current.socket, first.socket);
      assert.deepEqual(current.history, first.history);
      assert.equal((await fsp.stat(first.socket)).ino, endpoint.ino, "revive must not replace the listener");
      assert.equal(classifications.length, 2, "settled identity must not reroute");
      assert.equal(current.budget.modelCalls, 1, "a continuation gets a fresh Budget");
      assert.match(chats[round - 1].text, new RegExp(`Explicit continuation ${round}`));
      assert.equal(chats[round - 1].text.split("Original assignment marker").length - 1, 1, "the initial task is history, not re-injected");
      const markdown = await fsp.readFile(first.history.summary, "utf8");
      const jsonl = await fsp.readFile(first.history.cleanJsonl, "utf8");
      assert.ok(markdown.startsWith(previousMarkdown));
      assert.ok(jsonl.startsWith(previousJsonl));
      assert.ok(markdown.length > previousMarkdown.length);
      assert.ok(jsonl.length > previousJsonl.length);
      previousMarkdown = markdown;
      previousJsonl = jsonl;
    }
    assert.deepEqual((await fsp.readdir(path.dirname(first.history.summary))).sort(), ["session.clean.jsonl", "summary.md"]);
  } else if (scenario === "history") {
    controls.chat = () => chats.length === 1 ? toolAnswer("write", { path: "artifact.txt", content: "Actual native tool result" }) : textAnswer("Complete final answer\n困难度：low");
    const first = await create("Execute a real file tool then report");
    const terminal = await stopped(first.id);
    assert.equal(terminal.budget.modelCalls, 4);
    assert.equal(await fsp.readFile("artifact.txt", "utf8"), "Actual native tool result");
    const records = await events(first.history.cleanJsonl);
    assert.ok(records.some((r) => r.type === "message_start"));
    const start = records.find((r) => r.type === "tool_execution_start");
    const end = records.find((r) => r.type === "tool_execution_end");
    assert.equal(start.toolName, "write");
    assert.equal(start.args.content, "Actual native tool result");
    assert.equal(end.toolCallId, start.toolCallId);
    assert.equal(end.isError, false);
    assert.ok(end.result.content.length > 0);
    assert.ok(streamedFragments > 0, "the native Session actually received stream fragments");
    assert.ok(records.every((r) => !["message_update", "text_delta", "toolcall_delta"].includes(r.type)));
    const final = records.filter((r) => r.type === "message_end" && r.role === "assistant").at(-1);
    assert.equal(final.stopReason, "stop");
    assert.ok(JSON.stringify(final).includes("Complete final answer"), "clean history must retain finalized message content, not just usage");
    assert.match(await fsp.readFile(first.history.summary, "utf8"), /Complete final answer/);
  } else if (scenario === "steer") {
    const exit = controlledGate();
    controls.chat = async () => {
      if (chats.length === 1) await exit.promise;
      return textAnswer("Steered final answer");
    };
    const first = await create("One original assignment");
    await waitFor(() => chats.length === 1, { label: "first native stream" });
    await writeForDelivery(first.socket, '{"content":"Steering marker exactly once"}\n');
    exit.resolve();
    await waitFor(() => chats.length === 2, { label: "steered native stream" });
    const terminal = await stopped(first.id);
    assert.equal(chats.length, 2);
    assert.equal(classifications.length, 2);
    assert.equal(terminal.budget.modelCalls, 4);
    assert.equal(chats[1].text.split("Steering marker exactly once").length - 1, 1);
    assert.equal(chats[1].text.split("One original assignment").length - 1, 1);
    assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "custom_message").length, 0, "normal completion must be silent");
  } else if (scenario === "parallel") {
    const exit = controlledGate();
    controls.chat = async (request) => {
      const spawned = request.context.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent_create");
      if (request.text.includes("PARALLEL_PARENT") && !spawned) {
        return toolAnswer("subagent_create", { tasks: [1, 2, 3, 4].map((index) => ({ task: `Parallel child assignment ${index}` })) });
      }
      await exit.promise;
      return textAnswer("Parallel actor finished");
    };
    const roots = (await call("subagent_create", { tasks: [1, 2, 3, 4].map((index) => ({ task: `PARALLEL_PARENT ${index}` })) })).details.items;
    const actors = await waitFor(async () => {
      const all = (await call("subagent_list", {})).details.items;
      return all.length === 20 && all.every((actor) => actor.status === "running") && chats.length === 24 && all;
    }, { label: "four parents and sixteen native children running together" });
    assert.equal(actors.filter((actor) => actor.depth === 1).length, 4);
    assert.equal(actors.filter((actor) => actor.depth === 2).length, 16);
    for (const parent of roots) {
      assert.equal(actors.filter((actor) => actor.parentId === parent.id).length, 4);
    }
    for (const actor of actors) assert.ok((await fsp.stat(actor.socket)).isSocket());
    exit.resolve();
    await Promise.all(actors.map((actor) => stopped(actor.id)));
  } else if (scenario === "broadcast") {
    const exit = controlledGate();
    controls.chat = async (request) => {
      const spawned = request.context.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent_create");
      if (request.text.includes("SPAWN_MARKER") && !spawned) {
        return toolAnswer("subagent_create", { tasks: [{ name: "ChildOne", task: "Child assignment one" }, { name: "ChildTwo", task: "Child assignment two" }] }, "create-children");
      }
      if (request.text.includes("SPAWN_MARKER")) {
        const broadcastSent = request.context.messages.some((message) => message.role === "toolResult" && message.toolName === "write");
        if (spawned && !broadcastSent) {
          return toolAnswer("write", { path: path.join(sessionSocketDir, "sub_01", "children.sock"), content: '{"content":"CHILD_BROADCAST_ONLY"}\n' }, "child-broadcast");
        }
      }
      await exit.promise;
      return textAnswer("Local actor finished");
    };
    const roots = (await call("subagent_create", { tasks: [
      { task: "SPAWN_MARKER parent assignment" }, { task: "Sibling assignment two" },
      { task: "Sibling assignment three" }, { task: "Sibling assignment four" },
    ] })).details.items;
    const children = await waitFor(async () => {
      const all = (await call("subagent_list", {})).details.items;
      const found = all.filter((actor) => actor.depth === 2);
      return found.length === 2 && found.every((actor) => actor.status === "running") &&
        chats.filter((request) => request.text.includes("Child assignment")).length === 2 && found;
    }, { label: "depth-2 children run alongside four active parents" });
    assert.deepEqual(children.map((child) => child.id), ["sub_01_01", "sub_01_02"]);
    await assert.rejects(call("write", { path: path.join(sessionSocketDir, "sub_01", "children.sock"), content: '{"content":"OVERSTEP"}\n' }), (err) => err.message.includes("invalid_target"));
    await writeForDelivery(path.join(sessionSocketDir, "main", "children.sock"), '{"content":"ROOT_BROADCAST_ONLY"}\n');
    exit.resolve();
    await Promise.all([...roots, ...children].map((actor) => stopped(actor.id)));
    const childRequests = chats.filter((request) => request.text.includes("Child assignment"));
    assert.ok(childRequests.every((request) => !request.text.includes("ROOT_BROADCAST_ONLY")), "Main must not recursively broadcast to grandchildren");
    for (const name of ["Child assignment one", "Child assignment two"]) {
      assert.match(childRequests.filter((request) => request.text.includes(name)).at(-1).text, /CHILD_BROADCAST_ONLY/);
    }
    const rootRequests = chats.filter((request) => !request.text.includes("Child assignment"));
    assert.ok(rootRequests.every((request) => !request.text.includes("CHILD_BROADCAST_ONLY")), "child broadcasts must not reach ancestors or peers");
    assert.equal(rootRequests.filter((request) => request.text.includes("ROOT_BROADCAST_ONLY")).length, 4);
  } else if (scenario === "inherited") {
    sessionManager.appendMessage({ role: "user", content: "Captured parent context marker", timestamp: Date.now() });
    sessionManager.appendMessage(assistant([
      { type: "thinking", thinking: "Recorded parent thinking", thinkingSignature: "native-signature-test" },
      { type: "text", text: "Recorded parent answer" },
    ]));
    session.setThinkingLevel("high");
    const first = await create("Inherited task marker", { inheritContext: true });
    sessionManager.appendMessage({ role: "user", content: "Later parent mutation must not leak", timestamp: Date.now() });
    await stopped(first.id);
    assert.ok(first.warnings.some((warning) => warning.includes("external_test_tool")), "untransplantable tools must be reported by the public create response");
    assert.equal(getCurrentTools(chats[0].context.messages).some((tool) => tool.name === "external_test_tool"), false);
    assert.equal(classifications.length, 0, "Inherited execution must not classify");
    assert.equal(chats.length, 1);
    assert.equal(chats[0].options.reasoning, "high");
    assert.match(chats[0].text, /Custom inherited system identity/);
    assert.match(chats[0].text, /Captured parent context marker/);
    assert.match(chats[0].text, /Inherited task marker/);
    assert.equal(chats[0].text.includes("Later parent mutation must not leak"), false);
    const thinking = chats[0].context.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((block) => block.type === "thinking");
    assert.equal(thinking.thinking, "Recorded parent thinking");
    assert.equal(thinking.thinkingSignature, "native-signature-test");
    assert.equal((await item(first.id)).budget.modelCalls, 1);
  } else if (scenario === "stopping" || scenario === "stop-history") {
    const exit = controlledGate();
    controls.chat = async (request) => {
      await exit.promise; // Deliberately delay native exit after abort to observe stopping.
      if (request.options.signal.aborted) throw new Error("cancelled local request");
      return textAnswer("after exit");
    };
    const first = await create("Stop an active request");
    await waitFor(() => chats.length === 1, { label: "native request started" });
    const stopping = await call("subagent_stop", { id: first.id });
    assert.equal(stopping.details.status, "stopping");
    assert.equal((await item(first.id)).status, "stopping");
    try {
      if (scenario === "stopping") {
        await assert.rejects(call("write", { path: first.socket, content: '{"content":"must not be accepted"}\n' }), (err) => err.code === "agent_stopping");
      }
    } finally {
      exit.resolve();
    }
    assert.equal((await stopped(first.id)).budget.terminal.status, "cancelled");
    assert.match(await fsp.readFile(first.history.summary, "utf8"), /`cancelled`/);
    controls.chat = null;
    await call("write", { path: first.socket, content: '{"content":"resume after actual exit"}\n' });
    await waitFor(() => chats.length === 2, { label: "explicit revive after cancellation" });
    await stopped(first.id);
    assert.equal(classifications.length, 2);
  } else if (scenario === "failure") {
    controls.chat = () => assistant([], "error", "Local provider failure");
    const first = await create("Fail a native model request");
    const terminal = await stopped(first.id);
    assert.equal(terminal.budget.running, false);
    assert.match(await fsp.readFile(first.history.summary, "utf8"), /`failed`[\s\S]*Local provider failure/);
    const notices = sessionManager.getBranch().filter((entry) => entry.type === "custom_message");
    assert.equal(notices.length, 1);
    assert.equal(chats.length, 1, "an error notification must not start a root model turn");
    assert.equal(session.isStreaming, false);
    assert.equal(notices[0].details.type, "notification");
    assert.equal(notices[0].details.subagentId, first.id);
    assert.equal(notices[0].details.status, "failed");
    assert.deepEqual(notices[0].details.history, first.history);
  } else if (scenario === "reload") {
    const first = await create("Persisted original assignment");
    await stopped(first.id);
    assert.ok((await fsp.stat(first.socket)).isSocket());
    assert.ok(sessionManager.getSessionFile(), "the root must be durable");
    assert.ok(sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "subagent-state"), "the runtime must checkpoint into the actual root branch");
    await session.reload();
    const restored = await item(first.id);
    assert.equal(restored.id, first.id);
    assert.deepEqual(restored.history, first.history);
    assert.ok((await fsp.stat(restored.socket)).isSocket(), "reload must rebuild host-owned listeners for idle actors");
    await call("write", { path: restored.socket, content: '{"content":"Continue after reload"}\n' });
    await waitFor(() => chats.length === 2, { label: "revive from persisted session" });
    await stopped(first.id);
    assert.equal(classifications.length, 2);
    assert.match(chats[1].text, /Persisted original assignment/);
    assert.match(chats[1].text, /Continue after reload/);
  } else {
    throw new Error(`Unknown SDK test scenario: ${scenario}`);
  }
} finally {
  for (const gate of gates) gate.resolve();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  for (const socket of externalConnections) socket.destroy();
  await Promise.all(externalServers.map((server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  assert.deepEqual(extensionErrors, [], "shutdown errors must not be silently swallowed by the test");
  assert.deepEqual(networkAttempts, [], "the entire integration scenario must be offline");
  const sockets = await fsp.readdir(socketDir, { recursive: true }).catch((err) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  assert.equal(sockets.some((file) => file.endsWith(".sock")), false, "shutdown must remove every listener endpoint");
  assert.equal(process._getActiveHandles().filter((handle) => handle instanceof net.Server && handle.listening).length, 0, "shutdown must not leave listening servers");
}
console.log(`SCENARIO_OK:${scenario}`);
