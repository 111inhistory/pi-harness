# Preset／Routing TOML 迁移、共享 Classifier 与 Hook 架构演进提案

本提案记录三项关联演进的定稿架构、模块边界、约束与分阶段实施切片：

1. **Phase 1**：`presets.json` 与 `subagent-routing.json` 迁移至 TOML（可先独立交付）；
2. **Phase 2**：在 `harness.json` 引入共享 `classifier.models` 候选列表与 `src/classifier-client.ts`，同时从 `subagent-routing.toml` 移除旧 `[classifier]` 字段并升至 `version = 4`；
3. **Phase 3**：基于中性 `ToolObservation` 事实源、Capability 窄内部端口与三层 `hookId` Map，按 5 个可独立验收切片落地 Main Hook、defer 分类器、单条 Hook 全局单调 deadline、安全切片投影与脱敏 Stats。

各阶段实施后，同步更新[接口契约](../interface-contract.md)、[Harness 配置](../harness-configuration.md)、[当前架构](../architecture.md)、[Capability 提示词与分支记忆](../capability-prompt-memory.md)及[测试说明](../testing.md)。

---

## 1. 协作基线与集成顺序

- **主 checkout 基线**：当前主工作区 `HEAD` 为 `51987a1`，其上 14 项未提交改动属于已验证的 Pi SDK 1.6.1 升级，单独成提交，不与 TOML 迁移混装。
- **Phase 1 独立分支**：从干净 `51987a1` 在 `/code/.worktree/` 创建独立 worktree 与分支，基于原锁定 SDK 独立通过 `npm run check`。
- **依赖锁定集成**：两条线均会修改 `package.json` 与 `package-lock.json`；集成时基于最终 `package.json` 重生成 `package-lock.json`，并在 Pi 1.6.1 上复跑全量 `npm run check`。
- **活会话隔离**：实施过程不改动正在运行的 Pi 进程所用 launcher 与 `node_modules`，也不并行覆盖主 checkout。
- **Phase 3 切片顺序**：按强依赖顺序分 5 片推进与验收，前一片不得引用后一片模块：
  1. **Slice 3A**：中性 `ToolObservation` 事实源（含 Codemode 原生 `details` 类型化事实与真实 SDK 验证）；
  2. **Slice 3B**：Capability 窄内部端口（含跨轮／代次围栏）；
  3. **Slice 3C**：Main 机械 Hook、三层配置加载、`turn-tracker`／`repeat` 与 Preset `contentHash` 冻结；
  4. **Slice 3D**：后台 Classifier、defer 消费、单条 Hook 单调 deadline 超时与安全切片投影；
  5. **Slice 3E**：脱敏 Stats（纯事实订阅，不参与提交）。

---

## 2. Phase 1：Preset 与 Subagent Routing 迁移至 TOML

### 2.1 依赖与零回退原则

- 引入直接精确依赖 `"smol-toml": "1.9.1"`（零传递依赖，要求 Node >= 18，满足仓库 `engines.node >= 22.19.0`）。
- 遵循仓库零兼容性回退原则：生产加载器（`src/preset/config.ts`、`src/subagent/routing.ts`、`src/subagent/root-service.ts`、`extensions/preset.ts`）只读取 `.toml`，不保留运行期 `.json` 回退逻辑。
- `scripts/check-json.mjs` 保持只校验 JSON；仓库内两份示例文件 `config/presets.toml` 与 `config/subagent-routing.toml` 由生产 loader／validator 的既有测试覆盖，不额外新增 `check-toml` 脚本（后续 TOML 样例增多时再评估）。

### 2.2 `presets.toml` 结构

- **路径**：全局 `<agentDir>/presets.toml` 与受信项目 `<cwd>/.pi/presets.toml`；项目同名项整体覆盖全局项。
- **顶层映射**：直接采用顶层 `[<name>]`（不包裹 `[presets.<name>]`，不虚构文件级 `version` 元数据）。名称含点或空格时使用 TOML 引号键（如 `['fast.v2']`）。
- **字段语义与现 schema 一致**：`description`、`model`（`provider`、`id`）、`thinkingLevel`、`tools`、`codemode`（`mode`）、`instructions`（天然支持多行字符串 `"""..."""`）。Phase 3 的 Preset 级 Hook 表直接挂在 `[<name>.hooks.<hookId>]` 下。

