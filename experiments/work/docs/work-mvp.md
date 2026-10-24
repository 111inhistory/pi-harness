# Work 原型 API（暂缓）

> 本文保留原型的交互设计，不作为当前主线契约。Work 能力仍有需求，是否以 Pi 插件交付尚未决定。

## 状态

本文记录本目录原型已经实现的交互。代码位于 `experiments/work/src/work.mjs` 和 `experiments/work/extensions/work.mjs`；内部存储不属于原型 API。

## 工作结构

- `work` 更接近递归 TODO，不是通用树编辑器。
- 同一层级的普通工作项按数组顺序串行。
- 普通工作项可以拥有下一层子 TODO。
- 只有显式 `branch` 表示从当前位置分叉。
- 每条 Branch 内部仍是一组串行 TODO。
- `SEQ` 是层级内的顺序关系，不作为可见节点。
- 节点使用稳定 ID，例如 `w1`。

## `work.add`

`work.add` 既用于根级批量创建，也用于 attach 到已有节点。

```json
{
  "tool": "work",
  "action": "add",
  "attach": "root",
  "items": [
    {
      "title": "实现 work MVP",
      "desc": [
        "先确定公开交互，再接入 Pi。"
      ],
      "items": [
        {
          "title": "确定公开 API"
        },
        {
          "kind": "branch",
          "title": "探索备用展示路线",
          "desc": [
            "当前展示仍有歧义，单独验证另一种形式。"
          ],
          "items": [
            {
              "title": "验证 Branch 展示"
            }
          ]
        }
      ]
    },
    {
      "title": "记录验证结果"
    }
  ]
}
```

### 字段

```ts
type AddItem = {
  kind?: "item" | "branch"; // 缺省为 item
  title: string;
  desc?: string[];
  items?: AddItem[];
};

type WorkAdd = {
  action: "add";
  attach: "root" | string;
  items: AddItem[];
};
```

### 语义

- `attach` 只指定整批子树挂到哪个已有节点下。
- 每一个 `items` 数组都表示一个串行层级，数组顺序就是执行顺序。
- ITEM 和 BRANCH 都可以继续包含递归 `items`。
- `branch` 明确表示分叉；Branch 自己的 `items` 是该路线内的串行 TODO。
- `desc` 是初始记账条目；每个字符串创建一条记录。
- `desc` 可省略；空数组等价于省略。
- 调用方不能提供节点 ID 或 Desc ID。
- 新节点缺省为 `pending`。
- 添加整棵子树不改变 `focus`，也不自动开始执行。
- 整个递归调用原子提交：任意层级的 item 或 desc 校验失败时，不创建任何节点。
- 即使只创建一个节点，也使用单元素 `items`，不另设单节点输入形状。

### 返回

```json
{
  "ok": true,
  "attach": "root",
  "nodes": [
    {
      "id": "w1",
      "kind": "item",
      "title": "实现 work MVP",
      "status": "pending",
      "desc": [
        {
          "id": 1,
          "content": "先确定公开交互，再接入 Pi。"
        }
      ],
      "items": [
        {
          "id": "w2",
          "kind": "item",
          "title": "确定公开 API",
          "status": "pending",
          "desc": [],
          "items": []
        },
        {
          "id": "w3",
          "kind": "branch",
          "title": "探索备用展示路线",
          "status": "pending",
          "desc": [
            {
              "id": 1,
              "content": "当前展示仍有歧义，单独验证另一种形式。"
            }
          ],
          "items": [
            {
              "id": "w4",
              "kind": "item",
              "title": "验证 Branch 展示",
              "status": "pending",
              "desc": [],
              "items": []
            }
          ]
        }
      ]
    },
    {
      "id": "w5",
      "kind": "item",
      "title": "记录验证结果",
      "status": "pending",
      "desc": [],
      "items": []
    }
  ]
}
```

Desc ID 由 Harness 自增分配。调用方使用 `(nodeId, entryId)` 定位条目，不依赖内部采用节点内编号还是其他存储方式。

## `work.desc.*`

Description 对外始终从节点作用域访问，不提供独立 Description 工具或全局查询。

### 新增

```json
{
  "tool": "work",
  "action": "desc.add",
  "nodeId": "w2",
  "content": "验证后发现第二种展示更清晰。"
}
```

