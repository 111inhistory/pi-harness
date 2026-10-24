import assert from "node:assert/strict";
import test from "node:test";

import { Work, createWork, createWorkDispatcher } from "../src/work.mjs";

test("creates a recursive batch atomically and returns it in input order", () => {
  const work = createWork();
  const result = work.add({
    attach: "root",
    items: [
      {
        title: "实现 work MVP",
        desc: ["先确定公开交互，再接入 Pi。"],
        items: [
          { title: "确定公开 API" },
          {
            kind: "branch",
            title: "探索备用展示路线",
            desc: ["当前展示仍有歧义，单独验证另一种形式。"],
            items: [{ title: "验证 Branch 展示" }],
          },
        ],
      },
      { title: "记录验证结果" },
    ],
  });

  assert.deepEqual(result, {
    ok: true,
    attach: "root",
    nodes: [
      {
        id: "w1",
        kind: "item",
        title: "实现 work MVP",
        status: "pending",
        desc: [{ id: 1, content: "先确定公开交互，再接入 Pi。" }],
        items: [
          {
            id: "w2",
            kind: "item",
            title: "确定公开 API",
            status: "pending",
            desc: [],
            items: [],
          },
          {
            id: "w3",
            kind: "branch",
            title: "探索备用展示路线",
            status: "pending",
            desc: [{ id: 1, content: "当前展示仍有歧义，单独验证另一种形式。" }],
            items: [
              {
                id: "w4",
                kind: "item",
                title: "验证 Branch 展示",
                status: "pending",
                desc: [],
                items: [],
              },
            ],
          },
        ],
      },
      {
        id: "w5",
        kind: "item",
        title: "记录验证结果",
        status: "pending",
        desc: [],
        items: [],
      },
    ],
  });
});

test("keeps generated ids stable and appends later batches under the attach node", () => {
  const work = createWork();
  const first = work.add({ attach: "root", items: [{ title: "a" }, { title: "b" }] });
  assert.deepEqual(first.nodes.map((node) => node.id), ["w1", "w2"]);

  const nested = work.add({ attach: "w1", items: [{ title: "a.1", desc: ["follow-up"] }] });
  assert.equal(nested.attach, "w1");
  assert.deepEqual(nested.nodes, [
    {
      id: "w3",
      kind: "item",
      title: "a.1",
      status: "pending",
      desc: [{ id: 1, content: "follow-up" }],
      items: [],
    },
  ]);

  const branch = work.add({
    attach: "root",
    items: [{ kind: "branch", title: "b1", items: [{ title: "b1.1" }] }],
  });
  assert.equal(branch.nodes[0].id, "w4");
  assert.equal(branch.nodes[0].items[0].id, "w5");

  assert.equal(
    work.show({ id: "root", depth: 3 }),
    [
      "TODO",
      "1. [ ] a  #w1",
      "   1.1. [ ] a.1  #w3",
      "2. [ ] b  #w2",
      "   ↳ BRANCH b1  #w4",
      "      1. [ ] b1.1  #w5",
    ].join("\n"),
  );
});

test("rolls back every node when any nested item fails validation", () => {
  const work = createWork();

  assert.throws(
    () =>
      work.add({
        attach: "root",
        items: [
          { title: "valid sibling", desc: ["kept once valid"] },
          { title: "invalid parent", items: [{ title: "  " }] },
        ],
      }),
    /items\[1\]\.items\[0\]\.title must be a non-empty string/,
  );
  assert.equal(work.show({ id: "root" }), "TODO");

  assert.throws(
    () => work.add({ attach: "root", items: [{ title: "a", desc: ["ok", ""] }] }),
    /items\[0\]\.desc\[1\] must be a non-empty string/,
  );
  assert.equal(work.show({ id: "root" }), "TODO");

  assert.throws(
    () => work.add({ attach: "root", items: [{ title: "a", kind: "task" }] }),
    /items\[0\]\.kind must be "item" or "branch"/,
  );
  assert.throws(
    () => work.add({ attach: "root", items: [{ title: "a", items: [null] }] }),
    /items\[0\]\.items\[0\] must be an object/,
  );
  assert.equal(work.show({ id: "root" }), "TODO");

  // No node id or desc id was consumed by the failed batches.
  const created = work.add({ attach: "root", items: [{ title: "fresh", desc: ["first"] }] });
  assert.equal(created.nodes[0].id, "w1");
  assert.deepEqual(created.nodes[0].desc, [{ id: 1, content: "first" }]);
});

