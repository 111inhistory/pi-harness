# 项目深度代码与架构审查报告（2026-10）

## 0. 结论摘要

相较于此前（`e757008` 时期 2148 行的 `extensions/subagent.mjs` 单文件巨石），当前工作区已经完成了主干的职责拆分与大部分 TS 迁移：
- **架构演进显著改善**：`RootService`、`SubagentRuntime`、`NativeJobRunner`、`ActorSessionStore`、`AgentListeners`、`NativeDeliveryRouter` 等职责拆分清晰，单向依赖和所有权边界比上一轮合理得多。
- **核心问题重心转移**：
  1. **架构与边界缺陷**：Inherited 模式存在虚拟模型（`pi-virtual`）与 Responses/MCP 工具声明链断裂的实质性 Bug；`RootService.create` 等待首个模型流分发存在批次级阻塞与静默死锁隐患；`NativeJobRunner` 双重包装 `streamFunction` 存在脆弱耦合；监听同步（`listeners.sync`）在并发创建与执行流中重复调用。
  2. **极其严重的冗余防御性编程**：由于早期 JS/TS 混写，代码库形成了“在每一层内部都把上游当成不可信外部输入”的习惯——大量 `isPlainObject` / `checkFields` / `deepFreeze` / `structuredClone` / 重复 JSON 解析校验，不仅拖累可读性，还掩盖了真正的边界。
  3. **剩余 `.mjs` 技术债**：`src/` 和 `extensions/` 下仅剩 **9 个 `.mjs` 文件（约 1,620 行）**，且其中至少 30% 的代码是用于弥补无类型体系的运行时参数校验与合并逻辑，全量迁 TS 成本很低且能顺带砍掉大量冗余代码。
  4. **提示词（Prompts）**：外置 JSON 简洁度整体较好，但部分提示词（如 `config/subagent-routing.json` 中的回溯难度汇报要求、Subagent 命名空间双工具曝光、以及 `capability_step` 的 schema 描述）存在指令污染或行为诱导问题。

---

## 1. 架构设计与核心边界问题

### 1.1 [高] Inherited Subagent 的工具继承与虚拟模型断裂（两处实质性边界缺陷）

对比 `extensions/capability.ts` 与 `src/subagent/` 的 Inherited 路径，存在两处不一致和断裂：

1. **虚拟模型（`pi-virtual`）在 Inherited Subagent 中丢失物理模型身份**
   - **现状**：`extensions/capability.ts:340-367` 的 `inheritedModel()` 专门处理了 `selected.api === "pi-virtual"`——通过回溯 `sessionManager` 中发起调用的 assistant message 解析出真实的物理模型（因为继承的 thinking block 带有特定物理模型签名，重路由会导致签名校验失败或跨供应商报错）。
   - **问题**：`src/subagent/root-service.ts:62-69` 的 `capturedModel()` 完全没有处理 `pi-virtual`。当父会话使用虚拟模型创建 `inheritContext: true` 的 Subagent 时，子会话直接拿到了虚拟模型或重路由到其他物理模型，导致继承历史中的签名 thinking 块在子会话首次请求时报错或失效。
   - **修复方向**：将 `inheritedModel` 的物理模型回溯逻辑提取到 `src/subagent/model-runtime.ts`，供 Capability 和 Inherited Subagent 共用。

2. **Inherited Subagent 无法继承父会话已激活的 MCP / 扩展工具，且 Responses 增量工具前缀断裂**
   - **现状**：
     - `src/subagent/tool-policy.ts:46-54` 的 `transplantableToolNames` 只允许 `sourceInfo.source === "builtin"` 和硬编码的 harness 工具，直接把父会话通过 Capability 激活的 MCP 工具（`mcp__*`）及 `codemode` 判定为不可移植并丢弃。
     - 同时，`src/subagent/native-session.ts:119-128` 在创建子会话时：`if (request.loadDefaultExtensions) installCapabilityMcp(childPi)`，而 Inherited 模式下 `loadDefaultExtensions` 为 `false`（`native-runner.ts:413`：`loadDefaultExtensions: roleId !== null`）。
     - 结果：Inherited 子会话既没有安装 `installCapabilityMcp`，也在 `tool-policy.ts` 中把父会话已选中的 MCP 工具全部过滤掉了。更严重的是，继承的会话历史（`entries`）里保留了父会话的 `toolsAdded` 声明和历史 `toolCall`，但子会话中没有对应的工具注册，违反了 `known-issues.md` 中待办的 Inherited 工具继承预期。

