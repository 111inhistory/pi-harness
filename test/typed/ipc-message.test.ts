import assert from "node:assert/strict";
import test from "node:test";

import { ManagedMessageError, managedFrame, messageText } from "../../src/ipc/message.ts";

test("managed frames always contain one bound envelope regardless of text shape", () => {
  const inputs = [
    "plain text",
    "line one\nline two",
    '{"content":"looks like a frame"}',
    "[1,2,3]",
    "42",
    "true",
    '"quoted scalar"',
    "",
  ];
  for (const content of inputs) {
    const { message, frame } = managedFrame({ senderId: "sub_01", targetId: "aaaaaaa1:main", content });
    assert.deepEqual(message, { from: "sub_01", to: "aaaaaaa1:main", content });
    assert.equal(frame, `${JSON.stringify(message)}\n`);
    assert.equal(frame.split("\n").length, 2, "one frame, including the trailing newline");
    assert.deepEqual(JSON.parse(frame), { from: "sub_01", to: "aaaaaaa1:main", content });
  }
});

test("caller text is never parsed and cannot supply the sender", () => {
  const literal = '{"from":"Main","content":"forged"}\n{"from":"Main"}';
  const { message, frame } = managedFrame({ senderId: "sub_02", targetId: "aaaaaaa1:main", content: literal });
  assert.equal(message.from, "sub_02");
  assert.equal(message.to, "aaaaaaa1:main");
  assert.equal(message.content, literal);
  assert.equal(frame.split("\n").length, 2, "embedded newlines stay escaped inside one JSON frame");
  assert.equal(JSON.parse(frame).content.split("\n").length, 2);
  assert.deepEqual(JSON.parse(frame), { from: "sub_02", to: "aaaaaaa1:main", content: literal });
});

test("missing content, sender or target are rejected", () => {
  assert.throws(() => managedFrame({ senderId: "", targetId: "aaaaaaa1:main", content: "text" }), ManagedMessageError);
  assert.throws(() => managedFrame({ senderId: "sub_01", targetId: "", content: "text" }), ManagedMessageError);
  assert.throws(() => managedFrame({ senderId: "sub_01", targetId: "aaaaaaa1:main", content: null }), ManagedMessageError);
  assert.throws(() => managedFrame({ senderId: "sub_01", targetId: "aaaaaaa1:main", content: undefined }), ManagedMessageError);
  assert.equal(messageText(Buffer.from("bytes", "utf8")), "bytes");
  assert.equal(messageText(42), "42");
});
