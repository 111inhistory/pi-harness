import assert from "node:assert/strict";
import { createWorkDispatcher } from "../src/work.mjs";

const { dispatch: run } = createWorkDispatcher();
const created = run({
  tool: "work",
  action: "add",
  attach: "root",
  items: [
    {
      title: "确定部分交互",
      desc: ["先确定公开交互，再接入 Pi。"],
      items: [
        { title: "确定纯文本树视图" },
        {
          kind: "branch",
          title: "探索状态交互",
          desc: ["从当前 TODO 分叉，验证另一种表达方式。"],
          items: [{ title: "保留未决定项" }],
        },
        {
          kind: "branch",
          title: "保留现有路线",
          items: [{ title: "等待后续判断" }],
        },
      ],
    },
  ],
});

const rootItem = created.nodes[0];
const focusItem = rootItem.items[0];
const branch = rootItem.items[1];
const temporary = run({
  tool: "work",
  action: "desc.add",
  nodeId: branch.id,
  content: "这条临时想法应当被删除。",
});
run({
  tool: "work",
  action: "desc.delete",
  nodeId: branch.id,
  entryId: temporary.entry.id,
});
const descriptions = run({
  tool: "work",
  action: "desc.query",
  nodeId: branch.id,
  query: "分叉",
});
run({ tool: "work", action: "focus", id: focusItem.id });

const output = run({ tool: "work", action: "show", id: "root", depth: 4 });
const fullOutput = run({ tool: "work", action: "show", id: "root", full: true });

if (process.argv.includes("--assert")) {
  assert.match(output, /1\. \[ \] 确定部分交互  #w1/);
  assert.match(output, /1\.1\. \[ \] 确定纯文本树视图  #w2  ← focus/);
  assert.match(output, /↳ BRANCH 探索状态交互  #w3/);
  assert.match(output, /1\. \[ \] 保留未决定项  #w4/);
  assert.match(output, /↳ BRANCH 保留现有路线  #w5/);
  assert.match(output, /1\. \[ \] 等待后续判断  #w6/);
  assert.doesNotMatch(output, /从当前 TODO 分叉/);
  assert.match(fullOutput, /\[1\] 先确定公开交互，再接入 Pi。/);
  assert.deepEqual(descriptions.entries, [
    { id: 1, content: "从当前 TODO 分叉，验证另一种表达方式。" },
  ]);
  console.log("work contract smoke checks passed");
} else {
  console.log(output);
  console.log(`\n${JSON.stringify(descriptions, null, 2)}`);
}
