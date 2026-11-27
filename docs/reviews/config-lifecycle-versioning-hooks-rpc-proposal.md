# 配置存储版本化、生命周期统一、叶子刷新与 Hook 只读 RPC 提案

本提案记录 Phase 4（基线提交 `ef8bcb2`）的定稿架构、配置版本化契约、作用域收紧规则、统一生命周期原语、竞态闭环矩阵、测试策略与原子提交边界。本提案尚未实施；实施完成后，同步更新[接口契约](../interface-contract.md)、[Harness 配置](../harness-configuration.md)、[当前架构](../architecture.md)及[测试架构](../testing.md)。

---

## 1. 目标与非目标

### 目标
1. **显式配置版本化与标准化磁盘原语**：为 Harness 自有 4 份顶层配置文件建立统一版本演进规则、纯函数存储原语（路径、可插拔 serializer codec、独立版本校验）与离线迁移工具。
2. **收紧配置作用域边界**：禁止项目层覆盖本机安全防线、分类器候选、硬件资源与底层引擎调优项；项目层 `capability.blacklist` 改为按全局优先顺序去重并集追加。
3. **统一会话配置生命周期内核**：抽出零业务、零 UI 依赖的宿主共享 `ConfigLifecycle`，统一 `harness.json`、`hooks.toml`、`shell.approval.ruleFiles` 与 Shell 环境配置缓存的生命周期与确定性释放。
4. **叶子配置显式轻量刷新**：提供根级 `/config reload` 命令，对 `hooks.toml` 与 `shell.approval.ruleFiles` 执行逐槽事务刷新，不触碰重型 `/reload`。
5. **分支级 Hook 静音与命令收口**：通过独立分支 delta 记录支持按 `hookId` 静音与恢复，命令统一收为 `/hooks stats|mute|unmute|reset`（直接替换 `/hook-stats`）。
6. **Hook v1 只读 RPC**：经单一跨扩展只读端口新增 `hooks.current` 与 `hooks.stats`，同步生成 v1 协议资产。

### 非目标
- 不引入 `fs.watch` 热监听或 `stat` 自动感知刷新；
- 不将整份 `harness.json` 动态化（避免 `RootService`、`SubagentRuntime` 与 `Capability` 产生混代）；
- 不造通用 `BranchSlot` 或强行把各域分支记录合并为单一 KV（保留各域独立 `customType`、回放算法、优先级与 compaction 语义）；
- 不在 v1 RPC 中开放配置写盘、规则写入或刷新写方法；
- 不为外部 Shell 静态规则文件、Pi 原生 `settings.json` 或 Preset 内嵌 `hooks` 块强塞独立 `version`。

---

## 2. 配置存储与显式版本化

### 2.1 存储原语（`src/config-storage.ts`）

`src/config-storage.ts` 保持纯函数形态，零业务与 SDK 运行时依赖，只提供 3 个窄原语：

1. `configPaths(location, filename, scope)`：按 `{ agentDir, cwd, projectTrusted }` 与 `scope: 'global-only' | 'global-and-project'` 输出规范层路径列表 `readonly { scope: 'global' | 'project', path: string }[]`；项目层仅在 `projectTrusted === true` 时返回。
2. `readConfigDocument(filePath, codec, read?)`：支持 `codec: 'json' | 'toml'` 与可选测试 `read` 注入，不吞 I/O 或目录错误，返回 4 态判别联合体：`missing`、`ok(value, text)`、`read_error(error)`、`parse_error(error)`。
3. `requireConfigVersion(value, expected)`：校验根值为非数组普通对象且 `version === expected`，成功返回 `{ ok: true, body }`（已剥离 `version` 键）；失败返回 `{ ok: false, reason: 'not_object' | 'missing_version' | 'unsupported_version', expected, actual? }`。

各领域模块仍拥有各自的版本号、缺文件策略（如 `subagent-routing.toml` 缺失即报错）、合并语义及错误呈现方式。双层配置文件在每层合并前各自独立校验并剥离 `version`；已存在文件缺失或错配 `version`（含空 TOML、空 JSON 对象）一律拒绝。

### 2.2 版本演进规则（唯一判定不变量）

仅承诺**单向向后兼容**（新程序读取同版本旧文件）；因全仓严格拒绝未知键，不承诺旧程序读取新文件。判定是否升版的唯一不变量如下：

> 任意一份在当前版本下合法的旧配置文件，在新程序下是否仍能被合法读取且按原义解释？

