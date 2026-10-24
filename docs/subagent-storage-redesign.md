# Subagent 存储重构提案

状态：**提案，未实现。** 本文第 1、2 节描述当前行为，依据为 2026-10-24 对 `extensions/subagent.mjs`、`src/subagent-storage.mjs`、`src/subagent-runtime.mjs`、`src/inherited-context.mjs` 的阅读和对会话 `01a16dc7…` 的实测。第 3 节起为设计提案。

## 1. 当前问题

### 1.1 实测

| 文件 | 大小 | 其中 `subagent-state` |
| --- | --- | --- |
| 根会话 `01a16dc7….jsonl` | 472 MB | 3130 条，455 MB |
| `subagent-sessions/01a16dc7…/sub_25.jsonl` | 482 MB | 3095 条，444 MB |
| `subagent-sessions/01a16dc7…/sub_24.jsonl` | 456 MB | 3016 条，421 MB |

Fork 链 `01a16355`（497 MB）→ `01a16974`（910 MB）→ `01a16dc7`（896 MB）每一代都重新复制一遍。完整恢复后堆约 2.8 GiB。

### 1.2 根因

1. **每次变化写全量快照。** `#recordHistory` 在子会话每追加一条条目时移动 `history.endEntryId`，触发 `#markDirty` → `store.save` → `pi.appendEntry`。每份快照包含全部 Job 的 `result`、`spec` 与全部 actor 的 `roleInstructions`（最后一份 315 KB）。相邻快照的差异通常只有 `leafId`、`endEntryId`、`activeTimeMs`。总量约为 Job 数 × 轮次数。
2. **继承上下文复制了快照。** `captureInheritedContext` 原样复制父分支，包括全部 `subagent-state` 条目。
3. **恢复时整份读回种子。** `hydrate()` 对每个 `inheritedContext` 出现处执行一次 `SessionManager.open(seedFile)` 并保留条目数组；同一文件不缓存。Actor 已有会话文件时这些条目并无用途。
4. **常驻内存不释放。** Job 结束后 `retained.sessionManager` 不释放；`job.messages` 每轮整份克隆且不清空；`spec.inheritedContext.entries` 常驻。
5. **重复全量解析。** 恢复后的首次 `save` 校验种子、`hasRecordedTurn`、`readHistory`、`appendCustomToRetained` 每次都完整打开会话文件。

### 1.3 Rewind 与 Fork 的现有缺陷

- **Fork 后旧 actor 不可用。** 所有子文件读写都使用 `store.childSessionFile(agentId)`，即 `subagent-sessions/<当前根会话 id>/<agentId>.jsonl`；actor 记录里的 `sessionFile` 只被校验，不被使用。Fork 产生新根会话 id，所以 Fork 前创建的 actor 的历史读取和续跑都会找不到文件（`01a16dc7/` 下只有 `sub_24`、`sub_25`，`sub_01…21` 在 `01a16974/`）。
- **Rewind 后 ID 可能复用。** `createService` 重建 `allocatedAgentIds` 时检查 `Array.isArray(stateData.actors)`，但 `data.actors` 是以 agentId 为键的对象，`registry.actors` 才是数组。结果是该集合从不由持久化数据填充。进程重启后 Rewind 到较早分支，运行时序号回退，可能重新分配 `sub_N`：Fresh actor 会打开并追加到被放弃分支上同名 actor 的文件；Inherited actor 会因 `storage_seed_conflict` 失败。
- **现有清理脚本破坏 Rewind。** `scripts/prune-subagent-state-checkpoints.mjs` 只保留各叶子的最新快照；Rewind 到被删快照之前的位置时，注册表为空。

## 2. Pi 原生语义（实现依据）

| 操作 | 根会话文件 | 会话 id | 扩展事件 |
| --- | --- | --- | --- |
| `/tree`（Rewind） | 同一文件，只移动 leaf；旧分支保留 | 不变 | `session_tree` |
| `/fork`、`/clone` | `createBranchedSession(leaf)`：只复制 root→leaf 路径；条目 id 保留，`parentId` 重新串接，`label` 重建，`custom` 条目保留 | 新 id，header 带 `parentSession` | `session_start`（`reason: "fork"`，含 `previousSessionFile`） |
| `--fork` | `forkFrom`：复制整个文件，包括所有分支 | 新 id | `session_start` |

推论：

- 写在根分支上的 `custom` 条目天然跟随 Rewind 与 Fork，不需要扩展参与。条目越小，复制越便宜。
- 根会话文件之外的数据（子会话文件）不会被 Fork 复制，必须由本项目定义所有权。
- 当前 `session_tree` 与 Fork 都会退役服务并取消运行中的 Job（`retireService`）。本提案保持这一行为。

