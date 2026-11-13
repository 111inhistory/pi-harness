# 已知问题与验收边界

本页区分已知缺陷、未交付功能、待验收场景和设计限制。当前行为见[接口契约](interface-contract.md)，模块职责见[当前架构](architecture.md)。历史修复与排查记录见[归档目录](archive/README.md)和[审查目录](reviews/README.md)。

## 已知缺陷

### 严格工具 allowlist 下的激活记忆不一致

Pi SDK `1.5.0` 可能保留 MCP 注册，却拒绝激活不匹配 allowlist 的成员。例如 allowlist 只列出 `read`、`write`、`capability`，既不匹配目标 `mcp__*` 工具，也不保留隐藏的 `tool_search`。SDK 没有公开的激活资格预检接口，激活调用可以静默省略成员。

Capability 按实际激活集筛选公开结果，返回失败或部分成功。但先写入的 `capability-discovery` 规范记录仍可能包含未激活成员。激活调用抛出异常时也可能出现这类差异。该记录不授予执行权限，却可能让请求记忆提示一个未启用工具。

恢复办法是让 allowlist 显式匹配所需 MCP 工具，或使用保留默认工具的配置后重新发现。仅凭隐藏的 `tool_search` 是否存在，不能判断全部工具的激活资格。回归见 [capability-allowlist-mask.test.ts](../test/typed/capability-allowlist-mask.test.ts)。

这项缺陷尚未修复，也不是 `harness.json` 中的可选策略。修复需要明确 SDK 激活资格或调整记录协议；当前没有激活探针、回滚或补偿状态机。

## 已知环境故障

### macOS 兼容性尚未建立

