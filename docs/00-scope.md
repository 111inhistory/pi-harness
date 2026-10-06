# Pi Harness 交互 MVP 边界

## 目的

当前仓库开发的代码中，仅 `shell-preflight` 已正式挂载至当前 Pi 环境启用；`work`、`capability` 以及带固定派生拓扑和 Job Budget 的 `subagent` 均已在本地实现并跑通完整测试套件，但在运行时环境中暂缓全量挂载。

Subagent 使用原生 Jev 自动路由，支持显式消息、同 ID 续跑复活（revive）、自动通知，以及基于 Pi 会话存储的恢复；不引入复杂回执状态机、收件箱或自动重试。自动路由为 task → 角色 → 模型 → 本地 thinking 合成 → 执行。实际困难度通过最终文本回报，不要求结构化结果。配置在 `config/subagent-routing.json`，完整契约见 `docs/subagent-contract.md`。

各模块的接口状态以对应契约文档为准；已经确认的公开行为必须显式修订后才能改变，尚未确认的设计仍可在人工试用后直接删除或改名。

## 模块边界

| 模块 | 当前职责 | 明确不负责 |
| --- | --- | --- |
| `work` | 保存递归工作树、当前位置和局部状态 | 执行任务、启动 Subagent、决定是否继续 |
| `subagent` | 创建 Fresh／Inherited 子 Session；Jev 自动路由；短统一 ID（Job 与 Agent 耦合）；仅暴露 **`create`**、**`list`**、**`stop`** 三个生命周期原语；通过 write Unix Socket 实现单向消息投递；投递消息后自动通知；双轨历史（Compacted Markdown + Clean JSONL）；支持 stop 后写 socket 自动 revive | 不与 `work` 硬绑定；不做结构化结果；不暴露 `wait` 阻塞接口（直接 `stop` 后读取历史）；不产生碎片化的多重 socket 与多重历史 |
| `capability` | 无参调用：作为阻塞式 **Inherited Subagent** 运行，继承调用方原生会话与同一物理模型（thinking low，并发检索 Tool／MCP／Skill 以及 npm 元数据），直接整合返回 Markdown 结果；返回后仅把选中的已注册可见工具声明为 active | 不执行能力，不安装、启用、下载、连接或批准第三方代码；不维护独立协议系统 |
| `shell-preflight` | 在 Shell 执行前做语法检查（已挂载生效） | 后台进程管理、权限决策 |
| `deepseek-search` | 用户自行安装的现成互联网搜索插件 | 本项目不另写接入或安装逻辑；不负责工作状态与 Agent 调度 |
| tmux Skill | 按约定启动和观察后台进程 | 模型上下文继承、工作树更新 |

模块可以由 Agent 连续调用，但没有隐式联动。例如 Subagent 完成不会自动完成工作项，也不会自动触发主 Agent 继续。

> **已干掉的设计（Removed）**：原先的 `protocol-io` 模块以及所有虚拟协议（`agent://`, `history://`, `tool://`, `mcp://`, `skill://`, `npm://`）已从架构中彻底废除干掉。Pi 原生 `read`/`write` 工具回归 100% 纯粹的文件系统语义；Agent 通信回归操作系统原生 Unix Domain Socket 与文件。

## 本轮设计范围

- `work` 现有实现已就绪并全量通过单测，本轮暂不继续推进推进规则与依赖联动：
  - `work.add`：通过 `attach + items[]` 原子创建递归子树；每层 `items` 按顺序串行，ITEM/BRANCH 均可继续嵌套 `items` 并携带初始 `desc[]`。
  - `work.focus`：改变查看焦点，不改变执行状态。
  - `work.show`：以纯文本查看一棵局部子树。
  - `work.desc.add / delete / query`：所有公开操作都带 `nodeId`，不暴露独立 Description 工具。
- `shell-preflight`（已安装启用）：识别 Pi 实际使用的 Shell，并在 `bash`、`powershell` 和用户 `!` 命令执行前调用对应解析器做语法检查。
- `subagent` 执行与生命周期：
  - **接口极简收敛**：仅暴露 `create`、`list`、`stop` 三个核心操作。
  - **短统一 ID**：Agent 与 Job 概念完全耦合，统一为一个简洁短 ID（如 `sub_01`），消除双重 ID 映射。
  - **直接暴露历史**：创建与查询时直接向发起者暴露两个物理历史文件路径（Compacted Markdown 与 Clean JSONL）。
  - **自动路由与预算**：原子批量注册、Fresh／Inherited 上下文、全局并发队列、两层 4×4 派生限制、按深度 Job Budget（模型调用硬上限与单调时间硬上限）。