## 3. 目标与不变量

1. **任一根分支位置都可恢复。** Rewind 到任何条目，注册表等于该路径上发生过的事。不依赖“最新快照”。
2. **Fork 后历史可读、actor 可续跑。** 父根会话与 Fork 可同时打开，互不写对方的文件。
3. **写入量与事件数成正比，不与状态大小成正比。** 一个 Job 的大字段（任务、结果、角色说明）在根分支上只写一次。
4. **子 Agent 每轮不写根会话。**
5. **常驻内存只含元数据。** 对话正文只在运行中的 Job 内常驻。
6. **agentId 在一个根会话文件内跨分支唯一。**

## 4. 架构

两层存储，不新增第三种存储：

| 层 | 内容 | 作用域 | 写者 |
| --- | --- | --- | --- |
| A. 根分支事件 | actor 与 Job 的生命周期事件 | 根会话分支；随 Rewind、Fork 走 | 根会话服务 |
| B. 子会话文件 | 每个 actor 一个原生 Pi 会话文件 | `subagent-sessions/<所属根会话 id>/` | **仅**所属根会话（单写者） |

已考虑但不采用：**内容寻址 Blob 存储**。问题来自重复写入，不是单项过大；改为事件后，每个结果只写一次，放在根分支即可随 Fork 复制，也无需另设垃圾回收。只有在单项结果确实过大时再考虑。

### 4.1 A 层：根分支事件

全部为 `pi.appendEntry(customType, data)`，`data.v = 2`。

| `customType` | 写入时机 | 主要字段 |
| --- | --- | --- |
| `subagent-actor` | actor 创建；身份变化（路由完成、模型或工具变化） | `agentId`、`name`、`parentAgentId`、`depth`、`file`、身份字段（`roleId`、`roleInstructions`、`systemPrompt`、`model`、`thinkingLevel`、`tools`、`excludedTools`、`trusted`、`allowInherited`、`routed`）；身份变化时只写变化字段 |
| `subagent-job` | Job 创建 | `jobId`、`agentId`、`index`、`createdBy`、`continuedFromJobId`、`spec`（不含对话条目）、`origin`、`budgetLimits` |
| `subagent-job-end` | Job 终态 | `jobId`、`status`、`result` 或 `error`、`history: {startEntryId, endEntryId}`、`budgetUsage`、`anchor`（actor 新 leaf） |
| `subagent-anchor` | 不伴随 Job 终态的 leaf 移动（如向空闲 actor 追加完成通知） | `agentId`、`leafId` |
| `subagent-relocate` | 写时复制产生新文件（见 4.3） | `agentId`、`file`、`leafId` |

**恢复规则：** 状态 = 按顺序折叠 `getBranch()` 上所有 v2 事件。不写周期快照；事件数与 Job 数同量级，折叠开销远小于读取根会话本身。

**运行中 Job 不写每轮事件。** 中断恢复改为依赖子文件里的起点标记（4.2）。`activeTimeMs`、`modelCalls` 只在终态写入；进程崩溃时丢失这些用量计数，可以接受。

### 4.2 B 层：子会话文件

- **起点标记。** 每个 Job 开始时，在子文件追加一条 `custom` 条目 `subagent-job-start {jobId}`。`custom` 条目不进入模型上下文。标记 id 写入根事件 `subagent-job`（字段 `startEntryId`）。
- **中断恢复。** 根分支上只有 `subagent-job`、没有 `subagent-job-end` 的 Job 记为 `failed/interrupted`。结束位置取子文件中按文件顺序最后一条、祖先链包含该标记的条目。标记唯一属于一个 Job，所以即使同一起点上因 Rewind 有多条分支也不混淆。
- **首次落盘。** Pi 在会话出现对话前不落盘。标记所在文件不存在时，视为 Job 未开始，保留任务文本供续跑重述（与现有 `recordedAnchor` 规则一致）。
- **Inherited 种子。** 创建时直接把捕获的父分支写成子文件，并：
  - 删除 `subagent-*` 类 `custom` 条目并重接 `parentId`（复用 `withoutEntry` 的重接方式）；
  - 不在 Job `spec` 中保存条目，只保存元数据（`systemPrompt`、`tools`、`model`、`thinkingLevel`、`warnings`）和 `seedLeafId`；
  - 同批多个子 Agent 共用一次捕获，逐个序列化写文件，不做 `structuredClone`。
- **删除 `hydrate`。** 从未启动的 actor 也已有种子文件，续跑起点就是 `seedLeafId`。

