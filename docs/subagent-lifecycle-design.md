# Subagent 生命周期重构设计（基于当前实现）

## 状态

本文件是针对 `25963a7` 的实现方案，尚未实施，不替代 `subagent-contract.md`。目标是收敛现有代码的所有权和异步边界，而不是新增调度框架、鉴权、回执或自动重试。

## 1. 当前调用链与问题根源

当前链路：

```text
runtime.task/create
  -> #createJob（Budget、队列、原始 seed）
  -> #pump / #start（占槽、startActive）
  -> startPiJob(request)
       路由 -> resourceLoader.reload -> createAgentSession
       -> session.prompt -> drainLiveMessages
       -> cleanAppendChain -> adapter 判断 finalStatus
       -> writeCompactedSummary -> 必要时读回修改 Markdown
       -> finally：dispose、释放订阅、更新 retained
  -> handle.done.then(#finish, #fail)
       Runtime 再按 job.stopping / Budget 判断状态
  -> #end -> checkpoint / jobDone / 释放槽位 / Notification
```

具体问题不是少一次检查：

1. `handle.done` 同时代表原生执行退出和历史收尾完成。Runtime 只有等摘要写完，才能决定摘要应该写什么。
2. `startPiJob` 的 `cancelled` 同时表示显式 stop、预算 abort、service retirement，不能作为终态原因。
3. adapter 先计算 `finalStatus`，Runtime 的 `#finish/#fail` 又计算一遍。异步写入期间还可以更改结果。
4. queued cancel 在 `cancelJob` 直接 `#end`，路由／资源初始化错误也可能在摘要逻辑之前退出，生命周期不覆盖所有入口。
5. `allocatedAgentIdsBySession` 属于 extension controller；reload 会创建新 controller。它不是完整的根会话身份账本。
6. `retireService` 在设置 retirement Promise、取消 Job 之前就等待 Socket close，先后关系倒置。

现有可保留的部分：4 个执行槽、两层宽度限制、queued 缓冲、原生 steer、`drainLiveMessages`、SessionManager 分支 anchor、根 checkpoint、6 位 UID、分层 Socket 注册表、串行 Clean JSONL 写链。

## 2. 所有权

| 所有者 | 持有内容 | 不再负责 |
| --- | --- | --- |
| Root session 身份记录 | Session ID／UID、已分配 Actor ID | 分支内 Actor 的运行状态 |
| 当前 branch service | 当前可见 registry、retained 描述、Socket、每 Job 写链 | 重新决定终态 |
| Runtime Job | 队列、槽位、停止原因、Budget、唯一 terminal outcome | 操作 SDK 或生成摘要 |
| SDK run handle | abort、session、steer／pending、原生执行和退出 | 判定 cancelled/failed、写终态摘要 |
| 历史收尾函数 | 接收确定 outcome，写尾记录和摘要 | 检查取消标志、Budget、读回改写旧摘要 |

`cancelled` 可保留为 adapter 的“不要继续执行”标志，改名为 `abortRequested` 更准确；原因始终以 Runtime 的 `job.stopping` 为准。

## 3. 只增加一个 Job 状态：finalizing

不公开 registered、starting、quiescing 等多余状态。路由、资源加载、SDK 创建都仍属于 running。

```text
queued  ---------------------------> finalizing -> completed / cancelled / failed
   |                                     ^
   v                                     |
running -> stopping（等待原生退出）--------+
   |
   +------ 原生执行正常退出／报错 ---------+
```

### finalizing 的含义

- 模型、工具、SDK prompt、已接收的 steer 均已退出；或者本轮根本未启动。
- 本 Job 的普通消息接收入口已关闭。
- Runtime 已同步裁决且冻结 terminal outcome。
- 正在刷盘，尚未公开 terminal，不能 revive。
- `stop` 返回 `{ ok: false, reason: "finalizing", ... }`，不修改 outcome。
- `write` 对 finalizing Actor 在 backend preflight 拒绝 `agent_busy`；停止中的仍为 `agent_stopping`。

