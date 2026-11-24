# Preset 版本、会话工具基线与分支切换演进提案

本提案已完成讨论并定稿，待实施后同步更新[Capability 提示词与分支记忆](../capability-prompt-memory.md)、[接口契约](../interface-contract.md)与 [Harness RPC 线协议规范](../harness-rpc-wire-spec.md)。

## 当前问题

1. **旧会话固化的 `baseline` 会踢掉升级后新增的默认工具**：Pi SDK 的 `_restoreToolsFromTranscript` 在恢复旧会话时会自动激活分支从未提及的新增默认扩展工具（如升级后新增的 `job_stop`、`job_send`、`job_key`），但 Harness 的 `ensureToolBase`（`src/capability/tool-access.ts`）读到历史 `capability-tool-base` 后不再更新，一旦套用带 `tools` 修饰符的 Preset，`syncActiveToolsToCollections` 会按旧快照覆盖活跃工具集，把新增默认工具静默移出。
2. **Preset 缺少内部版本标识，配置或工具底座演进后无法统一判定与整套升级**：当前 `preset-state` 仅记录 `name` 与展平字段，修改 `presets.json` 中的提示词、模型、thinking、codemode、工具修饰符或底层默认工具变更后，无法以单一标识判断分支快照是否落后于当前定义；同时，分支引用的 Preset 名称已从当前 `presets.json` 删除或配置失效时，用户缺乏明确状态提示。
3. **切换或重套带 `tools` 的 Preset 会抹掉用户手动 `/capability base` 修改**：`resolvePreset` 始终基于初始 `baseline` 计算展开后的 `snapshot.tools`，而 `applyPresetEntry`（`src/capability/tool-access-replay.ts`）在 `snapshot.tools !== undefined` 时执行 `state.base.clear()` 与 `state.baseActions.clear()` 全量覆盖 `state.base`，导致手动 `/capability base add/remove` 被静默清空。
4. **`/preset clear` 行为与提示文案冲突**：当前 `clear` 将原 Preset 的工具结果转为 `branch` 成员（例如 `-edit +apply_patch` 后 `edit` 不会恢复），但通知文案仍提示 `the tool baseline are unchanged`。
5. **`/tree`（双击 Esc）切分支后 Preset 状态栏与未发消息分支的工具集失步**：`extensions/preset.ts` 未监听 `session_tree`，切分支后状态栏仍显示旧分支的 `preset:xxx`；`src/capability/extension.ts` 在 `session_tree` 未按目标分支重同步活跃工具集，分支尾部尚未发出新消息的 `/preset` 或 `/capability base` 记录以及空分支会出现 live 工具集与分支记录不一致。
6. **命令补全缺口**：`/preset` 未接入 `getArgumentCompletions` 与 `argumentCompletionProvider`；`/subagent` 的 `list` 漏补 `--id`，`interrupt`／`stop` 只补全 `children` 与无可控 Job 的 `main`，未补全活跃 Subagent ID。

## 改进方案

核心原则：**引入 Preset 内部 `contentHash`（内容哈希），将 Preset 视为原子版本包；要升级就一整套一起切换，不引入跨层半搬运与额外 RPC 写协议，不修改 Pi SDK。**

### 1. Preset 内部 `contentHash`、单条目持久化与版本跳过

- **格式版本与内容哈希分离**：
  - `preset-state` 的线协议版本号升级为 `version: 2`；内容版本标识命名为 `contentHash`（确定性哈希，如规范化 JSON 的 SHA-256），由内部计算，不要求用户在 `presets.json` 中手工维护。
- **`preset-state` v2 结构与单条目原子落盘**：
  - 同一次 Preset 应用涉及的工具选择、codemode 意图以及本次随升级带入的 `baseline` 增量，全部由**单个权威 `preset-state` v2 条目**承载，不再拆分两次 `appendEntry` 制造半写入状态。
  - `baseline` 增量作为该条目上的独立永久分支事实（后续 `/preset clear` 不撤回）。
  - 工具选择持久化规范化意图：`none`（未声明）／`modifiers { add, remove }`（`+name`／`-name` 归一化操作）／`replace { names }`（裸名替换），区分“未声明”与“显式空集合”，并保存当时解析出的工具名投影供 diff 与压缩对比。
  - Pi 的 `model`／`thinking` 设置与 live 工具集同步仍是外部 SDK 效果，沿用失败可见、不伪装成功的既有契约。
- **`contentHash` 输入与名义候选底座（不改 SDK，本仓闭环）**：
  - 纳入哈希的字段：`model`（`provider`、`id`）、`thinkingLevel`、工具选择模式与归一化操作、基于名义候选底座解析后的工具 **name** 集合（排序）、`disabledTools`（排序后的排除 **name** 集合）、`codemode`（`mode`）、`instructions`（提示词正文）。
  - 排除的字段：工具 `schema`／`guideline`／`snippet`（归 SDK、Capability 与 Provider 传输层）、`description`（说明文案）、以及用户手动 `branch` 层。
  - **名义候选底座**：计算当前候选版本的 `contentHash` 时，以 `分支旧 baseline ∪ 已注册的 Harness 自有默认激活工具清单`（如 `JOB_TOOLS` 等）作为名义底座，**不先按用户 `base remove` 或 `blacklist` 过滤**，避免手工层反向污染 Preset 哈希；最终生成 live 活跃集时再统一应用四层优先级，新增默认工具不获得绕过 `blacklist` 的权限。同一进程运行期间晚注册的工具（如延迟连上的 MCP，见 `preset-sdk.test.ts`）继续不纳入 Preset base。
