# 接口契约

## 状态与范围

本文规定 Harness 对外公开接口契约、使用流程与运行时行为边界。

实现职责见[当前架构](architecture.md)，参数与配置见[Harness 参数配置](harness-configuration.md)，未完成项与验收缺口见[已知问题](known-issues.md)。本文不规定内部模块划分、消息队列实现或用户界面形式。

## 术语

| 名称 | 含义 |
| --- | --- |
| Main | 根 Agent，逻辑地址 `<sessionHex>:main` |
| 创建者／父 Agent | 声明批次并接收子 Agent 显式消息的 Actor |
| Actor（子 Agent） | 持久身份与独立原生对话；跨多个 Job 保留目标、名册与历史 |
| Job | 一个 Actor 的一次执行；续跑创建新的 Job，`round` 是 Job 序号 |
| 批次 | 一次 `subagent_create` 声明的成员集合，会话内单调编号 |
| 逻辑地址 | `<sessionHex>:<segment>`，用于消息、查询与控制；不是文件系统路径 |
| 普通消息 | Agent 通过 `msg_write` 显式发送的消息 |
| Job 终态 | Job 结束的内部状态与唤醒；不是模型可见的 collaborator 结果消息 |
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
- MCP 服务器在后台连接，首个请求不为未选中的服务器等待：所有 MCP 工具注册为非激活，每个会话只在首个请求判定一次；仅当分支已声明、尚未注册的 MCP 工具存在时，才沿用 Pi 对 `direct` 服务器的启动等待，跳过判定后不在后续请求重新触发该等待。`/mcp` 管理器、连接恢复和实际工具调用的等待不变。
- 禁用全局 MCP 资源与模板列表。`read_mcp_resource` 还要求目标服务器具有当前启用且允许的入选工具；错误正文不返回服务器目录。
- 历史 Codemode 声明中的旧目录在请求投影中移除，不修改用户正文或磁盘历史。

MCP 配置中的 `codemode`／`deferred` exposure 不表示工具在 Capability 激活后只能从脚本调用。入选并激活的工具可以直接声明和调用，也可在 Codemode 中组合执行。接口已有原生声明或当前启用的 Codemode 查询入口时，结果只保留引用、名称、数量和接口入口；两者都不存在时保留调用所需的参数结构。

激活前会检查每个入选工具在当前会话是否有可用的调用入口：`direct`／`deferred` 工具在激活后直接声明，自带入口，不依赖 Codemode；仅能以 `codemode` exposure 从脚本调用的工具，若当前会话未启用、也不符合资格的 Codemode，则不可达，会被拒绝且不写入分支记录。部分入选工具不可达时返回 partial 并把原因按组告知模型、向用户显示汇总 warning；全部工具不可达且无成功 Skill 时失败。可达性检查不扩大为通用事务、自动回滚或历史授权撤销。

`ALL_TOOLS` 只返回工具名和短描述，不展开 TypeScript 接口。完整参数与工具指导由 `describeTool` 按需提供；`describeNamespace` 保留 namespace 指引和成员名称。目录查询不等待所有 MCP 服务器，宿主不添加主动 MCP 重连。实际嵌套工具调用继续经过 Pi 原生管线。

启用 `capability.lazySchemas`（默认空）后，仅在 Codemode 已启用且生效模式为 `only` 时，命中组或 `tool://<exact-name>` 单工具的参数与返回值 schema 不进入原生工具声明，也不内联进 Codemode 目录；发现结果与 `describeNamespace` 保留成员名称，`describeTool` 返回完整接口后经 Codemode 执行。生效模式可由模型 Preset 记录在分支上覆盖 Pi 设置。内部继承检索同样不再向检索模型重发被延迟的 schema；model-only 成员不能被延迟隐藏，应显式报告。

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

