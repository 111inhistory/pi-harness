# 接口契约

## 状态与范围

本文规定 Harness 对外公开接口契约、使用流程与运行时行为边界。

实现职责见[当前架构](architecture.md)，参数与配置见[Harness 参数配置](harness-configuration.md)，未完成项与验收缺口见[已知问题](known-issues.md)。本文不规定内部模块划分、消息队列实现或用户界面形式。

## 术语

| 名称 | 含义 |
| --- | --- |
| Main | 主 Agent |
| 父 Agent | 委派任务、接收子 Agent 消息和通知的 Agent |
| 执行轮次 | 同一个 Subagent 的一次执行；续跑属于新的执行轮次 |
| 普通消息 | Agent 显式发送的消息 |
| 终态通知 | 宿主在一轮执行结束后产生的通知 |
| 待投递 | 消息尚未写入接收方的 Pi 会话历史；写入不等于模型已读 |

## Capability

### 已确认的使用流程

Main 先理解任务，必要时初步了解项目。只有存在能力或指导缺口、否则要自行摸索或重复造轮子时，才调用 `capability`。

已有资源足以继续工作时，不必调用。相同任务阶段转换、开始写文档或开始架构设计，都不单独构成再次调用的理由。

Capability 根据任务和已有上下文，判断当前工作缺少什么，再搜索能补足工作的资源：

- Tool／MCP：执行任务的工具。
- Skill：能力、方法、指引和信息，不限于操作教程。

Main 不必先穷举资源名称或完整说明能力缺口，但应先判断是否确有缺口。Capability 也不只是基础工具失败后的备用搜索。

发现结果应在后续工作中复用。只有出现尚未覆盖的新需求、已有资源不适用或资源不可用时，才重新检索。

### 主 Agent 的可见范围

Capability 应避免让 Main 接触与当前工作无关的资源目录和检索过程。Main 接收筛选后的本地资源，而不是全部候选。

“不向 Main 暴露”的范围应区分：

- 全量目录和内部检索过程：不提前展示给 Main，避免分心。
- 筛选后的本地资源：交给 Main 使用。
- 远端候选：不返回 Main，转入用户审批流程（当前延期，不搜索远端）。

### 原生发现入口与 Codemode

**Capability 是 Tool／MCP／Skill 的发现入口。Codemode 仍可启用，但只负责执行和组合调用。**

配套入口 `extensions/harness.ts` 应执行以下边界：

- 禁用原生 `tool_search`，不向模型默认注入 `<mcp_servers>`。
- 不在 Codemode 沙箱中注册 `searchTools`。仅隐藏说明文字不算禁用。
- `ALL_TOOLS`、`describeTool` 和 `describeNamespace` 只查询当前启用且允许的工具，不查询完整注册表。
- MCP 工具经 Capability 选中并激活后才可执行。原生 MCP 连接、认证和调用管线仍由 Pi 提供。
- 禁用全局 MCP 资源与模板列表。`read_mcp_resource` 还要求目标服务器具有当前启用且允许的入选工具；错误正文不返回服务器目录。
- 历史 Codemode 声明中的旧目录在请求投影中移除，不修改用户正文或磁盘历史。

MCP 配置中的 `codemode`／`deferred` exposure 不表示工具在 Capability 激活后只能从脚本调用。入选并激活的工具可以直接声明和调用，也可在 Codemode 中组合执行。接口已有原生声明或当前启用的 Codemode 查询入口时，结果只保留引用、名称、数量和接口入口；两者都不存在时保留调用所需的参数结构。

`ALL_TOOLS` 只返回工具名和短描述，不展开 TypeScript 接口。完整参数与工具指导由 `describeTool` 按需提供；`describeNamespace` 保留 namespace 指引和成员名称。目录查询不等待所有 MCP 服务器，宿主不添加主动 MCP 重连。实际嵌套工具调用继续经过 Pi 原生管线。

先调用 Capability 选好工具，再运行 Codemode 脚本。如果脚本运行期间才激活新工具，当前脚本不能立即调用；新工具从下一次 Codemode 调用起可用。

该边界不承诺让模型忘记此前已读的用户正文，也不构成文件系统沙箱。基础文件工具仍按当前权限工作。

### 本地与远端分流

| 检索类型 | 契约行为 |
| --- | --- |
| 本地可用资源 | 筛选本地已注册且允许的 Skill／Tool／MCP，激活工具并交给 Main 使用 |
| 远端候选 | 远端搜索与审批界面当前延期；覆盖声明固定为 `not_searched`，不搜索远端，不返回远端候选 |

审批界面、审批对象、批准后的审查与安装流程，以及何时向 Main 提供新增能力，属于延期设计。本文不把批准候选等同于批准执行第三方代码。

延期不改变远端分流要求：审批尚未实现时，不应把远端候选返回 Main，或自动安装、加载和执行候选代码。

审批接收方未实现前，Capability 仅搜索本地资源，不搜索远端。返回结果与覆盖记录标明 `not_searched`，不表示远端不存在资源。

### 能力累积与压缩

**Capability 在当前会话分支内只增不减。** 后续发现补充已有能力，不自动移除先前选中的资源或停用已加载工具。