- **是（不升版）**：新增带默认值的可选键；仅拓宽已有键的允许值域（如枚举增项、新增 `action.type`）。
- **否（必须升版并配 `scripts/` 离线迁移）**：新增无默认值的必填键；删除或重命名已有键；改变已有键的类型、语义、合并规则或收紧作用域；改变文件根结构。

生产加载器只接受当前单一主版本，不保留旧版静默回退。

### 2.3 四份顶层配置文件契约

| 文件 | 目标版本 | 根结构与变更 |
| --- | --- | --- |
| `harness.json` | `version: 1` | 保持 JSON（已由 `codec` 解耦）；直接落第 3 节收紧后的作用域语义，避免刚升 1 即 1→2 |
| `presets.toml` | `version = 1` | 改为容器表 `[presets.<name>]`（未知顶层键判 `invalidDocument`）；内嵌 `[presets.<name>.hooks.<id>]` 不另加 `version`；保持按需直读 |
| `hooks.toml` | `version = 1` | 改为容器表 `[hooks.<id>]`（缺 `[hooks]` 视为空表）；避免未来新增顶层可选键与用户 `hookId` 冲突 |
| `subagent-routing.toml` | `version = 4` | 保持 v4 不动；可复用只读 I/O，不改变既有离线 validator 契约；保持按需直读 |

### 2.4 离线迁移 CLI（`scripts/migrate-config-v1.mjs`）

- 统一 CLI 入口，各格式转换函数相互独立；默认 `dry-run`，正式写入（`--apply`）前执行完整 preflight。
- 备份文件采用排他创建（不覆盖已有备份），并在输出中明确声明非多文件原子事务。
- 若 `.pi/harness.json` 包含 Global-only 字段，报告具体违规键并阻止写入，不应自动删除，也不应自动搬迁到全局配置以防私自扩大作用域。
- 同步核对仓库已有离线迁移工具（如 `scripts/migrate-config-toml.mjs`）的输出，确保产物符合 v1 生产加载器要求。

---

## 3. 配置作用域收紧（`src/harness-config.ts`）

`HarnessConfigLayer` 增加 `scope?: 'global' | 'project'`（默认 `'global'`；读取 `.pi/harness.json` 时传 `'project'`）：

- **Global-only 拒绝列表**（项目层出现顶层键、任意嵌套子路径或空对象 `{}` 均抛 `HarnessConfigError`）：
  - `classifier`（含 `classifier.models`）
  - `shell.approval`（含 `enabled`、`mode`、`command`、`ruleFiles`、`commandTimeoutMs`、`manualTimeoutMs`、`notificationUrl`、`reviewer.*`）
  - `btw`（含 `btw.panelMinRows`）
  - `codemode`（含 `memoryLimitBytes`、`defaultMaxOutputTokens`）
  - `capability.search`（含 `bm25`、`limits`）
  - `subagent.routingRetry`、`subagent.inheritedToolWaitMs`
- **项目层允许项保持不变**：`shell.preflight`、`shell.autoBackgroundAfterMs`、`shell.maxForegroundWaitMs`、`hooks.timeoutMs`、`subagent.maxDepth`、`subagent.maxActive*`、`subagent.budgetsByDepth`、`subagent.prompts`、`capability.noSelectionLimit`、`capability.pruneOnCompaction`、`capability.budget`、`capability.lazySchemas`（保持整表替换）。
- **`capability.blacklist` 并集追加**：项目层改为按全局优先顺序去重并集追加（项目层写 `[]` 保留全局列表不变）；用户显式分支 `blacklist remove` 语义保持独立。

---

## 4. 统一配置生命周期内核（`src/config-lifecycle.ts`）

### 4.1 宿主共享与类型安全 Token

- 通过既有同步 `pi.events` 握手（`pi-harness:config-lifecycle`）在同宿主多 `ExtensionAPI` 间共享唯一 `ConfigLifecycle` 实例，不额外叠加 `WeakMap` 快路；子会话继续通过 `harnessConfigFor(pi, fixed)` 持有固定快照。
- 各领域模块创建模块级类型安全 Token（`createSyncSlotToken<T>(spec)` / `createAsyncSlotToken<T>(spec)`），宿主按 Token 引用在 `Map` 中幂等存储，避免任意字符串 ID 造成泛型冲突。
- 各消费扩展在初始化期先完成零 I/O `bindSyncSlot` / `bindAsyncSlot` 绑定，并在自身注册 `pi.on('session_start', ...)` 前获取 `configLifecycleFor(pi)`，保证：
  1. 生命周期清空早于业务 `session_start`；
  2. 冷会话首轮前执行 `/config reload` 时已覆盖全部已安装的可刷新叶子。

