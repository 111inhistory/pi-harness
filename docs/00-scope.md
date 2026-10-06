# Pi Harness 交互 MVP 边界

## 目的

当前代码中仅 Shell Preflight 已接入 Pi 生效；`work`、Capability Broker，以及带固定派生拓扑和 Job Budget 的 Subagent 均已在本地完成实现与单测，暂缓全量接入。Subagent 使用原生 Jev 自动路由，支持显式消息、同 ID 续跑复活（revive）、类型化完成通知，以及基于 Pi 会话存储的恢复；不引入回执状态机、收件箱或自动重试。

自动路由为 task → 角色 → 模型 → 本地 thinking 合成 → 执行。实际困难度通过最终文本回报，不要求结构化结果。配置在 `config/subagent-routing.json`，完整契约见 `docs/subagent-contract.md`。

各模块的接口状态以对应契约文档为准；已经确认的公开行为必须显式修订后才能改变，尚未确认的设计仍可在人工试用后直接删除或改名。

## 模块边界

| 模块 | 当前职责 | 明确不负责 |
| --- | --- | --- |
| `work` | 保存递归工作树、当前位置和局部状态 | 执行任务、启动 Subagent、决定是否继续 |
| `subagent` | 创建 Fresh／Inherited 子 Session；Jev 自动路由；短统一 ID；仅暴露 `create`、`list`、`stop` 原语；通过 write Unix Socket 实现单向消息投递与分层次直接子级广播（不使用笼统全局 all，严格限定为直接子级）；双轨历史（Compacted Markdown + Clean JSONL）；stop 后写 socket 自动 revive | 不与 `work` 硬绑定；不做结构化结果；blocking 与同步等待暂缓（不提供 wait 接口，直接 stop 后读历史） |
| `protocol-io` | （已废弃干掉）原虚拟协议 URI 分发方案已移除，由 Unix Domain Socket 单向投递与双轨历史文件替代 | 不定义具体能力的语义；执行、安装、启用仍由各模块与审批决定 |
| `capability` | 无参调用：阻塞式内部检索 Agent 继承调用方原生会话与同一物理模型（thinking low，仅 `capability_search`／`submit_result`），并行检索 Tool／MCP／Skill，并仅以 npm 元数据检索远端包；返回后仅把选中的已注册可见工具声明为 active | 不执行能力，不安装、启用、下载、连接或批准第三方代码 |
| `deepseek-search` | 用户自行安装的现成互联网搜索插件 | 本项目不另写接入或安装逻辑；不负责工作状态与 Agent 调度 |
| `shell-preflight` | 在 Shell 执行前做语法检查 | 后台进程管理、权限决策 |
| tmux Skill | 按约定启动和观察后台进程 | 模型上下文继承、工作树更新 |

模块可以由 Agent 连续调用，但没有隐式联动。例如 Subagent 完成不会自动完成工作项，也不会自动触发主 Agent 继续。

## 本轮设计范围

- `work.add`：通过 `attach + items[]` 原子创建递归子树；每层 `items` 按顺序串行，ITEM/BRANCH 均可继续嵌套 `items` 并携带初始 `desc[]`。
- `work.focus`：改变查看焦点，不改变执行状态。
- `work.show`：以纯文本查看一棵局部子树。
- `work.desc.add / delete / query`：所有公开操作都带 `nodeId`，不暴露独立 Description 工具。
- `shell-preflight`：识别 Pi 实际使用的 Shell，并在 `bash`、`powershell` 和用户 `!` 命令执行前调用对应解析器做语法检查。
- `subagent` 执行切片：原子批量注册（`create`）、Fresh／Inherited 上下文、短统一 ID（Agent 与 Job 概念耦合）、全局并发队列、两层 4×4 派生限制、按深度 Job Budget、`list` 查询状态与预算、`stop` 优雅停止并落盘历史。
- `subagent` 消息通信与双轨历史：通过适配了 Unix Socket 的 write backend 实现向子 Agent 的单向消息投递（NDJSON 报文）；支持分层次直接子级广播（不叫笼统的 `all`，严格绑定发送者的直接子级：Main 广播 Depth 1，Depth 1 广播自身的 Depth 2，不递归扩散）；向 Socket 写入自动投递给对应 Agent，仅在异常时由宿主抛出 Notification；`stop` 后向 Socket 写入自动 revive 续跑，每个 Agent 终身绑定单一固定 Socket 和单一固定的双轨历史文件（追加写入）；双轨历史直接暴露给发起者：Compacted Markdown（参考 OMP，供 LLM 消费）与 Clean JSONL（去流式碎片，供 grep/rg/jq 检索）。
- `capability`：无参数调用，阻塞等待内部检索 Agent 的 `capability_search`／`submit_result` 三路并行检索 Tool／MCP／Skill；内部会话继承调用方原生会话条目、系统提示词与同一物理模型（thinking low），远端组仅以 npm 元数据列出未安装包；分支错误隔离，命中只带 `available`／`needs_approval`，返回后仅激活已注册可见的选中工具。
- Pi Extension：`extensions/work.mjs`、`extensions/subagent.mjs`、`extensions/capability.mjs`、`extensions/protocol-io.mjs` 和 `extensions/shell-preflight.mjs` 可同时加载。
- `subagent` 自动路由：直接调用 Pi 内置 TypeSafe／OpenRouter 的 Jev，串行选择角色和模型，本地合成 thinking；不抽象未来分类器，也不增加 fallback 或重试。
- `subagent` 通知、广播与持久化：完成事件复用消息通道但使用独立类型，不自动唤醒；`agent://all` 只发给发送者的直接子 Agent；注册表元数据写入根会话 custom entry，子对话使用 Pi 原生 JSONL。