- `subagent` 通信与 Revive 治理：
  - **write Unix Socket**：发起者通过向对应 Agent 的 Unix Socket（如 `/tmp/pi-subagents/<id>.sock`）写入 NDJSON 报文进行直接通信。
  - **内置 Notification**：向 Unix Socket 投递消息后自动触发投递给对应 Agent，无需多余的通知总线设计；仅在 Subagent 出现异常（崩溃/超时/熔断）时由宿主向上层抛出异常通知。
  - **Revive 生命周期治理**：`stop` 之后允许发消息自动 revive 续跑。每个 Agent 终身绑定**单一稳定 Socket** 和**单一稳定的双轨历史文件**（追加续写），严格防止 Socket 泄漏过量和历史文件碎片化雪崩。
- `subagent` 双轨历史（Dual History Tracks）：
  - **Compacted Markdown**：参考 OMP 风格的高密度执行与工具调用摘要，专供 LLM 低成本阅读理解。
  - **Clean JSONL**：剥离 token-by-token 流式碎片，保留完整结构化记录，专供 `grep`、`rg` 与 `jq` 高效定位排查。
- `capability`：作为阻塞式 Inherited Subagent 运行，继承父上下文后并发检索 Tool/MCP/Skill，直接返回 Markdown 结果，无需虚拟协议。
- `subagent` 自动路由（已实现并验证）：直接调用 Pi 内置 TypeSafe／OpenRouter 的 Jev，串行选择角色和模型，本地合成 thinking；不抽象未来分类器，也不增加 fallback 或重试。

## 本轮不实现

- `work` 的阻塞／暂停传播、恢复来源和 `cursor` 推进规则。
- Subagent 的 `wait` / 同步阻塞等待：彻底不提供，随时可 `stop` 并拉取历史。
- 结构化结果返回不做：不保留 `outputSchema`／`schemaMode` 目标。消息回执状态机、收件箱、handover 和通用分类器框架也不做。
- 外部扩展工具向 Inherited Subagent 的迁移；Pi 公开 API 不暴露这些工具的执行句柄。
- Git worktree 或文件系统隔离不在当前计划内；子 Agent 共享工作目录。
- 后台任务插件不在本轮；DeepSeek Search 是现成插件，由用户自行安装，不列为待实现的接入任务。
- Capability Marketplace 的下载审查、安装、启用和审批控制面；npm 元数据检索已实现，只返回元数据，不下载安装。

## 已确定约束

1. `work` 和 `subagent` 是独立模块。
2. 通信通过 Unix Domain Socket (NDJSON) 承载，发起者通过 write socket 与子 Agent 交互；彻底废弃 `protocol-io` 及其虚拟协议。
3. Fresh 不继承父会话聊天历史；初始上下文由自动路由选定的角色指令、模型与 thinking，加明确任务和材料组成。
4. `inheritContext: true` 在创建时继承父 Agent 的完整有效上下文（原始 SessionManager 条目）、系统提示词、工具和模型；创建后不再自动同步。
5. 上下文继承不产生文件系统隔离；当前共享工作目录。
6. Subagent 独立执行，所有任务默认 deferred；不提供 `wait` 阻塞接口。
7. Subagent 退出更新终态，向发起者直接暴露 Compacted Markdown 与 Clean JSONL，不改变 `work`。
8. 正常消息通过向 Socket 写入自动投递给对应 Agent；异常（超时/熔断/崩溃）由 Harness 向父层抛出异常通知，不自动唤醒主 Agent 继续。
9. 调用方只提交批次 `context` 与条目的 `name`、`task`、`inheritContext`；不接受路由旋钮或结果 Schema，也不提供兼容覆盖。
10. 自动路由是 Harness 内部的两阶段串行决策；角色与模型相互独立选择，不存在 `(model, role)` 组合预设或组合枚举。
11. Thinking 由角色期望档位限于模型策略区间，使用 low／medium／high，自动路径不超过 high；模型实际支持档位由 Pi 最终处理。困难度反馈存于最终文本和原生历史，不另做解析、校准或自动学习。
12. 自动路由与 Inherited Subagent 的交互（继承子代理是否重选模型或身份）未定案；当前继承语义（父模型、系统提示词、完整有效上下文）继续作为已记录行为保留。
13. Capability 继承调用方原生会话作为阻塞式 Inherited Subagent 运行，并发检索并直接返回 Markdown，调用阻塞直到内部执行结束。
14. 一个 Agent 拥有短统一 ID，对应唯一的 Socket 路径和唯一的一对双轨历史文件。`stop` 后发消息自动 revive 续跑，只在已有历史文件上追加，保持单会话单 Socket 单对文件，禁止资源无限膨胀。

## 暂未决定

- `work` 状态转换、执行位置和传播规则的最终推进方式。
- 是否需要同层中间插入。
- 三角色与模型 Preference 的后续人工调整；当前候选缺失或路由失败显式失败，不自动换模型。
- 真实模型的执行质量、thinking 效果与困难度反馈质量；离线集成验证不替代这些评估。
- 自动路由与 Inherited Subagent 的交互（继承子代理是否重选模型或身份）。