这是明确修订：模型已经退出后，stop 不再把结果从 completed 改为 cancelled。不能一边允许取消修改结果，一边承诺摘要只追加一次。

保守保留现有槽位释放位置：直到收尾结束再释放 `#running` 的槽位和父节点活跃名额，避免引入第二套调度计数。finalizing 也属于 LIVE_STATUSES。Budget 在执行退出时冻结；磁盘收尾不再算模型执行预算。由此修订“持槽期间全部计 active”的描述，明确槽位在收尾阶段仅用于阻止重叠运行。

## 4. 拆开执行和收尾：具体接口

### 4.1 保留 startJob / handle.done，改变 done 的意义

```js
startJob(request) -> {
  cancel(),
  done: Promise<ExecutionPayload>,
}
```

`done` 只表示：原生运行退出、普通消息入口关闭、资源释放、最终 native history bounds 已捕获。成功或 abort 返回部分 payload；不能返回时仍可 reject。

`startPiJob` 的整个路由／初始化／prompt 必须处于一个顶层 try/finally 内。新创建的 session 应先赋给资源拥有者，再做可能抛错的预算检查，保证创建后失败也会 dispose。

退出顺序：

1. 正常运行沿用 `drainLiveMessages`，在同一同步步骤内确认无 pending／steer 并关闭接收；取消路径关闭接收并等待已启动的原生工作实际退出。
2. 捕获 result、history bounds、有效模型／tools、assignment、anchor；即使出错也保留已记录的部分信息。
3. 解除事件订阅和 Budget watch，确保不再往本 Job 写链追加事件；保存最后的 retained 描述。
4. dispose SDK session；`done` settle。此处不等待 JSONL 写链、不写终态摘要。

事件写链留在 service 的每 Job 历史记录中，使 Runtime 后续收尾能访问它。无需引入通用 event bus 或新的后台 worker。

### 4.2 Runtime 增加一个 adapter hook

```js
createSubagentRuntime({
  startJob,
  finalizeJob: async ({ job, outcome }) => {
    // 等待该 Job 的事件写链，追加 job_end，写一段 summary。
    // 返回历史写入结果；不再决定 outcome。
  },
});
```

`finalizeJob` 对 Pi-free Runtime 测试可省略，省略等同无 I/O 收尾。真实 extension 必须安装它。

`#finish`、`#fail` 不直接 `#end`，共同进入一次性的 `#beginFinalization(job, execution)`。queued cancel、queued lifetime 到期、startJob 同步抛错、非法 handle，也走这个入口。

每 Job 保存一个 finalization Promise；不是重试机制，只防止多个事件重复进入同一收尾。

### 4.3 裁决和冻结必须在第一个 await 前完成

按当前 Runtime 的实际语义，裁决顺序是：

1. 已有 `job.stopping`：采用已接受的停止原因，不能被随后产生的 SDK abort error 覆盖。
2. 无 stopping：调用 `budget.check()`；已失败采用预算失败。
3. 原生执行失败：failed，保留原生错误。
4. 其余：completed。

`cancelJob` 在 queued/running 阶段也先观察 Budget：已经耗尽的预算不能被这次 stop 改成 cancelled；否则接受显式取消。已接受的取消之后 Budget 不再升级为另一个失败，这与当前 JobBudget 的 first-terminal-wins 一致，不采用“预算永远高于取消”的第二套规则。

现有 JobBudget 尚不能冻结“普通工具／模型错误导致的 failed”。需要提供一个内部 settle API（或等价调整 terminate），能冻结 completed/cancelled/failed，保留计数；Runtime 唯一调用。不能通过 `model_final` 把失败 Budget 快照伪装成 completed。

冻结的 outcome 包括：status、error、result、history bounds、Budget 快照、内部 jobId／round。之后 stop、Budget timer、Markdown I/O 都不能改它。

## 5. 历史：每 Job 收尾一次，覆盖所有终止入口

