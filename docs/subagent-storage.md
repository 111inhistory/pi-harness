# Subagent 存储 v2 与离线迁移

Subagent 会话存储使用增量生命周期事件与独立子会话文件。根分支保存 Actor 拓扑与恢复所需的元数据；子会话文件保存原生对话历史。运行时只折叠并解释 v2 事件，不识别或恢复旧版检查点。未完成项与验收缺口见[已知问题](known-issues.md)。

## 1. 目标与问题边界

存储 v2 使用增量生命周期事件替代全量注册表快照：

- 根分支写入量随 Job 注册与身份变化增长，不随每条子会话消息重写整个注册表。
- 根事件保存拓扑、身份补丁、起点与终态元数据，不保存继承对话数组或完整模型定义。
- 子会话文件使用 Pi 原生格式，独立保存每个 Actor 的完整对话。
- 运行时依赖原生 `SessionManager` 解析历史，不重写 Pi 的历史加载器，也不承诺压缩后释放 Pi 原生根历史。

## 2. Pi 原生语义

- 根注册表只折叠 `getBranch()` 上的事件。被放弃分支的数据保留在文件中，不进入当前注册表。
- 原生会话以条目 ID 和 `parentId` 表示分支。`branch(anchor)` 改变后续写入位置，不删除旧子分支。
- Fork 产生新根会话身份。子文件归属由绝对路径决定，不仅由 Actor ID 决定。
- 会话切换与退役应使用代次围栏隔离晚到回调，禁止旧代次写入新根。

## 3. 系统不变量

1. 每个 Actor 保留独立的原生对话与分支锚点。
2. 根写入量随 Job 和身份变化增长，不随每条子对话重写整个注册表。
3. 已封存 Job 的结果和历史区间不被续跑覆盖。
4. 读取或续跑 Fork 的旧 Actor 不写父会话文件（写时复制）。
5. 历史视图可重建，不作为状态恢复来源。
6. 运行时只解释 v2 事件，不识别、转换或恢复 v1 检查点。
7. 不支持多个进程同时写同一根会话。IPC 端点排他不是跨进程会话数据库锁。

## 4. 架构

### 4.1 A 层：根分支事件

`src/subagent/storage.ts` 定义事件名称并校验磁盘事件，适配层使用 `pi.appendEntry(customType, data)` 写入；`data.v = 2`。

| `customType` | 写入时机 | 字段 |
| --- | --- | --- |
| `subagent-job` | 注册一个 Job | `jobId`、`agentId`、`index`、`createdBy`、`continuedFromJobId`、`spec`、`origin`；首次 Job 另带 `actor: {name, parentAgentId, depth}`，建立 Actor 拓扑 |
| `subagent-actor` | 身份建立或变化 | `agentId` 与身份补丁：`sessionFile`、`cwd`、`trusted`、`allowInherited`、`systemPrompt`、`roleId`、`roleInstructions`、`preset`、`model`、`thinkingLevel`、`tools`、`excludedTools`、`assignment`、`routed`；可带 `anchor` |
| `subagent-job-start` | 原生 Job 起点建立后 | `jobId`、`startEntryId` |
| `subagent-job-end` | 视图收尾后统一发布一次 | `jobId`、`status`、`result`、`error`、`history: {startEntryId, endEntryId}`、`budget`；可带 `historyState`、`historyError`，不改写模型结果 |
| `subagent-anchor` | Job 终态以外的锚点移动 | `agentId`、`anchor` |

`subagent-actor` 不单独创建拓扑。写时复制通过身份补丁记录新 `sessionFile`，不另设重定向事件。身份未变化的字段不重复写入；模型仅保存 provider 和 model id。`preset` 固定所选名称与命名或临时 Preset 的配置正文，不保存目录、认证或运行句柄；原生子分支的 `preset-state` 固定实际应用的工具基线、Codemode 和指引。续跑使用已有身份与分支快照，不重新读取配置文件。

恢复按当前分支顺序折叠事件，再由 Runtime 统一校验拓扑、Job 所有者、续跑关系和中断裁决。Actor 层只提供原生文件与区间信息，不预先发布终态。默认流程不写周期快照，也不在每次模型回复后写用量事件。

根追加由 `root-service.ts` 持有。会话切换在 SDK BEFORE 钩子内等待原 Job 终态写入；代次失效后禁止写入新分支。写盘错误锁存并阻止切换报告为成功。超时或强制退出时可能需要中断恢复，系统不承诺跨文件事务。

