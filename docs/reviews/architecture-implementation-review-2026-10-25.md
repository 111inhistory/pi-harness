# 架构边界与代码实现 Review（2026-10-25）

> 历史审查记录：结论仅覆盖检查时的代码与环境。当前行为见[接口契约](../interface-contract.md)，未修复项见[已知问题](../known-issues.md)。

## 结论

**存储 v2 与提示词外置之后，项目能运行，默认回归也通过，但当前文档声明的职责边界大多没有落到代码结构上。** 主要风险集中在三处：

1. 受管理消息经过本进程 Socket 回环，调用方拿不到 runtime 的接收结果；广播的失败被静默丢弃。
2. `write` 覆写后能连接任意非受管的 `.sock` 端点。这是相对重写前行为的回归（见 [R1](#r1写入非受管-socket-的回归)）。
3. Subagent 适配层集中在一个 2148 行的文件里，并与 runtime 并行保存一部分生命周期状态。

作者决定本轮**保留 Socket**。下文的修改方向都以保留 Socket 为前提。

本文是 Review 记录，不是已经批准的修改方案。

## 范围与验证

- 检查对象：提交 `e757008` 的工作区，即 `extensions/`、`src/`、`prompts/` 和当前 `docs/` 文档。不使用 `docs/archive/` 推断需求。
- 运行验证：Linux 上执行 `npm run check`，类型检查通过；317 项测试中 315 通过、0 失败、2 环境跳过。
- 证据类型：除特别注明外，下文结论来自**静态代码阅读**，没有编写复现脚本。行号对应 `e757008`。
- 未检查：真实模型行为、Windows 实机、Shell Preflight、`experiments/`，以及 `capability-broker.mjs` 的检索排序细节。

## 作者澄清与撤回项

- **Capability 资格只增不减是有意设计。** 本轮初稿把"父会话失去工具后，子会话资格不收回"列为问题。该项撤回，不作为缺陷。
- 作者说明：能力在压缩后丢失的现象，来自外部插件 `pi-better-compaction` 的缺陷。作者计划停用该插件。停用后，`src/responses-tool-prefix.mjs` 和 `docs/reviews/native-compaction-review.md` 中为该插件写的兼容部分可能可以删减。本轮没有核实具体范围。
- 作者说明：重写开始前，工作区代码会拒绝非受管 Socket，但那版代码从未提交。

## 回归

### R1：写入非受管 Socket 的回归

**状态：作者确认是回归；git 历史中找不到修正前的版本。**

**当前行为：** `src/subagent-ipc-unix.mjs:8` 的 `isEndpoint` 只判断路径是否以 `.sock` 结尾。`createSocketAwareWriteOperations` 把非受管端点的内容原样写出（`src/subagent-socket.mjs:234`）。

**影响：** 根会话与子会话的 `write` 都由 harness 覆写（`extensions/subagent.mjs:988`）。所以 `write` 能向任意 Unix Socket 发送任意字节，例如 `/var/run/docker.sock`。路由角色用黑名单排除 `bash` 时，这条路径仍可以绕过排除，因此黑名单不再是执行边界。Pi 原生 `write` 对 Socket 路径执行文件写入只会失败，不会建立连接。

**来源：**

- 首个 Socket 提交 `56f8ed6` 就对所有 `.sock` 路径调用 `writeSocketOneWay`。此后 `1467da1` 到 `3f6eba6` 都保留了非受管分支的原样写出。
- 归档契约 `docs/archive/subagent-contract.md:251` 写着"普通文件和外部 Socket 不受这一字段规则影响"，把这条路径当成了合法行为。
- 没有任何测试断言"`write` 不连接非受管端点"。

**修改方向：** 非受管端点应拒绝，错误码可用 `unmanaged_endpoint`。同时应补一条回归测试：`write` 写非受管 `.sock` 路径时，不发起任何连接。`msg_write` 应采用同一规则。

## 架构与边界

### A1：受管理消息的投递结果不能返回调用方（高）

**当前路径：**

```text
write / msg_write → sendManagedSocket → writeSocketOneWay
  → 本进程 Socket 服务 → onMessage → runtime.sendMessage
```

`writeSocketOneWay` 在客户端写完并 `end()` 后就返回成功。runtime 在后面拒绝时，错误只进入 `ui.notify`（`extensions/subagent.mjs:860`），调用的 Agent 看不到。

写入前只预检了 `assertMessageAdmission`，覆盖未知 Agent、子节点名额和 stopping。以下情况被 runtime 拒绝时，调用方看到的仍是成功：

- 空文本或纯空白：`managedFrame` 接受，`#planMessage` 拒绝；
- 超过 32768 字符；
- 发给自己；
- 预检之后才进入 finalizing 的竞态；
- live Job 在交接过程中关闭后返回的 `agent_busy`。

**广播：** `createBroadcastSocketServer` 对每个直接子节点各自调用 `runtime.sendMessage`，不收集结果。`ensureBroadcastSocketServer`（`extensions/subagent.mjs:880`）没有传 `onError`，所以失败被静默丢弃。runtime 中能逐个接收者返回 `sent`／`errors` 的 `#broadcast`，在 Socket 路径上没有被调用。这与接口契约 D3 "返回每个接收者的成功或失败"不一致。

**修改方向（保留 Socket）：** 宿主自己发出的受管理写入，宜在 `sendManagedSocket` 中直接调用 `runtime.sendMessage`，把回执或广播结果返回给工具。Socket 服务继续供外部进程接入。这样回执的语义只取决于调用方是不是宿主，不取决于传输方式。

### A2：Socket 报文的发送者可以伪造（中高）

Socket 服务端信任报文里的 `from`。报文缺少 `from` 时，服务端默认把发送者当作 `Main`（`extensions/subagent.mjs:845`）。同一用户下的任意进程都能冒充 Main 或任意 Agent。

文档已把外部客户端的身份列为待定。但"缺少 `from` 时当作 Main"是最宽的默认值。

**修改方向：** 缺少或不合法的 `from` 应拒收，不应回退为 Main。

### A3：文档列出的职责所有者没有对应到模块（高）

`architecture.md` 列出了执行器、投递协调器、IPC 适配器和历史写入器等所有者。实际代码中：

- `extensions/subagent.mjs` 有 2148 行，同时负责服务生命周期、恢复、Socket 监听、投递、Job 执行循环（`startPiJob` 和 `drainLiveMessages`）、路由调用和历史收尾。
- `src/subagent/delivery.ts` 只有 85 行，不保存状态，只格式化消息并调用一次 `send`。投递逻辑实际分散在 `deliverToMain`、`deliverMessage`、`sendAgentDeliveryPayload`、`appendCompletion` 和 `deliverToLiveJob` 中。
- 文档所说的 typed 核心（`lifecycle.ts`、`delivery.ts`、`execution.ts`）约 530 行。`subagent-runtime.mjs`（1567 行）和适配层是 `.mjs`，`tsconfig.json` 设置了 `checkJs: false`，因此大部分逻辑不在类型检查范围内。

### A4：同一生命周期事实有多份可修改状态（高）

- **Job 是否在运行：** runtime 用 `job.status` 判断，适配层另用 `service.liveJobs` 和 `live.closed` 判断。两者靠时序保持一致。
- **中断恢复有两套：** `restoreService` 先把未结束的 Job 补为 `job_interrupted`（`extensions/subagent.mjs:345`）。runtime 的 `planRestore` 还保留了错误码为 `interrupted` 的路径（`src/subagent-runtime.mjs:45`）。走适配层时后者基本不会执行，但同一个概念有两个错误码。
- **`stoppedOrder`** 在适配层的恢复代码和 runtime 中各算一次。
- **`MAX_AGENT_DEPTH`** 在 `src/subagent-runtime.mjs:22` 和 `extensions/subagent.mjs:47` 各定义一次。

这与设计约束"每一类可变状态只有一个写入所有者"不一致。

### A5："Capability 复用 Subagent 执行"只做到一部分（中）

两者共用的只有 `openSubagentExecution`，它是包住 `createAgentSession` 的一层薄封装，负责会话所有权与清理。以下逻辑仍各写一份：

| 逻辑 | Subagent | Capability |
| --- | --- | --- |
| Budget 观察器 | `extensions/subagent.mjs:1227` `watchBudget` | `src/capability-agent.mjs:297` `watchBudget` |
| ModelRuntime 桥接 | `adoptParentModelRuntime` | `parentModelRuntime`（`extensions/capability.mjs:427`） |
| 运行结果分类 | `assertRunCompleted` | `providerErrorDetail` |

这与设计约束"不再另建一套会话创建、预算、取消和清理流程"不完全一致。

### A6：退役与持久化（中）

- **退役没有超时。** `retireService`（`extensions/subagent.mjs:168`）无限等待 `jobDone`。原生会话的 `waitForIdle` 一旦不结束，切换会话、`/tree` 和 shutdown 就会一直挂起。这与"不能无限等待客户端自行断开"的要求方向不一致。
- **退役期间结束的 Job 不写终态。** 退役一开始就设置 `service.active = false`，随后 `persistRuntimeEvent`（`extensions/subagent.mjs:1756`）直接返回。退役时被取消或恰好完成的 Job 不写 `job-end`，下次恢复会记为 `job_interrupted`，结果文本丢失。原因可能是根事件经全局 `pi.appendEntry` 写到当前叶子，而不是服务所属的分支。这一取舍没有写进文档。
- **`historyState`／`historyError` 不持久化。** `finalizePiJob` 先写一份不含 `historyState` 的 `job-end`（`extensions/subagent.mjs:1645`）。runtime 的 `#end` 再写一次时，这次写入被 `endedJobs` 去重丢弃（`extensions/subagent.mjs:1760`）。重启后，历史写入失败的状态会消失。

### A7：查询工具有写盘副作用，并且会整体失败（中）

`listDetailed` 对每个 Agent 调用 `historyPaths`（`src/subagent-runtime.mjs:604`），进而调用 `ensureJobView`。`ensureJobView` 会同步打开子会话文件，视图缺失时还会写盘。这条路径没有异常处理：任意一个 Agent 的历史不可读时，整个 `subagent_list` 都会失败。

### A8：Socket 监听与列表显示窗口耦合（低）

`listenerGroup` 复用了 `subagent_list` 的分组窗口（每组最多 4 个）来决定保留哪些监听。窗口外的 Agent 会被关闭监听，在下次托管写入时再恢复。宿主自己的写入会触发恢复，但外部进程连接窗口外的 Agent 时会失败。显示策略不宜决定传输可达性。

## 代码实现

### I1：通知投递结果不被检查（中）

`sendDelivery` 只要服务处于活动状态就同步返回 `accepted: true`，真实的发送结果放在 `completion` 里（`src/subagent/delivery.ts:78`）。所有调用方都不检查 `completion`。因此 `deliverMessage` 中的 `if (result.accepted)`（`extensions/subagent.mjs:651`）恒为真。原生发送失败时，代码不会回退到 `appendCompletion`，终态通知静默丢失。

### I2：提示词与 Schema 不一致（中）

- `capability_search` 的 `src` 枚举仍是 `["local", "remote", "all"]`（`src/capability-broker.mjs:98`），参数说明也仍把 remote 和 all 写成可用选项（`prompts/capability-tools.json`）。系统提示又要求只用 `local`。模型照参数说明调用 remote 时，会消耗内部预算（硬上限 8 次 Model Call）。
- Main 的 guidelines 仍包含 "A needs_approval result is a candidate…"。远端候选现在不会返回，这条是无效指引。

### I3：Capability 资格计算的开销（低）

`capabilityAllowsTool` 每调用一次，就递归执行父链上的 `capabilityAvailableTools`，后者遍历 `getAllTools()`（`src/capability-scope.mjs:27`）。`context_with_system`、`tool_call` 和 `selectedInterfaces` 会对每个工具调用它，所以每次请求的开销约为 O(工具数² × 深度)。宜在每次请求内缓存一次结果。

### I4：文档、注释与代码不一致

| 位置 | 描述 | 代码实际情况 |
| --- | --- | --- |
| `known-issues.md`：自动通知与消息合并 | 已删除队列观察探针 | `takeQueuedMessages` 仍用探针读取队列，并临时改写 `agent.steeringMode`（`extensions/subagent.mjs:2087`） |
| 当前文档 | 消息不合并 | `drainLiveMessages` 把缓冲的多条文本用 `\n\n` 合成一次 prompt（`extensions/subagent.mjs:1961`） |
| `src/subagent/lifecycle.ts:112`、`src/subagent-runtime.mjs:1354` | 注释仍描述 merge | 合并已撤回 |
| 架构文档：共用投递入口 | 终态只有一种封装 | 发给 Main 时为 `agent-delivery`，追加到保留会话时为 `agent-completion`；`MESSAGE_CUSTOM_TYPE` 没有使用 |
| `test/subagent-runtime.test.mjs:1199,1218` | 通知不会创建 Job；只有显式写入才会续跑 | 真实适配器经 `reviveWithNotification` 唤醒并创建 Job；该测试使用不唤醒的假适配器 |
| `extensions/capability.mjs:420`、`src/pi-job-budget.mjs:2` 等 | Pi 0.99 | 依赖锁定为 1.4.0 |
| `src/subagent-runtime.mjs:563` | — | Main 的 `status` 固定为 `"running"` |

另外，当前文档多处使用"已全面实现""均已通过"等措辞。结合上表，这些措辞会让维护者高估完成度。

### I5：其他

- `createService` 中 `ensurePrivateSocketRoot` 同步抛出时（`extensions/subagent.mjs:223`），`session_start` 直接失败。这条路径没有像存储错误那样走 `latchStorageError` 锁存，用户只看到一个异常。
- 子 Agent 发给 Main 的每条普通消息都带 `triggerTurn: true`。子 Agent 完成时，空闲的父 Agent 还会以新的 Budget 续跑。4 个子 Agent 相继完成，最多触发 4 次父 Agent 续跑。这与 D2 一致，但成本特征宜写入文档。

## 保留价值较高的部分

- `src/ipc/endpoint.ts`：硬链接原子发布、按 inode 校验后删除、私有根目录校验、主动断开连接，是边界处理最完整的模块。
- `ServiceLifecycle`：代次与失效判断正确，覆盖了并发激活和退役。
- `adjudicateTerminal`：终态裁决集中在一处，"首个停止原因优先"有测试。
- 存储 v2：事件折叠和写时复制设计合理；恢复时先整体校验，再追加修复事件。

## 修改顺序建议

以下顺序以保留 Socket 为前提，需作者确认后再实施。

1. **R1 + A2：** 拒绝非受管端点；缺少 `from` 时拒收；补回归测试。
2. **A1：** 宿主写入直接调用 runtime 并返回回执；广播返回逐个接收者的结果。
3. **I1 + A6：** 检查投递的 `completion`；持久化 `historyState`；给退役加超时；在文档中写明退役时终态不落盘的取舍，或者改为按分支写入。
4. **I2：** `src` 枚举只保留 `local`；删除 `needs_approval` 指引。
5. **A3 + A4 + A5：** 把 Job 执行循环、投递、恢复与持久化从 `extensions/subagent.mjs` 拆出；只由 runtime 判断 Job 是否在运行；合并重复的 Budget 观察器、ModelRuntime 桥接和中断恢复。
6. **I4：** 订正文档与注释；当前文档只描述接口和边界，不写进度。
7. 停用 `pi-better-compaction` 之后，复核 `src/responses-tool-prefix.mjs` 及相关调查记录能否删减。
