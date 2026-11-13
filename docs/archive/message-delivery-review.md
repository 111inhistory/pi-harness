# 消息与终态通知的投递边界验证

> 历史审查记录：结论仅覆盖检查时的代码与环境。当前行为见[接口契约](../interface-contract.md)，未修复项见[已知问题](../known-issues.md)。

## 已确认要求与实现可行性

作者已明确 D2 的行为要求：通知与 Pi steer message 一致，不另设取消、暂停通知或等待恢复的规则。

直接将通知作为一条 steer message 投递，是作者提出的实现建议，不是已批准的实现决定。以下补充代码核对和实际验证，区分 SDK 能力与产品接线。

### 现有代码已经走原生自定义消息

- `extensions/subagent.mjs:613–635`：通知通过 `pi.sendMessage` 发送，但使用 `triggerTurn: false`；普通消息使用 `triggerTurn: true, deliverAs: 'steer'`。
- `extensions/subagent.mjs:646–696`：发给 Subagent 父节点的通知只追加历史，不启动续跑。
- `src/subagent-runtime.mjs:1549–1552`：目前仅失败任务产生通知，正常完成和取消直接跳过。
- Pi `AgentSession.sendCustomMessage`：支持自定义消息走 steering 队列，同时保留 `customType`、`display` 和 `details`。SDK 不要求 steer 内容只能是用户输入。

### 带类型通知的补充实验

在同一 Pi `1.4.0` 环境，用真实 SDK 和模拟模型，按当前通知格式构造 `agent-completion`，通过 `pi.sendMessage(entry, {triggerTurn: true, deliverAs: 'steer'})` 投递。

| 投递时机 | 新增模型请求 | 正文进入模型请求 | 状态和历史路径保留在原生历史 |
| --- | --- | --- | --- |
| Main 正在执行工具 | 1 | 是 | 是 |
| Main 空闲 | 1 | 是 | 是 |
| 一次 `abort()` 已结束，Main 再次空闲 | 1 | 是 | 是 |

脚本见 [`notification-steer.mjs`](../reviews/reproductions/notification-steer.mjs)，输出见[对应 JSONL](../reviews/reproductions/notification-steer.jsonl)。脚本复现通知格式，没有加载生产 Subagent 扩展，也没有真实模型或网络请求。

**结论：Main 的通知可以直接使用原生自定义消息 steer 路径，保留当前通知的类型与附加信息。** 这不是把通知伪装成用户任务，也不要求再建立消息草稿提交协议。

完整实现不只是改发送参数：还需让正常完成产生通知，并在交给 Pi 前合并普通消息。若父节点是 Subagent，当前运行结束后会释放 SDK Session；空闲时必须经过既有任务管理与续跑入口，不能绕过任务登记、预算和并发限制，直接启动一个未登记的 SDK 执行。该入口还需产品组合测试。

下文保留此前的草稿与取消守卫实验作为资料，不作为新增实现要求。

## 结论

**原生 steer 路径可以投递通知，但排队、历史写入和模型读取不是同一个时点。** 项目负责交接前合并与会话隔离；中断和继续执行沿用 Pi，不由下文的取消守卫实验另定规则。

原生 steering 队列不会自动把进度消息与完成通知合为一项。宿主先保留事件，在 `turn_end` 中提交一条合并消息，可以复现作者要求的工具执行期间合并场景。

本轮没有接入项目实现。D1 的历史写入截止点与 D2 的 steer 行为要求已经明确；具体投递实现仍是经过 SDK 验证的候选。

## 范围与环境

- 记录时间：2026-10-24。
- SDK：本机安装的 Pi Coding Agent 与 Pi AI `1.4.0`；Node.js `22.23.4`。
- 使用真实 `createAgentSession`、扩展事件、原生队列和内存 SessionManager。
- 使用模拟模型输出、合成子任务事件与可控制的等待工具，不连接模型端点。
- 没有执行真实子 Agent，也没有修改项目实现或 SDK。