不得将本项目描述为兼容 macOS。前两次 macOS CI 运行（[af70eeb6](https://github.com/111inhistory/pi-harness/actions/runs/43160777427/job/130991157029) 与 [e8987153](https://github.com/111inhistory/pi-harness/actions/runs/43160828592/job/130991324504)）在 1,043 项测试中各自报告 993 通过、41 失败、9 跳过。

日志指向几组聚合性故障，而非 41 个独立定位的缺陷：

- 共享 SDK 夹具初始化以 `must live under the disposable cwd` 拒绝 `PI_CODING_AGENT_DIR`。它对 `process.cwd()` 使用字符串前缀检查。macOS 临时目录别名与规范路径差异是可能原因，但失败断言未同时打印两个路径值。原生与父协调 PBT 在夹具初始化阶段、尚未执行生成生命周期操作前即失败，因此这些失败不构成生命周期反例。
- 含空格与非 ASCII 字符的真实异步 Shell 测试在长原生临时目录下因 tmux `File name too long` 失败。这是实测的 Socket 路径长度故障，而非可选后端跳过。
- 受管 IPC / session-connect 用例在绑定临时 Unix Socket 时因 `listen EINVAL` 失败；其他用例无法观测到已发布的会话记录或 RPC 发现记录。过长的临时路径是绑定失败的候选原因。发布与超时类失败尚未独立追踪，因此不得拆分为已确认的独立成因，也不得轻率为仅限夹具的故障。

目前尚未建立 macOS 修复方案或端到端验收通过记录。Linux 与 Windows 的结果不能替代 macOS 验证；仅让短目录 CI 配置通过本身也不足以验证常规 macOS 临时目录行为。

### Ubuntu CI 上的 PowerShell 语法检查

[run 43154191240 中的 Ubuntu 任务](https://github.com/111inhistory/pi-harness/actions/runs/43154191240/job/130970182267) 在修订版 `1f35ba2c` 于 `checks PowerShell through its AST parser when available` 用例失败。只要环境中找到 `pwsh` 或 `powershell`（包括 Linux），该测试就会运行。一条合法的 Unicode PowerShell 命令返回了 `ok: false`；该任务报告 1,033 通过、1 失败、9 跳过，而同一次运行的 Windows 任务通过。本地 Linux 环境没有安装 PowerShell 可执行文件因而跳过该用例，故本地全绿结果未覆盖此路径。

失败检查耗时 5,035 ms，超出了 5,000 ms 的解析器期限。启动或检查超时是合理猜测，但原断言只打印了 `false !== true`，没有结果码或诊断信息。确切原因尚未确认：日志无法区分 `checker_timeout`、启动失败还是解析器拒绝；目前仅记录该环境下的超时现象。

当前失败断言已补充平台、Node 版本、所选可执行文件、Shell 类型、结果码与解析器诊断信息。超时时间、可用性规则与生产行为未作改动。按用户要求，该路径的进一步复现与主动验证暂缓；失败问题仍待排查。

## 待处理设计问题

### Provider 请求所有权与 compat 驱动的 thinking 变更

即使序列化后的消息前缀与缓存标识未变，修改生效的 thinking 配置仍可能使提供方的提示词缓存失效。这包括预算变更、thinking 启用/禁用切换，以及自适应 thinking 下的顶层 effort 变更。其可见代价是重新触发缓存写入或未命中缓存的输入计费。Anthropic 在 [thinking 与缓存](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost#prompt-caching) 与 [提示词缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#what-invalidates-the-cache) 中记录了这些影响以及受支持的逐消息 effort 替代方案。这是特定提供方的行为，并不意味着每次 thinking 级别变化都会使所有提供方的缓存失效。

适配必须遵循精确的 provider API 与显式的模型 `compat` 选项（包括 `supportsMidConvoEffort`）；仅凭自适应 thinking 本身不能作为能力判定依据。Pi SDK 1.5.0 已在多条传输路径上支持对话中 effort：其 Responses 适配器在开启对应 compat 选项且通过适用性检查（包括认证路径限制）后使用 `configuration_update` 条目；Anthropic 在其受支持路径且 thinking 保持开启时使用历史逐消息 effort 标记与固定的顶层 effort，禁用 thinking 时走另一条路径；Codex WebSocket 适配器在非输入请求参数不同时则会单独放弃增量 `previous_response_id` 复用。该延续性检查不保证提示词缓存复用。Harness 必须复用原生编码及其限制，不得根据 provider 名称、自适应模式或工具追加兼容位推断支持，也不得安装竞争编码器或在每次级别变更时轮换缓存 key。

尚未解决的设计缺口是 Harness 完整 provider 请求/缓存契约（包括跨 provider 路径的有效 thinking 配置）的所有权与验证。修复具体的 Capability 声明投影反例并未解决这一更广泛的架构问题；其[已解决证据](archive/capability-history-pbt.md)已单独归档。Capability 历史模型仅在固定 thinking 设置下检查转换后的 Responses 消息，并未观察完整出站 payload、自适应/关闭切换或在线缓存使用情况。请求投影由 Capability 扩展装配，而原生编码归属 provider 适配器。Provider 边界审查必须使用 SDK 钳位（clamped）后的有效值，区分普通预算、自适应 effort、关闭切换、原生增量 effort 支持与不支持路径。仅验证消息前缀稳定性不足以覆盖上述路径。

目前未针对此缺口实现额外的 Harness 适配，也未在此执行在线缓存未命中复现。本条目记录的是已确认的设计/验证遗漏与有文档依据的提供方行为，而非已复现的请求损坏缺陷。保持 thinking 设置稳定可避免受影响路径上有记录的参数变更失效，但本身不保证缓存命中。

## 未交付功能

| 项目 | 当前边界 |
| --- | --- |
| 用户交互界面 | `/subagent` 已提供查看、停止和会话连接；可视化／交互式任务管理界面及通过用户命令直接向子 Agent 发送消息仍未交付 |
| Capability 远端审批 | 内部搜索只使用本地来源；没有远端审批界面，也不搜索、安装或自动加载远端候选 |
| 仅提供资源的 MCP 服务器发现 | 没有工具的 MCP 服务器不作为独立发现项 |
| Work | 保留在 `experiments/work/`，不由主线扩展加载；交付形态未确定 |

## 待验收场景

默认回归使用真实 Pi SDK、本地模拟模型和离线 MCP 子进程。离线通过不等于真实提供方、多轮模型行为或长期运行验收。

- **Inherited 在线工具调用与压缩**：基础注册、延迟 MCP 和 Responses 声明链已有离线回归；动态激活后多轮调用、原生压缩后的实际工具调用仍需在线验收。
- **真实提供方的输入与行为**：精简 step 反馈的 JSON 完整性和大小已在模型请求中验证；提供方是否额外截断、角色选择质量和多轮遵循情况仍需实测。
- **长期资源与竞态**：退役、落盘失败和部分代次竞态已有回归；长时间压力、监听资源耗尽、强制终止点和插件取消导航的组合仍未完整覆盖。
- **跨 session 消息**：目录发布、原生 session name、存活校验、单帧写入、未知 session 拒绝与远端错误码透传已有两平台离线回归。Windows 的双 SDK 进程已验证显式连接、双向消息、忙时交接、原生压缩、树导航、reload 后继续收发和退出清理；真实提供方多轮行为、长期互发与资源压力仍需实测。IPC 目录必须保持本机私有：记录里的 `pid` 只在本机解释，跨机共享 `socketRoot` 不在设计范围内；跨机共享 durable session 历史不受此限制。
- **Manual 能力在线组合**：完整 SDK 会话（真实 `createAgentSession`、真实 stdio MCP 子进程、离线模型）覆盖未授权声明／执行／Codemode、`/capability enable` 授权后的 manual MCP 与资源读取资格、Main／子作用域隔离。真实提供方的缓存计费、真实资源读取、启用后 MCP 断连和长时间运行仍未验收。
- **Capability lazy schema**：离线 SDK 用例验证命中组 schema 不进入独立声明也不进入 Codemode 目录、`describeTool` 可取完整接口且脚本可执行、后续内部继承检索不重发这些 schema。真实提供方缓存命中、多轮模型遵循和长期保持未验收。
- **模型 Preset**：`/preset`、`--preset` 的模型切换、thinking、工具修饰符基于稳定基线、instructions 段落投影、分支指令快照恢复、`codemode.mode` 生效覆盖已有离线单测与离线 SDK 冒烟；真实 TUI 下的 `/preset` 选择器与 `--preset` 命令交互、真实提供方的模型切换与在线缓存仍未验收。
- **异步 Shell**：Linux tmux 与原生 Windows psmux 已通过真实 SDK 的离线回归，Windows 覆盖 Bash／PowerShell 入口、Main／Subagent 回调和取消清理。真实提供方多轮运行、长时压力与 Windows 进程查询不可用的故障注入仍未验收。Windows SDK 用例曾出现未完成首轮让出的偶发失败：固定 3 秒轮询把子会话启动、Shell 启动与 CLI 延迟混在一起，而产品契约并未承诺 3 秒；场景现以实际模型回调的 Shell 结果轮次作为让出信号，外层测试、子进程与命令期限保持不变。同一次全量中的 Bash 用例还留下一次 `connect ENOENT` 注册拒绝记录，其管道可用性原因尚未证明，也不因场景同步改动而修复。历史记录见[平台验收记录](reviews/async-shell-platform-acceptance.md)。
- **平台与用户边界**：当前改写的 Linux 与原生 Windows 完整离线门禁均已通过；平台跳过项、具体版本与验证范围见[审计记录](reviews/rpc-permission-audit.md)。`macos-latest` 已执行离线门禁并失败，具体证据见上面的 macOS 环境故障；项目目前不能宣称兼容 macOS。macOS 实机、多用户切换与管道权限隔离尚未验收。

现有在线样本只证明记录中的具体场景，不替代当前调用链的完整验收。

## 依赖边界

ModelRuntime 桥依赖 SDK 的内部结构，升级 SDK 时应复核。子会话收尾通过 `takeQueuedMessages` 读取原生待处理队列；该辅助函数临时切换队列模式并使用探针，不能把当前实现概括为完全没有队列探针。

`src/` 与 `extensions/` 生产代码使用严格 TypeScript；`scripts/` 与部分历史测试仍为 MJS。配置和提示词刷新规则见[Harness 参数配置](harness-configuration.md)与[提示词资产](../prompts/README.md)。

## 设计限制

这些限制描述当前行为，不自动转为新增功能承诺：

- **离线权限转换**：运行时仅读取规范记录。显式转换工具支持已关闭 v3 文件中的扁平纯 manual 记录，并保留原生检查点 ID 与无关字节。黑名单、混合/组记录以及旧格式与规范格式混杂的文件会被原样拒绝。执行外部转换前必须先关闭活跃根及其所属子文件；备份或补齐其他文件并不能让活跃文件迁移变得安全。具体已完成与延后证据见[审计记录](reviews/rpc-permission-audit.md)。
- **恢复与写入**：Shutdown 不可取消。强制退出或清理失败可能留下原生对话而没有根终态，下次按中断恢复。没有跨文件事务，也不支持多个进程同时写同一根会话。
- **导航取消**：导航尝试会先停止子 Job。后续插件取消导航时，已停止的 Job 不回滚或自动重跑。
- **消息交接**：异常、断连或超时不证明消息未入队，不自动重发。普通消息和子节点通知可触发模型请求，本项目不合并不同事件。跨 session 消息的 session 记录与 `from` 都是同用户本机进程的声明，不是认证；进程异常退出可能留下已失效的 session 记录，读取时按 pid 存活过滤，pid 复用时可能短暂误报。同一 durable session 不支持多进程同时打开；目录记录按 session ID 归属，重复打开时较早退出的进程可能删除后者记录。
- **异步 Shell 日志与恢复**：输出是终端转录。Windows ConPTY 可能折行和重绘，过滤文本可能含额外换行或重复字符。monitor 被外部强制杀死后没有自动恢复或通知补发；任务日志不自动按保留期清理，长期运行会持续增长。命令与增量读取说明见[异步 Shell](async-shell.md)。
- **能力记忆**：发现记录按分支累计，角色排除仍优先；请求投影重新核对当前资格。记录能否恢复依赖规范条目仍在当前分支，激活成功性另受上面的已知缺陷限制。
- **模型 Preset 与 Codemode 模式**：`codemode.mode` 无公开运行时写入通道，Preset 以分支记录覆盖本会话 Capability 的生效模式（原生 Codemode 工具与 lazySchemas 读取），从下一次请求生效；它只改变声明投影，不改变启用集合、授权或工具 exposure，也不影响其他读取 Pi `settings.codemode.mode` 的组件。`/preset clear` 只停止管理，不回滚 model／thinking／tools。恢复时依赖 Pi 原生运行状态，不强制重放 Preset 快照；应用后尚未发起请求就退出，工具集可能恢复为上次请求记录的 loadout。
- **MCP 发现与连接**：Capability 只搜索当前已注册工具，不等待全部后端，也不主动重连。注册或激活不表示服务持续在线；连接恢复沿用 Pi 原生行为和用户命令。
- **刷新边界**：根服务使用配置快照，已有 Job 保留原 Budget。提示词正文受 ESM 缓存影响，重启 Pi 是明确生效方式，`/reload` 不保证刷新全部依赖。
- **工具集变化与提示词缓存**：工具与 system 更新由 Pi 原生编码，并按模型 compat 选择追加路径。Chat Completions 的工具追加需要明确开启中途 system 消息与工具新增两个兼容位；标准端点仍重发顶层工具列表。同名 schema 更新在仅支持新增的路径可能重建前缀，未支持中途 system 消息的模型会折叠指引到头部。描述与共同指引变化使用增量段落，压缩则允许重建并收缩工具 checkpoint。详情见[Provider 传输行为](provider-transports.md)。前缀稳定和缓存标识相同不保证实际命中；不添加缓存断点或 TTL 策略。
- **缓存标识验收边界**：Main 在共享 ModelRuntime 边界观察最终 payload hook 结果，Inherited 与 Capability 检索会话通过自身 `streamFunction` wrapper 观察；有效 Responses key 按分支保存。离线回归覆盖钩子顺序、继承、落盘恢复、共享运行时和退役回调。任意第三方插件组合及真实服务商的长期缓存复用未全面验收；相同 key 不保证命中，详见[Provider 传输行为](provider-transports.md)。