### 1.2 [已对齐方向] `RootService.create` 的返回边界与就绪信号设计

- **位置**：`src/subagent/root-service.ts:132-135, 195-204`、`src/subagent/native-runner.ts:95-110, 489-500`
- **设计初衷**：避免 `subagent_create` 仅做无意义的纯内存注册就返回（如果配置错误、模型缺失或子会话初始化失败，应在 `create` 调用本身就报错，而不是返回成功后再发失败通知）。
- **当前实现的问题**：
  1. **`#starting` Map 缺乏异常清理闭环**：在 `RootService` 中，`startJob` 把 `handle.firstModelCall` 塞进 `this.#starting.set(request.agentId, handle.firstModelCall)`，依赖 `RootService.create()` 随后消费并 `delete`。
  2. **双重包装 `agent.streamFunction` 的脆弱性**：
     - 在 `native-runner.ts:479-499` 中，先调用 `installModelCallBudget` 包装了一次 `agent.streamFunction`，紧接着又手写了一段 `observeStream` 再次 monkey-patch `agent.streamFunction`。
     - 两个 wrapper 都各自注册了 `if (agent.streamFunction === wrapper) agent.streamFunction = previous` 的恢复逻辑，对清理顺序极度敏感。
- **优化设计方案**：
  - **将就绪屏障定在「路由完成 + 子会话与扩展装配完成 + IPC 监听就绪 + 首个 Prompt 已提交（或 `turn_start` 事件触发）」**，或者在 `installModelCallBudget` 内部统一提供 `onStreamDispatched` 钩子，彻底移除 `native-runner.ts` 中手写的第二层 `agent.streamFunction` 包装。
  - 同时确保 `#starting` 句柄在 `done` settle 时自动清理，避免泄漏。

### 1.3 [中] `listeners.sync()` 的高频冗余调用与竞态窗口

- **位置**：
  - `src/subagent/root-service.ts:183`（`initialize()` 结束时调用 `await this.listeners.sync()`）
  - `src/subagent/root-service.ts:191`（`create()` 注册完 batch 后调用 `await this.listeners.sync()`）
  - `src/subagent/native-runner.ts:505`（**每个 Job** 在打开 session 后、发 prompt 前又调用一次 `await deps.listeners.sync()`）
- **问题**：
  - 当 `subagent_create` 并发启动 4 个子 Agent 时，`RootService.create` 调了一次 `listeners.sync()`，紧接着 4 个 `NativeJobRunner` 各自在启动时又调了 4 次 `listeners.sync()`（共 5 次串行排队走 `#enqueue`）。
  - 在 `AgentListeners.sync()` 中，每次都会重新计算全量 `#destinations()` 并遍历比对。
  - 更重要的是：**Runner 是单个 Job 的物理执行器，根本不应该负责全局 Socket 监听器的同步**（这也违背了 `architecture.md` 中“Runner 不负责 Socket”的声明）。Socket 监听只与 Actor 注册表变化有关，由 `RootService` 在 `initialize` 和 `create` 时同步即可；续跑（revival）复用的本就是已注册 Actor 的既有监听端点。

### 1.4 [中] 双轨超时定时器：`runtime.ts` 的 `#scheduleLifetime` 与 `budget-watch.ts` 重复

- **位置**：`src/subagent/runtime.ts:1615-1630` vs `src/subagent/budget-watch.ts:68-96`（由 `native-runner.ts:258` 启动）
- **问题**：
  - 每个 Subagent Job 启动时，`SubagentRuntime.#createJob` 会启动一个 `#scheduleLifetime` 定时器盯住 `lifetimeMs` 并调用 `this.#checkBudget(job)`；
  - 与此同时，`NativeJobRunner.#run` 又调用 `watchSubagentBudget(request.budget, request.checkBudget)` 启动了另一个定时器，同样盯住 `min(lifetimeRemaining, activeRemaining)` 并调用同一个 `request.checkBudget`。
  - 同一份 `lifetimeMs` 超时被两个模块各自用一套 `setTimeout` 监控。既然 `watchSubagentBudget` 已经同时覆盖了 `lifetimeMs` 和 `activeTimeMs.hard`，Runtime 内部的 `#lifetimeTimers` 属于冗余状态，或者反过来应统一归口到一处。

