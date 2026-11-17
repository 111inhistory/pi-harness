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

`capability.blacklist` 提供启动默认禁止，当前 Preset 显式减项与分支手动黑名单共同生效。本会话基线白名单优先于这些禁止，普通发现和按需激活其次；覆盖不删除黑名单记录。祖先黑名单继续约束子会话，不因子会话白名单失效。

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

`-<tool>` 是本次选择的排除项，不写黑名单，不取消已有基线或按需成员。普通容器目标产生一次成员快照，不形成持续的全员激活规则；之后注册的新成员不自动加入，deactivate 单个成员也不会被容器重新激活。再次显式激活普通容器则重新选择当前成员，包括此前主动取消的成员。基线移除或 deactivate 容器按当前成员操作，保留容器加载记录。黑名单不接受 `[ns]` 或本次选择排除语法；Namespace 与工具的禁止分别保留，任一命中形成原始黑名单事实，再由本会话基线白名单决定是否覆盖；祖先禁止不能被子会话覆盖。

activate 与 base add 的目标可附加 `[lazy]` 或 `[no-lazy]`，容器可组合为 `[ns,lazy]` 或 `[ns,no-lazy]`。不带 schema 修饰符时遵守配置和既有显式覆盖；显式成员策略优先于同批容器策略。同条命令可混合不同工具的 schema 策略；冲突或非法修饰符在写入前拒绝。显式 lazy 选择必须具有可用 Codemode `only` 调用路径，否则整条选择拒绝，不自动切换模式。base remove、deactivate 与黑名单命令不接受这些加载修饰符。

基线、按需激活、原始黑名单命中、实际阻断、SDK active 与当前可用性分别展示，不再合成为 enabled／disabled／active／inactive 四态。原始黑名单命中不等于实际阻断：本会话基线可覆盖它，列表仍保留禁止事实；未被覆盖的有效禁止不能通过保留声明或普通发现绕过。

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

Capability 与 Subagent 分别通过 `extensions/capability.ts`、`extensions/harness.ts` 注册，共用底层执行能力和同一会话的配置、资格状态，不创建两套执行环境。Capability 直接调用内部执行入口，不要求公开的 `subagent_create`、`subagent_list` 或 `subagent_stop` 工具已注册或已激活。

Capability 调用仍等待检索完成，再返回筛选后的资源。复用执行代码不改变检索权限，不向内部检索 Agent 开放父 Agent 的执行权限。

## 工具权限管理

工具管理分别拥有基线白名单、按需激活集合和黑名单，不维护混合权限四态。当前会话优先级为「白名单 > 黑名单 > 普通发现／按需激活」；请求使用集合为「基线 ∪（按需激活集合 − 本会话黑名单）」。实际声明和调用还受注册状态、SDK 限制、父作用域、角色与深度约束，子会话白名单不能覆盖祖先禁止。

### 状态、记录与迁移

- `capability-tool-base` v1 保存初始基线及后续 add／remove；当前 Preset 工具快照可建立新的基线。
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
- 基线白名单覆盖本会话黑名单，黑名单覆盖普通按需激活／发现；精确工具白名单也可覆盖本会话整个组的禁止。两份记录均保留，移除基线后原禁止重新生效；不自动移除黑名单。
- 启动时尚未捕获基线的隐式默认可用性不作为白名单覆盖依据；捕获会排除当时被禁止的默认工具，避免仅因 SDK 初始 active 就取消配置禁止。之后显式 base add 或 Preset 正项可以建立覆盖。
- 移除手动规则不移除当前 Preset 的独立禁用，也不能解除 SDK 限制。配置默认目标可由分支上的显式移除覆盖；尚有其他禁用来源时如实报告。
- Preset 切换替换其基线及禁用贡献，不把减项累积为永久手动黑名单；clear 结束 Preset 禁用贡献，不回滚已应用模型、thinking 或基线。
- 黑名单管理工具使用资格，不自动禁用同名扩展命令或领域控制操作。已开始的工具调用不自动取消。