```toml
[fast]
description = "日常模型配置（示例，使用合成占位数据）"
thinkingLevel = "medium"
tools = ["+codemode", "-bash"]
instructions = """
该模型的专属调用指引（示例）。
"""

[fast.model]
provider = "fake-provider"
id = "fast-model"

[fast.codemode]
mode = "only"
```

### 2.3 `subagent-routing.toml` 结构（Phase 1 保持 `version = 3`）

- **路径**：`<agentDir>/subagent-routing.toml`。每次新建 Fresh Subagent 仍实时重读 `subagent-routing.toml` 与 `presets.toml`；仓库 `config/subagent-routing.toml` 仅作模板，不作运行期回退。
- **结构**：Phase 1 保持 `version = 3` 与 `[classifier]`，保持 `[[roles]]` 数组顺序，各角色下为 `[roles.candidates]`。候选值为字符串（命名 Preset）或子表 `[roles.candidates.<label>]`（遵循同一 Preset schema 的临时定义）；label 含点时显式加引号（例如 `[roles.candidates.'model.v2']`）。

```toml
version = 3

[classifier]
provider = "fake-provider"
id = "fake-classifier"

[instructions]
role = "..."
model = "..."

[[roles]]
id = "executor"
instructions = """
...
"""

[roles.candidates]
primary = "fast"

[roles.candidates.'deep.v2']
description = "..."
thinkingLevel = "high"
tools = ["-grep", "+msg_write"]

[roles.candidates.'deep.v2'.model]
provider = "fake-provider"
id = "deep-model"
```

### 2.4 Phase 1 离线迁移脚本

- 位于 `scripts/`（通过 `npm run` 暴露），专责离线转换用户现有的 `presets.json` 与 `subagent-routing.json`，**不触碰会话 JSONL 与 `harness.json`**。
- **默认 dry-run**：仅校验并展示转换结果；显式传入 `--apply` 时使用 `wx` 标志写入目标 `.toml`（目标已存在即拒绝覆盖），原 `.json` 保留不删。
- **等价性校验流水线**：`JSON.parse` → 生产 validator 校验 → `smol-toml` `stringify` → `smol-toml` `parse` → 生产 validator 再次校验 → 规范化对象深度比对一致后才允许写出。
- **必测边界**：多行文本、非 ASCII（中文等）、含点／空格键名、`[[roles]]` 数组顺序、命名引用与临时内联候选混用。

---

## 3. Phase 2：共享 `classifier.models` 与 `src/classifier-client.ts`

### 3.1 `harness.json` 配置扩展与 `subagent-routing.toml` v4

- `harness.json` 新增顶级 `classifier` 段（跟随 root config 快照；reload 或会话切换生效，单个 Job／批次内保持同一列表）：

```json
"classifier": {
  "models": []
}
```

  每项为 `{ "provider": string, "id": string }`（非空字符串、拒绝未知字段），默认空数组 `[]`；跨全局／受信项目层采用整表覆盖（与 `capability.lazySchemas` 一致）。
- `subagent-routing.toml` **删除 `[classifier]` 字段并将 `version` 升至 `4`**（严格单一 schema，无 v3 运行期回退）。当 `classifier.models` 为空时，Fresh 路由直接返回明确配置错误。

### 3.2 Phase 2 离线迁移脚本（冲突与恢复契约）

