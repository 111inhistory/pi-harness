# 架构调整设计：父 Subagent 等待子任务保活与 `revive` 语义收敛

本文已归档。parent-hold 已实现，当前行为见[接口契约](../interface-contract.md)和[当前架构](../architecture.md)。下文保留实现前的缺陷分析与候选方案；旧控制流、函数名和两层拓扑是当时的背景，不表示当前限制。

## 1. 背景与现状缺陷

在两层派生拓扑（`Main -> Depth 1 Subagent -> Depth 2 Subagent`）中，当前实现存在一处生命周期语义割裂：

1. **现状控制流**：
   - 当 Depth 1 Subagent 调用 `subagent_create` 派生 Depth 2 子任务后，若按指引结束当前回复（`conclude your turn to wait for completion notifications`），`NativeJobRunner.#run` 中的 `drainLiveMessages` 发现当前时刻 `parked` 与 `buffered` 消息均为空，会立即将 `live.closed` 置为 `true` 并退出。
   - 这导致 Depth 1 的 **Round 1 Job 立即以 `completed` 终态结束**，并向 `Main` 发送一条虚假的 Round 1 完成通知（正文通常是“我已派发子任务，正在等待结果”）。
   - 随后当 Depth 2 子任务陆续完成时，`NativeDeliveryRouter` 通过 `runtime.reviveWithNotification` 将处于 `idle/stopped` 的 Depth 1 反复唤醒为新的 **Round 2、Round 3 Continuation Job**（每次分配全新的 Job ID 与全新的 Budget），并再次向 `Main` 发送多次终态通知。
2. **核心矛盾**：
   - 对 Depth 1 而言，“结束当前回复以等待子任务通知”与“任务彻底完成、向父节点交付最终结果”在物理动作上都是结束当前模型回合（无 tool call）。
   - 在子任务尚未结束时就将父 Subagent 判定为 `completed` 并销毁会话、通知 `Main`，不仅造成虚假终态通知和 Budget 重复分配，也使 `revive`（续跑）混杂了“未完成任务的内部等待唤醒”与“已停止节点的新一轮任务唤醒”两种完全不同的语义。

---

## 2. 目标架构设计（零新公开状态、零新工具）

### 2.1 状态不变量：有活跃子节点时保持 `running`

- **不引入 `waiting` 等新公开状态**：
  - 对外状态机保持不变（Job：`running | stopping | finalizing | completed | failed | cancelled`；Agent 列表展示：`running | stopping | finalizing | stopped`）。
  - 只要一个 Subagent 仍有处于非终态（`running | stopping | finalizing`）的直接子 Agent，该父 Subagent 的当前 Job 在拓扑语义上就仍处于 **`running`** 状态，继续持有其活跃名额与当前会话句柄。
- **内部 `drainLiveMessages` 保活与 Budget 暂停**：
  - 在 `NativeJobRunner` 的 `drainLiveMessages` 循环中，当 `parked` 与 `buffered` 消息均消费完毕、准备关闭 `live.closed = true` 前，检查 `deps.hasActiveChildren(live.agentId)`：
    - **若 `hasActiveChildren === false`**：所有直接子任务均已终结且当前无待处理消息，正常设置 `live.closed = true` 退出循环，当前 Job 进入终态并向父节点发送唯一一次终态通知。
    - **若 `hasActiveChildren === true`**：
      1. 调用 `request.budget.pauseActive()` 暂停活跃时间（`activeTimeMs`）计费（等待子任务期间不消耗父节点活跃时长预算，仅受总存活租约 `lifetimeMs` 约束）；
      2. 在 Runner 内部挂起等待唤醒信号（当 `handoff` / `handoffCustom` 收到新消息或终态通知、或所有子节点均已离开活跃态、或当前 Job 被 `cancel` 时唤醒）；
      3. 唤醒后调用 `request.budget.startActive()` 恢复活跃时间计费（并触发 Runtime 侧 Budget 定时器重排 deadline），继续下一轮 `drainLiveMessages` 消费新到达的子节点通知或消息。

### 2.2 收敛 `revive` 语义并移除 `reviveWithNotification`

- **`revive` 的唯一语义**：
  - **仅当一个 Subagent 已经彻底处于 `stopped`（即当前 Job 已终结，且必然没有任何活跃子节点）时，由外部显式发送 `msg_write` 唤醒它启动新一轮 Job（Round N+1），才称为 `revive`。**
- **移除 `reviveWithNotification`**：
  - 由于父 Subagent 在其子 Subagent 运行期间始终保持当前 Job 处于 `running` 状态（直至子节点的终态通知投递完毕并由父节点处理收尾），子节点的终态通知永远是投递给一个**正在 `running` 的父 Job**（走 `runner.handoffCustom` 进入 `live.pending` 并唤醒挂起的 `drainLiveMessages`）。
  - 唯一可能的例外是：父 Job 因被取消（`cancelled`）或自身失败（`failed`）而提前进入 `stopping / finalizing / stopped`，此时晚到的子节点终态通知按既有规则通过 `appendRetained` 追加到父节点的保留会话历史中，**绝不通过通知自动开启新一轮 Job**。
  - 因此，`SubagentRuntime.reviveWithNotification` 及其在 `NativeDeliveryRouter.toAgent` 中的分支可以直接删除。

---

## 3. 涉及的模块与改动范围

1. **`src/subagent/runtime.ts` & `src/subagent/native-types.ts`**：
   - 为 Runner 提供查询接口（如 `hasActiveChildren(agentId: string): boolean`）。
   - 删除 `reviveWithNotification` 方法及相关类型定义。
   - 确保 Budget 在 `pauseActive()` / `startActive()` 切换时，Runtime 内部的 `watchSubagentBudget` 能重排下一次 deadline 定时器。
2. **`src/subagent/native-runner.ts`**：
   - 在 `LiveJob` 中增加轻量唤醒信号（如 `wake: (() => void) | null`）。
   - 在 `handoff` / `handoffCustom` 入队 `live.pending` 以及 `cancel()` 时调用 `live.wake?.()`。
   - 在 `drainLiveMessages` 中：当队列为空但 `deps.hasActiveChildren(live.agentId)` 为真时，`pauseActive()` -> `await waitForWake(live)` -> `startActive()` 并继续循环。
3. **`src/subagent/native-delivery.ts`**：
   - 在 `toAgent` 中移除 `this.#deps.runtime.reviveWithNotification(agentId, message)` 分支；终态通知统一走 `runner.handoffCustom`，若父节点已因取消/故障关闭，则走 `appendRetained` 写入保留历史。
4. **`prompts/subagent-turns.json`**：
   - 在 `context` 中微调结束条件说明：明确若仍有运行中的子任务，结束当前回复即挂起等待通知；待全部工作完成后再在最终回复中输出结果。
5. **测试更新**：
   - 更新 `test/typed/subagent-lifecycle.test.ts`、`test/typed/native-delivery.test.ts`、`test/typed/review-lifecycle-storage.test.ts` 中涉及 `reviveWithNotification` 的用例；
   - 新增/更新 Depth 1 派生 Depth 2 后结束当前回复的用例：验证 Depth 1 保持 `running`（Round 1 不提前结束、不向 Main 发假通知、等待期间 `activeTimeMs` 暂停计费），待 Depth 2 完成后在同一 Round 1 内继续执行并最终发送唯一一次完成通知。
