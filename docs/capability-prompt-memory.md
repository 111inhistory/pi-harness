# 提示词中的能力发现记忆

Capability 发现采用惰性机制，但选中的能力必须在会话压缩与嵌套工具调用中保留。

`src/capability/prompt.ts` 根据所选原生分支上的规范 `capability-discovery` 事实渲染当前 `<capabilities>` 段落正文；`src/request-instructions.ts` 通过 `before_agent_start` 的 `event.systemPromptOptions.sections` 写入动态指令段落，并在同轮发现、嵌套发现或自动压缩改变状态时格式化为持久化的 `custom_message`（`user` 角色）。Harness 不保存或重放段落放置日志；原生历史与传输编码仍由 SDK 负责。

## 持久化分支存储

每次成功或部分成功的发现均会向会话分支写入一条 `capability-discovery` 条目。用户显式启用／禁用使用独立的 `capability-tool-permission` 条目（`set`／`unset`），不写入发现记录；`/capability enable` 先写权限记录，再激活实际可用的成员。runtime 只读 canonical 与 config 默认，不读取旧 `manual`／`capability-blacklist`。显式离线工具 `npm run migrate:tool-permissions` 仅转换已核实的平面 manual-only 记录，保留原生 checkpoint ID；支持范围与拒绝条件见[接口契约](interface-contract.md#工具权限管理)。

- 嵌套调用：当外层工具调用 `ctx.executeTool("capability", ...)` 时，内层发现记录直接写入分支。即使调用的外层工具丢弃或汇总了内层 `details`，该记录依然保留。
- 规范条目是唯一的记忆来源。投影不读取 `toolResult.details`，也不从较早的结果消息中重建记忆。
- 每次运行前通过 `before_agent_start` 重建当前记忆；运行中的直接或嵌套发现由外层 `tool_result` 边界通过一条持久化的 `custom_message`（`user` 角色）同步最新状态，因此外层工具丢弃内层细节也不丢失。
- 先持久化后激活：Capability 在调用同步工具激活前，先将发现记录追加到分支中。

## 包含内容

- 工具与 MCP 组：ref、名称、描述、暴露方式、共享指示及选中的组成员。原生声明、Codemode 接口查询或降级结果元数据提供参数 schema；分支记录不重复保存 schema。
- 共享指示：每个已声明的命名空间均可通过原生指导段落输出其当前指示，包含 MCP 以及由用户直接启用的命名空间。仅当该生产者实际输出了该段落时，Capability 记忆才会省略此文本。否则记忆将保留这些指示，包括直接声明被隐藏的情况。两种情况下，工具结果文本均省略共享文本。
- Skill：绝对入口路径、名称和描述。宿主不从 Skill 文本中推断约束或关联。Skill 的 ref 即为其入口路径；模型通过原生文件读取理解指导。宿主不安装资源协议路由器，也不覆盖文件工具。
- 三态权限条目属于分支权限，而非请求状态。系统从不把权限条目投影为 `<capabilities>` 段落：显式启用的工具已由原生工具列表声明，投影会重复声明接口并改变头部系统提示词。权限条目与发现条目共享同一个 ref 命名空间和相同的权限检查，但只有发现条目会提供段落文本。参见[缓存边界](reviews/capability-enable-cache.md)。
- 默认禁用种子：`capability.manualTools` 归一为同 target/state 结构的默认 `disabled` 条目（精确或 prefix），不是独立名单。发现与准入按 disabled 排除；子节点通过 denial 阻止继承。目录浏览可显示其状态，但浏览不授予显式启用；`reset` 可解除为 `not managed`。
- 显式状态：`capability-tool-permission` 记录是权限来源，而非当前激活集合。`before_agent_start` 会移除在显式禁用、或属于默认禁用种子却未被显式启用时处于激活状态的工具（如 `defaultActive`、恢复的 transcript、其他扩展引入），`tool_call` 拒绝调用，Codemode 准入应用相同的断言。接收跨会话消息会按相同规则激活 `msg_write` 但不写显式启用记录，因此接收消息绝不会凭空产生用户授权。
- 共享指导：在多次发现之间保留，即使某次选择未增加新工具。
- 远程覆盖范围：发现仅搜索本地资源。覆盖范围显式将远程搜索标记为 `not_searched`。远程候选资源绝不进入分支记录、系统段落或总结。

发现记忆不授予执行权限。每次快照都会按当前注册表与调用方作用域重新过滤成员；不再在每条请求末尾追加尾部 `developer` 段落，也不重放旧的放置记录。原生声明、活跃工具集与执行准入仍为权威边界。

## 压缩与未使用能力淘汰

Main 和普通 Fresh／Inherited Subagent 在原生压缩成功后，若 `capability.pruneOnCompaction` 开启，或自上次压缩以来应用 Preset 移除过基线工具，则淘汰 Capability 发现的未使用工具成员。基线移除由分支记录中的前后工具选择比较推导，仅触发下一次成功压缩的清理，不持久修改配置；只增加工具不触发。使用窗口从上一次压缩之后开始，到新检查点之前结束。已完成的直接工具调用结果与持久化的嵌套 Codemode 调用记录提供使用证据；仅提及工具或调用被拒绝不计入使用。系统不维护独立的运行时使用记录。

显式禁用工具与发现／Codemode 恢复路径予以保留。工具基线优先使用当前 Preset 快照中的工具选择，没有该选择时使用 Pi 设置的默认工具集；清除 Preset 后回到默认工具基线。切换 Preset 时保留的动态 Capability 工具不纳入基线。在窗口期内未使用的其他已发现成员会从激活集合中移除。组收缩至其保留的成员；空的 MCP 或命名空间组将失去其记忆和共享指示。Skill 留在记忆中。该策略不会断开 MCP 传输连接。

在变更激活状态前，先向分支写入一条 `capability-prune` 记录。发现回放按分支顺序折叠这些记录：旧的选择保持移除状态，后续发现可引入新的选择。某组成员跨多个检查点全部移除后，旧组指引也应移除；重新发现仅引入新记录的元数据，不恢复旧指引。回放从分支尾部累积后续移除项，每条发现只投影一次，不在每次 prune 时重建全部已累积记录。重新打开或切换分支遵循该分支上的记录。压缩失败或取消不产生淘汰记录。

适用压缩边界上的 `capability-availability` 段落列出本次被移除的工具与组，说明摘要中的旧引用需要重新发现后才能再次使用。手动或运行前压缩由随后的 `before_agent_start` 写入该段落；运行中自动压缩与溢出重试则通过一条持久化的 `custom_message`（`user` 角色）随压缩边界同步，无需改写 SDK 头部。

当前的声明加载集合与权限状态决定工具可用性。Harness 不根据请求序号推断声明年代，也不为保住历史前缀而保留已停用工具。选择记忆与执行权限始终分离。

内部 Capability 检索与 `/btw` 不独立执行淘汰。它们的继承视图保留父会话的当前状态与边界通知。

## 原生发现边界

`extensions/capability.ts` 入口安装原生发现边界与 MCP 执行后端。它替换原生 MCP 发现入口，但不替换传输或认证。配套入口禁用原生 `tool_search`、全局资源列表以及默认的 `<mcp_servers>` 注入。

Codemode 依然可用于执行与组合。其沙箱不注册 `searchTools`。`ALL_TOOLS`、`describeTool` 与 `describeNamespace` 仅能看到当前已启用且受允许的工具。`ALL_TOOLS` 包含简要描述；`describeTool` 在被请求时返回完整接口。沙箱保持其启动时捕获的工具快照，因此新激活的工具需要一次新的 Codemode 调用。目录查询不等待 MCP 后端；宿主不添加主动 MCP 重连。实际的嵌套调用依然走 Pi 的工具流水线。通用的 MCP 资源读取需要所选服务器命名空间中当前已启用且受允许的成员。

旧版原生 Codemode 声明可能在其描述中嵌入目录。请求投影会将这些描述替换为已注册的安全 Codemode 描述。这种迁移从请求中移除了原生元数据，但不会改写用户文本或已存储的历史记录。这可能会使旧的缓存前缀失效。正常的发现更新保留下文所述的前缀行为。

## 时序与缓存行为

在每轮运行开始前，`before_agent_start` 通过 `event.systemPromptOptions.sections` 写入当前的动态段落（非 SDK 命名空间指引、`<capabilities>` 记忆、`<preset-instructions>` 与 `<capability-availability>`），由 SDK 原生对比并持久化在用户消息之前，不在请求末尾注入 `developer` 段落。静态工具与命名空间指引（如 Subagent、异步 Shell、`capability`）直接通过 SDK 原生 `ToolDefinition.promptGuidelines` 随 `<rules>` 段落发布。

在单轮执行中的未变更工具调用循环里，工具结果之后不再附加 `system`/`developer` 或额外 `user` 消息，请求以 `function_call_output`（或对应传输的工具结果）自然结束，从而维持隐式前缀缓存断点推进。仅当同一轮内的直接或嵌套发现（在外层 `tool_result` 合并去重）、或运行中自动压缩／溢出重试实际改变了当前状态或活跃工具声明时，Harness 才通过 `pi.sendMessage(..., { triggerTurn: true, deliverAs: 'steer' })` 持久化一条非空的 `custom_message`（编码为 `user` 角色，携带实际当前状态），既向模型同步最新记忆与可用性通知，又在 SDK 工具变更补丁之后收口为 `user` 断点。

规范业务记录在重新打开、分支回退与继承时恢复当前状态；重放时忽略过时的 `harness-tool-guidance`、`harness-capability-memory`、`harness-preset-instruction` 等旧放置记录，且不改写原始会话文件。Main、普通 Subagent、内部检索与 `/btw` 共用相同的当前状态渲染逻辑，并各自保持角色与权限边界。

安装的 SDK 在 `before_agent_start` 之后执行隐藏声明过滤与完整强制提示词投影（`forceSystemPrompt`）。完整强制提示词优先并可抑制 Harness 的系统段落，后续上下文插件也可按 SDK 钩子顺序替换上下文；Harness 不通过 provider hook 绕过这两类边界。

原生 `ToolDefinition.promptGuidelines`、工具描述与参数 schema 仍由 SDK 管理。Harness 不再构造独立的描述纠偏层，也不保存历史描述基线；参见[Provider 传输行为](provider-transports.md)。离线序列化观测只验证编码后的消息顺序，不等于真实供应商的缓存命中或计费结果。

## 待解决的 SDK allowlist 差异

在 SDK `1.5.0` 下，严格的工具 allowlist 可以在保留 MCP 注册的同时，拒绝激活与其不匹配的成员。仅缺少隐藏的 `tool_search` 并不能预判失败：匹配 MCP 成员名称的 allowlist 仍可允许激活。

Capability 在激活工具之前先写入规范的分支记录。宿主按实际激活集合过滤公开结果，但早期的记录可能保留未激活的成员。后续请求投影可能再次向模型提供这些成员。激活异常也会导致相同的差异。

这是“累积成功获取的能力”这一需求中尚未解决的缺陷，而非允许激活失败计为成功的策略。该记录不授予执行权限。触发条件与恢复方案见[已知问题](known-issues.md#严格工具-allowlist-下的激活记忆不一致)。

## 回归测试覆盖

- `test/typed/capability-prompt.test.ts`：当前规范记忆、原生 `promptGuidelines` 去重、非 SDK 命名空间指引、压缩淘汰与权限过滤；`test/typed/capability-current-snapshot-sdk.test.ts`：真实 SDK 下的未变更工具循环、`function_call_output` 收尾、同轮静态工具激活、嵌套吞并合并、运行中自动压缩与持久化 `user` 边界。
- `test/typed/capability-session-sdk.test.ts` 与 `test/typed/btw-session.test.ts`：真实 SDK 会话中的 Preset 继承、角色隔离与受阻父工具执行。
- `test/typed/capability-history-model.test.ts`：生成原生与转换视图历史，验证无 `developer_tail`、无放置日志写入、业务状态恢复、调用方消息保留、活跃声明与执行权限边界。
- `test/typed/capability-record.test.ts`：验证记录规范化、参数 schema 排除、分支序列化及覆盖范围报告。
- `test/typed/capability-nested.test.ts`：验证在外层工具省略内层结果时，嵌套工具调用仍可在分支上保留已发现的能力。
- `test/typed/capability-native-discovery.test.ts`：在两种扩展加载顺序下验证原生入口替换、选定 MCP 执行、带作用域的 Codemode 辅助函数、资源读取权限及后期服务器注册。
- `test/typed/capability-codemode-boundary.test.ts`：验证在不修改用户文本的前提下移除历史目录、精简目录、完整显式接口查询、沙箱快照以及取消后的 Worker 准入。
- `test/typed/capability-feedback-sdk.test.ts`：在真实 SDK 模型请求中验证完整且紧凑的反馈，并在仅传 ref 重复调用后验证完整命名空间选择。
- `test/typed/capability-allowlist-mask.test.ts`：复现宿主写入选择记录后激活失败的未决 SDK allowlist 场景。
- `test/typed/capability-main-default-activation.test.ts`：验证 Main 在没有 `msg_write` 的情况下启动，且 Capability 激活 Subagent 命名空间。
- `test/typed/capability-enable.test.ts`：验证命令解析、活跃注册表目标解析、先写记录再应用效果顺序、按目标拒绝、幂等性、写入失败不激活并报告、选择器及其取消操作和完成态。
- `test/typed/capability-provider-prefix.test.ts`：在 Provider 边界验证启用操作是追加而非改写，验证投影无多余内容，并测量 Pi 自身的提示词段落补丁。
- `test/typed/capability-mcp-reconnect.test.ts`：验证原生 `/mcp reconnect` 注册的工具可浏览且可启用、被撤销的注册被拒绝，以及 `manualTools` 依然约束新注册。
- `test/typed/cross-session-reply-activation.test.ts`：验证接收消息仅激活 `msg_write`、回复能够送达、不写入显式启用记录，且重复接收保持幂等。