### 1.5 [低] IPC 路径与平台工具函数在 3 个模块中重复实现

- **位置**：
  - `src/subagent/address.ts`：`effectiveUserId`、`defaultSocketRoot`、`pipePath`、`formatAgentSocketPath`
  - `src/ipc/endpoint.ts`：`effectiveUserId`、`defaultSocketRoot`、`insidePath`
  - `src/ipc/platform-windows.ts`：`PIPE_ROOT`、`pipePath`
  - `src/ipc/socket.ts`：`isInSocketDirectory` 中的 `inside` 逻辑、以及 `src/capability-skills.mjs` 中的 `isWithin` / `canonical`
- **问题**：为了所谓的“让 `runtime.ts` 不 import `ipc/`”，`address.ts` 把 `endpoint.ts` 和 `platform-windows.ts` 的路径生成与哈希算法原样复制了一份。一旦某一边修改了 Windows Pipe 命名规则或默认目录规则，另一边就会失步导致连接失败。事实上，纯路径计算函数放在 `src/ipc/address.ts` 作为底层纯函数，由 `endpoint.ts`、`platform-*.ts` 和 `runtime.ts` 共同引用即可，完全不会引入文件系统副作用。

---

## 2. 冗余的防御性编程（重点清理项）

项目的 `AGENTS.draft.md` 明确提出：**“区分强依赖与弱依赖……严禁把弱依赖边界当成强事务不变量去层层叠甲自检”**。但当前代码库中存在大量**跨内部模块甚至同模块内部**的过度防御：

### 2.1 对自己生成/已类型化的内部对象反复执行运行时 Schema 校验
1. **`src/job-budget.mjs` 的过度防御**：
   - `JobBudget` 仅在项目内部两处被调用（`runtime.ts` 和 `capability/agent.ts`）。
   - 但 `job-budget.mjs` 写了 `OPTION_FIELDS`、`SNAPSHOT_FIELDS`、`TERMINATE_FIELDS`、`PROFILE_FIELDS`、`LIMIT_FIELDS` 五个 Set，外加 `checkFields()`、`requireLimit()`、`requireProfile()`、`requireDepth()`、`#readClock()`，甚至对 `snapshot({ detail: true })` 和 `terminate({ reason: "cancelled" })` 都要遍历 `Object.keys` 检查有没有多余字段。
   - 迁入 TypeScript 后，这些内部调用契约全部由编译器保证，这 ~120 行运行时字段白名单校验完全是死重。
2. **`src/subagent/runtime.ts` 构造函数与内部方法的自检**：
   - `SubagentRuntime` 构造函数（`runtime.ts:760-810`）在 TS 已经有 `RuntimeOptions` 接口的情况下，仍然用 50 行代码逐个检查 `typeof startJob !== "function"`、`for (const [name, value] of Object.entries(...))`。
   - `RootService.#finalize`（`root-service.ts:269`）把 `outcome.transcript` 传给 `transcriptObjects()`，逐个元素检查 `if (!record(value)) throw ...`——而 `outcome.transcript` 就在几行前由 `readTranscript()` 生成，每个元素100%是 `{ role: ... }` 对象。
3. **`src/subagent/delivery.ts` 的重复校验**：
   - `sendDelivery(entry)` 先调一次 `validateDeliveryEntry(entry)`，紧接着下一行调 `deliveryMessage(entry)`，里面第一行又调一次 `validateDeliveryEntry(entry)`。而在 TypeScript 中 `entry: DeliveryEntry` 的字段类型本就是静态已知的。
4. **`RootService.#route` 对 `routeSubagent` 返回值的二次校验**：
   - `src/subagent-routing.mjs` 和 `src/subagent/routing.ts` 已经严格校验并返回了 `{ roleId, instructions, model, thinkingLevel, excludeTools, enableTools }`，但 `root-service.ts:323-328` 拿到返回值后又当成 `unknown` 重新校验了一遍所有字段类型，甚至把 `model` 传给 `capturedModel()` 再去 `registry.find()` 查一遍（而 `routeSubagent` 内部刚调过 `resolveChatModel(registry, model)`）。

