# 已关闭问题与已完成记录

本页归档已修复问题、已完成迁移和已落实的设计边界。尚未实现或验收的工作见[已知问题与验收边界](../known-issues.md)。本页的局部验证记录不代表完整平台或所有模型路径已通过验收。

## Parent PBT cancellation oracle

The generated parent-coordination model incorrectly required every child terminal notice to reach durable parent history, including a notice queued as native steer while the parent provider was held and then cancelled. The existing [notification contract](../interface-contract.md#自动完成通知) follows Pi steer interruption semantics and does not add notification-specific recovery.

The original local stress failure used seed `1002`, 100 runs, command limit 128 and fast-check's default generation size. It failed after 19 histories and shrank eight times to `hold(1), finish-pair, cancel(1)` with one child per parent. Property path: `18:6:5:6:6:6:6:8:8`; command replay path: `AAAAY:V`. A diagnostic confirmed the child notice was in the parent's SDK steer queue before cancellation. This is an oracle error, not a production delivery defect.

The model now distinguishes notices still pending behind a held provider from notices drained by the parent. Cancelling that parent permits only its pending notices to be absent, retaining at-most-once and direct-recipient assertions. Previously drained notices remain required exactly once; notices delivered after cancellation still use the existing retained-history path. Interrupted notices no longer require proof of model consumption. The exact original replay passes after this test-only correction; production behavior and generated operations are unchanged.

## Windows 聊天框命令选错 Shell

已修复。Windows 的聊天框 `!`／`!!` 命令用 PowerShell AST 检查，通过后交给 SDK 原生 PowerShell operations 执行，不再回退到 Bash。Agent 工具调用仍按 `bash`／`powershell` 分别检查。

Windows 11 虚拟机已验证中文命令、检查阶段不执行命令，以及非法语法阻断。实际装配、Named Pipe 成功与错误响应也已验证。完整 Windows 套件仍有平台断言和未完成场景，不能将本项修复等同于全仓 Windows 回归通过。

## 存储 v2 迁移与历史在线样本

存储 v2 不恢复 v1 检查点。批量转换、两份新对话、原件与约 4.2 GB 备份见[迁移记录](../reviews/subagent-migration-batch.md)。原件刻意保留，迁移工具按用户决定暂不清理；清理不列为待办。

迁移阶段的单样本真实 Gemini 续跑和随后 `GEMINI_SMOKE_OK` 冒烟均成功。这些是当时的在线记录，不能用来证明后续 TS 调用链已完成多轮在线验收。未因独立 SDK 临时代理问题修改 OAuth 插件、凭据或常驻配置。

## 移除外部压缩插件

用户已移除 `pi-better-compaction`，用户包配置中也已移除该插件，以避免破坏 Responses 的 `additional_tools`。历史问题见[压缩调查](../reviews/native-compaction-review.md)。Inherited 的 Responses 工具继承适配仍未完成，后续适配不以恢复该插件为前提。

## 原生压缩期间的消息投递

已修复。根会话执行原生压缩时，子 Agent 消息、跨 session 消息与终态通知原先会立即以 `deliverAs: "steer"` 交给 SDK，可能落在压缩重写的上下文边界内，或与重试轮次交错。

`RootService` 现在维护一个压缩门：`session_before_compact` 打开，`session_compact` 与 `session_compact_failed` 关闭；`sendToMain` 在投递前等待该门。退役时释放该门：旧根仍保有写入归属（quiescing）时终态通知可以保留，但不唤醒旧根；失去写入归属后投递被拒绝。等待本身不会挂起，也不自动重放。回归见 [delivery-compaction.test.ts](../../test/typed/delivery-compaction.test.ts) 与 [root-service-boundary.test.ts](../../test/typed/root-service-boundary.test.ts)。

## 本机 Socket 信任与资源保护

本项目信任同用户本机进程，不把同用户恶意程序作为隔离对象，不新增 Socket 认证协议。这是既定信任范围，不是待实现的认证功能。

报文缺少或误填 `from` 时拒收，不默认冒充 Main。宿主工具绑定实际调用方，也拒绝非受管 Socket／Named Pipe，不能借文件写入连接任意服务。

Socket 请求等待接收处理结果，成功正常返回，失败返回错误。超时或断连可能发生在消息接收之后，不自动重发，也不把正常返回当作模型已读。

`src/ipc/endpoint.ts` 已使用按系统用户隔离的私有目录、属主与 inode 校验、原子硬链接发布、活跃端点保护和自有资源清理。不能通过放宽权限共享端点。监听覆盖当前注册表，不再随列表显示窗口关闭旧 Actor；累计 Actor 增多时，监听占用也会增长。

## 正常导航退役与终态写入

正常切换在 SDK BEFORE 钩子内停止 Job 并保存终态；根上下文移动后禁止旧回调通过 `pi.appendEntry` 写入新分支。写盘失败会锁存并阻止切换被报告为成功。退役超时不释放仍被使用的原生文件，资源保持隔离。

真实 SDK 回归已覆盖正常退役写入一次终态，以及终态落盘失败时取消切换。强制终止、插件组合和长期竞态仍属于验收边界。

## 原生消息与提示词接线

普通消息和终态不维护合并槽。清除已有原生进度消息不吞没后来产生的终态；用户主动清除终态后不重发。

提示词正文已外置到 `prompts/`。权限、参数类型和状态裁定不由正文执行。共同指引、create 专属指引、子会话身份和 Inherited 定位已按[装配契约](../interface-contract.md#subagent-提示词装配)接线。任务语言没有硬拒绝，英文仍是路由器的使用推荐。

## 严格 TypeScript 接线与生产代码迁移

Subagent 应用入口、Runtime、SDK 执行器、会话工厂、身份保留、消息工具和 IPC 运行逻辑已进入严格 TS。剩余生产代码（`src/subagent/storage.ts`、`src/subagent/view.ts`、`src/subagent/routing.ts`、`src/subagent/job-budget.ts`、`src/subagent/pi-job-budget.ts`、`src/inherited-context.ts`、`src/prompt-text.ts`、`src/capability/skills.ts`、`src/shell-preflight.ts` 以及 `extensions/shell-preflight.ts`）已全量迁移至 TypeScript。`scripts/` 与历史测试用例（`test/*.test.mjs`）仍保持 MJS。

## Inherited 工具注册与 Responses additional_tools 基础链条

已通过离线 SDK 回归验证（`test/typed/native-session-factory.test.ts`）。Inherited 会话在捕获时通过父会话 spawning assistant 消息锁定物理模型（`physicalModelForCall`），避免虚拟模型在子会话中重路由；Fresh 与 Inherited 均独立加载已配置扩展与 MCP 后端，异步 MCP 注册提供最多 10 秒有界等待。在 OpenAI Responses 模式下，继承工具通过 `additional_tools` 正确声明并成功执行子进程 MCP 后端调用。

本项仅为真实 SDK 与离线子进程场景的局部验证，不能等同于真实提供方多轮在线运行或原生压缩生命周期验收。

## 本轮结果直接交付

终态通知已直接携带当前 Job 的最终回复文本，不再要求父会话先读取摘要。结果正文按 SDK `read` 的 2000 行／50 KiB 上限截断；超限时附本轮原始结果文件路径。持久化视图新增 `result.txt`，内存会话仅为超限结果生成临时文件。

回归覆盖多轮隔离、Inherited 背景隔离、正文只呈现一次、空的最终回复、原始文件重建和写入失败。真实 SDK 场景使用本地模拟模型，不把这些结果表述为真实提供方在线验收。接口见[本轮结果直接交付](../interface-contract.md#本轮结果直接交付)。
