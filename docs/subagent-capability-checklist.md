# Subagent / Capability 修改 checklist

基线提交：`1583847`。以下项已实施；复用现有机制，不另建通信、权限或验收框架。工具／MCP 白名单是资格集合，不复制父级执行句柄；角色额外黑名单使用完整工具名。模型响应只保留统一 id，输入 name 仍是内部任务标签。

## 1. 基础 I/O

- [x] 将文件写入与 Socket 消息写入拆为两个工具：`write`（可覆盖 Pi 原生同名工具）和 `msg_write`。
- [x] `msg_write` 继续接收 Socket 路径及 NDJSON 内容，由现有 host backend 绑定发送者，不允许普通文件写入。
- [x] 所有 Subagent 保留 `msg_write`，与角色文件修改权限分离。
- [x] 修复已确认的上行失败：只读角色缺 write → Python 原生 Socket 绕过绑定 → 缺失 from 被当成 Main → Main 向自己发消息被拒绝。不要靠猜测发送者或取消 self-send 检查修复。

## 2. Capability 运行时范围

- [x] 子 Agent 的 tool / MCP 可用范围不超出直接父级可用范围（子集，可相等）；Skill 不受父子工具集合约束，仍尊重原生包配置。
- [x] 父级新增可用 tool / MCP 时，向下传播添加到已有后代的运行时白名单；后续创建的孩子使用当时父级集合。
- [x] 角色配置控制黑名单；传播不能覆盖角色限制。沿用角色配置，不另建平行配置。
- [x] 白名单只增不减；这轮不实现权限撤销及其传播。
- [x] 权限一致应用于发现、激活和执行，namespace / MCP 整组不能绕过限制。
- [x] 核实原生工具及 additionalTools 等动态加入的工具：已启用项是否仍出现在 Capability 搜索结果。先复现并找根因，不预设问题就是 additionalTools。

## 3. 层级工具曝光

- [x] depth 1 的 Fresh / Inherited 均实际暴露 Capability 和 Subagent create / list / stop；不只验证注册状态。
- [x] depth 2 不暴露 Capability、Subagent create 或 stop；保留 list 和 `msg_write`。
- [x] 继承方式只影响上下文继承，不决定 depth 1 是否可创建 depth 2。
- [x] list 的初始范围保持要求已被后续授权替换：默认按调用者拓扑筛选，`all: true` 展示全部。

## 4. 工具业务契约

- [x] 精简 create / list，完全移除工具响应中的 Budget；内部裁决、checkpoint 和诊断保留。
- [x] 移除 create / list 重复返回的 parentSocket；父级端点继续放在子 Agent 启动上下文。
- [x] 核对并落实文档中的 id / name 统一约定，避免双重标识；不要未经核对继续保留两套名称。
- [x] stop 返回保持简洁；list 字段整理完成后，按用户补充要求增加可见范围选项。
- [x] create 先校验完整批次：任一任务的非 ASCII 字符占完整 assignment 的 Unicode codepoints 比例 **超过 20%**，整批拒绝并提示用英文。复用 runtime 实际组装的 task / context，不单查 task 字段。
- [x] 模型指导只保留 `Write requirements for subagents primarily in English.`，不说明比例阈值。
- [x] 同步必要的工具描述与契约文档；不新增一套专项验收流程。

## 5. list 后续调整

- [x] 默认包含直接父级、peers（含自己）及自己的 children；每组最多当前并发上限数量，活跃优先、最近停止的补齐。
- [x] Main 包含自身，并展开已展示的活跃 depth 1 节点；停止节点一律不展开，子 Agent 不展开 peer 的 children。
- [x] `all: true` 包含 Main 和全部历史节点，不受默认范围、组数量或停止节点展开规则限制；id 在所选范围内筛选。
- [x] 停止顺序写入内部 checkpoint，复用既有 unit 与真实离线 SDK 场景检查，不新增验收框架。

## 不做

- ACK、握手、重试、收件箱或新的发送者推断机制。
- 白名单撤销机制、Skill 手动扫描。
- 为理论问题增加额外抽象、防御性层或通用框架。

## 开始实现前

- [x] 经 Capability 发现并阅读 `hai-razor` 及关联的 complexity-tells / output-template 指导。

## Razor 收敛

原则：只有删除后会破坏真实目标、权限边界或重要区别的概念才独立保留。本次只审修改计划，不审整个 runtime 生命周期或重新设计 SDK。

| 概念 | 判定 | 证据与理由 |
|---|---|---|
| 独立 `msg_write` | Replace | 已有子会话用 Python 绕过 host 绑定、Main 收到 self-send 错误；将通信入口从文件写权限中分离，复用既有 Socket backend。 |
| 父级可用集合与角色限制 | Keep | 用户明确要求子级不扩权，且父级新增能力可向下添加；这些是现有真实权限差异。 |
| 新的独立权限管理框架 | Merge | 范围检查并入已有 Capability / 激活路径，另建一层没有独立责任。 |
| 权限撤销与反向传播 | Defer | 当前只增不减，没有撤销调用方；本轮不实现。 |
| Budget / 重复 parentSocket 响应字段 | Delete | Budget 是内部裁决；父端点已在启动上下文中。用量便于调度是最强保留理由，但用户明确要求不暴露，不足以保留。 |
| depth 1 / depth 2 工具差异 | Keep | 用户允许一级派生、禁止二级发现和继续控制；必须保留这一层级区别。 |
| 已启用原生工具重复出现在检索中 | Prove first | 已有 active 集合快照及工具返回 delta；现象不能直接证明 additionalTools 根因。先确认是检索候选还是 Main 正文，以及 SDK 注册／活跃集合是否一致。 |
| id / name 双字段 | Prove first | 当前文档的统一表述主要针对 Job / Agent ID；需对齐用户要求，不能据此断言 name 的独立存在合理。 |
| 非 ASCII 批次检查 | Keep | 用户明确要求语言约束及整体拒绝；只用一个比例判断，不增加语言识别器。 |
| 独立专项验收层 | Delete | 已有测试路径可承接具体修复；没有理由另建框架。必要的行为检查不等于独立验收层。 |

保留：发送者 host 绑定、角色限制、原有深度裁决、批次原子注册及内部 Budget。风险护栏：不通过删除这些真实边界换取表面简洁；未证实的 Bug 不预先新增兼容或兜底分支。