### 2.2 滥用 `deepFreeze`、`Object.freeze` 与 `structuredClone`
- **`job-budget.mjs`**：每次 `beginModelCall()`、`startActive()`、`pauseActive()`、`terminate()`、`snapshot()` 都对返回的小对象调用 `Object.freeze` 或递归 `deepFreeze`。在高频调用路径上递归冻结纯内部消费的状态视图毫无必要（TS 的 `readonly` 接口已提供编译期保护）。
- **`actor-sessions.ts`**：每次 `retain()`、`seal()`、`checkpointAppendedAnchor()` 都调用 `freezeDescriptor()` 对 descriptor 及内部数组做浅拷贝 + `Object.freeze`。
- **`runtime.ts`**：内部状态流转大量调用 `cloneValue()`（底层为 `structuredClone`），例如 `#jobRequest` 中 `pending.map(cloneValue)`、`reviveWithNotification` 中 `cloneValue(envelope)`、`#emitEnd` 中 `cloneValue(job.error)`。这些对象都是宿主自己剛构造出来的不可变通知或错误对象，反复深拷贝纯属防御性冗余。

### 2.3 提示词 JSON 资产在多处重复 `JSON.parse` 与手写类型守卫
- **现状**：
  - `prompts/capability-tools.json` 被 `extensions/capability.ts`（`readToolsPrompt`）、`src/capability/contracts.ts`、`src/capability/agent.ts`（`assetField`）分别读取并 `JSON.parse` 了 **3 次**，每个文件各自写了一套 `isRecord` / `object` 校验函数。
  - `prompts/subagent-tools.json` 被 `src/subagent/surface.ts`（`parseToolText` + `promptString`）和 `src/subagent/message-write.ts`（`msgWriteToolText`）分别读取并 `JSON.parse` 了 **3 次**，各自手写了几十行的嵌套属性校验。
- **改进建议**：在 `src/prompt-text.ts` 中按文件做一次解析与类型收窄（或直接导出强类型的加载函数），砍掉散落在各业务模块里的上百行 `requireRecord` / `requireText` / `assetField` 样板代码。

---

## 3. 边界处理（Edge Cases）审查

### 3.1 [中] `drainLiveMessages` 中对缓冲消息（`buffered`）的回放可能触发 `empty_response` 误杀
- **位置**：`src/subagent/native-runner.ts:598-626, 738-763`
- **触发条件**：
  - 当子 Agent 正在结束上一轮 turn、或者处于启动缓冲期时，收到了来自父/同级 Agent 的消息（进入 `live.pending`）。
  - 在 `drainLiveMessages` 中，Runner 先通过 `appendCustomMessage`（`triggerTurn: false`）把消息写入历史，然后发送 `continuationControlPrompt(null)`（内容为 `"Review the new messages above and continue your work."`）触发 `prompt()`。
  - 紧接着调用 `assertRunCompleted(messagesAfter(sessionManager, boundary))`。
  - 如果此时子 Agent 刚被外部取消（`live.cancelled` 在 `prompt()` 返回的微任务间隙变为 `true`），或者模型因某种原因返回了 `stopReason: "aborted"`，`assertRunCompleted` 会抛出 `run_aborted` 错误，而外层 `catch` 会将其归类为 `status: "failed"`（除非 `job.stopping` 已经被 Runtime 标记为 `cancelled`）。
  - 更微妙的是：在 `replayParkedUser`（`native-runner.ts:652-661`）中，如果 parked user message 的 `content.text === ""` 且 `images.length === 0`，函数直接 `return` 跳过了，但如果是纯空白字符串（如 `"   "`），仍会发起一次无意义的模型请求。