成功发现的资源通过 `pi.appendEntry` 写入会话分支规范记录（`src/capability/discovery-record.ts` 中的 `capability-discovery` 条目）。嵌套工具调用（如 `ctx.executeTool("capability", ...)`）同样写入规范条目，解决外层工具丢弃内部 `details` 导致记忆丢失的问题。规范条目是唯一记忆来源，不从 `toolResult.details` 恢复发现记忆。

发现记录不重复保存参数 schema。每次请求投影时（`src/capability/prompt.ts`）依据当前工具注册表动态校验权限，已注册但未允许的工具不暴露。

`compact` 压缩对话，不应丢失已发现资源、已加载工具及其可调用接口。分支规范条目持久保存在会话历史中，提示词投影在请求前自动重建 `<capabilities>` 系统段落，恢复已有能力不要求重新调用 Capability。

只增不减不等于绕过权限：已注册、可声明和可执行仍受宿主及角色边界约束。不同分支不因能力累积而相互泄漏。

用户授权保存在 `manual` 分类中。该分类与检索结果共用同一规范条目格式和同一 ref 命名空间，但它是分支授权，不是请求状态：`manual` 记录不进入 `<capabilities>` 投影。被授权的工具由原生工具声明提供接口，再投影一次只会改写头部系统提示词，而不增加模型可用的信息。

`capability.manualTools` 名单内的工具是另一种约束：模型侧发现完全看不到它们，发现路径也不能激活它们（`manual_only`），子会话不继承，必须具备用户明确授予的分支授权才能使用。名单与分类的来源不同：名单来自配置，`manual` 分类记录来自用户的启用动作。