- **定位与入口**：停机、无并发编辑前提下的离线工具（`scripts/migrate-routing-v4.mjs` + 薄库 `scripts/lib/routing-v4-migration.ts`，`npm run migrate:routing-v4`），首版仅暴露 `--agent-dir <dir>`；默认 dry-run，显式 `--apply` 才落盘。明确声明不承诺并发修改或断电下的双文件原子事务。
- **生产校验复用（零 schema 复制）**：脚本仅在离线侧校验 `version === 3` 与 `[classifier]` 形状，拆出 `classifier` 并置 `version = 4` 后，余下整对象直接交由生产 `validateRoutingConfig` 校验，并做 `stringify → parse → validateRoutingConfig` 深度等价比对；`harness.json` 稀疏保留原字段（不展开 `DEFAULT_HARNESS_CONFIG`），修改后过生产 `resolveHarnessConfig` 并严格拒绝任何异常或回退诊断。
- **全量预检与冲突拒写（任一命中即零写入、零备份退出）**：
  - 用 `lstatSync` 拒绝源／目标／备份路径上的 symlink 与非普通文件；任一待创建备份（`*.pre-routing-v4`）已存在时拒绝覆盖；
  - `subagent-routing.toml` 已是合法 v4：若 `harness.json` 合法且 `classifier.models` 非空，报告 `unchanged` 退出 0；若 `harness.json` 缺失或 `classifier.models` 为空，按不完整状态报错拒绝；
  - `harness.json` 已有非空 `classifier.models`：仅**精确单元素一致**（`models.length === 1` 且 `provider`/`id` 与 v3 `[classifier]` 相同）时视为已对齐并跳过重写／备份 `harness.json`；其余任何差异（不同模型或多候选列表）立即冲突报错停机，不静默覆盖或合并；
  - `harness.json` 缺失或 `classifier.models` 缺省／`[]` 时正常迁入单元素 `[X]`；
  - 写入前再次核对既有输入文件字节与预检原文一致，防止并发漂移。
- **写入顺序、备份保留与非原子恢复**：
  - **固定先落盘 `harness.json`、再替换 `subagent-routing.toml`**：若第二步失败，磁盘保留 `harness.json = [X]` 与完整 v3 路由，不会丢失原 `[classifier]`。
  - 仅对将修改的既有文件以 `wx` + `0600` 写入字节精确备份（`*.pre-routing-v4`）；新建 `harness.json` 时不为其建备份，按 `createdByUs` 区分本次 `wx` 写残片与 `EEXIST` 竞争者，绝不误删竞争者文件；既有目标先同目录暂存 `.tmp` 核验字节后再 `renameSync`，失败时清理本次未用 `.tmp`。
  - **恢复指引**：所有 shell 命令做安全单引号转义，绝不指导删除原始备份；半落地时保留 `harness.json.pre-routing-v4`，指引将同字节的 `subagent-routing.toml.pre-routing-v4` 另存／挪走后续跑，或先完整手动回滚再重跑；提醒关闭旧 v3 Pi 会话并在迁移后重启 Pi 以刷新 `harness.json` 缓存。

### 3.3 共享执行器 `src/classifier-client.ts`

先以单文件 `src/classifier-client.ts` 落地，待第二个真实消费者（Hooks）接入时再按需抽取薄端口，不提前分层。

- **输入契约**：有序候选列表 `models`、`ModelRegistry`、`ClassifierContext`、`signal`、绝对单调 `deadlineMs`、物理尝试扣费钩子 `debitAttempt`（含总尝试上限）、调用方单候选重试策略。
- **唯一重试与扣费层**：对 SDK 调用固定传入 `maxRetries: 0`，`src/classifier-client.ts` 是唯一的重试与候选晋级层。
- **免费预检边界（核对 Pi SDK `model-registry.js`）**：
  - 仅 `registry.findOfType('classifier', provider, id) === undefined`（`not_in_catalog`）允许免费跳过（不调用 `debitAttempt`，但仍计入总耗时 deadline）。
  - **禁止**以 `!registry.hasConfiguredAuth(model)` 作为免费跳过条件：SDK `getApiKeyAndHeaders` 在无鉴权配置且 `!compatibility.authHeader`（如本地免鉴权 endpoint）时仍返回 `ok: true`；亦**禁止**在预检阶段调用会触发动态登录或刷新凭据的 API。
  - 凡进入 SDK `registry.classify()` 的实际尝试，**入口处立即执行一次 `debitAttempt`**（SDK 内部认证解析与 HTTP 并非两个可独立观测阶段）。