### 模型提示与 compaction

集合移除或禁用立即影响执行资格。没有独立声明的成员立即移出 SDK active；有独立声明的成员可按现有协议保留到下一次成功 compaction，不能用声明仍存在推断当前可执行。

`capability-tool-blacklist-notice` 保存必要的模型禁用提示，不新增头部指令区块。压缩成功后移除失去资格的独立声明；压缩失败不提前删声明。普通未使用淘汰保护当前基线，按需工具按使用窗口收缩；黑名单的禁止不依赖普通淘汰开关。

### 子会话

基线和按需选择描述当前会话的可用工具，不是 root-only 授权。祖先黑名单通过实时父作用域传播，角色排除与固定深度约束继续优先；子会话不能靠自己的 Preset、base add 或 activate 解除祖先禁止。根配置的启动禁止在子会话中仍是外部围栏；父会话对该禁止的本地 base 覆盖只对父会话生效，不构成对子会话的继承授权。已记录历史不被改写，每次执行重新检查当前资格。

### 程序接口

RPC、用户命令、Preset 和发现发布复用工具管理领域操作。RPC 只处理校验、调用方绑定与结构化传输，不复制集合或规则状态，见[Harness RPC 独立接口](#harness-rpc-独立接口)。

## 模型 Preset

`extensions/preset.ts`（随包默认加载）提供模型切换、思考级别、模型专属指引和工具选择。

**配置。** 读取全局 agent 目录的 `presets.json` 与受信项目的 `.pi/presets.json`，项目同名项整体覆盖全局。每项可含 `model`（`provider`＋`id`）、`thinkingLevel`、`tools`、`codemode`（`mode`）与 `instructions`。`tools` 支持 `+name` 启用、`-name` 禁用；纯裸名列表替换 base tool 集合，禁止与任何带 `+`／`-` 前缀的项混用，混用拒绝整个 Preset 应用。工具选择始终基于会话首次启动捕获的初始工具集（原生默认工具、CLI 修饰与默认启用扩展工具，如 `capability`）计算，并记录为 Preset 工具基线；先应用 A 再应用 B 与直接应用 B 得到同一基线，跨 reload 不被前一个 Preset 污染。Preset 始终只替换基线；独立按需集合继续保留，显式减项通过黑名单阻止使用。启动基线只捕获一次，之后注册的 default-active 工具不会被自动纳入；若要在集合同步后保留，应显式加入基线或按需激活。保留的动态工具不写入 Preset 基线，继续由压缩淘汰策略管理。前后 Preset 基线比较时，若旧集合有工具不在新集合中，则下一次成功压缩执行淘汰，即使 `capability.pruneOnCompaction` 为 `false`；首次应用与初始基线比较，仅增加工具不触发，不改变全局配置。

Preset 正项建立当前基线，可覆盖本会话黑名单而不删除它；最终显式减项移除解析后的基线成员，并提供当前 Preset 生命周期内的禁止，切换或 clear 撤销该来源。后续显式 base add 可再次覆盖该禁止。祖先、角色、深度与 SDK 限制继续生效。

**入口。** `/preset` 打开选择器，`/preset NAME` 应用指定项，`/preset clear`（`none`／`off`）停止管理，`--preset NAME` 在启动时应用；状态栏显示当前 Preset。这些交互入口只作用于当前 Main。Fresh routing 显式选择命名或临时 Preset，复用配置解析、应用与指引投影；Inherited 保持捕获的模型与分支状态。

**应用与失败。** 先校验模型存在于目录，再 `setModel`；模型不可用则整体不应用并报错，绝不报成功；thinking 与 tools 随后应用。`instructions` is rendered from the current resolved branch snapshot as a request-local system section on every model call. Resume, tree, fork and reload restore current business state, without historical placement replay. A complete forced prompt retains SDK precedence.

**分支与清除。** `preset-state` 记录保存应用时解析快照（model／thinking／tools／codemode／instructions），快照用于恢复指令、状态标识及压缩保护基线，不在恢复时强制重放 model／thinking／tools；这些运行状态由 Pi 原生恢复。工具 loadout 随实际请求记录，应用 Preset 后尚未发起请求就退出，恢复时可能仍使用上一份工具集。首次启动的初始工具集由共享 `capability-tool-base` 记录捕获，供修饰符计算；`/preset clear`（及 `none`／`off`）显式清除直接分发而不加载预设配置，配置文件损坏或目录阻塞等不可读故障不阻碍退出已应用的快照、指引与 codemode 覆盖；清除写入 null 快照并停止管理，结束 Preset 黑名单贡献，不回滚已有 model／thinking／基线。

**Codemode 模式。** 扩展无公开 `codemode.mode` 写入通道。Preset 以 `codemode-mode` 分支记录覆盖本会话的生效模式，原生 Codemode 工具与 `capability.lazySchemas` 均读取该生效模式，从下一次请求生效；它只改变声明投影，不改变启用集合、显式启用记录或工具 exposure。若宿主无法应用该覆盖，只记录并给出 warning，不把未生效报成成功。

## `/btw` 独立问答

`/btw [question]` 在交互式终端底部打开独立问答面板（内联停靠，不覆盖主对话）。无参数时显示输入框；带参数时直接提问。打开时捕获当前分支上下文、系统提示词、模型、思考级别与缓存标识，再追加独立问答指令。虚拟模型使用最近一条响应的物理模型；无法确定时拒绝启动。

同一面板中的追问沿用临时会话。问答只存在内存中，不写入主对话、不生成 Subagent 任务、通知或通信端点，也不占用子节点名额。所有工具调用由执行钩子阻断，继承的声明仅保留不可执行的占位实现；manual 工具声明仍按子会话边界排除。

面板固定在终端底部、占满可用宽度，以终端半屏（`round(终端行数 / 2)`）为目标，不低于配置的组件最小行数 `btw.panelMinRows`（默认 8 行），不随回答长度变化；主对话在面板上方保持可见与可滚动，关闭后恢复主输入框。共享 TUI 预算默认给组件外的宿主区域预留 4 行，面板可用高度为「终端行数 − 4」；该空间不足组件最小行数时，`/btw` 报错拒绝打开。`panelMinRows` 描述组件自身，不是整个终端的最低高度。SDK 未公开实际分配高度，预留量是布局估算，不保证任意宿主布局均精确适配。打开期间把终端缩小到该下限以下时，面板改为一行错误提示并停止接受输入，恢复高度后自动恢复显示，问答内容与滚动位置保持不变。

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
- 子会话（Subagents）：非叶节点加载 `subagent_create`、`subagent_list`、`subagent_stop`、`capability` 与 `msg_write`；叶节点（`depth === maxDepth`）仅保留 `subagent_list` 与 `msg_write`。子节点独立获得 `msg_write`，但祖先禁用与角色最终排除仍可阻止它。
- `write` 是 SDK 原生文件工具，完全保持原生行为，不被拦截或覆写，不承担 IPC 消息发送。

Fresh 路由保留角色及其职责提示词，其他执行配置复用命名或临时 Preset。工具以子会话自己的默认集合为基线，应用 Preset 的 `tools` 修饰；显式最终减项作为执行作用域 denial 始终排除，后续激活不能绕过。SDK 注册排除只承载固定深度限制，祖先限制继续由作用域父链提供。Preset 的 Codemode 模式与指引使用同一分支记录及投影路径。候选与已解析选择固定在 Actor 身份中，续跑不读取后来编辑的配置。配置格式与离线转换见[Harness 参数配置](harness-configuration.md#fresh-routing-presets)。Root 装配入口由子会话 surface 替代，不重复加载。Fresh 与 Inherited 均独立加载已配置的扩展与 MCP 后端（`noExtensions: false`）；Inherited 在捕获时通过父会话生成该调用的 assistant 消息锁定底层物理模型（`physicalModelForCall`），避免虚拟模型在子会话中重路由。它恢复捕获的工具白名单、系统提示词与思考强度。白名单仅限可重新创建的文件型扩展工具与 MCP 工具，父会话专属诊断工具不传递。若继承的异步 MCP 尚未完成注册，按 `subagent.inheritedToolWaitMs` 有界等待，默认最多 10 秒。

Subagent 共享工作目录。深度上限（`subagent.maxDepth`，默认 2）、活跃直接子节点上限（Fresh 对应的 `subagent.maxActiveChildren`，默认 4；Inherited 对应的 `subagent.maxActiveInheritedChildren`，默认 3；两类直接子节点使用独立的父节点名额池）以及每层 Budget 通过 `harness.json` 配置，详见[Harness 参数配置](harness-configuration.md)。根服务和子会话使用同一份配置快照，已运行 Job 不受文件修改影响。这些配置不作为公开工具参数。

`subagent_create` 在本批子会话本地就绪后返回。本地就绪包括路由分配、会话创建、扩展与工具配置完成、初始输入就绪和 IPC 监听准备就绪。返回项包含 `id`、`socket`、`role` 与 `model`。它不等待首次模型流分发，也不等待任务完成。本地准备阶段的失败会使 create 报错，运行阶段的失败由终态通知报告。

### `/subagent` 命令

扩展命令 `/subagent` 提供同一根代次的观察与停止入口，不经过模型轮次，也不消耗 Job Budget。

| 子命令 | 行为 |
| --- | --- |
| `/subagent`、`/subagent list` | 打印当前根的 Actor 树；`--all` 展开完整树，`--id <actorId>` 只看指定子树 |
| `/subagent stop <actorId>` | 请求取消该 Actor 的当前 Job；返回 `ok` 与 `status`，被拒绝时附带 `reason`（`already_finished`、`stopping`、`finalizing`、`budget_exceeded`）；Actor 没有运行中的 Job 时保持幂等 `ok`，视图提示无运行任务 |
| `/subagent stop --all` | 对当前根所有 `running` Job 请求取消，立即汇总已请求／拒绝／失败数量，不等待终态 |
| `/subagent sessions` | 列出同一 Socket 根下所有存活 session 的短标识、进程、工作目录、session id 与 Main 的跨 session 地址；当前 session 以 `*` 标记；目录读取失败时报告错误通知，不报告「none」假成功 |
| `/subagent sessions connect <uid\|sessionId>` | 把选中存活 session 的联系信息作为一条本地上下文消息追加给当前 agent，并启用 `msg_write`；不向对方发送任何消息 |

- 列表输出为纯文本：树形缩进，`●` 活跃、`◐` 正在停止或收尾、`○` 空闲；列固定为 ID、深度、种类（`fresh`／`inherited`）、角色、状态与调用数。标题给出当前根的全部 Actor 数；活跃数与 Fresh／Inherited 分项只统计运行中的 Actor。窗口隐藏节点时给出提示。
- 列表与停止只读：不发送消息、不 steer、不唤醒；消息仍由 `msg_write` 与 IPC 提供。`sessions connect` 只向本会话追加一条上下文消息，不唤醒任何 Actor 或 session。
- 命令与 Root 同代次：退役或切换期间以 `runtime_transitioning` 拒绝。列表在异步读取后重新核对根代次，根已切换时不渲染旧快照。同代次的元数据写入失败不阻止列表显示或请求停止，但仍阻止新工作，取消也不表示终态已持久化。停止请求不等于终态，Job 仍占 Actor 与名额，直到原生执行退出。
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
- **发现**：`/subagent sessions` 是用户侧发现入口；模型侧不注册 session 工具，外部编排者直接读取同一份共享目录：`socketRoot/sessions/<uid>.json` 由各 session 在 `initialize` 后发布，`retire` 时按记录归属删除；读取时按 `pid` 存活与记录自洽过滤，畸形或残留记录被忽略且不由他人删除。共享目录缺失（`ENOENT`）视为空目录；其他目录读取错误向调用方如实抛出并在命令入口报错，不伪装为「无存活 session」。记录只含稳定 uid（8 位十六进制）、session id、原生 session name、工作目录、`pid` 与起始时间，不含拓扑或对话内容。`pid` 只在本机解释，因此 `socketRoot` 必须保持本机私有；跨机共享 durable session 历史不受此限制。`subagent_list` 仍只描述当前根。
- **补全**：`/subagent sessions con` 补全为 `sessions connect `；随后按实时存活目录补全目标 uid，候选显示会话名称、工作目录与完整 session id。可按 uid／完整 session id 的前缀或名称筛选；排除当前会话，不产生授权、激活或消息写入。选中后执行 connect 时仍重新校验目标是否存活。
- **连接**：`/subagent sessions connect <uid|sessionId>` 由用户指定一个存活 session，参数是列表中显示的完整 uid 或完整原生 session id，不接受序号或别名。命令把该 session 的 uid、原生 session id、原生名称、工作目录与 Main 地址作为一条原生自定义上下文消息追加到当前会话：不触发新一轮，忙碌时按 SDK 队列语义在当前轮结束时落盘、下一轮可见；不改写提示词头部、不复制对方 transcript、不注入整份目录、不建立持久连接状态。同一次 connect 通过按需激活操作使 `msg_write` 可用；黑名单或 SDK 限制阻止该工具时明确报告失败，不以连接动作解除禁止。目标未知或已退出以 `session_not_found` 报告，指向自身以 `invalid_target` 拒绝；重复 connect 允许再次追加当前信息，按需激活记录保持幂等。connect 只写本会话，不发送消息、不唤醒对方。
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

候选 Preset 使用 `thinkingLevel` 请求级别，例如 `"thinkingLevel": "high"`，未配置则保留子会话默认值，不通过 Harness 区间计算。请求级别传给 Pi SDK，由原生 `clampThinkingLevel` 调整到模型支持的档位；不支持 reasoning 的模型使用 `off`，路由不因该档位不受支持而拒绝启动。Inherited 模式传入捕获的父会话思考强度，同样由 Pi SDK 按实际模型能力应用。Actor 记录子会话实际生效的强度供续跑使用。

### 任务语言

任务描述宜主要使用英文以匹配路由器能力。系统对任务语言没有硬拒绝策略，不设非 ASCII 字符比例拦截。

### 通信指引

Agent 应通过提供的 `msg_write` 发送消息；`write` 保持 SDK 原生文件工具完全不变，不承担消息发送。

调用方只提供接收地址和纯文本消息。`content` 即为消息正文，不要求调用方封装成 JSON、拼接 NDJSON 或添加末尾换行。

`msg_write` 位于 subagent 命名空间。Main 默认不启用该工具；Capability 选中整个 subagent namespace 后，一并启用 `msg_write`。所有子 Agent 的 Harness 工具组独立提供该工具，仍受祖先禁用与角色最终排除约束。`msg_write` 只接受受管 IPC 地址或跨 session 地址。由宿主负责通信封装、消息分帧（`src/ipc/message.ts` 中的 `managedFrame`）和发送者绑定。内部传输格式不属于 Agent 的调用契约。

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

Harness RPC 是现有领域操作的远程适配层。会话宿主拥有组合、SDK 绑定和连接生命周期；Main、工具权限、Preset、审批、会话联系和 Subagent 继续拥有各自的业务状态。客户端直接使用结构化操作。

### 双通道边界

- Pi 原生 RPC 可继续提供 UI。完整 Harness 宿主通过 `createHarnessSessionHost` 借用实际 SDK runtime，在每个 ResourceLoader 中安装 `host.extension`；嵌入方保留正常 SDK 重绑回调和 runtime 所有权。仅扩展加载时如实报告 capabilities：不可观察字段为 null，输入仅为 `submitted`，缺少的导航控制返回 `unavailable`。
- 两个通道不承诺跨通道的全局消息顺序。订阅事件与 `stream.subscribe` 响应携带根会话与执行归属；`jobs.*`、`agents.tree` 响应带 Agent／Job 执行身份，但不重复携带根 `sessionId`（仅 `harness.info` 提供）；`tools.*` 等查询响应不携带归属。客户端不能仅按接收先后推断操作因果。
- `get_commands` 是 Slash 命令、Skill 与模板目录，不是工具目录；`get_tree` 是 Main 的 entry 树，不是 Subagent 树。Main 的原生消息查询与事件流不覆盖独立子会话。

### 启用条件与生命周期

- 端点仅在根宿主实际运行模式为 `rpc` 时创建。运行模式取自 Pi 的扩展运行模式，不扫描命令行，也不用 `hasUI` 推断。TUI、print 与 JSON 模式不创建、不监听、不发布该端点；内部 SDK 子会话不因父进程处于 RPC 模式而再次开启。
- 一个 RPC 根宿主提供一个端点。客户端通过 Agent 与 Job 标识访问子任务，不为每个子 Agent 新建监控端点。
- 端点使用独立地址，不与 `Main.sock`、Agent 端点或广播端点共用，复用受管 IPC 的创建、归属校验与清理。
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
| `approvals.list/get/respond/subscribe` | 真实审批队列和首次有效决定，保持超时、取消、无消费者时拒绝及退役释放 |
| `sessions.list/connect` | 共享会话目录与联系操作，联系和发送相互独立 |
| `tools.catalog`、`tools.detail` | 当前作用域目录与详情，报告 registered、eligible、active、managed 和 permission；禁用项保留，供用户管理 |
| `tools.activate`、`tools.deactivate` | 修改当前会话按需激活集合，与用户命令共用领域操作 |
| `tools.base.list/add/remove` | 查询与修改工具基线，不修改按需集合与黑名单 |
| `tools.blacklist.list/add/remove` | 查询与管理禁用目标，结果说明仍生效的来源与声明延期移除 |
| `agents.tree` | 当前根 Agent 树 |
| `jobs.list`、`jobs.get`、`jobs.result` | Job 列表、详情与单次结果；未就绪、不存在与读取失败分别表达 |
| `subagent.create` | 创建子任务；宿主绑定父身份、根会话、工作目录、继承快照与容量限制，返回已登记项与失败项 |
| `subagent.stop` | 请求取消指定子任务，区分请求取消与最终退出 |
| `message.send` | 按受管 IPC 地址（Unix Socket／Windows Named Pipe，不接受裸 Actor ID）投递、续跑或广播，返回领域回执与逐接收者结果；广播只允许父 Main 写广播端点，跨会话只允许 Main-to-Main，其他来源拒绝 |
| `history.read` | 读取指定 Job 的原生历史区间；running Job 返回已产生区间与 live 端，首个 Job 的 `null` start 是合法边界（按分支开头读取），memory-only 会话明确报告历史不可用 |
| `stream.subscribe`、`stream.unsubscribe` | 订阅或解除指定 Job 的子会话执行流；订阅响应携带读取边界（状态、轮次、历史区间、已产生消息与当前 `partial`），事件携带订阅、根会话、Agent 与 Job 归属 |

- 公开参数、结果、校验和生成 schema 关联于 `src/harness-rpc/contract.ts`，编译时核对 38 个方法的覆盖及结果类型。SDK 事件与历史保留不透明载荷。领域错误保留 code、message 和 detail；登记后的启动失败以 `start_failed` 和 detail 中的 registered／failures 报告，不能视为整批未创建。查询与回执不额外写入 Main 对话，操作自身仍保留业务记录。
- 子任务操作使用当前领域绑定；Root 过渡期间拒绝访问旧服务。SDK Main 控制独立于 Subagent 健康状态；后续回调受绑定代次围栏隔离。

### 执行流

- 实时数据源是子会话自己的原生事件订阅，保留完整原生事件类型与 Pi RPC 的 JSON 投影语义：不重复发送累计 `partial`，工具调用保留 `toolCallId` 与存在时的 `parentToolCallId`，推理只提供供应商实际返回的内容。
- 历史与实时流有明确衔接边界：订阅建立先于响应，响应返回当前 Job 的读取边界，包含 `status`、`round`、`history{startEntryId,endEntryId}`、已产生的 `messages` 与当前的 `partial`；客户端据边界补齐已产生内容后消费实时事件，不需要读取文件猜测增量起点。`live` 表示是否挂上实时源；running 与已终态 Job 都返回真实快照，订阅时 Job 已终态则不再补发终态事件，其状态只在边界中给出。
- `agent_end`、`agent_settled` 与 Harness Job 最终结束不是同一边界。订阅单独报告 Runtime 的 Job 终态；Job 可能继续消费停放输入或等待子任务，最终状态以 Runtime 为准。
- 订阅者异常或断连不影响任务执行；观察失败不改变任务结果。解除订阅或断连会同时释放该订阅的原生监听与 Runtime 终态观察，不将连接保留到 Job 结束。

## 异步 Shell

主机可安装 `pi-job`，由原有 Bash／PowerShell 工具运行终端任务（POSIX tmux，Windows psmux 3.4.0+）。`create --wait` 在指定窗口内等待，否则返回任务 ID；`poll` 默认返回新增输出；`send` 从 stdin 接收多行文字，`key` 发送显式按键。运行上限由独立的 `--timeout` 控制。完整命令、输出和安装契约见[异步 Shell](async-shell.md)。

注册和完成事件回到发起调用的 Actor 端点。Main 和子会话在每次 Shell 启动时获得各自的 `PI_AGENT_ID`、`PI_AGENT_SOCKET` 和执行代次标识；事件不占用 Agent 消息发送者身份，也不产生消息工具授权。未完成异步 Shell 与直接子节点共同保留 Subagent 当前 Job；完成事件先入队，后释放等待。

## 提示词与架构

本节指引与其他 namespace、MCP 指引共用分支记录与增量更新规则；会话恢复重放已有正文和落点。

工具提示词应表达上述使用流程和行为边界。提示词正文存放在 `prompts/`，通过 `src/prompt-text.ts` 的类型化缓存 getter 读取；执行代码保留数据装配、参数结构和权限判断。角色说明来自 `subagent-routing.json`，候选偏好使用所引用或临时 Preset 的 description，不新增模板框架或静默回退正文。

### Subagent 提示词装配

运行时始终读取 `prompts/subagent-tools.json` 与 `prompts/subagent-turns.json`。

| 模块 | 资产字段 | 装配位置 |
| --- | --- | --- |
| A：共同范围 | tools 的 `namespace`、`instructions` | 仅保留适用于所有成员的共同说明；原生声明已提供时不重复，容器独立加载或 schema 延迟隐藏时通过当前指引投影 |
| B：派生与协调 | tools 的 `create.guideline` | 只随 `subagent_create` 提供；延迟 schema 时保留工具专属指引，不追加到 list／stop／msg_write |
| 列表查询 | tools 的 `list.guideline` | 只随 `subagent_list` 提供 |
| 消息通信 | tools 的 `msg_write.guidelines` | 只随 `msg_write` 提供目标寻址、广播、唤醒、身份与报文格式规则，不包含创建或编排指引；延迟 schema 时保留工具专属指引 |
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
