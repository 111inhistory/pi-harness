# 模型可见的工具说明

## 写法

沿用 Pi 原生 `read`／`edit`／`write` 的格式，不新增全局提示词框架：

- **description**：这个工具做什么、返回什么；会不会等待。
- **参数 description**：字段含义、默认值、必要输入。
- **promptSnippet**：一句话用途，进入 Pi 的工具摘要。
- **promptGuidelines**：少量直接的操作规则，进入 Pi 的规则区。

工具说明使用简短英文；任务和材料保留调用方的原文。不为某个模型另写一套协议，也不假设某个模型会自行读懂仓库的设计文档。自定义系统提示词可能替代 Pi 默认的工具摘要和规则区，工具 description 和参数说明仍是模型理解调用方法的重要入口。

## Subagent 的操作顺序

`subagent_create`／`subagent_list`／`subagent_stop` 属于原生 `subagent` namespace，主会话默认注册但不激活；Fresh 子 Agent 的显式工具装载计划沿用原有行为。Capability 将整组作为一个候选发现并返回，选中后一起激活可直接声明的成员。Depth 2 没有 create，只包含 list／stop。

共同说明保存在 namespace.instructions；激活成员后，原生提示词会去重展示同一份操作规则。`write` 只替换执行 backend，description／schema／snippet／guidelines 保持原生内容，不常驻 Subagent 通信说明。

1. 用 `subagent_create` 提交独立任务；每个任务说明交付物、范围和验证要求。
2. Fresh 不继承聊天历史，必要信息放在 `task` 或共享的 `context` 中。需要父会话快照时才用 `inheritContext: true`。
3. 保存返回的 `id`、`socket` 和 `history` 路径。创建不会等待结果，也不会在正常完成时唤醒父 Agent。
4. 需要进度或结果时调用 `subagent_list`，不要在紧密循环中反复查询。
5. `stopped` 表示这一轮已结束，不表示成功；读取 `history.summary` 看结果，读取 `history.cleanJsonl` 检索完整消息。
6. `subagent_stop` 用于取消不再需要的工作，不是收集结果的前置操作。返回 `stopping`／`finalizing` 时仍未结束。

子 Agent 共享工作目录，避免同时修改同一文件。每个父节点最多 4 个活跃直接子节点，最多两层；没有全局并发上限或任务队列。

## 消息示例

将 `path` 替换为工具返回的实际 Socket 路径：

```json
{
  "path": "<returned socket>",
  "content": "{\"content\":\"Please check the tests and report the result.\"}\n"
}
```

这是 `write` 的参数，不是普通文件内容约定：

- 一行一个 JSON 对象，消息文字放在 `content`。
- 不提供 `from` 或 `to`：宿主绑定发送者，Socket 路径决定接收者。
- 写入成功不代表任务完成或接收者已经处理消息。
- 写入 `stopped` Agent 的 Socket 会启动新一轮；不要向 `stopping`／`finalizing` Agent 投递。
- `children.sock` 只广播给其所属 Agent 的直接子节点；不能使用别人的广播端点。
- 普通文件仍遵循原生 write 语义：新建或完整覆盖，局部修改用 edit。

## 其他工具

- `work`：记录和查看工作树，不执行任务。focus 只改变查看焦点。
- `capability`：无参数，根据当前会话发现值得复用的指导与能力，也用于补齐能力缺口。不要等到基础工具失败才查找成熟方案，也不要求每次工具调用前都检索。

### Capability 的主旨

优先复用已有的方法、规则、偏好、固定背景和说明，以及适合任务的工具／MCP，避免从头摸索或搭建替代方案。Word 编辑、PPT 创建等任务尤其应考虑是否已有成熟资源。

Skill 按宽泛的任务指导理解，而不只是操作教程。相关指导和工具入口应一起选择；主 Agent 读取指导，将其与具体工具接口结合使用，不能只按工具作者的通用描述判断当前场景的用法。

任务级指导与工具发现统一走 Capability；通过 Codemode 使用陌生工具时，先用 describeTool／describeNamespace 查看接口。不另起 searchTools 发现流程。这只是模型使用规则，原生 searchTools 函数仍然存在，不增加运行时禁用或权限控制，也不要求每次调用已知工具前重新检索。

内部检索先搜索本地指导与能力，再为尚未覆盖的需求搜索远端包元数据。返回聚焦的互补 refs，不堆砌所有相关候选。一个 namespace 是一个候选，包含全部可达成员与共同 instructions；hidden 成员不返回。所有原生 namespace 都使用 `namespace://<name>`，包括 MCP namespace；只有没有原生 namespace 的 MCP 工具才按 server 归组，使用 `mcp://<server>`。成员命中会回到整组，最终提交整组 ref。每次搜索的 Tool／MCP 上限均按候选组计数，不截断组内成员。

当前检索源仍是已注册工具、MCP、Skill 与 npm 包元数据。独立存放的 rule／preference／background 并未因此自动接入索引；返回的指导是已有资源的引用，不是新增的偏好提取结果字段。

Capability 在执行前检测 Subagent namespace 的 list／stop 已注册且非 hidden，不要求成员已经 active，也不要求 Depth 2 存在 create。缺少依赖时直接返回失败，不启动内部检索、不消耗模型调用。Capability 只安装只读资源入口，write 由 Subagent 提供；不依赖扩展加载顺序。

选中 namespace 会将可直接声明的成员一起激活；codemode／deferred 成员本来可间接调用，不额外激活。审批候选返回和缓存实现不变：`needs_approval` 候选仍会随选中结果返回，不代表安装或执行授权，尚未实现仅通知用户的分流。

## 维护与验证

实际说明在 `extensions/subagent.mjs`、`extensions/work.mjs`、`extensions/capability.mjs`、`src/capability-broker.mjs` 和 `src/capability-agent.mjs`。

测试检查工具注册后的语义，并使用真实 SDK 验证 Main 和 Fresh 子 Agent 实际看到的提示内容。离线测试不证明任何真实模型的理解或执行质量；这些需要安装后的试用确认。此轮不修改路由候选模型或模型 Preference。
