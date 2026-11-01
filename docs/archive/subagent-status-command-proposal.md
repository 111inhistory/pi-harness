# Subagent 状态命令提案

本文是设计提案，不是当前契约。当前行为见[接口契约](../interface-contract.md)，模块边界见[当前架构](../architecture.md)。提案已落地，保留原文供追溯；落地时移除了交互式 `show` 与停止来源两项，见[接口契约](../interface-contract.md)。

## 结论

- 应新增扩展命令 `/subagent`，让用户在当前 Pi 会话中查看当前根服务的 Subagent 树与 Job 状态，并停止运行中的任务。
- 范围：默认列表、`list`、`stop <actorId>`、`stop --all`。`show` 做成交互式，列为下一阶段的重点。
- **命令不能给 Subagent 发消息**：不提供发送、steer 或唤醒入口。消息能力仍只由模型工具 `msg_write` 与外部 IPC 提供。
- 命令应复用 `RootService` 与 `Runtime` 的现有事实来源和准入，不新增状态机；展示字段不足处按需补薄查询接口，不假定现有视图已包含全部字段。

## 现状与依据

| 事实 | 依据 |
| --- | --- |
| 扩展可以注册命令 | `pi.registerCommand(name, { description, handler, getArgumentCompletions })`，见 SDK `dist/core/extensions/types.d.ts:1171`、`:1231` |
| 命令处理器上下文 | `ExtensionCommandContext` 提供 `ui`、`waitForIdle`、`newSession`、`fork`、`navigateTree`，见 `types.d.ts:286` |
| 当前根服务获取 | `src/subagent/extension.ts:43` 的 `current(ctx)`；退役或切换期间抛 `runtime_transitioning` |
| 展示入口 | `RootService.list(filter, callerId)`（`root-service.ts:307`）→ `runtime.listDetailed`，并补充历史路径与 `historyDir` |
| 运行中 Job | `RootService.runtime.jobs()` 返回当前 `JobView`（含 `status`、`stopping`、`error`、`budget`） |
| 已结束 Job | `runtime.jobRecord(jobId)` 只接受 `finalizing` 或终态 Job；运行中的 Job 返回 `null` |
| 停止入口 | `RootService.stop(actorId)` → `runtime.stop` → `cancelJob(jobId)`；`cancelJob` 返回 `{ok, reason, job}`，但 `runtime.stop` 目前只返回 `{ok, id, status}`，丢掉了 `reason` |
| 未公开字段 | Fresh／Inherited 种类只在 Runtime 内部推导，需在列表投影补一个 `kind` 字段；Budget 仅有 `JobView.budget` 快照，没有 soft／hard 明细 |
| 展示同源 | `surface.ts` 的 `subagent_list` 与根服务投影共用每组 4 项窗口与折叠规则 |

命令处理器与 Root 服务同进程、同代次，不需要模型轮次，也不消耗 Job Budget。

## 建议的命令形态

```text
/subagent                  默认展示当前根的列表（等价于 list）
/subagent list [--all] [--id ID]
/subagent stop <actorId>
/subagent stop --all
```

- `list` 复用 `RootService.list` 的每组 4 项窗口与折叠；`--all` 映射 `all: true`。
- `list` 展示 `kind`（Fresh／Inherited）。Runtime 已按首个 Job spec 推导该值，只需在列表投影补一个只读字段。
- `stop` 只接受 Actor ID（`runtime.stop`）；按 Job ID 停止需要 `cancelJob`，第一版不提供。
- `stop --all` 只对 `running` 的 Job 调用 `cancelJob`，请求后立即汇总，不等待终态。
- 消息与续跑不在命令范围内：命令不调用 `sendMessage`，不给 Subagent 发消息、steer 或唤醒；`msg_write` 已经统一运行中 steer 与空闲复活，命令再加一个入口只会变成第二套变更路径。

### 展示风格

