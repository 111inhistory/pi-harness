# 接口契约

## 状态与范围

本文记录本轮讨论中的接口目标，以及对照当前代码发现的差异。目标要求不表示功能已经实现。

本文不规定内部模块划分、消息队列实现或用户界面形式。归档文档不作为本文的补充要求。

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
- 远端候选：不返回 Main，转入用户审批流程。

### 原生发现入口与 Codemode

**Capability 是 Tool／MCP／Skill 的发现入口。Codemode 仍可启用，但只负责执行和组合调用。**

配套入口 `extensions/harness.ts` 应执行以下边界：

- 禁用原生 `tool_search`，不向模型默认注入 `<mcp_servers>`。
- 不在 Codemode 沙箱中注册 `searchTools`。仅隐藏说明文字不算禁用。
- `ALL_TOOLS`、`describeTool` 和 `describeNamespace` 只查询当前启用且允许的工具，不查询完整注册表。
- MCP 工具经 Capability 选中并激活后才可执行。原生 MCP 连接、认证和调用管线仍由 Pi 提供。
- 禁用全局 MCP 资源与模板列表。`read_mcp_resource` 还要求目标服务器具有当前启用且允许的入选工具；错误正文不返回服务器目录。
- 历史 Codemode 声明中的旧目录在请求投影中移除，不修改用户正文或磁盘历史。

MCP 配置中的 `codemode`／`deferred` exposure 不表示工具在 Capability 激活后只能从脚本调用。入选并激活的工具可以直接声明和调用，也可在 Codemode 中组合执行。结果是否重复参数结构按原生 loadout 实际隐藏的声明逐项判断，不因 `codemode.mode = only` 一概保留完整接口。

先调用 Capability 选好工具，再运行 Codemode 脚本。如果脚本运行期间才激活新工具，当前脚本不能立即调用；新工具从下一次 Codemode 调用起可用。

该边界不承诺让模型忘记此前已读的用户正文，也不构成文件系统沙箱。基础文件工具仍按当前权限工作。

### 本地与远端分流

| 检索结果 | 目标要求 | 当前实现状态 |
| --- | --- | --- |
| 本地可用资源 | 将筛选后的 Skill／Tool／MCP 交给 Main | 已实现本地结果筛选与已注册工具激活；提示词已同步按需使用指引 |
| 远端候选 | 交给用户审批，不返回 Main | 已按 D4 停用远端搜索（coverage 声明 `not_searched`），远端候选不进入结果与记忆；用户审批界面留待后续设计 |

`needs_approval` 状态不等于已有审批流程，也不表示用户已经授权。

审批界面、审批对象、批准后的审查与安装流程，以及何时向 Main 提供新增能力，留待后续阶段设计，不阻塞核心功能设计。本文不把批准候选等同于批准执行第三方代码。

延期不改变远端分流要求：审批尚未实现时，也不应把远端候选返回 Main，或自动安装、加载和执行候选代码。

作者已确认并落地：审批接收方未实现前，只搜索本地资源，不搜索远端。返回结果与覆盖记录标明 `not_searched`，不表示远端不存在资源。

### 能力累积与压缩

**Capability 在当前会话分支内只增不减。** 后续发现补充已有能力，不自动移除先前选中的资源或停用已加载工具。

成功发现的资源通过 `pi.appendEntry` 写入会话分支规范记录（`src/capability/discovery-record.ts` 中的 `capability-discovery` 条目）。嵌套工具调用（如 `ctx.executeTool("capability", ...)`）同样写入规范条目，解决外层工具丢弃内部 `details` 导致记忆丢失的问题。规范条目是唯一记忆来源，不从 `toolResult.details` 恢复发现记忆。

发现记录不重复保存参数 schema。每次请求投影时（`src/capability/prompt.ts`）依据当前工具注册表动态校验权限，已注册但未允许的工具不暴露。

`compact` 压缩对话，不应丢失已发现资源、已加载工具及其可调用接口。分支规范条目持久保存在会话历史中，提示词投影在请求前自动重建 `<capabilities>` 系统段落，恢复已有能力不要求重新调用 Capability。原生压缩插件问题交由外部处理，但分支上的自定义条目投影不受会话压缩影响。

