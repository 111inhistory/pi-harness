# Subagent 存储 v2 与离线迁移

存储 v2 与旧历史迁移已落地。当前 TS 调用链通过真实 SDK 的本地模型回归；此前在线续跑属于迁移阶段样本，不代表新调用链的在线验收。长时间压力、多用户与 Windows 实机仍未完成。历史记录见[插件内存收敛](reviews/subagent-memory-review.md)和[批量迁移](reviews/subagent-migration-batch.md)。

## 1. 目标与问题边界

存储 v2 用增量生命周期事件替代反复写入的全量注册表。根分支保存恢复所需的元数据；子会话文件保存对话。根事件不包含继承对话数组或完整模型定义。

原有膨胀、恢复和 Fork 缺陷的实测留在[接入前复核](reviews/subagent-storage-v2-groundwork-review.md)。本页说明当前实现，不沿用旧快照格式作为运行契约。

Pi 原生 `SessionManager` 仍保留其解析的历史。插件不重写 Pi 的历史加载器，也不承诺压缩后释放 Pi 自身的根历史。

## 2. Pi 原生语义

- 根注册表只折叠 `getBranch()` 上的事件。被放弃分支的数据保留在文件中，不进入当前注册表。
- 原生会话以条目 ID 和 `parentId` 表示分支。`branch(anchor)` 改变后续写入位置，不删除旧子分支。
- Fork 或 Clone 产生新根会话身份。子文件归属由绝对路径决定，不仅由 Actor ID 决定。
- `/tree`、切换根会话和服务退役会取消旧服务的运行中 Job；旧回调不能转投新服务。

## 3. 目标与不变量

1. 每个 Actor 保留独立的原生对话与分支锚点。
2. 根写入量随 Job 和身份变化增长，不随每条子对话重写整个注册表。
3. 已封存 Job 的结果和历史区间不被续跑覆盖。
4. 读取或续跑 Fork 的旧 Actor 不写父会话文件。
5. 历史视图可重建，不作为状态恢复来源。
6. 运行时只解释 v2 事件，不识别、转换或恢复 v1 检查点。

## 4. 架构

### 4.1 A 层：根分支事件

`src/subagent-storage.mjs` 定义事件，适配层使用 `pi.appendEntry(customType, data)` 写入；`data.v = 2`。

| `customType` | 写入时机 | 字段 |
| --- | --- | --- |
| `subagent-job` | 注册一个 Job | `jobId`、`agentId`、`index`、`createdBy`、`continuedFromJobId`、`spec`、`origin`；首次 Job 另带 `actor: {name, parentAgentId, depth}`，建立 Actor 拓扑 |
| `subagent-actor` | 身份建立或变化 | `agentId` 与身份补丁：`sessionFile`、`cwd`、`trusted`、`allowInherited`、`systemPrompt`、`roleId`、`roleInstructions`、`model`、`thinkingLevel`、`tools`、`excludedTools`、`assignment`、`routed`；可带 `anchor` |
| `subagent-job-start` | 原生 Job 起点建立后 | `jobId`、`startEntryId` |
| `subagent-job-end` | 视图收尾后统一发布一次 | `jobId`、`status`、`result`、`error`、`history: {startEntryId, endEntryId}`、`budget`；可带 `historyState`、`historyError`，不改写模型结果 |
| `subagent-anchor` | Job 终态以外的锚点移动 | `agentId`、`anchor` |

`subagent-actor` 不单独创建拓扑。写时复制通过身份补丁记录新 `sessionFile`，不另设 relocate 事件。身份没有变化的字段不重复写入；模型仅保存 provider/id。

恢复按当前分支顺序折叠事件，再由 Runtime 统一校验拓扑、Job 所有者、续跑关系和中断裁决。Actor 层只提供原生文件与区间信息，不预先发布终态。默认流程不写周期快照，也不在每次模型回复后写用量事件。

根追加由 `root-service.ts` 持有。正常导航在 SDK BEFORE 钩子内等待原 Job 终态写入；代次失效后禁止写入新分支。写盘错误锁存并阻止导航被报告为成功。超时或强制退出仍可能需要中断恢复，不承诺跨文件事务。