- **错误分桶与候选晋级规则**：
  - `not_in_catalog`：不扣费，直接试下一个候选。
  - `aborted`／`deadline_exceeded`／`budget_exceeded`：立即终止，**绝不晋级下一个候选**。
  - `transient`：复用 SDK `isRetryableAssistantError` 判定；仅在当前候选按策略耗尽重试次数且仍有剩余预算与 deadline 时，晋级下一个候选。
  - `unavailable`（401／403／404 或 auth-missing）：**仅当 SDK 暴露真实结构化错误信号时才归为此桶并晋级**；SDK 未暴露结构化信号时按原失败处理并 fail closed，**绝不对任意错误字符串做正则猜测**。
  - `stop` 畸形答案、协议错误、上下文错误、未知错误：**fail closed**，绝不晋级下一个候选。
- **答案校验与返回值**：
  - 答案合法性由各调用方按题型自行校验（Routing 校验 `choice` 概率与 argmax；Hooks 按规则校验 `bool`／`score`／`choice`）。
  - 执行器返回命中候选 `{ provider, id }`、原生 `ClassifierResult` 与脱敏 `attempts` 列表（每项仅含 `provider`、`id`、`bucket`、`durationMs`、`usage`；原始错误文本仅保留在当前诊断对象中，不进入持久 Stats）。
- **调用方策略分离（不互相引用）**：
  - **Subagent Routing**：保留现有 `subagent.routingRetry`（指数退避 + jitter）与 Job 预算扣费；两道逻辑题（`role`、`model`）共享同一 Job 预算与总时间限制（总时间含退避、认证与全部候选）。
  - **Hooks（首版）**：每候选最多 1 次物理尝试，无跨候选长退避，受单条 Hook 单调 deadline 与单 turn 物理尝试上限约束。

---

## 4. Phase 3：ToolObservation、Hook 架构、Defer 分类器与 Stats

### 4.1 Slice 3A：中性 `ToolObservation` 事实源（`src/tool-observation.ts`）

- 归属中性工具观测模块 `src/tool-observation.ts`，不承载任何 Hook 或 Stats 业务策略。
- **Live 数据来源**：以 SDK 已执行的 `tool_result` 事件及其父 `toolCallId` 为实时事实源。
- **Codemode 集成边界（`src/capability/codemode.ts`）**：Codemode 仅在自身原生结果 `details` 中提供类型化嵌套调用事实（call ID、工具名、状态、耗时、受控摘要元数据），**不手工重发嵌套 `tool_result` 事件**。
- **去重与恢复**：顶层与嵌套事实按 call ID 去重；从磁盘恢复旧分支时，历史 Codemode 记录若缺少类型化嵌套事实，标记为 `unknown`（持久摘要记录延后至实际需求验证后再评估）。

### 4.2 Slice 3B：Capability 窄内部端口与装配边界

- **禁止隐式耦合**：不把 Hook 策略写入 `src/capability/extension.ts` 或 `extensions/preset.ts`，也不依赖扩展注册顺序或跨 `ExtensionAPI` 的 `WeakMap`。
- **显式端口注入**：`capabilityExtension(pi)` 返回窄内部端口，显式提供当前目录／活跃工具只读视图，以及 **`activate`** 与 **`discover`** 两类受控写入能力（均受 branch lease／代次围栏与 `AbortSignal` 约束）。`extensions/capability.ts` 在调用 `capabilityExtension(pi)` 拿到该端口后，直接装配 `installHookSurface(pi, { capabilityPort })`。
- 若未来需要支持在禁用 Capability 扩展时仍单独运行纯 Hook，再在统一会话装配层以显式可选端口注入。

### 4.3 Slice 3C：三层配置、Preset 快照哈希与机械 Hook 运行时

#### 三层统一 `hookId` Map 与确定性求值顺序

