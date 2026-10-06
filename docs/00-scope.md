# Pi Harness 交互 MVP 边界

## 目的

当前代码已接入 Pi，包含 `work`、Shell Preflight、以及带固定派生拓扑和 Job Budget 的 Subagent。Subagent 使用原生 Jev 自动路由，支持显式消息、同 ID 续跑、类型化完成通知，以及基于 Pi 会话存储的恢复；不引入复杂回执状态机、收件箱或自动重试。

自动路由为 task → 角色 → 模型 → 本地 thinking 合成 → 执行。实际困难度通过最终文本回报，不要求结构化结果。配置在 `config/subagent-routing.json`，完整契约见 `docs/subagent-contract.md`。

各模块的接口状态以对应契约文档为准；已经确认的公开行为必须显式修订后才能改变，尚未确认的设计仍可在人工试用后直接删除或改名。

## 模块边界

| 模块 | 当前职责 | 明确不负责 |
| --- | --- | --- |
| `work` | 保存递归工作树、当前位置和局部状态（TODO 状态机保持独立演进） | 执行任务、启动 Subagent、决定是否继续 |
| `subagent` | 创建 Fresh／Inherited 子 Session；Jev 自动路由；仅暴露 **`create`**、**`list`**、**`stop`** 三个生命周期原语；双轨历史（Compacted Markdown + Clean JSONL）；Unix Domain Socket (NDJSON) 通信与完成通知 | 不与 `work` 硬绑定；不做结构化结果；不暴露 `wait` 阻塞接口（直接 `stop` 后读取历史） |
| `capability` | 以阻塞式 **Inherited Subagent** 运行：继承调用方原生会话与同一物理模型，并行检索 Tool／MCP／Skill 及 npm 远端包元数据，聚合后一次性返回；返回后仅激活已注册可见的选中工具 | 不执行能力，不安装、启用、下载、连接或批准第三方代码；不维护独立协议系统 |
| `shell-preflight` | 在 Shell 执行前做语法检查，Fail-Closed 防御拦截 | 后台进程管理、权限决策 |
| `deepseek-search` | 用户自行安装的现成互联网搜索插件 | 本项目不另写接入或安装逻辑；不负责工作状态与 Agent 调度 |
| tmux Skill | 按约定启动和观察后台进程 | 模型上下文继承、工作树更新 |

模块可以由 Agent 连续调用，但没有隐式联动。例如 Subagent 完成不会自动完成工作项，也不会自动触发主 Agent 继续。

> **架构注记（Protocol IO 废除）**：原先通过虚拟协议（`agent://`, `history://`, `tool://`）劫持 Pi 原生 `read`/`write` 工具的 Protocol IO 方案已废止收敛。Pi 原生文件读写工具回归纯粹的文件系统语义；Agent 之间的实时通信走 Unix Domain Socket (NDJSON)，状态流转走原生 Notification，历史检索走真实落盘文件（Markdown / JSONL）。

## 本轮设计范围

- `work`：通过 `add` 原子创建递归子树，`focus` 切换视角，`show` 渲染纯文本局部树，`desc.add / delete / query` 管理节点描述。当前设计暂列为 TODO，先保持现状。
- `shell-preflight`：识别 Pi 实际使用的 Shell，并在 `bash`、`powershell` 和用户 `!` 命令执行前调用对应解析器做语法检查。
- `subagent` 生命周期与接口：
  - **`create`**：原子批量注册，支持 Fresh（Jev 自动路由）与 Inherited（父上下文继承）双形态。
  - **`list`**：列出花名册、层次深度、运行/空闲状态与只读预算。
  - **`stop`**：显式取消指定 Job，优雅停止。
- `subagent` 通信与通知：
  - **Unix Domain Socket**：每个运行中 Subagent 暴露一个 UDS（如 `/tmp/pi-subagents/<agentId>.sock`），报文为换行分隔的 JSON（NDJSON），用于流式通信与实时控制。
  - **Notification**：轻量级类型化事件推送（如生命周期状态跃变、任务完成通知），不自动唤醒父 Agent。
- `subagent` 双轨历史（Dual History Tracks）：
  - **Compacted Markdown**：参考 OMP 风格，浓缩任务目标、工具调用摘要、关键结果与最终输出，专为 LLM 上下文阅读设计。
  - **Clean JSONL**：落盘文件，剥离 token-by-token 流式碎片，保留完整的 `message_start`、`tool_call`、`tool_result` 与 `message_end` 结构，专为 `grep` / `rg` / `jq` 高效检索与排查设计。
- `capability`：作为阻塞式 Inherited Subagent 运行，继承父上下文后并发检索 Tool/MCP/Skill，返回整合好的 Markdown 结果。
- 拓扑与预算：两层 4×4 派生限制、按深度 Job Budget（模型调用硬上限与单调时间硬上限）。

## 本轮不实现

- `work` 的阻塞／暂停传播、恢复来源和 `cursor` 推进规则（列入后续 TODO 规划）。
- Subagent 的 `wait` / 同步阻塞等待：无需显式挂起父会话，随时可 `stop` 并读取历史。
- 虚拟协议层（Protocol IO）：不再提供 `agent://`、`history://`、`tool://` 等虚拟 URL Scheme。
- 结构化结果返回不做：不保留 `outputSchema`／`schemaMode` 目标。消息回执状态机、收件箱、handover 和通用分类器框架也不做。
- 外部扩展工具向 Inherited Subagent 的迁移；Pi 公开 API 不暴露这些工具的执行句柄。
- Git worktree 或文件系统隔离不在当前计划内；子 Agent 共享工作目录。
- 后台任务插件不在本轮；DeepSeek Search 是现成插件，由用户自行安装，不列为待实现的接入任务。
- Capability Marketplace 的下载审查、安装、启用和审批控制面。

## 已确定约束

1. `work` 和 `subagent` 是独立模块。
2. 通信通过 Unix Domain Socket (NDJSON) 和原生 Notification 承载，彻底废除 `agent://` 虚拟写入。
3. Fresh 不继承父会话聊天历史；初始上下文由自动路由选定的角色指令、模型与 thinking，加明确任务和材料组成。
4. `inheritContext: true` 在创建时继承父 Agent 的完整有效上下文（原始 SessionManager 条目）、系统提示词、工具和模型；创建后不再自动同步。
5. 上下文继承不产生文件系统隔离；当前共享工作目录。
6. 所有子任务执行依然为异步 deferred；父 Agent 无需 `wait`，可直接通过 `stop` 并拉取历史完成闭环。
7. Subagent 退出更新终态，向创建者投递类型化完成通知，生成 Compacted Markdown 与 Clean JSONL，不改变 `work`。