### 4.2 B 层：子会话文件

子文件位于 `$PI_CODING_AGENT_DIR/subagent-sessions/<rootId>/<agentId>.jsonl`，使用原生 Pi 格式。

- Job 开始时，根分支的 `subagent-job-start` v2 事件以 `startEntryId` 记录子会话当时已有的叶条目 ID，建立可恢复起点。子文件不写入 `subagent-*` 标记；读取该轮历史时，从起点条目之后开始切片。
- 根 Job 没有终态事件时，重启将其恢复为 `failed`，错误为 `job_interrupted`。结束位置从对应原生分支求取，之后追加恢复终态。
- 文件或起点尚未落盘时，不视为已执行，保留任务文本供后续重述。
- Inherited 种子在创建时过滤 `subagent-*` 条目，再写入子文件。捕获时不额外裁剪压缩前的原生对话；末尾未完成的工具调用按快照规则过滤。持久化 Job 只保留 `seedFile`、`seedLeafId` 等元数据，不常驻 `entries` 数组。
- 原生条目中的签名和扩展字段原样保留。

捕获与种子不复制整份历史。原生会话按追加写入：`SessionManager` 只向自己的条目数组 push 新条目并移动叶指针，context edit 以新条目记录替换对象，历史条目本身不再改写。因此容器、header 与索引归每个子会话，历史 entry 与消息正文按不可变数据共享。

| 数据 | 所有者 | 写入方式 |
| --- | --- | --- |
| 历史 entry 与消息正文 | 父会话的原生 `SessionManager`；捕获、种子和子会话只读引用 | 追加新条目，不改写已有条目 |
| 捕获数组与 header 副本 | 批次捕获；非持久化模式下每个 Inherited 子会话一份 | 新数组、新 session header id；条目按引用共享 |
| 条目数组、header、分支索引与叶指针 | 每个子 `SessionManager` | 追加 push、`branch` 移动叶指针；header 使用新 id |
| 模型可见上下文 | SDK 投影 | 每次按 compaction 摘要、`firstKeptEntryId` 区间与后续条目投影，不缓存副本 |

共享条目只来自当前版本的活动会话；旧版本 header 的条目原地迁移在加载阶段完成，不会改写捕获后共享的条目。持久化模式为每个子文件写入新 header 与种子正文，不共享条目数组。

### 4.3 所属权与 Fork：写时复制

根会话只写自有目录中的子文件。Actor 的权威文件为记录中的 `sessionFile`，锚点为折叠状态中的 `anchor`。

1. 读取外部文件时，只读打开记录中的路径。
2. 首次写入外部文件时，复制 `getBranch(anchor)` 到当前根会话目录，保留条目 ID，使用新 Header 并记录 `parentSession`。
3. 将新路径和锚点写入身份补丁。
4. 在新文件的锚点后续跑。

已有的自有副本只有在来源和锚点一致时才可复用。父会话文件被删除后，尚未复制的外部历史返回明确错误，不返回空数据。

### 4.4 Rewind

Rewind 后，注册表由目标根分支重新折叠。续跑使用目标 `anchor`；旧子分支和孤儿文件不因 Rewind 删除。

ID 占用扫描覆盖根文件全部分支的 Actor 与 Job 事件、自有子文件和 Job 视图目录。分配新 ID 时不复用被放弃分支已占用的身份。

### 4.5 内存模型

| 保留的数据 | 按需读取或释放的数据 |
| --- | --- |
| 根 `SessionManager`、Actor 与 Job 元数据和结果文本 | 已结束的持久化子会话 manager 在清理后解除引用；下次续跑或读取再打开 |
| 运行中 Job 的 live 会话 | 已结束持久化 Job 的对话按原生区间读取，不把完整对话附在 Job 元数据中 |
| 捕获的 Inherited 历史条目（跨子会话按只读引用共享） | 每个子会话自己的条目数组、header、分支索引与叶指针（随 manager 释放） |
| 纯内存 Actor 的唯一对话 | 持久化 Inherited 种子写入后删除 Job 对数组的引用 |

临时打开的 manager 不跨操作缓存。已有 live manager 时优先复用。纯内存 Actor 不能套用持久化文件的释放规则。

### 4.6 可读历史视图

`src/subagent/view.ts` 从 Job 元数据和原生区间派生文件：

```text
subagent-sessions/<rootId>/views/<jobId>/summary.md
subagent-sessions/<rootId>/views/<jobId>/transcript.jsonl
subagent-sessions/<rootId>/views/<jobId>/result.txt
```

