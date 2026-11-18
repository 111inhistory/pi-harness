# Subagent 存储 v3 与离线迁移

Subagent 存储使用增量生命周期事件与独立子会话文件。根分支保存 Actor 拓扑、批次目标与恢复所需的元数据；子会话文件保存原生对话历史。运行时只解释 v3 事件，不识别、推断或恢复旧版本事件。未完成项与验收缺口见[已知问题](known-issues.md)。

## 1. 目标与问题边界

存储 v3 使用增量生命周期事件替代全量注册表快照：

- 根分支写入量随 Job 注册、身份变化与批次拓扑增长，不随每条子会话消息重写整个注册表。
- 根事件保存拓扑、批次名册、身份补丁、起点与终态元数据，不保存继承对话数组或完整模型定义。
- 子会话文件使用 Pi 原生格式，独立保存每个 Actor 的完整对话。
- 运行时依赖原生 `SessionManager` 解析历史，不重写 Pi 的历史加载器，也不承诺压缩后释放 Pi 原生根历史。

v3 的破坏性变化集中在 Actor 身份与 Job 组成：Actor 持有持久目标、共享批次上下文与启动名册，Job 只表示一次执行。v2 及更早事件不被解释，见[第 6 节](#6-版本边界与离线迁移)。

## 2. Pi 原生语义

- 根注册表只折叠 `getBranch()` 上的事件。被放弃分支的数据保留在文件中，不进入当前注册表。
- 原生会话以条目 ID 和 `parentId` 表示分支。`branch(anchor)` 改变后续写入位置，不删除旧子分支。
- Fork 产生新根会话身份。子文件归属由绝对路径决定，不仅由 Actor ID 决定。
- 会话切换与退役应使用代次围栏隔离晚到回调，禁止旧代次写入新根。

## 3. 系统不变量

1. 每个 Actor 保留独立的原生对话、持久目标、批次上下文与分支锚点。
2. 根写入量随 Job、批次和身份变化增长，不随每条子对话重写整个注册表。
3. 已封存 Job 的结果和历史区间不被续跑覆盖。
4. 读取或续跑 Fork 的旧 Actor 不写父会话文件（写时复制）。
5. 历史视图可重建，不作为状态恢复来源。
6. 运行时只解释 v3 事件；其他版本整体报告 `unsupported_version`，不猜测、不改写、不删除。
7. 不支持多个进程同时写同一根会话。IPC 端点排他不是跨进程会话数据库锁。

## 4. 架构

### 4.1 A 层：根分支事件

`src/subagent/storage.ts` 定义事件名称并校验磁盘事件，适配层使用 `pi.appendEntry(customType, data)` 写入；每条 `data.v` 均为 `3`。

| `customType` | 写入时机 | 字段 |
| --- | --- | --- |
| `subagent-job` | 注册一个 Job | `jobId`、`agentId`、`index`、`createdBy`、`continuedFromJobId`、`spec`、`origin`；Actor 的首个 Job 另带 `actor: {name, parentAgentId, depth, batch, member, goal, context, roster, kind}`，建立拓扑与批次身份 |
| `subagent-actor` | 身份建立或变化 | `agentId` 与身份补丁：`sessionFile`、`cwd`、`trusted`、`allowInherited`、`systemPrompt`、`roleId`、`roleInstructions`、`preset`、`model`、`thinkingLevel`、`tools`、`excludedTools`、`assignment`、`routed`；可带 `anchor` |
| `subagent-job-start` | 原生 Job 起点建立后 | `jobId`、`startEntryId` |
| `subagent-job-end` | 视图收尾后统一发布一次 | `jobId`、`status`、`result`、`error`、`history: {startEntryId, endEntryId}`、`budget`；可带 `historyState`、`historyError`，不改写模型结果 |
| `subagent-anchor` | Job 终态以外的锚点移动 | `agentId`、`anchor` |

`subagent-actor` 不单独创建拓扑。身份补丁只写变化字段：`goal`、`context`、`roster` 属于 Actor 拓扑，只在首个 `subagent-job` 写入一次，不随后续 Job 或续跑重复。`preset` 固定所选名称与命名或临时 Preset 的配置正文，不保存目录、认证或运行句柄；原生子分支的 `preset-state` 固定实际应用的工具基线、Codemode 和指引。续跑使用已有身份与分支快照，不重新读取配置文件。

`spec` 只保存执行组成：`{kind: "initial"|"continuation"}`，以及存在继承时的 `inheritedContext`。持久化的 `inheritedContext` 仅含模型身份、思考强度、提示词、工具白名单与种子引用等元数据，不含对话条目数组；目标、共享上下文与名册由 Actor 持有，不重复写入 Job。

Actor 身份由本地 key（`sub_<batch>` 或 `sub_<batch>-<member>`）、`batch`、`member`、`parentAgentId`、`depth`、`goal`、`context`、`roster` 与 `kind`（`fresh`／`inherited`）组成。恢复时校验这些字段与 key 的编码一致；不一致报告 `storage_corrupt`，不按名称猜测。完整逻辑地址由根会话 uid 与本地 key 在读取时派生，不单独持久化，因此不随端点或路径变化。

持久化名册成员为 `{id, name, goal}`，其中 `id` 是 session 内的 Actor key；公开 `CreatedBatch.roster`、`JobRequest.roster` 与提示词名册仍使用 `{address, name, goal}`。Fork 恢复时按新根身份生成完整地址，不沿用父 session 的前缀。

`batch` 是会话范围单调递增的编号，分配时取「全部分支与本目录已有文件」的最大值加一；Rewind、Fork 或放弃的分支都不会让编号被复用。

恢复按当前分支顺序折叠事件，再由 Runtime 统一校验拓扑、Job 所有者、续跑关系和中断裁决。Actor 层只提供原生文件与区间信息，不预先发布终态。默认流程不写周期快照，也不在每次模型回复后写用量事件。

根追加由 `root-service.ts` 持有。会话切换在 SDK BEFORE 钩子内等待原 Job 终态写入；代次失效后禁止写入新分支。写盘错误锁存并阻止切换报告为成功。超时或强制退出时可能需要中断恢复，系统不承诺跨文件事务。

### 4.2 B 层：子会话文件

子文件位于 `$PI_CODING_AGENT_DIR/subagent-sessions/<rootId>/<agentId>.jsonl`，使用原生 Pi 格式。

- Job 开始时，根分支的 `subagent-job-start` v3 事件以 `startEntryId` 记录子会话当时已有的叶条目 ID，建立可恢复起点。子文件不写入 `subagent-*` 标记；读取该轮历史时，从起点条目之后开始切片。
- 根 Job 没有终态事件时，重启将其恢复为 `failed`，错误为 `job_interrupted`。结束位置从对应原生分支求取，之后追加恢复终态。
- continuation 已登记但尚未写入起点时，恢复区间从 Actor 已封存的 checkpoint 之后开始；没有后续原生条目则起止相同，历史为空，不重放前一轮对话。
- 文件或起点尚未落盘时，不视为已执行，保留 Actor 的目标供后续重述。
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

### 4.4 Rewind 与身份分配

Rewind 后，注册表由目标根分支重新折叠。续跑使用目标 `anchor`；旧子分支和孤儿文件不因 Rewind 删除。

ID 占用扫描覆盖根文件全部分支的 Actor 与 Job 事件、自有子文件和 Job 视图目录。分配新 Actor key、批次编号或 Job id 时都不复用被放弃分支已占用的身份。Actor 地址在其生命周期内稳定，续跑不重新编号。

### 4.5 内存模型

| 保留的数据 | 按需读取或释放的数据 |
| --- | --- |
| 根 `SessionManager`、Actor 与 Job 元数据和结果文本 | 已结束的持久化子会话 manager 在清理后解除引用；下次续跑或读取再打开 |
| 运行中 Job 的 live 会话 | 已结束持久化 Job 的对话按原生区间读取，不把完整对话附在 Job 元数据中 |
| 捕获的 Inherited 历史条目（跨子会话按只读引用共享） | 每个子会话自己的条目数组、header、分支索引与叶指针（随 manager 释放） |
| 纯内存 Actor 的唯一对话 | 持久化 Inherited 种子写入后删除 Job 对数组的引用 |

临时打开的 manager 不跨操作缓存。已有 live manager 时优先复用。纯内存 Actor 不能套用持久化文件的释放规则。

实时执行阶段（thinking／output／tool_call）与父节点等待状态只在读取列表时计算，不写入根事件，也不逐 token 落盘。

### 4.6 可读历史视图

`src/subagent/view.ts` 从 Job 元数据和原生区间派生文件：

```text
subagent-sessions/<rootId>/views/<jobId>/summary.md
subagent-sessions/<rootId>/views/<jobId>/transcript.jsonl
subagent-sessions/<rootId>/views/<jobId>/result.txt
```

一个 Job 对应一份视图，不按 Actor 跨轮追加。`summary.md` 保存共享目标、状态、用量、结果和续跑关系；`transcript.jsonl` 保存该 Job 的清洗区间；`result.txt` 原样保存该轮最终回复文本，供按需补读。

视图不参与状态恢复。文件缺失时由 Root 列表层在当前根目录重建，再通过 `history.summary`、`history.cleanJsonl`、`history.result` 返回路径。原始结果取自 Job 保存的结果字段，不从累计对话重新推断。每份视图独立捕获错误，损坏历史不阻断其余 Actor 状态。Runtime 的列表投影本身不执行视图写入。Fork 不为生成视图写父目录。当前分支不可见的 Job 不进入列表。

Job 终态不再向创建者模型投递自动结果消息；视图与 Job 记录是该结果的唯一持久来源。内存会话不生成持久化视图，也不使用临时结果文件；其结果只存在于进程内 Job 记录。

## 5. 关键流程

- Fresh：注册 Job 及首次拓扑（含目标、共享上下文与名册）→ 路由并保存身份 → 打开子会话 → 写起点 → 原生执行。
- Inherited：捕获并过滤父分支 → 写种子 → 注册 Job 并保存身份 → 写起点 → 原生执行。
- 结束：原生退出与清理 → 冻结候选终态 → 生成视图并记录历史写入状态 → Runtime 统一发布一次根终态 → 内部唤醒创建者；不生成结果消息。
- 等待子任务（parent-hold）：保留当前 Job 与会话，不写终态；暂停活跃时间计费，消息、子任务终结或异步 Shell 完成后在同一轮内继续。取消或失败按正常终态路径收尾。
- 续跑：显式消息向停止节点注册新的 continuation Job → 必要时写时复制 → 定位锚点 → 写新起点 → 原生执行。子节点终结不注册 continuation Job。
- 恢复：折叠当前分支 v3 事件 → 校验拓扑与身份 → 未结束 Job 以 `job_interrupted` 失败收尾。恢复不自动重跑、重发消息或推断旧版本状态。

## 6. 版本边界与离线迁移

### 6.1 运行时边界

运行时只折叠 v3 事件。遇到其他版本时：

- 报告 `unsupported_version`（字节完整、版本不受支持），而不是 `storage_corrupt`。
- Subagent 服务以可操作的错误失败：提示启动新根会话或在离线环境显式转换；不停止原生 Main 对话加载，不删除或改写旧文件。
- 不提供运行时回退、自动升级、猜测字段或兼容别名。

### 6.2 离线脚本

`scripts/plan-subagent-storage-v3.mjs` 只读扫描根会话，生成 v2 → v3 的批次与 Actor／Job 映射计划，不提供 apply 模式，不改写根或子会话。

```sh
node scripts/plan-subagent-storage-v3.mjs --agent-dir /tmp/agent --output /tmp/subagent-v3-plan.json
# 也可用 --session FILE 限定一个根会话；输出文件必须不存在
```

输出文件使用 `wx` 禁止覆盖，并设置 `0600` 模式（POSIX）；计划保留源文件哈希与读前／读后身份。批次根据原生父链和注册索引还原；v1、混合版本、坏行及无法证明的拓扑明确排除。`planReady` 只表示所选范围的计划可生成，不证明目标已离线；`requiresOfflineCheck` 与 `runtimeValidated: false` 明确保留后续验收边界。Capability 的工具引用协调尚未纳入转换，生成计划不等于可直接应用。方案见[迁移准备](reviews/subagent-storage-v3-migration.md)。

`scripts/convert-subagent-storage-v2.mjs` 是历史 v1 → v2 的一次性离线工具，只识别 `subagent-state` 旧检查点并生成 v2 事件。它**不能**生成 v3，也不能让 v2 根会话被当前运行时读取；不要把它的成功当作 v3 已支持。

- 脚本只依赖 Node.js 内置模块，直接读写 JSONL，不导入生产模块。
- 警告：不要在 Pi 仍使用目标根会话或共享子文件时原地转换。内存中的旧状态可能写回文件。先备份，并确认目标未在使用。
- 历史用法与审计见[归档：Subagent 迁移批次](archive/subagent-migration-batch.md)与[迁移冒烟记录](archive/subagent-migration-smoke.md)。
- `scripts/migrate-subagent-storage-v3.mjs` 是单根会话的显式 v2 → v3 离线入口。默认只生成新计划；`--apply --offline` 才写入，不能批量隐式改写其他根。生产模块仍不包含旧格式读取或迁移专用导出。

```sh
node scripts/migrate-subagent-storage-v3.mjs \
  --session /tmp/agent/sessions/project/session.jsonl --agent-dir /tmp/agent \
  --socket-root /tmp/pi-session-example --apply --offline
```

应用前应退出目标 Pi。脚本拒绝当前 Agent 环境指向的活动目标；指定 `--socket-root` 时也检查匹配的受管 session 记录，发现存活 PID 则拒绝，不停止进程或删除端点。`--offline` 是操作者对离线状态的明确确认，不能代替关闭目标会话。

每次应用重新生成计划，拒绝 v1、混合版本、坏行及有歧义的根。脚本先创建独占恢复副本和同文件系统的暂存输出，流式替换计划内的事件数据；非目标字节、换行、条目 ID、父链接及时间戳保持不变。落盘后重新读取并核对恢复副本和暂存文件的哈希，再以原子 rename 替换目标；不写子会话文件，不自动回滚。结果返回恢复副本路径、源／备份／目标哈希及显式恢复命令。恢复也必须在目标离线时执行。

此工具只转换 Subagent 结构化元数据。Capability 引用协调与继承状态仍属单独验收范围；报告保留对应限制，不宣称全部执行状态已迁移。

## 7. 验证范围

默认回归覆盖事件折叠、分支隔离、批次与 Actor 身份校验、身份补丁、写时复制、Job 视图、停止与恢复。Linux 上以真实 Pi SDK 与本地模拟模型运行；Windows 侧目前以交叉构建与平台适配测试验证，完整离线实机套件尚未作为当前声明。长期压力、多用户切换与管道权限隔离等未验证场景见[已知问题](known-issues.md)。