`work` 契约实现位于 `src/work.mjs`；旧的单节点原型已经完成迁移。

## 本轮不实现

- `work` 的阻塞／暂停传播、恢复来源和 `cursor` 推进规则。
- 虚拟协议层（Protocol IO 及 agent://、history:// 等虚拟 URI scheme）已彻底废弃干掉，不再保留。
- Subagent 的 blocking／`waiting`、同步等待和 parked 资源策略暂缓。不提供 `wait` 接口，直接 `stop` 后读取历史。
- 结构化结果返回不做：不保留 `outputSchema`／`schemaMode` 目标。消息回执状态机、收件箱、handover 和通用分类器框架也不做。
- 外部扩展工具向 Inherited Subagent 的迁移；Pi 公开 API 不暴露这些工具的执行句柄。
- Git worktree 或文件系统隔离不在当前计划内；子 Agent 共享工作目录。
- 后台任务插件不在本轮；DeepSeek Search 是现成插件，由用户自行安装，不列为待实现的接入任务。
- Capability Marketplace 的下载审查、安装、启用和审批控制面；npm 元数据检索（remote 组与 `npm://` 读取）已实现，只返回元数据，不下载安装。

## 已确定约束

1. `work` 和 `subagent` 是独立模块。
2. 消息通过 Unix Domain Socket (NDJSON) 单向投递，发起者通过 write socket 与子 Agent 交互；直接暴露双轨历史文件供普通文件读取与 grep/rg/jq 检索，彻底废弃虚拟协议。
3. Fresh 不继承父会话聊天历史；初始上下文由自动路由选定的角色指令、模型与 thinking，加明确任务和材料组成。
4. `inheritContext: true` 在创建时继承父 Agent 的完整有效上下文（原始 SessionManager 条目）、系统提示词、工具和模型；创建后不再自动同步。
5. 上下文继承不产生文件系统隔离；当前共享工作目录。
6. Subagent 独立执行；blocking 只表示 `task` 是否等待结果，不是另一种执行类型。
7. 当前所有 Job 都是 deferred；blocking 与同步等待暂缓，没有对应参数或 `waiting` 状态。
8. Subagent 退出更新结果并刷盘双轨历史，正常消息投递后自动触发消费，异常时向宿主抛出异常通知，不改变 `work`。
9. 完成与异常通知不自动要求主 Agent 继续。
10. 调用方只提交批次 `context` 与条目的 `name`、`task`、`inheritContext`；不接受路由旋钮或结果 Schema，也不提供兼容覆盖。
11. 自动路由是 Harness 内部的两阶段串行决策；角色与模型相互独立选择，不存在 `(model, role)` 组合预设或组合枚举。
12. Thinking 由角色期望档位限于模型策略区间，使用 low／medium／high，自动路径不超过 high；模型实际支持档位由 Pi 最终处理。困难度反馈存于最终文本和原生历史，不另做解析、校准或自动学习。
13. 自动路由与 Inherited Subagent 的交互（继承子代理是否重选模型或身份）未定案；当前继承语义（父模型、系统提示词、完整有效上下文）继续作为已记录行为保留。
14. Capability 内部检索继承调用方原生会话作为阻塞式 Inherited Subagent 并运行在同一物理模型（thinking 固定 low，不改变调用方设置），并发检索并直接返回结果；调用阻塞直到内部执行结束。
15. 原生 `write` 工具通过更换 write backend 适配 Unix Domain Socket，使得向 `.sock` 写入能直接单向投递 NDJSON；每个 Agent 终身绑定唯一的 Socket 与唯一一对双轨历史文件，stop 后写 socket 自动 revive 续跑并追加历史，严格杜绝 socket 泄漏与多重历史文件碎片化。

## 暂未决定

- blocking 与同步等待暂缓，后续若恢复再处理父调用等待和执行槽位的映射。
- `idle` 会话的 parked／资源回收策略。
- Compact 是否额外生成 Subagent 结果摘要。
- Provider Prompt Cache 的费用策略。
- `work` 状态转换、执行位置和传播规则的最终工具参数。
- 是否需要同层中间插入。
- 三角色与模型 Preference 的后续人工调整；当前候选缺失或路由失败显式失败，不自动换模型。
- 真实模型的执行质量、thinking 效果与困难度反馈质量；离线集成验证不替代这些评估。
- 自动路由与 Inherited Subagent 的交互。