### 4.2 B 层：子会话文件

子文件位于 `$PI_CODING_AGENT_DIR/subagent-sessions/<rootId>/<agentId>.jsonl`，使用原生 Pi 格式。

- Job 开始时，子文件写入原生 `subagent-job-start` 标记。根分支的同名 v2 事件记录标记 ID，建立可恢复起点。
- 根 Job 没有终态事件时，重启将其恢复为 `failed`，错误为 `job_interrupted`。结束位置从对应原生分支求取，之后追加恢复终态。
- 文件或起点尚未落盘时，不假装已经执行；保留任务文本供后续重述。
- Inherited 种子在创建时过滤 `subagent-*` 条目，再写入子文件。持久化 Job 只保留 `seedFile`、`seedLeafId` 等元数据，不保留 `entries` 数组。
- 原生条目中的 thinking/text 签名和扩展字段保留，不转成自制消息数据库。

### 4.3 所属权与 Fork：写时复制

根会话 R 只写自己目录中的子文件。Actor 的权威文件是记录里的 `sessionFile`，锚点是折叠状态中的 `anchor`。

1. 读取外部文件时，只读打开记录中的路径。
2. 首次写入外部文件时，复制 `getBranch(anchor)` 到 R 的目录，保留条目 ID，使用新 Header 并记录 `parentSession`。
3. 将新路径和锚点写入身份补丁。
4. 在新文件的锚点后续跑。

已有的自有副本只有在来源和锚点一致时才能复用，不覆盖不同分支的文件。父会话文件被删除后，尚未复制的外部历史返回明确错误，不静默返回空。

### 4.4 Rewind

Rewind 后，注册表由目标根分支重新折叠。续跑使用目标 `anchor`；旧子分支和孤儿文件不因 Rewind 删除。

ID 占用扫描覆盖根文件全部分支的 Actor／Job 事件、自有子文件和 Job 视图目录。分配新 ID 时不复用被放弃分支已经占用的身份。

### 4.5 内存模型

| 保留的数据 | 按需读取或释放的数据 |
| --- | --- |
| 根 `SessionManager`、Actor／Job 元数据和结果文本 | 已结束的持久化子会话 manager 在清理后解除引用；下次续跑或读取再打开 |
| 运行中 Job 的 live 会话 | 已结束 Job 的对话按原生区间读取，不常驻 `job.messages` |
| 纯内存 Actor 的唯一对话 | 持久化 Inherited 种子写入后删除 Job 对数组的引用 |

临时打开的 manager 不跨操作缓存。已有 live manager 时优先复用。纯内存 Actor 不能套用持久化文件的释放规则。

### 4.6 可读历史视图

`src/subagent-view.mjs` 从 Job 元数据和原生区间派生文件：

```text
subagent-sessions/<rootId>/views/<jobId>/summary.md
subagent-sessions/<rootId>/views/<jobId>/transcript.jsonl
```

一个 Job 一份视图，不按 Actor 跨轮追加。`summary.md` 保存任务、状态、用量、结果和续跑关系；`transcript.jsonl` 保存该 Job 的清洗区间。

视图不参与恢复。缺失时由 Root 列表层在当前根目录重建，再通过 `history.summary`、`history.cleanJsonl` 返回路径。每项分别捕获错误；一份损坏历史不阻断其余 Actor 状态。Runtime 的列表投影和终态通知本身不执行视图写入。Fork 不为生成视图写父目录。当前分支不可见的 Job 不进入列表。

旧 `src/subagent-history.mjs` 和跨轮追加实现已删除。旧项目目录 `.pi/subagents/` 不参与恢复，转换脚本也不处理该目录。

## 5. 关键流程

- Fresh：注册 Job 及首次拓扑 → 路由并保存身份 → 打开子会话 → 写起点 → 原生执行。
- Inherited：捕获并过滤父分支 → 写种子 → 注册 Job 并保存身份 → 写起点 → 原生执行。
- 结束：原生退出与清理 → 冻结候选终态 → 生成视图并记录历史写入状态 → Runtime 统一发布一次根终态 → 通知父节点。
- 续跑：注册新的 continuation Job → 必要时写时复制 → 定位锚点 → 写新起点 → 原生执行。