Global、Preset、Trusted Project 三层采用同一套以 `hookId` 为键的表结构，覆盖优先级固定为 **`Global < Preset < Project`**（同名 `hookId` 由高优先级层整体覆盖；停用某条规则只需写 `enabled = false`）：

- **Global**：`<agentDir>/hooks.toml` → 顶层 `[<hookId>]`
- **Preset**：`presets.toml` → `[<presetName>.hooks.<hookId>]`（名称含点时加引号，如 `['fast.v2'.hooks.'ds-prefer-read']`）
- **Trusted Project**：`<cwd>/.pi/hooks.toml` → 顶层 `[<hookId>]`

约束：

- 不使用 `[[<name>.hooks]]` 数组表，不在规则表内重复声明 `id` 字段，不引入 `rules` 包装层或 Preset 级默认配置块。
- **求值与执行顺序**：合并后的有效规则严格按 **`hookId` ASCII 字典序**执行。
- 仅单条规则内的 `actions` 为数组。
- **`when` 三值逻辑与安全辅助函数**：`when` 表达式按三值逻辑求值（`true`／`false`／`unknown`；缺失历史嵌套事实等不可判定输入返回 `unknown`，仅 `true` 视为命中）。内置受控只读辅助函数（不执行外部命令、不依赖易错裸正则）：
  - `shellStandalone(cmd, verbs)`：匹配顶层非管道段的独立 POSIX 简单命令；
  - `shellHasCommand(cmd, verbs)`：同时检查顶层管道各段；`verbs` 列表仅允许字面量（例如对 `git diff | head`，`shellStandalone` 与 `shellHasCommand` 分别为 `false`／`true`）；遇到动态或未支持的 shell 语法，或超出解析预算时，均返回 `unknown`；
  - `inWorkspace(path)`：仅按 `cwd` 做词法路径包含判定（不做磁盘或符号链接 I/O）。
- **`repeat` 节流三字段**：`repeat = { maxTriggers?, cooldownTurns?, resetOnCompaction? }`。配置多项时，触发次数与冷却轮数须**同时满足**；仅在压缩成功时同时重置两项计数；只配置 `resetOnCompaction = true` 而未指定 `maxTriggers` 或 `cooldownTurns` 视为非法配置。
- **Observe-only 语义**：通过“无匹配动作（未配置或空 `actions`）”自然表达，不新增独立 `shadow` 布尔开关。Observe-only 规则命中后**不消耗 `repeat` 预算**，但若触发分类器，仍消耗物理尝试与并发预算。

#### Preset 快照与 `presetContentHash`（零兼容分支保持 v2 哈希一致）

- 当 Preset 声明了非空 `hooks` 时，将规范化后的 `hooks` 对象冻结进 `preset-state` v2 `PresetSnapshot`，并纳入 `presetContentHash`（修改 `presets.toml` 中的 hooks 后，`/preset` 可直接识别为 `outdated`）。
- 当 Preset 未配置 `hooks` 或 `hooks` 为空时，`PresetSnapshot` 与 `presetContentHash` payload 中统一**省略（absent）**该字段，与现有 v2 快照保持逐字节一致的哈希值，不引入任何旧版兼容分支。

#### Turn 暂存、Branch Lease 与同步边界

- Hook 域（`src/hooks/`）区分两类租约与有界状态：
  - **Turn 级暂存**：`turn-tracker`、批内计数、本轮物理分类器尝试计数与待消费的 passive `injectHint` 队列；
  - **Branch 级租约（branch lease）**：分支级 `repeat` 状态、单飞租约以及异步 `activate`／`discover` 提交归属。
- **分界撤回**：
  - `agent_settled` **仅撤回 turn 暂存**（推进 turn 代次，丢弃未消费的 passive `injectHint`），不撤回仍属当前分支的 branch lease；
  - `session_before_switch`、`fork`、`session_tree` 与 `session_shutdown` **撤回 branch lease** 及全部分支／turn 暂存，并推进分支代次围栏。
- 同步 `when` 求值与投影按输入大小、条件节点数、规则数与动作数施加确定性容量上界；在动作前后检查单调时钟（明确 JS 同步计算不可在表达式中途硬抢占）。

