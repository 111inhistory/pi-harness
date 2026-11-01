# Subagent 状态命令提案

本文是设计提案，不是当前契约。当前行为见[接口契约](../interface-contract.md)，模块边界见[当前架构](../architecture.md)。提案落地前，Subagent 状态只能由模型调用 `subagent_list` 等工具获得，用户无法直接查看。

## 结论

- 应新增扩展命令 `/subagents`（名称待定），让用户在当前 Pi 会话中直接查看当前根服务的 Subagent 树与 Job 状态。
- 该命令应同时支持改变部分状态：停止运行中的 Job、显式唤醒 idle Actor。
- 命令应复用 `RootService` 的既有投影与 `Runtime` 的既有准入，不新增状态机、持久化字段或第二套展示规则。

## 现状与依据

| 事实 | 依据 |
| --- | --- |
| 扩展可以注册命令 | `pi.registerCommand(name, { description, handler, getArgumentCompletions })`，见 SDK `dist/core/extensions/types.d.ts:1171`、`:1231` |
| 命令处理器上下文 | `ExtensionCommandContext` 提供 `ui`、`waitForIdle`、`newSession`、`fork`、`navigateTree`，见 `types.d.ts:286` |
| 当前根服务获取 | `src/subagent/extension.ts:43` 的 `current(ctx)`；退役或切换期间抛 `runtime_transitioning` |
| 只读投影 | `RootService.listDetailed`（`root-service.ts:320` 起补充 `history`、`historyDir`）、`SubagentRuntime.list`／`listDetailed`／`jobs`（`runtime.ts:997`、`1016`、`1105`） |
| 状态变更入口 | `RootService.stop`、`RootService.sendMessage`（`root-service.ts:337-344`）→ `runtime.stop`、`runtime.sendMessage` |
| 展示同源 | `surface.ts` 的 `subagent_list` 与根服务投影共用每组 4 项窗口与折叠规则 |

命令处理器与 Root 服务同进程、同代次，不需要模型轮次，也不消耗 Job Budget。

## 建议的命令形态

```text
/subagents                     交互选择 Actor，再选择动作（详情／停止／唤醒）
/subagents list [--all] [--id ID]
/subagents show <id>
/subagents stop <id|jobId>
/subagents stop --all
/subagents wake <id> [text]
```

- `list` 复用 `listDetailed` 投影与每组 4 项窗口；`--all` 映射 `all: true`。每个直接子节点应标注种类（Fresh／Inherited），与 `subagent.maxActiveChildren`、`subagent.maxActiveInheritedChildren` 的分池一致。
- `show` 输出 Actor 的 `status`、`depth`、父节点、最近 Job 的 `status`、`termination`、`error` 与历史路径，并附 Budget 快照（`snapshot({ detail: true })`）。
- `stop` 调用 `runtime.stop`。`stop --all` 逐项调用并汇总失败项，不把部分失败报告为成功。
- `wake` 调用 `runtime.sendMessage({ from: 'Main', to: id, content })`，默认用 `ui.confirm` 确认，因为它会创建续跑 Job。
- `getArgumentCompletions` 提供子命令与 Actor id 补全。

## 不变量

1. 命令应只经 `RootService` 与 `Runtime` 改变状态，不直接改写 `job.status`，不写根分支事件。
2. 命令应在执行前经 `current(ctx)` 取得当前代次。退役或切换中应直接失败，不缓存旧 `RootService`。
3. 停止请求不等于终态。`stopping`、`finalizing` 仍占用 Actor 与活跃名额，输出应显示“已请求停止，等待原生执行退出”。
4. `wake` 应沿用既有续跑准入。`child_limit_exceeded`、`max_depth_exceeded` 等拒绝应原样呈现，不重试，不重放。
5. 状态变更不应创建新的 Job 或 Budget。`wake` 产生的续跑 Job 由 `Runtime` 按既有规则创建。
6. UI 失败不应回滚已完成的状态变更。
7. 只读路径不应调用 `waitForIdle`，不抢占根模型轮次。
8. 输出应只展示已持久化或模型可见的信息，不读取子会话凭据。

## 状态变更来源

现状：`StoppingReason` 只有 `{ status, error }`，`runtime.stop(id)` 与 `cancelJob(jobId)` 不接收来源；预算与退役也走同一条 `#beginStopping`。因此终态与列表无法区分“模型调用了 `subagent_stop`”、“用户执行了命令”、“预算耗尽”与“根服务退役”。命令接入后必须补上来源，否则用户无法判断一次取消是谁发起的。

| 来源 | 触发点 | 传值 |
| --- | --- | --- |
| 模型工具 | `surface.ts` 的 `subagent_stop` → `host.stop(id)` | `model` |
| 用户命令 | 本文的 `/subagents stop` | `user` |
| 宿主退役 | `RootService.retire()` 的 `cancelJob` | `retire` |
| 预算耗尽 | `#checkBudget` 的 `budget_exhausted` | `budget` |
| 总存活到期 | `#checkBudget` 的 `lifetime_expired` | `lifetime` |

实现步骤：