### 4.2 槽位契约与失效边界

- 同步槽（`harness`、`hooks`、`shell-env`）与异步槽（`shell-rule-files`）分离，统一返回 `SlotSnapshot<T> = { value, revision }`。
- 缓存作用域键为 `(sessionEpoch, cwd, projectTrusted[, extraKey])`：
  - `session_start` 与 `session_shutdown` 递增 `sessionEpoch` 并清空全部槽位缓存与 in-flight 映射（释放外层引用，不宣称底层异步读盘已退出）；
  - `session_tree` 在同 `(cwd, projectTrusted)` 下**不触发磁盘重读**（各领域自行清理分支投影与 lease）；
  - `(cwd, projectTrusted)` 变化视为新权限边界，绝不沿用旧槽位。
- 叶子等价比较由各域通过 `equals` 自行判定（校验通过后仅保留已验证来源字节的 SHA-256 摘要，不滞留原始配置文件正文）。
- `refreshLeaves(ctx)` 执行**逐槽事务刷新**：
  - 仅遍历 `refreshable: true` 的已绑定叶子（`hooks.toml`、`shell.approval.ruleFiles`）；
  - `shouldRefresh(ctx) === false`（如审批未启用或无 `ruleFiles`）返回 `skipped` 且零 I/O；
  - 校验失败时，若同边界下存在有效旧值则保留旧值并报 `failed (keptPrevious: true)`，若无有效旧值或刚跨权限边界则 fail-closed；
  - 校验通过且 `equals` 为真返回 `unchanged`（保留旧 `revision`），否则原子发布新 `revision` 并报 `updated`。

### 4.3 四处消费者接入

| 模块 | 槽位 | 刷新与释放变化 |
| --- | --- | --- |
| `src/harness-config.ts` | `HARNESS_SLOT`（sync，`refreshable: false`） | `harnessConfigFor(pi)` 包装该槽位；现有调用方零改动 |
| `src/hooks/extension.ts` | `HOOK_LAYERS_SLOT`（sync，`refreshable: true`） | 移除私有 `layerContext`；按 `layersRevision` 在轮边界重建 `branchState`；`hooks.current` 共用同槽 |
| `src/shell-approval/extension.ts` | `SHELL_RULE_FILES_SLOT`（async，`refreshable: true`）与 `SHELL_ENV_SLOT`（sync，`refreshable: false`） | 移除手写 `ruleSources` 与永不清 `configurationCache`；`session_shutdown` 补清 `mode` |
| `extensions/harness.ts` | 根组合入口注册 `/config reload` | 仅根宿主注册一次，调 `refreshLeaves(ctx)` 汇报逐槽结果；生命周期模块本身不拥有 UI |

---

## 5. Session／Branch 边界、命令收口与 Hook v1 只读 RPC

### 5.1 分支回放与 `/hooks` 命令收口

- **严格分离分支代次与叶游标**：`branchEpoch` 管异步写授权（`session_before_tree/switch/fork` 立即撤销 lease，取消导航后旧分支须重新取新 lease），`leafId` 仅用于同分支 append 的增量后缀推进，不作通用缓存键或异步租约。
- **分支级 Hook 静音**：新增独立 `HOOK_OVERRIDE_RECORD = 'harness-hook-override'`，以 delta op（`{ version: 1, op: 'mute' | 'unmute', id }` 与 `{ version: 1, op: 'reset' }`）记录本分支静音集合。`unmute` 与 `reset` 只清除本分支静音记录，绝不复活 TOML 的 `enabled = false`。
- **命令收口**：统一提供 `/hooks stats|mute|unmute|reset`，直接替换 `/hook-stats`，不保留兼容别名。首版分支写命令限制在 `ctx.isIdle()` 且未 `closed` 时执行（不维护可因 `session_before_tree` 取消而永久卡死的 `transitioning` 布尔）。

### 5.2 Hook v1 只读 RPC