test("rejects caller-supplied ids, statuses and unknown fields", () => {
  const work = createWork();

  assert.throws(
    () => work.add({ attach: "root", items: [{ id: "w1", title: "x" }] }),
    /items\[0\]: unsupported field "id"/,
  );
  assert.throws(
    () => work.add({ attach: "root", items: [{ title: "x", status: "done" }] }),
    /items\[0\]: unsupported field "status"/,
  );
  assert.throws(
    () => work.add({ attach: "root", items: [{ title: "x", parent: "root" }] }),
    /items\[0\]: unsupported field "parent"/,
  );
  assert.throws(
    () => work.add({ attach: "root", items: [{ entryId: 1, title: "x" }] }),
    /items\[0\]: unsupported field "entryId"/,
  );
  assert.throws(
    () =>
      work.dispatch({
        tool: "work",
        action: "add",
        attach: "root",
        items: [{ title: "x" }],
        status: "done",
      }),
    /work\.add: unsupported field "status"/,
  );

  assert.equal(work.show(), "TODO");
});

test("rejects unknown attach targets and empty or malformed batches", () => {
  const work = createWork();

  assert.throws(
    () => work.add({ attach: "w9", items: [{ title: "x" }] }),
    /attach does not reference an existing node: w9/,
  );
  assert.throws(() => work.add({ attach: "root", items: [] }), /items must be a non-empty array/);
  assert.throws(() => work.add({ attach: "root", items: "x" }), /items must be a non-empty array/);
  assert.throws(() => work.add({ attach: "root" }), /items must be a non-empty array/);
  assert.throws(() => work.add({ items: [{ title: "x" }] }), /attach must be a node id string/);
  assert.throws(
    () => work.add({ attach: "root", items: [{ title: "x", items: "y" }] }),
    /items\[0\]\.items must be an array/,
  );
  assert.equal(work.show(), "TODO");

  // An explicit empty desc or nested items array means the same as omitting it.
  const created = work.add({
    attach: "root",
    items: [{ title: "leaf", desc: [], items: [] }],
  });
  assert.deepEqual(created.nodes, [
    {
      id: "w1",
      kind: "item",
      title: "leaf",
      status: "pending",
      desc: [],
      items: [],
    },
  ]);
});