### 3.2 [中] `RootService.#temporaryResults` 临时目录泄漏
- **位置**：`src/subagent/root-service.ts:81, 260-264, 240-249`
- **触发条件**：在非持久化（in-memory）根会话中，当子 Agent 产出超过 50KiB 或 2000 行的长结果时，`#finalize` 会通过 `mkdtempSync(path.join(tmpdir(), 'pi-subagent-results-'))` 创建临时目录写入结果文件。
- **问题**：`RootService.retire()` 只关闭了 `listeners` 并等待 `jobs` 结束，**从未清理 `this.#temporaryResults` 目录**。在测试或长期运行的内存会话中，这些临时目录会残留在操作系统的 `/tmp` 下。

### 3.3 [低] `AgentListeners` 广播错误在外部 Socket 路径下丢失详细收件人失败信息
- **位置**：`src/subagent/listeners.ts:95-100` vs `src/ipc/socket.ts:102-104`
- **现象**：
  - 当外部客户端向 `children.sock` 广播且部分子 Agent 拒收时，`listeners.ts` 抛出 `new SubagentError('broadcast_partial_failure', 'Some broadcast recipients rejected the message.', { errors: result.errors, sent: result.sent })`。
  - 但 `socket.ts` 的 `readNdjson` 在捕获异常写回响应时只写了 `JSON.stringify({ code: errorCode(error), message: asError(error).message })`，丢弃了 `detail`（即具体哪个子 Agent 失败及原因），导致外部调用方只能看到笼统的 `"Some broadcast recipients rejected the message."`。而在 `message-write.ts:96` 中，宿主内部路径是把 `receipt.errors.map(e => `${e.to}: ${e.message}`).join('; ')` 拼进了 `message` 的。两边错误信息粒度不一致。

### 3.4 [低] `takeQueuedMessages` 队列探针的边界假设
- **位置**：`src/subagent/lifecycle.ts:288-315`、`src/subagent/native-runner.ts:675-691`
- **评价**：利用临时修改 `steeringMode = "all"` 并塞入 probe 对象来无损提取 SDK 队列，在单线程同步执行下是成立的（因为 `steer` / `peekQueuedMessages` / `clearSteeringQueue` 之间没有 `await` 让出事件循环）。但前提是 `agent.steer(probe)` 在 SDK 内部绝不能同步触发任何带有副作用的监听器（如 UI 渲染或日志记录）。目前 `known-issues.md` 已诚实记录了这一边界，短期可維持现状，长期应推动上游 `@earendil-works/pi-agent-core` 暴露只读的 `getSteeringQueue()` / `getFollowUpQueue()`。

---

## 4. 提示词（Prompts）审查

结合 `AGENTS.draft.md` 的原则（**“Prompt 是系统契约的一部分，严禁引入内部实现细节噪音……指令一律采用明确的技术动词与行为原语，坚决杜绝空洞的角色扮演说教与反向诱导”**），逐一审查 `prompts/` 与 `config/subagent-routing.json`：

### 4.1 [中高] `config/subagent-routing.json` 中残留了无用的“回溯难度汇报”指令（污染子 Agent 最终交付）
- **位置**：`config/subagent-routing.json` 中 `researcher`、`executor`、`reviewer` 三个角色的 `# Completion` 段落末尾：
  > `"After completion, report experienced difficulty as low, medium, or high with one factual reason; this is retrospective feedback, not a request to select a model or thinking level."`
- **问题**：
  1. 这显然是从早期路由实验（`experiments/jev-routing`）遗留下来的指令！
  2. 在生产环境中，子 Agent 的最终回复会通过 `terminalResultContent` **直接作为任务结果投递给父 Agent**。要求每个子 Agent 在完成任务后都附加一句“报告体感难度 low/medium/high 及原因”，不仅白白消耗输出 token，还会把毫无意义的路由实验反馈污染到父 Agent 的上下文中。
  3. 同时，`config/subagent-routing.json` 的 `sol` 模型 `preference` 中还写着：`"model eligibility and thinking ranges are defined separately in each role's candidate pool"`——而项目早已删除了 `thinking ranges`（改为候选直接指定单个 `thinking` 值）。
- **建议**：立即从 `config/subagent-routing.json` 的三个角色指令中删除 `After completion, report experienced difficulty...` 这一句，并修正 `sol` 偏好中的 `thinking ranges` 措辞。