- **独立跳过记录（`preset-version-skipped`）**：
  - 用户在 TUI 选择“保持旧版”时，追加小型 append-only 记录 `preset-version-skipped { version: 1, name, fromHash, candidateHash }`。
  - 仅检查当前最新激活 `preset-state` 之后的最后一次跳过记录；三元组 `(name, fromHash, candidateHash)` 完全匹配时才消音。新的 `apply` 或 `clear` 自然使旧跳过决定失效，无需清理或重写；显式手动 `/preset <name>` 始终忽略跳过记录。

### 2. 统一版本决策、缺失态处理与幂等重套

- **TUI `outdated`（必须严格守卫 `ctx.hasUI && ctx.mode === "tui"`）**：
  - 在 `session_start` 检测到分支已激活 Preset、当前 `presets.json` 存在可解析的同名配置、`recorded.contentHash !== current.contentHash` 且未命中当前 `preset-version-skipped` 时，弹出 `ctx.ui.select` 列出字段与工具名差异摘要，提供二选一：
    - **切换到当前版本**：整套应用当前版本的 Preset（同步刷新 `preset-state` v2 及内嵌 `baseline` 增量并同步活跃工具集）；
    - **保持旧版**：不动任何 live 状态以保护旧会话提示词缓存，并写入 `preset-version-skipped`。
- **`missing` 与 `unresolvable` 处理（分支 Preset 不在当前配置库或配置无效）**：
  - **沿用分支快照正常运行**，绝不静默丢弃或降级，也不在 `session_start` 弹出选择框。
  - **可见提示**：状态栏明确标出异常态（如 `preset:<name> (missing)`／`preset:<name> (invalid)`），并在 `session_start` 与 `session_tree` 发一条轻量 `warning` 通知，提示可用 `/preset` 切换或 `/preset clear` 清除。
  - **补全 `/preset` 交互面板**：即使当前 `presets.json` 为空，只要当前分支仍挂有 Preset，`/preset` 选择器仍展示 `(none)` 允许清除。
  - 用户如需继续使用旧快照同时补充新默认工具，可直接通过手动 `/capability base add` 覆盖；如需切换至新命名 Preset，直接执行 `/preset <新名称>` 整套切换。
- **无 Preset 老会话**：`preset === null` 的分支在 resume 时不弹窗、不追加任何记录，交由 Pi SDK 原生恢复。
- **非 TUI / RPC 模式**：
  - 禁止在 `session_start` 调用 `ctx.ui.select`（Pi `rpc-mode.js` 在挂载 stdin 行读取器前触发 `session_start`）。
  - 不新增基线写接口、独立漂移事件流或 leaf 锁：
    - `presets.current` 保持严格只读（绝不触发 `ensureToolBase` 写分支），保留既有 `{ preset }` 字段，并新增 `{ status: 'current' | 'outdated' | 'missing' | 'unresolvable', currentVersion, changes }`（无激活 Preset 时无候选）。
    - `presets.apply` 保持调用时重读最新可信配置并整套应用，结果返回实际 `contentHash`；支持可选参数 `expectedVersion`，当客户端预览版本与当前配置不匹配时拒绝写入并提示重查。
- **幂等重套与失败重试**：
  - 手动重套 `/preset <name>` 时，若 `recorded.contentHash === current.contentHash` 且当前 live 工具集已同步，则作为无变化返回、不写冗余记录；若此前 live 同步失败或工具集失步，允许仅重同步 live，不把显式重试吞掉。

### 3. 工具来源四层覆盖模型、`/preset clear` 与 v1 离线迁移

按由高到低拆为四个正交层，用户手动选择直接覆盖 Preset 且与 Preset `contentHash` 解耦：

1. **硬围栏层**：SDK 硬限制、子代理祖先黑名单、用户手动 `blacklist`。
2. **用户手动 `branch` 层**（`/capability base add/remove`）：直接覆盖 Preset 的增减，不参与 Preset `contentHash`；切换、升级或清除 Preset 不再清空手动 `branch` 层。若当前 Preset 显式写了 `-name` 但被用户手动 `branch` 层保留，应用结果与通知应明确提示该工具由 `branch` 层保留。
3. **当前 Preset 层**：
   - `modifiers { add, remove }` 仅叠加 Preset 自身的增减贡献。
   - `replace { names }`（裸工具名替换）仅替换第 4 层的默认基线，不擦除第 2 层用户手动 `branch` 成员。
   - **`/preset clear`**：撤回当前 Preset 自身的工具贡献与 Preset 黑名单（不撤回其已提交的永久 `baseline` 增量），回退到「有效基线 + 用户手动 `branch` 变更」（模型与 thinking 仍保持不变），并同步修正通知文案。