### 4.4 Slice 3D：Defer 分类器、单条 Hook 单调 Deadline 与安全切片投影

#### 异步动作分流：`injectHint` Passive 队列 vs `activate`／`discover` Branch Lease

- **异步 `injectHint`（走 passive turn 队列）**：仅在同一 `turn`、同一 `branch`、同一代次的**后续顶层 `tool_result` 边界**消费；若本轮无后续顶层 `tool_result` 边界即结束（`agent_end`／`agent_settled`），或进入新 turn／切分支，待投递提示**直接丢弃**，不以 `steer` 或合成消息兜底。
- **异步 `activate` 与 `discover`（走 branch lease）**：不绑定单个 turn；即使原触发 turn 已经 `agent_settled`，只要仍在同一 branch、branch lease 有效且未超 deadline，可**静默提交**到当前分支状态与活跃工具集，**绝不触发 wake 或发起新一轮模型调用**。发生 `session_before_switch`／`fork`／`session_tree`／`session_shutdown` 后立即失效并丢弃。
- **提交前复核**：无论是 `injectHint` 消费还是 `activate`／`discover` 提交，落地前均须重新核对四项不变量：**规则内容哈希**（与当前生效配置／Preset 快照一致）、**对应租约**（`injectHint` 核对 turn + branch 租约，`activate`／`discover` 核对 branch lease）、**`repeat` 预算**以及**单调 deadline**；任一不满足即丢弃并记录对应状态（`stale`／`timeout`／`suppressed`）。

#### 单条 Hook 全局单调 Deadline（`hooks.timeoutMs`）

- `harness.json` 新增 `hooks.timeoutMs`，试点默认 **`5000` ms**；单条规则可配置更小的 `timeoutMs`（仅允许收紧，不可超过全局上限）。
- **单一计时起点与全程共享**：从单条 Hook 规则命中并获准处理起，计算一个绝对单调 `deadline`；该 `deadline` 贯穿候选分类器遍历、已接受的后台 `discover` 以及等待投递到最终提交的全链路，**不在任何 action 或子请求处重新计时**。
- **`discover` 共享同一上限**：首版不增设第二套 Hook discovery timeout 旋钮。若部署启用了后台 `discover` 且需要更长时间，由配置者调大全局 `hooks.timeoutMs`。同时，Capability 自身的 `capability.budget` 仍是独立硬围栏，实际终止时刻取 `min(hookDeadline, capabilityBudget)`。
- **超时与资源围栏**：超过 `deadline` 立即记 `timeout`／`stale` 并调用 `AbortController.abort()` 取消底层 SDK／discover 调用，不回滚已持久化的动作。**single-flight 锁与异步并发槽必须持有至底层操作实际 settle 并完成清理后才释放**，严禁借助 `Promise.race` 提前放锁导致重入并发。

#### 并发与尝试限额（试点默认，暂不暴露全部配置旋钮）

- 每会话 `maxConcurrentAsyncHooks = 2`；
- 每 turn 物理分类器尝试上限 = `4`（跨候选、按每次 `debitAttempt` 计）；
- 不做排队：并发槽或 turn 尝试预算耗尽时，新命中直接记 `suppressed`；
- 首版不做跨规则事件聚合预算。

#### 安全切片投影（Slice Projection）

- **硬总上限**：**16 KiB UTF-8**（含最终序列化开销）。
- **默认白名单（零正文）**：默认仅发送结构与枚举元数据——`model`、`preset`、`tool`、`nested` 摘要、枚举状态与计数。文本正文与工具目录必须显式 **opt-in**。
- **试点分段上限**（后续结合样例与压测校准，不一次性暴露全部旋钮）：
  - `recentInputs`：opt-in，默认最多 `N = 3` 条，单条 `<= 1 KiB`；
  - `recentTools`：最多 `K = 6` 条，`preview <= 256 B`；
  - `prompt`／`result`：各 `<= 2 KiB`；
  - 工具目录列表：每列表 `<= 32` 项，单条 `description <= 160 B`；
  - 任何字段发生截断均显式附加 `clipped` 标记（遵循 `LESSONS.md` L008）。