### 删除

```json
{
  "tool": "work",
  "action": "desc.delete",
  "nodeId": "w2",
  "entryId": 2
}
```

### 查询

```json
{
  "tool": "work",
  "action": "desc.query",
  "nodeId": "w2"
}
```

关键词过滤：

```json
{
  "tool": "work",
  "action": "desc.query",
  "nodeId": "w2",
  "query": "展示"
}
```

规则：

- Desc 条目只有 `id` 和 `content`。
- 不设置 category、tag 或 event 字段。
- 不提供 update；纠错时删除旧条目并新增。
- `work.desc.query` 只用于读取指定节点的 Desc，或通过 `query` 做关键词过滤；它不是模型取得完整工作上下文的必经路径。
- `work.show` 默认不展开 Desc；需要一次取得完整上下文时使用 `full: true`。
- 删除 Desc 不改变节点状态。
- Desc 不作为状态计算、传播来源或恢复目标的数据源。
- 将来状态转换可以原子附带一条 Desc：转换成功则新增，失败则不新增。

## `work.focus`

```json
{
  "tool": "work",
  "action": "focus",
  "id": "w2"
}
```

`focus` 只改变默认查看位置：

- 不启动节点；
- 不移动执行位置；
- 不暂停其他路线；
- 不触发 Agent 继续执行。

## `work.show`

```json
{
  "tool": "work",
  "action": "show",
  "id": "root",
  "depth": 3
}
```

返回 TODO 式纯文本：

```text
TODO
1. [ ] 确定部分交互  #w1
   1.1. [ ] 确定纯文本视图  #w2  ← focus
   ↳ BRANCH 探索另一条路线  #w3
      1. [ ] 保留未决定项  #w4
   ↳ BRANCH 保留现有路线  #w5
      1. [ ] 等待后续判断  #w6
```

- `[ ]`、`[>]`、`[x]`、`[!]`、`[-]` 分别表示 pending、active、done、blocked、paused。
- 编号和缩进表达串行层级。
- `BRANCH` 只用于明确分叉。
- ID 放在行尾，供后续工具调用引用。
- Desc 默认不出现在树中。

完整视图：

```json
{
  "tool": "work",
  "action": "show",
  "id": "root",
  "full": true
}
```

`full: true` 一次返回指定节点的整棵子树：

```text
TODO
1. [ ] 确定部分交互  #w1
   desc:
     [1] 先确定公开交互，再接入 Pi。

   1.1. [ ] 确定纯文本视图  #w2  ← focus

   ↳ BRANCH 探索另一条路线  #w3
      desc:
        [1] 当前展示仍有歧义，单独验证另一种形式。
        [2] 比较两种展示对状态传播的影响。

      1. [ ] 保留未决定项  #w4
```

完整视图规则：

- 返回指定节点及其全部后代，不需要逐节点调用 `work.desc.query`。
- 展开每个节点的全部 Desc，以及该节点已经定义的全部公开状态信息。
- 继续使用 TODO 式纯文本；不另设 `work.getAll` 或 `work.export`。
- `depth` 用于默认紧凑视图；`full: true` 表示完整子树，二者不同时传入。

## 内部实现

尚未决定，也不属于公开 API：

- Desc 存在节点对象内还是独立索引中；
- Desc ID 的内部计数器放在哪里；
- 持久化文件布局；
- 查询是否建立索引。

MVP 实现时选择满足当前行为的最简单方案；这些选择不能改变 `work.add` 和 `work.desc.*` 的公开调用。

## 尚未确认

- `start / complete / block / pause / resume / reopen` 的最终参数形式；
- 执行位置如何显示和移动；
- 状态传播是写入还是查询时计算；
- 多来源暂停和阻塞的返回格式；
- 容器完成条件；
- 是否需要插入到同层中间位置。

## 实现状态

- `experiments/work/src/work.mjs` 实现内存工作树和公开 dispatch；
- `experiments/work/extensions/work.mjs` 保留 Pi 工具接入实验，不由主线装配；
- `experiments/work/prototype/cli.mjs` 提供 JSONL 交互；
- `experiments/work/test/work.test.mjs` 验证递归原子创建、Desc、focus 和两种树视图。

尚未确认的状态转换没有进入实现。