### 4.3 所属权与 Fork：写时复制

规则：**根会话 R 只写 `subagent-sessions/<R.id>/` 下的文件。**

- actor 的权威位置是事件里的 `file`（绝对路径），不是由 agentId 推导。所有读写改用 `file`。
- **读：** `file` 属于其他根会话（Fork 前的父会话）时，只读打开。
- **写**（续跑、追加完成通知）时，如果 `file` 不属于 R：
  1. 只读打开 `file`，取 `getBranch(anchor)`；
  2. 写入 `subagent-sessions/<R.id>/<agentId>.jsonl`：新 header（`parentSession: file`）+ 该路径，条目 id 保留；
  3. 追加 `subagent-relocate {agentId, file: 新路径, leafId: anchor}`；
  4. 在新文件上继续。
- 旧 Job 的 `history` 区间都是 `anchor` 的祖先，条目 id 保留，因此在新文件中仍可解析。
- 父会话与 Fork 可同时运行：二者永远不写同一个文件。
- 父会话文件被删除后，Fork 中未复制的 actor 历史不可读。读取时应报 `storage_history_unavailable`，不静默返回空。是否在 Fork 时主动复制，留待第 8 节决定。

### 4.4 Rewind

- 同一根会话文件、同一子文件目录。续跑时用 `sessionManager.branch(anchor)` 定位，被放弃的子分支保留在文件中（现有行为）。
- 被放弃分支上创建的 actor：其文件保留为孤儿；当前分支不可见；回到原分支时恢复可见。
- **ID 分配：** 服务启动时扫描根会话 `getEntries()`（全部分支）里的 `subagent-actor` 事件，并列出自有目录下的文件名，二者取并集作为已占用集合。事件很小，全量扫描开销可接受。

### 4.5 内存模型

| 常驻 | 不常驻（按需读取） |
| --- | --- |
| 根会话 `SessionManager`（事件很小） | 已结束 actor 的 `SessionManager`：Job 结束即释放，下次续跑或读取时打开 |
| 运行时注册表：actor 与 Job 元数据、每个 Job 的结果文本（各一份） | Job 对话：`job.messages` 删除；活跃 Job 从其 live `SessionManager` 读取，已结束 Job 经 `readHistory` 读取 |
| 运行中 Job 的 live 子会话 | Inherited 捕获：写完种子文件即释放 |

只读打开子文件（历史、`hasRecordedTurn`）宜经一个小型 LRU（按文件路径与 mtime 失效），避免同一操作内重复全量解析。

### 4.6 可读历史视图（替代 `.pi/subagents/`）

**当前行为。** `src/subagent-history.mjs` 在项目目录写 `.pi/subagents/<sha256(rootId)[:6]>/<agentId>/`：

- `session.clean.jsonl`：运行中逐条追加消息事件，是子会话对话的第二份副本；
- `summary.md`：每轮结束时覆盖或追加。

模型通过 `subagent_create`／`subagent_list` 返回的 `history.summary`、`history.cleanJsonl` 路径用 `read` 读取结果（接口契约“结果读取”一行）。问题：

- 按 actor 线性追加，不感知分支：Rewind 后续跑会把两条分支的对话混在同一文件；Fork 后新根会话的目录里没有旧 actor 的文件。
- 是第二份真相来源，与原生子会话文件可能不一致。
- 写在项目目录，依赖 `.gitignore`；本机已有 55 MB。
- 终态通知里的路径由 `getSubagentHistoryPaths(job.agentId)` 生成，未带会话目录，指向不存在的位置（`src/subagent-runtime.mjs` 的 `completionText`，`extensions/subagent.mjs` 的 `completionDetails`）。

**决定：保留“按路径读取”的模型接口，把文件改为由原生数据派生的、按 Job 不可变的视图。**

- **位置：** `subagent-sessions/<rootId>/views/<jobId>/`，与子会话文件同属根会话，不再写项目目录。
- **粒度：** 一个 Job 一个目录，Job 终态时一次写成，此后不变：
  - `summary.md`：由 `subagent-job` 与 `subagent-job-end` 事件渲染（任务、状态、用量、结果、`continuedFromJobId`）；
  - `transcript.jsonl`：`readTranscript(readHistory(Job 区间))`，即现有清洗格式。