### 4.2 [已确认修改] 移除对默认 `write` 的覆写，仅保留 `msg_write` 并归入 `subagent` 命名空间
- **位置**：`src/subagent/message-write.ts`、`src/subagent/surface.ts`、`prompts/subagent-tools.json`、`prompts/subagent-turns.json`
- **决议**：
  - 不再 override Pi 默认的 `write` 工具（彻底删掉文件写入与 IPC 发送混合的 `createSocketAwareWriteOperations` 文件分流、Named Pipe 绕过文件队列 hack 以及 `isReservedPath` 递归 `realpath` 检查）。
  - `msg_write` 归入 `subagent` 命名空间（`namespace: SUBAGENT_NAMESPACE`），专门负责向受管 Agent IPC 端点发送纯文本消息。
  - 所有子 Agent（含只读角色与叶子深度节点）默认可用 `msg_write`，提示词统一只引导使用 `msg_write`。

### 4.3 [低] `prompts/execution-budget.json` 与 `prompts/capability-policy.json` 拼接后的语义冲突
- **位置**：`src/capability/agent.ts:103`：`capabilityBudgetWarning` 将 `execution-budget.json` 的 `warning` 与 `capability-policy.json` 的 `budgetWrapUp` 拼接为：
  ```text
  Reaching soft model call limit. Please submit your current work (even if incomplete) quickly.

  Finish now via capability_step with finish: true and queries: []; include final selected refs.
  ```
- **问题**：
  1. `execution-budget.json` 的 `warning` 末尾多了一个尾随空格（`"quickly. "`）。
  2. 在 `pi-job-budget.mjs:100` 中，这条警告是以 `{ role: "user", content: [...] }` 的形式**伪装成用户消息**追加到上下文末尾的！在检索会话或编码子会话中途突然插入一条 `role: "user"` 的消息说 `"Reaching soft model call limit..."`，既不符合原生 `<system>` 控制消息规范，也可能在部分严格校验 user/assistant 交替或工具调用链的模型上引发困惑。

### 4.4 [已对齐方向] `prompts/subagent-turns.json` 明确禁止用 `msg_write` 等工具调用收尾
- **位置**：`prompts/subagent-turns.json`
- **设计初衷**：防止模型在结束任务时画蛇添足地调用 `msg_write` 发送最终结果，而非直接通过最终文本回复交付。
- **建议措辞**：
  > `"You are Subagent {agentId}. Your direct parent is {parentId}. Use msg_write to parentSocket {parentSocket} only for mid-task blockers, coordination, or interim decisions (messaging does not complete your task). Do not send your final result via msg_write; when finished, output your final result directly in your response and end your turn without a tool call—the host automatically delivers your final response to your parent."`

---

## 5. JS (`.mjs`) 技术债盘点与全量 TS 迁移路线图

目前生产代码（`extensions/` 与 `src/`）中残留的 `.mjs` 文件共 **9 个**。按照“**不保留兼容性，全写成 TS**”的要求，逐个评估迁移价值与瘦身空间：