`finalizeJob` 顺序：

1. 等待已经封口的 Clean JSONL 串行写链。
2. 追加一条 `job_end`，包含内部 jobId、round、status、error、Budget。未执行的 queued cancel／路由失败也因此有可读记录，不伪造 user/assistant 消息。
3. 写该 Job 的一段 Markdown。round 从 Runtime 的 Job 顺序提供，不能继续把所有 continuation 固定写成 Round 2。
4. 返回写入结果，Runtime 才 `#end`：发布终态、完成 jobDone、释放槽位、保存 checkpoint，再尝试一次失败 Notification。

删除 `startPiJob` 内的 finalStatus/finalErr 裁决、终态摘要和 `readFile -> lastIndexOf -> writeFile` 修补。每轮历史只能 append，不能为修状态重写整份摘要。

不使用 fsync 或跨文件事务：“历史 ready”表示 Node 文件写入已完成，不承诺掉电后的原子持久化。

### I/O 错误

执行结果与历史写入故障分开记录。历史写入失败不把已完成的模型工作重新判为执行失败；terminal 中增加 `historyState: "ready" | "error"` 及必要的 historyError，list 返回它，UI 明示。不自动重试或继续请求模型。

因此契约应是“terminal 后历史写入已结束；ready 才保证两份文件可读”，而不是吞掉 I/O 错误后声称文件已刷好。某次写链失败需保留错误，不能 `.catch` 通知完就遗忘；仍可尝试写 summary 以保留诊断。

## 6. 普通消息和非唤醒通知

普通消息维持现有行为：queued 缓冲、running steer／轮间缓冲、stopping 拒绝、terminal 显式 revive。新增 finalizing 的 busy 分支，不把消息存进正在销毁的 live run，也不因为收到消息而改变冻结的 outcome。

父 Agent 正在 finalizing 时，子失败通知等待该父 Job 的收尾 Promise 完成，然后走已有 retained 自定义消息追加路径，checkpoint 新 anchor；不能再进入已封口的 SDK run。若此时 service 已退休则放弃。它依然是一次非唤醒追加，不建立收件箱或重试队列。

通知范围不变：Depth 2 只通知其 Depth 1 父节点；Depth 1 只通知 Main。正常完成和显式取消不发异常通知。

## 7. 身份与分支：复用现有 SessionManager，不依赖文件猜测

6 位 UID 继续从根 Session ID 派生，不增加碰撞检测框架。根会话 identity 不能绑定 extension controller 的寿命。

利用当前 checkpoint：

- 根 SessionManager 的 `getEntries()` 返回所有分支的 entries；激活/reload 时扫描其中的 `subagent-state` 注册 Actor ID，构建根级已分配集合。
- 当前可见 Actor/Job 仍只从 `getBranch()` 的最新 checkpoint 恢复，两种读取用途不能混淆。
- 进程内分配记录同步更新根级集合；现有 `onAgentIdAllocated` 可保留。完成完整批次校验后才分配，允许已分配 ID 留空洞，不重新使用。
- 注册后的 checkpoint 必须包含 Actor，即使 queued、路由未完成、没有子 session 文件；因此根会话重新加载仍能从废弃分支发现这个 ID。
- 只在 root activation/reload 扫描全部 entries，不在每次模型事件或 list 轮询扫描。

这避免新增身份数据库／目录 marker。遵循原生 SessionManager 的持久化边界：没有被原生持久化的 entry 不承诺跨进程保留，memory-only session 也不承诺重启恢复。

Fresh 只为新分配 Actor 建 session，已有 Actor revive 必须从其 retained/seed 和 branch anchor 恢复，不能通过同名文件替 Fresh 选择上下文。

## 8. reload／树切换／shutdown

仍复用 `activateRootSession -> retireService -> restoreService`，但 retirement 必须在任何 await 之前建立并登记，所有并发进入者等待同一个 Promise。

退役顺序：