- 经单一跨扩展只读握手通道 `pi-harness:hook-inspection`（与 `shellApprovalController` 同构）同时提供 `current(ctx)` 与 `stats()`，未安装或非活跃会话统一返回 `RPC_ERROR.unavailable`，两方法均执行 `assertSession()`。
- **`hooks.current`**（`NoParams` → `HooksCurrentResult`）：
  - 反映已加载的 `HOOK_LAYERS_SLOT`（冷查走同槽加载，不写分支、不发 UI 通知）、当前分支 Preset 快照与本分支 `muted` 集合；
  - 字段包含 `valid`、`preset`、`classifierConfigured`、`rules`、`disabled`（TOML 胜出 tombstone）、`muted`（本分支静音的 `hookId` 升序数组，含已从 TOML 删除的历史 ID）与 `warnings`；
  - `rules` 每项仅输出结构摘要 `{ id, source, on, hasWhen, classifyKind, actionTypes, hasRepeat, observeOnly, muted, active }`，零 `when` 源码、提示词正文或 `classify.question`；
  - `warnings` 采用强类型脱敏码 `{ scope: 'global' | 'preset' | 'project', id?, code: 'version_invalid' | 'layer_invalid' | 'when_invalid' | 'classifier_unconfigured' }`，不透出路径、TOML 片段或原始 `actual` 版本值；层级失败时 `valid = false` 且 `rules`、`disabled` 为空。
- **`hooks.stats`**（`NoParams` → `HooksStatsResult`）：返回复制后的纯 JSON DTO（取整 `durationMs`、固定 6 类工具、`<= 64` 排序 Hook 桶与 `otherHooks`），无订阅、无写入。

---

## 6. 竞态闭环矩阵（10 项）

| # | 竞态场景 | 风险 | 结构性解法 |
| --- | --- | --- | --- |
| 1 | `readAsync` vs `refreshLeaves` vs 并发刷新 | 旧读覆写新版本、新刷新误杀在途 `tool_call`、旧 `finally` 误删新代 `inFlight` | 跨 `sessionEpoch` 禁写并抛 `ConfigStaleError`；同会话仅被新刷新取代（`opSeq` 变）只阻回写、不打断在途调用；`finally` 必验 `slot.inFlight === ownPromise`；并发刷新按 `opSeq` 串行/淘汰 |
| 2 | 刷新 `await` 期间切换或关闭会话 | 旧读盘结果写进新会话或通知新会话 UI | 作用域围栏核对宿主权威 `sessionEpoch` 与未关闭状态（不只重读旧 `ctx`），命令返回后复核 `sessionEpoch` |
| 3 | Shell 审批等待人工期间触发 `/config reload` | 用新规则解释旧用户答复 | 审批开始即冻结 `mode` 与 `ruleFiles` 已应用快照，刷新只影响下一次准入；切会话/撤 trust 走 `AbortSignal` 取消 |
| 4 | Hook 活跃轮内刷新引发 `bindBranch(ctx, 'commit')` | 轮中途清空 `recentTools`、打乱 `pendingHints` 对账、同轮混跑两代规则 | 冻结轮内匹配池（新规则下一轮生效）；活跃轮内绝不原地重建 `branchState` |
| 5 | 晚到异步 Hook 与已入队 `passiveHints` 漏检 | 刷新/静音后仍提交旧规则动作 | 所有未提交动作在提交前纯只读复核最新有效层与静音态（不改 `branchState`/游标/`recentTools`）；已交 SDK 消息不撤回 |
| 6 | `discoverCapability` 两阶段窗口（受理 → 同步发布） | 后台检索期间规则被改或静音，数秒后仍发布工具与分支记录 | `CapabilityHookPort.discover` 最后同步发布门增加可选纯只读断言 `canPublish?: () => boolean`（零 I/O/副作用、异常按 `false`；仅 Hook 传入，显式 `capability` 不受影响；已扣 repeat 不退，槽位等真正 settle 才释放） |
| 7 | ABA 复活（未提交前 `mute → unmute` 或改回原规则） | 已被撤销的旧在途批次意外恢复提交资格 | 每条当前有效 Hook 持 O(1) 身份令牌：语义 `key` 与未静音态不变沿用旧令牌（改注释或无关规则不误杀），变更/删除/静音即移出，重加或 `unmute` 得新令牌，无永久 ID 表 |
| 8 | `/hooks` 分支写 vs 可取消 `session_before_tree` | `before/post` 布尔在取消导航（不发 `session_tree`）时永久死锁 | 不用 `before/post` 布尔；分支写命令限制在 `ctx.isIdle()` 且未 `closed` 时同步核验身份写入 |
| 9 | 同会话信任下降或 `cwd` 变化 vs 旧 `RootService` | 旧根服务持受信项目预算继续准入新 Subagent | `RootService` 所有新准入路径共用 `(cwd, projectTrusted)` 权限围栏，不一致拒绝新准入直到 `/reload`（只读诊断不受阻塞） |
| 10 | 外部编辑器分步写多文件半写态 vs `/config reload` | 读到半写坏文件破坏运行态 | 逐槽事务解析失败保旧（`failed, keptPrevious: true`）；属文件系统弱边界，文档明示不上文件锁 |

---