- **派生、可重建：** 视图不参与恢复。视图缺失时（被删除、转换来的会话），`subagent_list` 返回路径前按根事件与子文件重建。
- **分支安全：** Job 区间封存后不可变，所以视图天然不受 Rewind 影响；当前分支看不到的 Job 不会被列出。Fork 后旧 Job 的视图路径指向父会话目录，按 4.3 只读；缺失时在自有目录重建。
- **Job id 唯一性：** 视图按 `jobId` 存放，所以 `jobId` 与 `agentId` 一样，分配时须避开全部分支与自有目录中已存在的 id（4.4）。
- **路径修正：** 所有返回路径统一取自存储层，消除未带会话目录的路径。

**取舍：**

| 放弃 | 原因 |
| --- | --- |
| 运行中实时追加 `session.clean.jsonl` | 工具说明只要求在终态通知后读取；运行中进度由 `subagent_list` 状态和消息通道提供。少一条写路径，也不再出现半截文件 |
| 按 actor 跨轮累积的 `summary.md` | 改为每 Job 一份，续跑链通过 `continuedFromJobId` 关联；换来分支安全与不可变 |
| 由工具直接返回结果正文（不落文件） | 未采用：会改变工具契约并把长结果放进调用方上下文；路径读取可按需读取局部 |

`.pi/subagents/` 不做转换，直接删除；转换脚本也不处理它。

## 5. 关键流程

1. **创建 Fresh actor：** 分配 id → 写 `subagent-actor`、`subagent-job` → 打开子文件 → 写起点标记 → 运行。
2. **创建 Inherited actor：** 捕获 → 过滤 → 写种子文件 → 写 `subagent-actor`（含 `seedLeafId`）、`subagent-job` → 写起点标记 → 运行。
3. **Job 结束：** 写 `subagent-job-end`（含结果、区间、用量、新 anchor）→ 写 Job 视图（4.6）→ 释放子会话。
4. **续跑：** 必要时写时复制 → `branch(anchor)` → 写 `subagent-job` 与起点标记 → 运行。
5. **服务启动（启动、Rewind、Fork 后）：** 折叠当前分支事件 → 未结束 Job 标为中断（用 4.2 求区间）并补写 `subagent-job-end` → 扫描全部分支建立已占用 id。

## 6. 兼容性与转换

作者确认允许破坏兼容性（本机会话数有限），但要求提供一次性转换。转换只保留**当前状态**，不保留历史位置的子 Agent 状态。

### 6.1 运行时

- **不读取 v1。** 新代码只折叠 v2 事件；`hydrate`、种子引用、`subagent-state` 相关代码全部删除。
- 未经转换的旧会话打开后注册表为空，不报错。4.4 的已占用集合包含自有目录下的现有文件名，新建 actor 不会写进旧 actor 的文件。

### 6.2 转换脚本 `scripts/convert-subagent-storage-v2.mjs`

转换是独立的一次性脚本，不属于生产代码：

- 生产代码（`extensions/`、`src/`）不含任何 v1 识别、转换或回退逻辑，不出现 `subagent-state` 字样。
- 脚本自包含：不从 `src/` 或 `extensions/` 导入，只依赖 Node 内置模块；直接读写 JSONL，不经 `SessionManager`。v2 事件格式在脚本内按第 4.1 节写死。
- 脚本的测试放在脚本旁（`scripts/convert-subagent-storage-v2.test.mjs`），不加入默认测试套件。
- 本机转换完成后，脚本及其测试可整体删除，生产代码无需改动。

离线执行，Pi 不应同时打开被转换的会话。

**根会话文件**（`sessions/**/*.jsonl` 中含 `subagent-state` 的文件，逐个处理）：

1. 当前位置取文件最后一条条目（与 `SessionManager` 定 leaf 的规则相同），取该路径上最后一份 v1 快照。
2. 删除文件中**全部** v1 `subagent-state` 条目，并把子条目重接到最近的保留祖先；条目 id 不变。
3. 由该快照合成 v2 事件，作为新条目追加在当前 leaf 之后：
   - 每个 actor 一条 `subagent-actor`；`file` 取 v1 记录的 `sessionFile`（可能位于祖先会话目录，按 4.3 视为只读）；anchor 取 v1 `leafId`。
   - 每个 Job 一条 `subagent-job` 和一条 `subagent-job-end`。v1 中仍在运行的 Job 记为 `failed/interrupted`，区间终点取 actor anchor。
   - 从未启动的 Inherited actor：`seedLeafId` 取种子文件第 `entryCount` 条条目的 id。
4. 原文件保留为 `<file>.v1.bak`，新内容原子替换。

**不回退：** 转换后，Rewind 到合成事件之前的任何位置，或从这些位置 Fork，子 Agent 注册表都为空。旧分支上的子 Agent 状态不转换。对话条目本身全部保留，Rewind 和 Fork 对对话照常有效。

