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

**Capability 是 Tool／MCP／Skill 的发现入口。Codemode 仍可启用，但只负责执行和组合调用。** 已提供的 Skill 入口可直接读取，无需再次发现；模型不通过文件系统或网络搜索未知 Skill。

`extensions/capability.ts` 注册 Capability 与 MCP 装配，并安装 Main 最终出站 payload 缓存标识观察器；未加载该入口时，不安装此观察器。该入口执行以下发现边界：

- 禁用原生 `tool_search`，不向模型默认注入 `<mcp_servers>`。
- 不在 Codemode 沙箱中注册 `searchTools`。仅隐藏说明文字不算禁用。
- `ALL_TOOLS`、`describeTool` 和 `describeNamespace` 只查询当前启用且允许的工具，不查询完整注册表。
- MCP 工具经 Capability 选中并激活后才可执行。原生 MCP 连接、认证和调用管线仍由 Pi 提供。
- 禁用全局 MCP 资源与模板列表。`read_mcp_resource` 还要求目标服务器具有当前启用且允许的入选工具；错误正文不返回服务器目录。
- 历史 Codemode 声明中的旧目录在请求投影中移除，不修改用户正文或磁盘历史。

MCP 配置中的 `codemode`／`deferred` exposure 不表示工具在 Capability 激活后只能从脚本调用。入选并激活的工具可以直接声明和调用，也可在 Codemode 中组合执行。接口已有原生声明或当前启用的 Codemode 查询入口时，结果只保留引用、名称、数量和接口入口；两者都不存在时保留调用所需的参数结构。

激活前会检查每个入选工具在当前会话是否有可用的调用入口：`direct`／`deferred` 工具在激活后直接声明，自带入口，不依赖 Codemode；仅能以 `codemode` exposure 从脚本调用的工具，若当前会话未启用、也不符合资格的 Codemode，则不可达，会被拒绝且不写入分支记录。部分入选工具不可达时返回 partial 并把原因按组告知模型、向用户显示汇总 warning；全部工具不可达且无成功 Skill 时失败。可达性检查不扩大为通用事务、自动回滚或历史授权撤销。

`ALL_TOOLS` 只返回工具名和短描述，不展开 TypeScript 接口。完整参数与工具指导由 `describeTool` 按需提供；`describeNamespace` 保留 namespace 指引和成员名称。目录查询不等待所有 MCP 服务器，宿主不添加主动 MCP 重连。实际嵌套工具调用继续经过 Pi 原生管线。

启用 `capability.lazySchemas`（默认空）后，仅在 Codemode 已启用且生效模式为 `only` 时，命中组的参数与返回值 schema 不进入原生工具声明，也不内联进 Codemode 目录；发现结果与 `describeNamespace` 保留成员名称，`describeTool` 返回完整接口后经 Codemode 执行。生效模式可由模型 Preset 记录在分支上覆盖 Pi 设置。命中组的内部继承检索同样不再向检索模型重发这些 schema；命中组中的 model-only 成员不能被延迟隐藏，应显式报告。

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