4. **有效启动基线（`baseline`）**：由首次捕获的 `capability-tool-base` 与后续 `preset-state` v2 记录的永久 `baseline` 增量共同构成。

**不保留运行时兼容与离线迁移**：
- 运行时解析器与重放器仅接受 `preset-state` v2，不做 v1／v2 猜测回退。
- 在 `scripts/` 下提供显式离线迁移工具，纯基于会话 JSONL 自身内容转换所有可恢复分支上的 v1 `preset-state`（**不依赖 `presets.json`**，原 Preset 名已删除或改名亦可无损迁移）：
  - 保留原有 entry IDs；需要修正工具成员时紧接原节点插入标准 `capability-tool-base` 条目，将原节点直接子节点改挂到修正条目下；
  - 将 v1 展平 `tools` 映射为 `replace { names }` 并纯本地计算 `contentHash`（无法从展平结果反推 `+`／`-` 原意；打开后若同名仍在 `presets.json`，通过常规版本升级即可切回修饰符语义）；
  - 逐分支核对工具成员，包括旧 `clear` 保留工具或排除旧基线、旧 Preset 应用擦除手动选择的情况；运行时 `preset-state` v2 结构不包含迁移字段；
  - 迁移本机活跃会话前须先关闭对应会话并备份原始 JSONL。

### 4. `/tree` 分支切换静默同步

放弃切前跨分支半搬运弹窗与 RPC 导航差异事件，对齐 Pi 原生模型／thinking 的分支恢复语义：

- **状态栏同步**：`extensions/preset.ts` 监听 `session_tree`，按目标分支最新快照刷新 `preset:<name>` 状态栏（含 `outdated`／`missing`／`invalid` 提示）。
- **工具集最小差分同步**：`src/capability/extension.ts` 在 `session_tree` 按目标分支集合做最小差分同步 `activeTools`，保留非 Harness 管理工具与 SDK 新默认工具。无差异时不调用 `setActiveTools`、不写冗余记录。Pi 1.6.0 移除已从历史恢复的工具时会清理其待注册工具集合；仅新增或无差异时保留。

### 5. 命令补全补齐

- `extensions/preset.ts`：接入 `getArgumentCompletions` 与 `argumentCompletionProvider`，补全当前已配置 preset 名称、`clear`、`show`。
- `src/subagent/command.ts`：`list` 补全 `--id` 及对应候选；`interrupt` 与 `stop` 补全当前可达且活跃的 Subagent ID，移除对无可控 Job 的 `main` 误导候选或修正展示。

## 验收要点

- **`contentHash`、单条目持久化与整套升级**：修改 `presets.json` 任一语义字段或历史分支 `baseline` 缺少 Harness 新增默认工具（如 `job_stop`）时，`currentVersion` 与分支 `contentHash` 不同；用户手动 `base remove`／`blacklist` 不污染 `contentHash`；TUI 下 `session_start` 二选一——选切换则单条 `preset-state` v2 一并写入新快照与永久 `baseline` 增量，选保持则写 `preset-version-skipped` 且后续不再重复弹窗直至 `candidateHash` 变化；同一进程内晚注册工具仍不进入 Preset base（现有 `preset-sdk.test.ts` 保持通过）。
- **`missing`／`unresolvable` 与无 Preset 恢复**：分支引用的 Preset 已从 `presets.json` 删除或配置失效时，沿用分支快照不弹窗，状态栏标 `(missing)`／`(invalid)` 并轻提示，空配置时 `/preset` 仍保留 `(none)` 清除入口；无 Preset 分支 resume 不弹窗、不写记录。
- **RPC 只读检查与 `expectedVersion`**：验证 `--mode rpc --resume` 在存在版本差异时不阻塞启动；`presets.current` 严格只读（不写 `capability-tool-base`）并返回正确 `status`／`currentVersion`／`changes`；`presets.apply` 返回实际 `contentHash` 并在 `expectedVersion` 失配时拒绝写入。
- **用户手动层覆盖 Preset、`clear` 与失败重试**：验证四层优先级（含与 Preset `-name` 冲突提示）、`/preset clear` 撤回 Preset 贡献但保留永久 `baseline` 增量与用户 `branch` 层、以及同 `contentHash` 下上次同步失败后手动重套可重新同步 live。
- **`/tree` 静默同步与缓存边界**：真 SDK 测试 A/B 分支切走切回（含未发消息的 `/preset`／`/capability base` 记录、空分支、无差异分支），验证状态栏与 `activeTools` 一致、保留 SDK 新默认工具、遵循 Pi 对待注册工具的处理、无差异时不调用多余 `setActiveTools`，并核对 Responses 前缀稳定。
- **离线迁移与补全回归**：验证 `scripts/` 在缺失 `presets.json` 时保持历史工具成员、entry IDs 及多分支拓扑；验证 `/preset` 参数补全与 `/subagent list/interrupt/stop` 活跃目标补全。