**子会话文件**（`subagent-sessions/**/*.jsonl`，包括孤儿文件）：删除继承来的 `subagent-state` 条目并重接 `parentId`；条目 id 不变，所以 anchor 与 Job 区间仍有效。同样保留 `.v1.bak`。

**其他要求：**

- 幂等：不含 v1 条目的文件跳过。
- `--dry-run` 只报告每个文件的转换前后大小、actor 与 Job 数。
- 一个子文件可能被多个根会话（Fork 链）引用，按路径去重，只处理一次。
- 转换完成后，`scripts/prune-subagent-state-checkpoints.mjs` 与 `scripts/measure-session-memory.mjs` 删除。

## 7. 测试矩阵

均以真实 `SessionManager` 文件执行，并断言根会话文件大小与常驻堆的上限。

| 场景 | 断言 |
| --- | --- |
| 单 Job 运行 N 轮 | 根会话只增加 2 条子 Agent 事件 |
| 100 个 Job 后重启 | 注册表一致；未展开任何对话 |
| 在 Job 2 结束前 Rewind，再续跑 actor | 续跑从 Rewind 点的 anchor 开始；被放弃的子分支保留 |
| Rewind 到 actor 创建前，重启，再创建 actor | 不复用被放弃分支的 agentId |
| `/fork` 后读旧 actor 历史 | 读父目录文件，成功 |
| `/fork` 后续跑旧 actor | 新目录生成路径副本并写 `subagent-relocate`；父文件字节不变 |
| 父会话与 Fork 同时续跑同一 actor | 两个文件各自增长，互不影响 |
| `/clone`、`--fork` | 同上；`--fork` 复制全部分支后折叠结果仍正确 |
| Inherited 子 Agent 的父分支含其他子 Agent 事件 | 种子不含 `subagent-*` 条目 |
| Job 运行中进程崩溃 | 恢复为 `interrupted`，区间由起点标记求得 |
| 崩溃发生在子文件首次落盘前 | Job 视为未开始，任务文本保留 |
| 未转换的旧会话加载 | 注册表为空、不报错；新建 actor 不复用目录中已有文件名 |
| Rewind 后续跑同一 actor | 新旧两个 Job 各有独立视图，内容不混合 |
| 删除视图目录后 `subagent_list` | 视图按原内容重建 |
| 终态通知中的路径 | 指向实际存在的文件 |

以下各行属于转换脚本的独立测试，不进入默认测试套件：

| 场景 | 断言 |
| --- | --- |
| 转换后加载 | 注册表与转换前当前位置的 v1 快照一致；运行中 Job 为 `interrupted`；旧 actor 可读历史、可续跑 |
| 转换后 Rewind 到合成事件之前 | 注册表为空；对话不受影响 |
| 转换 Fork 链（父会话与 Fork 共享子文件） | 子文件只处理一次；两个根会话各自加载正确 |
| 重复执行转换 | 无变化 |

## 8. 已定事项

作者已确认以下默认取舍：

1. Fork 后只在首次写入时复制 actor 文件（4.3）。Fork 依赖父会话的子文件继续存在；父会话目录被删除后，未复制的旧 actor 历史不可读，返回明确错误。
2. `/tree` 继续取消运行中的 Job。
3. 不支持同一根会话被两个进程同时打开，文档写明。
4. 暂不裁剪 Inherited 种子中压缩之前的条目；待与原生压缩插件的兼容性验证后再议。

## 9. 实施顺序

不保留兼容层，直接替换存储：

1. 重写 `src/subagent-storage.mjs`：v2 事件写入与折叠、子文件按 `file` 读写、写时复制、只读打开 LRU、ID 占用扫描。删除快照、种子引用与 `hydrate`。
2. 运行时：`exportState` 与 `#markDirty` 改为发出生命周期事件；删除每轮 `endEntryId` 落盘与 `job.messages` 常驻；`spec.inheritedContext` 只保留元数据。
3. 适配层：继承捕获过滤 `subagent-*` 条目并直接写种子文件；起点标记与中断恢复；Job 结束释放 `SessionManager`；所有子文件 I/O 改用记录中的 `file`。
4. 历史视图（4.6）：删除 `src/subagent-history.mjs` 的实时追加与跨轮摘要，改为终态写入 Job 视图并支持重建；更新工具说明与接口契约中的 `history` 描述。
5. 删除旧测试中依赖 v1 快照与 `.pi/subagents/` 路径的用例；补齐第 7 节测试。
6. 更新 `docs/architecture.md` 的存储描述。
7. 独立转换脚本及其测试（6.2）；在本机执行后可删除。