1. `StoppingReason` 增加 `source`，取值 `model`、`user`、`retire`、`budget`、`lifetime`。
2. `stop(id, source)`、`cancelJob(jobId, source)`、`#beginStopping(job, status, error, source)` 逐层透传；`#checkBudget` 根据 Budget 终态选择 `budget` 或 `lifetime`。
3. `jobView` 的 `stopping` 从状态字符串改为 `{ status, source }`；终态的 `error.detail` 增加 `source`，不新增顶层字段。
4. `firstEffectiveStopping` 仍保留首个有效原因，来源随该原因固定；晚到的预算或执行报告不能改写来源。
5. 停止语义不变：无论来源，Job 仍占用 Actor 与名额，直到原生执行退出并完成收尾。

### 提示词边界

- 提示词不应暴露内部状态机：停止来源只进入 Job 视图与终态 `error.detail`，`stop.description` 保持原样。
- 活跃名额由 `create.capacity` 注入 system prompt 段落，按配置快照生成，见[接口契约](../interface-contract.md#subagent-提示词装配)。

## 非目标

- 不新增持久化字段或存储格式。
- 不实现常驻状态面板；后续可用 `ui.setStatus` 提供摘要。
- 不接管历史 Actor 的原生会话。历史 Actor 只读展示，续跑仍由 `msg_write` 与既有工具承担。
- 不复制 `subagent_list` 的窗口与折叠逻辑。

## 实现计划

1. 新增 `src/subagent/command.ts`，导出 `installSubagentCommand(api: ExtensionAPI, current: (ctx: ExtensionContext) => Promise<RootService>): void`。该模块只做命令注册、参数解析和输出渲染，不持有 Job 状态，不缓存 `RootService`。
2. 注册点：`src/subagent/extension.ts` 在 `installSessionSurface(...)` 之后调用 `installSubagentCommand(api, current)`，复用现有的 `current`（已包含 `transitionPending`／`retiring` 拒绝和 `assertOperational`）。命令在扩展工厂阶段注册，与工具 loadout、Capability 激活无关。
3. Handler 主流程：

```text
handler(raw, ctx)
  service = await current(ctx)              // runtime_transitioning 直接冒泡
  cmd = parseCommand(raw)                   // 纯函数；非法参数抛 SubagentError('invalid_command_args')
  list     -> renderTree(service.listDetailed({ all, id }, { callerId: 'Main' }))
  show     -> renderActor(service.list(), service.jobRecord(cmd.jobId))
  stop     -> service.stop(cmd.target)
  stopAll  -> Promise.allSettled(nonTerminal(service.runtime.jobs()).map(stop))，汇总失败项
  wake     -> ctx.ui.confirm(...) 后 service.sendMessage({ from: 'Main', to, content })
```

4. `parseCommand` 是纯函数：支持子命令、`--all`、`--id`、位置参数，未知子命令或缺参返回带 `field` 的 `SubagentError`。解析失败不触达 `RootService`。
5. 输出：纯文本多行；Actor 行含 `id`、`status`、`depth`、种类（Fresh／Inherited）、父节点、最近 Job 与 `historyDir`。拒绝路径统一 `ctx.ui.notify(message, 'error')`，保留原始 `code`，不重试。
6. 复用点：`listDetailed` 提供窗口、折叠与历史路径；`jobs()` 提供 `stop --all` 的目标集合；`jobRecord` 提供 `status`、`termination`、`error` 与 Budget 快照。命令不新增投影规则。
7. 分步落地，每步单独可验证：
   1. `parseCommand` + `list`／`show`（只读，无状态变更）。
   2. `stop` 与 `stop --all`（含部分失败汇总）。
   3. `wake`（`ui.confirm` + 拒绝透传）。
   4. `getArgumentCompletions`（子命令 + 当前 Actor id）。
8. 测试：新增 `test/typed/subagent-command.test.ts`，用 fake `current` 与 fake `RootService` 覆盖参数解析、`--all`、未知 `--id`、退役中拒绝、`stop --all` 部分失败、`wake` 拒绝透传；SDK 端到端取决于 SDK 是否暴露命令执行入口，未确认前标注未测。
9. 风险：命令与 Root 同代次，切换后旧命令不得操作新根；`stop` 后 Job 仍占名额，输出必须区分“已请求停止”和“已终结”；命令不写根分支，因此不产生额外持久化事件。

## 测试计划

- Handler 单测：使用 fake `RootService`，覆盖子命令解析、`--all`、拒绝路径透传。
- Typed 测试：退役或切换中拒绝；`stop` 后名额释放；`wake` 经 `sendMessage` 且拒绝原样返回；`stopping.source` 在工具、命令、预算、存活到期与退役五条路径上分别为 `model`、`user`、`budget`、`lifetime`、`retire`。
- 真实 SDK：现有 `test/typed/harness-config-sdk.test.ts` 场景没有命令执行入口，需先确认 SDK 是否暴露命令调用。若不暴露，只做 handler 级覆盖，并在交付说明中标注未测。
- 门禁：`npm run check`；文档改动另跑 `npm run check:docs`。

## 未决问题

1. 命令名用 `/subagents` 还是 `/subagent`。
2. 是否保留 `wake`（改变状态且创建 Job），或只保留 `stop`。
3. 交互菜单与子命令并存，还是只做子命令。
4. `stop --all` 是否应遵守退役顺序：先请求停止，再等待终态。
5. 是否需要 `--json` 输出供脚本使用。