一个 Job 对应一份视图，不按 Actor 跨轮追加。`summary.md` 保存任务、状态、用量、结果和续跑关系；`transcript.jsonl` 保存该 Job 的清洗区间；`result.txt` 原样保存该轮最终回复文本，供截断通知补读。

视图不参与状态恢复。文件缺失时由 Root 列表层在当前根目录重建，再通过 `history.summary`、`history.cleanJsonl`、`history.result` 返回路径。原始结果取自 Job 保存的结果字段，不从累计对话重新推断。每份视图独立捕获错误，损坏历史不阻断其余 Actor 状态。Runtime 的列表投影和终态通知本身不执行视图写入。Fork 不为生成视图写父目录。当前分支不可见的 Job 不进入列表。

## 5. 关键流程

- Fresh：注册 Job 及首次拓扑 → 路由并保存身份 → 打开子会话 → 写起点 → 原生执行。
- Inherited：捕获并过滤父分支 → 写种子 → 注册 Job 并保存身份 → 写起点 → 原生执行。
- 结束：原生退出与清理 → 冻结候选终态 → 生成视图并记录历史写入状态 → Runtime 统一发布一次根终态 → 通知父节点。
- 等待子任务（parent-hold）：保留当前 Job 与会话，不写终态；暂停活跃时间计费，消息或子任务终结后在同一轮内继续。取消或失败按正常终态路径收尾。
- 续跑：显式消息向停止节点注册新的 continuation Job → 必要时写时复制 → 定位锚点 → 写新起点 → 原生执行。子节点终态通知不注册 continuation Job。

内存模式（非持久化模式）不生成持久化历史视图。结果超过通知上限时，Root 写入系统临时文件。临时文件由 `src/subagent/temporary-results.ts` 统一管理，在根服务退役与 `/reload` 时保持存活。Node.js 进程正常退出时清理临时文件，通知携带该临时文件路径。

每轮由 Runtime 独立通知父节点，通知直接携带有界的本轮结果。普通消息和终态不合并，不自动重发。迁移或恢复不自动重跑已结束的任务。

## 6. 兼容性与转换

### 6.1 运行时边界

运行时只折叠已知 v2 事件。含旧检查点的分支不会因为存在旧条目被拒绝，但旧条目不恢复注册表。分配 ID 时仍避开已经存在的自有文件。

生产代码不包含 v1 检查点转换、回退或自动升级逻辑。

### 6.2 独立离线迁移脚本

`scripts/convert-subagent-storage-v2.mjs` 只依赖 Node.js 内置模块，直接读写 JSONL，不导入生产模块或使用 `SessionManager`。

警告：不要在 Pi 仍使用目标根会话或共享子文件时原地转换。内存中的旧状态可能写回文件。先备份，并确认目标未在使用。

转换只保留当前位置的注册表，不保留每个 v1 历史位置的注册表。Rewind 到合成事件之前时，旧 Subagent 状态为空；原生对话条目仍保留。

- `--dry-run` 只报告转换前后大小、Actor 与 Job 数，不写文件。
- `--apply --offline` 在完整预检后保留 `<file>.v1.bak`，再原子替换。已有不同内容的备份不覆盖。
- `--session FILE` 限定一个根会话及其自有子文件的写入。已清理的外部文件仅供读取；仍含旧检查点的共享文件要求先处理其所有者。
- 根文件只选择当前路径上的最后一份 v1 状态，删除旧检查点并修复父链接，再合成当前 v2 事件。
- 每个 Job 注册一次并写终态；转换时未结束的 Job 记为 `job_interrupted`。未启动的继承任务从原种子前缀换算 `seedLeafId`。
- 子文件去除旧检查点；锚点和原生结构引用随之调整。工具正文、签名及不透明原生字段不重新格式化。
- 删除末尾检查点可能改变原生默认 leaf 时，仅追加空元数据标记保留原分支。
- 跳过无旧条目的文件。文件被多个根引用时不重复改写；子文件先转换后中断时，可借原始备份继续。

历史转换审计与迁移复核见归档文档（如 [archive/subagent-migration-batch.md](archive/subagent-migration-batch.md)）。

## 7. 验证范围

默认回归覆盖事件折叠、分支隔离、身份补丁、写时复制、Job 视图、停止和恢复。Linux 与 Windows 的完整离线套件已运行；长期压力、多用户切换与管道权限隔离等未验证场景见[已知问题](known-issues.md)。
