# 已知问题与待定事项

本页记录问题状态。目标要求、当前行为和待定细节见[接口契约](interface-contract.md)。

## Windows 聊天框命令选错 Shell

**状态：作者已报告；本轮未复现，未修复。**

Windows 下，聊天框 `!` 命令使用 Bash，而不是预期的 PowerShell（`pwsh`）。

Pi 有两类命令入口：

- Agent 通过 Bash 或 PowerShell 工具调用命令。
- 用户通过聊天框 `!` 命令调用命令。

作者确认 Shell Preflight 已覆盖上述入口。入口覆盖不等于 Shell 选择正确，根因仍待定位。

后续修复应分别验证工具调用和聊天框命令。语法检查应与实际执行使用同一个 Shell，扩展不应把聊天框命令改到另一个 Shell 执行。

## 工具提示词不明确

**状态：提示词与接口规范已同步改写；多轮实际模型交互效果待全面评估。**

- 纯文本通信已落地：`write`／`msg_write` 接收纯文本内容，由宿主负责 NDJSON 分帧和发送者绑定；提示词明确告知调用方不再拼装 JSON/NDJSON，也不自行编写 Socket 客户端。
- 任务语言硬拒绝已在路由和契约中删除，英文仅作为当前 Jev 路由器的推荐项。
- Capability 提示词已明确按需检索与复用原则；Subagent 提示词已明确终态通知与空闲等待规则。
- 提示词从代码中彻底分离的工作本轮暂不实施。

## Socket 权限与退出清理

**状态：核心机制已在 `src/ipc/endpoint.ts` 落地，生产环境安全修复已接入；跨平台与实机权限待验证。**

- 已落地：按系统用户划分私有目录（`0700`），严格校验目录所有权；启动时安全探测并回收孤儿失效 Socket；基于 inode 校验属主，避免误删他人端点；关闭时主动断开客户端连接并清理自身创建的 Socket。
- 生产环境安全修复已落地：接入显式根目录校验与基于原子硬链接（atomic hardlink no-replace fail-closed）的创建机制，防止路径替换与符号链接攻击。
- Windows 命名管道与 Unix Socket 差异已在代码中隔离，Named Pipes 跳过 Unix 文件系统路径规则。
- 多用户切换与 Windows 实机运行表现仍待后续实地验证。

## 原生压缩后不再使用已发现能力

**状态：外部原生压缩插件暂缓处理；本地分支规范记录与动态权限过滤已落地。**

作者澄清，问题不是 `Tool not found`。使用 OpenAI 原生压缩后，Main 在 Capability 再次返回前不再使用此前发现的能力。

本轮已在已安装版本中复现：原生压缩插件漏收 `additional_tools`，并在回放时因输入比对失败而跳过不透明压缩窗口。结果可能只剩占位摘要与保留尾部。详见[原生压缩兼容性调查](reviews/native-compaction-review.md)。作者决定暂缓处理外部插件，不提上游 issue，压缩方案在外部处理。

本项目已通过持久化分支记录确保能力在压缩后不丢：
- 会话历史通过 `pi.appendEntry` 保存规范的 `capability-discovery` 条目（`src/capability/discovery-record.ts`），嵌套调用亦能持久化。
- 请求投影（`src/capability-prompt.mjs`）在每次调用前自动重建 `<capabilities>` 系统段落，并依据当前工具注册表动态校验权限，不重复存储参数 schema。
- 原生压缩即使抹除对话中的工具输出，只要分支上的自定义规范条目保留，能力投影即可完整恢复。

## 原生发现边界与 MCP 资源

**状态：配套入口已禁用原生发现路径；Codemode 执行与选中 MCP 调用通过离线 SDK 验证。**