- **字段拒绝优先于正则脱敏**：
  - 分类器输入仅接受枚举与显式白名单字段，**禁止**传入工具 JSON Schema、图片、任意 custom payload、路径凭据；
  - `bash`／`codemode`／MCP 工具参数默认不传；
  - 显式提示配置者：开启文本类字段 opt-in 后，系统无法保证文本不含敏感信息，且该文本会发送至候选分类器供应商。

### 4.5 Slice 3E：脱敏 Stats

- 仅订阅中性工具事实与 Hook 执行事件，绝不参与条件判定、预算扣费或动作提交。
- 仅记录常量 `hookId`、有限枚举标签／状态桶（如 `matched`、`committed`、`suppressed`、`timeout`、`stale`、`failed`）、耗时与 token `usage`。
- **严禁记录**提示词正文、工具参数、工具返回正文或供应商原始错误字符串。

---

## 5. 各阶段验收清单

| 阶段／切片 | 交付物 | 验证要点 |
| --- | --- | --- |
| **Phase 1** | `smol-toml@1.9.1`、`presets.toml`／`subagent-routing.toml` 加载器与校验、`config/*.toml` 模板、离线迁移脚本、文档与测试 | 独立 worktree 过 `npm run check`；迁移脚本覆盖多行／非 ASCII／点号键／数组顺序／`wx` 不覆盖／round-trip 规范比对；无 JSON 运行期回退 |
| **Phase 2** | `harness.json` `classifier.models`、`src/classifier-client.ts`、`subagent-routing.toml` v4、双文件离线迁移脚本 | 免费跳过仅认 `not_in_catalog`；免鉴权本地模型不被 `!hasConfiguredAuth` 误跳；`maxRetries: 0` 单点 debit；transient 耗尽晋级、结构化不可用晋级、畸形 `stop`／abort／预算 fail closed；双文件迁移覆盖稀疏保留／缺失新建／精确一致跳过／冲突零写入拒停／symlink 与备份保护／写前漂移复核／半失败注入回滚与续迁 |
| **Slice 3A** | `src/tool-observation.ts`、Codemode 原生 `details` 类型化事实 | 真实 SDK `tool_result` 与 Codemode 嵌套 call ID 去重、不重发事件、旧历史缺失标记 `unknown` |
| **Slice 3B** | Capability 窄内部端口（`activate`、`discover` 与只读视图）与 `extensions/capability.ts` 显式装配 | branch lease／代次围栏隔离晚到回调、`AbortSignal` 取消后资源围栏保持至 settle |
| **Slice 3C** | 三层 `hooks.toml`／Preset hooks（`Global < Preset < Project`、ASCII `hookId` 序、`when` 三值逻辑、安全 shell 辅助函数、`repeat` 三字段）、`turn-tracker`、`presetContentHash` 冻结 | 空／无 hooks 与旧 v2 hash 逐字节一致；非空 hooks 变更触发 `outdated`；`agent_settled` 仅清 turn 暂存，切换／fork／tree／shutdown 撤 branch lease；Observe-only 不扣 `repeat` |
| **Slice 3D** | 异步 `injectHint` passive 队列、`activate`／`discover` branch lease 静默提交、`hooks.timeoutMs` 单调 deadline、并发与 turn 尝试上限、16 KiB 安全切片 | 仅异步 `injectHint` 限同 turn+branch 顶层 `tool_result` 消费、无边界丢弃不 steer；`activate`／`discover` 在 `settled` 后凭有效 branch lease 静默提交且不 wake；timeout 立即 abort 且锁持有至真实 settle；`discover` 取 `min(hookDeadline, capabilityBudget)`；切片硬上限 16 KiB 与 `clipped` 标记 |
| **Slice 3E** | 脱敏 Stats 订阅器 | 仅含常量 ID／状态桶／耗时／usage；不泄漏正文、参数或原始错误；不干扰提交路径 |