| 序号 | 当前文件 | 行数 | 迁移目标 | 迁移时应直接砍掉的技术债 / 改造点 |
| --- | --- | --- | --- | --- |
| 1 | `src/prompt-text.mjs` | 15 | `src/prompt-text.ts` | 增加集中式的 JSON 资产读取与类型定义，消除 `surface.ts`、`message-write.ts`、`capability.ts`、`agent.ts` 中重复的 `JSON.parse` 与手写字段校验函数。 |
| 2 | `src/inherited-context.mjs` | 97 | `src/inherited-context.ts` | 直接产出强类型的 `InheritedSnapshot` 接口（复用 SDK 的 `FileEntry`、`Model<Api>`、`ThinkingLevel`），从而删掉 `extensions/capability.ts:154-175` 的 `inheritedSnapshot()` 校验转换函数和 `surface.ts:303-312` 的 `requireCapturedContext()`。 |
| 3 | `src/subagent-view.mjs` | 90 | `src/subagent/view.ts` | 直接移入 `src/subagent/` 目录；使用 `SessionEntry` 强类型替代手写的 `typeof part === "object"` 防御分支；删掉 `root-service.ts` 中的 `transcriptObjects` 二次检查。 |
| 4 | `src/capability-skills.mjs` | 53 | `src/capability/skills.ts` | 直接移入 `src/capability/` 目录；为 `discoverSessionSkills` 补齐 `ExtensionAPI` 与返回类型，使 `broker.ts:152` 无需再用 `record()` / `array()` 解包。 |
| 5 | `src/pi-job-budget.mjs` | 115 | `src/subagent/pi-job-budget.ts` | 修正注释中过时的 `"Pi 0.99 adapter"`；增加可选的 `onStreamDispatched?: () => void` 钩子，合并 `native-runner.ts` 中重复的 `streamFunction` 包装。 |
| 6 | `src/job-budget.mjs` | 405 | `src/subagent/job-budget.ts` | **重点瘦身**：删掉 `OPTION_FIELDS`、`SNAPSHOT_FIELDS`、`TERMINATE_FIELDS`、`PROFILE_FIELDS`、`LIMIT_FIELDS`、`checkFields`、`deepFreeze` 等约 120 行纯运行时防御代码；直接实现 `runtime.ts` 中的 `JobBudgetPort` 接口，消除 `runtime.ts` 里的重复类型定义与 `as JobBudgetPort` 强转。 |
| 7 | `src/subagent-routing.mjs` | 290 | `src/subagent/ routing.ts`（合并） | **直接与现有的 `src/subagent/routing.ts` 合并为一个文件**！目前路由被人为劈成 `src/subagent/routing.ts`（配置校验）和 `src/subagent-routing.mjs`（执行分类）两个文件，合并后可删掉 `validateConfig` 包装层及 `root-service.ts:#route` 中的返回值二次校验。 |
| 8 | `src/subagent-storage.mjs` | 450 | `src/subagent/storage.ts` | 直接移入 `src/subagent/`；用 TypeScript 判别联合类型（Discriminated Unions）定义 5 种 `subagent-*` 事件（`EVENTS`），消除 `RootService.initialize()` 和 `ActorSessionStore` 中大量的 `unknown` 二次断言。 |
| 9 | `extensions/shell-preflight.mjs` + `src/shell-preflight.mjs` | 78 + 135 | `extensions/shell-preflight.ts` + `src/shell-preflight.ts` | 补齐 `ExtensionAPI`、`ExtensionContext` 及 `ShellPreflightResult` 判别联合类型。 |

> **附带清理**：
> - `tsconfig.json`：完成上述 9 个文件迁移后，应将 `"allowJs": true` 移除（或设为 `false`），并将 `test/*.test.mjs` 与 `test-support/*.mjs` 逐步迁入 `test/typed/`，彻底关闭 JS 后门。
> - `experiments/` 与 `scripts/`：如果不属于生产运行时，保持在 `tsconfig.json` 的 `include` 之外即可，或将 `scripts/test.mjs` 改为 `.ts`。

---

## 6. 审阅意见对齐与最终实施路线图

经与用户及审阅意见交叉核对，最终达成以下工程决议：

### 6.1 核心决议对照表