- 输出走 `ctx.ui.notify(text, 'info')` 的多行纯文本，参考 pi-antigravity 的 `/antigravity.usage`：标题行、按内容计算的列宽（`padEnd`／`padStart`）、每行一个 Actor、末尾一行汇总。
- 层级用缩进表达（每层两个空格）；`●` 表示活跃、`◐` 表示正在停止／收尾、`○` 表示空闲；精确状态仍看 `STATUS` 列。
- 列固定为：ID、深度、种类、角色、状态、调用数。不写 `key=value`，不把模型名、父节点或终止原因塞进列表行；这些留给 `show`。
- 汇总统计当前根的**全部** Actor，不按窗口裁剪；窗口隐藏节点时用一行提示说明。
- 不自建 TUI 组件，不依赖 ANSI 主题色；列宽与对齐在命令内计算。
- `list` 的目标形状：

```text
Subagents · 01a1958d · 3 actors · 2 active (1 fresh / 1 inherited)
  ● sub_01        d1  fresh      executor    running   12 calls
    ● sub_01_01   d2  inherited  researcher  running    3 calls
  ○ sub_02        d1  fresh      executor    idle          –
window shows 3 of 4 · history /…/views
```

## 不变量

1. 参数解析先于 `current(ctx)`：解析失败不触达 `RootService`。
2. 命令只经 `RootService` 与 `Runtime` 改变状态，不直接改写 `job.status`，不直接追加根分支事件；停止产生的状态变化与终态事件仍由现有 Runtime／RootService 路径记录。
3. 停止请求不等于终态。`stopping`、`finalizing` 仍占用 Actor 与活跃名额，输出应区分“已请求停止”“已在停止”“正在收尾”与实际拒绝。
4. `stop --all` 请求取消后立即汇总返回，不等待全部终态；资源释放沿用 Runtime 现有规则。
5. 状态变更使用同一次 `current(ctx)` 解析出的 service，命令自身不引入异步间隔。若后续加入确认框，确认后必须重新解析并核对代次，不能把旧选择应用到新根。
6. UI 失败不应回滚已完成的状态变更。
7. 只读路径不应调用 `waitForIdle`，不抢占根模型轮次。
8. 命令不得调用 `sendMessage`，也不得新增任何向 Subagent 投递消息的入口；消息只走 `msg_write` 与 IPC。
9. 输出应只展示已持久化或模型可见的信息，不读取子会话凭据。

## 状态变更来源（配套改动）

现状：`StoppingReason` 只有 `{ status, error }`，`runtime.stop(id)` 与 `cancelJob(jobId)` 不记录发起方；预算与退役共用 `#beginStopping`。

建议只记录**显式停止请求**的发起方。预算耗尽与总存活到期继续由既有终态事实（`termination`、`error.code`）表达，不复制一份相同分类。

| 来源 | 触发点 |
| --- | --- |
| 模型工具 | `surface.ts` 的 `subagent_stop` → `RootService.stop` |
| 用户命令 | `/subagent stop` |
| 宿主退役 | `RootService.retire()` 的 `cancelJob` |

实现要求：

1. `stop(id, requester)`、`cancelJob(jobId, requester)`、`#beginStopping(...)` 逐层透传；`retire` 传 `retire`。
2. 预算路径保持现状：`cancelJob` 自身的预算预检与 `#checkBudget` 仍用 Budget 终态表达，不新增 `budget`／`lifetime` 来源值。
3. 来源写入终态 `error.detail`。这属于既有持久化内容的扩展，不新增事件类型或顶层字段；`JobView` 可增加 `stoppingSource` 供 `show` 展示。
4. 必须覆盖所有终态裁定路径：`cancelJob` 的预算预检、`#checkBudget`、`#beginStopping` 与收尾裁定（`adjudicateTerminal`）；晚到观察不能改写来源。
5. 该改动独立于命令，可单独提交与验证。

### 提示词边界