工具管理分别保存基线、按需激活和黑名单，不把用户管理操作当作检索成果。管理记录不进入 `<capabilities>` 资源指引；声明与执行依据当前集合、作用域及 SDK 状态，见[工具权限管理](#工具权限管理)。

`capability.blacklist` 提供启动默认禁止。分支手动黑名单与祖先禁止优先于工具选择；分支手动 base add 可覆盖当前 Preset 的显式减项。普通发现和按需激活遵守有效禁止。

严格工具 allowlist 可能拒绝不匹配的 MCP 成员。当前先写记录、再激活的顺序会让未激活成员残留在规范记忆中，后续投影可能再次展示它们。这是与成功获得能力才应累积的要求不一致的已知缺陷，详见[已知问题](known-issues.md#严格工具-allowlist-下的激活记忆不一致)。

API 协调应同时保证资源指引、工具状态与供应商接口声明一致。缓存命中是优化目标，不应以丢失工具或扩大执行权限换取前缀稳定。

### `/capability` 命令

用户命令直接调用工具管理领域操作，不经过发现模型，也不消耗检索 Budget。

| 子命令 | 行为 |
| --- | --- |
| `/capability`、`/capability list` | 查看当前会话已有的基线与按需工具 |
| `/capability list --activatable` | 扩展显示当前可按需加载的工具 |
| `/capability list --usable` | 筛选当前可使用的工具，包含符合条件的基线成员；与 `--activatable` 同用时取两者并集 |
| `/capability list --filter=<text>` | 按文本筛选目录 |
| `/capability base list` | 查看当前工具基线 |
| `/capability base add <target...>`、`base remove <target...>` | 修改基线成员，不改变按需集合或解除黑名单 |
| `/capability activate [target...]`、`deactivate [target...]` | 修改按需激活集合；省略目标时使用交互选择 |
| `/capability blacklist list` | 查看禁用规则及其生效来源 |
| `/capability blacklist add <target...>`、`blacklist remove <target...>` | 管理分支黑名单；不解除当前 Preset 或 SDK 的独立限制 |

目标支持精确工具名、`mcp://<server>`、`namespace://<name>` 与前缀模式。具体成员在操作时对照实时注册表解析，未知或受限制成员逐项报告。浏览不激活、不写记录；取消选择无副作用。补全覆盖五组命令及实时目标。

`/capability help` 是只读命令帮助入口，列出目标语法、修饰符、批量操作与交互选择方式，不发现或激活工具、不写分支记录。activate／deactivate 无目标时打开树形多选器，根层列出独立工具和 Namespace／MCP 容器，成员以 `├─`／`└─` 展示，确认后才统一提交。默认以半屏为目标；尺寸不足时只显示红色提示和退出方式，不显示可操作列表，恢复尺寸后保留先前选择。标题上方与按键提示上方均有横线，计入组件高度预算。父层每个容器显示最多约七行成员预览；折叠数量提示无连接符，与复选框对齐，其上最后一个工具用 `└─` 收尾。进入成员层后展示完整逻辑列表，通过有限视口滚动，不再使用 earlier／remain 折叠窗口。尺寸和可用高度预算与 `/btw` 复用内部 TUI 模块，业务会话与持久化不进入该模块。

选择器的 ↑／↓ 仅移动同级项，← 返回父层，→ 进入容器；PageUp／PageDn 按实际视口容量翻页，Home／End 到当前完整同级列表首尾。组件聚焦时接管宿主视口按键，不能滚动会话历史；退出后恢复宿主行为。Tab 勾选工具，容器行则批量勾选成员；Space 在容器行直接切换 schema 策略，不需要先用 Tab 切换字段。schema 控件仅在 Namespace／MCP 行提供，工具行不重复策略开关或内部状态字段；不显示 `load:explicit`。返回容器后保留成员光标与选择。激活确认使用 `[ns]` 加具体选中成员，避免确认时重新展开容器而影响未展示的新成员；deactivate 确认只提交具体成员名，不携带加载修饰符。尺寸不足时只接受取消，不应用选择；取消不写状态，不要求搜索功能。

基线添加与按需激活分别保存容器加载和具体成员选择。普通 Namespace／MCP 目标展开当前可激活成员；`namespace://<name>[ns]` 或 `mcp://<server>[ns]` 只加载容器元数据，成员须在同条命令中显式给出。多个容器和独立工具可以混用，显式成员按注册表归属匹配，不按参数位置划组。每个 `[ns]` 容器至少需要一个有效正向成员；成员全部被禁止、不可达或排除，以及默认展开后为空，均警告并拒绝整条选择，不写记录、不应用效果。

`-<tool>` 是本次选择的排除项，不写黑名单，不取消已有基线或按需成员。普通容器目标产生一次成员快照，不形成持续的全员激活规则；之后注册的新成员不自动加入，deactivate 单个成员也不会被容器重新激活。再次显式激活普通容器则重新选择当前成员，包括此前主动取消的成员。基线移除或 deactivate 容器按当前成员操作，保留容器加载记录。黑名单不接受 `[ns]` 或本次选择排除语法；Namespace 与工具的禁止分别保留，分支手动禁止和祖先禁止优先于工具选择。

activate 与 base add 的目标可附加 `[lazy]` 或 `[no-lazy]`，容器可组合为 `[ns,lazy]` 或 `[ns,no-lazy]`。不带 schema 修饰符时遵守配置和既有显式覆盖；显式成员策略优先于同批容器策略。同条命令可混合不同工具的 schema 策略；冲突或非法修饰符在写入前拒绝。显式 lazy 选择必须具有可用 Codemode `only` 调用路径，否则整条选择拒绝，不自动切换模式。base remove、deactivate 与黑名单命令不接受这些加载修饰符。

基线、按需激活、原始黑名单命中、实际阻断、SDK active 与当前可用性分别展示。手动 base add 可以覆盖当前 Preset 的显式减项，列表仍保留禁止来源。实际阻断持续约束已有声明和普通发现。

操作先写分支记录，再应用 SDK 效果。写入失败不改变工具集合，不宣称成功。已接受的管理意图与 SDK 实际激活结果分别报告；SDK 拒绝不能被当作已可用。命令只操作当前会话，不唤醒其他 Agent，不改变路由或 Budget。

记录写入失败由 `recordError` 表达；记录成功但 SDK 效果应用失败由 `effectError` 表达，不回滚已经落盘的意图，也不自动重放。`changed` 表达本次记录了哪些目标操作，不保证每个目标都发生了实际激活或移除，实际效果使用独立结果字段。

原生工具声明、Codemode 接口和动态指引继续遵循 Provider 协议及缓存边界，见[工具指引与缓存前缀](#工具指引与缓存前缀)。

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

Main 与普通 Subagent 在成功 compaction 后，若 `capability.pruneOnCompaction` 开启，或上次压缩以来应用 Preset 移除过基线工具，则移除窗口内未使用的 Capability 工具成员；使用证据包括直接执行结果和 Codemode 的持久化嵌套调用记录。显式禁用工具与发现恢复入口保留（不进入普通淘汰）。基础工具采用当前 Preset 快照中的工具选择；没有 Preset 工具选择时使用 Pi 设置的默认工具集。切换时保留的动态工具不纳入该基线，仍按窗口使用情况淘汰。MCP／Namespace 的发现记忆按成员收缩，空组从发现记忆移除；独立加载的容器说明不因最后一个成员取消而丢失。Skill 不参与淘汰，不断开 MCP 连接。

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

静态工具指引通过 SDK 原生 `ToolDefinition.promptGuidelines` 提供；Capability 记忆、Preset 指令和动态指引在 `before_agent_start` 写入 `systemPromptOptions.sections`，由 SDK 比较并持久化更新。同 turn 的必要变化在外层工具结果边界合并为带内容的 `harness-context-sync` 消息，经 SDK 编码为 user。中途自动压缩或压缩后续跑会重新提供当前非空状态，即使业务状态未变，也不能漏掉被压缩丢弃的信息。未变的普通工具循环不注入尾部 developer 或 user。

当前分支事实在重新打开、回退与继承后恢复当前状态。SDK 管理原生声明与 provider 编码；完整的强制提示词可抑制 Harness 系统段落，已持久化的 user 状态消息仍属于对话历史。Harness 不改写旧消息，不读取旧放置记录，不添加显式缓存断点，也不保证精确历史请求复现、全请求前缀连续性或服务端命中。权限与后端准入校验独立生效。

### 与 Subagent 的关系

**Capability 独立管理内部检索会话。** `capability/manager.ts` 持有本表面的在途检索，取消、树导航、fork、会话切换和关闭会使旧检索失效；旧结果不得保存发现记录或激活工具。取消导航不关闭 manager，后续检索仍可启动。`capability/session.ts` 负责独立的内存 SessionManager、隔离 loader 和 SDK 会话装配，底层继续复用 `session/execution.ts` 的 SDK 执行清理原语及共享 Budget，不经过 Actor／Job 注册。manager 仅在每次检索完成清理后释放其在途引用。

Capability 与 Subagent 分别通过 `extensions/capability.ts`、`extensions/harness.ts` 注册，共用底层执行能力和同一会话的配置、资格状态，不创建两套执行环境。Capability 直接调用内部执行入口，不要求公开的 `subagent_create`、`subagent_list` 或 `subagent_signal` 工具已注册或已激活。

Capability 调用仍等待检索完成，再返回筛选后的资源。复用执行代码不改变检索权限，不向内部检索 Agent 开放父 Agent 的执行权限。

## 工具权限管理

工具管理分别拥有基线、按需激活集合和黑名单。工具选择优先级为「硬性禁止 > 分支手动 base add／remove > 当前 Preset 工具选择 > 有效启动基线」。普通发现与按需激活继续遵守有效禁止；声明和调用还受注册状态、SDK 限制、角色与深度约束。

### 状态、记录与迁移

- `capability-tool-base` v1 保存初始基线及后续手动 add／remove；`preset-state` v2 保存 Preset 工具选择与本次加入启动基线的默认工具。
- `capability-tool-dynamic` v1 保存 activate／deactivate；发现选择也进入按需集合，`capability-prune` 移除被淘汰成员。
- 基线与按需记录中的成员为具体工具名，容器引用独立保存在同条记录的加载信息中；一条命令不需要另建跨记录事务。容器拥有自己的描述与共同指引，成员拥有工具专属指引；两者不通过复制整组指引绑定。
- `capability-tool-blacklist` v1 保存 add／remove。配置 `capability.blacklist` 提供启动默认黑名单，当前 Preset 的显式最终减项提供该 Preset 生命周期内的黑名单。各来源不因加入基线或激活而失效。
- 三类分支事实仅追加，导航与恢复按当前分支重放；运行时不读取旧权限记录。历史转换仅由显式离线脚本执行，不在启动或请求中迁移。
- 离线 `npm run migrate:tool-permissions -- <session.jsonl...>` 将支持的旧 enabled 记录转为基线添加，disabled 记录转为黑名单添加；保留原生条目 ID 与检查点。含 reset tombstone、同条记录混合 enabled／disabled、新旧记录混杂，或需要实时目录才能展开的 enabled 组／前缀等不能安全转换的文件会被拒绝，原文件保持不变，需单独离线处理。
- SDK 的 `--exclude-tools` 和 allowlist 独立生效。扩展拿不到原生 `--tools -name` 的原始减项，因此该参数仍只遵循 Pi 原生初始选择语义，不冒充 Harness 黑名单。

### 派生视图与查询

列表分别报告基线成员、按需成员、黑名单命中、SDK active、可激活与当前可用等事实，不用一个 state 字段覆盖不同维度。当前目录只观察实际注册状态；未注册不等于已禁用。黑名单查询可以保留未注册目标，以解释未来注册时的禁止规则。

### 生效优先级与入口

- 基线移除只改变基线；deactivate 只改变按需成员。工具仍属于另一集合时保持相应请求资格。
- 分支手动黑名单（含组和前缀）优先于基线、Preset 与按需激活；手动 base add 可覆盖当前 Preset 显式减项。覆盖不删除禁止记录。
- SDK 初始激活或 Preset 更新加入的默认工具仍遵守有效禁止。
- 移除手动规则不移除当前 Preset 的独立禁用，也不能解除 SDK 限制。配置默认目标可由分支上的显式移除覆盖；尚有其他禁用来源时如实报告。
- Preset 切换替换其工具选择及禁用贡献；clear 撤回两项贡献，保留模型、thinking、有效启动基线与手动分支选择。
- 黑名单管理工具使用资格，不自动禁用同名扩展命令或领域控制操作。已开始的工具调用不自动取消。

### 模型提示与 compaction

集合移除或禁用立即影响执行资格。没有独立声明的成员立即移出 SDK active；有独立声明的成员可按现有协议保留到下一次成功 compaction，不能用声明仍存在推断当前可执行。

`capability-tool-blacklist-notice` 保存必要的模型禁用提示，不新增头部指令区块。压缩成功后移除失去资格的独立声明；压缩失败不提前删声明。普通未使用淘汰保护当前基线，按需工具按使用窗口收缩；黑名单的禁止不依赖普通淘汰开关。

### 子会话

基线和按需选择描述当前会话的可用工具，不是 root-only 授权。子会话不再受限于父会话已注册的工具目录，可以发现并启用仅在子会话注册的工具；祖先黑名单通过实时父作用域传播，角色排除与固定深度约束继续优先；子会话不能靠自己的 Preset、base add 或 activate 解除祖先禁止。根配置的启动禁止在子会话中仍是外部围栏；父会话对该禁止的本地 base 覆盖只对父会话生效，不构成对子会话的继承授权。已记录历史不被改写，每次执行重新检查当前资格。

### 程序接口

RPC、用户命令、Preset 和发现发布复用工具管理领域操作。RPC 只处理校验、调用方绑定与结构化传输，不复制集合或规则状态，见[Harness RPC 独立接口](#harness-rpc-独立接口)。

## 模型 Preset

`extensions/preset.ts`（随包默认加载）提供模型切换、思考级别、模型专属指引和工具选择。

**配置。** 读取全局 agent 目录的 `presets.toml` 与受信项目的 `.pi/presets.toml`，项目同名项整体覆盖全局。只读取 TOML，不对同名 `.json` 回退。`tools` 支持 `+name`／`-name` 修饰符或纯裸名列表；两种方式混用会拒绝应用。修饰符叠加到有效启动基线，裸名列表替换该层；用户手动 base add／remove 保留。显式减项在当前 Preset 生命周期内禁止普通按需激活，可由分支手动 base add 覆盖。保留的按需工具继续由压缩淘汰策略管理。

**入口。** `/preset` 打开选择器，`/preset NAME` 应用指定项，`/preset clear`（`none`／`off`）停止管理，`--preset NAME` 在启动时应用；状态栏显示当前 Preset。这些交互入口只作用于当前 Main。Fresh routing 显式选择命名或临时 Preset，复用配置解析、应用与指引投影；Inherited 保持捕获的模型与分支状态。

**应用与失败。** 先校验模型存在于目录，再 `setModel`；模型不可用则整体不应用并报错，绝不报成功；thinking 与 tools 随后应用。`instructions` is rendered from the current resolved branch snapshot as a request-local system section on every model call. Resume, tree, fork and reload restore current business state, without historical placement replay. A complete forced prompt retains SDK precedence.

**版本与恢复。** `preset-state` v2 保存应用时的模型、思考级别、工具操作与名称投影、Codemode 模式、指引及 `contentHash`。修饰符候选可以纳入新注册的 Harness 默认工具；确认更新时新增默认名与快照写入同一条记录，后续清除保留这些基线增量。手动分支选择、展示描述及工具 schema 不参与哈希；晚注册的 MCP 不自动进入基线。TUI 恢复时可以更新整套 Preset 或记住跳过当前候选版本。缺失或无效的配置沿用记录版本，并在状态栏标示。RPC 通过 `presets.current` 读取版本差异，通过 `presets.apply` 更新。

**分支与清除。** `/tree` 静默刷新状态栏并同步目标分支的 Harness 工具差异；Pi 管理模型和思考级别恢复。`/preset clear` 可在配置不可读时运行，撤回 Preset 工具、黑名单、指引和 Codemode 贡献，保留用户手动工具选择、有效启动基线、模型与思考级别。Codemode 模式随 Preset 快照生效，并供原生 Codemode 与 `capability.lazySchemas` 读取。

**离线迁移。** 旧 `preset-state` v1 使用 `npm run migrate:preset-state -- --session FILE` 预览转换。先关闭会话并备份，再使用 `--apply --offline`。迁移只读会话 JSONL，不读取 `presets.toml`。旧展平工具数组转换为裸名替换；为保持分支工具成员，离线脚本在需要修正的位置插入标准 `capability-tool-base` 条目，将直接子节点挂到该条目下。已有条目 ID 保留。转换后逐分支核对工具成员，当前的禁止规则仍按 v2 契约执行。

迁移插入的增减与手动基线记录遵循相同规则；移除项也会进入声明清理流程。若在 `/tree` 直接选中修正条目之前的旧 Preset 节点，需选中后续修正条目才会应用这批增减。应用前保留的 `.pre-preset-v2` 文件是完整恢复点。

## `/btw` 独立问答

`/btw [question]` 在交互式终端底部打开独立问答面板（内联停靠，不覆盖主对话）。无参数时显示输入框；带参数时直接提问。打开时捕获当前分支上下文、系统提示词、模型、思考级别与缓存标识，再追加独立问答指令。虚拟模型使用最近一条响应的物理模型；无法确定时拒绝启动。

同一面板中的追问沿用临时会话。问答只存在内存中，不写入主对话、不生成 Subagent 任务、通知或通信端点，也不占用子节点名额。所有工具调用由执行钩子阻断，继承的声明仅保留不可执行的占位实现；manual 工具声明仍按子会话边界排除。

面板固定在终端底部、占满可用宽度，以终端半屏（`round(终端行数 / 2)`）为目标，不低于配置的组件最小行数 `btw.panelMinRows`（默认 8 行），不随回答长度变化；主对话在面板上方保持可见与可滚动，关闭后恢复主输入框。共享 TUI 预算默认给组件外的宿主区域预留 4 行，面板可用高度为「终端行数 − 4」；该空间不足组件最小行数时，`/btw` 报错拒绝打开。`panelMinRows` 描述组件自身，不是整个终端的最低高度。SDK 未公开实际分配高度，预留量是布局估算，不保证任意宿主布局均精确适配。打开期间把终端缩小到该下限以下时，面板改为一行错误提示并停止接受输入，恢复高度后自动恢复显示，问答内容与滚动位置保持不变。

SDK 停靠区的页脚、待处理消息、状态行与 widget 会共同占用空间，可能裁切面板底部。首选最小行数约束面板请求的高度，实际显示空间由 SDK 分配；放大终端或减少 widget 可恢复显示。

`/btw` 只在全屏（fullscreen）渲染下可用；常规（regular）渲染下拒绝打开，并提示把 `tuiMode` 设为 `fullscreen`。回答区独立滚动：鼠标滚轮与 PgUp／PgDn 只移动回答视口；溢出时显示滚动条，可点击或拖拽滑块（拖动在指针移出滚动条列后继续，直到释放），指针落在标题行或输入框同一列不会滚动回答。停在底部时自动跟随新文本，向上阅读时不因流式更新跳动，滚回底部即恢复跟随。面板消费落在其范围内的滚轮事件，边界处不会带动主对话滚动。

Enter 提问，Shift+Enter 换行，Ctrl+C 仅取消当前回答（取消完成后可继续提问，失败会显示错误），Esc 关闭面板并清理临时会话。主会话退出、重载或切换分支时也会关闭面板。重新打开会捕获新的主对话快照，不恢复之前的问答。

## Subagent

### 身份与逻辑地址

Subagent 域分三层：创建者声明的**批次**、持久的 **Actor（子 Agent）** 与 Actor 的一次 **Job**。Actor 保留自己的原生对话、目标、批次名册与历史；Job 只表示一次执行，续跑创建新的 Job，角色、模型、目标与分支上下文沿用该 Actor 已记录的身份。`round` 只是该 Actor 的第几次 Job 序号，不是独立身份。

每个会话用稳定的 8 位小写十六进制 `sessionHex` 标识，逻辑地址为 `<sessionHex>:<segment>`：

| 地址 | 含义 |
| --- | --- |
| `<sessionHex>:main` | 会话的 Main Actor |
| `<sessionHex>:sub_<batch>` | 单成员批次的 Actor |
| `<sessionHex>:sub_<batch>-<member>` | 多成员批次中第 `member` 个 Actor |
| `<sessionHex>:batch_<batch>` | 批次组选择地址 |
| `<sessionHex>:<segment>/children` | 某 Actor 的直接子节点选择地址 |

`batch` 是会话范围单调递增的编号，创建时分配，永不复用，包括被放弃分支或旧文件已占用的编号。Actor 地址在其生命周期内稳定，续跑不改变；没有父节点别名，`subagent_create`、`subagent_list` 与子会话上下文都直接给出创建者与同伴的真实地址。逻辑地址只在本机受管 IPC 命名空间内解释，不是文件系统路径，也不是另一套传输方案。

### Subagent 调用形态

| 操作 | 当前接口与行为 |
| --- | --- |
| 创建 | `subagent_create({context?, agents: [{goal, name?, inheritContext?}]})`；等待本批各 Actor 本地就绪（路由分配、会话创建、扩展与工具配置完成、初始输入就绪且 IPC 监听准备就绪），不等待首次模型调用或第一轮完成 |
| 创建返回 | `batch`、`address`（批次组地址）、`roster` 与 `items`；`roster` 按声明顺序给出每个成员的 `address`、`name`、`goal`，`items` 另含 `id`（本地 Actor key）、`role`、`model` 与可选 `warnings`。启动前失败以 `start_failed` 报告失败成员，已登记 Actor 保留，不自动重建 |
| 名册与上下文 | `context` 是整批共享的背景与约束；`goal` 是成员自己的交付目标；`name` 只是名册标签，可省略。批次创建时固定目标与名册：单成员批次只接收共享 `context`，自身地址来自宿主身份段、目标来自执行输入；多成员批次额外接收完整名册与一条正向协作提示 |
| 上下文继承 | 默认不继承聊天历史；`inheritContext: true` 捕获父会话快照 |
| 查询 | `subagent_list({id?, all?})`；返回嵌套 `children` 树，不返回 `parentId` 或外层 `items`。默认窗口每组最多 4 项、活跃优先，`all: true` 返回完整树，`id` 返回可见子树或 `null` |
| 控制 | `subagent_signal({target, action})`，`action` 为 `interrupt` 或 `stop`；`target` 是一个完整逻辑地址：单 Actor、批次组地址或直接子节点选择地址。广播排除发送者自身，单个目标指向自己时拒绝 |
| 结果读取 | Job 结束不向创建者的模型投递自动结果消息；终态结果保存为 Job 记录与历史视图，通过 `history.*` 路径或 RPC `jobs.result` 读取 |
| 通信 | `msg_write({to, content})`，`to` 是完整逻辑地址；`write` 保持 SDK 原生文件工具完全不变，不用于消息发送 |
| 续跑 | 向已停止的 Actor 发消息，会启动同一 Actor 的新 Job；Actor 的目标、身份与历史保留 |

#### 列表投影

`subagent_list` 与 `/subagent` 使用同一份投影。节点携带 `id`、`address`、`name`、`status`、`role` 与 `kind`（`fresh`／`inherited`），不返回目标、活动对象、模型、Socket、深度或原始 Job 状态字符串。`status` 是单一字符串：正常结束为 `idle`；终态为 `stopped(failed)`、`stopped(cancelled)` 或 `stopped(unknown)`；运行中的 Job 由执行侧附加 `running(thinking)` 或 `running(tool-<n>s)`，没有可观察阶段时保持裸 `running`；Main 没有 Job，始终为裸 `running`。不存在 `completed` 标签或独立活动对象。可用历史时附带 `history`（`summary`、`cleanJsonl`、可选 `result`），不携带 `jobId`；读取失败以该节点的 `historyError` 报告。列表不发布内部视图目录或 CLI 页脚路径；当前轮次由 `history` 路径本身确定，Job 标识只保留在 Job 专属接口中。`/subagent` 的文本视图另外从 Actor 身份显示模型名；模型不属于工具或 RPC 的列表结果。

初始工具集与激活状态按调用方深度确定：

- Main 会话：基础工具沿用 Pi 的工具配置。`subagent_create`、`subagent_list`、`subagent_signal` 和 `msg_write` 均已注册，但默认不激活；Capability 选中整个 `subagent` 命名空间后一起激活。收到跨 session 消息时，宿主在触发模型轮次前自动激活 `msg_write`，使 Main 可以直接回复；该激活不写能力记录，也不加载命名空间的其余工具。
- 子会话（Subagents）：非叶节点加载 `subagent_create`、`subagent_list`、`subagent_signal`、`capability` 与 `msg_write`；叶节点（`depth === maxDepth`）仅保留 `subagent_list` 与 `msg_write`。子节点独立获得 `msg_write`，但祖先禁用与角色最终排除仍可阻止它。
- `write` 是 SDK 原生文件工具，完全保持原生行为，不被拦截或覆写，不承担 IPC 消息发送。

Fresh 路由保留角色及其职责提示词，其他执行配置复用命名或临时 Preset。工具以子会话自己的默认集合为基线，应用 Preset 的 `tools` 修饰；显式最终减项作为执行作用域 denial 始终排除，后续激活不能绕过。SDK 注册排除只承载固定深度限制，祖先限制继续由作用域父链提供。Preset 的 Codemode 模式与指引使用同一分支记录及投影路径。候选与已解析选择固定在 Actor 身份中，续跑不读取后来编辑的配置。配置格式与离线转换见[Harness 参数配置](harness-configuration.md#fresh-routing-presets)。Root 装配入口由子会话 surface 替代，不重复加载。Fresh 与 Inherited 均独立加载已配置的扩展与 MCP 后端（`noExtensions: false`）；Inherited 在捕获时通过父会话生成该调用的 assistant 消息锁定底层物理模型（`physicalModelForCall`），避免虚拟模型在子会话中重路由。它恢复捕获的工具白名单、系统提示词与思考强度。白名单仅限可重新创建的文件型扩展工具与 MCP 工具，父会话专属诊断工具不传递。若继承的异步 MCP 尚未完成注册，按 `subagent.inheritedToolWaitMs` 有界等待，默认最多 10 秒。

Subagent 共享工作目录。深度上限（`subagent.maxDepth`，默认 2）与三个独立的父节点直接子节点上限通过 `harness.json` 配置：`subagent.maxActiveBatches`（默认 4，同批任一成员仍在执行即占用）、`subagent.maxActiveSubagents`（默认 7，Fresh 与 Inherited 合计）与 `subagent.maxActiveInheritedSubagents`（默认 3，前者中的 Inherited 子集）。三个上限相互独立：声明的 Inherited 上限可以高于总上限，配置解析不改写也不拒绝该声明，运行期实际只取两者较小值。准入按深度、新批次、全部直接子节点、Inherited 子集依次检查；续跑重新检查同一组上限。进入 `stopping` 或 `finalizing` 的 Job 仍占用名额，直到原生资源实际退出。根服务与子会话使用同一份配置快照，已运行 Job 不受文件修改影响；这些上限不作为公开工具参数。

`subagent_create` 在本批子会话本地就绪后返回。本地就绪包括路由分配、会话创建、扩展与工具配置完成、初始输入就绪和 IPC 监听准备就绪。它不等待首次模型流分发，也不等待目标完成。本地准备阶段的失败会使 create 报错，运行阶段的失败记录到 Job 终态。

### `/subagent` 命令

扩展命令 `/subagent` 提供同一根代次的观察与控制入口，不经过模型轮次，也不消耗 Job Budget。

| 子命令 | 行为 |
| --- | --- |
| `/subagent`、`/subagent list` | 打印当前根的 Actor 树、逻辑地址、名称、状态、角色与模型；`--all` 展开完整树，`--id <actorKey>` 只看指定子树 |
| `/subagent interrupt <target>` | 中断目标 Actor 的当前原生执行；不结束 Job、目标或名额。`target` 是 Actor id、完整逻辑地址或 `children` |
| `/subagent stop <target>` | 请求结束目标的当前 Job；Actor、目标与历史保留。Actor 没有运行中的 Job 时保持幂等 `ok`，视图提示无运行任务 |
| `/subagent stop children` | 对 Main 的全部直接子节点逐一停止；等同 `<sessionHex>:main/children` 选择地址，排除发送者自身 |
| `/subagent sessions` | 列出同一 Socket 根下所有存活 session 的短标识、进程、工作目录、session id 与该 session Main 的逻辑地址；当前 session 以 `*` 标记；目录读取失败时报告错误通知，不报告「none」假成功 |
| `/subagent sessions connect <uid\|sessionId>` | 把选中存活 session 的联系信息作为一条本地上下文消息追加给当前 agent，并启用 `msg_write`；不向对方发送任何消息 |

- CLI 的 `children` 与 `main` 是作用于当前 Main 的本地简写；`children` 展开为 `<sessionHex>:main/children`，替代旧「停止全部」，`main` 解析为 `<sessionHex>:main`，因 Main 没有可控制的 Job 而被拒绝。模型工具与 RPC 只使用完整逻辑地址，不暴露这层简写。
- 列表输出为纯文本：树形缩进，`●` 活跃、`◐` 等待或收尾、`○` 空闲、`?` 未知；列固定为逻辑地址（已声明标签时附 `(label)`）、种类（`fresh`／`inherited`）、角色、目标与活动。标签只是显示元数据，不替代地址，也不参与寻址或唯一性判断。标题给出当前根的全部 Actor 数；活跃数与 Fresh／Inherited 分项只统计运行中的 Actor。窗口隐藏节点时给出提示。
- 列表与信号只读或只做控制：不发送消息、不 steer、不唤醒；消息仍由 `msg_write` 与 IPC 提供。`sessions connect` 只向本会话追加一条上下文消息，不唤醒任何 Actor 或 session。
- 命令与 Root 同代次：退役或切换期间以 `runtime_transitioning` 拒绝。列表在异步读取后重新核对根代次，根已切换时不渲染旧快照。同代次的元数据写入失败不阻止列表显示或请求控制，但仍阻止新工作；取消不表示终态已持久化。信号请求不等于终态，Job 仍占 Actor 与名额，直到原生执行退出。

### 结果与历史

Job 结束时，宿主统一裁定终态（`completed`、`cancelled` 或 `failed`），写入一次终态事件，包含本轮结果、`status`、`jobId`、Job 序号 `round`、历史区间与 Budget。该终态是**内部状态与唤醒**，不伪装成 collaborator 发来的结果消息，也不由宿主自动向创建者模型投递正文。

- 结果正文按 Job 保存：持久化会话写入 `views/<jobId>/result.txt`，通过 `history.result` 返回路径；`summary.md` 与 `transcript.jsonl` 用于按需回顾该轮。内存会话不声称存在持久化历史，结果保留在进程内 Job 记录。
- 视图写入失败不改写模型结果，`historyState` 与 `historyError` 随终态记录；`result.txt` 只含原始结果，不添加标题、不裁剪空白、不补换行。
- 结果绑定 `agentId`、`jobId` 与 Job 序号 `round`，只取本 Job 原生历史区间；续跑不附带此前 Job 或父会话背景。
- 读取入口：模型与外部客户端使用 RPC `jobs.result`、`jobs.get` 与 `history.read`；`subagent_list` 节点只给出可用历史路径，不嵌入正文。

**子节点终结继续父 Subagent 的当前 Job（parent-hold）。** 只要还有处于 `running`、`stopping` 或 `finalizing` 的直接子节点，或当前执行仍持有未完成的异步 Shell 任务，正常执行的父 Subagent 在回复结束后保持 `running`，保留当前 Job、Budget、会话和活跃名额。队列为空时暂停活跃时间计费，仍受总存活租约限制；消息、子节点终结或最后一项工作结束后在同一 Job 内继续。全部结束后父 Subagent 才正常收尾。

子节点终结不创建 continuation Job。父 Actor 若已因取消或失败关闭，晚到的子节点状态不自动续跑；只有显式消息向已停止节点发起新 Job。

### 显式交付与收尾提醒

Agent 之间的可见交付只有显式消息。用户在创建批次时声明目标；成员通过 `msg_write` 向创建者或同伴报告进度、阻塞、问题与最终结果。宿主不把成员的最终 assistant 正文当作结果消息转发。

正常 Job 收尾前，执行侧检查最近最多 5 个包含工具调用的轮次：只要其中出现过一次 `msg_write` 工具执行（不区分目标、参数或执行成败），就不再提醒；经 Codemode 发起的嵌套 `msg_write` 同样以原生工具执行事件计入。若全部未出现，宿主在同一 Job、同一 Budget 内追加一次自提醒并获得一次继续机会；发送与否仍由成员决定。该提醒最多一次，不周期检查、不强制发送、不创建额外 Job，也不产生第二次机会。原生队列与在途交接先排空再判断；提醒后再次排空队列才允许收尾。

### 广播

`msg_write` 可写批次组地址 `<sessionHex>:batch_<batch>` 或某 Actor 的 `<sessionHex>:<segment>/children`，向该组全部成员广播，不递归展开其他组。

- 广播排除发送者自身；过滤后没有接收者时返回成功回执，接收者列表为空，而不是「发给自己」错误。只有单个目标恰好等于发送者时才以 `invalid_target` 拒绝。
- 每个接收者使用与单独发送相同的准入和续跑规则；停止节点在允许续跑时启动新 Job，仍受并发上限等限制。
- 广播有部分失败时，消息写入工具报错并指出失败接收者，不返回只含成功项的结果，也不自动重试已成功的接收者。
- 跨 session 不支持广播。

### 跨 session 消息

跨 session 消息用于让一个 Pi session 的 Main 联系同一用户、同一 Socket 根下另一个存活 session 的 Main。它不建立跨主机调度，也不自动广播到其他 session。

**平台范围**：Unix Socket 与 Windows Named Pipe 共用同一份目录、记录与 Main 与 Main 之间的准入。地址属于哪个 session 由逻辑地址的 8 位前缀判定；业务层不把管道地址当文件系统路径推断。

- **地址**：目标 session Main 的逻辑地址 `<targetHex>:main`，与本地 `msg_write` 使用同一地址空间，没有第二套 scheme。`/subagent sessions` 显示该逻辑地址；外部编排者读取目录记录的 `socketDir` 只为定位 `<socketDir>/main.sock`。指向其他 session 非 Main 地址的路径以 `invalid_target` 拒绝。
- **发现**：`/subagent sessions` 是用户侧发现入口；模型侧不注册 session 工具，外部编排者直接读取同一份共享目录：`socketRoot/sessions/<uid>.json` 由各 session 在 `initialize` 后发布，`retire` 时按记录归属删除；读取时按 `pid` 存活与记录自洽过滤，畸形或残留记录被忽略且不由他人删除。共享目录缺失（`ENOENT`）视为空目录；其他目录读取错误向调用方如实抛出并在命令入口报错，不伪装为「无存活 session」。记录只含稳定 uid（8 位十六进制）、session id、原生 session name、工作目录、`pid` 与起始时间，不含拓扑或对话内容。`pid` 只在本机解释，因此 `socketRoot` 必须保持本机私有。
- **补全**：`/subagent sessions con` 补全为 `sessions connect `；随后按实时存活目录补全目标 uid，候选显示会话名称、工作目录与完整 session id。可按 uid／完整 session id 的前缀或名称筛选；排除当前会话，不产生授权、激活或消息写入。选中后执行 connect 时仍重新校验目标是否存活。
- **连接**：`/subagent sessions connect <uid|sessionId>` 把该 session 的 uid、原生 session id、原生名称、工作目录与 Main 逻辑地址作为一条原生自定义上下文消息追加到当前会话：不触发新一轮，忙碌时按 SDK 队列语义在当前轮结束时落盘、下一轮可见；不改写提示词头部、不复制对方 transcript、不注入整份目录、不建立持久连接状态。同一次 connect 通过按需激活使 `msg_write` 可用；黑名单或 SDK 限制阻止该工具时明确报告失败，不以连接动作解除禁止。目标未知或已退出以 `session_not_found` 报告，指向自身以 `invalid_target` 拒绝；connect 只写本会话，不发送消息、不唤醒对方。
- **发送**：`msg_write` 接受上述逻辑地址，且只有 Main 可发送。宿主先按本 root 的会话前缀解析：属于本 session 的地址走同一进程内的领域写入（Main 写给自己的 `Main` 由 self-send 规则拒绝）；不属于本 root 时，只有目标为已发布 session 的 `:main` 才按跨 session 写入。线上帧为 `{from, to, content}`，`from` 由发送宿主绑定为 `<sender-uid>:main`，`to` 为目标 `<uid>:main`；模型不提供发送者或独立 session 字段。
- **接收**：目标根只在其 `main.sock` 接受此类帧，并校验 `from` 与 `to` 都是完整逻辑地址。`from` 的 session 前缀必须是当前存活的已发布 session；发送者自身的 uid 映射为本地 `main`，交由 Runtime 的 self-send 规则拒绝。通过后把复合身份映射为 Runtime 的外部发送者描述（session id、完整 `from`、回复地址），不把复合身份当作本地 Actor key。
- **呈现**：接收方消息沿用统一的 `Message from` 标签，跨 session 的 `from` 显示完整身份 `<uid>:main`；回复提示使用发送方真实的逻辑 Main 地址。普通消息不显示发送方的执行状态。
- **边界**：跨 session 只做 Main 之间的消息，不能广播；终态与 parent-hold 仍只属于本 session，子 Agent 不参与跨 session 交互。未知或已退出的 session 以 `unknown_session` 拒绝。超时、断连或错误不证明消息未入队，宿主不重发。
- **信任**：session 记录与 `from` 都是同用户本机进程的声明，不构成认证协议；与外部 Socket 客户端属于同一信任模型。

### 外部编排接口

session 生命周期（创建、恢复、停止、轮询、定时检查）与 `/session`、`/cron` 命令由独立的编排项目承担。本仓库不注册 `session_*` 工具，也不提供进程托管或管理协议；这里只保证外部编排所需的稳定接口。

- **发现**：`<socketRoot>/sessions/<uid>.json`（版本化记录）。字段为 `version`、`sessionId`、`uid`、`socketDir`、`pid`、`cwd`、`name`、`startedAt`。记录由 session 自己发布、按归属删除；读取方按 `pid` 存活与记录自洽过滤，畸形或残留记录被忽略且不由他人删除。`uid` 是 8 位十六进制的派生地址，用于寻址与判同；`sessionId` 是原生身份，`name` 是原生显示名。
- **寻址**：`<socketRoot>/<uid>/main.sock`（Unix）或该目录派生的 `\\.\pipe\pi-harness-<8 位命名空间>-main.sock`（Windows）。每个 session 只暴露一个 Agent IPC 端点 `main.sock`；Harness RPC 是独立协议的 `harness-rpc.sock`，不承载 Agent 消息。其他 Actor 与选择器都是逻辑地址，不是独立 Socket 文件。
- **消息**：向目标 `main.sock` 写单帧 NDJSON `{"from":"<sender-uid>:main","to":"<target-uid>:main","content":"..."}`；接收端在 IPC 边界校验两端都是完整逻辑地址、发送者 uid 是当前存活的已发布 session，并映射为 Runtime 的外部发送者描述。只有 Main 参与跨 session；自发、广播与非 Main 目标拒绝；不确定交接不重发。
- **异步 Shell 回调**：同一 `main.sock` 还接受 `kind: "async-shell"` 帧，帧中必须带 `agentId` 与执行租约 `token`；根按 Actor 路由到该租约，身份不匹配或租约失效时拒绝。回调不伪装成 Agent 消息，也不产生消息工具授权。
- **编排者身份**：外部编排者必须作为已发布的 Pi session 参与（通过 SDK 或 CLI 运行），复用上述发布、寻址与收发。本仓库不为非 session 的外部进程新增客户端身份、第二套接收端点或管理通道。
- **名称**：原生 session name；`/name` 通过 `session_info_changed` 同步到目录，其他 session 与人类界面读取同一份名称。
- **平台与信任**：POSIX Unix Socket／Windows Named Pipe；同一用户本机；记录与 `from` 都是声明，不是认证。
- **非目标**：进程创建/停止/托管、stop/poll 的宿主请求协议、cron、管理范围、`/session`/`/cron`、transcript 读取与 `session_*` 工具。

`/subagent sessions` 是只读发现视图；`connect` 只把选中 session 的联系信息写入本会话上下文并启用 `msg_write`，不向对方发送消息，也不构成管理入口。

### 思考强度

候选 Preset 使用 `thinkingLevel` 请求级别，例如 `"thinkingLevel": "high"`，未配置则保留子会话默认值，不通过 Harness 区间计算。请求级别传给 Pi SDK，由原生 `clampThinkingLevel` 调整到模型支持的档位；不支持 reasoning 的模型使用 `off`，路由不因该档位不受支持而拒绝启动。Inherited 模式传入捕获的父会话思考强度，同样由 Pi SDK 按实际模型能力应用。Actor 记录子会话实际生效的强度供续跑使用。

### 任务语言

任务描述宜主要使用英文以匹配路由器能力。系统对任务语言没有硬拒绝策略，不设非 ASCII 字符比例拦截。

### 通信指引

`msg_write` 位于 subagent 命名空间。Main 默认不启用该工具；Capability 选中整个 subagent namespace 后，一并启用 `msg_write`。所有子 Agent 的 Harness 工具组独立提供该工具，仍受祖先禁用与角色最终排除约束。

调用方只提供完整逻辑目标地址和纯文本消息；`to` 必须是 `<sessionHex>:main`、`<sessionHex>:sub_<batch>[-<member>]`、`<sessionHex>:batch_<batch>` 或 `<sessionHex>:<segment>/children`，不是 Socket 路径。宿主负责通信封装、消息分帧（`src/ipc/message.ts` 中的 `managedFrame`）和发送者绑定；内部传输格式不属于 Agent 的调用契约。

参数示例：

```json
{
  "to": "<sessionHex>:main",
  "content": "Please review the test results."
}
```

消息正文中的换行或 JSON 文本按普通内容传递，不被当作多个报文或宿主元数据。调用方不提供发送者身份；宿主统一绑定真实发送者。

`write` 保持 SDK 原生文件写入行为。`msg_write` 专用于受管消息目标，不写普通文件。

消息写入成功返回简洁纯文本（`Successfully sent message to ...`），`details: undefined`，不另加 ACK 或回执对象；失败以消息投递错误报告。广播部分失败在响应中保留失败接收者列表及原因，普通 IPC 错误不向调用方泄漏内部状态细节。消息写入成功不等于接收者已读取，也不等于任务已完成。超时或错误不保证消息尚未送达，严禁自动重发。

### 终端结果折叠

Harness 为没有专用结果渲染器的工具提供统一预览，包括 Capability、Subagent 控制工具和动态 MCP 工具。默认只显示前 10 个终端视觉行；短结果完整显示，单行长 JSON 也按屏幕宽度折叠。已有专用渲染器不被替换。

工具结果可用 Pi 原生展开键（默认 `Ctrl+O`，动作名 `app.tools.expand`）切换。全屏模式下，左键点击工具结果可展开／收起。Subagent 消息也按视觉行折叠；点击标题、预览或折叠提示可切换，标题保留发送者、轮次与可用状态。点击后的展开状态在重绘和宽度调整后保留；全局展开键优先更新显示状态。滚轮和拖动不触发折叠，普通终端模式仍使用展开键。

折叠只改变界面显示，不改写工具 `content`、`details`、保存的消息或模型上下文。界面展开显示全部已交付内容；若结果已按字节／行数上限截断，完整原文仍需按所附文件路径补读。

### 等待子任务

父 Agent 等待直接子节点时，应结束当前回复并交还控制；宿主保持 parent-hold 并在子节点终结时内部唤醒，不需要 `sleep`、忙轮询或阻塞式 `wait` 工具。

这里的停下指父 Agent 结束当前轮次，不是调用 `subagent_signal` 的 `stop`。子节点终结是内部状态，不构成一次 collaborator 结果交付；父 Agent 需要内容时，由子节点显式 `msg_write`，或由调用方读取 Job 结果与历史。

### 普通消息投递

- 每条显式消息单独交给 Pi，不等待同源或同轮次事件。
- 保留来源、轮次与跨 session 发送者描述，不改写已交出的消息。
- Job 终态是 Runtime 的内部状态，不进入消息队列；不维护合并槽、批次映射或重发状态。
- 用户清除先前进度不影响随后产生的消息独立入队；主动清除后系统不自行重发。
- Pi 决定一个或多个排队消息在哪次模型请求中消费，不承诺一条消息对应一次请求。
- 交接异常不等于未入队。向运行中 SDK 会话交接消息或跨 Socket 写入时，抛出异常、断连或超时并不证明消息未入队；只有明确收到「未交出」的同步拒收才允许转入保留历史，严禁对结果未知的已提交消息自动重发。

### 用户查看入口

用户已可通过 `/subagent` 命令查看 Actor 树、模型、历史路径与会话，并对指定 Actor、批次组或直接子节点发起 `interrupt`／`stop`，命令见 [`/subagent` 命令](#subagent-命令)。`subagent_list` 是供模型使用的同一投影的查询接口。可视化／交互式任务管理界面仍处于延期设计状态。

## Harness RPC 独立接口

Harness RPC 是现有领域操作的远程适配层。会话宿主拥有组合、SDK 绑定和连接生命周期；Main、工具权限、Preset、审批、会话联系和 Subagent 继续拥有各自的业务状态。客户端直接使用结构化操作。

### 双通道边界

- Pi 原生 RPC 可继续提供 UI。完整 Harness 宿主通过 `createHarnessSessionHost` 借用实际 SDK runtime，在每个 ResourceLoader 中安装 `host.extension`；嵌入方保留正常 SDK 重绑回调和 runtime 所有权。仅扩展加载时如实报告 capabilities：不可观察字段为 null，输入仅为 `submitted`，缺少的导航控制返回 `unavailable`。
- 两个通道不承诺跨通道的全局消息顺序。订阅事件与 `stream.subscribe` 响应携带根会话与执行归属；`jobs.*`、`agents.tree` 响应带 Agent／Job 执行身份，但不重复携带根 `sessionId`（仅 `harness.info` 提供）；`tools.*` 等查询响应不携带归属。客户端不能仅按接收先后推断操作因果。
- `get_commands` 是 Slash 命令、Skill 与模板目录，不是工具目录；`get_tree` 是 Main 的 entry 树，不是 Subagent 树。Main 的原生消息查询与事件流不覆盖独立子会话。

### 启用条件与生命周期

- 端点仅在根宿主实际运行模式为 `rpc` 时创建。运行模式取自 Pi 的扩展运行模式，不扫描命令行，也不用 `hasUI` 推断。TUI、print 与 JSON 模式不创建、不监听、不发布该端点；内部 SDK 子会话不因父进程处于 RPC 模式而再次开启。
- 一个 RPC 根宿主提供一个端点。客户端通过 Agent 与 Job 标识访问子任务，不为每个子 Agent 新建监控端点。
- 端点使用独立地址 `harness-rpc.sock`，与会话唯一的 Agent IPC 端点 `main.sock` 不共用，复用受管 IPC 的创建、归属校验与清理。
- 端点创建失败时不发布发现记录，并通过宿主通知与状态报告原因；客户端此时只能观察到无记录或连接失败。该失败不阻止 RPC 宿主启动。
- 完整宿主跨新建、切换、fork 和 reload 保留连接及地址，替换领域绑定并释放旧 Root 观察者；Main 宿主观察者随真实 SDK session 重绑。取消导航恢复原会话的领域服务。断连只解除观察，不取消任务、不决定审批或关闭 Pi。

### 地址与发现

- 端点地址为 `<socketRoot>/<session-uid>/harness-rpc.sock`；Windows 使用由同一目录派生的 Named Pipe。
- `harness-rpc.json` 包含协议版本、稳定地址、当前 `sessionId`、pid 和起始时间；完整宿主在当前 Root 目录更新发现记录。关闭移除记录。失败通过 SDK 通知、`host.status()` 与会话应用的 `rpcStatus()` 暴露，RPC 清理失败不能跳过底层 Job 和资源退役。

### 协议

- 帧为换行分隔的 JSON。请求为 `{id, method, params?}`；响应为 `{id, ok: true, result}` 或 `{id, ok: false, error: {code, message, detail?}}`；订阅事件为 `{event: {subscription, seq, payload}}`。
- 每个端点仅接纳一个客户端连接，额外连接不顶替当前客户端。FIN 释放观察者，但槽位持续到未决响应写出且 Socket 实际关闭。完整宿主只在关闭时强制关闭连接，Root 切换释放 Root 观察者。
- 协议版本为 2。普通请求串行；停止、审批回复、Main 中断与退订可绕过长请求。响应可能乱序，必须按 id 关联。有界积压默认 4 MiB，超限断开并释放观察者。
- 客户端不能自动重放结果未知的控制输入。异常、超时与断连不证明输入尚未入队。
- 语言无关的线协议规范见 [Harness RPC 线协议规范](harness-rpc-wire-spec.md)；机器可读 schema 与方法清单由定义源码生成，Git 追踪 [`schemas/SHA256SUMS`](../schemas/SHA256SUMS) 和 [`schemas/fixtures/harness-rpc/`](../schemas/fixtures/harness-rpc/)；生成、GitHub Actions 下载与 `$defs` 细节见 [Harness RPC Schema](harness-rpc-schema.md)。

### 方法

| 方法 | 职责 |
| --- | --- |
| `harness.info` | 协议版本、会话标识与进程标识 |
| `main.*` | SDK 状态、输入准入、中断、压缩、导航、reload、新建、切换、fork 和观察；preflight 区分 handled、queued、started，不等待整次运行完成 |
| `presets.catalog/current/apply/clear` | 共享 Preset 配置、分支快照及应用／清除结果，保持稀疏选择语义 |
| `hooks.current` | 当前有效 Hook 结构、禁用规则、分支静音及脱敏配置诊断 |
| `hooks.stats` | 当前会话的 Hook、工具和分类器计数快照 |
| `approvals.list/get/respond/subscribe` | 真实审批队列和首次有效决定，保持超时、取消、无消费者时拒绝及退役释放 |
| `approvals.mode.get/set` | 读取 Shell 审批模式，或为当前分支固定后续请求使用的模式 |
| `sessions.list/connect` | 共享会话目录与联系操作，联系和发送相互独立 |
| `tools.catalog`、`tools.detail` | 当前作用域目录与详情，报告 registered、eligible、active、managed 和 permission；禁用项保留，供用户管理 |
| `tools.activate`、`tools.deactivate` | 修改当前会话按需激活集合，与用户命令共用领域操作 |
| `tools.base.list/add/remove` | 查询与修改工具基线，不修改按需集合与黑名单 |
| `tools.blacklist.list/add/remove` | 查询与管理禁用目标，结果说明仍生效的来源与声明延期移除 |
| `agents.tree` | 当前根 Agent 树 |
| `jobs.list`、`jobs.get`、`jobs.result` | Job 列表、详情与单次结果；未就绪、不存在与读取失败分别表达 |
| `subagent.create` | 创建一个目标的协作批次；宿主绑定父身份、根会话、工作目录、继承快照与容量限制，返回批次地址、名册、已登记成员与失败项 |
| `subagent.signal` | 对单个逻辑目标执行 `interrupt`（中止当前原生执行并在同一 Job／Budget 继续）或 `stop`（结束当前 Job），返回逐目标结果与状态 |
| `message.send` | 按完整逻辑地址投递、续跑或广播，返回领域回执与逐接收者结果；广播与子节点选择排除发送者，跨会话只允许 Main 到对方 `:main`，其他来源拒绝 |
| `history.read` | 读取指定 Job 的原生历史区间；running Job 返回已产生区间与 live 端，首个 Job 的 `null` start 是合法边界（按分支开头读取），memory-only 会话明确报告历史不可用 |
| `stream.subscribe`、`stream.unsubscribe` | 订阅或解除指定 Job 的子会话执行流；订阅响应携带读取边界（状态、轮次、历史区间、已产生消息与当前 `partial`），事件携带订阅、根会话、Agent 与 Job 归属 |

- 公开参数、结果、校验和生成 schema 关联于 `src/harness-rpc/contract.ts`，编译时核对方法覆盖及结果类型。SDK 事件与历史保留不透明载荷。领域错误保留 code、message 和 detail；登记后的启动失败以 `start_failed` 和 detail 中的 registered／failures 报告，不能视为整批未创建。查询与回执不额外写入 Main 对话，操作自身仍保留业务记录。
- 子任务操作使用当前领域绑定；Root 过渡期间拒绝访问旧服务。SDK Main 控制独立于 Subagent 健康状态；后续回调受绑定代次围栏隔离。

### Shell 审批模式

`approvals.mode.get` 无参数，返回配置默认值、当前模式及其来源。`autoFallbackToManual` 只在审批启用、当前模式为 `auto` 且审查器停用或 Node 版本不支持时为 `true`。审批停用时仍可读取；未安装 Shell 审批扩展时返回 `unavailable`。

`approvals.mode.set` 接收 `{ mode }`，允许 `ask`、`auto`、`yolo`，返回 `{ mode, previousMode, changed, source }`。首次显式选择会写入分支，即使选择等于配置默认值。已有相同分支值时返回 `changed: false`。成功响应的 `source` 为 `branch`。模式变更只影响后续审批，无须等待当前轮结束。审批停用或扩展未安装时返回 `unavailable`。

### Hook 查询

`hooks.current` 与 `hooks.stats` 都不接收参数。当前会话未安装 Hook 查询时返回 `unavailable`。两者不写分支、不唤醒模型、不发 UI 通知。

- `hooks.current` 读取当前分支的 Preset 与静音记录，复用 Hook 文件快照。首次查询可加载文件。规则按 ID 排序，`active` 表示可参与执行，`muted` 表示分支静音。`disabled` 列出合并后被文件或 Preset 禁用的 ID；`muted` 包含已无规则定义的历史 ID。文件层无效时返回 `valid: false`，`rules` 和 `disabled` 为空；刷新失败而旧快照仍有效时继续返回旧快照。`warnings` 只含层级、可用的规则 ID 和诊断码。响应不含配置路径、规则表达式、动作正文或分类问题。
- `hooks.stats` 返回当前会话的计数快照：按 ID 排序的最多 64 条规则、其余规则的合计、固定六类工具和分类器计数。分类耗时按毫秒取整。会话切换后从新会话读取，查询不清零。

### 执行流

- 实时数据源是子会话自己的原生事件订阅，保留完整原生事件类型与 Pi RPC 的 JSON 投影语义：不重复发送累计 `partial`，工具调用保留 `toolCallId` 与存在时的 `parentToolCallId`，推理只提供供应商实际返回的内容。
- 历史与实时流有明确衔接边界：订阅建立先于响应，响应返回当前 Job 的读取边界，包含 `status`、`round`、`history{startEntryId,endEntryId}`、已产生的 `messages` 与当前的 `partial`；客户端据边界补齐已产生内容后消费实时事件，不需要读取文件猜测增量起点。`live` 表示是否挂上实时源；running 与已终态 Job 都返回真实快照，订阅时 Job 已终态则不再补发终态事件，其状态只在边界中给出。
- `agent_end`、`agent_settled` 与 Harness Job 最终结束不是同一边界。订阅单独报告 Runtime 的 Job 终态；Job 可能继续消费停放输入或等待子任务，最终状态以 Runtime 为准。
- 订阅者异常或断连不影响任务执行；观察失败不改变任务结果。解除订阅或断连会同时释放该订阅的原生监听与 Runtime 终态观察，不将连接保留到 Job 结束。

## 异步 Shell

Bash／PowerShell 工具接受 `background` 和 `pty`，长时间运行的命令可返回 Job ID 和日志路径。`timeout` 限制命令的总运行时间；未显式后台时，`shell.maxForegroundWaitMs` 决定工具调用等待终态的上限，达到上限仍在运行则返回同一个 Job。当前执行可用 `job_stop` 停止自己的 Job；只有 PTY Job 接受 `job_send` 和 `job_key`，日志使用 `read` 查看。独立 `pi-job` CLI、平台限制和安装契约见[异步 Shell](async-shell.md)。

- **模型可见输出**：前台结果保留最后 2,000 行且最多 50 KiB。显式后台、自动转后台、完成通知与 `job_stop` 只输出本次新增的未读区间，单块最多 32 KiB 且最多 2,000 行；超出时保留头尾，截断说明使用 `output.log` 的全局 1-based 行号。同步终态不补发通知，异步完成只通知一次；`internal_error` 的 `message` 不随截断丢失。
- **`structuredContent`**：`bash`／`powershell` 保留原 SDK 的 `outputSchema` 字段，增加 `status` 与可选 `job_id`，`exit_code` 允许 `null`。非零退出在 `codemode` 中 resolve 而不抛错；`structuredContent` 不进入模型正文或持久化历史。
- **TUI**：Shell 结果由结构化 `details` 渲染。工具调用头显示 `background`／`pty`；受管前台等待期推送仅用于展示的尾部预览；转后台、显式后台、`job_stop` 与 `async-shell-result` 卡片显示状态、`message`、`exitCode`、输出预览、截断提示与 `logPath`，不展示裸 JSON。折叠只影响显示，不改变已定稿的模型正文。

注册和完成事件回到会话唯一的 Agent IPC 端点 `main.sock`，帧中携带发起调用的 `agentId` 与该执行租约的 `token`，由根路由到对应 Actor。Main 和子会话在每次 Shell 启动时获得各自的 `PI_AGENT_ID`、`PI_AGENT_SOCKET`（即 `main.sock`）、`PI_ASYNC_SHELL_TOKEN` 和私有任务根；事件不占用 Agent 消息发送者身份，也不产生消息工具授权。未完成异步 Shell 与直接子节点共同保留 Subagent 当前 Job；完成事件先入队，后释放等待。

## 提示词与架构

本节指引与其他 namespace、MCP 指引共用分支记录与增量更新规则；会话恢复重放已有正文和落点。

工具提示词应表达上述使用流程和行为边界。提示词正文存放在 `prompts/`，通过 `src/prompt-text.ts` 的类型化缓存 getter 读取；执行代码保留数据装配、参数结构和权限判断。Shell 的逐次结果正文、截断说明与界面文案由执行代码按结果字段装配，不放入提示词资产；`prompts/async-shell.json` 只保存工具用途、参数指引和固定控制工具描述。角色说明来自 `subagent-routing.toml`，候选偏好使用所引用或临时 Preset 的 description，不新增模板框架或静默回退正文。

### Subagent 提示词装配

运行时始终读取 `prompts/subagent-tools.json` 与 `prompts/subagent-turns.json`。

| 模块 | 资产字段 | 装配位置 |
| --- | --- | --- |
| A：共同范围 | tools 的 `namespace`、`instructions` | 仅保留适用于所有成员的共同说明；原生声明已提供时不重复，容器独立加载或 schema 延迟隐藏时通过当前指引投影 |
| B：目标与协作 | tools 的 `create.guideline` | 只随 `subagent_create` 提供；延迟 schema 时保留工具专属指引，不追加到 list／signal／msg_write |
| 列表查询 | tools 的 `list.guideline` | 只随 `subagent_list` 提供 |
| 信号控制 | tools 的 `signal.guideline` | 只随 `subagent_signal` 提供 |
| 消息通信 | tools 的 `msg_write.guidelines` | 只随 `msg_write` 提供逻辑寻址、广播、唤醒、身份与报文格式规则，不包含创建或编排指引；延迟 schema 时保留工具专属指引 |
| C：子会话身份与交付 | turns 的 `context` | 所有子会话的 `appendSystemPrompt`；替换自身与创建者的完整逻辑地址 |
| D1：Fresh 职责 | `subagent-routing.toml` 的角色说明 | Fresh 路由后注入，续跑保留已记录角色 |
| 共同工作指引 | `subagent.prompts.common`，内置为空 | Fresh 与 Inherited 的当前会话装配均追加一次非空正文 |
| D2：Inherited 上下文定位 | `subagent.prompts.inherited`，默认来自 turns 的 `inheritedContext` | 仅 Inherited 会话额外注入，续跑及重新打开原生会话时仍按该 Actor 身份装配 |
| E：活跃名额 | tools 的 `create.capacity` | 当 `subagent_create` 激活时通过 `promptGuidelines` 注入 `<rules>`；`{batches}`、`{subagents}`、`{inherited}` 按当前配置快照替换 |
| F：批次上下文 | turns 的 `batchContext`、`goal`、`roster`、`collaborate`、`unnamedMember` | 执行侧按 Job 装配一次：共享 `context`，多成员时再附名册与协作提示；与成员目标一起构成初始输入 |
| G：终态提醒 | turns 的 `msgWriteReminder` | 正常收尾且最近工具轮次没有 `msg_write` 时，作为同一 Job 内的单次自提醒 |
| H：中断说明 | turns 的 `interruptionNotice` | `interrupt` 后追加的一条带发送者地址的简短说明，不声称仅中断工具调用 |

提示词定制边界：

- 仅开放 `subagent.prompts.common` 和 `subagent.prompts.inherited` 两段，支持逐层 `replace` 与 `append`，详见[提示词定制](harness-configuration.md#提示词定制)。
- 宿主上下文固定：`subagent-turns.json` 中的 `context` 只含两个固定占位符 `{agentAddress}`、`{creatorAddress}`，由宿主原样插入，不展开变量或代码。
- 提示词段落装配不改写已捕获的历史，也不把历史重写为新的任务正文。快照捕获仍会移除 Harness 内部条目和末尾尚未完成的工具调用，并为子会话分配独立 session ID。
- 子会话装配顺序：依次为路由角色指引、宿主身份段（`childContext`）、非空 `common`，以及仅用于 Inherited 模式的非空 `inherited`。`common` 默认为空时，装配顺序保持为角色、宿主身份与继承指引。
- 批次上下文只在执行侧按 Job 渲染，不写入持久化的格式化副本：单成员批次只包含共享 `context`，不重复自身目标或地址；多成员批次包含固定名册与一条正向协作提示，不描述其他批次的行为。
- `create.capacity` 仅在 `subagent_create` 激活时通过 `before_agent_start` 写入 `promptGuidelines`（落入 `<rules>`），值来自当前配置快照。同一快照下文本逐字节一致；配置变化只产生 `<rules>` 补丁，工具描述保持静态。

参数说明按所属工具与实际嵌套位置保存：

- `create.parameters.context`
- `create.parameters.agents.description` 及 `create.parameters.agents.items.{name,goal,inheritContext}`
- `list.parameters.{all,id}`、`signal.parameters.{target,action}`
- `msg_write.parameters.{to,content}`

这些是提示词资产路径，公开调用参数仍为 `context`、`agents[].goal`、`to` 等字段。

## 核心设计细节

核心运行时模块遵循以下系统不变量：

- Capability 共享底层执行入口，仅检索本地资源；基于 `capability-discovery` 分支规范记录保留记忆。
- 终态裁定覆盖正常完成、取消与失败。parent-hold 保留正常执行的父 Subagent 当前 Job；取消或失败后的晚到子节点状态只作为保留历史，不自动创建新轮次。
- Job 终态是 Runtime 内部状态与唤醒，不伪装成 collaborator 结果消息；模型可见交付只有显式 `msg_write`。
- 消息投递为纯文本接口与宿主分帧，基于 Pi steer message；不维护合并状态、自动重试或结果重放。
- 每个根只绑定一个 Agent IPC 外部端点 `main.sock`；Harness RPC 使用独立协议的 `harness-rpc.sock`。同根流量直接进入领域路由，逻辑地址不映射为独立 Socket。关闭时每个端点（Agent IPC `main.sock` 与 Harness RPC `harness-rpc.sock`）都只在确认绑定的 dev／ino 与有效 UID 后释放；最后一个端点释放并完成清理后，才删除本根创建且已空的 session 目录，不依赖关闭顺序，也不按路径重试。持久化 Actor/Job 历史保留。
- 交接异常不证明未入队，严禁盲目重发。
- 会话切换与服务退役通过代次围栏隔离晚到回调，禁止旧代次写入新根。

## 延期边界

- 可视化／交互式任务管理界面，以及通过用户命令直接向子 Agent 发送消息。
- 远端审批对象、用户入口和批准后的流程。

上述需求暂缓实现，不阻塞当前核心接口，也不自动执行未授权代码。