每轮由 Runtime 独立通知父节点。普通消息和终态不合并，不为迁移或恢复重新执行已经结束的任务。

## 6. 兼容性与转换

### 6.1 运行时

运行时只折叠已知 v2 事件。含旧检查点的分支不会因为存在旧条目被拒绝，但旧条目不恢复注册表。分配 ID 时仍避开已经存在的自有文件。

生产目录不包含 v1 转换、回退或自动升级逻辑。

### 6.2 独立离线脚本

`scripts/convert-subagent-storage-v2.mjs` 只依赖 Node 内置模块，直接读写 JSONL，不导入生产模块或使用 `SessionManager`。迁移工具按用户要求保留，暂不清理。

警告：不要在 Pi 仍使用目标根会话或共享子文件时原地转换。内存中的旧状态可能继续写回文件。先备份，并确认目标不在使用。

- `--dry-run` 只报告转换前后大小、Actor／Job 数，不写文件。
- `--apply --offline` 在完整预检后保留 `<file>.v1.bak`，再原子替换。已有不同内容的备份不覆盖。
- `--session FILE` 限定一个根会话及其自有子文件的写入。已清理的外部文件仅供读取；仍含旧检查点的共享文件要求先处理其所有者。
- 根文件只选择当前路径上的最后一份 v1 状态，删除全部旧检查点并修复父链接，再合成当前 v2 事件。
- 每个 Job 注册一次并写终态；转换时未结束的 Job 记为 `job_interrupted`。未启动的继承任务从原种子前缀换算 `seedLeafId`。
- 子文件去除旧检查点；锚点和原生结构引用随之调整。工具正文、签名及不透明原生字段不重新格式化。
- 删除末尾检查点可能改变原生默认 leaf 时，仅追加空元数据标记保留原分支。
- 无旧条目的文件跳过。文件被多个根引用时不重复改写；中断的子文件优先转换可借原始备份继续。

转换只保留当前位置的注册表，不保留各 v1 历史位置的注册表。Rewind 到合成事件之前，旧 Subagent 状态为空；原生对话条目仍保留。

### 6.3 已完成的真实数据处理

先备份根文件和子文件，共约 4.2 GB、223 个文件，并生成校验清单。10 个非当前根会话原地转换。

最后两份占用中的对话按用户要求创建新会话：复制所需子文件，保留原件；新副本使用 `[v2迁移]` 名称。新主副本中的两个旧失败占位与 v2 ID 冲突，已按用户确认的规则换为未占用编号，不丢弃任务元数据或改动原生对话 ID。详细路径、数量与备份见[批量记录](reviews/subagent-migration-batch.md)。

原件刻意保留 v1 数据，不表示新副本仍待转换。

## 7. 验证范围

默认回归覆盖事件折叠、分支隔离、身份补丁、原生签名保留、写时复制、持久化与纯内存引用释放、Job 视图、停止和恢复。

作者决定不编写迁移测试矩阵。实际先带备份转换一个旧会话，人工检查加载、列表、历史和真实模型续跑；批量阶段检查注册表及已有历史区间，不重跑原任务。

通过默认回归或单样本验收，不等于完成 Linux 长时间压力、多用户或 Windows 实机验证。

## 8. 已定事项

1. Fork 默认只在首次写入时复制子文件；未复制的历史依赖父目录保留。
2. `/tree` 继续取消运行中的 Job。
3. 不支持多个进程同时写同一根会话。端点保护不是跨进程会话数据库锁。
4. 不额外裁剪 Inherited 种子中压缩前的条目；外部压缩兼容性另行处理。
5. 用户查看界面、远端审批和 Windows 暂缓，迁移工具不急于清理。

## 9. 实施结果

存储、Runtime、适配层和 Job 视图已接通；完整快照、`hydrate`、每轮历史重写与旧历史模块已移除。独立转换和真实数据迁移已完成，原件及备份保留。当前默认回归与提示词状态见[正文外置记录](reviews/prompt-extraction-review.md)。