## 7. 测试策略（4 层，零重复覆盖）

遵循[测试架构](../testing.md)，不按内部函数机械堆测试：

1. **纯契约与离线迁移**：扩展 `harness-config.test.ts`、`preset-definition.test.ts`、`subagent-routing-config.test.ts` 及 Hook loader／迁移场景，覆盖四份文档显式版本门禁（含空 JSON/空 TOML）、容器表与 4A Global-only 拒绝（含空对象）及黑名单并集（Preset 版本哈希仍由 `preset-version.test.ts` 覆盖）；新增 `test/typed/config-v1-migration.test.ts`，至少执行一次真实 CLI `--apply` 进程并把产物直接喂给各生产 loader 验真，覆盖 dry-run、排他备份与 Global-only 阻写。
2. **纯槽位并发模型（`test/typed/config-lifecycle-model.test.ts`）**：仅测纯槽位生命周期，默认 50 组 × 24–32 步、2–3 个显式 `deferred` gate，无磁盘/无 SDK/无定时 sleep，结束统一 drain，复用 `PI_PBT_SEED` 收缩重放约定；重点验证跨代 `ConfigStaleError`、同会话被取代不误杀在途读、旧 `finally` 不误删新代 `inFlight`、`session_tree` 零读盘，以及解绑释放与底层实际完成分别断言。
3. **真实 Pi SDK 门控竞态场景**（扩展既有 SDK 套件，绝不绕过命令准入）：
   - 轮内 `passiveHints` / `classify` 变更与 ABA 走真实 `/config reload`；`mute → unmute` ABA 走 `agent_settled` 后仍合法存活的 branch-only `classify` / `discover`；
   - `discoverCapability` 撤销发布门后，断言底层未 settle 前确仍占槽不可重入，settle 后恢复；
   - 至少 1 条真实 `harness + capability + shell-preflight` 组合走 `session.prompt('/config reload')`（冷会话、同 bus），断言单次命令注册、双叶子更新且 MCP / Stats / RootService 快照不重建；反向加载顺序用轻量真实 bus 装配验证；
   - 补覆盖取消 `session_before_tree` 后 `/hooks mute` 不死锁、Shell 审批等待期刷新隔离与 shutdown 清 `mode`、以及 `RootService` 信任下降拒绝新准入。
4. **真实 Socket RPC 与协议资产闭环**：扩展 `harness-rpc` 测试，验 `session rebind` 后不吐旧 `hooks.stats`、冷坏版本（`version_invalid`）与刷新失败保旧快照分开验证、TOML `disabled` 与分支 `muted`（含孤立历史 ID）区分及零路径/正文泄露；跑 `npm run check:rpc-schema` 与按行为契约登记 `test/contracts.json`。

---

## 8. 原子提交拆分顺序（从 `main` `ef8bcb2` 新开分支）

1. **Commit 1（Storage + Harness v1 & 作用域收紧）**：`src/config-storage.ts`、`harness.json` `version: 1` 与 Global-only 拒绝 / `capability.blacklist` 并集、`scripts/migrate-config-v1.mjs` 基础、文档与测试。
2. **Commit 2（Preset v1 容器表 + 迁移 + Routing 复用只读 I/O）**：`presets.toml` `version = 1` + `[presets.<name>]`、迁移扩展与既有迁移脚本对齐、`subagent-routing.toml` v4 复用只读 I/O（不改离线 validator 契约）。
3. **Commit 3（Hook v1 容器表 + 迁移）**：`hooks.toml` `version = 1` + `[hooks.<id>]`、迁移扩展与测试。
4. **Commit 4（统一配置生命周期内核）**：`src/config-lifecycle.ts`、迁入 4 处缓存、`shell-approval` 补 shutdown 清 `mode`、`RootService` 权限围栏与纯槽位 PBT。
5. **Commit 5（`/config reload` 叶子事务刷新与两阶段发布门）**：`extensions/harness.ts` 注册 `/config reload`、`CapabilityHookPort.discover` 同步 `canPublish`、O(1) 规则身份令牌与 SDK 竞态验证。
6. **Commit 6（分支级 Hook 静音与 `/hooks` 命令收口）**：`HOOK_OVERRIDE_RECORD` delta 回放、`/hooks stats|mute|unmute|reset` 替换 `/hook-stats`、分支导航/取消导航回归。
7. **Commit 7（Hook v1 只读 RPC 与协议生成物）**：`pi-harness:hook-inspection` 只读端口、`hooks.current` / `hooks.stats`、`npm run schema:rpc`、真实 Socket 测试与契约文档同步。