1. 同步标记 service 不接受新工作；禁止 Socket 新投递、create、revive。
2. 对 queued/running 请求取消；stopping 等真实退出；finalizing 只等待，不重新取消。
3. 同时停止 Socket listener，关闭其已有连接。server.close 不能因一个未结束连接阻止发出 Job abort。
4. 等待所有 Job 的 finalization/jobDone；不跳过最后的 retained/anchor 捕获。活动 checkpoint 与退役快照的保存由 lifecycle owner 决定，不能让 `service.closed` 直接抹掉最后的会话位置。
5. 清理句柄、liveJobs、retained，再暴露新 service。

重建时按完整拓扑注册单点端点、Main 广播、已有孩子的 Depth 1 广播端点。保留当前修复。

跨进程恢复中 queued/running/stopping/finalizing 都视为 interrupted，不自动重跑或重发通知。不承诺 root checkpoint 与两个派生历史文件原子一致，也不在恢复时重放摘要；root registry 是生命周期事实来源，部分历史可用于诊断。

## 9. 对现有代码的修改落点

| 文件／函数 | 修改 |
| --- | --- |
| `src/subagent-runtime.mjs` 的 `#finish/#fail/#failStart/cancelJob/#checkBudget` | 统一进入 `#beginFinalization`，仅这里裁决 outcome |
| Runtime 的状态验证、LIVE_STATUSES、list、sendMessage、restoreState | 支持 finalizing，非终态占名额，拒绝写入，不修改 outcome |
| Runtime `#end/#settle/#notifyTerminal` | 只负责收尾完成后的 publication，不重新裁决 |
| `extensions/subagent.mjs:startPiJob` | 全阶段 try/finally、只运行 SDK；封口事件写链，删除摘要状态判断及修改 Markdown |
| extension 新 `finalizePiJob` | 等待写链，用 Runtime outcome 写一次 job_end／summary |
| `src/job-budget.mjs` | 支持 Runtime 冻结普通失败，执行退出后不再计文件写入时间 |
| `createService/restoreService` | 从全部根 entries 重建分配集合；branch checkpoint 仍用于可见 registry |
| `retireService/appendCompletion` | 退休 Promise 提前登记；finalizing 通知走 retained 路径 |
| `docs/subagent-contract.md` | 明确 finalizing、stop 截止点、历史故障状态和 Active Time 边界 |

不建立通用状态机库，不增加独立 starting 状态，不重写路由／Capability／Socket 协议。

## 10. 实施顺序及验收

先完成并测试 Runtime 的单次裁决/finalization hook，再迁移 SDK adapter，最后身份恢复和 retirement；不要在已有补丁上再加一层摘要修补。

必须用事件屏障而非固定 sleep 验证：

1. queued cancel、queued expiry、分类失败、loader 失败、SDK 创建失败、模型失败、正常完成都恰好 finalize 一次。
2. stop 在 routing/tool/model 中被接受；原生退出前保留槽位；退出后 outcome 固定。
3. 延迟 JSONL 和 Markdown：finalizing 可见、write busy、stop 明确未接受、terminal 等待刷盘，只有一段摘要。
4. 预算失败与 stop 的先后顺序按已接受 verdict 固定；无 SDK abort 错误覆盖它。
5. I/O 失败 terminal 可收敛且报告 historyState:error，不声称 ready、不自动重试。
6. 未启动 Actor 跨树分支、reload、新进程恢复都不复用已持久化 ID；正常 Fresh 不含废弃分支上下文。
7. retirement 遇到未结束 Socket 连接仍能立即发出原生 abort，且后继 service 等全部 Job 收尾。
8. 父 finalizing 时 Depth 2 失败通知只追加父上下文一次、不唤醒 Main、不重新打开父 run。
9. revive 保持 Actor、Socket 和两份历史路径不变，内部 jobId/round 增加，Budget 重置。

所有测试命令继续加 Bash `timeout`。当前基线：`timeout 75s npm test`，245 项，244 通过、1 跳过。