**Capability 的分支规范记录只追加、不改写已有条目。** 后续发现补充能力；当前有效资源与工具激活状态还受权限变化和[压缩时收缩发现能力](#压缩时收缩发现能力)约束。

成功发现的资源通过 `pi.appendEntry` 写入会话分支规范记录（`src/capability/discovery-record.ts` 中的 `capability-discovery` 条目）。嵌套工具调用（如 `ctx.executeTool("capability", ...)`）同样写入规范条目，解决外层工具丢弃内部 `details` 导致记忆丢失的问题。规范条目是唯一记忆来源，不从 `toolResult.details` 恢复发现记忆。

发现记录不重复保存参数 schema。每次请求投影时（`src/capability/prompt.ts`）依据当前工具注册表动态校验权限，已注册但未允许的工具不暴露。

`compact` 保留分支规范历史，但成功压缩后会淘汰使用窗口内未使用的发现工具成员。提示词投影按发现与淘汰记录重建当前有效的 `<capabilities>` 系统段落；已淘汰工具需要重新发现，摘要中的旧引用不代表当前可调用。具体保留范围见[压缩时收缩发现能力](#压缩时收缩发现能力)。

记录只追加不等于绕过权限：已注册、可声明和可执行仍受宿主及角色边界约束。不同分支不因能力累积而相互泄漏。

用户授权保存在三态权限记录（`capability-tool-permission`）中。它与检索结果共用同一 ref 命名空间，但它是分支权限，不是请求状态：权限记录不进入 `<capabilities>` 投影。被显式启用的工具由原生工具声明提供接口，再投影一次只会改写头部系统提示词，而不增加模型可用的信息。

`capability.manualTools` 归一为同 target/state 结构的默认 `disabled` 条目：模型侧发现与准入按 `disabled` 排除，不进入检索候选；子会话通过 denial 阻止继承；显式启用是 root-only，可覆盖默认条目。config 默认、显式启用／禁用写入同一份三态管理数据。

严格工具 allowlist 可能拒绝不匹配的 MCP 成员。当前先写记录、再激活的顺序会让未激活成员残留在规范记忆中，后续投影可能再次展示它们。这是与成功获得能力才应累积的要求不一致的已知缺陷，详见[已知问题](known-issues.md#严格工具-allowlist-下的激活记忆不一致)。

API 协调应同时保证资源指引、工具状态与供应商接口声明一致。缓存命中是优化目标，不应以丢失工具或扩大执行权限换取前缀稳定。

### `/capability` 命令

扩展命令 `/capability` 提供目录浏览与用户启用入口，不经过模型轮次，也不消耗 Capability Budget。

| 子命令 | 行为 |
| --- | --- |
| `/capability`、`/capability list [expr]` | 按四态派生视图列出工具；`expr` 为无空格的状态／类别过滤表达式，默认 `enabled+active`；不调用模型、不启动检索 |
| `/capability enable` | 打开包含命名空间、MCP 分组及单个工具的终端选择列表，选中项即显式启用；Esc 取消无副作用 |
| `/capability enable <target...>` | 按目标显式启用，激活当前可用的具体成员并写入当前分支的权限记录 |
| `/capability disable <target...>` | 按目标显式禁用；立即拒绝后续调用，没有独立声明的成员立即移出 active，独立声明保留到成功 compaction |
| `/capability reset <target...>` | 解除显式规则回到 `not managed`；不激活、不授予其他限制 |

- `expr` 由 `+`／`-` 连接的 term 组成，term ∈ `enabled`、`disabled`、`active`、`inactive`、`tool`、`namespace`；不得含空格，首 term 隐含并集，`+` 取并集、`-` 排除，重复 term 拒绝。至多一个类别 term；只写类别时取该类别默认集 `enabled+active`，空表达式等价于 `enabled+active`。`tool` 指无命名空间的成员，`namespace` 指有命名空间的成员（含 MCP）。
- 四态互斥穷尽：已管理只有 `enabled`／`disabled`，未管理的运行时成员为 `active`／`inactive`。四态是派生展示与过滤层，不写入管理记录；`active` 集只表示运行时选择，不冒充显式启用。
- 类别归属：MCP 工具归 `namespace`（含 MCP 服务器），有非 MCP 命名空间的成员归 `namespace`，其余归 `tool`。按显示名称自然排序。列表只显示真实注册的工具；被 SDK 排除、未注册或当前作用域不可见的工具不出现。
- 过滤为空时列出完整默认集；没有匹配时给出可恢复提示。浏览不激活工具、不写入记录、不授予权限。
- 目标语法：精确工具名、`mcp://<server>`、`namespace://<name>`，以及 config 默认的 `foo*` 前缀（`enable`／`disable`／`reset` 同语法）；裸 token 按精确工具名处理，不做隐式组展开；组规则按命名空间名、别名或成员匹配当前及后续注册的成员。目标在**执行时**对照实时注册表解析：`/mcp` 重连后新注册或重新注册的工具无需重启即可浏览和启用；撤回并注册为 `hidden` 的成员被拒绝，陈旧选择不会激活已消失的注册。
- 顺序为「先写记录、再应用效果」：权限记录是唯一持久化点；写入失败时不激活、不移除、不宣称成功，命令报告 `recordError`。未注册、隐藏、未获资格或受 SDK 限制的目标逐项报告，不使整条命令失败；重复设置幂等，不写第二条记录。
- `enable` 只激活当前可用的具体成员；未注册、隐藏、未获资格或受 SDK 限制的成员只报告，不激活。显式启用是 root-only：子会话不能继承，也不会绕过祖先作用域、SDK 限制或资格要求。
- `disable` 立即由执行钩子拒绝直接与 Codemode 嵌套调用；已开始的执行不自动取消。Codemode-only 成员立即移出 active；有独立声明的成员保留声明到下一次成功 compaction 再定向移除。只有禁用前已启用且实际使用过的工具才追加禁止提示。
- `reset` 只解除显式规则，不激活工具、不授予授权；migrated 记录或 `capability.manualTools` 种子仍生效时报告 `stillManaged`。
- `capability.manualTools` 是默认 `disabled` 种子，不是独立名单：名单内工具除非显式启用，否则默认禁用。跨 session 收信时接收根会话按当前资格激活 `msg_write`；`msg_write` 被种子默认禁用时，connect 的显式启用就是用户授权。
- 已显式启用的 MCP 工具与发现选中的 MCP 工具同等对待：通过原生 MCP 准入、出现在 Codemode 可用目录中，并可作为 `read_mcp_resource` 的服务器选择依据；`read_mcp_resource` 自身仍需被选中或显式启用。
- 授权与提示：显式启用不产生 `<capabilities>` 段落。启用追加工具声明；Subagent 共同及专属指引分别在首个成员及对应工具声明后作为独立系统段落投影，不写进 description，也不用工具元数据改写头部 rules。第三方工具的 `promptSnippet`／`promptGuidelines` 仍遵循 Pi 原生段落更新；未支持中途 system 消息时可能折叠进头部。Chat Completions 的工具新增需要同时明确开启 `supportsMidConvoSystemMessages` 与 `supportsMidConvoToolAdditions`；仅有一个标志时不启用。标准路径仍使用顶层工具列表，同名 schema 更新可能重建前缀。共同指引与工具描述更新使用增量段落，详见[传输行为](provider-transports.md)。
- 补全覆盖 `list` 的动词与 term，以及 `enable`／`disable`／`reset` 的目标（含 `mcp://<server>` 与 `namespace://<name>` 组引用，可连续追加）。分组优先展示，避免工具较多时被候选数量上限截断；可通过命名空间别名查找分组。
- 命令只读写当前根会话：不发送消息、不唤醒 Subagent、不改变路由或 Budget。

### Capability 调用形态

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

### 压缩时收缩发现能力

Main 与普通 Subagent 在成功 compaction 后，若 `capability.pruneOnCompaction` 开启，或上次压缩以来应用 Preset 移除过基线工具，则移除窗口内未使用的 Capability 工具成员；使用证据包括直接执行结果和 Codemode 的持久化嵌套调用记录。显式禁用工具与发现恢复入口保留（不进入普通淘汰）。基础工具采用当前 Preset 快照中的工具选择；没有 Preset 工具选择时使用 Pi 设置的默认工具集。切换时保留的动态工具不纳入该基线，仍按窗口使用情况淘汰。MCP／namespace 按成员收缩，空组移除共同指引与记忆；Skill 不参与淘汰，不断开 MCP 连接。

淘汰先写分支记录，再更新激活集。新 checkpoint 不再声明已撤下的成员；其首条 system message 包含固定的能力变更段，提示摘要中的相关描述属于历史信息，需要重新发现。该段不触发额外轮次，也不因后续重新启用而改写。重新发现通过尾部新声明恢复工具；恢复与分支切换遵守各自记录。压缩失败不淘汰；内部检索和 `/btw` 不独立运行这套机制。

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

### 工具指引与缓存前缀

增量规则适用于所有工具来源。原生 `promptGuidelines` 由 SDK 追加变化；namespace、MCP 与用户直接启用工具的共同指引使用分支记录固定正文和落点。当前目录中的新指引追加到尾部，不把它写回历史声明。指引变化、撤销与 Capability 新发现也只追加新的系统更新；重复请求和恢复不重复追加。

Capability 的初始投影可按可见结果建立历史落点；之后即使嵌套调用结果不可见，也在当前尾部更新，不改写旧 checkpoint。仅在原生指引已实际投递时省略同源重复正文。历史版本保留，最新状态遵守当前资格与权限，执行权仍由工具声明和宿主检查决定。

### 与 Subagent 的关系

**Capability 的检索 Agent 复用 Subagent 的底层执行能力。** 系统通过 `src/subagent/execution.ts` 中的 `openSubagentExecution` 统一管理会话生命周期、超时与清理，不为 Capability 另建一套会话创建、预算、取消和清理流程。

Capability 与 Subagent 分别通过 `extensions/capability.ts`、`extensions/subagent.ts` 注册，共用底层执行能力和同一会话的配置、资格状态，不创建两套执行环境。Capability 直接调用内部执行入口，不要求公开的 `subagent_create`、`subagent_list` 或 `subagent_stop` 工具已注册或已激活。

Capability 调用仍等待检索完成，再返回筛选后的资源。复用执行代码不改变检索权限，不向内部检索 Agent 开放父 Agent 的执行权限。

## 工具权限管理

工具权限管理是用户控制的三态状态：`not managed`、显式启用、显式禁用。它与工具选择、激活集和 Capability 自动发现是不同概念：显式启用表示用户要求该工具可用，显式禁用表示用户禁止该工具，二者都不表示工具是否已注册或当前是否激活。manual 与 blacklist 已收敛为同一份管理数据、同一套查询与修改接口，不保留第二份名单或额外协调状态。

### 状态、记录与迁移

- 管理记录保存在当前分支的 `capability-tool-permission` 自定义条目中，只追加、不重写；每条记录包含 `set`（目标与 `enabled`／`disabled`）与 `unset`（解除目标）。`unset` 是统一解除标记：覆盖显式、显式迁移与 config 默认条目。`resume`、`tree`、`fork`、`reload` 按分支重放。无记录或被 `unset` 覆盖即 `not managed`。
- 目标为精确工具名（注册或未注册均可）、`mcp://<server>` 或 `namespace://<name>`；组规则按命名空间名、别名或成员匹配当前及后续注册的成员。裸 token 一律按精确工具名处理，不做隐式组展开。
- 历史格式只通过**显式离线迁移**进入 canonical：用户在会话关闭时运行 `npm run migrate:tool-permissions -- <session.jsonl>`，把旧 `capability-blacklist` 与 `capability-discovery` 的 `manual` 转换为同一 `set` 的 `enabled`／`disabled` 条目并写迁移 marker；runtime 的启动与回合生命周期不扫描旧格式，只读 canonical 记录与 config 默认。config `capability.manualTools` 归一为同结构的默认 `disabled` 条目（精确名或 `foo*` prefix），不构成独立名单或 matcher。canonical 条目优先于 config 默认；显式 group enable 覆盖更窄的 config 默认条目，同类再按具体度与 mutation 时间取最新。
- SDK 命令行限制（`--exclude-tools`、严格 allowlist）不属于管理状态，也不合成为记录；解除管理不会解除 SDK 限制，查询与诊断不虚构 SDK 未提供的来源。
- 只读查询不暴露来源、命中规则或诊断信息；需要时只返回状态与必要结果。

### 派生视图与查询

- 面向用户与程序的派生视图为互斥四态：已管理的 `enabled`／`disabled`，未管理的运行时成员 `active`／`inactive`。四态是展示与过滤层，不是第二份持久化状态；已管理工具不因处于 active 集而被报告为显式启用。
- `/capability list [expr]` 与 RPC `tools.permission.query` 共用同一套表达式：term ∈ `enabled`、`disabled`、`active`、`inactive`、`tool`、`namespace`，`+`／`-` 连接，默认 `enabled+active`；只写类别时取该类别默认集。
- 查询结果只包含名称、类别、`state`、是否已管理、是否注册与是否 active；不返回来源或命中规则。

### 生效优先级与入口

- 显式禁用优先于显式启用、授权与激活选择：直接调用与 Codemode 嵌套调用都由执行钩子拒绝。显式启用是 root-only，子会话不能继承，也不会绕过祖先作用域、SDK 限制或资格要求。
- 显式禁用后立即阻止后续调用；已开始的执行不自动取消，Agent 也不自动停止。Capability 发现候选、`/capability list` 与 Codemode 的 `ALL_TOOLS`、`describeTool`、`describeNamespace` 在全部模式下都不返回被禁工具及其接口信息；已记录的 `<capabilities>` 记忆段与工具指引投影同样排除。
- 已启用且当前具有独立声明的工具被禁用后，钩子立即阻止调用，声明保留到下一次成功 compaction 再定向移除；没有独立声明的成员（按真实 loadout 的 `hiddenDeclarations` 与 `lazySchemas` mask 判定，包括 Codemode-only、生效模式 `only` 下被隐藏的 direct，以及被 lazy 组遮蔽的成员）立即从有效工具集移除，原始注册保留。
- 解除（`reset`）写入 `unset` 标记，统一覆盖显式、显式迁移与 config 默认条目，回到 `not managed`；不自动激活工具、不授予授权。被更宽组规则覆盖的精确目标解除后仍由组规则管理，结果报告 `stillManaged`。
- 管理状态不改变 SDK 的选择语义：`--tools -name` 不激活工具但仍注册；`--exclude-tools` 从注册表排除；Preset 修改 active 集不修改管理状态；Capability 自动发现不产生显式管理记录。
- 工具权限管理工具使用资格，不自动禁用同名扩展命令或领域控制操作。

### 模型提示与 compaction

- 只有设置显式禁用前已经启用且在本会话当前上下文（上次 compaction 之后）实际使用过的工具才向模型追加禁止提示；使用证据沿用直接调用与 Codemode 嵌套调用记录，注册、发现和 `describeTool` 不算使用。未启用或未使用的工具不增加提示，规则与执行钩子仍然生效。
- 禁止提示使用尾部追加的独立记录（`capability-tool-permission-notice`），不新增头部 system section，不复用普通淘汰的「重新发现」文案；同一工具不重复提示。
- 成功 compaction 按当前管理状态定向移除仍被显式禁用的独立声明成员；`capability.pruneOnCompaction` 关闭时该定向移除仍然生效。普通淘汰继续按自身规则工作，同一工具同时涉及两者时使用禁止语义，不进入普通淘汰的「重新发现」提示。显式启用的工具受保护，不进入普通淘汰；旧 `capability-prune` 记录不再压过显式启用。压缩失败不提前移除，调用继续由钩子阻止。

### 子会话

- 子会话不得自行解除祖先限制。根会话把当前 `explicitlyDisabled` 与 `explicitlyEnabled` 都作为 **live denial** 沿作用域父链传播：禁用向子会话生效；显式启用是 root-only，子会话同样不能继承。denial 在每次资格解析时生效，已开始的执行不自动取消。
- 已学到的名字不会从子会话记忆中物理删除；denial 在每次解析时覆盖它，所以不能把“已学到”当作仍可使用。

### 程序接口

Harness RPC 独立接口提供权限查询与用户管理适配，与用户命令共用同一份领域操作和记录，不解析命令、通知或状态栏文本。状态、记录与传播语义由本节定义，程序接口只做结构化传输与结果适配，见 [Harness RPC 独立接口](#harness-rpc-独立接口)。

## 模型 Preset

`extensions/preset.ts`（随包默认加载）提供模型切换、思考级别、模型专属指引和工具选择。

**配置。** 读取全局 agent 目录的 `presets.json` 与受信项目的 `.pi/presets.json`，项目同名项整体覆盖全局。每项可含 `model`（`provider`＋`id`）、`thinkingLevel`、`tools`、`codemode`（`mode`）与 `instructions`。`tools` 使用原生 `+name`／`-name`／裸名语义，始终基于会话首次启动捕获的初始工具集（原生默认工具、CLI 修饰与默认启用扩展工具，如 `capability`）计算，并记录为 Preset 工具基线；先应用 A 再应用 B 与直接应用 B 得到同一基线，跨 reload 不被前一个 Preset 污染。只有增减修饰符时，另保留当前已激活且有 Capability 发现或显式启用记录的工具；显式减项仍移除对应工具，裸名列表仍完整替换工具选择。保留的动态工具不写入 Preset 基线，继续由压缩淘汰策略管理。前后 Preset 基线比较时，若旧集合有工具不在新集合中，则下一次成功压缩执行淘汰，即使 `capability.pruneOnCompaction` 为 `false`；首次应用与初始基线比较，仅增加工具不触发，不改变全局配置。

**入口。** `/preset` 打开选择器，`/preset NAME` 应用指定项，`/preset clear`（`none`／`off`）停止管理，`--preset NAME` 在启动时应用；状态栏显示当前 Preset。Preset 只作用于当前 Main 会话，不静默改变 Fresh／Inherited Subagent 的路由或模型。

**应用与失败。** 先校验模型存在于目录，再 `setModel`；模型不可用则整体不应用并报错，绝不报成功；thinking 与 tools 随后应用。`instructions` 作为独立 system 段落经 `prompt-section-journal` 增量投影并在 resume／tree／fork／reload 回放，不覆盖整份 system prompt。

**分支与清除。** `preset-state` 记录保存应用时解析快照（model／thinking／tools／codemode／instructions），快照用于恢复指令、状态标识及压缩保护基线，不在恢复时强制重放 model／thinking／tools；这些运行状态由 Pi 原生恢复。工具 loadout 随实际请求记录，应用 Preset 后尚未发起请求就退出，恢复时可能仍使用上一份工具集。首次启动的初始工具集另存为 `preset-base` 供修饰符计算；`/preset clear` 写入 null 快照并停止管理，不回滚已有 model／thinking／tools。

**Codemode 模式。** 扩展无公开 `codemode.mode` 写入通道。Preset 以 `codemode-mode` 分支记录覆盖本会话的生效模式，原生 Codemode 工具与 `capability.lazySchemas` 均读取该生效模式，从下一次请求生效；它只改变声明投影，不改变启用集合、显式启用记录或工具 exposure。若宿主无法应用该覆盖，只记录并给出 warning，不把未生效报成成功。

## `/btw` 独立问答

`/btw [question]` 在交互式终端底部打开独立问答面板（内联停靠，不覆盖主对话）。无参数时显示输入框；带参数时直接提问。打开时捕获当前分支上下文、系统提示词、模型、思考级别与缓存标识，再追加独立问答指令。虚拟模型使用最近一条响应的物理模型；无法确定时拒绝启动。

同一面板中的追问沿用临时会话。问答只存在内存中，不写入主对话、不生成 Subagent 任务、通知或通信端点，也不占用子节点名额。所有工具调用由执行钩子阻断，继承的声明仅保留不可执行的占位实现；manual 工具声明仍按子会话边界排除。

面板固定在终端底部、占满可用宽度，高度为终端半屏（`round(终端行数 / 2)`），不低于配置的首选最小行数 `btw.panelMinRows`（默认 8 行），不随回答长度变化；主对话在面板上方保持可见与可滚动，关闭后恢复主输入框。终端行数不足以容纳首选最小行数与一行主对话（默认 9 行）时，`/btw` 报错拒绝打开，这是尽力而为的检查，不代表 SDK 布局最终会给出的高度。打开期间把终端缩小到该下限以下时，面板改为一行错误提示并停止接受输入，恢复高度后自动恢复显示，问答内容与滚动位置保持不变。

SDK 停靠区的页脚、待处理消息、状态行与 widget 会共同占用空间，可能裁切面板底部。首选最小行数约束面板请求的高度，实际显示空间由 SDK 分配；放大终端或减少 widget 可恢复显示。

`/btw` 只在全屏（fullscreen）渲染下可用；常规（regular）渲染下拒绝打开，并提示把 `tuiMode` 设为 `fullscreen`。回答区独立滚动：鼠标滚轮与 PgUp／PgDn 只移动回答视口；溢出时显示滚动条，可点击或拖拽滑块（拖动在指针移出滚动条列后继续，直到释放），指针落在标题行或输入框同一列不会滚动回答。停在底部时自动跟随新文本，向上阅读时不因流式更新跳动，滚回底部即恢复跟随。面板消费落在其范围内的滚轮事件，边界处不会带动主对话滚动。

Enter 提问，Shift+Enter 换行，Ctrl+C 仅取消当前回答（取消完成后可继续提问，失败会显示错误），Esc 关闭面板并清理临时会话。主会话退出、重载或切换分支时也会关闭面板。重新打开会捕获新的主对话快照，不恢复之前的问答。

## Subagent

### Subagent 调用形态

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

**平台范围**：Unix Socket 与 Windows Named Pipe 共用同一份目录、记录和 Main 与 Main 之间的准入。地址属于哪个 session 的端点命名空间由 IPC 平台适配层判定：Unix 是 session 目录下的 socket 文件，Windows 是以该目录派生的管道名前缀；业务层不把管道地址当文件系统路径推断。文件系统路径等价（目录记录的 `socketDir` 自洽校验、storage 自有文件与 copy-on-write 的父文件比对）按平台原生语义比较：Windows 视为大小写不敏感，POSIX 保持大小写敏感。

- **地址**：目标 session 的受管 `Main` Socket 路径，与本地 `msg_write` 使用同一地址空间，没有第二套 scheme。`/subagent sessions` 直接显示该路径；外部编排者读取目录记录的 `socketDir` 推导同一路径。指向其他 session 非 `Main` 端点的路径以 `invalid_target` 拒绝，因此拿到任意子 Actor Socket 也不能越界。
- **发现**：`/subagent sessions` 是用户侧发现入口；模型侧不注册 session 工具，外部编排者直接读取同一份共享目录：`socketRoot/sessions/<uid>.json` 由各 session 在 `initialize` 后发布，`retire` 时按记录归属删除；读取时按 `pid` 存活与记录自洽过滤，畸形或残留记录被忽略且不由他人删除。记录只含稳定 uid（8 位十六进制）、session id、原生 session name、工作目录、`pid` 与起始时间，不含拓扑或对话内容。`pid` 只在本机解释，因此 `socketRoot` 必须保持本机私有；跨机共享 durable session 历史不受此限制。`subagent_list` 仍只描述当前根。
- **补全**：`/subagent sessions con` 补全为 `sessions connect `；随后按实时存活目录补全目标 uid，候选显示会话名称、工作目录与完整 session id。可按 uid／完整 session id 的前缀或名称筛选；排除当前会话，不产生授权、激活或消息写入。选中后执行 connect 时仍重新校验目标是否存活。
- **连接**：`/subagent sessions connect <uid|sessionId>` 由用户指定一个存活 session，参数是列表中显示的完整 uid 或完整原生 session id，不接受序号或别名。命令把该 session 的 uid、原生 session id、原生名称、工作目录与 Main 地址作为一条原生自定义上下文消息追加到当前会话：不触发新一轮，忙碌时按 SDK 队列语义在当前轮结束时落盘、下一轮可见；不改写提示词头部、不复制对方 transcript、不注入整份目录、不建立持久连接状态。同一次 connect 经用户启用路径（与 `/capability enable` 相同）启用 `msg_write`；`msg_write` 被列入 `manualTools` 时，本次 connect 就是显式授权，不需要额外命令、确认或握手。目标未知或已退出以 `session_not_found` 报告，指向自身以 `invalid_target` 拒绝；重复 connect 允许再次追加当前信息，显式启用记录保持幂等。connect 只写本会话，不发送消息、不唤醒对方。
- **发送**：`msg_write` 接受上述路径，且只有 `Main` 可发送。宿主先按本 root 的受管端点解析：属于本 session 的路径走原有本地写入（`Main` 写给自己的 `Main` 由 Runtime 的 self-send 规则拒绝）；不属于本 root 时，只有目标为已发布 session 的 `Main` 才按跨 session 写入。线上帧只有 `from` 与 `content`，`from` 由发送宿主绑定为 `<session-uid>:Main`，模型不提供发送者或独立 session 字段。
- **接收**：目标根只在其 `Main` 端点接受复合身份的帧。IPC 边界解析 `from` 的 `<uid>:Main`，要求该 uid 是当前存活的已发布 session；发送者自身的 uid 映射为本地 `Main`，交由 Runtime 的 self-send 规则拒绝。通过后把复合身份映射为 Runtime 的外部发送者描述（session id、完整 `from`、回复地址），不把复合身份当作本地 Actor ID。
- **呈现**：接收方消息沿用统一的 `Message from` 标签，跨 session 的 `from` 显示完整身份 `<uid>:Main`；回复提示使用发送方真实的受管 `Main` Socket 地址，不再出现 `session:` 协议。普通消息不显示发送方的执行状态，只有终态通知带状态与轮次。
- **边界**：跨 session 只做 Main 之间的消息，不能广播；终态通知与 parent-hold 仍只属于本 session，子 Agent 不参与跨 session 交互。未知或已退出的 session 以 `unknown_session` 拒绝。超时、断连或错误不证明消息未入队，宿主不重发。
- **信任**：session 记录与 `from` 都是同用户本机进程的声明，不构成认证协议；与外部 Socket 客户端属于同一信任模型。

### 外部编排接口

session 生命周期（创建、恢复、停止、轮询、定时检查）与 `/session`、`/cron` 命令由独立的编排项目承担。本仓库不注册 `session_*` 工具，也不提供进程托管或管理协议；这里只保证外部编排所需的稳定接口。

- **发现**：`<socketRoot>/sessions/<uid>.json`（版本化记录）。字段为 `version`、`sessionId`、`uid`、`socketDir`、`pid`、`cwd`、`name`、`startedAt`。记录由 session 自己发布、按归属删除；读取方按 `pid` 存活与记录自洽过滤，畸形或残留记录被忽略且不由他人删除。`uid` 是 8 位十六进制的派生地址，用于寻址与判同；`sessionId` 是原生身份，`name` 是原生显示名。
- **寻址**：`<socketRoot>/<uid>/Main.sock`（Unix）或该目录派生的 `\\.\pipe\pi-harness-<8 位命名空间>-Main.sock`（Windows）。没有 `session:` 方案；其他 Actor 端点不是跨 session 目标。
- **消息**：向目标 Main 端点写单帧 NDJSON `{"from":"<sender-uid>:Main","content":"..."}`；接收端在 IPC 边界校验发送者 uid 是当前存活的已发布 session，并映射为 Runtime 的外部发送者描述。只有 Main 参与跨 session；自发、广播与非 Main 端点拒绝；不确定交接不重发。
- **编排者身份**：外部编排者必须作为已发布的 Pi session 参与（通过 SDK 或 CLI 运行），复用上述发布、寻址与收发。本仓库不为非 session 的外部进程新增客户端身份、第二套接收端点或管理通道。
- **名称**：原生 session name；`/name` 通过 `session_info_changed` 同步到目录，其他 session 与人类界面读取同一份名称。
- **平台与信任**：POSIX Unix Socket／Windows Named Pipe；同一用户本机；记录与 `from` 都是声明，不是认证。
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

Main 压缩期间，消息进入所属根代次的内存待投递队列后即可应答；发送方不等待摘要生成。应答表示根已接管消息，不表示已落盘或模型已读。压缩结束后按接管顺序交给 SDK；退役在原上下文中排空队列且不唤醒 Main。丢失代次所有权的消息不能写入新根，投递失败由接收根报告，结果未知的交接不重放。

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

用户已可通过 `/subagent` 命令查看任务树、状态与会话，并停止指定任务或全部任务，命令见 [`/subagent` 命令](#subagent-命令)。`subagent_list` 是供模型使用的独立查询接口。

可视化／交互式任务管理界面，以及通过用户命令直接向子 Agent 发送消息，仍处于延期设计状态。

## Harness RPC 独立接口

Harness 为 Pi 原生 RPC 未覆盖的工具信息、子 Agent 控制、消息历史与子会话执行流提供独立的结构化端点。客户端继续通过 Pi 原生 RPC 控制和读取 Main 会话，不应执行 Slash 命令后解析面向人的文本。

### 双通道边界

- Pi 原生 RPC（stdin／stdout）负责 Main 输入、执行流、模型设置、会话操作与原生查询；Harness 独立端点（Unix Socket／Windows Named Pipe）负责工具目录、子 Agent 控制、执行记录与子会话事件。
- 两个通道不承诺跨通道的全局消息顺序。订阅事件与 `stream.subscribe` 响应携带根会话与执行归属；`jobs.*`、`agents.tree` 响应带 Agent／Job 执行身份，但不重复携带根 `sessionId`（仅 `harness.info` 提供）；`tools.*` 等查询响应不携带归属。客户端不能仅按接收先后推断操作因果。
- `get_commands` 是 Slash 命令、Skill 与模板目录，不是工具目录；`get_tree` 是 Main 的 entry 树，不是 Subagent 树。Main 的原生消息查询与事件流不覆盖独立子会话。

### 启用条件与生命周期

- 端点仅在根宿主实际运行模式为 `rpc` 时创建。运行模式取自 Pi 的扩展运行模式，不扫描命令行，也不用 `hasUI` 推断。TUI、print 与 JSON 模式不创建、不监听、不发布该端点；内部 SDK 子会话不因父进程处于 RPC 模式而再次开启。
- 一个 RPC 根宿主提供一个端点。客户端通过 Agent 与 Job 标识访问子任务，不为每个子 Agent 新建监控端点。
- 端点使用独立地址，不与 `Main.sock`、Agent 端点或广播端点共用，复用受管 IPC 的创建、归属校验与清理。
- 端点创建失败时不发布发现记录，并通过宿主通知与状态报告原因；客户端此时只能观察到无记录或连接失败。该失败不阻止 RPC 宿主启动。
- 根会话切换、fork、reload 或退役期间，接口拒绝访问旧服务，旧订阅终止，不自动改指向新根；新根就绪后由客户端明确查询或订阅。客户端断开只解除观察，不取消子任务、不关闭 Pi。

### 地址与发现

- 端点地址为 `<socketRoot>/<session-uid>/harness-rpc.sock`；Windows 使用由同一目录派生的 Named Pipe。
- 同一私有目录的 `harness-rpc.json` 是机器可读发现记录，包含协议版本、地址、`sessionId`、`pid` 与起始时间；会话关闭时删除本会话目录下的发现记录（按路径，容忍缺失）。发现不依赖 Slash 命令，也不向 Pi 原生 stdout 注入记录。

### 协议

- 帧为换行分隔的 JSON。请求为 `{id, method, params?}`；响应为 `{id, ok: true, result}` 或 `{id, ok: false, error: {code, message, detail?}}`；订阅事件为 `{event: {subscription, seq, payload}}`。
- 每连接请求按顺序处理并保序响应。慢客户端的有界积压（默认 4 MiB，实现可调）超过上限时断开并释放订阅，不阻塞模型执行，也不静默丢弃事件后假装完整。
- 客户端不能自动重放结果未知的控制输入。异常、超时与断连不证明输入尚未入队。

### 方法

| 方法 | 职责 |
| --- | --- |
| `harness.info` | 协议版本、会话标识与进程标识 |
| `tools.catalog`、`tools.detail` | 工具目录与详情；报告 `registered`、`eligible`、`active`、`managed` 与 `permission`（`enabled`／`disabled`／`active`／`inactive`）；`catalog` 默认排除 `disabled`，`detail` 可显示 |
| `tools.enable` | 用户显式启用工具或分组，与 `/capability enable` 共用同一份领域操作；不作为模型可调用的通用授权工具 |
| `tools.permission.query` | 查询派生权限视图；`{expr?}` 返回 `scope`、`expression`、`entries` 与 `managed`；不返回来源或命中规则 |
| `tools.permission.enable`、`tools.permission.disable` | 显式启用或禁用目标；返回逐项结果、受影响工具，以及 `disable` 立即移出 active 的无独立声明成员与延迟到 compaction 的声明成员 |
| `tools.permission.reset` | 解除显式规则；返回 `reset`、`notManaged` 与仍然生效的 `stillManaged` |
| `agents.tree` | 当前根 Agent 树 |
| `jobs.list`、`jobs.get`、`jobs.result` | Job 列表、详情与单次结果；未就绪、不存在与读取失败分别表达 |
| `subagent.create` | 创建子任务；宿主绑定父身份、根会话、工作目录、继承快照与容量限制，返回已登记项与失败项 |
| `subagent.stop` | 请求取消指定子任务，区分请求取消与最终退出 |
| `message.send` | 按受管 IPC 地址（Unix Socket／Windows Named Pipe，不接受裸 Actor ID）投递、续跑或广播，返回领域回执与逐接收者结果；广播只允许父 Main 写广播端点，跨会话只允许 Main-to-Main，其他来源拒绝 |
| `history.read` | 读取指定 Job 的原生历史区间；running Job 返回已产生区间与 live 端，首个 Job 的 `null` start 是合法边界（按分支开头读取），memory-only 会话明确报告历史不可用 |
| `stream.subscribe`、`stream.unsubscribe` | 订阅或解除指定 Job 的子会话执行流；订阅响应携带读取边界（状态、轮次、历史区间、已产生消息与当前 `partial`），事件携带订阅、根会话、Agent 与 Job 归属 |

- 控制操作本身的业务输入与副作用保留；控制响应、查询结果与观察事件不写入 Main 的对话、分支条目或 TUI。
- 所有子任务操作使用装配时绑定的当前根服务；切根先关闭旧端点再装配新端点，旧代次服务在退役前其端点已关闭，晚到请求无法绕过代次与准入围栏。

### 执行流

- 实时数据源是子会话自己的原生事件订阅，保留完整原生事件类型与 Pi RPC 的 JSON 投影语义：不重复发送累计 `partial`，工具调用保留 `toolCallId` 与存在时的 `parentToolCallId`，推理只提供供应商实际返回的内容。
- 历史与实时流有明确衔接边界：订阅建立先于响应，响应返回当前 Job 的读取边界，包含 `status`、`round`、`history{startEntryId,endEntryId}`、已产生的 `messages` 与当前的 `partial`；客户端据边界补齐已产生内容后消费实时事件，不需要读取文件猜测增量起点。`live` 表示是否挂上实时源；running 与已终态 Job 都返回真实快照，订阅时 Job 已终态则不再补发终态事件，其状态只在边界中给出。
- `agent_end`、`agent_settled` 与 Harness Job 最终结束不是同一边界。订阅单独报告 Runtime 的 Job 终态；Job 可能继续消费停放输入或等待子任务，最终状态以 Runtime 为准。
- 订阅者异常或断连不影响任务执行；观察失败不改变任务结果。

## 异步 Shell

主机可安装 `pi-job`，由原有 Bash／PowerShell 工具运行终端任务（POSIX tmux，Windows psmux 3.4.0+）。`create --wait` 在指定窗口内等待，否则返回任务 ID；`poll` 默认返回新增输出；`send` 从 stdin 接收多行文字，`key` 发送显式按键。运行上限由独立的 `--timeout` 控制。完整命令、输出和安装契约见[异步 Shell](async-shell.md)。

注册和完成事件回到发起调用的 Actor 端点。Main 和子会话在每次 Shell 启动时获得各自的 `PI_AGENT_ID`、`PI_AGENT_SOCKET` 和执行代次标识；事件不占用 Agent 消息发送者身份，也不产生消息工具授权。未完成异步 Shell 与直接子节点共同保留 Subagent 当前 Job；完成事件先入队，后释放等待。

## 提示词与架构

本节指引与其他 namespace、MCP 指引共用分支记录与增量更新规则；会话恢复重放已有正文和落点。

工具提示词应表达上述使用流程和行为边界。提示词正文存放在 `prompts/`，通过 `src/prompt-text.ts` 的类型化缓存 getter 读取；执行代码保留数据装配、参数结构和权限判断。角色说明与路由偏好仍来自 `subagent-routing.json`，不新增模板框架或静默回退正文。

### Subagent 提示词装配

运行时始终读取 `prompts/subagent-tools.json` 与 `prompts/subagent-turns.json`。

| 模块 | 资产字段 | 装配位置 |
| --- | --- | --- |
| A：共同范围与通信 | tools 的 `namespace`、`instructions` | 初始共同指引随首次成员声明投影；正文变化在尾部增量更新，Capability 记忆不重复该 namespace 的 instructions |
| B：派生与协调 | tools 的 `create.guideline` | 随 `subagent_create` 首次声明投影独立系统段落，不追加到 list／stop 的共同指引 |
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

- 可视化／交互式任务管理界面，以及通过用户命令直接向子 Agent 发送消息。
- 远端审批对象、用户入口和批准后的流程。

上述需求暂缓实现，不阻塞当前核心接口，也不自动执行未授权代码。