test("focus only moves the default view position", () => {
  const work = createWork();
  const created = work.add({
    attach: "root",
    items: [{ title: "a", items: [{ title: "a.1" }] }, { title: "b" }],
  });
  const childId = created.nodes[0].items[0].id;
  assert.equal(childId, "w2");

  assert.equal(work.focusId, "root");
  assert.ok(!work.show().includes("← focus"));

  assert.deepEqual(work.focus({ id: childId }), { ok: true, focus: "w2" });
  assert.equal(work.focusId, "w2");
  assert.equal(work.show(), "TODO\n1. [ ] a.1  #w2  ← focus");

  // Focus neither starts nodes nor rewrites statuses.
  assert.equal(
    work.show({ id: "root", full: true }),
    [
      "TODO",
      "1. [ ] a  #w1",
      "",
      "   1.1. [ ] a.1  #w2  ← focus",
      "",
      "2. [ ] b  #w3",
    ].join("\n"),
  );

  // Adding a subtree keeps the current focus.
  work.add({ attach: "root", items: [{ title: "c" }] });
  assert.equal(work.focusId, "w2");
  assert.equal(work.show(), "TODO\n1. [ ] a.1  #w2  ← focus");

  const root = work.show({ id: "root" });
  assert.match(root, /^1\. \[ \] a  #w1$/m);
  assert.match(root, /^   1\.1\. \[ \] a\.1  #w2  ← focus$/m);
  assert.match(root, /^2\. \[ \] b  #w3$/m);
  assert.match(root, /^3\. \[ \] c  #w4$/m);
  assert.ok(!root.includes("#w4  ← focus"));

  // Focus also accepts a branch or the root, still without touching the tree.
  assert.deepEqual(work.focus({ id: "w3" }), { ok: true, focus: "w3" });
  assert.equal(work.show({ id: "w3", depth: 1 }), "TODO\n1. [ ] b  #w3  ← focus");
  assert.deepEqual(work.focus({ id: "root" }), { ok: true, focus: "root" });
  assert.ok(!work.show({ id: "w1", depth: 1 }).includes("← focus"));
  assert.throws(() => work.focus({ id: "w99" }), /id does not reference an existing node: w99/);
});

test("stores descriptions per node with harness-assigned ids", () => {
  const work = createWork();
  work.add({ attach: "root", items: [{ title: "a" }, { title: "b" }] });

  assert.deepEqual(work.descAdd({ nodeId: "w1", content: "first" }), {
    ok: true,
    nodeId: "w1",
    entry: { id: 1, content: "first" },
  });
  assert.deepEqual(work.descAdd({ nodeId: "w1", content: "second" }), {
    ok: true,
    nodeId: "w1",
    entry: { id: 2, content: "second" },
  });
  assert.deepEqual(work.descAdd({ nodeId: "w2", content: "other node" }), {
    ok: true,
    nodeId: "w2",
    entry: { id: 1, content: "other node" },
  });

  assert.deepEqual(work.descQuery({ nodeId: "w1" }), {
    ok: true,
    nodeId: "w1",
    entries: [
      { id: 1, content: "first" },
      { id: 2, content: "second" },
    ],
  });
  assert.deepEqual(work.descQuery({ nodeId: "w2" }), {
    ok: true,
    nodeId: "w2",
    entries: [{ id: 1, content: "other node" }],
  });

  assert.throws(
    () => work.descAdd({ nodeId: "w9", content: "x" }),
    /nodeId does not reference an existing node: w9/,
  );
  assert.throws(
    () => work.descAdd({ nodeId: "w1", content: "  " }),
    /content must be a non-empty string/,
  );

  // Desc entries never change the node status or the tree.
  assert.equal(work.show({ id: "w1" }), "TODO\n1. [ ] a  #w1");
});

test("filters and deletes descriptions within one node", () => {
  const work = createWork();
  work.add({ attach: "root", items: [{ title: "a" }, { title: "b" }, { title: "c" }] });
  work.descAdd({ nodeId: "w1", content: "验证后发现第二种展示更清晰。" });
  work.descAdd({ nodeId: "w1", content: "Keep Note Alpha" });
  work.descAdd({ nodeId: "w2", content: "展示" });

  assert.deepEqual(work.descQuery({ nodeId: "w1", query: "展示" }), {
    ok: true,
    nodeId: "w1",
    entries: [{ id: 1, content: "验证后发现第二种展示更清晰。" }],
  });
  assert.deepEqual(work.descQuery({ nodeId: "w1", query: "note alpha" }), {
    ok: true,
    nodeId: "w1",
    entries: [{ id: 2, content: "Keep Note Alpha" }],
  });
  assert.deepEqual(work.descQuery({ nodeId: "w1", query: "missing" }), {
    ok: true,
    nodeId: "w1",
    entries: [],
  });
  assert.deepEqual(work.descQuery({ nodeId: "w3" }), {
    ok: true,
    nodeId: "w3",
    entries: [],
  });

  assert.deepEqual(work.descDelete({ nodeId: "w1", entryId: 1 }), {
    ok: true,
    nodeId: "w1",
    deleted: { id: 1, content: "验证后发现第二种展示更清晰。" },
  });
  assert.deepEqual(work.descQuery({ nodeId: "w1" }), {
    ok: true,
    nodeId: "w1",
    entries: [{ id: 2, content: "Keep Note Alpha" }],
  });

  // Deleting on one node never touches another node's entries.
  assert.deepEqual(work.descQuery({ nodeId: "w2" }), {
    ok: true,
    nodeId: "w2",
    entries: [{ id: 1, content: "展示" }],
  });
  assert.throws(
    () => work.descDelete({ nodeId: "w1", entryId: 1 }),
    /unknown desc entry 1 on node w1/,
  );
  assert.throws(
    () => work.descDelete({ nodeId: "w1", entryId: "2" }),
    /entryId must be an integer/,
  );
  assert.throws(
    () => work.descDelete({ nodeId: "w9", entryId: 1 }),
    /nodeId does not reference an existing node: w9/,
  );

  // Deleted ids are never reused.
  assert.deepEqual(work.descAdd({ nodeId: "w1", content: "third" }), {
    ok: true,
    nodeId: "w1",
    entry: { id: 3, content: "third" },
  });
  assert.deepEqual(work.descQuery({ nodeId: "w1", query: "  " }), {
    ok: true,
    nodeId: "w1",
    entries: [
      { id: 2, content: "Keep Note Alpha" },
      { id: 3, content: "third" },
    ],
  });
});

test("renders the compact view up to the requested depth", () => {
  const work = createWork();
  work.add({
    attach: "root",
    items: [
      { title: "L1", items: [{ title: "L2", items: [{ title: "L3" }] }] },
      { title: "S1" },
    ],
  });

  assert.equal(work.show({ id: "root", depth: 0 }), "TODO");
  assert.equal(
    work.show({ id: "root", depth: 1 }),
    ["TODO", "1. [ ] L1  #w1", "2. [ ] S1  #w4"].join("\n"),
  );
  assert.equal(
    work.show({ id: "root", depth: 2 }),
    ["TODO", "1. [ ] L1  #w1", "   1.1. [ ] L2  #w2", "2. [ ] S1  #w4"].join("\n"),
  );
  assert.equal(
    work.show({ id: "root", depth: 3 }),
    [
      "TODO",
      "1. [ ] L1  #w1",
      "   1.1. [ ] L2  #w2",
      "      1.1.1. [ ] L3  #w3",
      "2. [ ] S1  #w4",
    ].join("\n"),
  );

  // The compact view defaults to a depth of 2.
  assert.equal(work.show({ id: "root" }), work.show({ id: "root", depth: 2 }));

  // A node target renders itself plus the requested number of descendant levels.
  assert.equal(
    work.show({ id: "w1", depth: 1 }),
    ["TODO", "1. [ ] L1  #w1", "   1.1. [ ] L2  #w2"].join("\n"),
  );

  assert.throws(
    () => work.show({ id: "root", depth: -1 }),
    /depth must be a non-negative integer/,
  );
  assert.throws(
    () => work.show({ id: "root", depth: 1.5 }),
    /depth must be a non-negative integer/,
  );
  assert.throws(
    () => work.show({ id: "root", depth: 2, full: true }),
    /depth cannot be combined with full/,
  );
  assert.throws(() => work.show({ id: "root", full: "yes" }), /full must be a boolean/);
});

test("renders branches inline without consuming item numbers", () => {
  const work = createWork();
  const created = work.add({
    attach: "root",
    items: [
      { title: "确定部分交互", items: [{ title: "确定纯文本视图" }] },
      { kind: "branch", title: "探索另一条路线", items: [{ title: "保留未决定项" }] },
      { kind: "branch", title: "保留现有路线", items: [{ title: "等待后续判断" }] },
    ],
  });
  assert.deepEqual(
    created.nodes.map((node) => node.kind),
    ["item", "branch", "branch"],
  );
  work.focus({ id: created.nodes[0].items[0].id });

  assert.equal(
    work.show({ id: "root", depth: 3 }),
    [
      "TODO",
      "1. [ ] 确定部分交互  #w1",
      "   1.1. [ ] 确定纯文本视图  #w2  ← focus",
      "   ↳ BRANCH 探索另一条路线  #w3",
      "      1. [ ] 保留未决定项  #w4",
      "   ↳ BRANCH 保留现有路线  #w5",
      "      1. [ ] 等待后续判断  #w6",
    ].join("\n"),
  );

  // A branch target renders itself plus its serial items.
  assert.equal(
    work.show({ id: "w3", depth: 1 }),
    [
      "TODO",
      "↳ BRANCH 探索另一条路线  #w3",
      "   1. [ ] 保留未决定项  #w4",
    ].join("\n"),
  );

  // Items keep counting past branches at their own level.
  const tail = work.add({ attach: "root", items: [{ title: "收尾" }] });
  assert.equal(tail.nodes[0].id, "w7");
  assert.match(work.show({ id: "root", depth: 1 }), /^2\. \[ \] 收尾  #w7$/m);
});

test("renders the full subtree with descriptions", () => {
  const work = createWork();
  work.add({
    attach: "root",
    items: [
      {
        title: "确定部分交互",
        desc: ["先确定公开交互，再接入 Pi。"],
        items: [{ title: "确定纯文本视图" }],
      },
      {
        kind: "branch",
        title: "探索另一条路线",
        desc: ["当前展示仍有歧义，单独验证另一种形式。", "比较两种展示对状态传播的影响。"],
        items: [{ title: "保留未决定项" }],
      },
    ],
  });
  work.focus({ id: "w2" });

  assert.equal(
    work.show({ id: "root", full: true }),
    [
      "TODO",
      "1. [ ] 确定部分交互  #w1",
      "   desc:",
      "     [1] 先确定公开交互，再接入 Pi。",
      "",
      "   1.1. [ ] 确定纯文本视图  #w2  ← focus",
      "",
      "   ↳ BRANCH 探索另一条路线  #w3",
      "      desc:",
      "        [1] 当前展示仍有歧义，单独验证另一种形式。",
      "        [2] 比较两种展示对状态传播的影响。",
      "",
      "      1. [ ] 保留未决定项  #w4",
    ].join("\n"),
  );

  // The full view expands the whole subtree from any node, ignoring depth and
  // only printing a desc block for nodes that have entries.
  const fromItem = work.show({ id: "w1", full: true });
  assert.equal(
    fromItem,
    [
      "TODO",
      "1. [ ] 确定部分交互  #w1",
      "   desc:",
      "     [1] 先确定公开交互，再接入 Pi。",
      "",
      "   1.1. [ ] 确定纯文本视图  #w2  ← focus",
    ].join("\n"),
  );
  assert.equal(fromItem.match(/desc:/g).length, 1);

  assert.equal(
    work.show({ id: "w3", full: true }),
    [
      "TODO",
      "↳ BRANCH 探索另一条路线  #w3",
      "   desc:",
      "     [1] 当前展示仍有歧义，单独验证另一种形式。",
      "     [2] 比较两种展示对状态传播的影响。",
      "",
      "   1. [ ] 保留未决定项  #w4",
    ].join("\n"),
  );
});

test("dispatches work tool requests", () => {
  const { work, dispatch } = createWorkDispatcher();

  const added = dispatch({
    tool: "work",
    action: "add",
    attach: "root",
    items: [
      {
        title: "实现 work MVP",
        desc: ["先确定公开交互，再接入 Pi。"],
        items: [
          { title: "确定公开 API" },
          {
            kind: "branch",
            title: "探索备用展示路线",
            items: [{ title: "验证 Branch 展示" }],
          },
        ],
      },
      { title: "记录验证结果" },
    ],
  });
  assert.deepEqual(added.nodes.map((node) => node.id), ["w1", "w5"]);
  assert.equal(added.attach, "root");

  assert.deepEqual(
    dispatch({ tool: "work", action: "desc.add", nodeId: "w2", content: "验证后发现第二种展示更清晰。" }),
    {
      ok: true,
      nodeId: "w2",
      entry: { id: 1, content: "验证后发现第二种展示更清晰。" },
    },
  );
  assert.deepEqual(
    dispatch({ tool: "work", action: "desc.add", nodeId: "w2", content: "补充：保留原编号方案。" }),
    {
      ok: true,
      nodeId: "w2",
      entry: { id: 2, content: "补充：保留原编号方案。" },
    },
  );
  assert.deepEqual(
    dispatch({ tool: "work", action: "desc.query", nodeId: "w2", query: "展示" }),
    {
      ok: true,
      nodeId: "w2",
      entries: [{ id: 1, content: "验证后发现第二种展示更清晰。" }],
    },
  );
  assert.deepEqual(
    dispatch({ tool: "work", action: "desc.delete", nodeId: "w2", entryId: 2 }),
    {
      ok: true,
      nodeId: "w2",
      deleted: { id: 2, content: "补充：保留原编号方案。" },
    },
  );
  assert.deepEqual(dispatch({ tool: "work", action: "focus", id: "w2" }), {
    ok: true,
    focus: "w2",
  });
  assert.equal(work.focusId, "w2");
  assert.equal(
    dispatch({ tool: "work", action: "show", id: "w2", depth: 1 }),
    "TODO\n1. [ ] 确定公开 API  #w2  ← focus",
  );
});

test("rejects malformed or unknown dispatch requests", () => {
  const { dispatch } = createWorkDispatcher();

  assert.throws(() => dispatch(null), /request must be an object/);
  assert.throws(
    () => dispatch({ tool: "bash", action: "add", attach: "root", items: [{ title: "x" }] }),
    /unsupported tool: bash/,
  );
  assert.throws(
    () => dispatch({ tool: "work", action: "rename", id: "w1" }),
    /unsupported work action: rename/,
  );
  assert.throws(
    () => dispatch({ tool: "work", action: "show", id: "root", limit: 3 }),
    /work\.show: unsupported field "limit"/,
  );
  assert.throws(
    () => dispatch({ tool: "work", action: "focus" }),
    /id does not reference an existing node: undefined/,
  );
});

test("keeps work instances independent", () => {
  const first = new Work();
  const second = createWork();
  first.add({ attach: "root", items: [{ title: "only in first" }] });

  assert.equal(first.show(), "TODO\n1. [ ] only in first  #w1");
  assert.equal(second.show(), "TODO");
  assert.equal(second.focusId, "root");
});