严格工具 allowlist 可能拒绝不匹配的 MCP 成员。当前先写记录、再激活的顺序会让未激活成员残留在规范记忆中，后续投影可能再次展示它们。这是与成功获得能力才应累积的要求不一致的已知缺陷，详见[已知问题](known-issues.md#严格工具-allowlist-下的激活记忆不一致)。

API 协调应同时保证资源指引、工具状态与供应商接口声明一致。缓存命中是优化目标，不应以丢失工具或扩大执行权限换取前缀稳定。

### `/capability` 命令

扩展命令 `/capability` 提供目录浏览与用户启用入口，不经过模型轮次，也不消耗 Capability Budget。

| 子命令 | 行为 |
| --- | --- |
| `/capability`、`/capability list [tool\|mcp\|namespace] [filter]` | 列出当前可选的已注册工具，按类别及 MCP 服务器／命名空间分组；可选类别与纯文本过滤，不调用模型、不启动检索 |
| `/capability enable` | 打开终端原生选择列表，选中项即启用并写入当前分支的 `manual` 记录；Esc 取消无副作用 |
| `/capability enable <target...>` | 按目标启用一个或多个工具，并写入当前分支的 `manual` 记录 |

- 类别只有 `tool`、`mcp`、`namespace`；不传类别时列出全部。`list` 的第一个词只有恰好是这三个名字时才作为类别，其余文本都是过滤词。Skill 不属于该入口。
- 每个工具只属于一个类别：MCP 工具归 `mcp`（按服务器分组），非 MCP 命名空间成员归 `namespace`，其余归 `tool`。组内按显示名称自然排序，组与类别顺序固定。列表只显示真实注册且当前有资格的工具，并标出激活状态与 `manual` 标记；`manual` 工具可以浏览，但浏览不构成授权。
- 过滤为空时列出完整目录；没有匹配时给出可恢复提示。浏览不激活工具、不写入能力记录、不授予权限。
- 补全覆盖 `list` 与类别，以及 `enable` 的目标（含 `mcp://<server>` 与 `namespace://<name>` 组引用，可连续追加）。
- `enable` 的目标在**执行时**对照当前注册表解析：先精确匹配已注册工具名，再展开 `mcp://<server>`、`namespace://<name>`，最后展开裸的非 MCP 命名空间名。工具名优先于同名命名空间。隐藏成员不进入组展开。
- 目标解析使用实时注册表，因此 Pi 原生 `/mcp` 重连后新注册或重新注册的工具无需重启会话、无需先跑模型发现即可浏览和启用；已被撤回并重新注册为 `hidden` 的工具在执时被拒绝，陈旧选择不会激活已消失的注册。
- 顺序为先激活、后写记录：只有激活调用后处于激活集（新激活或已激活）的工具进入 `manual` 记录。未注册、隐藏、未获资格和未被激活的目标逐个报告，不使整条命令失败。
- 重复启用幂等：已记录的目标报告为已启用，不写第二条记录。
- 分支记录写入失败不回滚已激活工具。命令报告该失败；缺少记录时 manual 工具在下一次请求的声明剪枝中被移除，即失败方向是关闭的，而不是当作成功。
- 只增不减：没有停用、移除或重置子命令。能力记忆按分支累计。
- 该命令是 `capability.manualTools` 名单的唯一启用入口。名单内工具不出现在检索候选里，子会话也不能持有它们；子会话同样注册该命令，但子作用域排除 `manual` 工具，启用会被拒绝（`not_permitted`），选择列表也不列出它们。
- 授权依据是分支上的 `manual` 记录，不是当前激活状态。工具因 `defaultActive`、历史恢复或其他扩展而处于激活状态，不构成授权：`before_agent_start` 会把它从声明与激活集中移除，`tool_call` 也会以需要用户授权拒绝。用户启用后才写记录并保留。
- 已启用的 manual MCP 工具与发现选中的 MCP 工具同等对待：通过原生 MCP 准入、出现在 Codemode 的可用目录中，并可作为 `read_mcp_resource` 的服务器选择依据。`read_mcp_resource` 自身仍需被选中或手动启用。
- 用户授权不是请求状态：`manual` 记录不产生 `<capabilities>` 段落。启用会追加工具声明，Subagent 共同及专属指引分别在首个成员及对应工具声明后作为独立系统段落投影，不写进 description，也不使用工具元数据改写头部 rules。第三方工具的 `promptSnippet`／`promptGuidelines` 仍遵循 Pi 原生段落更新；未支持中途 system 消息时可能折叠进头部。Chat Completions 的工具与消息编码继续由 Pi 原生处理；共同指引投影也会提供给该路径，未支持中途 system 消息时沿用 Pi 的折叠行为，详见[已知问题](known-issues.md)。
- 命令只读写当前根会话：不发送消息、不唤醒 Subagent、不改变路由或 Budget。
- 收到跨 session 消息时，接收根会话按当前资格激活 `msg_write`，不加载整个命名空间、不写入用户授权记录，重复收信幂等。显式列入 `manualTools` 时仍受该门禁约束。

### 当前调用形态

- `capability({})` 无参数，内部检索读取调用方上下文。
- 调用等待内部检索结束，再返回结果。
- 本地结果包含筛选后的资源引用、名称、必要路径及接口入口；每项不重复 `available`。
- 选中的工具在交付前重新检查注册与资格，不能激活的成员从成功清单移除。部分交付返回简短 `partialReason`，失败返回 `failureReason`。
- 接口通过原生声明、当前启用的 Codemode 查询入口或必要的结果字段提供，不通过资源 URI 读取。
- 检索不等待全部 MCP 后端，宿主也不主动重连。尚未注册的后端本次不可发现；连接完成后可再次检索。
- Skill 返回元数据和绝对入口路径；Main 使用原生 `read` 按需读取文件，不提供 `skill://` 读取协议。宿主不自动提取约束、绑定或执行步骤。
- 内部本地检索使用 MiniSearch 的 BM25 排序和默认切词，精确引用独立查找；不提供手写模糊兜底或语言语义推断。检索限制与算法参数由 `harness.json` 配置，详见[Harness 参数配置](harness-configuration.md#capability)。
- 当前不搜索远端，也不返回远端候选。
- Capability 与 Subagent 配套装配，内部检索不检查公开 Subagent 工具是否已注册或激活。

### 内部批量检索与增量提交

内部检索会话只执行 `capability_step({queries, refs, finish?})`。公开 `capability({})` 仍只有一次最终返回。

每次 step 先接受此前结果中的 refs，再并行执行下一批本地查询。宿主复用现有 Broker，每条查询保持原有召回、排序、候选数量和正文读取限制。工具本身串行执行，批次内部的查询使用 `Promise.allSettled`，单条查询失败不取消其他查询。

refs 去空白并去重；未知 ref 使本次提交整体拒绝，但不清除此前已接受的选择。选择仅在本次内部会话累积，不提前写入 Main 的分支记忆或激活工具。

模型正文的搜索候选只包含 ref、名称、短描述、类型和必要的 Skill 路径或工具数量。完整成员及共同指引保留在 details 和宿主候选集中，不按 JSON 字符截断。一次发现中首次命中返回候选正文，后续命中只返回 `repeatedRefs`；批次内重复查询也遵守此规则。之前出现的 ref 仍可选择，重复命中不计为没有匹配。新一次发现重新读取目录。

`noSelectionCount` 统计没有新增接受 refs 的 step，不统计零命中关键词数量。搜索有候选但未选择、只重复已选 refs、提交被拒绝，都会增加计数；有新增选择时不增加，也不清零。首轮搜索尚无候选可选，因此内部上限使用 `noSelectionLimit + 1`，默认 `3 + 1 = 4`。达到上限时结束，不再执行该 step 请求的新查询。

主动结束使用 `finish: true` 与空 `queries`，仍可提交最后一批 refs。完成一次本地搜索后允许正常空结束。工具返回 `terminate: true`，不追加模型总结。已接受的 finish 是完成边界；此后内部会话迟到的错误不推翻结果，调用方取消除外。模型自然结束但没有显式 finish，视为未完成协议。

| 收尾情况 | 最终状态 |
| --- | --- |
| 显式完成、无 warnings，含正常空结果 | `ok` |
| 显式完成但有搜索或激活 warnings | `partial` |
| 达到零选择限制、Budget 耗尽、模型故障或协议未完成，但已有选择 | `partial`，保留累计选择 |
| 非正常结束且没有选择 | `failed` |
| 分支记录保存失败 | `failed`，不新增激活 |

外层在内部会话结束后刷新注册与资格，筛掉失效成员，统一保存发现记录、激活工具并投影接口。正常空搜索仍为 `ok`；选中成员全部失效且没有保留 Skill 时为 `failed`；只损失部分成员时为 `partial`。调用方取消后不发布新选择。`endReason` 表达内部检索结束原因，候选目录、计数和完整诊断不返回 Main。`coverage` 与 `missingCapabilities` 沿用既有来源，不把零选择次数当作本地资源不存在的证据。

内部 Budget 与零选择上限通过 `harness.json` 配置，详见[Harness 参数配置](harness-configuration.md#capability)。这些值不作为公开工具参数。

### 与 Subagent 的关系

**Capability 的检索 Agent 复用 Subagent 的底层执行能力。** 系统通过 `src/subagent/execution.ts` 中的 `openSubagentExecution` 统一管理会话生命周期、超时与清理，不为 Capability 另建一套会话创建、预算、取消和清理流程。

Capability 与 Subagent 配套装配和配置（`extensions/harness.ts`），不要求用户分别配置两套执行环境。Capability 直接调用内部执行入口，不要求公开的 `subagent_create`、`subagent_list` 或 `subagent_stop` 工具已注册或已激活。

Capability 调用仍等待检索完成，再返回筛选后的资源。复用执行代码不改变检索权限，不向内部检索 Agent 开放父 Agent 的执行权限。

## Subagent

### 当前调用形态

| 操作 | 当前接口与行为 |
| --- | --- |
| 创建 | `subagent_create({context?, tasks: [{task, name?, inheritContext?}]})`；等待本批各子 Agent 本地就绪（路由分配、会话创建、扩展与工具配置完成、初始输入就绪且 IPC 监听准备就绪），不等待首次模型调用或第一轮任务完成 |
| 创建返回 | `items` 按输入顺序包含 `id`、`socket`、`role` 与 `model`，不返回 `status` 或历史路径；启动前失败以工具错误报告失败 ID，已注册节点保留，不自动重建 |
| 上下文 | 默认不继承聊天历史；`inheritContext: true` 复制父会话快照 |
| 查询 | `subagent_list({id?, all?})`；返回嵌套 `children` 树，不返回 `parentId` 或外层 `items`；默认视图有范围限制，`all: true` 查询完整树，`id` 返回可见子树或 `null`；节点附带 `kind`（`fresh`／`inherited`）；持久化存储启用时返回的树根附带 `historyDir` |
| 取消 | `subagent_stop({id})`；请求取消，不等待执行退出与历史写入结束 |
| 结果读取 | 终态通知直接携带本轮最终输出；超限时附完整结果路径。`history.result` 指向原始结果，`history.summary` 与 `history.cleanJsonl` 用于按需回顾该轮任务和记录 |
| 通信 | `msg_write` 向返回的 IPC 地址或跨 session 地址写入消息；`write` 保持 SDK 原生文件工具完全不变，不用于消息发送 |
| 续跑 | 向已停止的 Subagent 发消息，会启动同一 Subagent 的新一轮执行 |

初始工具集与激活状态按调用方深度确定：

- Main 会话：基础工具沿用 Pi 的工具配置。`subagent_create`、`subagent_list`、`subagent_stop` 和 `msg_write` 均已注册，但默认不激活；Capability 选中整个 `subagent` 命名空间后一起激活。收到跨 session 消息时，宿主在触发模型轮次前自动激活 `msg_write`，使 Main 可以直接回复；该激活不写能力记录，也不加载命名空间的其余工具。
- 子会话（Subagents）：非叶节点加载 `subagent_create`、`subagent_list`、`subagent_stop`、`capability` 与 `msg_write`；叶节点（`depth === maxDepth`）仅保留 `subagent_list` 与 `msg_write`。所有子节点显式保持激活 `msg_write`。
- `write` 是 SDK 原生文件工具，完全保持原生行为，不被拦截或覆写，不承担 IPC 消息发送。

Fresh 初始工具按 Pi 默认配置加载，包括已配置的扩展工具与 MCP 后端，并合并角色 `enableTools`。角色 `excludeTools` 通过 SDK 始终排除，`enableTools` 和扩展主动激活都不能绕过。Root 装配入口由子会话 surface 替代，不重复加载。Fresh 与 Inherited 均独立加载已配置的扩展与 MCP 后端（`noExtensions: false`）；Inherited 在捕获时通过父会话生成该调用的 assistant 消息锁定底层物理模型（`physicalModelForCall`），避免虚拟模型在子会话中重路由。它恢复捕获的工具白名单、系统提示词与思考强度。白名单仅限可重新创建的文件型扩展工具与 MCP 工具，父会话专属诊断工具不传递。若继承的异步 MCP 尚未完成注册，按 `subagent.inheritedToolWaitMs` 有界等待，默认最多 10 秒。

Subagent 共享工作目录。深度上限（`subagent.maxDepth`，默认 2）、活跃直接子节点上限（Fresh 对应的 `subagent.maxActiveChildren`，默认 4；Inherited 对应的 `subagent.maxActiveInheritedChildren`，默认 3；两类直接子节点使用独立的父节点名额池）以及每层 Budget 通过 `harness.json` 配置，详见[Harness 参数配置](harness-configuration.md)。根服务和子会话使用同一份配置快照，已运行 Job 不受文件修改影响。这些配置不作为公开工具参数。

`subagent_create` 在本批子会话本地就绪后返回。本地就绪包括路由分配、会话创建、扩展与工具配置完成、初始输入就绪和 IPC 监听准备就绪。返回项包含 `id`、`socket`、`role` 与 `model`。它不等待首次模型流分发，也不等待任务完成。本地准备阶段的失败会使 create 报错，运行阶段的失败由终态通知报告。

### `/subagent` 命令

扩展命令 `/subagent` 提供同一根代次的观察与停止入口，不经过模型轮次，也不消耗 Job Budget。

| 子命令 | 行为 |
| --- | --- |
| `/subagent`、`/subagent list` | 打印当前根的 Actor 树；`--all` 展开完整树，`--id <actorId>` 只看指定子树 |
| `/subagent stop <actorId>` | 请求取消该 Actor 的当前 Job；返回 `ok` 与 `status`，被拒绝时附带 `reason`（`already_finished`、`stopping`、`finalizing`、`budget_exceeded`）；Actor 没有运行中的 Job 时保持幂等 `ok`，视图提示无运行任务 |
| `/subagent stop --all` | 对当前根所有 `running` Job 请求取消，立即汇总已请求／拒绝／失败数量，不等待终态 |
| `/subagent sessions` | 列出同一 Socket 根下所有存活 session 的短标识、进程、工作目录、session id 与 Main 的跨 session 地址；当前 session 以 `*` 标记 |
| `/subagent sessions connect <uid\|sessionId>` | 把选中存活 session 的联系信息作为一条本地上下文消息追加给当前 agent，并启用 `msg_write`；不向对方发送任何消息 |

- 列表输出为纯文本：树形缩进，`●` 活跃、`◐` 正在停止或收尾、`○` 空闲；列固定为 ID、深度、种类（`fresh`／`inherited`）、角色、状态与调用数。标题给出当前根的全部 Actor 数；活跃数与 Fresh／Inherited 分项只统计运行中的 Actor。窗口隐藏节点时给出提示。
- 列表与停止只读：不发送消息、不 steer、不唤醒；消息仍由 `msg_write` 与 IPC 提供。`sessions connect` 只向本会话追加一条上下文消息，不唤醒任何 Actor 或 session。
- 命令与 Root 同代次：退役或切换期间以 `runtime_transitioning` 拒绝。列表在异步读取后重新核对根代次，根已切换时不渲染旧快照。停止请求不等于终态，Job 仍占 Actor 与名额，直到原生执行退出。
- 交互式详情尚未实现。

默认查询以 Main 或调用者的直接父节点为根。每个同父组最多 4 项，活跃优先、最近停止节点补齐；Main 展开可见活跃子节点，子 Agent 只展开自己，不展开 peers 的孩子。停止节点不展开，即使仍有活跃后代。节点保留状态、Socket 和可用的最近已结束 Job 历史；运行中的节点可同时带上一轮历史。`all: true` 不作窗口裁剪或停止节点折叠。持久化存储启用时，返回的树根节点（含 id 选中的子树根）附带 `historyDir` 指针，指向包含各轮 `<jobId>/summary.md` 与 `transcript.jsonl` 的持久化历史目录；内存会话不附带该字段。

### 本轮结果直接交付

终态通知的 `content` 直接携带本轮最后一条模型回复的文本，不额外调用模型生成摘要。共享投递层只呈现一次正文，不再把正文复制进终态标记的 JSON。

- 结果正文沿用 SDK `read` 的头部截断规则：最多 2000 行或 50 KiB，先达到的上限生效。超限时明确标记截断，并附本轮完整结果路径；单行超过字节上限时不切碎该行，仅返回截断说明和路径。
- 持久化会话写入 `views/<jobId>/result.txt`，通过 `history.result` 返回路径。文件只含原始结果，不添加标题、不裁剪空白、不补换行。缺失时可从保存的 Job 结果重建。
- 内存会话仅在结果超限时写系统临时文件。临时文件由 `temporary-results.ts` 统一管理，在根服务退役或 `/reload` 时保持存活供父节点补读。Node.js 进程正常退出时清理临时文件，系统不宣称存在持久化历史。文件写入失败时仍投递有界结果，并说明完整文件不可用，不伪造路径。
- 结果绑定 `agentId`、`jobId` 和 `round`，只取本轮原生历史区间。续跑不附带此前轮次的结果、累计 Actor 历史或 Inherited 父会话背景。
- 空的最后回复保持为空，不回退到更早的模型文字；工具调用说明不当作最终结果。失败或取消时只携带本轮已产生的最后回复文本，状态与错误仍单独报告。
- `summary.md` 和 `transcript.jsonl` 继续用于历史查阅，不充当直接返回正文。结果文件写入失败不改变模型执行状态；历史写入状态另记。直接交付不改变执行、结束或通知触发条件。

### 广播

广播发送给发送者的全部直接子 Agent，不递归广播，也不按列表显示窗口裁剪。

每个接收者使用与单独发送相同的规则：停止节点在允许续跑时启动新一轮任务，仍受并发上限等限制；处于停止或收尾状态的节点可以拒绝消息。

广播有部分失败时，消息写入工具报错并指出失败接收者，不返回成功结果，也不自动重试。

### 跨 session 消息

跨 session 消息用于让一个 Pi session 的 Main 联系同一用户、同一 Socket 根下另一个存活 session 的 Main。它不建立跨主机调度，也不自动广播到其他 session。

**平台范围：当前只实现 POSIX（Linux、macOS）。Windows 明确不支持**：不发布 session 记录，`/subagent sessions` 提示不可用，跨 session 发送以 `unsupported_platform` 拒绝。Windows 命名管道的寻址与端点归属校验尚未实现与验收。

- **地址**：目标 session 的受管 `Main` Socket 路径，与本地 `msg_write` 使用同一地址空间，没有第二套 scheme。`/subagent sessions` 直接显示该路径；外部编排者读取目录记录的 `socketDir` 推导同一路径。指向其他 session 非 `Main` 端点的路径以 `invalid_target` 拒绝，因此拿到任意子 Actor Socket 也不能越界。
- **发现**：`/subagent sessions` 是用户侧发现入口；模型侧不注册 session 工具，外部编排者直接读取同一份共享目录：`socketRoot/sessions/<uid>.json` 由各 session 在 `initialize` 后发布，`retire` 时按记录归属删除；读取时按 `pid` 存活与记录自洽过滤，畸形或残留记录被忽略且不由他人删除。记录只含稳定 uid、session id、原生 session name、工作目录、`pid` 与起始时间，不含拓扑或对话内容。`subagent_list` 仍只描述当前根。
- **补全**：`/subagent sessions con` 补全为 `sessions connect `；随后按实时存活目录补全目标 uid，候选显示会话名称、工作目录与完整 session id。可按 uid／完整 session id 的前缀或名称筛选；排除当前会话，不产生授权、激活或消息写入。选中后执行 connect 时仍重新校验目标是否存活。
- **连接**：`/subagent sessions connect <uid|sessionId>` 由用户指定一个存活 session，参数是列表中显示的完整 uid 或完整原生 session id，不接受序号或别名。命令把该 session 的 uid、原生 session id、原生名称、工作目录与 Main 地址作为一条原生自定义上下文消息追加到当前会话：不触发新一轮，忙碌时按 SDK 队列语义在当前轮结束时落盘、下一轮可见；不改写提示词头部、不复制对方 transcript、不注入整份目录、不建立持久连接状态。同一次 connect 经用户启用路径（与 `/capability enable` 相同）启用 `msg_write`；`msg_write` 被列入 `manualTools` 时，本次 connect 就是显式授权，不需要额外命令、确认或握手。目标未知或已退出以 `session_not_found` 报告，指向自身以 `invalid_target` 拒绝；重复 connect 允许再次追加当前信息，授权记录保持幂等。connect 只写本会话，不发送消息、不唤醒对方。
- **发送**：`msg_write` 接受上述路径，且只有 `Main` 可发送。宿主先按本 root 的受管端点解析：属于本 session 的路径走原有本地写入（`Main` 写给自己的 `Main` 由 Runtime 的 self-send 规则拒绝）；不属于本 root 时，只有目标为已发布 session 的 `Main` 才按跨 session 写入。线上帧只有 `from` 与 `content`，`from` 由发送宿主绑定为 `<session-uid>:Main`，模型不提供发送者或独立 session 字段。
- **接收**：目标根只在其 `Main` 端点接受复合身份的帧。IPC 边界解析 `from` 的 `<uid>:Main`，要求该 uid 是当前存活的已发布 session；发送者自身的 uid 映射为本地 `Main`，交由 Runtime 的 self-send 规则拒绝。通过后把复合身份映射为 Runtime 的外部发送者描述（session id、完整 `from`、回复地址），不把复合身份当作本地 Actor ID。
- **呈现**：接收方消息沿用统一的 `Message from` 标签，跨 session 的 `from` 显示完整身份 `<uid>:Main`；回复提示使用发送方真实的受管 `Main` Socket 地址，不再出现 `session:` 协议。普通消息不显示发送方的执行状态，只有终态通知带状态与轮次。
- **边界**：跨 session 只做 Main 之间的消息，不能广播；终态通知与 parent-hold 仍只属于本 session，子 Agent 不参与跨 session 交互。未知或已退出的 session 以 `unknown_session` 拒绝。超时、断连或错误不证明消息未入队，宿主不重发。
- **信任**：session 记录与 `from` 都是同用户本机进程的声明，不构成认证协议；与外部 Socket 客户端属于同一信任模型。

### 外部编排接口

session 生命周期（创建、恢复、停止、轮询、定时检查）与 `/session`、`/cron` 命令由独立的编排项目承担。本仓库不注册 `session_*` 工具，也不提供进程托管或管理协议；这里只保证外部编排所需的稳定接口。

- **发现**：`<socketRoot>/sessions/<uid>.json`（版本化记录）。字段为 `version`、`sessionId`、`uid`、`socketDir`、`pid`、`cwd`、`name`、`startedAt`。记录由 session 自己发布、按归属删除；读取方按 `pid` 存活与记录自洽过滤，畸形或残留记录被忽略且不由他人删除。`uid` 用于寻址与判同，`sessionId` 是原生身份，`name` 是原生显示名。
- **寻址**：`<socketRoot>/<uid>/Main.sock`（POSIX）。没有 `session:` 方案；其他 Actor 端点不是跨 session 目标。
- **消息**：向目标 Main 端点写单帧 NDJSON `{"from":"<sender-uid>:Main","content":"..."}`；接收端在 IPC 边界校验发送者 uid 是当前存活的已发布 session，并映射为 Runtime 的外部发送者描述。只有 Main 参与跨 session；自发、广播与非 Main 端点拒绝；不确定交接不重发。
- **编排者身份**：外部编排者必须作为已发布的 Pi session 参与（通过 SDK 或 CLI 运行），复用上述发布、寻址与收发。本仓库不为非 session 的外部进程新增客户端身份、第二套接收端点或管理通道。
- **名称**：原生 session name；`/name` 通过 `session_info_changed` 同步到目录，其他 session 与人类界面读取同一份名称。
- **平台与信任**：仅 POSIX；同一用户本机；记录与 `from` 都是声明，不是认证。
- **非目标**：进程创建/停止/托管、stop/poll 的宿主请求协议、cron、管理范围、`/session`/`/cron`、transcript 读取与 `session_*` 工具。

`/subagent sessions` 是只读发现视图；`connect` 只把选中 session 的联系信息写入本会话上下文并启用 `msg_write`，不向对方发送消息，也不构成管理入口。

### 思考强度

候选模型直接配置单一 `thinking` 级别，例如 `"thinking": "high"`。系统去除了区间与裁剪逻辑，不再通过区间计算最终强度。Inherited 模式仍继承父会话的思考强度。

### 任务语言

任务描述宜主要使用英文以匹配路由器能力。系统对任务语言没有硬拒绝策略，不设非 ASCII 字符比例拦截。

### 通信指引

Agent 应通过提供的 `msg_write` 发送消息；`write` 保持 SDK 原生文件工具完全不变，不承担消息发送。

调用方只提供接收地址和纯文本消息。`content` 即为消息正文，不要求调用方封装成 JSON、拼接 NDJSON 或添加末尾换行。

`msg_write` 位于 subagent 命名空间。Main 默认不启用该工具；Capability 选中整个 subagent namespace 后，一并启用 `msg_write`。所有子 Agent 的 Harness 工具组显式保持启用该工具。`msg_write` 只接受受管 IPC 地址或跨 session 地址。由宿主负责通信封装、消息分帧（`src/ipc/message.ts` 中的 `managedFrame`）和发送者绑定。内部传输格式不属于 Agent 的调用契约。

参数示例：

```json
{
  "path": "<返回的 IPC 地址>",
  "content": "Please review the test results."
}
```

消息正文中的换行或 JSON 文本按普通内容传递，不被当作多个报文或宿主元数据。调用方不提供发送者身份；宿主统一绑定真实发送者。

`write` 保持 SDK 原生文件写入行为。`msg_write` 专用于受管消息端点，不写普通文件。

消息写入成功返回简洁纯文本（`Successfully sent message to ...`），`details: undefined`，不另加 ACK 或回执对象；失败以消息投递错误报告。广播部分失败在响应中保留失败接收者列表及原因，普通 IPC 错误不向调用方泄漏内部状态细节。消息写入成功不等于接收者已读取，也不等于任务已完成。超时或错误不保证消息尚未送达，严禁自动重发。

### 自动完成通知

宿主在核心生命周期中统一判定终态（`adjudicateTerminal`）并封装通知（`terminalNotification`）。终态判定覆盖正常完成（`completed`）、取消（`cancelled`）与失败（`failed`）。通知携带本轮结果、`status`、`jobId`、`round` 与可用历史路径。宿主在任务结束后自动通知父 Agent，不依赖 Subagent 主动调用消息工具。

通知表达本轮执行的结束状态，清晰区分正常完成、取消和失败。

**子节点通知继续父 Subagent 的当前轮次（parent-hold）。** 只要还有处于 `running`、`stopping` 或 `finalizing` 的直接子节点，正常执行的父 Subagent 在回复结束后保持 `running`，保留当前 Job、Budget、会话和活跃名额。队列为空时暂停活跃时间计费，仍受总存活租约限制；消息或子节点通知到达后在同一 Job 内继续。所有直接子节点终结且通知处理完毕后，父 Subagent 才正常收尾并交付一次终态通知。

子节点终态通知不创建 continuation Job。父 Subagent 若已因取消或失败关闭，晚到的子节点通知仅追加到保留历史，不自动续跑。只有显式消息向已停止节点发起新一轮执行；Main 的原生通知唤醒行为保持不变。

**交接异常不等于未入队。** 向运行中 SDK 会话交接消息或跨 Socket 写入时，抛出异常、断连或超时并不证明消息未入队；只有明确收到“未交出”的同步拒收才允许转入保留历史，严禁对结果未知的已提交消息自动重发。

通知的排队、中断和后续执行沿用 Pi steer message，不另设通知专用的取消或恢复规则。每条通知独立作为 steer message 投递，保留宿主来源和本轮任务结果。

### 终端结果折叠

Harness 为没有专用结果渲染器的工具提供统一预览，包括 Capability、Subagent 控制工具和动态 MCP 工具。默认只显示前 10 个终端视觉行；短结果完整显示，单行长 JSON 也按屏幕宽度折叠。已有专用渲染器不被替换。

工具结果可用 Pi 原生展开键（默认 `Ctrl+O`，动作名 `app.tools.expand`）切换。全屏模式下，左键点击工具结果可展开／收起。Subagent 消息和终态通知也按视觉行折叠；点击标题、预览或折叠提示可切换，标题保留发送者、状态和轮次。点击后的展开状态在重绘和宽度调整后保留；全局展开键优先更新显示状态。滚轮和拖动不触发折叠，普通终端模式仍使用展开键。

折叠只改变界面显示，不改写工具 `content`、`details`、保存的消息或模型上下文。界面展开显示全部已交付内容；若结果已按字节／行数上限截断，完整原文仍需按所附文件路径补读。

### 等待子任务

父 Agent 等待所有 children 时，应结束当前回复并交还控制，等待通知唤醒。不必通过 `sleep`、忙轮询或新增阻塞式 `wait` 工具维持等待。

这里的停下指父 Agent 结束当前轮次，不是调用 `subagent_stop` 取消子任务。

单个子任务的完成通知不代表所有 children 已完成。父 Agent 被唤醒后，如果仍有子任务未结束且没有其他工作，可再次交还控制。

### 普通消息与终态通知独立投递

- 每条普通消息和每条终态通知分别交给 Pi，不等待同源或同轮次事件。
- 保留来源、轮次和宿主终态元数据，不改写已交出的消息。
- 不维护合并槽、批次映射、队列清空探针或重发状态。
- 用户清除先前进度不影响随后产生的终态独立入队；主动清除终态后，系统不自行重发。
- Pi 决定一个或多个排队消息在哪次模型请求中消费，不承诺一条消息对应一次请求。

### 用户查看入口

当前面向 Agent 的 `subagent_list` 是模型接口，不能替代面向用户的查看与控制入口。

面向用户的查看界面形式、可见信息范围，以及用户是否能停止或发送消息，处于延期设计状态。

## 提示词与架构

工具提示词应表达上述使用流程和行为边界。提示词正文存放在 `prompts/`，通过 `src/prompt-text.ts` 的类型化缓存 getter 读取；执行代码保留数据装配、参数结构和权限判断。角色说明与路由偏好仍来自 `subagent-routing.json`，不新增模板框架或静默回退正文。

### Subagent 提示词装配

运行时始终读取 `prompts/subagent-tools.json` 与 `prompts/subagent-turns.json`。

| 模块 | 资产字段 | 装配位置 |
| --- | --- | --- |
| A：共同范围与通信 | tools 的 `namespace`、`instructions` | Subagent namespace；共同指引随已启用成员进入提示词 |
| B：派生与协调 | tools 的 `create.guideline` | 仅追加到 `subagent_create.promptGuidelines`，不追加到 list／stop 的共同指引 |
| C：子会话身份与交付 | turns 的 `context` | 所有子会话的 `appendSystemPrompt`；替换实际 Agent ID、Parent ID 与父端点 |
| D1：Fresh 职责 | `subagent-routing.json` 的角色说明 | Fresh 路由后注入，续跑保留已记录角色 |
| 共同工作指引 | `subagent.prompts.common`，内置为空 | Fresh 与 Inherited 的当前会话装配均追加一次非空正文 |
| D2：Inherited 上下文定位 | `subagent.prompts.inherited`，默认来自 turns 的 `inheritedContext` | 仅 Inherited 会话额外注入，续跑及重新打开原生会话时仍按该 Actor 身份装配 |
| E：活跃名额 | tools 的 `create.capacity` | 作为 system prompt 段落 `subagent_capacity` 注入；`{fresh}`、`{inherited}` 按当前配置快照替换 |

提示词定制边界：

- 仅开放 `subagent.prompts.common` 和 `subagent.prompts.inherited` 两段，支持逐层 `replace` 与 `append`，详见[提示词定制](harness-configuration.md#提示词定制)。
- 宿主上下文固定：`subagent-turns.json` 中的 `context` 包含三个固定占位符 `{agentId}`、`{parentId}`、`{parentSocket}`，由宿主直接插入，不展开变量或代码。
- 提示词段落装配不改写已捕获的历史，也不把历史重写为新的任务正文。快照捕获仍会移除 Harness 内部条目和末尾尚未完成的工具调用，并为子会话分配独立 session ID。
- 子会话装配顺序：依次为路由角色指引、宿主身份段（`childContext`）、非空 `common`，以及仅用于 Inherited 模式的非空 `inherited`。`common` 默认为空时，装配顺序保持为角色、宿主身份与继承指引。
- `create.capacity` 通过 `before_agent_start` 写入 `sections.subagent_capacity`，值来自当前配置快照。同一快照下文本逐字节一致；配置变化只产生一条段落补丁，工具描述保持静态。

参数说明按所属工具与实际嵌套位置保存：

- `create.parameters.context`
- `create.parameters.tasks.description` 及 `create.parameters.tasks.items.{name,task,inheritContext}`
- `list.parameters.{all,id}`、`stop.parameters.id`
- `msg_write.parameters.{path,content}`

这些是提示词资产路径，公开调用参数仍为 `context`、`tasks[].task` 等原有字段。

## 核心设计细节

核心运行时模块遵循以下系统不变量：

- Capability 共享底层执行入口，仅检索本地资源；基于 `capability-discovery` 分支规范记录保留记忆。
- 终态裁定覆盖正常完成、取消与失败。parent-hold 保留正常执行的父 Subagent 当前 Job；取消或失败后的晚到通知只追加历史，不自动创建新轮次。
- 普通消息与终态通知各自基于 Pi steer message 投递，不维护合并状态。
- IPC 通信为纯文本接口与宿主分帧，建立私有目录与失效 Socket 回收机制。
- 交接异常不证明未入队，严禁盲目重发。
- 会话切换与服务退役通过代次围栏隔离晚到回调，禁止旧代次写入新根。

## 延期边界

- 用户查看入口的内容与交互。
- 远端审批对象、用户入口和批准后的流程。

上述需求暂缓实现，不阻塞当前核心接口，也不自动执行未授权代码。