- `tool_search` 和全局 MCP 资源列表不可执行；默认 `<mcp_servers>` 不进入模型请求。
- Codemode 仍可启用。沙箱不注册 `searchTools`；枚举与接口查询只看当前启用且允许的工具。
- 旧 Codemode 声明中的目录也在请求边界过滤；不删除磁盘历史或用户正文。
- 通用资源读取要求服务器具有当前启用且允许的入选工具；无效或不支持资源的服务器不会借错误正文暴露目录。
- 当前服务器选择来自工具命名空间。只有资源、没有工具的 MCP 服务器尚无独立发现项；本轮不宣称覆盖此类服务器。
- 验证使用真实 Pi SDK 与 MCP 管线，本地脚本模拟模型和传输。真实模型、真实 MCP 服务与 Windows 实机不在本轮验证范围内。

## 自动通知与消息合并

**状态：核心 typed 模块与适配层已落地；存在已知 Pi 1.4 Root SDK 限制，不宣称所有清空行为已完全修复。**

- 已实现：`src/subagent/lifecycle.ts` 实现正常完成（`completed`）、取消（`cancelled`）与失败（`failed`）的统一终态裁定与通知封装；`src/subagent/delivery.ts` 实现了基于 Pi steer message 的合并投递并在 `message_end` 封口；适配层接通了空闲父 Agent 唤醒续跑（revival）。
- 已连接边界：协调器已接入 native input、`message_start`、`agent_end`（aborted）和 `agent_settled` 边界。
- 子 Agent 队列识别：受管理的子 Agent 会话拥有公开 `agent.hasQueuedMessages()` 探针，能正确识别原生队列清空。
- **已知 SDK 缺口（Root `clearQueue`）**：
  - Pi 1.4 的 Root `ExtensionContext.hasPendingMessages()` 仅统计文本用户队列镜像，不统计自定义 steer 消息（`agent-delivery`）。
  - Root 会话没有向扩展公开 `AgentSession`（或 `session.agent`），也不提供 `queue_cleared` 事件。
  - 当 Root 忙碌且无输入、中断或沉降边界时，调用 `session.clearQueue()` 会移除待处理自定义消息。协调器对此不知情。同轮次后续终态通知合并到已丢失的槽中，导致通知丢失。
  - Main 保持 `upstream-main-clear` 回归测试为失败（RED），作为上游 API 缺口证据。在支持的 Root API 提供前，不静默跳过该测试。
  - 普通 Esc 后的通知（`upstream-main-esc`）、忙碌 Main 和忙碌 Subagent 父节点的合并均已通过离线 SDK 测试。这些结果不覆盖上述无事件的队列清空场景。
- 全仓测试套件由 Main 统一执行，当前不引用最终测试统计数字。

## 用户无法直接查看 Subagent

**状态：作者已指出功能缺失；用户界面待设计。**

Agent 的状态查询工具不能替代用户查看入口。查看内容和用户控制范围留待后续阶段设计，不阻塞核心功能设计。

## 远端 Capability 缺少审批分流

**状态：D4 选择已在代码中落地，远端搜索已停用；审批界面与流程延期。**

- 已落实 D4：Capability 仅搜索本地可用资源（Tool、MCP、Skill），远端搜索处于关闭状态，返回结果与分支记录明确标明远端为 `not_searched`，远端候选不返回 Main，也不写入分支记忆或摘要。
- 审批界面、审批对象和批准后的流程留待后续阶段设计，不阻塞核心重写。审批延期不改变远端候选绝不返回 Main 的要求。

## 内部架构与边界

**状态：核心 typed 模块已实现并建立单元测试；适配层集成与跟进修复正在收尾。**

架构重写已按计划分离落地核心 typed 模块（`src/subagent/execution.ts`、`lifecycle.ts`、`delivery.ts`、`routing.ts`、`src/ipc/endpoint.ts`、`message.ts`、`src/capability/discovery-record.ts`）：
- 统一了执行会话生命周期与清理，消除公开工具注册依赖。
- 确定了停止原因与终态裁定顺序，统一通知格式。
- 实现了基于 Pi steer message 的消息合并投递与空闲唤醒续跑。
- 实现了纯文本 NDJSON 分帧通信与私有 Socket 安全管理。
- 规范了分支自定义条目能力持久化与动态权限校验。

投递、根目录安全和 Capability 记录失败的修复已接入。全仓验证仍保留上述 SDK 队列缺口为失败，不应据此声明重写已完成。