- 提示词不应暴露内部状态机：停止来源只进入 Job 视图与终态 `error.detail`，`stop.description` 保持原样。
- 活跃名额由 `create.capacity` 注入 system prompt 段落，按配置快照生成，见[接口契约](../interface-contract.md#subagent-提示词装配)。

## 非目标

- 不新增事件类型、顶层字段或存储格式；停止来源只扩展现有终态 `error.detail`。
- 第一版不实现交互菜单、`--json` 与跨 session 视图；这些能力的选择与理由见“已定选择”，留待后续版本。
- 不提供消息、steer、唤醒或续跑入口。
- 不接管历史 Actor 的原生会话。历史 Actor 只读展示，续跑仍由 `msg_write` 与既有工具承担。
- 不复制 `subagent_list` 的窗口与折叠逻辑。

## 实现计划

1. 拆成两层：`src/subagent/command.ts` 负责注册、参数解析、调用 `RootService`／`Runtime` 与错误呈现；`src/subagent/status-view.ts` 负责列表文本格式与 `show` 的交互视图（`src/subagent/view.ts` 已被历史视图占用）。不预先设计通用视图框架。
2. 注册点：`src/subagent/extension.ts` 在 `installSessionSurface(...)` 之后调用 `installSubagentCommand(api, current)`，复用现有的 `current`（已包含 `transitionPending`／`retiring` 拒绝和 `assertOperational`）。命令在扩展工厂阶段注册，与工具 loadout、Capability 激活无关：未激活 subagent 工具时仍可查看状态。
3. Handler 主流程：

```text
handler(raw, ctx)
  cmd = parseCommand(raw)                   // 先解析；非法参数不触达 RootService
  service = await current(ctx)              // runtime_transitioning 直接冒泡
  list     -> service.list({ all, id }, 'Main')
  stop     -> service.stop(actorId)
  stopAll  -> service.runtime.jobs().jobs.filter(job => job.status === 'running')
              逐项 service.runtime.cancelJob(job.jobId)，按 {ok} 与 reason 归类，立即返回
```

4. `parseCommand` 是纯函数：支持子命令、`--all`、`--id`、位置参数，未知子命令或缺参返回带 `field` 的 `SubagentError('invalid_command_args')`。
5. 输出：`status-view.ts` 渲染纯文本；默认列表只保留 `id`、深度、种类、角色、状态、调用数，父节点、最近 Job 与终止原因留给 `show`。错误统一捕获 `SubagentError` 后 `ctx.ui.notify(\`${code}: ${message}\`, 'error')`，保留原始 `code`，不重试、不显示堆栈。
6. 事实来源：`RootService.list` 提供窗口、折叠、`kind` 与历史路径；`runtime.jobs()` 提供运行中 Job 与 Budget 快照；`runtime.jobRecord` 只用于终态细节。命令不新增投影规则；缺少的字段按需补薄查询接口。
7. 分步落地，每步单独可验证：
   1. Runtime 列表投影补 `kind`（只读字段，不新增持久化）。
   2. `parseCommand` + 默认列表／`list`（只读）。
   3. `stop` 与 `stop --all`（含 `{ok:false, reason}` 归类）。`StopResult` 需透传 `cancelJob` 的 `reason`（可选字段）；不加时命令只能按 `status` 展示，无法区分 `already_finished` 与 `budget_exceeded`。
   4. `getArgumentCompletions`（子命令 + 当前 Actor id）。
8. 下一阶段重点：交互式 `show`。
   - 入口：`/subagent show [actorId]`；无 id 时用 `ctx.ui.select` 选一个 Actor，有 id 时直接展示。
   - 内容：单个详情视图，沿用 `list` 的纯文本与对齐风格；字段为身份（id／kind／depth／parent）、最近 Job 状态与终止原因、Budget 计数与阶段、历史路径、直接子节点摘要。
   - 边界：只读；不自建分页、返回栈、实时刷新或自定义键位，选择与取消沿用 Pi 自带的 selector。
9. 测试：新增 `test/typed/subagent-command.test.ts`，用 fake `current` 与 fake `RootService` 覆盖解析顺序、`--all`、未知 `--id`、退役中拒绝、`stop` 的 `{ok:false, reason}` 归类、`stop --all` 立即返回。真实 SDK 集成：用 `extensionRunner.getRegisteredCommands()` 取注册命令、`createCommandContext()` 构造上下文调用 handler；TUI 输入、菜单与渲染另列未测。
10. 风险：命令与 Root 同代次，任何异步间隔后不得复用旧 service；`stop` 后 Job 仍占名额，输出必须区分“已请求停止”和“已终结”；命令不直接追加根分支事件，停止产生的终态仍由 Runtime／RootService 记录。

## 测试计划

- Handler 单测：解析先于 `current`、`--all`、未知 `--id`、退役或切换中拒绝、`stop` 的 `{ok:false, reason}` 归类、`stop --all` 立即返回不等待终态。
- Typed 测试：命令只经 `RootService`／`Runtime`；不写根分支；UI 失败不回滚已完成的状态变更。
- 真实 SDK 集成：`extensionRunner.getRegisteredCommands()` 取注册命令，`createCommandContext()` 构造上下文并调用 handler；TUI 输入、菜单与渲染另列未测。
- 停止来源（配套改动单独验证）：工具、用户命令、退役三条路径；预算路径不新增来源值，仍由终态事实表达。
- 门禁：`npm run check`；文档改动另跑 `npm run check:docs`。

## 已定选择

| 问题 | 选择 | 理由 |
| --- | --- | --- |
| 命令名 | `/subagent` | 与工具命名空间 `subagent` 一致；命令是进入该命名空间的单一入口，具体动作由子命令给出 |
| `kind` | v1 展示，在 Runtime 列表投影补 `kind` | 分池限额需要用户能看出子节点属于哪个池；值已由首个 Job spec 推导，只增加一个只读字段 |
| 展示风格 | 参考 `/antigravity.usage` 的多行纯文本；树形缩进 + `●`／`◐`／`○` 状态符 + 固定列，经 `ui.notify` 输出 | 现有命令输出约定就是 notify 文本；树形表达层级，状态符便于扫读，固定列避免 `key=value` 堆砌；不引入 TUI 组件与主题依赖 |
| `show` | 交互式：Pi 自带 `select` 选一个 Actor，单个详情视图；v1 不含 | 详情多字段浏览用纯文本命令不便；复用 Pi 自带 selector 与现有文本风格，不自建组件、分页或键位 |
| Budget 明细 | 不展示 soft／hard，只展示 `JobView.budget` 的计数与阶段 | soft／hard 来自配置快照，暴露它需要扩展 Job 视图；状态命令不需要第二份配置投影 |
| 消息与续跑 | 明确不提供：命令不能给 Subagent 发消息 | 用户命令发消息会绕过发送者身份（`#planMessage` 只认 `Main` 与当前根的 Actor）、重复 `msg_write` 的复活与名额准入，并要求命令自己处理“交接异常不等于未入队”的未知结果；这些都不应出现在状态命令里 |
| 历史 Actor | 允许显式消息，不提供控制 | “只读展示”针对状态视图；显式消息沿用既有复活规则，拒绝原样返回 |
| `--json` | v1 不做 | 目前没有脚本消费者；输出模式会扩大契约与测试，等有消费者再加 |
| 交互菜单 | v1 不做，无参数直接打印列表；`show` 的交互在下一阶段 | 菜单需要额外的选择器与键位处理；先解决命令与状态变更 |
| 命令可用性 | 扩展工厂阶段注册，始终可用 | 命令不是工具，不受 loadout／Capability 激活影响；排查状态时不应依赖先激活工具 |
| 错误呈现 | 捕获 `SubagentError` 后 `ui.notify(code: message, 'error')` | 命令处理器抛原始异常会在 TUI 里显示堆栈；保留 code 便于对账 |
| `stop --all` 范围 | 只对当前根的 `running` Job 发请求；`stopping`、`finalizing` 只报告状态 | 重复请求没有意义；命令立即返回，资源释放沿用 Runtime |

后续版本：交互式 `show`（重点）、`--json`、跨 session 视图（另写提案）。