只增不减不等于绕过权限：已注册、可声明和可执行仍受宿主及角色边界约束。不同分支不因能力累积而相互泄漏。

API 协调应同时保证资源指引、工具状态与供应商接口声明一致。缓存命中是优化目标，不应以丢失工具或扩大执行权限换取前缀稳定。

### 当前调用形态

本节依据本轮对代码和当前会话接口的核对，不表示永久保留全部实现细节。

- `capability({})` 无参数，内部检索读取调用方上下文。
- 调用等待内部检索结束，再返回结果。
- 本地结果可包含资源引用、用途说明、可用状态和共同指引。
- 选中的已注册工具可被激活；接口通过返回值或原生声明提供，不通过资源 URI 读取。
- Skill 返回元数据和绝对入口路径；Main 使用原生 `read` 按需读取文件，不提供 `skill://` 读取协议。宿主不自动提取约束、绑定或执行步骤。
- 内部本地检索使用 MiniSearch 的 BM25 排序和默认切词，精确引用独立查找；不提供手写模糊兜底或语言语义推断。实现边界见[当前架构](architecture.md#capability)。
- 当前不搜索远端，也不返回远端候选。
- Capability 与 Subagent 配套装配，内部检索不检查公开 Subagent 工具是否已注册或激活。

### 内部批量检索与增量提交

内部检索会话只执行 `capability_step({queries, refs, finish?})`。旧的两个内部工具已删除，不保留别名。公开 `capability({})` 仍只有一次最终返回。

每次 step 先接受此前结果中的 refs，再并行执行下一批本地查询。宿主复用现有 Broker，每条查询保持原有召回、排序、候选数量和正文读取限制。工具本身串行执行，批次内部的查询使用 `Promise.allSettled`，单条查询失败不取消其他查询。

refs 去空白并去重；未知 ref 使本次提交整体拒绝，但不清除此前已接受的选择。选择仅在本次内部会话累积，不提前写入 Main 的分支记忆或激活工具。

`noSelectionCount` 统计没有新增接受 refs 的 step，不统计零命中关键词数量。搜索有候选但未选择、只重复已选 refs、提交被拒绝，都会增加计数；有新增选择时不增加，也不清零。首轮搜索尚无候选可选，因此内部上限使用 `3 + 1 = 4`。达到上限时结束，不再执行该 step 请求的新查询；不另设首次搜索状态。

主动结束使用 `finish: true` 与空 `queries`，仍可提交最后一批 refs。完成一次本地搜索后允许正常空结束。工具返回 `terminate: true`，不追加模型总结。已接受的 finish 是完成边界；此后内部会话迟到的错误不推翻结果，调用方取消除外。模型自然结束但没有显式 finish，视为未完成协议。

| 收尾情况 | 最终状态 |
| --- | --- |
| 显式完成、无 warnings，含正常空结果 | `ok` |
| 显式完成但有搜索或激活 warnings | `partial` |
| 达到零选择限制、Budget 耗尽、模型故障或协议未完成，但已有选择 | `partial`，保留累计选择 |
| 非正常结束且没有选择 | `failed` |
| 分支记录保存失败 | `failed`，不新增激活 |

外层在内部会话结束后统一保存发现记录、激活工具并投影接口；调用方取消后不发布新选择。`endReason` 表达内部检索结束原因，候选目录、计数和完整诊断不返回 Main。`coverage` 与 `missingCapabilities` 沿用既有来源，不把零选择次数当作本地资源不存在的证据。

内部 Budget 放宽为模型调用 soft 16／hard 20、活跃时间 soft 180 秒／hard 360 秒、总存活时间 600 秒。这些是宿主固定值，不是公开工具参数。

### 与 Subagent 的关系

**Capability 的检索 Agent 复用 Subagent 的底层执行能力。** 已通过 `src/subagent/execution.ts` 中的 `openSubagentExecution` 统一管理会话生命周期、超时与清理，不再为 Capability 另建一套会话创建、预算、取消和清理流程。

Capability 与 Subagent 配套装配和配置（`extensions/harness.ts`），不要求用户分别配置两套执行环境。Capability 直接调用内部执行入口，不要求公开的 `subagent_create`、`subagent_list` 或 `subagent_stop` 工具已注册或已激活，消除了对公开工具注册表的依赖。

Capability 调用仍等待检索完成，再返回筛选后的资源。复用执行代码不改变检索权限，不向内部检索 Agent 开放父 Agent 的执行权限。

Shell Preflight 独立配置和使用。本项目不要求三个功能各自作为完全独立的插件配置。

## Subagent

### 当前调用形态

| 操作 | 当前接口与行为 |
| --- | --- |
| 创建 | `subagent_create({context?, tasks: [{task, name?, inheritContext?}]})`；等待本批各子 Agent 本地就绪（local readiness：路由分配、会话创建、扩展与工具配置完成、初始输入就绪且 IPC 监听准备就绪），不等待首次模型调用或第一轮任务完成 |
| 创建返回 | `items` 按输入顺序包含 `id`、`socket`、`role` 与 `model`，不返回 `status` 或历史路径；启动前失败以工具错误报告失败 ID，已注册节点保留，不自动重建 |
| 上下文 | 默认不继承聊天历史；`inheritContext: true` 复制父会话快照 |
| 查询 | `subagent_list({id?, all?})`；返回嵌套 `children` 树，不返回 `parentId` 或外层 `items`；默认视图有范围限制，`all: true` 查询完整树，`id` 返回可见子树或 `null`；持久化存储启用时返回的树根附带 `historyDir` |
| 取消 | `subagent_stop({id})`；请求取消，不等待执行退出与历史写入结束 |
| 结果读取 | 终态通知直接携带本轮最终输出；超限时附完整结果路径。`history.result` 指向原始结果，`history.summary` 与 `history.cleanJsonl` 用于按需回顾该轮任务和记录 |
| 通信 | `msg_write` 向返回的 IPC 地址写入消息；`write` 保持 SDK 原生文件工具完全不变，不用于消息发送 |
| 续跑 | 向已停止的 Subagent 发消息，会启动同一 Subagent 的新一轮执行 |

Fresh 初始工具按 Pi 默认配置加载，包括已配置的扩展工具与 MCP 后端，并合并角色 `enableTools`。角色 `excludeTools` 通过 SDK 始终排除，`enableTools` 和扩展主动激活都不能绕过。Root 装配入口由子会话 surface 替代，不重复加载。Fresh 与 Inherited 均独立加载已配置的扩展与 MCP 后端（`noExtensions: false`）；Inherited 在捕获时通过父会话生成该调用的 assistant 消息锁定底层物理模型（`physicalModelForCall`），避免虚拟模型在子会话中重路由，恢复捕获的工具白名单（仅限可重新创建的文件型扩展工具与 MCP 工具，父会话专属诊断工具不传递）、系统提示词与思考强度，对异步 MCP 提供最多 10 秒有界等待。

Subagent 当前共享工作目录。当前实现限制每个父节点最多 4 个活跃子节点，最多派生两层。

创建的等待边界是本批子会话本地就绪（local readiness：路由分配、会话创建、扩展与工具配置完成、初始输入就绪且 IPC 监听准备完毕），返回 `id`、`socket`、`role` 与 `model`；不再等待首次模型流分发（移除了 `firstModelCall` 和 `#starting` 拦截），也不等待响应或任务完成。本地准备阶段的失败会使 create 报错，运行阶段的失败由终态通知报告。

默认查询以 Main 或调用者的直接父节点为根。每个同父组最多 4 项，活跃优先、最近停止节点补齐；Main 展开可见活跃子节点，子 Agent 只展开自己，不展开 peers 的孩子。停止节点不展开，即使仍有活跃后代。节点保留状态、Socket 和可用的最近已结束 Job 历史；运行中的节点可同时带上一轮历史。`all: true` 不作窗口裁剪或停止节点折叠。持久化存储启用时，返回的树根节点（含 id 选中的子树根）附带 `historyDir` 指针，指向包含各轮 `<jobId>/summary.md` 与 `transcript.jsonl` 的持久化历史目录；内存会话不附带该字段。

### 本轮结果直接交付

**已实现。** 终态通知的 `content` 直接携带本轮最后一条模型回复的文本，不额外调用模型生成摘要。共享投递层只呈现一次正文，不再把正文复制进终态标记的 JSON。

- 结果正文沿用 SDK `read` 的头部截断规则：最多 2000 行或 50 KiB，先达到的上限生效。超限时明确标记截断，并附本轮完整结果路径；单行超过字节上限时不切碎该行，仅返回截断说明和路径。
- 持久化会话写入 `views/<jobId>/result.txt`，通过 `history.result` 返回路径。文件只含原始结果，不添加标题、不裁剪空白、不补换行。缺失时可从保存的 Job 结果重建。
- 内存会话仅在结果超限时写系统临时文件，临时文件由 `temporary-results.ts` 统一管理，在根服务退役或 `/reload` 时保持存活供父节点补读，在 Node.js 进程正常退出时清理（不保证 SIGKILL 下清理），不宣称存在持久化历史。文件写入失败时仍投递有界结果，并说明完整文件不可用，不伪造路径。
- 结果绑定 `agentId`、`jobId` 和 `round`，只取本轮原生历史区间。续跑不附带此前轮次的结果、累计 Actor 历史或 Inherited 父会话背景。
- 空的最后回复保持为空，不回退到更早的模型文字；工具调用说明不当作最终结果。失败或取消时只携带本轮已产生的最后回复文本，状态与错误仍单独报告。
- `summary.md` 和 `transcript.jsonl` 继续用于历史查阅，不充当直接返回正文。结果文件写入失败不改变模型执行状态；历史写入状态另记。直接交付不改变执行、结束或通知触发条件。

### 广播

**保留当前行为。** 广播到发送者的全部直接子 Agent，不递归广播，也不按列表显示窗口裁剪。

每个接收者使用与单独发送相同的规则：停止节点在允许续跑时启动新一轮任务，仍受并发上限等限制；正在停止或收尾的节点可以拒绝消息。

广播有部分失败时，消息写入工具报错并指出失败接收者，不返回成功结果，也不自动重试。

### 思考强度

**已实现：直接配置一个 `thinking` 值，例如 `"thinking": "high"`。** `src/subagent/routing.ts` 已在 `RoutingCandidate` 中直接指定候选模型的思考强度，去除了 `min`／`max` 区间与裁剪逻辑，不再通过区间计算最终强度，也不改为使用 Pi 默认值。Inherited 模式仍继承父会话的思考强度，不受本项改变。

### 任务语言

任务描述宜主要使用英文。作者说明，原因是当前路由器 Jev 对非英文的对齐欠佳。

**已移除任务语言的硬拒绝策略。** 英文仅作为当前路由器的使用推荐，已删除按非 ASCII 字符比例或任务语言硬拒绝任务的检查。

### 通信指引

Agent 应通过提供的 `msg_write` 发送消息；`write` 保持 SDK 原生文件工具完全不变，不再覆写或承担消息发送。

**已实现纯文本通信接口与宿主分帧。** 调用方只提供接收地址和纯文本消息。`content` 就是消息正文，不要求调用方把正文封装成 JSON、拼接 NDJSON 或添加末尾换行。

`msg_write` 位于 subagent 命名空间，对 Main 和所有子 Agent 默认启用，仅接受受管 IPC 地址。由宿主负责通信封装、消息分帧（`src/ipc/message.ts` 中的 `managedFrame`）和发送者绑定。内部传输格式不属于 Agent 的调用契约。

以下是目标接口的工具参数示例，正文为纯文本，地址为接口返回的实际地址：

```json
{
  "path": "<返回的 IPC 地址>",
  "content": "Please review the test results."
}
```

消息正文中的换行或 JSON 文本按普通内容传递，不被当成多个报文或宿主元数据。调用方不提供发送者身份；宿主统一绑定真实发送者。

`write` 保持 SDK 原生文件写入行为。`msg_write` 专用于受管消息端点，不写普通文件。提示词与工具说明已同步更新为纯文本通信规范。

消息写入成功返回简洁纯文本（`Successfully sent message to ...`），`details: undefined`，不另加 ACK 或回执对象；失败以消息投递错误报告。广播部分失败在响应中保留失败接收者列表及原因，普通 IPC 错误不向调用方泄漏内部任意状态细节。消息写入成功不等于接收者已读取，也不等于任务已完成。超时或错误不保证消息尚未送达，不自动重发。

### 自动完成通知

**已在核心生命周期中实现自动终态通知。** `src/subagent/lifecycle.ts` 实现了终态判定（`adjudicateTerminal`）与通知封装（`terminalNotification`），统一覆盖正常完成（`completed`）、取消（`cancelled`）与失败（`failed`），携带本轮结果、`status`、`jobId`、`round` 与可用的历史路径。宿主在任务结束后自动通知父 Agent，不再依赖 Subagent 主动调用消息工具。

通知表达本轮执行的结束状态，清晰区分正常完成、取消和失败，不使用模糊的“停止”。

**子节点通知继续父 Subagent 的当前轮次。** 只要还有处于 `running`、`stopping` 或 `finalizing` 的直接子节点，正常执行的父 Subagent 在回复结束后保持 `running`，保留当前 Job、Budget、会话和活跃名额。队列为空时暂停活跃时间计费，仍受总存活租约限制；消息或子节点通知到达后在同一 Job 内继续。所有直接子节点终结且通知处理完毕后，父 Subagent 才正常收尾并交付一次终态通知。

子节点终态通知不创建 continuation Job。父 Subagent 若已因取消或失败关闭，晚到的子节点通知仅追加到保留历史，不自动续跑。只有显式消息向已停止节点发起新一轮执行；Main 的原生通知唤醒行为保持不变。

**通知的排队、中断和后续执行沿用 Pi steer message，不另设通知专用的取消或恢复规则。** 每条通知独立作为 steer message 投递，保留宿主来源和本轮任务结果。

### 终端结果折叠

Harness 为没有专用结果渲染器的工具提供统一预览，包括 Capability、Subagent 控制工具和动态 MCP 工具。默认只显示前 10 个终端视觉行；短结果完整显示，单行长 JSON 也按屏幕宽度折叠。已有专用渲染器不被替换。

工具结果可用 Pi 原生展开键（默认 `Ctrl+O`，动作名 `app.tools.expand`）切换。全屏模式下，左键点击工具结果可展开／收起。Subagent 消息和终态通知也按视觉行折叠；点击标题、预览或折叠提示可切换，标题保留发送者、状态和轮次。点击后的展开状态在重绘和宽度调整后保留；全局展开键优先更新显示状态。滚轮和拖动不触发折叠，普通终端模式仍使用展开键。

折叠只改变界面显示，不改写工具 `content`、`details`、保存的消息或模型上下文。界面展开显示全部已交付内容；若结果已按字节／行数上限截断，完整原文仍需按所附文件路径补读。

### 等待子任务

父 Agent 等待所有 children 时，应结束当前回复并交还控制，等待通知唤醒。不必通过 `sleep`、忙轮询或新增阻塞式 `wait` 工具维持等待。

这里的“停下”指父 Agent 结束当前轮次，不是调用 `subagent_stop` 取消子任务。

单个子任务的完成通知不代表所有 children 已完成。父 Agent 被唤醒后，如果仍有子任务未结束且没有其他工作，可再次交还控制。

### 普通消息与终态通知独立投递

**作者已决定暂不做消息合并。** 此决定同时适用于 Main 和子 Agent，取代此前的合并与 `message_end` 封口方案。

- 每条普通消息和每条终态通知分别交给 Pi，不等待同源或同轮次事件。
- 保留来源、轮次和宿主终态元数据，不改写已交出的消息。
- 不维护合并槽、批次映射、队列清空探针或重发状态。
- 清掉先前进度，不影响随后产生的终态独立入队；主动清掉终态后，不自行重发。
- Pi 决定一个或多个排队消息在哪次模型请求中消费，不承诺一条消息对应一次请求。

### 用户查看入口

**用户应能直接查看 Subagent。** 作者指出当前缺少该能力。

面向 Agent 的 `subagent_list` 不能替代面向用户的查看入口。用户不应依赖 Main 代为查询，才能了解子任务。

用户界面形式、可见信息范围，以及用户是否能停止或发送消息，留待后续阶段设计，不阻塞核心功能设计。延期不表示取消用户查看需求。

## 提示词与架构

工具提示词应表达上述使用流程和行为边界。提示词正文放在 `prompts/`，通过 `src/prompt-text.ts` 的类型化缓存 getter 读取；执行代码保留数据装配、参数结构和权限判断。角色说明与路由偏好仍来自 `subagent-routing.json`，不新增模板框架或静默回退正文。

### Subagent 提示词装配

运行时始终读取 `prompts/subagent-tools.json` 与 `prompts/subagent-turns.json`。`*.new.json` 仅作讨论稿，不参与发现、加载或回退。文案确认后写回原文件，再删除讨论稿；不迁移运行时文件名。

| 模块 | 资产字段 | 装配位置 |
| --- | --- | --- |
| A：共同范围与通信 | tools 的 `namespace`、`instructions` | Subagent namespace；共同指引随已启用成员进入提示词 |
| B：派生与协调 | tools 的 `create.guideline` | 仅追加到 `subagent_create.promptGuidelines`，不追加到 list／stop 的共同指引 |
| C：子会话身份与交付 | turns 的 `context` | 所有子会话的 `appendSystemPrompt`；替换实际 Agent ID、Parent ID 与父端点 |
| D1：Fresh 职责 | `subagent-routing.json` 的角色说明 | Fresh 路由后注入，续跑保留已记录角色 |
| D2：Inherited 上下文定位 | turns 的 `inheritedContext` | 仅 Inherited 会话额外注入，续跑及重新打开原生会话时仍按该 Actor 身份装配 |

`inheritedContext` 接线与正式正文已启用。空串或全空白时不产生额外指引；非空正文原样传递，不由代码补写默认措辞。装配不清洗继承历史，也不把它改写成新的 assignment。

参数说明按所属工具与实际嵌套位置保存，不再使用顶层扁平 `parameters`：
- `create.parameters.context`
- `create.parameters.tasks.description` 及 `create.parameters.tasks.items.{name,task,inheritContext}`
- `list.parameters.{all,id}`、`stop.parameters.id`
- `msg_write.parameters.{path,content}`

这些是提示词资产路径，公开调用参数仍为 `context`、`tasks[].task` 等原有字段。正文可以独立编辑；回归验证字段映射、按能力与上下文模式选块、身份与端点替换和实际工具行为，不锁定具体文案。

公开行为应先于内部架构方案确定。消息合并已撤回，不为预留该功能引入协调状态。

## 核心设计细节

核心 typed 模块（`src/subagent/execution.ts`、`lifecycle.ts`、`delivery.ts`、`routing.ts`、`storage.ts`、`view.ts`、`job-budget.ts`、`pi-job-budget.ts`、`inherited-context.ts`、`src/ipc/endpoint.ts`、`message.ts`、`src/capability/discovery-record.ts`、`skills.ts`、`shell-preflight.ts`）已在当前工作区分离实现并建立单元测试：

- Capability 共享底层执行入口，落实 D4 仅本地检索，基于 `capability-discovery` 分支规范记录解决嵌套调用记忆丢失。
- 终态裁定统一覆盖正常完成、取消与失败；子节点通知恢复父 Subagent 的当前 Job，显式消息才启动停止节点的新轮次。
- 普通消息与终态通知各自基于 Pi steer message 投递，不维护合并状态。
- IPC 通信完成纯文本接口与宿主分帧，建立私有目录与失效 Socket 回收机制。

root/child 独立投递、会话隔离与 IPC 根目录校验已接入默认离线回归。Capability、Subagent 与迁移样本的真实模型续跑已完成基础验收。Linux 长时间压力、多用户权限和 Windows 实机验证尚未完成，不将基础验收等同于完整平台验收。

## 后续阶段

- 用户查看入口的内容与交互。
- 远端审批对象、用户入口和批准后的流程。

上述功能需求保留，但不阻塞核心功能设计。