| 议题 | 最终决议 | 理由与技术边界 |
| --- | --- | --- |
| **1. `subagent_create` 启动屏障** | **采用方案 A** | 等待「路由完成 + 子会话与扩展装配完成 + IPC 监听就绪 + 首个 Prompt 已提交（进入运行态）」，删除 `firstModelCall` 管道、`#starting` Map 及 `native-runner.ts` 中的第二层 `observeStream` 包装。 |
| **2. 消息工具与 `write` 解耦** | **删除 `write` override，统一走 `msg_write`** | `msg_write` 归入 `subagent` namespace，所有子会话默认可用；不再拦截默认 `write`，删除普通文件与 Socket 混写分流、Named Pipe 绕过文件队列 hack 及 `isReservedPath` 检查。 |
| **3. 外部 Socket 广播错误** | **保留失败详情** | 外部 IPC 错误响应保留每个失败收件人及原因，与内部 `msg_write` 错误信息对齐。 |
| **4. `listeners.sync()` 归口** | **仅由 `RootService` 调用** | 移除 `NativeJobRunner` 中的 `await deps.listeners.sync()`，由 `RootService` 在 `initialize` 和 `create` 时确保监听就绪。 |
| **5. Lifetime 定时器收敛** | **将 `watchSubagentBudget` 收归 `SubagentRuntime`** | 原 `Runtime.#scheduleLifetime` 只看 `lifetimeMs` 不看 `activeTimeMs.hard`；将完整的 `watchSubagentBudget` 移入 `Runtime` 替代 `#scheduleLifetime`，并从 `NativeJobRunner` 移除。**关键接线点**：必须在 `Runtime.#start` 调用 `budget.startActive()` 之后启动/重排 watcher（不能仅在 `#createJob` 未 active 时排期），并在 `#beginStopping` / `#beginFinalization` / `#end` 时清理。 |
| **6. Inherited 正确性修复** | **修复虚拟模型回溯 + 明确工具可继承范围** | ① 提取物理模型回溯逻辑供 Capability 与 Inherited Subagent 共用；② 修复 Inherited 子会话中已激活 MCP/扩展工具的注册与执行链路。 |
| **7. 校验、Freeze 与 Clone 清理** | **按实际引用与突变关系清理** | 保留磁盘恢复、配置文件、外部 IPC、工具入参校验；删除内部已类型化返回值复查、`delivery.ts` 重复校验、`transcriptObjects` 复查；删除 `freezeDescriptor`、`job-budget` 的 `deepFreeze`、已 `splice(0)` 移交的 `pending.map(cloneValue)` 等无共享突变风险的拷贝；其余拷贝逐处核查“原对象是否仍被保存 + 接收方是否会原地修改”后再定去留。 |
| **8. 内存会话临时文件清理** | **绑定进程退出清理，不在普通 `retire()` 中误删** | SDK 在切换会话/fork/reload 时也会触发 `retire()` 与 `session_shutdown`，直接删除会导致同会话内已投递路径失效；因此仅在 `process.once("exit")`（或明确退出进程）时 `rmSync` 清理 `#temporaryResults`。 |
| **9. 提示词修订** | **已完成修改并验证通过** | 已完成 `prompts/subagent-tools.json`、`prompts/subagent-turns.json`、`prompts/execution-budget.json` 与 `config/subagent-routing.json` 的精确修订。 |
| **10. 全量 `.mjs` 迁 `.ts`** | **按模块推进，补齐完整源模块类型，不留 shim** | 将剩余 9 个 `.mjs` 全部重写为 `.ts`，在消费端 Port 基础上补齐源模块全部导出与内部类型，完成后关闭 `tsconfig.json` 的 `allowJs`。 |

### 6.2 实施阶段划分

1. **阶段一：提示词、启动屏障（方案 A）与通信解耦（`msg_write`）**
   - 修改 `prompts/` 与 `config/subagent-routing.json`。
   - 重构 `src/subagent/message-write.ts`、`src/subagent/surface.ts`、`src/ipc/socket.ts`：移除 `write` 覆写，`msg_write` 挂入 `subagent` 命名空间，补齐外部 Socket 广播失败详情。
   - 重构 `src/subagent/native-runner.ts` 与 `src/subagent/root-service.ts`：落地启动方案 A，移除 `firstModelCall` / `#starting` / `observeStream`，移除 Runner 内的 `listeners.sync()`。
2. **阶段二：Inherited 模式正确性修复**
   - 在 `src/subagent/model-runtime.ts` 统一 `pi-virtual` 物理模型回溯，接入 `extensions/capability.ts` 与 `src/subagent/root-service.ts`。
   - 修复 Inherited 子会话的工具装配与 Responses 增量声明链（`src/subagent/native-session.ts`、`src/subagent/tool-policy.ts`、`src/subagent/native-runner.ts`）。
3. **阶段三：全量 `.mjs` 迁 `.ts` 与内部冗余清理**
   - 迁移 9 个 `.mjs` 模块至 `.ts`（合并 `subagent-routing.mjs` 与 `src/subagent/routing.ts`，集中 `src/prompt-text.ts` 资产加载，合并 `src/subagent/address.ts` 与 `src/ipc/` 路径计算）。
   - 收敛 `watchSubagentBudget` 至 `SubagentRuntime`，清理内部重复校验与无意义的 `deepFreeze` / `cloneValue`，在进程退出/shutdown 时清理 `#temporaryResults`。
   - 更新测试引用并跑通全套 `npm run check`。