后续脚本中的取消许可和服务代次是实验夹具的候选逻辑，不是生产路径。通过这些场景不表示产品已修复。

## 一、工具执行期间的批次交接

1. 模拟模型调用等待工具。
2. 等待工具报告已进入执行。
3. 生成同一子任务的进度消息和完成通知。
4. 释放工具，观察后续请求与原生历史。

| 方式 | 后续模型请求数 | 第一次后续请求的内容 | 历史消息数 |
| --- | --- | --- | --- |
| 分别调用 `pi.sendMessage` | 2 | 仅进度消息 | 2 |
| `turn_end` 发送一条合并 steering 消息 | 1 | 同项包含进度与完成信息 | 1 |
| `turn_end` 返回原生消息草稿并请求继续 | 1 | 同项包含进度与完成信息 | 1 |

表中不计初始请求。输出的 `modelCalls` 包含初始请求，分别为 3、2、2。

三种场景均验证了空闲唤醒：`pi.sendMessage(..., {triggerTurn: true, deliverAs: 'steer'})` 新增一次模型请求。脚本等待 `agent_settled`，并在清理前等待 `waitForIdle()`，不把 `agent_end` 当成最终收尾。

## 二、最终回复后的继续执行

**不能把加入草稿前的 `event.context.canContinue` 直接作为返回值。** 最终 assistant 回复后，旧预览不可继续；新增自定义消息会改变最终预览。

| 场景 | 新消息已写入历史 | 后续请求数 |
| --- | --- | --- |
| 返回草稿，并沿用旧预览的 `canContinue: false` | 是 | 0 |
| 返回草稿，并请求 `continue: true` | 是 | 1 |

SDK 在所有边界处理函数运行后重新验证上下文。候选实现可以在确实增加模型可见消息、且宿主仍允许执行时请求继续，不应把旧预览当成权限判断。

## 三、取消与服务代次

| 实验 | 无后置守卫的对照 | 加入候选守卫后的结果 |
| --- | --- | --- |
| 异步边界暂停后，宿主取消 | 草稿仍写入历史；模拟 provider 随后收到已取消的 signal | 未提交草稿，事件留在夹具内存 |
| 异步边界暂停后，服务退役 | 旧事件仍提交并触发后续请求 | 返回前复核代次与存活状态，未提交旧事件 |
| 空闲唤醒已排期后，宿主取消或服务退役 | 本轮未运行无守卫对照 | 派发时复核资格，零次唤醒，事件仍在夹具内存 |

另一个工具取消场景确认：首个 `turn_end.outcome` 仍为 `completed`，最终 `agent_settled.aborted` 才为真。夹具提前撤销投递许可后，没有写入通知。

取消场景中，模拟 provider 可能接到携带已取消 signal 的调用。脚本没有网络请求，不能把这个记录解释为真实端点已经收到请求。

这些实验表明，如果自行规定“取消后禁止通知”，就需要额外的许可检查。作者随后选择沿用 Pi steer message，因此不采用该自建策略。旧会话服务关闭后的隔离检查仍需保留。

## 四、交接之后的新事件

首批消息已经提交后，第二次模型请求期间再生成事件。新事件在下一边界形成第二条历史消息，第三次请求看到它。

该结果支持“已提交批次不修改，后来事件进入下一批”。它不保证任意两个 HTTP 请求之间到达的事件都能并入前一批。

同一微任务内排期两条空闲通知，候选调度只派发一次，并提交一条合并消息。微任务本身不是安全屏障：派发时仍需复核取消、代次和忙碌状态。

## 五、返回草稿不等于提交成功

测试加入第二个扩展处理函数，由它返回空 `entries` 和 `continue: false`。结果如下：

- 第一个处理函数提出的消息没有写入历史。
- SDK 没有将这种合法替换报告为错误。
- 若第一个处理函数已经用 `splice` 移除内存事件，事件就会丢失。

