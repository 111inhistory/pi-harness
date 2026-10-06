import assert from "node:assert/strict";
import test from "node:test";

import { captureInheritedContext } from "../src/inherited-context.mjs";

const HEADER = { type: "session", id: "session-1", cwd: "/work", version: 3 };

const PI = { getActiveTools: () => ["read", "write", "capability"] };

function messageEntry(id, parentId, message) {
  return { type: "message", id, parentId, timestamp: 1_000, message };
}

function createContext(branch, header = HEADER) {
  return {
    cwd: "/work",
    model: { provider: "acme", id: "model-1" },
    thinkingLevel: "low",
    getSystemPrompt: () => "You are the caller's system prompt.",
    sessionManager: {
      getHeader: () => header,
      getBranch: () => branch,
    },
  };
}

test("captures the live fields and the native header plus branch entries", () => {
  const branch = [messageEntry("e1", null, { role: "user", content: [{ type: "text", text: "hi" }] })];
  const before = Date.now();
  const snapshot = captureInheritedContext(PI, createContext(branch));
  assert.ok(snapshot.capturedAt >= before && snapshot.capturedAt <= Date.now());
  assert.equal(snapshot.cwd, "/work");
  assert.equal(snapshot.systemPrompt, "You are the caller's system prompt.");
  assert.deepEqual(snapshot.model, { provider: "acme", id: "model-1" });
  assert.equal(snapshot.thinkingLevel, "low");
  assert.deepEqual(snapshot.tools, ["read", "write", "capability"]);
  const header = snapshot.entries[0];
  assert.equal(header.type, "session");
  assert.equal(header.cwd, HEADER.cwd);
  assert.equal(header.version, HEADER.version);
  assert.notEqual(header, HEADER, "the captured header is a copy");
  assert.notEqual(header.id, HEADER.id, "the child keeps the conversation, never the caller's session id");
  assert.match(header.id, /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
  assert.deepEqual(snapshot.entries.slice(1), branch);
  assert.equal(snapshot.entries.length, branch.length + 1);
});

test("two captures of one session never share a session id", () => {
  const branch = [messageEntry("e1", null, { role: "user", content: [{ type: "text", text: "hi" }] })];
  const ctx = createContext(branch);
  const first = captureInheritedContext(PI, ctx);
  const second = captureInheritedContext(PI, ctx);
  assert.notEqual(first.entries[0].id, HEADER.id);
  assert.notEqual(second.entries[0].id, HEADER.id);
  assert.notEqual(first.entries[0].id, second.entries[0].id);
});

test("keeps native blocks and drops only the in-flight tool call", () => {
  const thinking = { type: "thinking", thinking: "hidden chain of thought", signature: "sig-abc" };
  const completedCall = { type: "toolCall", id: "call-read", name: "read", arguments: { path: "a.txt" } };
  const pendingCall = { type: "toolCall", id: "call-capability", name: "capability", arguments: {} };
  const assistant = messageEntry("e2", "e1", {
    role: "assistant",
    provider: "acme",
    model: "model-1",
    content: [thinking, { type: "text", text: "Checking what exists." }, completedCall, pendingCall],
  });
  const result = messageEntry("e3", "e2", {
    role: "toolResult",
    toolCallId: "call-read",
    toolName: "read",
    content: [{ type: "text", text: "file body" }],
  });
  const branch = [
    messageEntry("e1", null, { role: "user", content: [{ type: "text", text: "use my Firefox" }] }),
    assistant,
    result,
  ];

  const snapshot = captureInheritedContext(PI, createContext(branch));
  const captured = snapshot.entries.find((entry) => entry.id === "e2");
  assert.deepEqual(
    captured.message.content.map((block) => block.type),
    ["thinking", "text", "toolCall"],
  );
  assert.equal(captured.message.content[0].signature, "sig-abc", "provider thinking survives verbatim");
  assert.equal(captured.message.content[2].id, "call-read");
  assert.ok(snapshot.entries.some((entry) => entry.id === "e3"), "the real tool result stays");
  // The caller's live entries are untouched.
  assert.equal(assistant.message.content.length, 4);
  assert.equal(assistant.message.content[3].id, "call-capability");
  assert.notEqual(captured, assistant);
  assert.notEqual(captured.message, assistant.message);
});

test("drops a trailing assistant message that carries nothing but the pending call", () => {
  const branch = [
    messageEntry("e1", null, { role: "user", content: [{ type: "text", text: "hi" }] }),
    messageEntry("e2", "e1", { role: "assistant", provider: "acme", model: "model-1", content: [{ type: "toolCall", id: "call-capability", name: "capability", arguments: {} }] }),
  ];
  const snapshot = captureInheritedContext(PI, createContext(branch));
  assert.equal(snapshot.entries.length, 2, "the empty pending message is gone");
  assert.equal(snapshot.entries[0].type, "session");
  assert.equal(snapshot.entries[1], branch[0]);
});

test("keeps thinking and text of a pending message even when its call never resolves", () => {
  const branch = [
    messageEntry("e1", null, { role: "user", content: [{ type: "text", text: "hi" }] }),
    messageEntry("e2", "e1", {
      role: "assistant",
      provider: "acme",
      model: "model-1",
      content: [{ type: "thinking", thinking: "reasoning", signature: "sig" }, { type: "toolCall", id: "call-capability", name: "capability", arguments: {} }],
    }),
  ];
  const snapshot = captureInheritedContext(PI, createContext(branch));
  const captured = snapshot.entries.find((entry) => entry.id === "e2");
  assert.deepEqual(captured.message.content, [{ type: "thinking", thinking: "reasoning", signature: "sig" }]);
});

test("leaves entries untouched when nothing is in flight", () => {
  const branch = [
    messageEntry("e1", null, { role: "user", content: [{ type: "text", text: "hi" }] }),
    messageEntry("e2", "e1", { role: "assistant", provider: "acme", model: "model-1", content: [{ type: "text", text: "answer" }] }),
  ];
  const snapshot = captureInheritedContext(PI, createContext(branch));
  assert.equal(snapshot.entries[1], branch[0]);
  assert.equal(snapshot.entries[2], branch[1]);
});

test("drops a pending-only message and relinks the followers it carried", () => {
  const pending = messageEntry("e2", "e1", {
    role: "assistant",
    provider: "acme",
    model: "model-1",
    content: [{ type: "toolCall", id: "call-capability", name: "capability", arguments: {} }],
  });
  const label = { type: "label", id: "e3", parentId: "e2", timestamp: 1_000, targetId: "e1", label: "bookmark" };
  const info = { type: "session_info", id: "e4", parentId: "e3", timestamp: 1_000, name: "smoke" };
  const branch = [messageEntry("e1", null, { role: "user", content: [{ type: "text", text: "hi" }] }), pending, label, info];
  const snapshot = captureInheritedContext(PI, createContext(branch));
  assert.deepEqual(
    snapshot.entries.map((entry) => (entry.type === "session" ? "session" : entry.id)),
    ["session", "e1", "e3", "e4"],
    "the dangling call is gone and the branch stays connected",
  );
  const relinked = snapshot.entries.find((entry) => entry.id === "e3");
  assert.equal(relinked.parentId, "e1", "a direct follower becomes a child of the removed message's parent");
  assert.equal(relinked.label, "bookmark");
  assert.equal(info.parentId, "e3", "deeper descendants keep their own parent");
  assert.equal(label.parentId, "e2", "the caller's live entries stay untouched");
  assert.equal(pending.message.content.length, 1, "the caller's pending message is not mutated");
});

test("entries are the branch alone when the session has no header", () => {
  const branch = [messageEntry("e1", null, { role: "user", content: [{ type: "text", text: "hi" }] })];
  const snapshot = captureInheritedContext(PI, createContext(branch, null));
  assert.deepEqual(snapshot.entries, branch);
  assert.notEqual(snapshot.entries, branch, "the captured list is its own array");
});