因此，原生边界返回值只是提案，不是提交回执。候选适配器应通过公开的 `entry_appended` 事件核对本批提交，再释放对应内存事件。还需验证批次标识、部分提交与重复边界，不能在此宣称恰好一次投递或引入自动重试承诺。

## SDK 代码证据

以下路径相对于 `node_modules/@earendil-works/`。

| 位置 | 静态依据 |
| --- | --- |
| `pi-agent-core/dist/agent.js:141` | steering 默认使用 `one-at-a-time` |
| `pi-coding-agent/dist/core/extensions/types.d.ts:752–795` | 边界可返回 `custom_message` 草稿与继续执行标记 |
| `pi-coding-agent/dist/core/extensions/runner.js:759–809` | 处理函数顺序运行；后续函数可替换草稿；预览在各函数返回后重建 |
| `pi-coding-agent/dist/core/agent-session.js:486–533` | 执行 `turn_end` 边界、提交草稿，再决定继续执行 |
| `pi-coding-agent/dist/core/agent-session.js:613–639` | 计算最终上下文与 `canContinue`，提交后发出 `entry_appended` |
| `pi-coding-agent/dist/core/agent-session.js:683–708` | `agent_settled` 扩展处理期间，SDK 仍可能暂存触发执行的动作 |
| `pi-coding-agent/dist/core/agent-session.js:1449–1474,1566–1586` | 宿主取消影响收尾与继续执行；已运行的边界仍可能先提交草稿 |
| `pi-coding-agent/dist/core/agent-session.js:1844–1881` | 忙碌时排队；空闲且触发执行时启动新一轮 |
| `pi-agent-core/dist/agent-loop.js:177–200` | 工具结果完成后发出 `turn_end`，随后读取 steering 队列 |

`context` 与 `context_with_system` 是请求投影，不等于历史提交。`pi.sendMessage` 返回 `undefined`，不能据此断言模型已经收到消息。

`session.pendingMessageCount` 不统计所有自定义消息，不能用它证明通知队列已空。`agent_end` 也不表示自动重试与收尾已经结束。

## 候选架构约束

以下是实验结束时提出的候选，后来已由“沿用 Pi steer message”替代，不再作为当前方案：

- 采用 SDK 历史提交作为批次不可修改的边界，不承诺模型已读。
- 在 `turn_end` 提出批次草稿；用 `agent_before_settle` 检查可继续的尾部事件。
- 观察本批原生条目提交后，才释放对应的内存事件。
- 显式取消后不自动唤醒；恢复需来自用户或父任务的明确动作。
- 旧代次退役后禁止新投递，不把事件转交新分支。

SDK 的空闲状态只回答“是否忙碌”，不回答“是否获准继续”。不要在边界处理函数内等待 `session.abort()`；`abort()` 等待空闲，而空闲又依赖处理函数返回。

## 剩余验证

- 提交观察与部分写入失败，及多个扩展修改同一边界。
- 多子任务、多轮次事件隔离与顺序。
- `agent_before_settle` 与自动重试组合下的尾部排空。
- 真正分支替换与旧回调到达，而非夹具中的代次变更。
- 真正取消入口与候选许可之间的完整接线。

## 复现材料

- [`reproductions/message-delivery.mjs`](../reviews/reproductions/message-delivery.mjs)：6 个输出场景，原始输出见[对应 JSONL](../reviews/reproductions/message-delivery.jsonl)。
- [`reproductions/message-boundaries.mjs`](../reviews/reproductions/message-boundaries.mjs)：12 个含断言的边界场景，原始输出见[对应 JSONL](../reviews/reproductions/message-boundaries.jsonl)。

场景数仅适用于上述版本与本轮脚本。负向对照的断言通过，表示成功观察到缺陷条件，不表示负向做法可用于实现。
